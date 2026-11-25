'use strict';
// Persistent job layer for long-term memory extraction (service mode).
//
// One row of mova_memory_jobs (migration 002) per (owner, conversation, message).
// The row holds the message text only until the job reaches a terminal state;
// complete()/skip() clear it, failJob() keeps it for a retry, and a worker that
// claims a row owns it until it calls complete/skip/fail.
//
// Rules enforced here:
//  - No pg / Electron / BullMQ import: the caller injects `query(sql, params)`.
//  - Every statement is parameterized and belongs to one owner, always passed
//    as $1 (so an audit of params[0] proves owner scoping).
//  - Every identifier is validated (UUID / length) before it reaches SQL.
//  - Errors carry a stable code: invalid-input, not-found, job-limit,
//    storage-error. Query failures never leak SQL text or message text.
//
// Workers renew their processing lease; expired leases are recovered on a
// later poll. Attempt numbers fence out stale workers' status updates.

const { randomUUID } = require('node:crypto');

const TABLE = 'mova_memory_jobs';
const STATUSES = Object.freeze(['pending', 'processing', 'done', 'skipped', 'failed']);
const MAX_ATTEMPTS = 3;
const MAX_TEXT_CHARS = 20_000;
const MAX_CONVERSATION_ID_CHARS = 1_000;
const MAX_MESSAGE_ID_CHARS = 500;
const MAX_ERROR_CHARS = 500;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;
const DEFAULT_PURGE_DAYS = 7;
const MAX_PURGE_DAYS = 3_650;

// Lenient UUID shape check (any version/variant): mova_users ids come from the
// migration seed, from fixtures, and from renderer-supplied values.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Columns shared by every returning clause. `text` is deliberately absent: the
// only reader of job text is claim(), which is the extraction worker.
const JOB_COLUMNS = 'id, conversation_id, message_id, project_id, status, attempts, last_error, created_at, updated_at';
const RETURNING = `returning ${JOB_COLUMNS}`;

class MemoryJobsError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'MemoryJobsError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function raise(code, detail) {
  throw new MemoryJobsError(code, detail);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLogger(logger) {
  const base = { debug() {}, info() {}, warn() {}, error() {} };
  if (!logger || typeof logger !== 'object') return base;
  const pick = key => (typeof logger[key] === 'function' ? logger[key].bind(logger) : base[key]);
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') };
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value.trim())) raise('invalid-input', field);
  return value.trim();
}

/** Trimmed non-empty string with a hard length limit (ids). */
function label(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) raise('invalid-input', field);
  const trimmed = value.trim();
  if (trimmed.length > max) raise('invalid-input', field);
  return trimmed;
}

/** Trimmed non-empty message body, truncated to keep rows bounded. */
function body(value) {
  if (typeof value !== 'string' || !value.trim()) raise('invalid-input', 'text');
  return value.trim().slice(0, MAX_TEXT_CHARS);
}

/** Optional project scope: null/empty means the global ChatMova scope. */
function optionalLabel(value, max, field) {
  if (value === undefined || value === null || value === '') return null;
  return label(value, max, field);
}

/** Reason/error text: trimmed and truncated, never throws, null when empty. */
function reason(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, MAX_ERROR_CHARS);
}

function integer(value, { field, fallback, min, max }) {
  if (value === undefined || value === null) {
    if (fallback === undefined) raise('invalid-input', field);
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) raise('invalid-input', field);
  return value;
}

function statusOf(value) {
  if (!STATUSES.includes(value)) raise('invalid-input', 'status');
  return value;
}

/** Map a DB row (snake_case) to the public shape (camelCase). */
function toJob(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    conversationId: row.conversation_id ?? null,
    messageId: row.message_id ?? null,
    projectId: row.project_id ?? null,
    status: row.status ?? null,
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Create the job layer.
 *
 * @param {object} options
 * @param {Function} options.query `(sql, params) => Promise<{rows, rowCount?}>` (required)
 * @param {string} options.ownerId owner UUID (required; scopes every statement)
 * @param {Function} [options.now] `() => Date|string|number`, default `() => new Date()`
 * @param {object} [options.logger] `{debug,info,warn,error}`; never console by default
 * @param {number} [options.maxPending=0] cap on pending+processing rows (0 = no cap)
 * @param {Function} [options.id] `() => uuid`; default `randomUUID` (tests may inject)
 */
function createMemoryJobs(options = {}) {
  if (!isObject(options)) raise('invalid-input', 'options');
  if (typeof options.query !== 'function') raise('invalid-input', 'query');
  const query = options.query;
  const ownerId = uuid(options.ownerId, 'ownerId');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const newId = typeof options.id === 'function' ? options.id : randomUUID;
  const logger = normalizeLogger(options.logger);
  const maxPending = integer(options.maxPending, { field: 'maxPending', fallback: 0, min: 0, max: 1_000_000 });

  const stamp = () => {
    const value = now();
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  };

  /** Run one statement; any driver failure becomes a stable storage-error. */
  async function run(sql, params) {
    try {
      const result = await query(sql, params);
      return result && typeof result === 'object' ? result : { rows: [] };
    } catch (error) {
      logger.error?.('memory-jobs.query-failed', { code: error?.code ?? null, message: String(error?.message ?? '').slice(0, 200) });
      throw new MemoryJobsError('storage-error', error?.code ?? null);
    }
  }

  const rows = result => (Array.isArray(result.rows) ? result.rows : []);
  const affected = result => (Number.isInteger(result.rowCount) ? result.rowCount : rows(result).length);

  async function assertCapacity() {
    if (maxPending <= 0) return;
    const result = await run(
      `select count(*)::int as pending
       from ${TABLE}
       where owner_id = $1 and status in ('pending','processing')`,
      [ownerId],
    );
    const pending = Number(rows(result)[0]?.pending ?? 0);
    if (pending >= maxPending) raise('job-limit', { maxPending });
  }

  async function findExisting(conversationId, messageId) {
    const result = await run(
      `select ${JOB_COLUMNS}
       from ${TABLE}
       where owner_id = $1 and conversation_id = $2 and message_id = $3`,
      [ownerId, conversationId, messageId],
    );
    return toJob(rows(result)[0]);
  }

  /**
   * Insert the job or return the row that already exists for the same
   * (owner, conversation, message). Idempotent: a duplicate enqueue never
   * resets status, attempts, or text.
   */
  async function enqueue(input = {}) {
    if (!isObject(input)) raise('invalid-input', 'input');
    const conversationId = label(input.conversationId, MAX_CONVERSATION_ID_CHARS, 'conversationId');
    const messageId = label(input.messageId, MAX_MESSAGE_ID_CHARS, 'messageId');
    const projectId = optionalLabel(input.projectId, 500, 'projectId');
    const text = body(input.text);
    await assertCapacity();
    const inserted = await run(
      `insert into ${TABLE} (owner_id, id, conversation_id, message_id, project_id, text)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (owner_id, conversation_id, message_id) do nothing
       ${RETURNING}`,
      [ownerId, newId(), conversationId, messageId, projectId, text],
    );
    const created = toJob(rows(inserted)[0]);
    if (created) return created;
    // Conflict: the winning row is committed by the time the insert returns, so
    // a follow-up statement (fresh snapshot) can see it.
    const existing = await findExisting(conversationId, messageId);
    if (!existing) raise('storage-error', 'enqueue-not-visible');
    return existing;
  }

  /**
   * Atomically claim up to `limit` runnable jobs. Pending rows and failed rows
   * with attempts < 3 are eligible; the row moves to 'processing' and attempts
   * is incremented in the same statement. Claimed rows include their text.
   */
  async function claim(input = {}) {
    const limit = integer(input.limit, { field: 'limit', fallback: 1, min: 1, max: MAX_LIST_LIMIT });
    const jobId = input.id == null ? null : uuid(input.id, 'id');
    const result = await run(
      `with claimed as (
         select id
         from ${TABLE}
         where owner_id = $1
           and (status = 'pending' or (status = 'failed' and attempts < $2))
           and ($5::uuid is null or id = $5::uuid)
         order by created_at, id
         limit $3
         for update skip locked
       )
       update ${TABLE}
       set status = 'processing',
           attempts = ${TABLE}.attempts + 1,
           last_error = null,
           updated_at = $4
       from claimed
       where ${TABLE}.id = claimed.id
       returning ${TABLE}.id, conversation_id, message_id, project_id, text, status, attempts, created_at, updated_at`,
      [ownerId, MAX_ATTEMPTS, limit, stamp(), jobId],
    );
    return rows(result).map(row => ({ ...toJob(row), text: row.text ?? '' }));
  }

  // A generous lease avoids reclaiming slow model calls; live workers renew it.
  async function recoverStale() {
    const current = stamp();
    const cutoff = new Date(current.getTime() - 10 * 60_000);
    const result = await run(
      `update ${TABLE}
       set status = case when attempts >= $3 then 'failed' else 'pending' end,
           last_error = 'lease-expired', updated_at = $4
       where owner_id = $1 and status = 'processing' and updated_at < $2`,
      [ownerId, cutoff, MAX_ATTEMPTS, current],
    );
    return affected(result);
  }

  async function heartbeat(id, attempts) {
    const jobId = uuid(id, 'id');
    const attempt = integer(attempts, { field: 'attempts', min: 1, max: MAX_ATTEMPTS });
    const result = await run(
      `update ${TABLE} set updated_at = $4
       where owner_id = $1 and id = $2 and status = 'processing' and attempts = $3`,
      [ownerId, jobId, attempt, stamp()],
    );
    return affected(result) > 0;
  }

  /** Terminal update shared by complete/skip/fail; throws not-found on 0 rows. */
  async function transition(id, setClause, params, attempts) {
    const jobId = uuid(id, 'id');
    const attempt = attempts === undefined ? null : integer(attempts, { field: 'attempts', min: 1, max: MAX_ATTEMPTS });
    const result = await run(
      `update ${TABLE}
       set ${setClause}, updated_at = $${params.length + 3}
       where owner_id = $1 and id = $2${attempt === null ? '' : ` and status = 'processing' and attempts = $${params.length + 4}`}
       ${RETURNING}`,
      [ownerId, jobId, ...params, stamp(), ...(attempt === null ? [] : [attempt])],
    );
    const job = toJob(rows(result)[0]);
    if (!job) raise('not-found', jobId);
    return job;
  }

  /** Mark done and drop the text (message content is never kept after success). */
  function complete(id, attempts) {
    return transition(id, "status = 'done', text = '', last_error = null", [], attempts);
  }

  /** Mark skipped with a reason and drop the text. */
  function skip(id, error, attempts) {
    return transition(id, "status = 'skipped', text = '', last_error = $3", [reason(error)], attempts);
  }

  /** Mark failed and keep the text: the row stays claimable for a retry. */
  function failJob(id, error, attempts) {
    return transition(id, "status = 'failed', last_error = $3", [reason(error)], attempts);
  }

  /** Requeue a failed/skipped job while it still has attempts left. */
  async function retry(id) {
    const jobId = uuid(id, 'id');
    const result = await run(
      `update ${TABLE}
       set status = 'pending', last_error = null, updated_at = $3
       where owner_id = $1 and id = $2
         and status in ('failed','skipped') and attempts < $4
       ${RETURNING}`,
      [ownerId, jobId, stamp(), MAX_ATTEMPTS],
    );
    const job = toJob(rows(result)[0]);
    if (job) return job;
    const current = await run(
      `select status, attempts from ${TABLE} where owner_id = $1 and id = $2`,
      [ownerId, jobId],
    );
    const row = rows(current)[0];
    if (!row) raise('not-found', jobId);
    raise('invalid-input', { id: jobId, status: row.status, attempts: Number(row.attempts ?? 0) });
  }

  /** Newest-first job metadata for the owner; job text is never returned. */
  async function list(input = {}) {
    if (!isObject(input)) raise('invalid-input', 'input');
    const wanted = input.status === undefined || input.status === null ? null : statusOf(input.status);
    const limit = integer(input.limit, { field: 'limit', fallback: DEFAULT_LIST_LIMIT, min: 1, max: MAX_LIST_LIMIT });
    const result = await run(
      `select ${JOB_COLUMNS}
       from ${TABLE}
       where owner_id = $1 and ($2::text is null or status = $2::text)
       order by created_at desc, id
       limit $3`,
      [ownerId, wanted, limit],
    );
    return rows(result).map(toJob);
  }

  /** Delete terminal rows (done/skipped) last touched before the cutoff. */
  async function purgeDone(input = {}) {
    if (!isObject(input)) raise('invalid-input', 'input');
    const olderThanDays = integer(input.olderThanDays, {
      field: 'olderThanDays', fallback: DEFAULT_PURGE_DAYS, min: 0, max: MAX_PURGE_DAYS,
    });
    const before = new Date(stamp().getTime() - olderThanDays * 86_400_000);
    const result = await run(
      `delete from ${TABLE}
       where owner_id = $1 and status in ('done','skipped') and updated_at < $2`,
      [ownerId, before],
    );
    return { deleted: affected(result), before };
  }

  return {
    ownerId,
    statuses: STATUSES,
    maxAttempts: MAX_ATTEMPTS,
    enqueue,
    claim,
    recoverStale,
    heartbeat,
    complete,
    skip,
    fail: failJob,
    retry,
    list,
    purgeDone,
  };
}

module.exports = {
  createMemoryJobs,
  MemoryJobsError,
  STATUSES,
  MAX_ATTEMPTS,
  MAX_TEXT_CHARS,
  MAX_ERROR_CHARS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_PURGE_DAYS,
  TABLE,
};
