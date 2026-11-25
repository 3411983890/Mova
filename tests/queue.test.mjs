import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createQueueService,
  createWorkerService,
  createQueueRouter,
  jobId,
  QUEUES,
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
  QueueServiceError,
  redactRedisUrl,
} = require('../electron/services/queue.cjs');

class FakeQueue {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.jobs = [];
    this.counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
    this.closed = 0;
    this.failCounts = false;
    this.failClose = false;
    this.paused = false;
    FakeQueue.instances.push(this);
  }
  async add(name, data, opts) {
    const existing = this.jobs.find(job => job.id === opts.jobId);
    if (existing) {
      existing.duplicateAdds = (existing.duplicateAdds ?? 0) + 1;
      return { id: existing.id, name, data: existing.data };
    }
    this.jobs.push({ id: opts.jobId, name, data: JSON.parse(JSON.stringify(data)), opts });
    this.counts.waiting += 1;
    return { id: opts.jobId };
  }
  async getJobCounts() {
    if (this.failCounts) throw Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' });
    return { ...this.counts };
  }
  async getJobs(types, start, end) {
    if (this.failJobs) throw Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' });
    return this.jobs
      .filter(job => types.includes('failed') && job.failedReason !== undefined)
      .slice(start, end + 1);
  }
  async pause() {
    this.paused = true;
  }
  async resume() {
    this.paused = false;
  }
  async close() {
    this.closed += 1;
    if (this.failClose) throw new Error('close boom');
  }
}
FakeQueue.instances = [];

function logger() {
  const entries = [];
  const record = level => (message, fields) => entries.push({ level, message, fields });
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

function service(extra = {}) {
  FakeQueue.instances = [];
  const log = logger();
  const instance = createQueueService({
    redisUrl: 'redis://:super-secret@127.0.0.1:56379',
    QueueClass: FakeQueue,
    connection: {},
    logger: log,
    env: {},
    now: () => new Date('2026-11-10T20:00:00.000Z'),
    ...extra,
  });
  return { instance, log };
}

const code = async (fn, value) => {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${value} but nothing was thrown`);
  assert.ok(error instanceof QueueServiceError, `expected QueueServiceError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, value);
};

test('no Redis / no injected connection => disabled mode, health is safe, enqueue rejects', async t => {
  const log = logger();
  const instance = createQueueService({ redisUrl: null, env: {}, logger: log });
  t.after(() => instance.close());
  assert.equal(instance.enabled, false);
  assert.equal(instance.disabledReason, 'queue-disabled');
  await code(() => instance.enqueueMemoryExtract({ conversationId: 'c', messageId: 'm' }), 'queue-disabled');
  const stats = await instance.stats();
  assert.deepEqual(stats.counts, { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
  assert.equal(stats.redis, 'disabled');
  assert.equal(stats.queueWaiting, 0);
  const health = await instance.health();
  assert.equal(health.redis, 'disabled');
  assert.match(health.message, /MOVA_REDIS_URL/);
  assert.equal(log.entries.some(entry => entry.level === 'warn' && entry.message === 'queue.disabled'), true);
  await instance.close();
  await instance.close();
});

test('module never loads bullmq/ioredis when a fake Queue is injected', () => {
  const { instance } = service();
  const loaded = Object.keys(require.cache).filter(key => /node_modules[\\/](bullmq|ioredis)[\\/]/.test(key));
  assert.deepEqual(loaded, []);
  return instance.close();
});

test('fixed queue names and job names; every queue is auto-created once', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  assert.deepEqual(instance.names, QUEUES);
  assert.deepEqual(Object.values(QUEUES), ['mova-memory-extract', 'mova-memory-index', 'mova-backup', 'mova-session-sync']);
  assert.deepEqual(FakeQueue.instances.map(queue => queue.name).sort(), Object.values(QUEUES).sort());
  assert.equal(new Set(FakeQueue.instances.map(queue => queue.name)).size, 4);
  assert.equal(JOB_NAMES.memoryExtract, 'extract');
  assert.equal(JOB_NAMES.memoryIndex, 'index');
  assert.equal(JOB_NAMES.backup, 'backup');
  assert.equal(JOB_NAMES.sessionSync, 'sync');
});

test('deterministic BullMQ-safe job ids per queue contract', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  const extract = await instance.enqueueMemoryExtract({ conversationId: 'conv/1', messageId: 'msg:1', text: 'hello' });
  assert.equal(extract, jobId('extract', ['conv/1', 'msg:1']));
  assert.match(extract, /^[A-Za-z0-9_-]+$/, 'BullMQ rejects ":" and whitespace in custom job ids');
  assert.ok(extract.length <= 180);

  const index = await instance.enqueueMemoryIndex({ chunkId: 'chunk-1', embeddingVersion: 3 });
  assert.equal(index, jobId('index', ['chunk-1', 3]));
  assert.match(index, /^[A-Za-z0-9_-]+$/);

  const backup = await instance.enqueueBackup({ date: '2026-11-10', kind: 'scheduled' });
  assert.equal(backup, jobId('backup', ['2026-11-10', 'scheduled']));

  const sync = await instance.enqueueSessionSync({ eventId: 'evt_abc', conversationId: 'c' });
  assert.equal(sync, jobId('sync', ['evt_abc']));

  // Same logical keys -> same ids, and BullMQ dedupes instead of adding again.
  assert.equal(await instance.enqueueMemoryExtract({ conversationId: 'conv/1', messageId: 'msg:1' }), extract);
  assert.equal(await instance.enqueueSessionSync({ eventId: 'evt_abc' }), sync);
  const memoryQueue = FakeQueue.instances.find(queue => queue.name === 'mova-memory-extract');
  assert.equal(memoryQueue.jobs.length, 1);
  assert.equal(memoryQueue.jobs[0].duplicateAdds, 1);
  assert.equal(FakeQueue.instances.find(queue => queue.name === 'mova-session-sync').jobs.length, 1);

  // Different keys must not collide, including ambiguous separators.
  const a = await instance.enqueueMemoryExtract({ conversationId: 'a_b', messageId: 'c' });
  const b = await instance.enqueueMemoryExtract({ conversationId: 'a', messageId: 'b_c' });
  assert.notEqual(a, b);
  assert.equal(await instance.enqueueMemoryIndex({ chunkId: 'k', embeddingVersion: 1 }), jobId('index', ['k', 1]));
  assert.notEqual(await instance.enqueueMemoryIndex({ chunkId: 'k', embeddingVersion: 2 }), index);
});

test('default backup id uses UTC date and manual kind; payloads pass through', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  const id = await instance.enqueueBackup({ note: 'manual trigger' });
  assert.equal(id, jobId('backup', ['2026-11-10', 'manual']));
  const queue = FakeQueue.instances.find(entry => entry.name === 'mova-backup');
  assert.equal(queue.jobs[0].name, 'backup');
  assert.deepEqual(queue.jobs[0].data, { note: 'manual trigger', kind: 'manual', date: '2026-11-10' });
});

test('retry policy: 3 attempts, exponential backoff, failed jobs retained for dead letters', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  await instance.enqueueMemoryExtract({ conversationId: 'c', messageId: 'm' });
  const job = FakeQueue.instances.find(queue => queue.name === 'mova-memory-extract').jobs[0];
  assert.equal(DEFAULT_JOB_OPTIONS.attempts, 3);
  assert.equal(job.opts.attempts, 3);
  assert.deepEqual(job.opts.backoff, { type: 'exponential', delay: 2000 });
  assert.equal(job.opts.removeOnFail, false, 'dead letters must stay queryable');
  assert.deepEqual(job.opts.removeOnComplete, { age: 86_400, count: 5_000 });

  await instance.enqueueMemoryExtract({ conversationId: 'c', messageId: 'm2' }, { attempts: 5, backoff: { type: 'fixed', delay: 10 } });
  const retried = FakeQueue.instances.find(queue => queue.name === 'mova-memory-extract').jobs[1];
  assert.equal(retried.opts.attempts, 5);
  assert.deepEqual(retried.opts.backoff, { type: 'fixed', delay: 10 });
  assert.equal(retried.opts.removeOnFail, false);
});

test('invalid keys/targets are rejected before touching BullMQ', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  await code(() => instance.enqueueMemoryExtract({ conversationId: 'c', messageId: '   ' }), 'queue-invalid-key');
  await code(() => instance.enqueueMemoryExtract({ messageId: 'm' }), 'queue-invalid-key');
  await code(() => instance.enqueueMemoryIndex({ chunkId: 'x' }), 'queue-invalid-key');
  await code(() => instance.enqueueBackup({ kind: 'daily' }), 'queue-invalid-key');
  await code(() => instance.enqueueBackup({ date: '2026/11/10' }), 'queue-invalid-key');
  await code(() => instance.enqueueSessionSync({}), 'queue-invalid-key');
  await code(() => instance.enqueue('nope', {}), 'queue-unknown');
  await code(() => instance.enqueueMemoryExtract(null), 'queue-invalid-data');
  await code(() => instance.deadLetters('nope'), 'queue-unknown');
  assert.equal(FakeQueue.instances.every(queue => queue.jobs.length === 0), true);
});

test('stats aggregate all queues; a failing queue degrades health without throwing', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  const [extractQueue, indexQueue, backupQueue, syncQueue] = [
    FakeQueue.instances.find(queue => queue.name === 'mova-memory-extract'),
    FakeQueue.instances.find(queue => queue.name === 'mova-memory-index'),
    FakeQueue.instances.find(queue => queue.name === 'mova-backup'),
    FakeQueue.instances.find(queue => queue.name === 'mova-session-sync'),
  ];
  extractQueue.counts = { waiting: 3, active: 1, completed: 10, failed: 2, delayed: 4, paused: 0 };
  indexQueue.counts = { waiting: 1, active: 0, completed: 2, failed: 0, delayed: 0, paused: 0 };
  backupQueue.counts = { waiting: 0, active: 0, completed: 1, failed: 1, delayed: 0, paused: 0 };
  syncQueue.counts = { waiting: 2, active: 2, completed: 5, failed: 0, delayed: 1, paused: 0 };
  const stats = await instance.stats();
  assert.equal(stats.redis, 'ok');
  assert.equal(stats.counts.waiting, 6);
  assert.equal(stats.counts.delayed, 5);
  assert.equal(stats.queueWaiting, 11);
  assert.equal(stats.queueFailed, 3);
  assert.equal(stats.queueLag, 6 + 5 + 3);
  assert.equal(stats.queues['mova-memory-extract'].waiting, 3);

  indexQueue.failCounts = true;
  const degraded = await instance.stats();
  assert.equal(degraded.redis, 'down');
  assert.deepEqual(degraded.queues['mova-memory-index'], { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0, error: 'redis-unavailable' });
  assert.equal(degraded.queues['mova-memory-extract'].waiting, 3);
  const health = await instance.health();
  assert.equal(health.redis, 'down');
  assert.match(health.message, /Redis/);
  assert.equal(health.redisUrl, 'redis://:***@127.0.0.1:56379');
  assert.equal(redactRedisUrl('redis://user:pw@host:1/0'), 'redis://user:***@host:1/0');
  assert.equal(redactRedisUrl(null), null);
});

test('dead letters are listed without leaking job payloads by default', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  const queue = FakeQueue.instances.find(entry => entry.name === 'mova-memory-extract');
  queue.jobs.push({ id: 'extract_1', name: 'extract', data: { text: 'private chat text' }, failedReason: 'boom', attemptsMade: 3, timestamp: 1, opts: {} });
  const dead = await instance.deadLetters('memoryExtract', { limit: 5 });
  assert.equal(dead.length, 1);
  assert.equal(dead[0].id, 'extract_1');
  assert.equal(dead[0].failedReason, 'boom');
  assert.equal(dead[0].attemptsMade, 3);
  assert.equal('data' in dead[0], false);
  queue.failJobs = true;
  await assert.rejects(instance.deadLetters('memoryExtract'), error => error.code === 'queue-unavailable');
  queue.failJobs = false;
  const withData = await instance.deadLetters('mova-memory-extract', { includeData: true });
  assert.deepEqual(withData[0].data, { text: 'private chat text' });
});

test('pause/resume/close are idempotent and swallow per-queue close failures', async () => {
  const { instance, log } = service();
  assert.deepEqual(await instance.pause(), Object.values(QUEUES));
  assert.equal(FakeQueue.instances.every(queue => queue.paused === true), true);
  assert.deepEqual(await instance.resume(), Object.values(QUEUES));
  assert.equal(FakeQueue.instances.every(queue => queue.paused === false), true);
  const failing = FakeQueue.instances.find(queue => queue.name === 'mova-backup');
  failing.failClose = true;
  await instance.close();
  assert.equal(FakeQueue.instances.every(queue => queue.closed === 1), true);
  assert.equal(log.entries.some(entry => entry.message === 'queue.close-failed'), true);
  await instance.close();
  assert.equal(instance.enabled, false);
});

test('queue.add failure is mapped to queue-unavailable and logged', async t => {
  const log = logger();
  const instance = createQueueService({ redisUrl: 'redis://127.0.0.1:1', QueueClass: class extends FakeQueue {
    async add() { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); }
  }, connection: {}, env: {}, logger: log });
  t.after(() => instance.close());
  await code(() => instance.enqueueBackup({}), 'queue-unavailable');
  assert.equal(log.entries.some(entry => entry.message === 'queue.enqueue-failed' && entry.fields.queue === 'mova-backup'), true);
});

class FakeWorker {
  constructor(name, processor, options) {
    this.name = name;
    this.processor = processor;
    this.options = options;
    this.listeners = new Map();
    this.closed = 0;
    FakeWorker.instances.push(this);
  }
  on(event, listener) {
    this.listeners.set(event, listener);
    return this;
  }
  async close() {
    this.closed += 1;
  }
}
FakeWorker.instances = [];

test('queue router adapts a raw BullMQ-style add(name, data, opts) caller', async t => {
  const { instance } = service();
  t.after(() => instance.close());
  const router = createQueueRouter(instance);
  const extractId = await router.add('mova-memory-extract', { conversationId: 'c', messageId: 'm' }, { jobId: 'c:m' });
  assert.equal(extractId, jobId('extract', ['c', 'm']), 'caller colon ids are replaced by contract ids');
  const syncId = await router.add('mova-session-sync', { eventId: 'e1', conversationId: 'c' });
  assert.equal(syncId, jobId('sync', ['e1']));
  const indexId = await router.add('mova-memory-index', { chunkId: 'k', embeddingVersion: 1 });
  assert.equal(indexId, jobId('index', ['k', 1]));
  const reindexA = await router.add('mova-memory-index', { kind: 'reindex', ownerId: 'o', embeddingVersion: 2, embeddingModel: 'e5' });
  const reindexB = await router.add('mova-memory-index', { kind: 'reindex', ownerId: 'o', embeddingVersion: 2, embeddingModel: 'e5' });
  assert.equal(reindexA, reindexB);
  assert.match(reindexA, /^reindex_/);
  const backupId = await router.add('mova-backup', { kind: 'scheduled', date: '2026-11-10' });
  assert.equal(backupId, jobId('backup', ['2026-11-10', 'scheduled']));
  await code(() => router.add('dot-queue', {}), 'queue-unknown');
  const memoryQueue = FakeQueue.instances.find(queue => queue.name === 'mova-memory-extract');
  assert.equal(memoryQueue.jobs[0].opts.removeOnFail, false, 'dead-letter retention cannot be disabled by a caller');
  assert.equal(await router.getWaitingCount(), 5, 'waiting counts aggregate every queue');
  assert.equal(await router.getFailedCount(), 0);
  assert.equal((await router.health()).status, 'ok');
  assert.throws(() => createQueueRouter(null), error => error.code === 'invalid-options');
});

test('worker service starts Workers only for injected handlers and closes them', async t => {
  FakeWorker.instances = [];
  const log = logger();
  const handler = async () => 'ok';
  const workers = createWorkerService({
    redisUrl: 'redis://127.0.0.1:56379',
    handlers: { memoryExtract: handler, [QUEUES.sessionSync]: handler },
    WorkerClass: FakeWorker,
    connection: {},
    logger: log,
    concurrency: { memoryExtract: 2 },
    env: {},
  });
  t.after(() => workers.close());
  assert.deepEqual(workers.queues.sort(), ['mova-memory-extract', 'mova-session-sync']);
  assert.deepEqual(workers.missingHandlers.sort(), ['mova-backup', 'mova-memory-index']);
  assert.equal(FakeWorker.instances.length, 2);
  const extract = FakeWorker.instances.find(worker => worker.name === 'mova-memory-extract');
  assert.deepEqual(extract.options.connection, {});
  assert.equal(extract.options.prefix, 'mova');
  assert.equal(extract.options.concurrency, 2);
  assert.equal(FakeWorker.instances.find(worker => worker.name === 'mova-session-sync').options.concurrency, 1);
  assert.deepEqual(await extract.processor({ id: 'job-1' }), 'ok');
  assert.equal(log.entries.some(entry => entry.level === 'warn' && entry.message === 'queue.workers-missing-handlers'), true);
  FakeWorker.instances[0].listeners.get('failed')({ id: 'job-1', attemptsMade: 3 }, Object.assign(new Error('extract failed'), { code: 'boom' }));
  assert.equal(log.entries.some(entry => entry.message === 'queue.job-failed' && entry.fields.jobId === 'job-1'), true);
  await workers.close();
  assert.equal(FakeWorker.instances.every(worker => worker.closed === 1), true);
});

test('worker service rejects handler errors so BullMQ can retry them', async () => {
  FakeWorker.instances = [];
  const workers = createWorkerService({
    redisUrl: 'redis://127.0.0.1:56379',
    handlers: { memoryExtract: async () => { throw new Error('boom'); } },
    WorkerClass: FakeWorker,
    connection: {},
    env: {},
  });
  const worker = workers.workers.get('memoryExtract');
  await assert.rejects(() => worker.processor({ id: 'x' }), /boom/);
  await workers.close();
});

test('worker service requires redis and at least one handler', () => {
  const WorkerClass = class {};
  assert.throws(() => createWorkerService({ env: {}, handlers: { memoryExtract() {} }, WorkerClass }), error => error.code === 'redis-missing');
  assert.throws(() => createWorkerService({ env: {}, redisUrl: 'redis://x', handlers: {}, WorkerClass }), error => error.code === 'queue-invalid-handlers');
  assert.throws(() => createWorkerService({ env: {}, redisUrl: 'redis://x', handlers: { memoryExtract: 'nope' }, WorkerClass }), error => error.code === 'queue-invalid-handlers');
  assert.throws(() => createWorkerService({ env: {}, redisUrl: 'redis://x', handlers: null, WorkerClass }), error => error.code === 'queue-invalid-handlers');
  // Still no real BullMQ/ioredis module loaded by these paths.
  assert.deepEqual(Object.keys(require.cache).filter(key => /node_modules[\\/](bullmq|ioredis)[\\/]/.test(key)), []);
});
