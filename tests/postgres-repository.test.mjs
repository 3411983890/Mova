import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createTestExtractor } from './helpers/memory-extractor.mjs';

const require = createRequire(import.meta.url);
const {
  createPostgresRepository,
  DEFAULT_SETTINGS,
  SINGLE_USER_ID,
  EMBEDDING_DIM,
  PROJECT_OVERLAY_KEY,
  redactConnectionString,
} = require('../electron/db/postgres-repository.cjs');
const { createPgStore } = require('../electron/db/postgres-store.cjs');
const migrateModule = require('../electron/db/migrate.cjs');
const { createSessionSync } = require('../electron/session-sync.cjs');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const MIGRATION_PATH = path.join(ROOT, 'electron', 'db', 'migrations', '001_init.sql');
const SCHEMA = await fs.readFile(MIGRATION_PATH, 'utf8');

const code = (fn, expected) => assert.rejects(fn, error => error.code === expected);

// ---------------------------------------------------------------------------
// In-memory implementation of the store contract used by the repository. It
// mirrors the scope/token filtering that postgres-store.cjs performs in SQL, so
// the semantic layer can be tested without a database.
// ---------------------------------------------------------------------------
function createFakeStore(options = {}) {
  const faults = options.faults || {};
  const state = {
    projects: new Map(), // name -> { id, name, memoryMode }
    byId: new Map(), // id -> name
    conversations: new Map(), // id -> conversation row (projectName = memory scope)
    memories: [],
    chunks: [],
    backups: [],
    settings: {},
  };
  let projectSeq = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const containsTokens = (text, tokenList) => tokenList.length === 0
    || tokenList.some(token => String(text || '').toLocaleLowerCase().includes(String(token).toLocaleLowerCase()));
  const inScope = (scopeValue, projectName) => {
    if (scopeValue.allProjects === true) return true;
    if ((scopeValue.projectName ?? null) === null) return projectName === null;
    return projectName === scopeValue.projectName || (scopeValue.includeGlobal === true && projectName === null);
  };
  const projectNameOf = row => (row.projectId ? state.byId.get(row.projectId) ?? null : null);
  const memoryRow = row => ({ ...clone(row), projectName: projectNameOf(row) });

  const store = {
    state,
    async seed() {},
    async transaction(fn) { return fn(store); },
    async close() {},
    async settingsData() { return clone(state.settings); },
    async saveSettingsData(data) { state.settings = clone(data); },
    async projects() { return [...state.projects.values()].map(project => ({ ...project })); },
    async ensureProject(name, memoryMode = 'scoped') {
      if (state.projects.has(name)) return state.projects.get(name).id;
      projectSeq += 1;
      const id = `00000000-0000-4000-9000-${String(projectSeq).padStart(12, '0')}`;
      state.projects.set(name, { id, name, memoryMode });
      state.byId.set(id, name);
      return id;
    },
    async deleteUnusedProjects(names) {
      for (const [name, project] of [...state.projects]) {
        if (names.includes(name)) continue;
        if (state.memories.some(memory => memory.projectId === project.id)) continue;
        state.projects.delete(name);
        state.byId.delete(project.id);
      }
    },
    async conversations() {
      return [...state.conversations.values()].map(conversation => ({
        ...clone(conversation),
        events: clone(conversation.events || []),
      }));
    },
    async upsertConversation(conversation) {
      const previous = state.conversations.get(conversation.id) || { events: [] };
      state.conversations.set(conversation.id, {
        ...conversation,
        projectName: conversation.projectId ? state.byId.get(conversation.projectId) ?? null : null,
        events: previous.events,
      });
    },
    async replaceMessageEvents(conversationId, events) {
      const conversation = state.conversations.get(conversationId);
      if (!conversation) return;
      conversation.events = events.map((event, index) => ({ ...clone(event), sequence: index + 1 }));
    },
    async deleteConversationsExcept(ids) {
      for (const [id] of [...state.conversations]) {
        if (ids.includes(id)) continue;
        state.conversations.delete(id);
        state.chunks = state.chunks.filter(chunk => chunk.conversationId !== id);
      }
    },
    async memories() { return state.memories.map(memoryRow); },
    async searchMemories(scopeValue) {
      return state.memories
        .map(memoryRow)
        .filter(row => row.status === 'active'
          && inScope(scopeValue, row.projectName)
          && containsTokens(row.text, scopeValue.tokens || []))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, scopeValue.limit || 300);
    },
    async searchMessages(scopeValue) {
      const rows = [];
      for (const conversation of state.conversations.values()) {
        if (conversation.temporary) continue;
        if (!inScope(scopeValue, conversation.projectName)) continue;
        for (const event of conversation.events || []) {
          if (event.type !== 'message') continue;
          if (!containsTokens(event.content?.search || '', scopeValue.tokens || [])) continue;
          rows.push({
            eventId: event.eventId,
            conversationId: conversation.id,
            sequence: event.sequence,
            content: clone(event.content),
            role: event.role,
            projectName: conversation.projectName,
          });
        }
      }
      return rows.slice(0, scopeValue.limit || 500);
    },
    async memoryBySource(conversationId, messageId) {
      return state.memories
        .map(memoryRow)
        .filter(row => row.conversationId === conversationId && row.messageId === messageId);
    },
    async sourceMessageEvents(conversationId, messageId) {
      const conversation = state.conversations.get(conversationId);
      if (!conversation || conversation.temporary) return [];
      const ids = new Set([messageId, ...(messageId?.endsWith('-assistant') ? [messageId.slice(0, -10)] : [])]);
      return conversation.events.filter(event => event.type === 'message' && (!messageId || ids.has(event.eventId)))
        .map(event => ({ ...clone(event), projectName: conversation.projectName, title: conversation.title }));
    },
    async insertMemory(row, source) {
      state.memories.push({
        ...clone(row),
        conversationId: source?.conversationId ?? null,
        messageId: source?.messageId ?? null,
      });
    },
    async updateMemory(memoryId, patch) {
      const target = state.memories.find(memory => memory.id === memoryId);
      if (!target) return false;
      Object.assign(target, clone(patch));
      return true;
    },
    async deleteMemory(memoryId) {
      const before = state.memories.length;
      state.memories = state.memories.filter(memory => memory.id !== memoryId);
      state.chunks = state.chunks.filter(chunk => !(chunk.sourceKind === 'memory' && chunk.sourceId === memoryId));
      return state.memories.length !== before;
    },
    async supersedeMemories(ids, supersededBy, updatedAt) {
      for (const memory of state.memories) {
        if (!ids.includes(memory.id)) continue;
        memory.status = 'superseded';
        memory.supersededBy = supersededBy;
        memory.updatedAt = updatedAt;
      }
    },
    async insertChunks(rows) { state.chunks.push(...rows.map(row => clone(row))); },
    async deleteMemoryChunks(memoryId) {
      state.chunks = state.chunks.filter(chunk => !(chunk.sourceKind === 'memory' && chunk.sourceId === memoryId));
    },
    async deleteMessageChunks(conversationId) {
      state.chunks = state.chunks.filter(chunk => !(chunk.sourceKind === 'message' && chunk.conversationId === conversationId));
    },
    async chunkSources() {
      return state.chunks
        .filter(chunk => chunk.sourceId && chunk.embedding != null)
        .map(chunk => ({ sourceKind: chunk.sourceKind, sourceId: chunk.sourceId }));
    },
    async clearChunks() { state.chunks = []; },
    async vectorSearch(scopeValue) {
      return state.chunks
        .filter(chunk => inScope(scopeValue, chunk.projectName ?? null))
        .map(chunk => ({
          sourceKind: chunk.sourceKind,
          sourceId: chunk.sourceId,
          conversationId: chunk.conversationId ?? null,
          messageId: chunk.messageId ?? null,
          content: chunk.content,
          projectName: chunk.projectName ?? null,
          score: 0.75,
        }));
    },
    async counts() {
      let events = 0;
      for (const conversation of state.conversations.values()) events += (conversation.events || []).length;
      return { memories: state.memories.length, conversations: state.conversations.size, events };
    },
    async databaseBytes() {
      if (faults.databaseBytes) throw new Error('no database');
      return 8192;
    },
    async ping() {
      if (faults.ping) throw new Error('connection refused');
      return true;
    },
    async schemaReady() {
      if (faults.schema) return false;
      return true;
    },
    async clearMemories() {
      state.memories = [];
      state.chunks = state.chunks.filter(chunk => chunk.sourceKind !== 'memory');
    },
    async clearSessions() {
      state.conversations.clear();
      state.chunks = state.chunks.filter(chunk => chunk.sourceKind !== 'message');
    },
    async clearAll() {
      await store.clearMemories();
      await store.clearSessions();
      state.settings = {};
    },
    async insertBackup(record) { state.backups.push(clone(record)); },
    async updateBackup(backupId, patch) {
      const target = state.backups.find(backup => backup.id === backupId);
      if (!target) return false;
      Object.assign(target, clone(patch));
      return true;
    },
    async backups(limit = 50) {
      return state.backups.slice(-limit).reverse().map(backup => clone(backup));
    },
    async backup(backupId) {
      const target = state.backups.find(backup => backup.id === backupId);
      return target ? clone(target) : null;
    },
  };
  return store;
}

function fixture(extra = {}) {
  const store = createFakeStore(extra.fake || {});
  let counter = 0;
  const id = extra.id || (() => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  });
  let tick = 0;
  const now = extra.now || (() => {
    tick += 1;
    return new Date(Date.UTC(2026, 10, 10, 0, 0, tick)).toISOString();
  });
  const options = { ...(extra.options || {}) };
  if (!Object.hasOwn(options, 'extractor')) options.extractor = createTestExtractor();
  const repository = createPostgresRepository({
    store,
    id,
    now,
    connectionString: extra.connectionString || 'postgres://mova:super-secret@127.0.0.1:55432/mova',
    ...options,
  });
  return { store, repository, id, now };
}

function snapshotWith({ projects = [], conversations = [] } = {}) {
  return { version: 1, projects, conversations };
}

test('memory provenance resolves the exact persisted reply and respects scope and deletion', async () => {
  const { repository } = fixture();
  const conversationId = JSON.stringify(['CodeMova', 'Alpha', 'Original chat']);
  await repository.saveSessions(snapshotWith({ projects: [{ name: 'Alpha' }], conversations: [[conversationId, [
    { id: 'turn-a', text: 'Original user wording', reply: { text: 'Exact assistant wording', reasoning: 'Hidden' } },
    { id: 'turn-b', text: 'Another message' },
  ]]] }));
  const messageId = 'turn-a-assistant';
  const memory = await repository.saveMemory({ text: 'A summary', projectId: 'Alpha', conversationId, messageId });
  const input = { id: memory.id, conversationId, messageId, projectId: 'Alpha', includeGlobal: true };
  assert.deepEqual(await repository.readMemorySource(input), { role: 'assistant', text: 'Exact assistant wording', projectId: 'Alpha' });
  assert.equal(await repository.readMemorySource({ ...input, projectId: 'Beta' }), null);
  assert.equal(await repository.readMemorySource({ ...input, messageId: 'turn-b' }), null);
  await repository.saveSessions(snapshotWith());
  assert.equal(await repository.readMemorySource(input), null);
});

test('history-only query finds persisted messages across projects and reads selected ranges', async () => {
  const { repository } = fixture();
  const conversationId = JSON.stringify(['CodeMova', 'Beta', '配置记录']);
  const turns = Array.from({ length: 7 }, (_, index) => ({ id: `t${index}`, text: `message ${index}` }));
  turns[3].reply = { text: 'Exact bandwidth 30 Mbps', reasoning: 'Hidden' };
  await repository.saveSessions(snapshotWith({ projects: [{ name: 'Beta' }], conversations: [[conversationId, turns]] }));
  await repository.saveMemory({ text: 'Exact bandwidth 30 Mbps', projectId: 'Alpha' });
  const hits = await repository.query({ query: 'bandwidth', allProjects: true, includeMemories: false });
  assert.deepEqual(hits.map(hit => [hit.kind, hit.messageId]), [['session', 't3-assistant']]);
  const input = { conversationId, messageId: 't3-assistant' };
  assert.deepEqual((await repository.readHistorySource(input)).messages, [
    { messageId: 't3-assistant', text: 'Exact bandwidth 30 Mbps', role: 'assistant' },
  ]);
  const around = await repository.readHistorySource({ ...input, mode: 'around' });
  assert.deepEqual(around.messages.map(message => message.messageId), ['t1', 't2', 't3', 't3-assistant', 't4', 't5']);
  assert.equal((await repository.readHistorySource({ ...input, mode: 'conversation' })).messages.length, 8);
  assert.equal(await repository.readHistorySource({ ...input, messageId: 'unknown', mode: 'conversation' }), null);
});

test('claimed memory jobs settle early returns without re-enqueueing', async () => {
  for (const scenario of ['disabled', 'empty', 'duplicate']) {
    const settled = [];
    const job = { id: 'j1', attempts: 1, conversationId: 'c', messageId: 'm', text: scenario === 'empty' ? '' : 'ordinary text' };
    let available = true;
    const memoryJobs = {
      async recoverStale() {},
      async claim() { if (!available) return []; available = false; return [job]; },
      async enqueue() { throw new Error('must not enqueue claimed jobs'); },
      async complete(...args) { settled.push(['done', ...args]); },
      async skip(...args) { settled.push(['skip', ...args]); },
      async fail(...args) { settled.push(['fail', ...args]); },
    };
    const { repository, store } = fixture({ options: { memoryJobs } });
    if (scenario === 'disabled') await repository.settings({ autoExtract: false });
    if (scenario === 'duplicate') store.memoryBySource = async () => [{ id: 'existing', text: 'existing', source: 'automatic' }];
    const result = await repository.processPendingJobs({ limit: 1 });
    assert.equal(result.completed, 1, scenario);
    assert.equal(settled.length, 1, scenario);
    assert.equal(settled[0][0], scenario === 'duplicate' ? 'done' : 'skip', scenario);
    assert.equal(settled[0].at(-1), 1);
  }
});

test('concurrent direct ingest and worker share an exclusive job claim', async () => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let status = 'pending';
  let extracts = 0;
  const row = { id: 'j1', attempts: 1, conversationId: 'c', messageId: 'm', text: 'ordinary text' };
  const memoryJobs = {
    async enqueue() { return { ...row, status }; },
    async claim() { if (status !== 'pending') return []; status = 'processing'; return [row]; },
    async complete() { status = 'done'; },
    async skip() { status = 'skipped'; },
    async fail() { status = 'failed'; },
  };
  const extractor = { async extract() { extracts++; started(); await gate; return []; } };
  const { repository } = fixture({ options: { memoryJobs, extractor } });
  const direct = repository.ingest({ conversationId: 'c', messageId: 'm', text: 'ordinary text' });
  await entered;
  assert.equal((await repository.processPendingJobs()).processed, 0);
  const duplicate = await repository.ingest({ conversationId: 'c', messageId: 'm', text: 'ordinary text' });
  assert.equal(duplicate.skipped, 'job-unavailable');
  release();
  await direct;
  assert.equal(status, 'done');
  assert.equal(extracts, 1);
});

// ---------------------------------------------------------------------------
// Static contract checks
// ---------------------------------------------------------------------------
test('repository exports the full MemoryRepository surface and contract defaults', () => {
  const { repository } = fixture();
  for (const name of [
    'read', 'saveSessions', 'ingest', 'query', 'context', 'saveMemory', 'updateMemory',
    'deleteMemory', 'settings', 'exportData', 'clear', 'health', 'stats', 'backup',
    'listBackups', 'restore', 'reindex', 'close',
  ]) {
    assert.equal(typeof repository[name], 'function', `${name} must be a function`);
  }
  assert.equal(SINGLE_USER_ID, '00000000-0000-4000-8000-000000000001');
  assert.equal(EMBEDDING_DIM, 384);
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), [
    'autoExtract', 'autoStartServices', 'backupRetentionDays', 'backupSchedule',
    'contextMaxChars', 'contextMaxMemories', 'extractorMode', 'historyRetention',
    'hybridWeight', 'includeGlobal', 'maxMemories', 'memoryEnabled', 'quotaBytes', 'semanticSearch',
  ]);
  assert.equal(DEFAULT_SETTINGS.semanticSearch, true);
  assert.equal(DEFAULT_SETTINGS.hybridWeight, 0.5);
  assert.equal(DEFAULT_SETTINGS.extractorMode, 'llm');
  assert.equal(DEFAULT_SETTINGS.autoStartServices, true);
  assert.equal(DEFAULT_SETTINGS.backupSchedule, 'daily 03:00');
  assert.equal(DEFAULT_SETTINGS.backupRetentionDays, 30);
});

test('migration 001_init.sql matches contract §3: extensions, tables, vector(384), indexes, seed', () => {
  assert.match(SCHEMA, /create extension if not exists vector;/);
  assert.match(SCHEMA, /create extension if not exists pg_trgm;/);
  for (const table of [
    'mova_users', 'mova_projects', 'mova_conversations', 'mova_session_events',
    'mova_memories', 'mova_memory_sources', 'mova_search_chunks', 'mova_settings', 'mova_backups',
  ]) {
    assert.match(SCHEMA, new RegExp(`create table if not exists ${table} \\(`), `${table} table`);
  }
  // Single-user ownership columns.
  assert.match(SCHEMA, /owner_id uuid not null references mova_users\(id\) on delete cascade/);
  // Vector column and ngram/fts channels.
  assert.match(SCHEMA, /embedding vector\(384\)/);
  assert.match(SCHEMA, /content_ngrams text\[\] not null default '\{\}'/);
  assert.match(SCHEMA, /fts tsvector generated always as \(to_tsvector\('simple', content\)\) stored/);
  // Memory constraints.
  assert.match(SCHEMA, /kind in \('fact','preference','decision','note'\)/);
  assert.match(SCHEMA, /status in \('active','disabled','superseded'\)/);
  assert.match(SCHEMA, /source in \('user','automatic'\)/);
  assert.match(SCHEMA, /supersedes uuid\[\] not null default '\{\}'/);
  // Contract indexes.
  for (const index of [
    'mova_search_chunks_fts_idx', 'mova_search_chunks_ngrams_idx', 'mova_search_chunks_embedding_idx',
    'mova_search_chunks_scope_idx', 'mova_memories_scope_idx',
  ]) {
    assert.match(SCHEMA, new RegExp(`create index if not exists ${index}`), index);
  }
  assert.match(SCHEMA, /using hnsw \(embedding vector_cosine_ops\)/);
  assert.match(SCHEMA, /unique \(owner_id, name\)/);
  assert.match(SCHEMA, /unique \(conversation_id, sequence\)/);
  // Owner seed with the fixed contract UUID.
  assert.match(SCHEMA, /insert into mova_users \(id, display_name\)\s*\n?values \('00000000-0000-4000-8000-000000000001'/);
  assert.match(SCHEMA, /on conflict \(id\) do nothing/);
  // Rollback instructions must exist for operators.
  assert.match(SCHEMA, /Rollback/);
});

test('migrate.cjs lists ordered migrations and redacts connection passwords', async () => {
  const migrations = await migrateModule.listMigrations();
  assert.ok(migrations.some(entry => entry.name === '001_init.sql'));
  assert.deepEqual(migrations.map(entry => entry.name), [...migrations.map(entry => entry.name)].sort());
  assert.equal(migrateModule.redactConnectionString('postgres://mova:secret@host:55432/mova'), 'postgres://mova:***@host:55432/mova');
  assert.equal(redactConnectionString('postgres://mova:super-secret@127.0.0.1:55432/mova'), 'postgres://mova:***@127.0.0.1:55432/mova');
  assert.equal(redactConnectionString(null), null);
});

test('missing configuration fails fast with invalid-config', () => {
  const previous = process.env.MOVA_DB_URL;
  delete process.env.MOVA_DB_URL;
  try {
    assert.throws(() => createPostgresRepository({}), error => error.code === 'invalid-config');
    assert.throws(() => createPostgresRepository({ ownerId: SINGLE_USER_ID }), error => error.code === 'invalid-config');
  } finally {
    if (previous !== undefined) process.env.MOVA_DB_URL = previous;
  }
});

test('read() returns the renderer-compatible envelope and never exposes the DB password', async () => {
  const { repository } = fixture();
  const state = await repository.read();
  assert.equal(state.version, 1);
  assert.equal(state.sessions.version, 1);
  assert.deepEqual(state.sessions.projects, []);
  assert.deepEqual(state.sessions.conversations, []);
  assert.deepEqual(state.memories, []);
  assert.deepEqual(state.settings, DEFAULT_SETTINGS);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.checkpoints, []);
  assert.ok(state.storage.bytes > 0);
  assert.ok(!state.storage.filePath.includes('super-secret'));
  assert.match(state.storage.filePath, /\*\*\*/);
});

// ---------------------------------------------------------------------------
// Snapshot round trip (§3.2, §4 saveSessions)
// ---------------------------------------------------------------------------
test('saveSessions filters temporary data, keeps turns verbatim and never duplicates events', async () => {
  const { repository, store } = fixture();
  const alpha = JSON.stringify(['CodeMova', 'Alpha', 'Chat']);
  const global = JSON.stringify(['ChatMova', 'Mova', 'Global chat']);
  const turn = { id: 'turn-1', text: '中文项目设计', reply: { text: '原始回复', timeline: [], source: 'desktop' }, attempts: 2 };
  const snapshot = snapshotWith({
    projects: [{ name: 'Alpha', sourceFolders: [{ name: 'src' }], memory: 'project' }, { name: 'Mova' }],
    conversations: [
      [alpha, [turn, { id: 'temp-message', text: '临时消息', temporary: true }]],
      [global, { projectId: undefined, messages: [{ id: 'g1', text: '中文全局设计' }] }],
      ['temporary', { projectId: 'Alpha', temporary: true, messages: [{ id: 't', text: '中文临时设计' }] }],
    ],
  });
  const source = structuredClone(snapshot);
  const returned = await repository.saveSessions(snapshot);
  assert.deepEqual(snapshot, source, 'caller snapshot must not be mutated');
  assert.equal(returned.version, 1);
  // Temporary conversation dropped, temporary message dropped.
  assert.equal(returned.conversations.length, 2);
  assert.equal(returned.conversations[0][1].length, 1);
  assert.equal(store.state.conversations.size, 2);
  assert.equal(store.state.memories.length, 0);
  const alphaRecord = store.state.conversations.get(alpha);
  assert.equal(alphaRecord.events.length, 1);
  assert.equal(alphaRecord.projectName, 'Alpha');
  assert.equal(store.state.conversations.get(global).projectName, null, 'ChatMova is global memory scope');

  // Repeated saves must be idempotent (same event ids, same count).
  const firstEvents = JSON.parse(JSON.stringify(alphaRecord.events.map(event => event.eventId)));
  await repository.saveSessions(source);
  await repository.saveSessions(source);
  assert.equal(store.state.conversations.get(alpha).events.length, 1);
  assert.deepEqual(store.state.conversations.get(alpha).events.map(event => event.eventId), firstEvents);

  const sessions = await repository.loadSessions();
  const restored = sessions.conversations.find(([key]) => key === alpha);
  assert.deepEqual(restored[1], [turn], 'turn payload round-trips exactly');
  // Projects keep UI attributes and derive chats from conversations.
  const project = sessions.projects.find(entry => entry.name === 'Alpha');
  assert.deepEqual(project.sourceFolders, [{ name: 'src' }]);
  assert.equal(project.memory, 'project');
  assert.deepEqual(project.chats.map(chat => chat.title), ['Chat']);
  assert.equal(project.chats[0].mode, 'CodeMova');
  const mova = sessions.projects.find(entry => entry.name === 'Mova');
  assert.deepEqual(mova.chats.map(chat => chat.title), ['Global chat']);
  assert.equal(mova.chats[0].mode, 'ChatMova');
  // Project overlay must not leak into public settings.
  const settings = await repository.settings();
  assert.equal(Object.hasOwn(settings, PROJECT_OVERLAY_KEY), false);

  // Deleting a conversation in the snapshot removes it from the database.
  await repository.saveSessions(snapshotWith({ projects: [{ name: 'Alpha' }], conversations: [[alpha, [turn]]] }));
  assert.equal(store.state.conversations.size, 1);
  assert.equal((await repository.read()).sessions.conversations.length, 1);
});

test('远程项目与单条会话的主机和任务回执在 PostgreSQL 往返后仍可重连', async () => {
  const { repository } = fixture();
  const project = 'Remote';
  const mode = 'CodeMova';
  const cloudOrigin = 'https://mova.example';
  const cloudChat = { mode, title: 'Cloud', location: 'cloud', cloudOrigin, cloudConversationId: 'cloud-session' };
  const localChat = { mode, title: 'Local', location: 'local' };
  const cloudTurn = { text: '研究', cloudTask: { id: 'remote-receipt' }, cloudPending: true };
  await repository.saveSessions(snapshotWith({
    projects: [{ name: project, device: 'cloud', cloudOrigin, cloudLabel: '主机', instructions: '引用资料', chats: [cloudChat, localChat] }],
    conversations: [[JSON.stringify([mode, project, 'Cloud']), [cloudTurn]], [JSON.stringify([mode, project, 'Local']), [{ text: '旧记录' }]]],
  }));
  const snapshot = await repository.loadSessions();
  const restored = snapshot.projects.find(item => item.name === project);
  assert.equal(restored.cloudOrigin, cloudOrigin);
  assert.equal(restored.cloudLabel, '主机');
  assert.equal(restored.instructions, '引用资料');
  assert.equal(restored.chats.find(chat => chat.title === 'Cloud').cloudConversationId, 'cloud-session');
  assert.equal(restored.chats.find(chat => chat.title === 'Local').location, 'local');
  assert.deepEqual(snapshot.conversations.find(([key]) => key === JSON.stringify([mode, project, 'Cloud']))[1], [cloudTurn]);
});

test('saveSessions persists conversation-level usage and aim rows, not just messages', async () => {
  const { repository } = fixture();
  const chat = JSON.stringify(['ChatMova', 'Mova', '用量会话']);
  const other = JSON.stringify(['ChatMova', 'Mova', '另一个会话']);
  const usage = { input: 184320, output: 9240, cacheRead: 261120, cacheWrite: 4096, totalTokens: 198656, cost: 0.0413, calls: 7, elapsedMs: 102000 };
  const aim = { goal: { title: '接入真实用量', status: 'active' }, plan: { steps: [{ label: '写入数据库', status: 'done' }] } };
  await repository.saveSessions({
    version: 1,
    projects: [{ name: 'Mova' }],
    conversations: [[chat, [{ id: 'm1', text: '你好' }]]],
    usage: [[chat, usage], [other, { input: 1, output: 1, calls: 1 }]],
    aims: [[chat, aim]],
  });

  const sessions = await repository.loadSessions();
  assert.deepEqual(sessions.usage, [[chat, usage]], '本轮及之前累计的真实用量必须读得回来');
  assert.deepEqual(sessions.aims, [[chat, aim]]);
  // 已删除会话对应的行不应留在库里。
  assert.equal(sessions.usage.some(([key]) => key === other), false);

  // read() 给首次载入用的快照也带上这两类状态，否则启动后用量会显示为 0。
  const full = await repository.read();
  assert.deepEqual(full.sessions.usage, [[chat, usage]]);
  assert.deepEqual(full.sessions.aims, [[chat, aim]]);
  // 状态行不能泄漏到公开设置里。
  const settings = await repository.settings();
  assert.equal(Object.hasOwn(settings, '@chatUsage'), false);
  assert.equal(Object.hasOwn(settings, '@chatAims'), false);

  // 脏行只丢自己，不影响整个快照。
  await repository.saveSessions({
    version: 1,
    projects: [{ name: 'Mova' }],
    conversations: [[chat, [{ id: 'm1', text: '你好' }]]],
    usage: [[chat, usage], ['broken'], [chat, 'nope']],
    aims: 'not-an-array',
  });
  const again = await repository.loadSessions();
  assert.deepEqual(again.usage, [[chat, usage]]);
  assert.deepEqual(again.aims, []);
});

test('saveSessions keeps a chat archived across loadSessions, and un-archiving is persisted too', async () => {
  const { repository, store } = fixture();
  const archivedKey = JSON.stringify(['CodeMova', 'Alpha', '归档的聊天']);
  const normalKey = JSON.stringify(['CodeMova', 'Alpha', '普通聊天']);
  const globalKey = JSON.stringify(['ChatMova', 'Mova', '全局聊天']);
  const chats = archivedTitles => [
    { title: '归档的聊天', mode: 'CodeMova', archived: archivedTitles.includes('归档的聊天') },
    { title: '普通聊天', mode: 'CodeMova', archived: archivedTitles.includes('普通聊天') },
  ];
  const snapshotOf = archivedTitles => ({
    version: 1,
    projects: [
      { name: 'Alpha', chats: chats(archivedTitles) },
      { name: 'Mova', chats: [{ title: '全局聊天', mode: 'ChatMova', archived: archivedTitles.includes('全局聊天') }] },
    ],
    conversations: [
      [archivedKey, [{ id: 'a1', text: '归档会话' }]],
      [normalKey, [{ id: 'b1', text: '普通会话' }]],
      [globalKey, [{ id: 'g1', text: '全局会话' }]],
    ],
  });
  const chatOf = (sessions, projectName, title) =>
    sessions.projects.find(row => row.name === projectName).chats.find(chat => chat.title === title);

  // 归档 → 落盘。重启时走的就是 loadSessions()。
  await repository.saveSessions(snapshotOf(['归档的聊天', '全局聊天']));
  const loaded = await repository.loadSessions();
  assert.equal(chatOf(loaded, 'Alpha', '归档的聊天').archived, true, '重启后已归档的聊天必须还是已归档');
  assert.equal(chatOf(loaded, 'Alpha', '普通聊天').archived, false);
  assert.equal(chatOf(loaded, 'Mova', '全局聊天').archived, true, 'ChatMova 的聊天同样要保留归档状态');
  assert.deepEqual(store.state.settings['@chatArchived'], [[archivedKey, true], [globalKey, true]]);
  assert.equal(Object.hasOwn(await repository.settings(), '@chatArchived'), false, '会话状态行不能泄漏到公开设置');

  // read()（首次载入走的另一条路径）也必须带上归档状态。
  const full = await repository.read();
  assert.equal(chatOf(full.sessions, 'Alpha', '归档的聊天').archived, true);

  // 脏行只丢自己，不影响整份会话。
  store.state.settings['@chatArchived'] = [['broken'], [archivedKey, 'yes'], [archivedKey, true]];
  assert.equal(chatOf(await repository.loadSessions(), 'Alpha', '归档的聊天').archived, true);

  // 取消归档必须也能持久化：行要真的被删掉，而不是被忽略。
  await repository.saveSessions(snapshotOf([]));
  assert.deepEqual(store.state.settings['@chatArchived'], []);
  const unarchived = await repository.loadSessions();
  assert.equal(chatOf(unarchived, 'Alpha', '归档的聊天').archived, false, '取消归档后重启不能又变回已归档');
  assert.equal(chatOf(unarchived, 'Mova', '全局聊天').archived, false);

  // 会话被删掉之后，@chatArchived 里不能留下孤儿键。
  await repository.saveSessions({
    version: 1,
    projects: [{ name: 'Alpha', chats: chats(['归档的聊天']) }],
    conversations: [[normalKey, [{ id: 'b1', text: '普通会话' }]]],
  });
  assert.deepEqual(store.state.settings['@chatArchived'], []);
  const afterDelete = await repository.loadSessions();
  assert.equal(afterDelete.projects.some(row => row.chats.some(chat => chat.archived)), false);
});

test('the desktop save chain (sessionSync.save) keeps a chat archived and returns it archived on the next sync', async () => {
  const { repository } = fixture();
  const sync = createSessionSync();
  const key = JSON.stringify(['CodeMova', 'Alpha', '归档的聊天']);
  const snapshotOf = archived => ({
    version: 1,
    projects: [{ name: 'Alpha', chats: [{ title: '归档的聊天', mode: 'CodeMova', archived }] }],
    conversations: [[key, [{ id: 't1', text: '你好' }]]],
    aims: [], usage: [], permissionPresets: [],
  });
  // 库里先有一条未归档的聊天（模拟上次启动留下的数据）。
  await repository.saveSessions(snapshotOf(false));
  // 渲染层第一次载入：服务端还没有归档状态。
  const preview = await sync.read('renderer', repository);
  assert.equal(preview.sessions.projects[0].chats[0].archived, false);

  // 用户点「归档」，渲染层带上次看到的 revision 保存；主进程先 mergeSessions 再写库。
  await sync.save('renderer', repository, snapshotOf(true), preview.revision);
  assert.equal((await repository.loadSessions()).projects[0].chats[0].archived, true, '重启载入必须还是已归档');
  // 紧接着的 2 秒同步拿到的快照也是已归档，不会把界面打回未归档。
  const synced = await sync.read('renderer', repository);
  assert.equal(synced.sessions.projects[0].chats[0].archived, true);

  // 取消归档同样要穿过合并链路：不能只「写进」不「删掉」。
  await sync.save('renderer', repository, snapshotOf(false), synced.revision);
  assert.equal((await repository.loadSessions()).projects[0].chats[0].archived, false);
});

test('saveSessions rejects malformed snapshots and invalid conversation keys', async () => {
  const { repository } = fixture();
  await code(() => repository.saveSessions(null), 'invalid-snapshot');
  await code(() => repository.saveSessions({ version: 2, projects: [], conversations: [] }), 'invalid-snapshot');
  await code(() => repository.saveSessions({ version: 1, projects: 'nope', conversations: [] }), 'invalid-snapshot');
  await code(() => repository.saveSessions({ version: 1, projects: [], conversations: [['x']] }), 'invalid-snapshot');
  await code(() => repository.saveSessions({ version: 1, projects: [], conversations: [[42, []]] }), 'invalid-snapshot');
  await code(() => repository.saveSessions({ version: 1, projects: [], conversations: [['k', { messages: 'bad' }]] }), 'invalid-snapshot');
});

// ---------------------------------------------------------------------------
// Scope, search and context (§4, §6.4, §7)
// ---------------------------------------------------------------------------
test('query honours exact project scope, global scope, includeGlobal and explicit allProjects', async () => {
  const { repository } = fixture();
  const alpha = JSON.stringify(['CodeMova', 'Alpha', 'Chat']);
  const beta = JSON.stringify(['CodeMova', 'Beta', 'Chat']);
  const global = JSON.stringify(['ChatMova', 'Mova', 'Chat']);
  await repository.saveSessions(snapshotWith({
    projects: [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Mova' }],
    conversations: [
      [alpha, [{ id: 'a', text: '中文项目设计', reply: { text: '原始回复', timeline: [] } }]],
      [beta, [{ id: 'b', text: '中文项目设计' }]],
      [global, [{ id: 'g', text: '中文全局设计' }]],
      ['temporary', { projectId: 'Alpha', temporary: true, messages: [{ id: 't', text: '中文临时设计' }] }],
    ],
  }));
  await repository.saveMemory({ text: '全局中文偏好', projectId: null });
  await repository.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha', pinned: true });
  await repository.saveMemory({ text: '另一个项目设计 TypeScript', projectId: 'Beta' });

  const hits = await repository.query({ query: '项目设计', projectId: 'Alpha', includeGlobal: false, includeSessions: false });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'memory');
  assert.equal(hits[0].projectId, 'Alpha');

  // Session hits carry conversationId/messageId and a synthetic id.
  const sessions = await repository.query({ query: '项目设计', projectId: 'Alpha', includeGlobal: false });
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(hit => hit.kind === 'memory' || hit.kind === 'session'));
  const sessionHit = sessions.find(hit => hit.kind === 'session' && hit.messageId === 'a');
  assert.equal(sessionHit.conversationId, alpha);
  assert.equal(sessionHit.id, `${alpha}:a`);
  assert.equal(sessionHit.role, 'user');

  // Exact global scope: projectId null matches project_id is null only.
  const globalOnly = await repository.query({ query: '中文', projectId: null, includeGlobal: true });
  assert.deepEqual(globalOnly.filter(hit => hit.kind === 'session').map(hit => hit.messageId), ['g']);
  assert.ok(globalOnly.every(hit => hit.projectId === null));
  // Project scope + global memories.
  const withGlobal = await repository.query({ query: '中文', projectId: 'Alpha', includeGlobal: true });
  assert.equal(withGlobal.length, 3);
  // allProjects is only for explicit user search.
  assert.equal((await repository.query({ query: '项目设计', allProjects: true })).length, 5);
  assert.equal((await repository.query({ query: '项目设计', allProjects: true, includeSessions: false })).length, 2);
  await code(() => repository.query({ query: '中文', projectId: '' }), 'invalid-input');
  await code(() => repository.query({ limit: 0 }), 'invalid-input');
});

test('query excludes mock/demo/tool/thinking/sensitive/temporary content', async () => {
  const { repository } = fixture();
  await repository.saveSessions(snapshotWith({
    projects: [{ name: 'Alpha' }],
    conversations: [['scope', { projectId: 'Alpha', messages: [
      { id: 'real', text: '你好', reply: { source: 'desktop', text: 'PostgreSQL 实际答案', thinking: '内部思考不索引' } },
      { id: 'mock', text: '你好', reply: { source: 'mock', text: 'PostgreSQL 示例答案' } },
      { id: 'demo', text: '你好', reply: { source: 'demo', text: 'PostgreSQL 演示答案' } },
      { id: 'tool', role: 'tool', text: 'PostgreSQL 工具载荷' },
      { id: 'secret', text: 'api_key=PostgreSQL 机密' },
      { id: 'temp', text: 'PostgreSQL 临时消息', temporary: true },
    ] }]],
  }));
  const hits = await repository.query({ projectId: 'Alpha', query: 'PostgreSQL', includeGlobal: false });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, 'real-assistant');
  assert.equal(hits[0].role, 'assistant');
  assert.equal((await repository.query({ projectId: 'Alpha', query: '内部思考' })).length, 0);
  assert.equal((await repository.query({ projectId: 'Alpha', query: '机密' })).length, 0);
  assert.equal((await repository.query({ projectId: 'Alpha', query: '临时消息' })).length, 0);
  assert.equal((await repository.query({ projectId: 'Beta', query: 'PostgreSQL' })).length, 0);
});

test('context uses exact scope, pinned order, budgets, provenance lines and never allProjects', async () => {
  const { repository } = fixture();
  const alpha = JSON.stringify(['CodeMova', 'Alpha', 'Chat']);
  await repository.saveSessions(snapshotWith({
    projects: [{ name: 'Alpha' }],
    conversations: [[alpha, [{ id: 'm1', text: '项目设计讨论' }]]],
  }));
  await repository.saveMemory({ text: '全局中文偏好', projectId: null });
  const pinned = await repository.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha', pinned: true });
  await repository.saveMemory({ text: '另一个项目设计', projectId: 'Beta' });
  await repository.ingest({ conversationId: alpha, projectId: 'Alpha', messageId: 'm1', text: '记住 项目偏好是深色主题' });

  const scoped = await repository.context({ projectId: 'Alpha', includeGlobal: true });
  assert.ok(scoped.memories.every(memory => memory.projectId === 'Alpha' || memory.projectId === null));
  assert.deepEqual(scoped.usedIds, scoped.memories.map(memory => memory.id));
  assert.equal(scoped.memories[0].id, pinned.id);
  const lines = scoped.text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(Object.keys(lines[0]).sort(), ['conversationId', 'expiresAt', 'id', 'messageId', 'observedAt', 'source', 'text', 'validTo']);
  assert.equal(lines[0].id, pinned.id);
  assert.equal(lines[0].source, 'user');
  assert.equal(lines[0].conversationId, null);
  const automatic = lines.find(line => line.source === 'automatic');
  assert.equal(automatic.conversationId, alpha);
  assert.equal(automatic.messageId, 'm1');

  // Budget/limit caps.
  const capped = await repository.context({ projectId: 'Alpha', includeGlobal: true, maxChars: 300, limit: 1 });
  assert.equal(capped.memories.length, 1);
  assert.ok(capped.text.length <= 300);
  await code(() => repository.context({ projectId: '' }), 'invalid-input');
  await code(() => repository.context({ maxChars: 100000 }), 'invalid-input');
  // Global scope only.
  assert.deepEqual((await repository.context({ projectId: null, includeGlobal: true })).memories.map(memory => memory.projectId), [null]);
  // Temporary requests and disabled memory produce nothing.
  assert.equal((await repository.context({ projectId: 'Alpha', temporary: true })).text, '');
  await repository.settings({ memoryEnabled: false });
  assert.equal((await repository.context({ projectId: 'Alpha' })).text, '');
  // allProjects is ignored by context; Beta memory never appears.
  await repository.settings({ memoryEnabled: true });
  const all = await repository.context({ projectId: 'Alpha', allProjects: true });
  assert.ok(all.memories.every(memory => memory.projectId !== 'Beta'));
});

// ---------------------------------------------------------------------------
// Memory lifecycle (§4, §6.3)
// ---------------------------------------------------------------------------
test('saveMemory validates input, dedupes and rejects sensitive content', async () => {
  const { repository } = fixture();
  await code(() => repository.saveMemory({ text: 'api_key=abc123' }), 'sensitive-content');
  await code(() => repository.saveMemory({ text: '记住我的密码是 abc123' }), 'sensitive-content');
  await code(() => repository.saveMemory({ text: '   ' }), 'invalid-input');
  await code(() => repository.saveMemory({ text: 'ok', status: 'superseded' }), 'invalid-input');
  await code(() => repository.saveMemory({ text: 'ok', kind: 'other' }), 'invalid-input');
  await code(() => repository.saveMemory({ text: 'ok', projectId: '' }), 'invalid-input');
  const first = await repository.saveMemory({ text: 'Use TypeScript', projectId: 'Alpha' });
  assert.equal(first.version, 1);
  assert.equal(first.source, 'user');
  assert.equal(first.status, 'active');
  assert.deepEqual(first.supersedes, []);
  const duplicate = await repository.saveMemory({ text: 'Use TypeScript', projectId: 'Alpha' });
  assert.equal(duplicate.id, first.id);
  assert.equal((await repository.read()).memories.length, 1);
});

test('explicit keys supersede only inside one scope; status/pin/delete follow the local semantics', async () => {
  const { repository, store } = fixture();
  const old = await repository.saveMemory({ text: 'Use JavaScript', key: 'language', projectId: 'Alpha' });
  const other = await repository.saveMemory({ text: 'Use Rust', key: 'language', projectId: 'Beta' });
  const next = await repository.saveMemory({ text: 'Use TypeScript', key: 'language', projectId: 'Alpha' });
  assert.equal(next.version, 2);
  assert.deepEqual(next.supersedes, [old.id]);
  const state = await repository.read();
  assert.equal(state.memories.find(memory => memory.id === old.id).status, 'superseded');
  assert.equal(state.memories.find(memory => memory.id === other.id).status, 'active');
  // Superseded memories cannot be revived.
  await code(() => repository.updateMemory(old.id, { status: 'active' }), 'invalid-status');
  // Disabled memories leave context but can be re-enabled when no key conflict exists.
  await repository.updateMemory(next.id, { text: 'Use TypeScript strict mode', pinned: true, status: 'disabled' });
  assert.equal((await repository.context({ projectId: 'Alpha' })).memories.length, 0);
  await repository.updateMemory(next.id, { status: 'active' });
  assert.equal((await repository.context({ projectId: 'Alpha' })).memories[0].id, next.id);
  // Key conflict when another active memory shares scope+key.
  await code(() => repository.updateMemory(old.id, { status: 'active' }), 'invalid-status');
  assert.equal(await repository.deleteMemory(next.id), true);
  assert.equal(await repository.deleteMemory(next.id), false);
  await code(() => repository.updateMemory('not-a-uuid', { pinned: true }), 'not-found');
  await code(() => repository.updateMemory(next.id, { pinned: true }), 'not-found');
  await code(() => repository.updateMemory(other.id, { kind: 'fact' }), 'invalid-input');
  await code(() => repository.updateMemory(other.id, { pinned: 'yes' }), 'invalid-input');
  await code(() => repository.updateMemory(other.id, { text: 'api_key=abc' }), 'sensitive-content');
  // Delete propagation removes index chunks as well.
  store.state.chunks.push({ sourceKind: 'memory', sourceId: other.id, content: 'indexed' });
  assert.equal(await repository.deleteMemory(other.id), true);
  assert.equal(store.state.chunks.filter(chunk => chunk.sourceId === other.id).length, 0);
});

test('LLM extraction keeps project scope for CodeMova and saves explicit global memories for ChatMova', async () => {
  const { repository } = fixture();
  const project = await repository.ingest({
    conversationId: 'conv-1',
    projectId: 'Alpha',
    messageId: 'm1',
    text: '我喜欢简洁的中文回答。我们决定采用本地存储。今天下雨了。',
  });
  assert.equal(project.extracted.length, 2);
  assert.ok(project.extracted.every(memory => memory.source === 'automatic'
    && memory.conversationId === 'conv-1' && memory.messageId === 'm1' && memory.projectId === 'Alpha'));
  const kinds = project.extracted.map(memory => memory.kind).sort();
  assert.deepEqual(kinds, ['decision', 'preference']);
  // Same message is idempotent; provenance rows make it discoverable again.
  const duplicate = await repository.ingest({ conversationId: 'conv-1', projectId: 'Alpha', messageId: 'm1', text: 'ignored on retry' });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.extracted.map(memory => memory.id).sort(), project.extracted.map(memory => memory.id).sort());
  // New messages continue to work.
  assert.equal((await repository.ingest({ conversationId: 'conv-1', projectId: 'Alpha', messageId: 'm2', text: '今天天气不错' })).extracted.length, 0);
  // ChatMova: the LLM decides what is durable; the result is global.
  const global = await repository.ingest({ conversationId: 'chat', messageId: 'g1', text: '我喜欢简洁的界面。我决定使用 MySQL。' });
  assert.equal(global.extracted.length, 2);
  assert.ok(global.extracted.every(memory => memory.projectId === null));
  assert.deepEqual(global.extracted.map(memory => memory.kind).sort(), ['decision', 'preference']);
  assert.equal((await repository.context({ projectId: 'Alpha', includeGlobal: true })).memories.length, 4);
  assert.equal((await repository.context({ projectId: 'Alpha', includeGlobal: false })).memories.length, 2);
});

test('explicit remember facts are global in ChatMova and survive a new conversation', async () => {
  const { repository } = fixture();
  const result = await repository.ingest({
    conversationId: '["ChatMova","Mova","第一段对话"]',
    messageId: 'msg-1887',
    text: '记住我说了1887这四个数字',
  });
  assert.equal(result.extracted.length, 1);
  assert.equal(result.extracted[0].projectId, null);
  assert.equal(result.extracted[0].kind, 'fact');
  assert.equal(result.extracted[0].source, 'automatic');
  assert.match(result.extracted[0].text, /1887/);
  assert.doesNotMatch(result.extracted[0].text, /^记住/);
  // A different conversation must receive the global fact as quoted memory.
  const context = await repository.context({
    projectId: null,
    includeGlobal: true,
    query: '你记得我在别的对话里说的四个数字吗',
  });
  assert.equal(context.enabled, true);
  assert.equal(context.memories.length, 1);
  assert.match(context.text, /1887/);
  assert.match(context.text, /msg-1887/);
  // A generic recall question shares no useful token with the saved fact.
  const generic = await repository.context({
    projectId: null,
    includeGlobal: true,
    query: '你还记得我让你记住什么吗',
  });
  assert.match(generic.text, /1887/);
});

test('natural-language forget/correct commands execute locally and ambiguous targets require confirmation', async () => {
  const { repository } = fixture();
  const memory = await repository.saveMemory({ text: '我的幸运数字是 1887', projectId: null });
  const corrected = await repository.ingest({ conversationId: 'c', messageId: 'correct', text: '把 1887 改成 1888' });
  assert.equal(corrected.action, 'correct');
  assert.match(corrected.text, /1888/);
  const after = await repository.read();
  assert.equal(after.memories.find(item => item.id === memory.id).text, '我的幸运数字是 1888');
  const forgotten = await repository.ingest({ conversationId: 'c', messageId: 'forget', text: '忘记 1888' });
  assert.equal(forgotten.action, 'forget');
  assert.equal((await repository.read()).memories.length, 0);

  await repository.saveMemory({ text: '1887 是测试编号', projectId: null });
  await repository.saveMemory({ text: '我的数字是 1887', projectId: null });
  const ambiguous = await repository.ingest({ conversationId: 'c', messageId: 'ambiguous', text: '忘记 1887' });
  assert.equal(ambiguous.action, 'confirm');
  assert.ok(ambiguous.candidates.length >= 2);
  assert.equal((await repository.read()).memories.length, 2);
});

test('LLM extraction fails visibly instead of silently using rules', async () => {
  const { repository: unavailable } = fixture({ options: { extractor: null } });
  const missing = await unavailable.ingest({ conversationId: 'c', messageId: 'm', text: '记住 1887' });
  assert.equal(missing.skipped, 'llm-unavailable');
  assert.equal(missing.extractor, 'llm');
  assert.equal(missing.extracted.length, 0);

  const error = Object.assign(new Error('timeout'), { code: 'llm-timeout' });
  const { repository: failing } = fixture({ options: { extractor: createTestExtractor({ error }) } });
  const failed = await failing.ingest({ conversationId: 'c', messageId: 'm2', text: '记住 1887' });
  assert.equal(failed.skipped, 'llm-failed');
  assert.equal(failed.error, 'llm-timeout');
  assert.equal(failed.extracted.length, 0);
});

test('legacy rules setting migrates to LLM on read and cannot be selected again', async () => {
  const { repository, store } = fixture();
  store.state.settings.extractorMode = 'rules';
  const value = await repository.settings();
  assert.equal(value.extractorMode, 'llm');
  await code(() => repository.settings({ extractorMode: 'rules' }), 'invalid-settings');
});

test('ingest skips ineligible, empty, sensitive, disabled and over-limit input', async () => {
  const { repository } = fixture();
  await code(() => repository.ingest(null), 'invalid-input');
  const input = { conversationId: 'c', projectId: 'Alpha', messageId: 'm', text: '我喜欢中文回答' };
  assert.equal((await repository.ingest({ ...input, temporary: true })).skipped, 'ineligible');
  for (const role of ['assistant', 'tool', 'bot', 'system']) {
    assert.equal((await repository.ingest({ ...input, messageId: role, role })).skipped, 'ineligible');
  }
  assert.equal((await repository.ingest({ ...input, messageId: 'author', author: 'tool' })).skipped, 'ineligible');
  assert.equal((await repository.ingest({ ...input, messageId: 'empty', text: '   ' })).skipped, 'empty');
  assert.equal((await repository.ingest({ ...input, messageId: 'q', text: 'I prefer Python?' })).extracted.length, 0);
  for (const text of ['记住我的密码是 abc123', 'I use api_key=abc123', '请记住 sk-abcdefghijklmnop', '记住 Bearer confidential']) {
    assert.equal((await repository.ingest({ ...input, messageId: text, text })).skipped, 'sensitive-content');
  }
  await repository.settings({ autoExtract: false });
  assert.equal((await repository.ingest(input)).skipped, 'disabled');
  await repository.settings({ autoExtract: true, extractorMode: 'off' });
  assert.equal((await repository.ingest(input)).skipped, 'disabled');
  await repository.settings({ extractorMode: 'llm', maxMemories: 1 });
  assert.equal((await repository.ingest({ ...input, messageId: 'cap' })).extracted.length, 1);
  assert.equal((await repository.ingest({ ...input, messageId: 'cap2' })).skipped, 'memory-limit');
  await code(() => repository.saveMemory({ text: 'over cap' }), 'memory-limit');
});

test('automatic database decisions supersede previous versions and stay traceable', async () => {
  const { repository } = fixture();
  const input = { conversationId: 'db-chat', projectId: 'Alpha', messageId: 'mysql', text: '本项目使用 MySQL' };
  const old = (await repository.ingest(input)).extracted[0];
  const latest = (await repository.ingest({ ...input, messageId: 'postgres', text: '本项目改用 PostgreSQL，不使用 MySQL 了' })).extracted[0];
  assert.equal(old.key, 'database');
  assert.equal(latest.key, 'database');
  assert.equal(latest.version, 2);
  assert.deepEqual(latest.supersedes, [old.id]);
  const context = await repository.context({ projectId: 'Alpha' });
  assert.deepEqual(context.memories.map(memory => memory.id), [latest.id]);
  const line = JSON.parse(context.text.trim());
  assert.equal(line.conversationId, 'db-chat');
  assert.equal(line.messageId, 'postgres');
});

// ---------------------------------------------------------------------------
// Settings, export, clear
// ---------------------------------------------------------------------------
test('settings merge defaults, accept the new service keys and reject invalid values', async () => {
  const { repository } = fixture();
  assert.deepEqual(await repository.settings(), DEFAULT_SETTINGS);
  const patched = await repository.settings({ semanticSearch: false, hybridWeight: 0.25, extractorMode: 'llm', backupSchedule: 'weekly 03:00', backupRetentionDays: 90, autoStartServices: false, quotaBytes: 0 });
  assert.equal(patched.semanticSearch, false);
  assert.equal(patched.hybridWeight, 0.25);
  assert.equal(patched.extractorMode, 'llm');
  assert.equal(patched.backupSchedule, 'weekly 03:00');
  assert.equal(patched.backupRetentionDays, 90);
  assert.equal(patched.autoStartServices, false);
  assert.deepEqual(await repository.settings(), patched);
  await code(() => repository.settings({ unknownKey: 1 }), 'invalid-settings');
  await code(() => repository.settings({ historyRetention: '7days' }), 'invalid-settings');
  await code(() => repository.settings({ semanticSearch: 'yes' }), 'invalid-settings');
  await code(() => repository.settings({ extractorMode: 'magic' }), 'invalid-settings');
  await code(() => repository.settings({ backupSchedule: 'hourly' }), 'invalid-settings');
  await code(() => repository.settings({ hybridWeight: 2 }), 'invalid-input');
  await code(() => repository.settings({ contextMaxChars: 100000 }), 'invalid-input');
  await code(() => repository.settings({ backupRetentionDays: 0 }), 'invalid-input');
  await code(() => repository.settings(null), 'invalid-settings');
});

test('exportData and clear only touch repository data', async () => {
  const { repository, store } = fixture();
  await repository.saveSessions(snapshotWith({ projects: [{ name: 'Alpha' }], conversations: [[JSON.stringify(['CodeMova', 'Alpha', 'Chat']), [{ id: 'm', text: '会话内容' }]]] }));
  await repository.saveMemory({ text: 'Original preference', projectId: 'Alpha' });
  const exported = await repository.exportData();
  assert.equal(exported.version, 1);
  assert.equal(exported.ownerId, SINGLE_USER_ID);
  assert.equal(exported.memories.length, 1);
  assert.equal(exported.sessions.conversations.length, 1);
  assert.ok(!exported.storage.filePath.includes('super-secret'));
  await repository.clear({ target: 'memories' });
  assert.equal((await repository.read()).memories.length, 0);
  assert.equal((await repository.read()).sessions.conversations.length, 1);
  await repository.clear({ target: 'sessions' });
  assert.equal((await repository.read()).sessions.conversations.length, 0);
  assert.equal(store.state.conversations.size, 0);
  await repository.clear({ target: 'tasks' });
  await code(() => repository.clear({ target: 'unknown' }), 'invalid-target');
  await code(() => repository.clear({}), 'invalid-target');
  await repository.settings({ maxMemories: 5 });
  await repository.clear({ target: 'all' });
  assert.deepEqual(await repository.settings(), DEFAULT_SETTINGS);
});

// ---------------------------------------------------------------------------
// Health, stats, backups, reindex
// ---------------------------------------------------------------------------
test('health never throws and reports missing optional services honestly', async () => {
  const { repository } = fixture();
  const status = await repository.health();
  assert.equal(status.mode, 'postgres');
  assert.equal(status.database, 'ok');
  assert.equal(status.redis, 'disabled');
  assert.equal(status.objectStorage, 'disabled');
  assert.equal(status.embedding, 'down');
  assert.equal(status.embeddingModel, 'Xenova/multilingual-e5-small');
  assert.equal(status.embeddingDim, 384);
  assert.equal(status.queueLag, 0);
  assert.match(status.message, /embedding/i);

  const failing = fixture({ fake: { faults: { ping: true } } });
  const down = await failing.repository.health();
  assert.equal(down.database, 'down');
  assert.match(down.message, /database unavailable/);

  const unmigrated = fixture({ fake: { faults: { schema: true } } });
  assert.equal((await unmigrated.repository.health()).database, 'migrating');
});

test('health and stats probe queue, object storage and embedding when injected', async () => {
  const queue = {
    getWaitingCount: async () => 3,
    getFailedCount: async () => 1,
    client: { ping: async () => 'PONG' },
    add: async () => ({ id: 'job' }),
  };
  const embeddingService = {
    model: 'Xenova/multilingual-e5-small',
    dim: 384,
    status: async () => 'ok',
    embed: async texts => texts.map(() => new Array(384).fill(0.01)),
  };
  const backupManager = { health: async () => true, create: async () => ({ path: '/tmp/x', bytes: 1 }), restore: async () => true };
  const { repository } = fixture({ options: { queue, embeddingService, backupManager } });
  const status = await repository.health();
  assert.equal(status.database, 'ok');
  assert.equal(status.redis, 'ok');
  assert.equal(status.objectStorage, 'ok');
  assert.equal(status.embedding, 'ok');
  assert.equal(status.queueLag, 3);
  const stats = await repository.stats();
  assert.deepEqual(stats, {
    databaseBytes: 8192,
    attachmentBytes: 0,
    queueWaiting: 3,
    queueFailed: 1,
    memories: 0,
    conversations: 0,
    events: 0,
    quotaBytes: null,
    indexPath: null,
  });
  // A queue without a probe must not claim to be connected.
  const noProbe = fixture({ options: { queue: { add: async () => ({}) } } });
  assert.equal((await noProbe.repository.health()).redis, 'down');
});

test('stats degrades to zeros while the database is down', async () => {
  const { repository } = fixture({ fake: { faults: { ping: true, databaseBytes: true } } });
  const stats = await repository.stats();
  assert.equal(stats.databaseBytes, 0);
  assert.equal(stats.memories, 0);
});

test('backup/restore require their service and record failures without deleting data', async () => {
  const { repository, store } = fixture();
  await code(() => repository.backup({ kind: 'manual' }), 'backup-unavailable');
  await code(() => repository.restore('00000000-0000-4000-8000-000000000099'), 'restore-unavailable');

  const failing = { create: async () => { throw new Error('pg_dump failed for postgres://mova:secret@host/db'); } };
  const { repository: failingRepository } = fixture({ options: { backupManager: failing } });
  const failed = await failingRepository.backup({ kind: 'manual' });
  assert.equal(failed.status, 'failed');
  assert.ok(!failed.error.includes('secret'));
  assert.match(failed.error, /pg_dump failed/);

  const manager = {
    create: async ({ kind }) => ({ path: `/backups/${kind}.sql`, bytes: 4096 }),
    restore: async record => { assert.equal(record.status, 'completed'); return true; },
    health: async () => true,
  };
  const { repository: goodRepository } = fixture({ options: { backupManager: manager } });
  const record = await goodRepository.backup({ kind: 'manual' });
  assert.equal(record.status, 'completed');
  assert.equal(record.path, '/backups/manual.sql');
  assert.equal(record.bytes, 4096);
  assert.ok(record.completedAt);
  const list = await goodRepository.listBackups();
  assert.equal(list.length, 1);
  assert.deepEqual(await goodRepository.restore(record.id), { restored: true });
  assert.equal(store.state.backups.length, 0, 'fixture store is separate');
  const { repository: badRestore } = fixture({ options: { backupManager: manager } });
  await code(() => badRestore.restore('00000000-0000-4000-8000-000000000042'), 'not-found');
});

test('reindex clears chunks and reports queued work, or fails clearly without a service', async () => {
  const { repository } = fixture();
  await code(() => repository.reindex(), 'service-unavailable');

  const added = [];
  const queue = { add: async (...args) => { added.push(args); return {}; }, getWaitingCount: async () => 0 };
  const { repository: queuedRepository, store: queuedStore } = fixture({ options: { queue } });
  await queuedRepository.saveSessions(snapshotWith({
    projects: [{ name: 'Alpha' }],
    conversations: [[JSON.stringify(['CodeMova', 'Alpha', 'Chat']), [{ id: 'm', text: '会话内容' }]]],
  }));
  queuedStore.state.chunks.push({ sourceKind: 'memory', sourceId: 'x', content: 'chunk' });
  const result = await queuedRepository.reindex();
  assert.equal(result.queued, 1);
  assert.equal(queuedStore.state.chunks.length, 0);
  const reindexJobs = added.filter(args => String(args[2].jobId).startsWith('reindex:'));
  assert.equal(reindexJobs.length, 1);
  const syncJobs = added.filter(args => args[0] === 'mova-session-sync');
  assert.equal(syncJobs.length, 1, 'saveSessions also enqueues session sync');

  const engine = { rebuild: async () => ({ queued: 7 }) };
  const { repository: engineRepository } = fixture({ options: { searchEngine: engine } });
  assert.deepEqual(await engineRepository.reindex(), { queued: 7 });
});

test('ingest does not enqueue a no-op extract job; chunk indexing still queues', async () => {
  const added = [];
  const queue = { add: async (...args) => { added.push(args); return {}; } };
  const embeddingService = { status: async () => 'ok', embed: async texts => texts.map(() => new Array(384).fill(0.02)) };
  const { repository } = fixture({ options: { queue, embeddingService } });
  const result = await repository.ingest({ conversationId: 'c', projectId: 'Alpha', messageId: 'm', text: '我喜欢简洁的回答' });
  assert.equal(result.extracted.length, 1);
  assert.equal(result.queued, undefined);
  assert.ok(!added.some(args => args[0] === 'mova-memory-extract'), 'LLM extraction is synchronous, not a queued no-op');
  // Every queued chunk job uses chunkId + embeddingVersion (contract §8).
  const chunkJobs = added.filter(args => args[1].chunkId);
  assert.ok(chunkJobs.length >= 1);
  assert.ok(chunkJobs.every(args => args[2].jobId === `${args[1].chunkId}:1`));
});

test('close is idempotent and clears the seed latch', async () => {
  const { repository } = fixture();
  await repository.close();
  await repository.close();
  assert.deepEqual(await repository.settings(), DEFAULT_SETTINGS);
});

test('semantic channel falls back to keyword search when embedding is down and never fakes vectors', async () => {
  const embeddingService = {
    status: async () => 'down',
    embed: async () => { throw new Error('model unavailable'); },
  };
  const { repository, store } = fixture({ options: { embeddingService } });
  await repository.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha' });
  assert.equal(store.state.chunks.length, 0, 'no chunk is written when embedding fails');
  const hits = await repository.query({ query: '项目设计', projectId: 'Alpha', includeGlobal: false });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'memory');
  assert.equal((await repository.health()).embedding, 'down');
});

// ---------------------------------------------------------------------------
// Hybrid retrieval wiring (§7) and indexing hooks
// ---------------------------------------------------------------------------
test('query() uses searchEngine.searchWithMeta for hybrid RRF and drops out-of-scope hits', async () => {
  let engineRows = [];
  const calls = [];
  const engine = {
    searchWithMeta: async request => {
      calls.push(request);
      return { hits: engineRows, meta: { fused: true } };
    },
  };
  const embeddingService = { status: async () => 'ok', embed: async texts => texts.map(() => new Array(384).fill(0.02)) };
  const { repository } = fixture({ options: { searchEngine: engine, embeddingService } });
  const alpha = JSON.stringify(['CodeMova', 'Alpha', 'Chat']);
  await repository.saveSessions(snapshotWith({
    projects: [{ name: 'Alpha' }, { name: 'Beta' }],
    conversations: [[alpha, [{ id: 'a', text: '中文项目设计' }]]],
  }));
  const alphaMemory = await repository.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha' });
  const betaMemory = await repository.saveMemory({ text: '项目设计使用 Rust', projectId: 'Beta' });

  engineRows = [
    { kind: 'memory', id: alphaMemory.id, score: 0.91 },
    { kind: 'memory', id: betaMemory.id, score: 0.99 }, // must be dropped: other project
    { kind: 'session', conversationId: alpha, messageId: 'a', text: '中文项目设计', score: 0.8 },
    { kind: 'session', conversationId: alpha, messageId: 'ghost', text: '项目设计 幽灵消息', score: 0.97 }, // unknown message
    { kind: 'session', conversationId: 'unknown-conversation', messageId: 'x', text: '项目设计 未知会话', score: 0.98 },
  ];
  const hits = await repository.query({ query: '项目设计', projectId: 'Alpha', includeGlobal: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, '项目设计');
  assert.equal(calls[0].projectId, 'Alpha');
  assert.equal(calls[0].includeGlobal, false);
  assert.equal(calls[0].allProjects, false);
  assert.equal(calls[0].includeSessions, true);
  assert.equal(calls[0].ownerId, SINGLE_USER_ID);
  assert.equal(calls[0].embeddingModel, 'Xenova/multilingual-e5-small');
  // No cross-project and no hallucinated conversation leaks.
  assert.equal(hits.filter(hit => hit.kind === 'memory' && hit.projectId === 'Beta').length, 0);
  assert.equal(hits.filter(hit => hit.messageId === 'ghost' || hit.messageId === 'x').length, 0);
  // Hit shapes stay renderer-compatible.
  const memoryHit = hits.find(hit => hit.kind === 'memory');
  assert.equal(memoryHit.id, alphaMemory.id);
  assert.equal(memoryHit.memoryKind, 'fact');
  const sessionHit = hits.find(hit => hit.kind === 'session');
  assert.equal(sessionHit.conversationId, alpha);
  assert.equal(sessionHit.id, `${alpha}:a`);
  assert.equal(sessionHit.role, 'user');
  assert.ok(hits.every(hit => typeof hit.score === 'number' && hit.score > 0 && hit.score < 1), 'fused RRF scores');

  // includeSessions:false is forwarded and session hits are suppressed.
  const memoryOnly = await repository.query({ query: '项目设计', projectId: 'Alpha', includeSessions: false });
  assert.equal(calls.at(-1).includeSessions, false);
  assert.ok(memoryOnly.every(hit => hit.kind === 'memory'));

  // semanticSearch off: the engine is not consulted at all.
  await repository.settings({ semanticSearch: false });
  const before = calls.length;
  await repository.query({ query: '项目设计', projectId: 'Alpha' });
  assert.equal(calls.length, before);
  await repository.settings({ semanticSearch: true });

  // Engine failure falls back to keyword hits without throwing.
  const broken = { searchWithMeta: async () => { throw new Error('vector index down'); } };
  const { repository: brokenRepository } = fixture({ options: { searchEngine: broken } });
  await brokenRepository.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha' });
  const fallback = await brokenRepository.query({ query: '项目设计', projectId: 'Alpha' });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].kind, 'memory');
});

test('context filters unrelated memories for specific requests and does not backfill reranker choices', async () => {
  let selectedId;
  const extractor = { rerank: async () => ({ ids: [selectedId] }) };
  const { repository } = fixture({ options: { extractor } });
  const relevant = await repository.saveMemory({ text: '数据库使用 PostgreSQL', projectId: 'Alpha' });
  await repository.saveMemory({ text: '数据库使用 SQLite 作为缓存', projectId: 'Alpha' });
  const unrelated = await repository.saveMemory({ text: '喜欢海边旅行', projectId: 'Alpha' });
  const specific = await repository.context({ projectId: 'Alpha', query: '数据库', limit: 1 });
  assert.equal(specific.memories.some(memory => memory.id === unrelated.id), false);
  selectedId = relevant.id;
  const generic = await repository.context({ projectId: 'Alpha', query: '我让你记住什么', limit: 2 });
  assert.deepEqual(generic.memories.map(memory => memory.id), [relevant.id]);
});

test('context() uses engine relevance only to reorder exact-scope memories', async () => {
  const requests = [];
  const engine = {
    searchWithMeta: async request => {
      requests.push(request);
      return { hits: [{ kind: 'memory', id: relevanceOrder[0] ?? '' }, { kind: 'memory', id: relevanceOrder[1] ?? '' }] };
    },
  };
  const relevanceOrder = [];
  const { repository } = fixture({ options: { searchEngine: engine } });
  const first = await repository.saveMemory({ text: 'Alpha 设计 偏好一', projectId: 'Alpha' });
  const second = await repository.saveMemory({ text: 'Alpha 设计 偏好二', projectId: 'Alpha' });
  const beta = await repository.saveMemory({ text: 'Beta 设计 偏好', projectId: 'Beta' });
  relevanceOrder.push(second.id, first.id);
  const context = await repository.context({ projectId: 'Alpha', includeGlobal: true, query: '设计' });
  assert.equal(requests.at(-1).includeSessions, false);
  assert.equal(requests.at(-1).allProjects, false);
  assert.deepEqual(context.memories.map(memory => memory.id).slice(0, 2), [second.id, first.id]);
  assert.equal(context.memories.some(memory => memory.id === beta.id), false, 'Beta memory is never added');
  // No engine request when the query is empty.
  const before = requests.length;
  await repository.context({ projectId: 'Alpha' });
  assert.equal(requests.length, before);
});

test('indexing hooks chunk memories/messages, fill gaps and stay idempotent', async () => {
  const embeddingService = { status: async () => 'ok', embed: async texts => texts.map(() => new Array(384).fill(0.02)) };
  const { repository, store } = fixture({ options: { embeddingService } });
  const alpha = JSON.stringify(['CodeMova', 'Alpha', 'Chat']);
  const memory = await repository.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha' });
  assert.equal(store.state.chunks.filter(chunk => chunk.sourceKind === 'memory' && chunk.sourceId === memory.id).length, 1);
  await repository.saveSessions(snapshotWith({
    projects: [{ name: 'Alpha' }],
    conversations: [[alpha, [{ id: 'a', text: '中文项目设计', reply: { text: '助手回复内容' } }]]],
  }));
  // saveSessions never chunks synchronously; the worker (or indexPending) does.
  assert.equal(store.state.chunks.filter(chunk => chunk.sourceKind === 'message').length, 0);
  const filled = await repository.indexPending({ limit: 50 });
  assert.equal(filled.indexed, 2);
  const messageChunks = store.state.chunks.filter(chunk => chunk.sourceKind === 'message');
  assert.equal(messageChunks.length, 2);
  assert.ok(messageChunks.every(chunk => chunk.conversationId === alpha));
  assert.deepEqual(messageChunks.map(chunk => chunk.messageId).sort(), ['a', 'a-assistant']);
  assert.ok(messageChunks.every(chunk => Array.isArray(chunk.contentNgrams) && chunk.content.length <= 1000));
  assert.deepEqual(await repository.indexPending({ limit: 50 }), { indexed: 0, queued: 0 });
  // Re-indexing a session replaces its chunks instead of duplicating them.
  const replaced = await repository.indexSession(alpha);
  assert.equal(replaced.indexed, 2);
  assert.equal(store.state.chunks.filter(chunk => chunk.sourceKind === 'message').length, 2);
  await code(() => repository.indexSession('missing-conversation'), 'not-found');
  assert.equal((await repository.indexMemory(memory.id)).indexed, 1);
  await code(() => repository.indexMemory('00000000-0000-4000-8000-000000000404'), 'not-found');
});

test('indexing hooks delegate to the queue when a worker is configured', async () => {
  const added = [];
  const queue = { add: async (...args) => { added.push(args); return {}; } };
  const embeddingService = { status: async () => 'ok', embed: async texts => texts.map(() => new Array(384).fill(0.02)) };
  const { repository } = fixture({ options: { queue, embeddingService } });
  await repository.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha' });
  const result = await repository.indexPending({ limit: 10 });
  assert.ok(result.queued >= 1);
  assert.ok(added.every(args => args[2].jobId === `${args[1].chunkId}:1`));
  await code(() => createPostgresRepository({ store: createFakeStore(), embeddingService: null }).indexPending(), 'embedding-unavailable');
});

test('saveSessions enqueues one idempotent session-sync job per conversation', async () => {
  const added = [];
  const queue = { add: async (...args) => { added.push(args); return {}; }, getWaitingCount: async () => 0 };
  const { repository } = fixture({ options: { queue } });
  const snapshot = snapshotWith({
    projects: [{ name: 'Alpha' }],
    conversations: [[JSON.stringify(['CodeMova', 'Alpha', 'Chat']), [{ id: 'a', text: '会话内容' }]]],
  });
  await repository.saveSessions(snapshot);
  await repository.saveSessions(snapshot);
  const sync = added.filter(args => args[0] === 'mova-session-sync');
  assert.equal(sync.length, 2);
  assert.equal(new Set(sync.map(args => args[2].jobId)).size, 1, 'jobId derives from stable event ids');
  assert.match(sync[0][2].jobId, /^sync:/);
  assert.deepEqual(sync[0][1].eventIds, ['a']);
});

// ---------------------------------------------------------------------------
// SQL layer shape (static)
// ---------------------------------------------------------------------------
test('SQL store exposes the store contract and rejects unconfigured queries', async () => {
  const store = createPgStore({ ownerId: SINGLE_USER_ID });
  for (const name of [
    'seed', 'transaction', 'settingsData', 'saveSettingsData', 'projects', 'ensureProject',
    'deleteUnusedProjects', 'conversations', 'upsertConversation', 'replaceMessageEvents',
    'deleteConversationsExcept', 'memories', 'searchMemories', 'searchMessages', 'memoryBySource',
    'insertMemory', 'updateMemory', 'deleteMemory', 'supersedeMemories', 'insertChunks',
    'deleteMemoryChunks', 'clearChunks', 'vectorSearch', 'counts', 'databaseBytes', 'ping',
    'schemaReady', 'clearMemories', 'clearSessions', 'clearAll', 'insertBackup', 'updateBackup',
    'backups', 'backup', 'close',
  ]) {
    assert.equal(typeof store[name], 'function', `${name} must exist`);
  }
  await assert.rejects(store.ping(), error => error.code === 'database-unavailable');
  await store.close();
});

// ---------------------------------------------------------------------------
// Integration test against a real PostgreSQL (opt-in)
// ---------------------------------------------------------------------------
const TEST_DB_URL = process.env.MOVA_TEST_DB_URL || '';
const TEST_DB_NAME = (() => {
  try { return new URL(TEST_DB_URL).pathname.replace(/^\//, ''); } catch { return ''; }
})();
const RUN_INTEGRATION = Boolean(TEST_DB_URL) && /test/i.test(TEST_DB_NAME);

test('integration: migrations, snapshot round trip, scope filters and health against MOVA_TEST_DB_URL', { skip: RUN_INTEGRATION ? false : 'MOVA_TEST_DB_URL not set (or database name lacks "test")' }, async t => {
  const pg = require('pg');
  const { migrate } = migrateModule;
  const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 4 });
  t.after(async () => { await pool.end(); });
  await migrate({ pool, log: () => {} });
  const status = await migrateModule.status({ pool });
  assert.equal(status.find(entry => entry.name === '001_init.sql')?.state, 'applied', '001_init.sql is applied');
  const second = await migrate({ pool, log: () => {} });
  assert.deepEqual(second.applied, [], 'migration is idempotent');
  assert.ok(second.skipped.includes('001_init.sql'));

  const { rows } = await pool.query('select count(*)::int as count from mova_users');
  assert.ok(rows[0].count >= 1, 'single owner row seeded');

  const repository = createPostgresRepository({ connectionString: TEST_DB_URL, inlineIndex: false });
  t.after(async () => { await repository.close(); });
  await repository.clear({ target: 'all' });
  await repository.settings({ semanticSearch: false });

  const alpha = JSON.stringify(['CodeMova', 'Alpha', 'Chat']);
  const turn = { id: 'int-turn-1', text: '中文项目设计', reply: { text: '真实回复', timeline: [] } };
  const snapshot = { version: 1, projects: [{ name: 'Alpha', sourceFolders: [{ name: 'src' }] }], conversations: [[alpha, [turn, { id: 'temp', text: '临时', temporary: true }]]] };
  await repository.saveSessions(snapshot);
  await repository.saveSessions(snapshot);
  const afterFirst = await repository.loadSessions();
  assert.equal(afterFirst.conversations.length, 1);
  assert.deepEqual(afterFirst.conversations[0][1], [turn]);

  const counts = await repository.stats();
  assert.equal(counts.conversations, 1);
  assert.equal(counts.events, 1, 'repeated saves do not duplicate events');
  assert.equal(counts.memories, 0);

  const old = await repository.saveMemory({ text: 'Use MySQL', key: 'database', projectId: 'Alpha' });
  const latest = await repository.saveMemory({ text: 'Use PostgreSQL', key: 'database', projectId: 'Alpha' });
  assert.equal(latest.version, 2);
  assert.deepEqual(latest.supersedes, [old.id]);
  const global = await repository.saveMemory({ text: '全局偏好', projectId: null });
  const scopedHits = await repository.query({ query: 'PostgreSQL', projectId: 'Alpha', includeGlobal: false });
  assert.deepEqual(scopedHits.filter(hit => hit.kind === 'memory').map(hit => hit.id), [latest.id]);
  const context = await repository.context({ projectId: 'Alpha', includeGlobal: true });
  assert.deepEqual(context.memories.map(memory => memory.id).sort(), [latest.id, global.id].sort());
  const merged = await repository.settings({ semanticSearch: true });
  assert.equal(merged.semanticSearch, true);
  assert.equal(merged.hybridWeight, 0.5);
  await repository.deleteMemory(latest.id);
  const afterDelete = await repository.read();
  assert.equal(afterDelete.memories.length, 2, 'superseded history and the global memory remain');
  assert.equal(afterDelete.memories.some(memory => memory.id === latest.id), false);
  const health = await repository.health();
  assert.equal(health.database, 'ok');
  assert.equal(health.mode, 'postgres');
  assert.ok(!(await repository.read()).storage.filePath.includes('mova_local_password'));
  await repository.clear({ target: 'all' });
  assert.equal((await repository.stats()).memories, 0);
});
