'use strict';

/**
 * BullMQ queue layer for Mova service mode.
 *
 * Contract: Mova服务版接口约定.md §8 (queues) and §5 (health/stats).
 *
 * Rules enforced here:
 *  - Queue names are fixed: mova-memory-extract / mova-memory-index / mova-backup /
 *    mova-session-sync. No Dot queues, no Dot workers, no Dot budget logic.
 *  - Every job id is deterministic (idempotent re-enqueue) and safe for BullMQ
 *    (no ":" and no whitespace, so the id is valid as a Redis key suffix).
 *  - Retries: 3 attempts total (initial try + 2 retries) with exponential backoff.
 *    Failed jobs are kept (removeOnFail: false) so dead letters stay queryable.
 *  - This module never imports Electron, never imports `bullmq`/`ioredis` at load
 *    time, and never requires a live Redis for construction when a `connection`
 *    or `QueueClass` is injected. That keeps tests and the main process able to
 *    degrade instead of crashing.
 *  - Health/stats never throw (§5: a failed probe returns a status, it does not
 *    take down the settings page).
 *
 * Not implemented here: job schedulers (daily 03:00 backup is scheduled by the
 * parent via BullMQ Job Schedulers or the main process timer), Dot task state
 * machine, embeddings, and pg access.
 */

const { createHash } = require('node:crypto');

/** Canonical queue keys -> BullMQ queue names. */
const QUEUES = Object.freeze({
  memoryExtract: 'mova-memory-extract',
  memoryIndex: 'mova-memory-index',
  backup: 'mova-backup',
  sessionSync: 'mova-session-sync',
});

const QUEUE_KEYS = Object.freeze(Object.keys(QUEUES));
const QUEUE_NAMES = Object.freeze(Object.values(QUEUES));

/** Job names used for each queue; handlers can switch on job.name. */
const JOB_NAMES = Object.freeze({
  memoryExtract: 'extract',
  memoryIndex: 'index',
  backup: 'backup',
  sessionSync: 'sync',
});

const DEFAULT_QUEUE_PREFIX = 'mova';

/**
 * Default job options.
 * `attempts: 3` = at most three processing attempts per job (2 retries), as
 * required by the contract. `backoff` uses BullMQ's built-in exponential type.
 */
const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: Object.freeze({ type: 'exponential', delay: 2_000 }),
  removeOnComplete: Object.freeze({ age: 86_400, count: 5_000 }),
  removeOnFail: false,
});

const MAX_JOB_ID_LENGTH = 180;
const MAX_DIGEST_LENGTH = 32;
const MAX_SLUG_LENGTH = 48;

class QueueServiceError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'QueueServiceError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimString(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) throw new QueueServiceError('queue-invalid-key', label);
  return value.trim().slice(0, max);
}

function safeMessage(error) {
  if (!error) return null;
  const text = typeof error === 'string' ? error : error.message;
  return typeof text === 'string' ? text.slice(0, 300) : null;
}

function normalizeLogger(logger) {
  const base = { debug() {}, info() {}, warn() {}, error() {} };
  if (!logger || typeof logger !== 'object') return base;
  return {
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : base.debug,
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : base.info,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : base.warn,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : base.error,
  };
}

/** Never echo an injected Redis password into logs/health payloads. */
function redactRedisUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  return url.replace(/(:\/\/[^:/@\s]*):[^@/\s]*@/g, '$1:***@');
}

function slug(part) {
  return String(part)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

function digest(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, MAX_DIGEST_LENGTH);
}

/**
 * Deterministic, BullMQ-safe job id.
 *
 * Format: `<kind>_<sha256-prefix>_<readable-slug>` (readable part may be empty
 * for non-ASCII ids). Same parts always produce the same id; different parts
 * produce a different digest, so the readable slug is never load-bearing.
 */
function jobId(kind, parts) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(kind)) throw new QueueServiceError('queue-invalid-key', 'kind');
  if (!Array.isArray(parts) || !parts.length) throw new QueueServiceError('queue-invalid-key', 'parts');
  const values = parts.map((part, index) => {
    if (typeof part === 'number') {
      if (!Number.isFinite(part)) throw new QueueServiceError('queue-invalid-key', `parts[${index}]`);
      return String(part);
    }
    if (typeof part !== 'string' || !part.trim()) throw new QueueServiceError('queue-invalid-key', `parts[${index}]`);
    return part.trim();
  });
  const readable = values.map(slug).filter(Boolean).join('_').slice(0, MAX_SLUG_LENGTH * 2);
  const id = `${kind}_${digest([kind, ...values])}${readable ? `_${readable}` : ''}`;
  return id.slice(0, MAX_JOB_ID_LENGTH);
}

/** UTC `YYYY-MM-DD`; the backup queue's idempotency key uses a date. */
function utcDate(now) {
  const value = now instanceof Date ? now : new Date(now ?? Date.now());
  return value.toISOString().slice(0, 10);
}

function jobOptions(overrides) {
  const merged = {
    ...DEFAULT_JOB_OPTIONS,
    backoff: { ...DEFAULT_JOB_OPTIONS.backoff },
    removeOnComplete: { ...DEFAULT_JOB_OPTIONS.removeOnComplete },
  };
  if (!isObject(overrides)) return merged;
  const { jobId: _ignored, ...rest } = overrides;
  Object.assign(merged, rest);
  if (isObject(rest.backoff)) merged.backoff = { ...rest.backoff };
  if (isObject(rest.removeOnComplete)) merged.removeOnComplete = { ...rest.removeOnComplete };
  return merged;
}

/**
 * Build an ioredis connection lazily. Only called when a real queue/worker is
 * created, so importing this module (or tests) never touches Redis.
 */
function createRedisConnection(redisUrl, overrides = {}) {
  if (typeof redisUrl !== 'string' || !redisUrl.trim()) throw new QueueServiceError('redis-missing');
  let mod;
  try {
    mod = require('ioredis');
  } catch (error) {
    throw new QueueServiceError('redis-unavailable', safeMessage(error));
  }
  const Redis = mod?.default ?? mod?.Redis ?? mod;
  if (typeof Redis !== 'function') throw new QueueServiceError('redis-unavailable', 'ioredis export shape');
  try {
    return new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false, ...overrides });
  } catch (error) {
    throw new QueueServiceError('redis-unavailable', safeMessage(error));
  }
}

function resolveQueue(queueKey) {
  if (QUEUE_KEYS.includes(queueKey)) return { key: queueKey, name: QUEUES[queueKey] };
  const entry = Object.entries(QUEUES).find(([, name]) => name === queueKey);
  if (entry) return { key: entry[0], name: entry[1] };
  throw new QueueServiceError('queue-unknown', String(queueKey));
}

/**
 * Create the queue service.
 *
 * @param {object} [options]
 * @param {string|null} [options.redisUrl] default: `MOVA_REDIS_URL`; falsy => disabled mode
 * @param {Function} [options.QueueClass] injected BullMQ Queue (tests); default lazily `require('bullmq').Queue`
 * @param {object} [options.connection] injected connection; skipped construction path
 * @param {Function} [options.connectionFactory] default ioredis factory (`() => connection`)
 * @param {object} [options.redisOptions] extra ioredis options
 * @param {string} [options.prefix='mova'] BullMQ key prefix
 * @param {object} [options.logger] `{debug,info,warn,error}`; injected, never console by default
 * @param {Function} [options.now] `() => Date` (used for backup date keys)
 * @returns {object} queue service
 */
function createQueueService(options = {}) {
  if (!isObject(options)) throw new QueueServiceError('invalid-options');
  const env = options.env || process.env;
  const logger = normalizeLogger(options.logger);
  const prefix = options.prefix || DEFAULT_QUEUE_PREFIX;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const redisUrl = options.redisUrl === undefined ? env.MOVA_REDIS_URL || null : options.redisUrl;
  const injectedConnection = options.connection || null;
  const injectedQueue = options.QueueClass || options.Queue || null;
  const ownsConnection = !injectedConnection;

  const state = { enabled: false, queues: new Map(), connection: null, disabledReason: null, closed: null };

  function buildConnection() {
    if (injectedConnection) return injectedConnection;
    if (typeof options.connectionFactory === 'function') return options.connectionFactory();
    return createRedisConnection(redisUrl, options.redisOptions);
  }

  if (!redisUrl && !injectedConnection) {
    state.disabledReason = 'queue-disabled';
    logger.warn?.('queue.disabled', { reason: 'missing-redis-url' });
  } else {
    try {
const Queue = injectedQueue || require('bullmq').Queue;
      state.connection = buildConnection();
      for (const key of QUEUE_KEYS) {
        state.queues.set(key, new Queue(QUEUES[key], { connection: state.connection, prefix }));
      }
      state.enabled = true;
    } catch (error) {
      state.disabledReason = 'queue-unavailable';
      logger.error?.('queue.unavailable', { code: error?.code ?? null, message: safeMessage(error) });
      for (const queue of state.queues.values()) {
        Promise.resolve().then(() => queue.close?.()).catch(() => {});
      }
      state.queues.clear();
      state.enabled = false;
    }
  }

  function queueFor(queueKey) {
    if (!state.enabled) throw new QueueServiceError(state.disabledReason || 'queue-disabled');
    const { key, name } = resolveQueue(queueKey);
    const queue = state.queues.get(key);
    if (!queue) throw new QueueServiceError('queue-unavailable', name);
    return { key, name, queue };
  }

  async function enqueue(queueKey, data, overrides = {}) {
    if (!isObject(data)) throw new QueueServiceError('queue-invalid-data');
    const { key, name, queue } = queueFor(queueKey);
    // No implicit random/time-based ids: every job must be idempotent.
    if (typeof overrides.jobId !== 'string' || !overrides.jobId.trim()) throw new QueueServiceError('queue-invalid-key', 'jobId');
    const jobIdValue = overrides.jobId;
    let job;
    try {
      job = await queue.add(JOB_NAMES[key], data, { ...jobOptions(overrides), jobId: jobIdValue });
    } catch (error) {
      logger.error?.('queue.enqueue-failed', { queue: name, jobId: jobIdValue, code: error?.code ?? null, message: safeMessage(error) });
      throw new QueueServiceError('queue-unavailable', safeMessage(error));
    }
    const id = job?.id === undefined || job?.id === null ? jobIdValue : String(job.id);
    logger.debug?.('queue.enqueued', { queue: name, jobId: id });
    return id;
  }

  /** conversationId + messageId -> deterministic extract job. */
  function enqueueMemoryExtract(payload, overrides = {}) {
    if (!isObject(payload)) throw new QueueServiceError('queue-invalid-data');
    const conversationId = trimString(payload.conversationId, 1_000, 'conversationId');
    const messageId = trimString(payload.messageId, 500, 'messageId');
    return enqueue('memoryExtract', { ...payload, conversationId, messageId }, { ...overrides, jobId: jobId('extract', [conversationId, messageId]) });
  }

  /** chunkId + embeddingVersion -> deterministic index job. */
  function enqueueMemoryIndex(payload, overrides = {}) {
    if (!isObject(payload)) throw new QueueServiceError('queue-invalid-data');
    const chunkId = trimString(payload.chunkId, 500, 'chunkId');
    if (typeof payload.embeddingVersion !== 'string' && typeof payload.embeddingVersion !== 'number') {
      throw new QueueServiceError('queue-invalid-key', 'embeddingVersion');
    }
    const embeddingVersion = String(payload.embeddingVersion).trim();
    if (!embeddingVersion) throw new QueueServiceError('queue-invalid-key', 'embeddingVersion');
    return enqueue('memoryIndex', { ...payload, chunkId, embeddingVersion }, { ...overrides, jobId: jobId('index', [chunkId, embeddingVersion]) });
  }

  /** date + kind -> deterministic backup job (daily 03:00 is one job per day). */
  function enqueueBackup(payload = {}, overrides = {}) {
    if (!isObject(payload)) throw new QueueServiceError('queue-invalid-data');
    const kind = payload.kind === undefined ? 'manual' : payload.kind;
    if (!['manual', 'scheduled'].includes(kind)) throw new QueueServiceError('queue-invalid-key', 'kind');
    const date = payload.date === undefined ? utcDate(now()) : String(payload.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new QueueServiceError('queue-invalid-key', 'date');
    return enqueue('backup', { ...payload, kind, date }, { ...overrides, jobId: jobId('backup', [date, kind]) });
  }

  /** eventId -> deterministic session-sync job. */
  function enqueueSessionSync(payload, overrides = {}) {
    if (!isObject(payload)) throw new QueueServiceError('queue-invalid-data');
    const eventId = trimString(payload.eventId, 300, 'eventId');
    return enqueue('sessionSync', { ...payload, eventId }, { ...overrides, jobId: jobId('sync', [eventId]) });
  }

  async function stats() {
    const perQueue = {};
    let waiting = 0;
    let active = 0;
    let completed = 0;
    let failed = 0;
    let delayed = 0;
    let paused = 0;
    let down = 0;
    for (const key of QUEUE_KEYS) {
      const name = QUEUES[key];
      const queue = state.queues.get(key);
      if (!state.enabled || !queue) {
        perQueue[name] = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0, error: state.enabled ? 'queue-unavailable' : 'queue-disabled' };
        continue;
      }
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
        const value = {
          waiting: number(counts?.waiting),
          active: number(counts?.active),
          completed: number(counts?.completed),
          failed: number(counts?.failed),
          delayed: number(counts?.delayed),
          paused: number(counts?.paused),
        };
        perQueue[name] = value;
        waiting += value.waiting;
        active += value.active;
        completed += value.completed;
        failed += value.failed;
        delayed += value.delayed;
        paused += value.paused;
      } catch (error) {
        down += 1;
        perQueue[name] = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0, error: 'redis-unavailable' };
        logger.warn?.('queue.stats-failed', { queue: name, code: error?.code ?? null, message: safeMessage(error) });
      }
    }
    return {
      enabled: state.enabled,
      redis: !state.enabled ? 'disabled' : down === 0 ? 'ok' : 'down',
      queueWaiting: waiting + delayed,
      queueFailed: failed,
      queueLag: waiting + delayed + active,
      counts: { waiting, active, completed, failed, delayed, paused },
      queues: perQueue,
    };
  }

  /** HealthStatus fragment for §5; never throws. */
  async function health() {
    try {
      const value = await stats();
      const message = !value.enabled
        ? '未配置 MOVA_REDIS_URL，队列与后台任务关闭'
        : value.redis === 'ok'
          ? undefined
          : 'Redis 不可用，队列已降级（不阻塞聊天主流程）';
      return {
        redis: value.redis,
        queueLag: value.queueLag,
        queueWaiting: value.queueWaiting,
        queueFailed: value.queueFailed,
        enabled: value.enabled,
        prefix,
        redisUrl: redactRedisUrl(redisUrl),
        ...(message ? { message } : {}),
        ...(state.disabledReason ? { disabledReason: state.disabledReason } : {}),
      };
    } catch (error) {
      logger.error?.('queue.health-failed', { message: safeMessage(error) });
      return { redis: state.enabled ? 'down' : 'disabled', queueLag: 0, queueWaiting: 0, queueFailed: 0, enabled: state.enabled, redisUrl: redactRedisUrl(redisUrl), message: 'health-check-failed' };
    }
  }

  /** Failed (dead-letter) jobs for one queue. Job data is omitted by default. */
  async function deadLetters(queueKey, options2 = {}) {
    const { queue, name } = queueFor(queueKey);
    const limit = Number.isInteger(options2.limit) && options2.limit >= 1 && options2.limit <= 100 ? options2.limit : 20;
    const includeData = options2.includeData === true;
    let jobs;
    try {
      jobs = await queue.getJobs(['failed'], 0, limit - 1, false);
    } catch (error) {
      logger.warn?.('queue.dead-letters-failed', { queue: name, message: safeMessage(error) });
      throw new QueueServiceError('queue-unavailable', safeMessage(error));
    }
    return (Array.isArray(jobs) ? jobs : []).slice(0, limit).map(job => ({
      id: job?.id === undefined ? null : String(job.id),
      name: job?.name ?? null,
      failedReason: job?.failedReason ?? null,
      attemptsMade: Number(job?.attemptsMade ?? 0),
      timestamp: job?.timestamp ?? null,
      ...(includeData ? { data: job?.data ?? null } : {}),
    }));
  }

  async function pause() {
    const results = [];
    for (const key of QUEUE_KEYS) {
      const queue = state.queues.get(key);
      if (!queue?.pause) continue;
      try {
        await queue.pause();
        results.push(QUEUES[key]);
      } catch (error) {
        logger.warn?.('queue.pause-failed', { queue: QUEUES[key], message: safeMessage(error) });
      }
    }
    return results;
  }

  async function resume() {
    const results = [];
    for (const key of QUEUE_KEYS) {
      const queue = state.queues.get(key);
      if (!queue?.resume) continue;
      try {
        await queue.resume();
        results.push(QUEUES[key]);
      } catch (error) {
        logger.warn?.('queue.resume-failed', { queue: QUEUES[key], message: safeMessage(error) });
      }
    }
    return results;
  }

  function close() {
    if (state.closed) return state.closed;
    state.closed = (async () => {
      for (const [key, queue] of state.queues) {
        try {
          await queue.close?.();
        } catch (error) {
          logger.warn?.('queue.close-failed', { queue: QUEUES[key], message: safeMessage(error) });
        }
      }
      state.queues.clear();
      state.enabled = false;
      if (ownsConnection && state.connection && typeof state.connection.quit === 'function') {
        try {
          await state.connection.quit();
        } catch (error) {
          logger.warn?.('queue.connection-close-failed', { message: safeMessage(error) });
        }
      }
      state.connection = null;
    })();
    return state.closed;
  }

  return {
    names: QUEUES,
    jobNames: JOB_NAMES,
    prefix,
    get enabled() {
      return state.enabled;
    },
    get disabledReason() {
      return state.disabledReason;
    },
    queue: queueKey => queueFor(queueKey).queue,
    enqueue,
    enqueueMemoryExtract,
    enqueueMemoryIndex,
    enqueueBackup,
    enqueueSessionSync,
    stats,
    health,
    deadLetters,
    pause,
    resume,
    close,
  };
}

/**
 * Start BullMQ Workers inside the child process (electron/services/worker-entry.mjs).
 * Each worker gets its own connection: blocking commands must not share a
 * connection with other workers or with the main-process queues.
 *
 * @param {object} options
 * @param {string|null} [options.redisUrl] default `MOVA_REDIS_URL`
 * @param {Record<string, Function>} options.handlers keyed by queue key or queue name
 * @param {Function} [options.WorkerClass] injected BullMQ Worker (tests)
 * @param {object} [options.connection] injected connection used for all workers
 * @param {Function} [options.connectionFactory]
 * @param {object} [options.concurrency] number or per-key map, default 1
 * @param {object} [options.logger]
 */
function createWorkerService(options = {}) {
  if (!isObject(options)) throw new QueueServiceError('invalid-options');
  const env = options.env || process.env;
  const logger = normalizeLogger(options.logger);
  const handlers = options.handlers;
  if (!isObject(handlers)) throw new QueueServiceError('queue-invalid-handlers');
  const redisUrl = options.redisUrl === undefined ? env.MOVA_REDIS_URL || null : options.redisUrl;
  const injectedConnection = options.connection || null;
  const prefix = options.prefix || DEFAULT_QUEUE_PREFIX;
  if (!redisUrl && !injectedConnection) throw new QueueServiceError('redis-missing');

  let Worker;
  try {
Worker = options.WorkerClass || options.Worker || require('bullmq').Worker;
  } catch (error) {
    throw new QueueServiceError('queue-unavailable', safeMessage(error));
  }
  if (typeof Worker !== 'function') throw new QueueServiceError('queue-unavailable', 'Worker');

  const factory = typeof options.connectionFactory === 'function'
    ? options.connectionFactory
    : () => createRedisConnection(redisUrl, options.redisOptions);
  const makeConnection = () => injectedConnection || factory();
  const ownsConnections = !injectedConnection;
  const workers = new Map();
  const connections = [];
  const missing = [];

  function concurrencyFor(key) {
    const value = options.concurrency;
    if (Number.isInteger(value) && value >= 1) return Math.min(value, 50);
    if (isObject(value) && Number.isInteger(value[key]) && value[key] >= 1) return Math.min(value[key], 50);
    return 1;
  }

  for (const key of QUEUE_KEYS) {
    const handler = handlers[key] ?? handlers[QUEUES[key]];
    if (typeof handler !== 'function') {
      missing.push(QUEUES[key]);
      continue;
    }
    const connection = makeConnection();
    connections.push(connection);
    const worker = new Worker(QUEUES[key], async job => handler(job, { logger, queue: QUEUES[key] }), {
      connection,
      prefix,
      concurrency: concurrencyFor(key),
    });
    worker.on?.('failed', (job, error) => {
      logger.error?.('queue.job-failed', {
        queue: QUEUES[key],
        jobId: job?.id === undefined ? null : String(job.id),
        attemptsMade: Number(job?.attemptsMade ?? 0),
        code: error?.code ?? null,
        message: safeMessage(error),
      });
    });
    worker.on?.('error', error => {
      logger.error?.('queue.worker-error', { queue: QUEUES[key], code: error?.code ?? null, message: safeMessage(error) });
    });
    worker.on?.('completed', job => {
      logger.debug?.('queue.job-completed', { queue: QUEUES[key], jobId: job?.id === undefined ? null : String(job.id) });
    });
    workers.set(key, worker);
  }

  if (!workers.size) throw new QueueServiceError('queue-invalid-handlers', `no handlers for ${QUEUE_NAMES.join(', ')}`);
  if (missing.length) logger.warn?.('queue.workers-missing-handlers', { queues: missing });

  const state = { closed: null };
  function close() {
    if (state.closed) return state.closed;
    state.closed = (async () => {
      for (const [key, worker] of workers) {
        try {
          await worker.close?.();
        } catch (error) {
          logger.warn?.('queue.worker-close-failed', { queue: QUEUES[key], message: safeMessage(error) });
        }
      }
      workers.clear();
      if (ownsConnections) {
        for (const connection of connections) {
          try {
            await connection?.quit?.();
          } catch (error) {
            logger.warn?.('queue.connection-close-failed', { message: safeMessage(error) });
          }
        }
      }
      connections.length = 0;
    })();
    return state.closed;
  }

  return {
    names: QUEUES,
    prefix,
    workers,
    queues: [...workers.keys()].map(key => QUEUES[key]),
    missingHandlers: missing,
    close,
  };
}

/**
 * Adapter for callers that speak the raw BullMQ `queue.add(name, data, opts)`
 * shape (for example electron/db/postgres-repository.cjs): a single object that
 * routes each fixed queue name to the matching deterministic enqueue helper.
 *
 * Notes for the caller:
 *  - the 4th "jobId" argument such callers pass is ignored: ids are derived from
 *    the contract keys, and BullMQ forbids ":" in custom ids;
 *  - `removeOnFail` is forced to false so dead letters stay queryable (§8);
 *  - `getWaitingCount`/`getFailedCount` aggregate all four queues.
 */
function createQueueRouter(service) {
  if (!service || typeof service.enqueueMemoryExtract !== 'function') throw new QueueServiceError('invalid-options', 'queue service');
  const overridesFrom = (options2 = {}) => {
    if (!isObject(options2)) return {};
    const { attempts, backoff, delay, priority, removeOnComplete } = options2;
    return {
      ...(Number.isInteger(attempts) && attempts >= 1 ? { attempts } : {}),
      ...(isObject(backoff) ? { backoff } : {}),
      ...(Number.isInteger(delay) && delay >= 0 ? { delay } : {}),
      ...(Number.isInteger(priority) ? { priority } : {}),
      ...(isObject(removeOnComplete) ? { removeOnComplete } : {}),
      removeOnFail: false,
    };
  };
  return {
    async add(name, data = {}, options2 = {}) {
      const overrides = overridesFrom(options2);
      if (name === QUEUES.memoryExtract) return service.enqueueMemoryExtract(data, overrides);
      if (name === QUEUES.sessionSync) return service.enqueueSessionSync(data, overrides);
      if (name === QUEUES.backup) return service.enqueueBackup(data, overrides);
      if (name === QUEUES.memoryIndex) {
        // Full reindex jobs have no chunk id; key them by owner + embedding version.
        if (data?.kind === 'reindex') {
          const owner = data.ownerId ?? 'owner';
          const version = data.embeddingVersion ?? 1;
          const model = data.embeddingModel ?? 'default';
          return service.enqueue('memoryIndex', { ...data }, {
            ...overrides,
            jobId: jobId('reindex', [owner, version, model]),
          });
        }
        return service.enqueueMemoryIndex(data, overrides);
      }
      throw new QueueServiceError('queue-unknown', String(name));
    },
    async getWaitingCount() {
      return (await service.stats()).queueWaiting;
    },
    async getFailedCount() {
      return (await service.stats()).queueFailed;
    },
    // Repository health probes read `status`; expose it alongside the Redis state.
    async health() {
      const value = await service.health();
      return { ...value, status: value.redis === 'ok' ? 'ok' : value.redis === 'disabled' ? 'disabled' : 'down' };
    },
  };
}

module.exports = {
  QUEUES,
  QUEUE_KEYS,
  QUEUE_NAMES,
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_QUEUE_PREFIX,
  QueueServiceError,
  createQueueService,
  createWorkerService,
  createQueueRouter,
  createRedisConnection,
  jobId,
  jobOptions,
  redactRedisUrl,
  utcDate,
};
