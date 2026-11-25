'use strict';

/**
 * Session event log — a compatibility layer over `mova_session_events`.
 *
 * Contract: Mova服务版接口约定.md §10 (authoritative) and §3.2; dev doc §5.
 *
 * Important naming/scope statement:
 *  - This is NOT the official Pi `SessionManager` and must not be described as
 *    one. The installed Pi SDK version does not ship a `SessionManager`, so this
 *    module implements “compatible-with-SessionManager semantics” only:
 *    append/list/load/rebuild over a stable event log.
 *  - It never overwrites Pi agent state (`session.agent.state.messages`) and never
 *    pretends a restore happened by mutating runtime state. It only persists
 *    events into PostgreSQL and rebuilds portable, user-visible messages.
 *  - `rebuildMessages` deliberately omits private reasoning: no `thinking`,
 *    `reasoning`, or provider-signed thinking blocks are copied, because they are
 *    not portable across models (dev doc §5.3/§5.4).
 *  - JSON snapshots and PostgreSQL must not become two writable authorities: the
 *    renderer snapshot stays the runtime record, this log is the durable mirror.
 *
 * Supported event types: message / tool_call / tool_result / model_change /
 * compaction / branch / task_event (task_event is the dev doc §5.1 extension).
 *
 * Storage is injected via `query(text, params)` (pg Pool/PoolClient-compatible),
 * so tests need no PostgreSQL.
 */

const { createHash } = require('node:crypto');

const EVENT_TYPES = Object.freeze(['message', 'tool_call', 'tool_result', 'model_change', 'compaction', 'branch', 'task_event']);
const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'tool', 'system']);
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_LIST_LIMIT = 5_000;
const MAX_TOOL_CHARS = 4_000;
const MAX_TEXT_CHARS = 200_000;

const COLUMNS = 'event_id, conversation_id, parent_event_id, sequence, type, role, content, model_id, provider_id, created_at';
const CHAIN_COLUMNS = COLUMNS.split(', ').map(column => `e.${column}`).join(', ');

/**
 * Only `mova_session_events` is touched. `sequence` is allocated in SQL when the
 * caller does not supply one; `event_id` conflicts are ignored so a redelivered
 * sync job is a no-op rather than a duplicate.
 */
const SQL = Object.freeze({
  insertEvent: `insert into mova_session_events (event_id, conversation_id, parent_event_id, sequence, type, role, content, model_id, provider_id, created_at)
values ($1, $2, $3, coalesce($4::bigint, (select coalesce(max(sequence), 0) + 1 from mova_session_events where conversation_id = $2)), $5, $6, $7::jsonb, $8, $9, coalesce($10::timestamptz, now()))
on conflict (event_id) do nothing
returning ${COLUMNS}`,
  getEvent: `select ${COLUMNS} from mova_session_events where event_id = $1`,
  latestSequence: `select coalesce(max(sequence), 0) as sequence from mova_session_events where conversation_id = $1`,
  latestEvent: `select ${COLUMNS} from mova_session_events where conversation_id = $1 order by sequence desc limit 1`,
  listEvents: `select ${COLUMNS} from mova_session_events
where conversation_id = $1 and sequence >= $2 and sequence <= $3
order by sequence asc
limit $4`,
  listEventChain: `with recursive chain as (
  select ${COLUMNS} from mova_session_events where conversation_id = $1 and event_id = $2
  union all
  select ${CHAIN_COLUMNS} from mova_session_events e join chain c on e.event_id = c.parent_event_id where e.conversation_id = $1
)
select * from chain order by sequence asc limit $3`,
  countEvents: `select count(*)::int as count from mova_session_events where conversation_id = $1`,
  lastModelChange: `select ${COLUMNS} from mova_session_events where conversation_id = $1 and type = 'model_change' order by sequence desc limit 1`,
});

class SessionStoreError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'SessionStoreError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function normalizeLogger(logger) {
  const noop = () => {};
  return {
    debug: typeof logger?.debug === 'function' ? logger.debug.bind(logger) : noop,
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : noop,
  };
}

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) throw new SessionStoreError('invalid-input', label);
  return value.trim().slice(0, max);
}

function optionalText(value, max, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SessionStoreError('invalid-input', label);
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function stableStringify(value) {
  try {
    return JSON.stringify(value, (key, item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
      }
      return item;
    });
  } catch {
    throw new SessionStoreError('invalid-content');
  }
}

function hashParts(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safe(error) {
  const message = typeof error === 'string' ? error : error?.message;
  if (typeof message !== 'string') return null;
  return message.replace(/(:\/\/[^:/@\s]*):[^@/\s]*@/g, '$1:***@').slice(0, 300);
}

function mapEvent(row) {
  if (!row) return null;
  let content = row.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      content = row.content;
    }
  }
  return {
    eventId: row.event_id ?? row.eventId,
    conversationId: row.conversation_id ?? row.conversationId,
    parentEventId: row.parent_event_id ?? row.parentEventId ?? null,
    sequence: Number(row.sequence),
    type: row.type,
    role: row.role ?? null,
    content,
    modelId: row.model_id ?? row.modelId ?? null,
    providerId: row.provider_id ?? row.providerId ?? null,
    createdAt: toIso(row.created_at ?? row.createdAt),
    duplicated: false,
  };
}

/** Deterministic event id; identical logical input always maps to one id. */
function eventIdFor({ conversationId, parentEventId = null, sequence = null, type, role = null, modelId = null, providerId = null, content }) {
  return `evt_${hashParts([
    'mova-session-event-v1',
    conversationId,
    parentEventId ?? '',
    sequence ?? '',
    type,
    role ?? '',
    modelId ?? '',
    providerId ?? '',
    stableStringify(content ?? null),
  ]).slice(0, 40)}`;
}

/**
 * Rebuild portable messages from events.
 *
 * Only user-visible text and tool results survive. Compaction points become a
 * summary message and cut the pre-compaction history (dev doc §5.5). Reasoning /
 * thinking fields are never read.
 */
function rebuildConversation(events, options = {}) {
  if (!Array.isArray(events)) throw new SessionStoreError('invalid-events');
  const maxToolChars = Number.isInteger(options.maxToolChars) && options.maxToolChars >= 40
    ? Math.min(options.maxToolChars, MAX_TEXT_CHARS)
    : MAX_TOOL_CHARS;
  const includeSummary = options.includeSummary !== false;
  const sorted = [...events]
    .filter(event => event && Number.isFinite(Number(event.sequence)))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

  let compactionIndex = -1;
  let compaction = null;
  sorted.forEach((event, index) => {
    if (event.type === 'compaction') {
      compactionIndex = index;
      compaction = event;
    }
  });

  const messages = [];
  const warnings = [];
  const pending = new Map();
  let model = null;

  if (compaction && includeSummary) {
    const summary = typeof compaction.content?.summary === 'string'
      ? compaction.content.summary
      : typeof compaction.content?.text === 'string' ? compaction.content.text : '';
    if (summary.trim()) messages.push({ role: 'system', kind: 'summary', text: summary.trim().slice(0, MAX_TEXT_CHARS), eventId: compaction.eventId, sequence: compaction.sequence });
    else warnings.push('compaction-without-summary');
  }

  for (const event of sorted.slice(compactionIndex + 1)) {
    if (event.type === 'message') {
      for (const part of visibleMessageParts(event)) {
        messages.push({ role: part.role, text: part.text, eventId: event.eventId, sequence: event.sequence, modelId: event.modelId ?? null });
      }
      continue;
    }
    if (event.type === 'model_change') {
      model = {
        modelId: event.modelId ?? event.content?.modelId ?? null,
        providerId: event.providerId ?? event.content?.providerId ?? null,
        thinkingLevel: event.content?.thinkingLevel ?? null,
        eventId: event.eventId,
        sequence: event.sequence,
      };
      continue;
    }
    if (event.type === 'tool_call') {
      const callId = String(event.content?.callId ?? event.content?.id ?? event.eventId);
      const name = typeof event.content?.name === 'string' ? event.content.name.slice(0, 200) : 'tool';
      const args = truncate(stringifyArguments(event.content?.arguments ?? event.content?.input ?? null), 2_000);
      const call = { callId, name, arguments: args.text, truncated: args.truncated, eventId: event.eventId, sequence: event.sequence };
      pending.set(callId, call);
      messages.push({ role: 'assistant', kind: 'tool_call', ...call });
      continue;
    }
    if (event.type === 'tool_result') {
      const callId = String(event.content?.callId ?? event.content?.id ?? '');
      if (callId) pending.delete(callId);
      const raw = toolResultText(event.content);
      const truncated = truncate(raw, maxToolChars);
      messages.push({
        role: 'tool',
        kind: 'tool_result',
        callId: callId || null,
        name: typeof event.content?.name === 'string' ? event.content.name.slice(0, 200) : pending.get(callId)?.name ?? 'tool',
        text: truncated.text,
        truncated: truncated.truncated,
        ...(event.content?.ref || event.content?.objectKey ? { ref: event.content.ref ?? event.content.objectKey } : {}),
        eventId: event.eventId,
        sequence: event.sequence,
      });
      continue;
    }
    // branch / task_event carry no message content; they matter for lineage only.
  }

  let interrupted = false;
  const lastMessage = [...sorted].reverse().find(event => event.type === 'message');
  if (lastMessage) {
    const status = lastMessage.content?.status ?? lastMessage.content?.reply?.status;
    interrupted = lastMessage.content?.interrupted === true || ['streaming', 'interrupted', 'error'].includes(status);
  }

  return {
    messages,
    model,
    compaction: compaction ? { eventId: compaction.eventId, sequence: compaction.sequence, summary: messages.find(message => message.kind === 'summary')?.text ?? null } : null,
    pendingToolCalls: [...pending.values()],
    interrupted,
    warnings,
  };
}

function truncate(value, max) {
  const string = typeof value === 'string' ? value : String(value ?? '');
  if (string.length <= max) return { text: string, truncated: false };
  return { text: `${string.slice(0, max)}…`, truncated: true };
}

function stringifyArguments(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!isObject(content)) return '';
  for (const key of ['text', 'result', 'summary', 'preview']) {
    if (typeof content[key] === 'string') return content[key];
  }
  if (content.ref || content.objectKey) return `[stored:${content.ref ?? content.objectKey}]`;
  return '';
}

/**
 * Visible text of a `message` event.
 * Handles both the renderer turn shape ({ user, reply }) that §3.2 stores and a
 * plain { text } message. Reasoning/thinking keys are intentionally ignored.
 */
function visibleMessageParts(event) {
  const content = event.content;
  const parts = [];
  if (typeof content === 'string') {
    if (event.role && event.role !== 'thinking' && content.trim()) parts.push({ role: event.role === 'assistant' ? 'assistant' : event.role, text: content.slice(0, MAX_TEXT_CHARS) });
    return parts;
  }
  if (!isObject(content)) return parts;
  const userText = typeof content.user === 'string' ? content.user : typeof content.user?.text === 'string' ? content.user.text : null;
  const replyText = typeof content.reply === 'string' ? content.reply : typeof content.reply?.text === 'string' ? content.reply.text : null;
  if (userText !== null && userText.trim()) parts.push({ role: 'user', text: userText.slice(0, MAX_TEXT_CHARS) });
  if (replyText !== null && replyText.trim()) parts.push({ role: 'assistant', text: replyText.slice(0, MAX_TEXT_CHARS) });
  if (!parts.length && typeof content.text === 'string' && content.text.trim()) {
    const role = event.role === 'assistant' ? 'assistant' : event.role === 'user' ? 'user' : null;
    if (role) parts.push({ role, text: content.text.slice(0, MAX_TEXT_CHARS) });
  }
  return parts;
}

/** Strip reasoning-like fields before anything is persisted or rebuilt. */
const PRIVATE_KEYS = Object.freeze(['thinking', 'reasoning', 'reasoningContent', 'reasoning_content', 'thinkingBlocks', 'thinkingSignature', 'thought']);
function stripPrivateReasoning(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => !(isObject(item) && ['thinking', 'thought'].includes(item.type)))
      .map(stripPrivateReasoning);
  }
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.includes(key)) continue;
    const cleaned = stripPrivateReasoning(item);
    // The UI transcript keeps reasoning as `timeline: [{type:'thinking'}]`; drop
    // the key once every entry in it was reasoning, so nothing is implied to exist.
    if (key === 'timeline' && Array.isArray(cleaned) && cleaned.length === 0) continue;
    out[key] = cleaned;
  }
  return out;
}

/**
 * Convert a renderer snapshot (§3.2 shape) into a deterministic event plan.
 * Pure function: no I/O, so the same snapshot always yields the same ids.
 */
function snapshotToEvents(snapshot, options = {}) {
  if (!isObject(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.conversations)) throw new SessionStoreError('invalid-snapshot');
  const includeReasoning = options.includeReasoning === true;
  const trackModelChanges = options.modelChanges === true;
  const only = Array.isArray(options.conversationIds) ? new Set(options.conversationIds) : null;
  const plan = [];
  const seen = new Set();

  for (const entry of snapshot.conversations) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new SessionStoreError('invalid-snapshot');
    const [conversationId, data] = entry;
    if (only && !only.has(conversationId)) continue;
    const meta = snapshotMeta(conversationId, data);
    if (meta.temporary) {
      plan.push({ conversationId, temporary: true, events: [] });
      continue;
    }
    const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
    const events = [];
    let parentEventId = options.parentEventId ?? null;
    let previousModel = null;
    let sequence = Number.isInteger(options.sequenceStart) && options.sequenceStart >= 0 ? options.sequenceStart : 0;
    for (const turn of messages) {
      if (!isObject(turn) || turn.temporary === true) continue;
      if (trackModelChanges) {
        const model = typeof turn.reply?.model === 'string' ? turn.reply.model : null;
        if (model && model !== previousModel) {
          const content = stripPrivateReasoning({ modelId: model, source: 'snapshot' });
          const eventId = turn.id ? `${turn.id}:model` : eventIdFor({ conversationId, parentEventId, sequence: sequence + 1, type: 'model_change', content });
          assertFreshEventId(seen, eventId);
          events.push({ eventId, conversationId, parentEventId, sequence: sequence + 1, type: 'model_change', role: null, content, modelId: model, providerId: null });
          parentEventId = eventId;
          sequence += 1;
          previousModel = model;
        }
      }
      const user = { text: typeof turn.text === 'string' ? turn.text : '' };
      if (Array.isArray(turn.imageIds) && turn.imageIds.length) user.imageIds = turn.imageIds.slice(0, 8);
      const reply = isObject(turn.reply) ? { ...turn.reply } : (typeof turn.reply === 'string' ? { text: turn.reply } : null);
      const attempts = Array.isArray(turn.attempts) ? turn.attempts : Array.isArray(reply?.attempts) ? reply.attempts : null;
      if (reply) delete reply.attempts;
      const content = includeReasoning
        ? { user: { ...user, ...(isObject(turn.thinking) ? { thinking: turn.thinking } : {}) }, reply, attempts }
        : stripPrivateReasoning({ user, reply, attempts });
      const sequenceValue = sequence + 1;
      const eventId = typeof turn.id === 'string' && turn.id.trim()
        ? turn.id.trim().slice(0, 300)
        : turn.id === undefined || turn.id === null
          ? eventIdFor({ conversationId, parentEventId, sequence: sequenceValue, type: 'message', role: null, content })
          : String(turn.id).slice(0, 300);
      assertFreshEventId(seen, eventId);
      events.push({ eventId, conversationId, parentEventId, sequence: sequenceValue, type: 'message', role: null, content, modelId: reply?.model ?? null, providerId: null });
      parentEventId = eventId;
      sequence = sequenceValue;
      if (typeof reply?.model === 'string') previousModel = reply.model;
    }
    plan.push({ conversationId, temporary: false, projectId: meta.projectId, events });
  }
  return plan;
}

/**
 * A snapshot turn id is used verbatim as `event_id` (§3.2). If the same id shows
 * up twice the log would silently drop the second turn, so the plan fails loudly.
 */
function assertFreshEventId(seen, eventId) {
  if (seen.has(eventId)) throw new SessionStoreError('duplicate-event-id', eventId);
  seen.add(eventId);
}

function snapshotMeta(id, data) {
  let parts;
  try {
    parts = JSON.parse(id);
  } catch {}
  const projectId = isObject(data) && Object.hasOwn(data, 'projectId') ? data.projectId : Array.isArray(parts) && parts[0] === 'CodeMova' ? parts[1] : null;
  const temporary = Boolean(data?.temporary || (Array.isArray(parts) && /temporary|临时/i.test(String(parts[0]))));
  return { projectId: projectId === undefined ? null : projectId, temporary };
}

/**
 * @param {object} options
 * @param {(text: string, params?: unknown[]) => Promise<{rows: object[]}>} options.query
 * @param {Function} [options.now]
 * @param {object} [options.logger]
 */
function createSessionStore(options = {}) {
  if (!isObject(options)) throw new SessionStoreError('invalid-options');
  if (typeof options.query !== 'function') throw new SessionStoreError('query-required');
  const query = options.query;
  const logger = normalizeLogger(options.logger);
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function normalizeInput(input) {
    if (!isObject(input)) throw new SessionStoreError('invalid-input');
    if (input.temporary === true) return null;
    const conversationId = text(input.conversationId, 1_000, 'conversationId');
    if (!EVENT_TYPES.includes(input.type)) throw new SessionStoreError('invalid-type', String(input.type));
    const role = input.role === undefined || input.role === null ? null : String(input.role);
    if (role !== null && !MESSAGE_ROLES.includes(role)) throw new SessionStoreError('invalid-role', role);
    if (input.type === 'message' && role === null && !isObject(input.content)) throw new SessionStoreError('invalid-content');
    if (input.content === undefined) throw new SessionStoreError('invalid-content');
    const serialized = stableStringify(input.content);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTENT_BYTES) throw new SessionStoreError('content-limit');
    const sequence = input.sequence === undefined || input.sequence === null
      ? null
      : Number.isSafeInteger(input.sequence) && input.sequence >= 1 ? input.sequence : (() => { throw new SessionStoreError('invalid-sequence'); })();
    const parentEventId = optionalText(input.parentEventId, 300, 'parentEventId');
    const eventId = optionalText(input.eventId, 300, 'eventId');
    const modelId = optionalText(input.modelId, 200, 'modelId');
    const providerId = optionalText(input.providerId, 200, 'providerId');
    const createdAt = input.createdAt === undefined || input.createdAt === null ? null : toIso(input.createdAt);
    if (createdAt === null && input.createdAt !== undefined && input.createdAt !== null) throw new SessionStoreError('invalid-timestamp');
    const resolvedId = eventId ?? eventIdFor({ conversationId, parentEventId, sequence, type: input.type, role, modelId, providerId, content: input.content });
    if (parentEventId && parentEventId === resolvedId) throw new SessionStoreError('invalid-parent');
    return { eventId: resolvedId, conversationId, parentEventId, sequence, type: input.type, role, content: input.content, serialized, modelId, providerId, createdAt };
  }

  async function insertOne(event, { idempotent = true } = {}) {
    let rows;
    try {
      ({ rows } = await query(SQL.insertEvent, [
        event.eventId,
        event.conversationId,
        event.parentEventId,
        event.sequence,
        event.type,
        event.role,
        event.serialized,
        event.modelId,
        event.providerId,
        event.createdAt ?? new Date(now()).toISOString(),
      ]));
    } catch (error) {
      if (error?.code === '23505') {
        const constraint = String(error.constraint ?? '');
        if (constraint.includes('sequence')) throw new SessionStoreError('sequence-conflict', constraint);
        if (idempotent) {
          const existing = await getEvent(event.eventId);
          if (existing) return { ...existing, duplicated: true };
        }
        throw new SessionStoreError('duplicate-event', constraint || safe(error));
      }
      logger.error?.('session.event-insert-failed', { eventId: event.eventId, code: error?.code ?? null, message: safe(error) });
      throw new SessionStoreError('storage-error', safe(error));
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row) return mapEvent(row);
    if (!idempotent) throw new SessionStoreError('duplicate-event', event.eventId);
    const existing = await getEvent(event.eventId);
    if (existing) return { ...existing, duplicated: true };
    throw new SessionStoreError('storage-error', 'insert returned no row');
  }

  async function getEvent(eventId) {
    const { rows } = await query(SQL.getEvent, [eventId]);
    return mapEvent(Array.isArray(rows) ? rows[0] : null);
  }

  /**
   * Append one event. Returns the stored event (with `duplicated: true` when the
   * id already existed). Returns `null` for temporary conversations: they must
   * never be persisted (§4/§8 of the dev doc).
   */
  async function appendEvent(input) {
    const normalized = normalizeInput(input);
    if (!normalized) return null;
    const event = await insertOne(normalized);
    logger.debug?.('session.event-appended', { eventId: event.eventId, duplicate: event.duplicated === true });
    return event;
  }

  async function appendEvents(inputs) {
    if (!Array.isArray(inputs)) throw new SessionStoreError('invalid-input');
    const out = [];
    for (const input of inputs) out.push(await appendEvent(input));
    return out;
  }

  async function listEvents(input = {}) {
    if (!isObject(input)) throw new SessionStoreError('invalid-input');
    const conversationId = text(input.conversationId, 1_000, 'conversationId');
    const limit = Number.isInteger(input.limit) && input.limit >= 1 ? Math.min(input.limit, MAX_LIST_LIMIT) : 1_000;
    const fromSequence = Number.isSafeInteger(input.fromSequence) && input.fromSequence >= 0 ? input.fromSequence : 0;
    const toSequence = Number.isSafeInteger(input.toSequence) && input.toSequence >= 0 ? input.toSequence : Number.MAX_SAFE_INTEGER;
    if (fromSequence > toSequence) throw new SessionStoreError('invalid-range');
    const leafEventId = optionalText(input.leafEventId, 300, 'leafEventId');
    const { rows } = leafEventId
      ? await query(SQL.listEventChain, [conversationId, leafEventId, limit])
      : await query(SQL.listEvents, [conversationId, fromSequence, toSequence, limit]);
    let events = (Array.isArray(rows) ? rows : []).map(mapEvent).filter(Boolean);
    // Type filtering happens after the SQL limit: the caller always gets at most
    // `limit` rows, ordered by sequence, optionally narrowed by type.
    if (Array.isArray(input.types) && input.types.length) {
      const allowed = new Set(input.types);
      events = events.filter(event => allowed.has(event.type));
    }
    return events;
  }

  async function latestSequence(conversationId) {
    const { rows } = await query(SQL.latestSequence, [text(conversationId, 1_000, 'conversationId')]);
    const row = Array.isArray(rows) ? rows[0] : null;
    return Number(row?.sequence ?? 0) || 0;
  }

  async function countEvents(conversationId) {
    const { rows } = await query(SQL.countEvents, [text(conversationId, 1_000, 'conversationId')]);
    const row = Array.isArray(rows) ? rows[0] : null;
    return Number(row?.count ?? 0) || 0;
  }

  async function latestModelChange(conversationId) {
    const { rows } = await query(SQL.lastModelChange, [text(conversationId, 1_000, 'conversationId')]);
    return mapEvent(Array.isArray(rows) ? rows[0] : null);
  }

  /**
   * Load one conversation for restore/rendering. Does not touch Pi runtime state.
   */
  async function loadConversation(input = {}) {
    if (!isObject(input)) throw new SessionStoreError('invalid-input');
    const conversationId = text(input.conversationId, 1_000, 'conversationId');
    const events = await listEvents({ conversationId, limit: input.limit, leafEventId: input.leafEventId, types: input.types });
    const rebuilt = rebuildConversation(events, { maxToolChars: input.maxToolChars, includeSummary: input.includeSummary });
    const modelChange = rebuilt.model ?? null;
    return {
      conversationId,
      events,
      messages: rebuilt.messages,
      model: modelChange,
      compaction: rebuilt.compaction,
      pendingToolCalls: rebuilt.pendingToolCalls,
      interrupted: rebuilt.interrupted,
      warnings: rebuilt.warnings,
      leafEventId: events.length ? events[events.length - 1].eventId : null,
      sequence: events.length ? events[events.length - 1].sequence : 0,
    };
  }

  /**
   * Import the current renderer snapshot turns (§3.2) into `mova_session_events`.
   * Idempotent: stable per-turn ids mean a repeated import inserts nothing new.
   * The caller must have upserted `mova_conversations` rows first (FK).
   */
  async function importSnapshot(snapshot, importOptions = {}) {
    const plan = snapshotToEvents(snapshot, importOptions);
    const summary = { conversations: plan.length, inserted: 0, skipped: 0, duplicated: 0, temporary: [], perConversation: [] };
    for (const conversation of plan) {
      if (conversation.temporary) {
        summary.temporary.push(conversation.conversationId);
        summary.perConversation.push({ conversationId: conversation.conversationId, temporary: true, inserted: 0, duplicated: 0 });
        continue;
      }
      let inserted = 0;
      let duplicated = 0;
      for (const event of conversation.events) {
        const stored = await appendEvent({ ...event, temporary: false });
        if (!stored) continue;
        if (stored.duplicated) duplicated += 1;
        else inserted += 1;
      }
      summary.inserted += inserted;
      summary.duplicated += duplicated;
      summary.skipped += duplicated;
      summary.perConversation.push({ conversationId: conversation.conversationId, temporary: false, inserted, duplicated });
    }
    logger.info?.('session.snapshot-imported', { conversations: summary.conversations, inserted: summary.inserted, duplicated: summary.duplicated });
    return summary;
  }

  return {
    eventTypes: EVENT_TYPES,
    appendEvent,
    appendEvents,
    listEvents,
    getEvent,
    loadConversation,
    rebuildMessages: events => rebuildConversation(events).messages,
    rebuildConversation,
    latestSequence,
    countEvents,
    latestModelChange,
    importSnapshot,
    snapshotToEvents,
  };
}

module.exports = {
  createSessionStore,
  SessionStoreError,
  SQL,
  EVENT_TYPES,
  MESSAGE_ROLES,
  rebuildConversation,
  rebuildMessages: events => rebuildConversation(events).messages,
  snapshotToEvents,
  stripPrivateReasoning,
  eventIdFor,
  mapEvent,
};
