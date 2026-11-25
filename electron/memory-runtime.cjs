'use strict';
// Local service-mode runtime: Docker services + PostgreSQL + pgvector + Redis
// queues + local ONNX embeddings. This module is intentionally Electron-free
// except for the optional `app` used to resolve userData.
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { Pool } = require('pg');
const { createMemoryRepository } = require('./memory-store.cjs');
const { createPostgresRepository, SINGLE_USER_ID } = require('./db/postgres-repository.cjs');
const { migrate } = require('./db/migrate.cjs');
const { configureDefaultChatImages } = require('./chat-images.cjs');
const { createEmbeddingService } = require('./services/embedding.cjs');
const { createIndexer } = require('./services/indexer.cjs');
const { createHybridSearch } = require('./services/hybrid-search.cjs');
const { createQueueService, createWorkerService, createQueueRouter } = require('./services/queue.cjs');
const { createBackupService, spawnRunner } = require('./services/backup.cjs');
const { createRestoreCoordinator, gateMethods } = require('./services/restore-coordinator.cjs');
const { createSessionStore } = require('./services/session-store.cjs');
const { createQuotaService } = require('./services/quota.cjs');
const { createSecretVault } = require('./services/secret-vault.cjs');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

const DEFAULTS = Object.freeze({
  dbUrl: 'postgres://mova:mova_local_password@127.0.0.1:55432/mova',
  redisUrl: 'redis://127.0.0.1:56379',
  s3Endpoint: 'http://127.0.0.1:59090',
  s3Region: 'us-east-1',
  s3Bucket: 'mova-artifacts',
  s3AccessKey: 'mova',
  s3SecretKey: 'mova_local_password',
});

function redact(url) {
  return String(url || '').replace(/(:\/\/[^:/@\s]*):[^@/\s]*@/g, '$1:***@');
}

function dockerBin(env = process.env) {
  return env.MOVA_DOCKER_BIN || env.MOVA_DOCKER_CLI || 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
}

function serviceScript() {
  return path.join(__dirname, '..', 'scripts', 'services.mjs');
}

function normalizeConfig({ app, env = process.env } = {}) {
  const userData = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.mova-runtime');
  let persistedAutoStart = null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(userData, 'service-bootstrap.json'), 'utf8'));
    if (typeof value?.autoStartServices === 'boolean') persistedAutoStart = value.autoStartServices;
  } catch { /* no bootstrap settings yet */ }
  return {
    mode: env.MOVA_MODE || 'postgres',
    dbUrl: env.MOVA_DB_URL || DEFAULTS.dbUrl,
    redisUrl: env.MOVA_REDIS_URL || DEFAULTS.redisUrl,
    s3Endpoint: env.MOVA_S3_ENDPOINT || DEFAULTS.s3Endpoint,
    s3Region: env.MOVA_S3_REGION || DEFAULTS.s3Region,
    s3Bucket: env.MOVA_S3_BUCKET || DEFAULTS.s3Bucket,
    s3AccessKey: env.MOVA_S3_ACCESS_KEY || DEFAULTS.s3AccessKey,
    s3SecretKey: env.MOVA_S3_SECRET_KEY || DEFAULTS.s3SecretKey,
    autoStart: persistedAutoStart === null ? env.MOVA_AUTOSTART_SERVICES !== 'false' : persistedAutoStart,
    userData,
    backupDir: env.MOVA_BACKUP_DIR || path.join(userData, 'backups'),
    modelDir: env.MOVA_EMBEDDING_CACHE_DIR || path.join(userData, 'models'),
    env,
  };
}

function createRuntimeLogger(logger = console) {
  const debugEnabled = process.env.MOVA_DEBUG_MEMORY === '1';
  const call = (level, message, detail) => {
    if (level === 'debug' && !debugEnabled) return;
    const fn = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : null;
    if (!fn) return;
    // A detached Electron process may have no stdout reader; a console write
    // can throw EPIPE. Logging must never crash the app.
    //
    // 注意：这个 try/catch 只挡得住**同步**抛错。管道断掉时真正的失败发生在
    // `Socket._write` 之后，是流上的异步 `'error'` 事件，没人监听就会升级成
    // uncaughtException（在 Electron 里就是一个跟用户无关的崩溃弹窗）。
    // 那一层的守卫在 electron/stdio-guard.cjs（main.cjs 第一条语句装上）。
    try {
      if (detail === undefined) fn(`[memory-runtime] ${message}`);
      else fn(`[memory-runtime] ${message}`, detail);
    } catch { /* stdout is gone */ }
  };
  return { debug: (m, d) => call('debug', m, d), info: (m, d) => call('info', m, d), warn: (m, d) => call('warn', m, d), error: (m, d) => call('error', m, d) };
}

async function runServiceCommand(command, config, logger) {
  const env = {
    ...process.env,
    ...config.env,
    MOVA_MODE: config.mode,
    MOVA_DB_URL: config.dbUrl,
    MOVA_REDIS_URL: config.redisUrl,
    MOVA_S3_ENDPOINT: config.s3Endpoint,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: `${path.dirname(dockerBin(config.env))};${process.env.PATH || ''}`,
  };
  logger.info(`services:${command}`);
  const { stdout, stderr } = await execFile(process.execPath, [serviceScript(), command, '--json'], {
    cwd: path.dirname(serviceScript()), env, timeout: 210_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (stderr && !/warning/i.test(stderr)) logger.warn('services output', stderr.slice(0, 1000));
  try { return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); } catch { return { raw: stdout }; }
}

function createS3Client(config) {
  return new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  });
}

function dockerBackupRunner(config) {
  const docker = dockerBin(config.env);
  const url = new URL(config.dbUrl);
  return async spec => {
    const tool = path.basename(String(spec.command || 'pg_dump')).replace(/\.exe$/i, '');
    const backupDir = config.backupDir;
    const args = (spec.args || []).map(arg => {
      if (typeof arg !== 'string') return arg;
      const resolved = path.resolve(arg);
      if (resolved.startsWith(path.resolve(backupDir) + path.sep)) {
        return `/backup/${path.basename(arg)}`;
      }
      return arg;
    });
    const dockerArgs = [
      'run', '--rm', '--add-host=host.docker.internal:host-gateway',
      '-v', `${backupDir}:/backup`,
      '-e', 'PGHOST=host.docker.internal',
      '-e', `PGPORT=${url.port || '5432'}`,
      '-e', `PGUSER=${decodeURIComponent(url.username || 'mova')}`,
      '-e', `PGPASSWORD=${decodeURIComponent(url.password || '')}`,
      '-e', `PGDATABASE=${decodeURIComponent(url.pathname.replace(/^\//, '') || 'mova')}`,
      'pgvector/pgvector:pg16', tool, ...args,
    ];
    return spawnRunner({ ...spec, command: docker, args: dockerArgs, env: { ...process.env, ...spec.env } });
  };
}

/**
 * @param {{app?: object, env?: NodeJS.ProcessEnv, logger?: Console}} options
 */
function createMemoryRuntime(options = {}) {
  const config = normalizeConfig(options);
  const logger = createRuntimeLogger(options.logger || console);
  const extractor = options.extractor || null;
  let repository = null;
  let pool = null;
  let embedding = null;
  let indexer = null;
  let search = null;
  let queue = null;
  let worker = null;
  let backup = null;
  let sessionStore = null;
  let s3 = null;
  let ready = null;
  let closed = false;
  let backupTimer = null;
  let lastBackupDate = null;
  const coordinator = createRestoreCoordinator({ acquireExclusive: options.acquireRestoreExclusive });
  let restoring = false;
  let restoreDone = null;

  async function ensureServices() {
    if (config.mode === 'local') return null;
    if (config.autoStart) return runServiceCommand('ensure', config, logger);
    const status = await runServiceCommand('status', config, logger);
    if (!status?.ok) throw new Error('local services are not healthy; start Docker Desktop and run node scripts/services.mjs ensure');
    return status;
  }

  async function start() {
    if (ready) return ready;
    ready = (async () => {
      if (config.mode === 'local') {
        repository = createMemoryRepository({ directory: path.join(config.userData, 'memory'), extractor });
        logger.info('local JSON mode');
        return repository;
      }

      await ensureServices();
      pool = new Pool({ connectionString: config.dbUrl, max: 8, application_name: 'mova-electron' });
      pool.on('error', error => logger.warn('database pool error', error.message));
      await migrate({ pool, log: message => logger.info(`migration:${message}`) });

      embedding = createEmbeddingService({ cacheDir: config.modelDir });
      // Do not warm the ONNX model on Electron's main thread during startup:
      // model loading is CPU-heavy and would delay the window/debug endpoint.
      // The first search or the health panel triggers lazy loading instead.
      indexer = createIndexer({ pool, embedding, ownerId: SINGLE_USER_ID });

      queue = createQueueService({ redisUrl: config.redisUrl, logger });
      // The repository speaks raw BullMQ add(name, ...); the router maps the four
      // fixed queue names to deterministic colon-free job ids.
      const router = createQueueRouter(queue);
      const queueAdapter = Object.create(router);
      queueAdapter.add = async (name, data, opts = {}) => {
        // The repository batches event ids per conversation; the queue contract
        // keys session sync by eventId. Use the first event as the stable key and
        // let the handler rebuild the whole conversation.
        if (name === 'mova-session-sync' && data && !data.eventId) {
          const eventId = Array.isArray(data.eventIds) ? data.eventIds[0] : data.conversationId;
          return queue.enqueueSessionSync({ ...data, eventId }, { ...opts, removeOnFail: false });
        }
        return router.add(name, data, opts);
      };

      const backupRunner = dockerBackupRunner(config);
      backup = createBackupService({
        query: (sql, params) => pool.query(sql, params),
        directory: config.backupDir,
        databaseUrl: config.dbUrl,
        ownerId: SINGLE_USER_ID,
        runner: backupRunner,
        env: config.env,
        logger,
      });
      sessionStore = createSessionStore({ query: (sql, params) => pool.query(sql, params), logger });
      s3 = createS3Client(config);
      // Bucket creation/health is checked lazily in health(), never on startup.

      // `search` needs the repository's settings, while the repository needs the
      // search engine. Resolve that cycle with a late-bound provider.
      let repositoryRef = null;
      search = createHybridSearch({
        pool,
        embedding,
        ownerId: SINGLE_USER_ID,
        settings: () => (repositoryRef ? repositoryRef.settings() : { semanticSearch: true, hybridWeight: 0.5 }),
      });
      repositoryRef = createPostgresRepository({
        pool,
        embeddingService: embedding,
        indexer,
        searchEngine: search,
        queue: queueAdapter,
        extractor,
        ownerId: SINGLE_USER_ID,
      });
      const base = repositoryRef;

      // Backup records are owned by the backup service; never create a second
      // metadata row in the repository. The UI sees the backup service records.
      repository = Object.create(base);
      repository.vault = createSecretVault({
        query: (sql, params) => pool.query(sql, params),
        ownerId: SINGLE_USER_ID,
      });
      const quota = createQuotaService({
        query: (sql, params) => pool.query(sql, params),
        directory: path.join(config.userData, 'chat-images'),
        settingsProvider: () => base.settings(),
      });
      // Enforce the user quota on the write paths that can grow storage. The
      // value is an estimate of the new bytes; the quota service measures DB +
      // local attachments. 0 means unlimited and skips measurement.
      const wrapQuota = (name, estimate) => {
        const original = base[name].bind(base);
        repository[name] = async (...args) => {
          if (estimate) await quota.checkWrite({ bytes: estimate(...args) });
          return original(...args);
        };
      };
      wrapQuota('saveMemory', input => (input?.text ? Buffer.byteLength(String(input.text), 'utf8') : 0));
      wrapQuota('updateMemory', (_id, patch) => (patch?.text ? Buffer.byteLength(String(patch.text), 'utf8') : 0));
      // 替代（supersede）同样会新增一条记忆：不计量的话，反复替代可以绕过配额。
      wrapQuota('supersedeMemory', input => (input?.text ? Buffer.byteLength(String(input.text), 'utf8') : 0));
      wrapQuota('ingest', input => (input?.text ? Buffer.byteLength(String(input.text), 'utf8') : 0));
      wrapQuota('saveSessions', snapshot => Buffer.byteLength(JSON.stringify(snapshot || {}), 'utf8'));
      configureDefaultChatImages({ quota, directory: path.join(config.userData, 'chat-images') });
      const baseSettings = base.settings.bind(base);
      repository.settings = async patch => {
        const value = await baseSettings(patch);
        if (patch && typeof patch.autoStartServices === 'boolean') {
          try {
            fs.mkdirSync(config.userData, { recursive: true });
            fs.writeFileSync(path.join(config.userData, 'service-bootstrap.json'), JSON.stringify({ autoStartServices: patch.autoStartServices }), 'utf8');
          } catch { /* setting still applies in memory; next boot falls back to env */ }
        }
        return value;
      };
      repository.backup = input => backup.backup({ kind: input?.kind === 'scheduled' ? 'scheduled' : 'manual' });
      repository.listBackups = () => backup.list({ limit: 100 });
      repository.restore = async input => {
        const id = typeof input === 'string' ? input : input?.id;
        if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('invalid-input'), { code: 'invalid-input' });
        if (closed) throw Object.assign(new Error('runtime-closed'), { code: 'runtime-closed' });
        if (restoring) throw Object.assign(new Error('restore-in-progress'), { code: 'restore-in-progress' });
        restoring = true;
        try {
          restoreDone = backup.restore(id, {
            confirmToken: backup.restoreToken(id),
            stopWrites: coordinator.stopWrites,
            overwriteCurrent: true,
            confirmOverwrite: true,
          });
          return await restoreDone;
        } finally { restoring = false; restoreDone = null; }
      };
      repository.health = async () => {
        const value = await base.health();
        try {
          await s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }), { abortSignal: AbortSignal.timeout(3000) });
          value.objectStorage = 'ok';
        } catch {
          value.objectStorage = 'down';
        }
        return value;
      };
      repository.stats = async () => {
        const value = await base.stats();
        try {
          const { rows } = await pool.query('select count(*)::int as count from mova_search_chunks where owner_id=$1', [SINGLE_USER_ID]);
          value.indexPath = rows[0]?.count > 0 ? 'postgres:pgvector' : null;
          const quotaStats = await quota.stats();
          value.quotaBytes = quotaStats.quotaBytes > 0 ? quotaStats.quotaBytes : null;
          if (Number.isFinite(quotaStats.attachmentBytes)) value.attachmentBytes = quotaStats.attachmentBytes;
        } catch { /* stats remains usable without index/quota metadata */ }
        return value;
      };

      // Worker: index/backup/extract/session-sync queues. Search and memory
      // extraction remain synchronous; these jobs fill indexes and run backups.
      try {
        worker = createWorkerService({
          redisUrl: config.redisUrl,
          logger,
          concurrency: 1,
          handlers: Object.fromEntries(Object.entries({
            memoryExtract: async () => base.processPendingJobs({ limit: 5 }),
            memoryIndex: async job => {
              const data = job?.data || {};
              if (data.kind === 'reindex') return indexer.reindexAll({ ownerId: SINGLE_USER_ID });
              if (data.sourceKind === 'message' && typeof data.conversationId === 'string') {
                const prefix = `${data.conversationId}:`;
                const messageId = typeof data.sourceId === 'string' && data.sourceId.startsWith(prefix)
                  ? data.sourceId.slice(prefix.length) : null;
                if (!messageId) return { skipped: 'message-id-missing' };
                const { rows } = await pool.query(
                  `select e.content, c.project_id
                     from mova_session_events e
                     join mova_conversations c on c.id = e.conversation_id
                    where e.conversation_id=$1 and e.event_id=$2`,
                  [data.conversationId, messageId],
                );
                if (!rows[0]) return { skipped: 'message-not-found' };
                const content = rows[0].content || {};
                const text = String(messageId).endsWith('-assistant')
                  ? (typeof content.reply?.text === 'string' ? content.reply.text : '')
                  : (typeof content.user === 'string' ? content.user : typeof content.text === 'string' ? content.text : '');
                if (!text.trim()) return { skipped: 'message-empty' };
                return indexer.indexMessage({
                  ownerId: SINGLE_USER_ID, conversationId: data.conversationId,
                  messageId, text, projectId: rows[0].project_id || null,
                });
              }
              const memoryId = data.memoryId || data.sourceId;
              if (typeof memoryId !== 'string') return { skipped: true };
              const { rows } = await pool.query(
                'select id, text, project_id, source, status from mova_memories where id=$1 and owner_id=$2',
                [memoryId, SINGLE_USER_ID],
              );
              if (!rows[0]) return { skipped: 'memory-not-found' };
              return indexer.indexMemory({ id: rows[0].id, text: rows[0].text, projectId: rows[0].project_id, source: rows[0].source });
            },
            backup: async job => backup.backup({ kind: job?.data?.kind === 'scheduled' ? 'scheduled' : 'manual' }),
            sessionSync: async job => {
              const conversationId = job?.data?.conversationId;
              if (typeof conversationId !== 'string') return { skipped: true };
              return base.indexSession(conversationId);
            },
          }).map(([name, handler]) => [name, (...args) => coordinator.runWorker(() => handler(...args))])),
        });
      } catch (error) {
        logger.warn('worker unavailable; queues remain durable but unprocessed', error.message);
      }

      scheduleBackups();
      // Resume durable extraction jobs that were interrupted by a quit/crash.
      setTimeout(() => {
        if (closed) return;
        coordinator.run(() => base.processPendingJobs({ limit: 5 }))
          .then(result => { if (result.processed) logger.info('memory jobs resumed', result); })
          .catch(error => logger.warn('memory job resume failed', error.message));
      }, 2000);
      const jobTimer = setInterval(() => {
        if (closed) return;
        coordinator.run(() => base.processPendingJobs({ limit: 5 })).catch(error => logger.warn('memory job retry failed', error.message));
      }, 60_000);
      if (jobTimer.unref) jobTimer.unref();
      const maintenanceTimer = setInterval(() => {
        if (closed) return;
        coordinator.run(() => base.maintenance({ apply: true }))
          .then(result => { if (result?.applied) logger.info('memory maintenance applied', result.stats); })
          .catch(error => logger.warn('memory maintenance failed', error.message));
      }, 24 * 60 * 60 * 1000);
      if (maintenanceTimer.unref) maintenanceTimer.unref();
      // The first search may race the local model/index. Once the window is up,
      // warm the model and rebuild any keyword-only chunks in the background.
      setTimeout(() => {
        if (closed) return;
        coordinator.run(async () => {
          await embedding.warmup();
          const summary = await indexer.reindexAll({ ownerId: SINGLE_USER_ID, batchSize: 50 });
          logger.info('index refreshed', { memories: summary.memories, messages: summary.messages, failed: summary.failed });
        }).catch(error => logger.warn('background index refresh failed', error.message));
      }, 1500);
      repository.vault = gateMethods(repository.vault, coordinator);
      repository = gateMethods(repository, coordinator, ['restore']);
      logger.info('postgres service runtime ready');
      return repository;
    })().catch(error => {
      ready = null;
      throw error;
    });
    return ready;
  }

  function scheduleBackups() {
    if (backupTimer) return;
    backupTimer = setInterval(async () => {
      if (closed) return;
      try {
        await coordinator.run(async () => {
        const settings = await repository.settings();
        if (settings.backupSchedule === 'off') return;
        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        if (lastBackupDate === date) return;
        const schedule = String(settings.backupSchedule || 'daily 03:00');
        const [hour, minute] = schedule.split(/\s+/).at(-1).split(':').map(Number);
        if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
        if (schedule.startsWith('weekly') && now.getDay() !== 1) return;
        const due = now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
        if (!due) return;
        lastBackupDate = date;
        if (queue?.enabled) await queue.enqueueBackup({ kind: 'scheduled' });
        else await backup.backup({ kind: 'scheduled' });
        });
      } catch (error) {
        logger.warn('scheduled backup failed', error.message);
      }
    }, 60_000);
    if (backupTimer.unref) backupTimer.unref();
  }

  async function stop() {
    if (closed) return;
    closed = true;
    if (backupTimer) clearInterval(backupTimer);
    if (restoreDone) await restoreDone.catch(() => {});
    coordinator.close();
    if (worker) await worker.close().catch(() => {});
    if (queue) await queue.close().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (embedding) await embedding.close().catch(() => {});
  }

  return {
    config,
    start,
    stop,
    get repository() { return repository; },
    get pool() { return pool; },
    get services() { return { queue, embedding, indexer, search, backup, sessionStore, s3 }; },
  };
}

module.exports = { createMemoryRuntime, createRuntimeLogger, DEFAULTS, redact };
