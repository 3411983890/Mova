'use strict';
// SQL persistence layer for the Mova PostgreSQL repository.
//
// This module owns *all* SQL. The semantic layer
// (electron/db/postgres-repository.cjs) owns validation, extraction rules,
// ranking and response shaping, so it can be exercised without a database by
// injecting an equivalent store (see tests/postgres-repository.test.mjs).
//
// Store contract (all methods bound to a single owner_id, camelCase results):
//   seed(), transaction(fn), close()
//   settingsData(), saveSettingsData(data)
//   projects(), ensureProject(name, memoryMode), deleteUnusedProjects(names)
//   conversations(), upsertConversation(conv), replaceMessageEvents(id, events),
//   deleteConversationsExcept(ids)
//   memories(), searchMemories(scope), searchMessages(scope),
//   memoryBySource(conversationId, messageId)
//   insertMemory(row), updateMemory(id, patch), deleteMemory(id),
//   supersedeMemories(ids, byId, updatedAt)
//   insertChunks(rows), deleteMemoryChunks(memoryId), vectorSearch(scope)
//   counts(), databaseBytes(), ping(), schemaReady()
//   clearMemories(), clearSessions(), clearAll()
//   insertBackup(record), updateBackup(id, patch), backups(limit), backup(id)
//
// Every query is parameterized; no caller value is interpolated into SQL.
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const txStorage = new AsyncLocalStorage();
const DEFAULT_OWNER_ID = '00000000-0000-4000-8000-000000000001';

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

function num(value) {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function vectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const parts = vector.map(value => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw coded('invalid-input', 'embedding contains a non-finite value');
    return n.toFixed(7);
  });
  return `[${parts.join(',')}]`;
}

function memoryRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    key: row.key ?? null,
    status: row.status,
    pinned: row.pinned === true,
    source: row.source,
    version: row.version,
    supersedes: Array.isArray(row.supersedes) ? row.supersedes.map(String) : [],
    supersededBy: row.superseded_by ?? null,
    embeddingModel: row.embedding_model ?? null,
    embeddingVersion: row.embedding_version ?? null,
    normalizedHash: row.normalized_hash ?? null,
    importance: row.importance === null || row.importance === undefined ? 0.5 : Number(row.importance),
    useCount: Number(row.use_count ?? 0),
    lastUsedAt: iso(row.last_used_at),
    observedAt: iso(row.observed_at),
    validFrom: iso(row.valid_from),
    validTo: iso(row.valid_to),
    expiresAt: iso(row.expires_at),
    lastConfirmedAt: iso(row.last_confirmed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    projectName: row.project_name ?? null,
    conversationId: row.conversation_id ?? null,
    messageId: row.message_id ?? null,
  };
}

function backupRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    path: row.path,
    bytes: row.bytes === null || row.bytes === undefined ? null : num(row.bytes),
    status: row.status,
    error: row.error ?? null,
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
  };
}

const MEMORY_SELECT = `
  select m.id, m.kind, m.text, m."key" as key, m.status, m.pinned, m.source, m.version,
         m.supersedes, m.superseded_by, m.embedding_model, m.embedding_version,
         m.normalized_hash, m.importance, m.use_count, m.last_used_at,
         m.observed_at, m.valid_from, m.valid_to, m.expires_at, m.last_confirmed_at,
         m.created_at, m.updated_at, p.name as project_name,
         src.conversation_id, src.message_id
  from mova_memories m
  left join mova_projects p on p.id = m.project_id
  left join lateral (
    select ms.conversation_id, ms.message_id
    from mova_memory_sources ms
    where ms.memory_id = m.id
    order by ms.conversation_id, ms.message_id
    limit 1
  ) src on true`;

// Contract §4: exact project match, null means global, empty string is a
// caller bug (rejected before reaching SQL), allProjects is explicit search.
// Params: $1 owner, $2 allProjects, $3 projectName, $4 includeGlobal.
function scopeFilter(projectColumn, projectNameColumn) {
  return `(
    $2::boolean = true
    or ($3::text is null and ${projectColumn} is null)
    or ($3::text is not null and ${projectNameColumn} = $3)
    or ($4::boolean = true and ${projectColumn} is null)
  )`;
}

function tokenFilter(prefix, expression) {
  return `(
    cardinality(${prefix}::text[]) = 0
    or exists (
      select 1 from unnest(${prefix}::text[]) as token
      where position(lower(token) in lower(${expression})) > 0
    )
  )`;
}

function createPgStore(options = {}) {
  const ownerId = options.ownerId || DEFAULT_OWNER_ID;
  const connectionString = options.connectionString || null;
  let pool = options.pool || null;
  let ownsPool = false;

  function getPool() {
    if (pool) return pool;
    if (!connectionString) throw coded('database-unavailable', 'no PostgreSQL connection configured');
    let pg;
    try {
      pg = require('pg');
    } catch {
      throw coded('pg-unavailable', 'the "pg" package is not installed');
    }
    pool = new pg.Pool({
      connectionString,
      max: options.max || 4,
      idleTimeoutMillis: 30_000,
      application_name: 'mova-repository',
      ...(options.poolOptions || {}),
    });
    ownsPool = true;
    pool.on?.('error', () => { /* idle client errors must not crash Electron main */ });
    return pool;
  }

  function executor() {
    return txStorage.getStore() || getPool();
  }

  function query(text, params) {
    try {
      return executor().query(text, params);
    } catch (error) {
      // getPool() throws synchronously when unconfigured.
      return Promise.reject(error);
    }
  }

  async function transaction(fn) {
    if (txStorage.getStore()) return fn(store);
    const client = await getPool().connect();
    try {
      await client.query('begin');
      const value = await txStorage.run(client, () => fn(store));
      await client.query('commit');
      return value;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* broken connection */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function seed() {
    await query(
      `insert into mova_users (id, display_name) values ($1, $2) on conflict (id) do nothing`,
      [ownerId, 'Mova'],
    );
    await query(
      `insert into mova_settings (owner_id, data) values ($1, '{}'::jsonb) on conflict (owner_id) do nothing`,
      [ownerId],
    );
  }

  async function settingsData() {
    const result = await query(`select data from mova_settings where owner_id = $1`, [ownerId]);
    const data = result.rows[0]?.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  async function saveSettingsData(data) {
    await query(
      `insert into mova_settings (owner_id, data, updated_at) values ($1, $2::jsonb, now())
       on conflict (owner_id) do update set data = excluded.data, updated_at = now()`,
      [ownerId, JSON.stringify(data || {})],
    );
  }

  async function projects() {
    const result = await query(
      `select id, name, memory_mode from mova_projects where owner_id = $1 order by created_at, name`,
      [ownerId],
    );
    return result.rows.map(row => ({ id: row.id, name: row.name, memoryMode: row.memory_mode }));
  }

  async function ensureProject(name, memoryMode = 'scoped') {
    const result = await query(
      `insert into mova_projects (id, owner_id, name, memory_mode) values ($1, $2, $3, $4)
       on conflict (owner_id, name) do update set name = mova_projects.name
       returning id`,
      [randomUUID(), ownerId, name, memoryMode],
    );
    return result.rows[0].id;
  }

  // Projects are removed from the sidebar by deleting the whole project, but a
  // project that still owns memories is kept so deletion can never silently
  // destroy memory rows (contract §13: do not drop data for speed).
  async function deleteUnusedProjects(names) {
    await query(
      `delete from mova_projects p
       where p.owner_id = $1
         and p.name <> all($2::text[])
         and not exists (select 1 from mova_memories m where m.project_id = p.id)`,
      [ownerId, names && names.length ? names : []],
    );
  }

  async function conversations() {
    const rows = await query(
      `select c.id, c.project_id, p.name as project_name, c.title, c.temporary, c.created_at, c.updated_at
       from mova_conversations c
       left join mova_projects p on p.id = c.project_id
       where c.owner_id = $1
       order by c.created_at, c.id`,
      [ownerId],
    );
    const events = await query(
      `select e.event_id, e.conversation_id, e.parent_event_id, e.sequence, e.type, e.role,
              e.content, e.model_id, e.provider_id, e.created_at
       from mova_session_events e
       join mova_conversations c on c.id = e.conversation_id
       where c.owner_id = $1
       order by e.conversation_id, e.sequence`,
      [ownerId],
    );
    const grouped = new Map();
    for (const event of events.rows) {
      if (!grouped.has(event.conversation_id)) grouped.set(event.conversation_id, []);
      grouped.get(event.conversation_id).push({
        eventId: event.event_id,
        parentEventId: event.parent_event_id ?? null,
        sequence: num(event.sequence),
        type: event.type,
        role: event.role ?? null,
        content: event.content,
        modelId: event.model_id ?? null,
        providerId: event.provider_id ?? null,
        createdAt: iso(event.created_at),
      });
    }
    return rows.rows.map(row => ({
      id: row.id,
      projectName: row.project_name ?? null,
      title: row.title,
      temporary: row.temporary === true,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      events: grouped.get(row.id) || [],
    }));
  }

  async function upsertConversation(conversation) {
    await query(
      `insert into mova_conversations (id, project_id, owner_id, title, temporary, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update
         set project_id = excluded.project_id,
             title = excluded.title,
             temporary = excluded.temporary,
             created_at = least(mova_conversations.created_at, excluded.created_at),
             updated_at = excluded.updated_at
       where mova_conversations.owner_id = excluded.owner_id`,
      [
        conversation.id,
        conversation.projectId || null,
        ownerId,
        conversation.title,
        conversation.temporary === true,
        conversation.createdAt,
        conversation.updatedAt,
      ],
    );
  }

  // Idempotent event regeneration. Message sequences are assigned 1..n while
  // skipping sequences occupied by other event types (tool calls, model
  // changes, compaction) so a snapshot sync never collides with the session
  // store. Existing message events are shifted out of the way first, then
  // upserted by their stable event_id, and leftovers are deleted.
  async function replaceMessageEvents(conversationId, events) {
    const occupied = await query(
      `select sequence::text as sequence from mova_session_events
       where conversation_id = $1 and type <> 'message'`,
      [conversationId],
    );
    const taken = new Set(occupied.rows.map(row => num(row.sequence)));
    let cursor = 0;
    const planned = events.map(event => {
      do { cursor += 1; } while (taken.has(cursor));
      return { ...event, sequence: cursor };
    });

    await query(
      `update mova_session_events set sequence = sequence + 100000000
       where conversation_id = $1 and type = 'message'`,
      [conversationId],
    );

    for (const event of planned) {
      await query(
        `insert into mova_session_events
           (event_id, conversation_id, parent_event_id, sequence, type, role, content, model_id, provider_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         on conflict (event_id) do update
           set parent_event_id = excluded.parent_event_id,
               sequence = excluded.sequence,
               role = excluded.role,
               content = excluded.content,
               model_id = excluded.model_id,
               provider_id = excluded.provider_id
         where mova_session_events.conversation_id = excluded.conversation_id`,
        [
          event.eventId,
          conversationId,
          event.parentEventId || null,
          event.sequence,
          event.type || 'message',
          event.role || null,
          JSON.stringify(event.content ?? {}),
          event.modelId || null,
          event.providerId || null,
          event.createdAt || new Date().toISOString(),
        ],
      );
    }

    const keep = events.map(event => event.eventId);
    await query(
      `delete from mova_session_events
       where conversation_id = $1 and type = 'message' and event_id <> all($2::text[])`,
      [conversationId, keep.length ? keep : []],
    );
  }

  async function deleteConversationsExcept(ids) {
    const keep = ids && ids.length ? ids : [];
    const doomed = await query(
      `select id from mova_conversations where owner_id = $1 and id <> all($2::text[])`,
      [ownerId, keep],
    );
    if (doomed.rows.length) {
      const removed = doomed.rows.map(row => row.id);
      await query(
        `delete from mova_search_chunks
         where owner_id = $1 and source_kind = 'message' and conversation_id = any($2::text[])`,
        [ownerId, removed],
      );
      await query(`delete from mova_conversations where owner_id = $1 and id = any($2::text[])`, [ownerId, removed]);
    }
    return doomed.rows.length;
  }

  async function memories() {
    const result = await query(`${MEMORY_SELECT} where m.owner_id = $1 order by m.created_at, m.id`, [ownerId]);
    return result.rows.map(memoryRow);
  }

  async function searchMemories(scope = {}) {
    const result = await query(
      `${MEMORY_SELECT}
       where m.owner_id = $1
         and m.status = 'active'
         and ${scopeFilter('m.project_id', 'p.name')}
         and ${tokenFilter('$5', 'm.text')}
       order by m.updated_at desc, m.id
       limit $6`,
      [
        ownerId,
        scope.allProjects === true,
        scope.projectName ?? null,
        scope.includeGlobal === true,
        Array.isArray(scope.tokens) ? scope.tokens.slice(0, 128) : [],
        Number.isInteger(scope.limit) && scope.limit > 0 ? scope.limit : 300,
      ],
    );
    return result.rows.map(memoryRow);
  }

  async function searchMessages(scope = {}) {
    const result = await query(
      `select e.event_id, e.conversation_id, e.sequence, e.content, e.role, p.name as project_name
       from mova_session_events e
       join mova_conversations c on c.id = e.conversation_id
       left join mova_projects p on p.id = c.project_id
       where c.owner_id = $1
         and c.temporary = false
         and e.type = 'message'
         and ${scopeFilter('c.project_id', 'p.name')}
         and ${tokenFilter('$5', "coalesce(e.content->>'search', '')")}
       order by e.conversation_id, e.sequence
       limit $6`,
      [
        ownerId,
        scope.allProjects === true,
        scope.projectName ?? null,
        scope.includeGlobal === true,
        Array.isArray(scope.tokens) ? scope.tokens.slice(0, 128) : [],
        Number.isInteger(scope.limit) && scope.limit > 0 ? scope.limit : 500,
      ],
    );
    return result.rows.map(row => ({
      eventId: row.event_id,
      conversationId: row.conversation_id,
      sequence: num(row.sequence),
      content: row.content,
      role: row.role ?? null,
      projectName: row.project_name ?? null,
    }));
  }

  async function memoryBySource(conversationId, messageId) {
    const result = await query(
      `${MEMORY_SELECT}
       where m.owner_id = $1
         and exists (
           select 1 from mova_memory_sources ms
           where ms.memory_id = m.id and ms.conversation_id = $2 and ms.message_id = $3
         )
       order by m.created_at, m.id`,
      [ownerId, conversationId, messageId],
    );
    return result.rows.map(memoryRow);
  }

  async function sourceMessageEvents(conversationId, messageId = null) {
    const ids = messageId ? [messageId] : null;
    if (messageId?.endsWith('-assistant')) ids.push(messageId.slice(0, -10));
    const result = await query(
      `select e.event_id, e.content, e.role, p.name as project_name, c.title
       from mova_session_events e
       join mova_conversations c on c.id = e.conversation_id
       left join mova_projects p on p.id = c.project_id
       where c.owner_id = $1 and c.id = $2 and c.temporary = false and e.type = 'message'
         and ($3::text[] is null or e.event_id = any($3::text[]))
       order by (e.event_id = $4) desc, e.sequence`,
      [ownerId, conversationId, ids, messageId],
    );
    return result.rows.map(row => ({
      eventId: row.event_id, content: row.content, role: row.role, projectName: row.project_name ?? null, title: row.title,
    }));
  }

  async function insertMemory(memory, source = null) {
    await query(
      `insert into mova_memories
         (id, owner_id, project_id, kind, text, "key", status, pinned, source, version,
          supersedes, superseded_by, embedding_model, embedding_version,
          normalized_hash, importance, observed_at, valid_from, valid_to, expires_at,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[], $12, $13, $14,
               $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        memory.id,
        ownerId,
        memory.projectId || null,
        memory.kind,
        memory.text,
        memory.key ?? null,
        memory.status,
        memory.pinned === true,
        memory.source,
        memory.version,
        Array.isArray(memory.supersedes) ? memory.supersedes : [],
        memory.supersededBy || null,
        memory.embeddingModel || null,
        memory.embeddingVersion ?? null,
        memory.normalizedHash ?? null,
        memory.importance ?? 0.5,
        memory.observedAt ?? memory.createdAt,
        memory.validFrom ?? null,
        memory.validTo ?? null,
        memory.expiresAt ?? null,
        memory.createdAt,
        memory.updatedAt,
      ],
    );
    if (source && source.conversationId && source.messageId) {
      await query(
        `insert into mova_memory_sources (memory_id, conversation_id, message_id, source_span, confidence)
         values ($1, $2, $3, $4, $5)
         on conflict (memory_id, conversation_id, message_id) do nothing`,
        [memory.id, source.conversationId, source.messageId, source.sourceSpan ?? null, source.confidence ?? null],
      );
    }
  }

  async function updateMemory(memoryId, patch = {}) {
    const fields = [];
    const params = [];
    const push = (column, value, cast = '') => {
      params.push(value);
      fields.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.text !== undefined) push('text', patch.text);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.pinned !== undefined) push('pinned', patch.pinned === true);
    if (patch.embeddingModel !== undefined) push('embedding_model', patch.embeddingModel);
    if (patch.embeddingVersion !== undefined) push('embedding_version', patch.embeddingVersion);
    if (patch.normalizedHash !== undefined) push('normalized_hash', patch.normalizedHash);
    push('updated_at', patch.updatedAt || new Date().toISOString());
    params.push(ownerId, memoryId);
    const result = await query(
      `update mova_memories set ${fields.join(', ')}
       where owner_id = $${params.length - 1} and id = $${params.length}
       returning id`,
      params,
    );
    return result.rowCount > 0;
  }

  async function deleteMemory(memoryId) {
    const result = await query(`delete from mova_memories where owner_id = $1 and id = $2`, [ownerId, memoryId]);
    await query(
      `delete from mova_search_chunks where owner_id = $1 and source_kind = 'memory' and source_id = $2`,
      [ownerId, memoryId],
    );
    return result.rowCount > 0;
  }

  async function supersedeMemories(ids, supersededBy, updatedAt) {
    if (!Array.isArray(ids) || !ids.length) return;
    await query(
      `update mova_memories
       set status = 'superseded', superseded_by = $2, updated_at = $3
       where owner_id = $1 and id = any($4::uuid[])`,
      [ownerId, supersededBy, updatedAt, ids],
    );
  }

  async function insertChunks(rows) {
    for (const row of rows) {
      await query(
        `insert into mova_search_chunks
           (id, owner_id, project_id, conversation_id, message_id, source_kind, source_id,
            content, content_ngrams, embedding, embedding_model, embedding_version, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::vector, $11, $12, $13)
         on conflict (id) do update
           set content = excluded.content,
               content_ngrams = excluded.content_ngrams,
               embedding = excluded.embedding,
               embedding_model = excluded.embedding_model,
               embedding_version = excluded.embedding_version`,
        [
          row.id || randomUUID(),
          ownerId,
          row.projectId || null,
          row.conversationId || null,
          row.messageId || null,
          row.sourceKind,
          row.sourceId || null,
          row.content,
          Array.isArray(row.contentNgrams) ? row.contentNgrams : [],
          vectorLiteral(row.embedding),
          row.embeddingModel || null,
          row.embeddingVersion ?? null,
          row.createdAt || new Date().toISOString(),
        ],
      );
    }
  }

  async function deleteMemoryChunks(memoryId) {
    await query(
      `delete from mova_search_chunks where owner_id = $1 and source_kind = 'memory' and source_id = $2`,
      [ownerId, memoryId],
    );
  }

  async function deleteMessageChunks(conversationId) {
    await query(
      `delete from mova_search_chunks where owner_id = $1 and source_kind = 'message' and conversation_id = $2`,
      [ownerId, conversationId],
    );
  }

  // Source ids that already have a vector, used by indexPending() to skip work.
  async function chunkSources() {
    const result = await query(
      `select distinct source_kind, source_id from mova_search_chunks
       where owner_id = $1 and embedding is not null and source_id is not null`,
      [ownerId],
    );
    return result.rows.map(row => ({ sourceKind: row.source_kind, sourceId: row.source_id }));
  }

  async function clearChunks() {
    await query(`delete from mova_search_chunks where owner_id = $1`, [ownerId]);
  }

  async function vectorSearch(scope = {}) {
    const literal = vectorLiteral(scope.embedding);
    if (!literal) return [];
    const result = await query(
      `select ch.source_kind, ch.source_id, ch.conversation_id, ch.message_id, ch.content,
              p.name as project_name, 1 - (ch.embedding <=> $5::vector) as score
       from mova_search_chunks ch
       left join mova_projects p on p.id = ch.project_id
       where ch.owner_id = $1
         and ch.embedding is not null
         and ${scopeFilter('ch.project_id', 'p.name')}
         and ($7::text is null or ch.source_kind = $7)
       order by ch.embedding <=> $5::vector
       limit $6`,
      [
        ownerId,
        scope.allProjects === true,
        scope.projectName ?? null,
        scope.includeGlobal === true,
        literal,
        Number.isInteger(scope.limit) && scope.limit > 0 ? scope.limit : 50,
        scope.sourceKind ?? null,
      ],
    );
    return result.rows.map(row => ({
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      conversationId: row.conversation_id ?? null,
      messageId: row.message_id ?? null,
      content: row.content,
      projectName: row.project_name ?? null,
      score: Number(row.score) || 0,
    }));
  }

  async function counts() {
    const result = await query(
      `select
         (select count(*) from mova_memories where owner_id = $1)::bigint as memories,
         (select count(*) from mova_conversations where owner_id = $1)::bigint as conversations,
         (select count(*) from mova_session_events e
            join mova_conversations c on c.id = e.conversation_id
           where c.owner_id = $1)::bigint as events`,
      [ownerId],
    );
    const row = result.rows[0] || {};
    return { memories: num(row.memories), conversations: num(row.conversations), events: num(row.events) };
  }

  async function databaseBytes() {
    const result = await query(`select pg_database_size(current_database())::bigint as bytes`);
    return num(result.rows[0]?.bytes);
  }

  async function ping() {
    await query('select 1');
    return true;
  }

  async function schemaReady() {
    const result = await query(
      `select to_regclass('public.mova_memories') is not null as ready,
              to_regclass('public.mova_users') is not null as users`,
    );
    const row = result.rows[0] || {};
    return row.ready === true && row.users === true;
  }

  async function clearMemories() {
    await query(`delete from mova_search_chunks where owner_id = $1 and source_kind = 'memory'`, [ownerId]);
    await query(`delete from mova_memories where owner_id = $1`, [ownerId]);
  }

  async function clearSessions() {
    await query(
      `delete from mova_search_chunks
       where owner_id = $1 and source_kind = 'message'
         and conversation_id in (select id from mova_conversations where owner_id = $1)`,
      [ownerId],
    );
    await query(`delete from mova_conversations where owner_id = $1`, [ownerId]);
  }

  async function clearAll() {
    await clearMemories();
    await clearSessions();
    await query(`delete from mova_projects where owner_id = $1
                 and not exists (select 1 from mova_memories m where m.project_id = mova_projects.id)`, [ownerId]);
    await query(`update mova_settings set data = '{}'::jsonb, updated_at = now() where owner_id = $1`, [ownerId]);
  }

  async function insertBackup(record) {
    await query(
      `insert into mova_backups (id, owner_id, kind, path, bytes, status, error, created_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        ownerId,
        record.kind,
        record.path ?? '',
        record.bytes ?? null,
        record.status,
        record.error ?? null,
        record.createdAt,
        record.completedAt ?? null,
      ],
    );
  }

  async function updateBackup(backupId, patch = {}) {
    const fields = [];
    const params = [];
    const push = (column, value) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (patch.path !== undefined) push('path', patch.path);
    if (patch.bytes !== undefined) push('bytes', patch.bytes);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.completedAt !== undefined) push('completed_at', patch.completedAt);
    if (!fields.length) return false;
    params.push(ownerId, backupId);
    const result = await query(
      `update mova_backups set ${fields.join(', ')}
       where owner_id = $${params.length - 1} and id = $${params.length}
       returning id`,
      params,
    );
    return result.rowCount > 0;
  }

  async function backups(limit = 50) {
    const result = await query(
      `select id, kind, path, bytes, status, error, created_at, completed_at
       from mova_backups where owner_id = $1 order by created_at desc, id limit $2`,
      [ownerId, Number.isInteger(limit) && limit > 0 ? limit : 50],
    );
    return result.rows.map(backupRow);
  }

  async function backup(backupId) {
    const result = await query(
      `select id, kind, path, bytes, status, error, created_at, completed_at
       from mova_backups where owner_id = $1 and id = $2`,
      [ownerId, backupId],
    );
    return result.rows[0] ? backupRow(result.rows[0]) : null;
  }

  async function close() {
    if (pool && ownsPool) {
      const current = pool;
      pool = null;
      ownsPool = false;
      await current.end().catch(() => {});
    }
  }

  const store = {
    ownerId,
    seed,
    transaction,
    close,
    settingsData,
    saveSettingsData,
    projects,
    ensureProject,
    deleteUnusedProjects,
    conversations,
    upsertConversation,
    replaceMessageEvents,
    deleteConversationsExcept,
    memories,
    searchMemories,
    searchMessages,
    memoryBySource,
    sourceMessageEvents,
    insertMemory,
    updateMemory,
    deleteMemory,
    supersedeMemories,
    insertChunks,
    deleteMemoryChunks,
    deleteMessageChunks,
    chunkSources,
    clearChunks,
    vectorSearch,
    counts,
    databaseBytes,
    ping,
    schemaReady,
    clearMemories,
    clearSessions,
    clearAll,
    insertBackup,
    updateBackup,
    backups,
    backup,
    query,
  };
  return store;
}

module.exports = { createPgStore, DEFAULT_OWNER_ID, iso, num, vectorLiteral };
