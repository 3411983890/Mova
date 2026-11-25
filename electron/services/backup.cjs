'use strict';

/**
 * Logical backup & restore for Mova service mode.
 *
 * Contract: Mova服务版接口约定.md §9 and §12.2; dev doc §11.3.
 *
 * Scope, stated plainly so the settings page cannot overclaim:
 *  - This module implements LOGICAL backups (`pg_dump` custom format by default,
 *    plain SQL optional) plus a guarded logical restore (`pg_restore`/`psql`).
 *  - WAL archiving, continuous archiving, point-in-time recovery (PITR), backup
 *    encryption, off-site copies and attachment/object-storage archiving are
 *    NOT implemented here. They are reported as unsupported by `capabilities()`
 *    and by `status()`; the UI must not show “时间点恢复/连续归档” as available.
 *
 * Safety rules enforced here:
 *  - Failure never deletes existing backups and never deletes current data.
 *  - Restore requires an explicit `confirmToken` (see `restoreToken(id)`), an
 *    explicit target (`restoreToNewDatabase` or `overwriteCurrent`) and resolved
 *    write-stopping (the caller injects `stopWrites`, e.g. queue pause + worker
 *    shutdown). Restore never issues `--clean`/`DROP DATABASE`; `--single-transaction`
 *    keeps a failed restore from leaving a half-written database.
 *  - A backup row is written to `mova_backups` as `running` before `pg_dump`, and
 *    updated to `completed`/`failed`. A metadata failure is surfaced as an error,
 *    never silently swallowed.
 *  - Connection strings are never passed on the command line and passwords are
 *    redacted from all errors/log payloads.
 *
 * Dependencies are injected: `query(text, params)` (pg), `runner(spec)` (spawn),
 * `fs` (node:fs/promises shape) — tests use fakes, no real Postgres/Redis needed.
 */

const defaults = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const DEFAULT_OWNER_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3_650;
const MAX_ERROR_LENGTH = 500;
const STREAM_CAP = 8_192;

/**
 * `mova_backups` statements. The schema is owned by electron/db (§3.1); these
 * are the only writes this module performs.
 */
const SQL = Object.freeze({
  insertBackup: `insert into mova_backups (id, owner_id, kind, path, status)
values ($1, $2, $3, $4, 'running')
returning id, owner_id, kind, path, bytes, status, error, created_at, completed_at`,
  completeBackup: `update mova_backups
set status = 'completed', bytes = $2, completed_at = now(), error = null
where id = $1
returning id, owner_id, kind, path, bytes, status, error, created_at, completed_at`,
  failBackup: `update mova_backups
set status = 'failed', error = $2, completed_at = now()
where id = $1
returning id, owner_id, kind, path, bytes, status, error, created_at, completed_at`,
  listBackups: `select id, owner_id, kind, path, bytes, status, error, created_at, completed_at
from mova_backups
where owner_id = $1
order by created_at desc
limit $2`,
  getBackup: `select id, owner_id, kind, path, bytes, status, error, created_at, completed_at
from mova_backups
where id = $1 and owner_id = $2`,
  expiredBackups: `select id, path, created_at
from mova_backups
where owner_id = $1
  and status = 'completed'
  and created_at < $2
  and ($3::uuid is null or id <> $3)
order by created_at asc
limit $4`,
  deleteBackup: `delete from mova_backups where id = $1`,
});

/**
 * Capability matrix consumed by the settings page. Everything false must not be
 * advertised as available. `note` is user-facing and deliberately explicit.
 */
const CAPABILITIES = Object.freeze({
  kind: 'logical',
  formats: Object.freeze(['custom', 'plain']),
  logicalBackup: true,
  logicalRestore: true,
  backupMetadata: true,
  retention: true,
  walArchiving: false,
  pointInTimeRecovery: false,
  continuousArchiving: false,
  encryption: false,
  offsiteCopy: false,
  attachmentArchive: false,
  integrityCheck: 'caller-supplied verify()',
  rpoMinutes: null,
  rtoMinutes: null,
  note: '当前仅实现逻辑备份与恢复（pg_dump/pg_restore）。未实现 WAL 归档、连续归档与时间点恢复（PITR），界面不得显示已具备这些能力。',
});

class BackupError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'BackupError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function redact(value) {
  return String(value ?? '')
    .replace(/(:\/\/[^:/@\s]*):[^@/\s]*@/g, '$1:***@')
    .replace(/\b((?:pg)?password|passwd|pwd)\s*=\s*\S+/gi, '$1=***');
}

function safeError(error) {
  const text = typeof error === 'string' ? error : error?.message ?? '';
  return redact(text).slice(0, MAX_ERROR_LENGTH);
}

function normalizeLogger(logger) {
  const noop = () => {};
  return {
    debug: typeof logger?.debug === 'function' ? logger.debug.bind(logger) : noop,
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : noop,
  };
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id ?? row.ownerId ?? null,
    kind: row.kind,
    path: row.path,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    status: row.status,
    error: row.error ?? null,
    createdAt: toIso(row.created_at ?? row.createdAt),
    completedAt: toIso(row.completed_at ?? row.completedAt),
  };
}

/** Parse a postgres URL into libpq environment variables (never argv). */
function connectionEnv(databaseUrl, baseEnv = process.env) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) throw new BackupError('database-url-missing');
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new BackupError('invalid-database-url');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new BackupError('invalid-database-url');
  let database;
  let user;
  let password;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    user = url.username ? decodeURIComponent(url.username) : null;
    password = url.password ? decodeURIComponent(url.password) : null;
  } catch {
    throw new BackupError('invalid-database-url');
  }
  if (!database) throw new BackupError('invalid-database-url');
  const env = { ...baseEnv, PGDATABASE: database };
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (user) env.PGUSER = user;
  if (password) env.PGPASSWORD = password;
  // A quieter client is easier to scan for real failures.
  env.PGCONNECT_TIMEOUT = env.PGCONNECT_TIMEOUT ?? '15';
  return { env, database, host: url.hostname || null, port: url.port || null, redactedUrl: redact(databaseUrl) };
}

/** Default runner: spawn a child process and collect bounded stdout/stderr. */
function spawnRunner(spec) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = spec.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, spec.timeoutMs)
      : null;
    if (timer?.unref) timer.unref();
    child.stdout?.on('data', chunk => {
      if (stdout.length < STREAM_CAP) stdout += String(chunk).slice(0, STREAM_CAP - stdout.length);
    });
    child.stderr?.on('data', chunk => {
      if (stderr.length < STREAM_CAP) stderr += String(chunk).slice(0, STREAM_CAP - stderr.length);
    });
    child.once('error', error => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: signal === 'SIGKILL' && Boolean(spec.timeoutMs) });
    });
  });
}

function timestampSlug(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function validateFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) throw new BackupError('invalid-filename');
  const name = filename.trim();
  if (name.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new BackupError('invalid-filename');
  if (name.includes('..') || name.startsWith('.')) throw new BackupError('invalid-filename');
  if (!/\.(dump|sql|backup)$/i.test(name)) throw new BackupError('invalid-filename');
  return name;
}

function formatForFilename(filename, requested) {
  if (requested !== undefined) {
    if (!['custom', 'plain'].includes(requested)) throw new BackupError('invalid-format');
    return requested;
  }
  return /\.sql$/i.test(filename) ? 'plain' : 'custom';
}

/**
 * @param {object} options
 * @param {(text: string, params?: unknown[]) => Promise<{rows: object[]}>} options.query
 * @param {string} options.directory backup directory (options.directory || MOVA_BACKUP_DIR || options.userData/backups)
 * @param {string} [options.databaseUrl] default `MOVA_DB_URL`
 * @param {string} [options.ownerId] default fixed single-user uuid
 * @param {number} [options.retentionDays] default `MOVA_BACKUP_RETENTION_DAYS` or 30
 * @param {(spec: object) => Promise<{code: number|null, stderr?: string, stdout?: string}>} [options.runner]
 * @param {object} [options.fs] node:fs/promises-compatible
 * @param {Function} [options.now] `() => Date`
 * @param {Function} [options.id] `() => uuid`
 * @param {object} [options.logger]
 * @param {object} [options.env]
 */
function createBackupService(options = {}) {
  if (!isObject(options)) throw new BackupError('invalid-options');
  if (typeof options.query !== 'function') throw new BackupError('query-required');

  const env = options.env || process.env;
  const query = options.query;
  const io = options.fs || defaults;
  const logger = normalizeLogger(options.logger);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const nextId = typeof options.id === 'function' ? options.id : randomUUID;
  const runner = typeof options.runner === 'function' ? options.runner : spawnRunner;

  const ownerId = options.ownerId === undefined ? DEFAULT_OWNER_ID : options.ownerId;
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new BackupError('invalid-owner');
  const databaseUrl = options.databaseUrl === undefined ? env.MOVA_DB_URL || '' : options.databaseUrl;
  const retentionDays = options.retentionDays === undefined
    ? Number(env.MOVA_BACKUP_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)
    : Number(options.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) throw new BackupError('invalid-retention');

  const directory = options.directory || env.MOVA_BACKUP_DIR || (options.userData ? path.join(options.userData, 'backups') : null);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new BackupError('backup-dir-missing');

  const pgDumpPath = options.pgDumpPath || 'pg_dump';
  const pgRestorePath = options.pgRestorePath || 'pg_restore';
  const psqlPath = options.psqlPath || 'psql';
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30 * 60 * 1000;

  function currentDate() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new BackupError('invalid-clock');
    return date;
  }

  async function markFailed(id, error) {
    try {
      await query(SQL.failBackup, [id, safeError(error)]);
    } catch (metadataError) {
      logger.error?.('backup.metadata-failed', { id, code: metadataError?.code ?? null, message: safeError(metadataError) });
    }
  }

  async function removePartial(targetPath) {
    try {
      await io.unlink(targetPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.('backup.partial-cleanup-failed', { path: targetPath, code: error?.code ?? null });
    }
  }

  /**
   * Delete backups older than the retention window (metadata + file). Used by
   * `backup()` only after a successful dump, so a failed run never prunes.
   */
  async function prune({ keepId = null } = {}) {
    const cutoff = new Date(currentDate().getTime() - retentionDays * 86_400_000);
    let rows;
    try {
      ({ rows } = await query(SQL.expiredBackups, [ownerId, cutoff.toISOString(), keepId, 500]));
    } catch (error) {
      logger.warn?.('backup.prune-query-failed', { message: safeError(error) });
      return [];
    }
    const removed = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      try {
        await io.unlink(row.path);
      } catch (error) {
        // Missing file: still drop the row. Any other error keeps the row so the
        // next run can retry; retention must never silently lose bookkeeping.
        if (error?.code !== 'ENOENT') {
          logger.warn?.('backup.prune-file-failed', { id: row.id, path: row.path, code: error?.code ?? null });
          continue;
        }
      }
      try {
        await query(SQL.deleteBackup, [row.id]);
      } catch (error) {
        logger.warn?.('backup.prune-row-failed', { id: row.id, message: safeError(error) });
        continue;
      }
      removed.push({ id: row.id, path: row.path, createdAt: toIso(row.created_at ?? row.createdAt) });
    }
    return removed;
  }

  /**
   * Run one logical backup.
   * @param {{kind?: 'manual'|'scheduled', filename?: string, format?: 'custom'|'plain'}} [input]
   * @returns {Promise<object>} BackupRecord
   */
  async function backup(input = {}) {
    if (!isObject(input)) throw new BackupError('invalid-input');
    const kind = input.kind === undefined ? 'manual' : input.kind;
    if (!['manual', 'scheduled'].includes(kind)) throw new BackupError('invalid-kind');
    if (!databaseUrl) throw new BackupError('database-url-missing');
    const connection = connectionEnv(databaseUrl, env);
    const format = formatForFilename(input.filename ?? '', input.format);
    const filename = input.filename === undefined
      ? `mova-${kind}-${timestampSlug(currentDate())}.${format === 'plain' ? 'sql' : 'dump'}`
      : validateFilename(input.filename);
    const targetPath = path.join(directory, filename);
    if (path.resolve(path.dirname(targetPath)) !== path.resolve(directory)) throw new BackupError('invalid-filename');

    try {
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new BackupError('backup-dir-unavailable', safeError(error));
    }

    const id = nextId();
    const createdAt = currentDate().toISOString();
    try {
      await query(SQL.insertBackup, [id, ownerId, kind, targetPath]);
    } catch (error) {
      logger.error?.('backup.metadata-insert-failed', { id, code: error?.code ?? null, message: safeError(error) });
      throw new BackupError('backup-metadata-failed', safeError(error));
    }

    // Dump to a side file and rename on success so an interrupted run can never
    // overwrite an existing completed backup at the same path.
    const partialPath = `${targetPath}.${id}.partial`;
    const args = [
      '--format', format === 'plain' ? 'plain' : 'custom',
      '--file', partialPath,
      '--no-owner',
      '--no-privileges',
      '--verbose',
    ];
    const spec = { command: pgDumpPath, args, env: connection.env, cwd: directory, timeoutMs };
    let result;
    try {
      result = await runner(spec);
    } catch (error) {
      await markFailed(id, error);
      await removePartial(partialPath);
      throw new BackupError(error?.code === 'ENOENT' ? 'backup-tool-missing' : 'backup-failed', safeError(error));
    }
    if (!result || result.code !== 0) {
      const detail = result?.timedOut ? 'pg_dump timed out' : (result?.stderr || `pg_dump exited with code ${result?.code}`);
      await markFailed(id, detail);
      await removePartial(partialPath);
      throw new BackupError(result?.timedOut ? 'backup-timeout' : 'backup-failed', safeError(detail));
    }

    try {
      await io.rename(partialPath, targetPath);
    } catch (error) {
      await markFailed(id, error);
      await removePartial(partialPath);
      throw new BackupError('backup-failed', safeError(error));
    }

    let bytes;
    try {
      const stat = await io.stat(targetPath);
      bytes = Number(stat.size);
      if (!Number.isFinite(bytes) || bytes <= 0) throw new BackupError('backup-empty');
    } catch (error) {
      await markFailed(id, error);
      throw new BackupError(error?.code === 'backup-empty' ? 'backup-empty' : 'backup-failed', safeError(error));
    }

    let record;
    try {
      const { rows } = await query(SQL.completeBackup, [id, bytes]);
      record = mapRecord(Array.isArray(rows) ? rows[0] : null) ?? {
        id, ownerId, kind, path: targetPath, bytes, status: 'completed', error: null, createdAt, completedAt: null,
      };
    } catch (error) {
      // The dump exists but its metadata is wrong. Never delete existing backups;
      // surface the failure so the UI does not show a half-recorded backup as good.
      logger.error?.('backup.metadata-complete-failed', { id, code: error?.code ?? null, message: safeError(error) });
      throw new BackupError('backup-metadata-failed', safeError(error));
    }

    try {
      const removed = await prune({ keepId: id });
      if (removed.length) logger.info?.('backup.pruned', { removed: removed.length, retentionDays });
    } catch (error) {
      logger.warn?.('backup.prune-failed', { message: safeError(error) });
    }
    logger.info?.('backup.completed', { id, kind, bytes, path: targetPath });
    return record;
  }

  async function list({ limit = 50 } = {}) {
    const max = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 50;
    const { rows } = await query(SQL.listBackups, [ownerId, max]);
    return (Array.isArray(rows) ? rows : []).map(mapRecord).filter(Boolean);
  }

  async function get(id) {
    if (typeof id !== 'string' || !id.trim()) throw new BackupError('invalid-id');
    const { rows } = await query(SQL.getBackup, [id, ownerId]);
    return mapRecord(Array.isArray(rows) ? rows[0] : null);
  }

  async function latestCompleted() {
    const records = await list({ limit: 500 });
    return records.find(record => record.status === 'completed') ?? null;
  }

  /** Token the renderer must echo back for a restore confirmation. */
  function restoreToken(id) {
    if (typeof id !== 'string' || !id.trim()) throw new BackupError('invalid-id');
    return `RESTORE-${id}`;
  }

  function targetDatabaseName(options2) {
    if (options2.restoreToNewDatabase !== undefined) {
      if (options2.overwriteCurrent === true) throw new BackupError('restore-target-ambiguous');
      if (typeof options2.restoreToNewDatabase !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(options2.restoreToNewDatabase)) {
        throw new BackupError('invalid-target-database');
      }
      return { mode: 'new-database', database: options2.restoreToNewDatabase, databaseUrl: options2.targetDatabaseUrl };
    }
    if (options2.overwriteCurrent === true) {
      if (options2.confirmOverwrite !== true) throw new BackupError('restore-overwrite-unconfirmed');
      return { mode: 'overwrite-current', database: null, databaseUrl: null };
    }
    throw new BackupError('restore-target-required');
  }

  /**
   * Guarded logical restore.
   *
   * @param {string} id backup id
   * @param {object} input
   * @param {string} input.confirmToken must equal `restoreToken(id)`
   * @param {Function} input.stopWrites required; `({reason, backupId}) => await resume()`
   * @param {string} [input.restoreToNewDatabase] target database name (pre-created)
   * @param {string} [input.targetDatabaseUrl] connection URL for that database
   * @param {boolean} [input.overwriteCurrent] explicit in-place restore
   * @param {boolean} [input.confirmOverwrite] second explicit flag for in-place restore
   * @param {Function} [input.verify] integrity check `() => {ok, checks}`; optional
   * @returns {Promise<{restored: true, id: string, mode: string, database: string|null, format: string, verified: boolean|null, warnings: string[]}>}
   */
  async function restore(id, input = {}) {
    if (!isObject(input)) throw new BackupError('restore-requires-confirmation');
    if (!id || typeof id !== 'string') throw new BackupError('invalid-id');
    if (input.confirmToken !== restoreToken(id)) throw new BackupError('restore-requires-confirmation');
    if (typeof input.stopWrites !== 'function') throw new BackupError('restore-requires-stop-writes');

    const target = targetDatabaseName(input);
    const warnings = [];

    const record = await get(id);
    if (!record) throw new BackupError('backup-not-found');
    if (record.status !== 'completed') throw new BackupError('backup-not-completed');

    let stat;
    try {
      stat = await io.stat(record.path);
    } catch (error) {
      throw new BackupError(error?.code === 'ENOENT' ? 'backup-file-missing' : 'backup-unreadable', safeError(error));
    }
    if (!stat.size) throw new BackupError('backup-empty');

    const source = connectionEnv(databaseUrl, env);
    let targetConnection;
    if (target.mode === 'new-database') {
      const targetUrl = target.databaseUrl;
      if (!targetUrl) throw new BackupError('restore-requires-target-url');
      targetConnection = connectionEnv(targetUrl, env);
      if (targetConnection.database === source.database) throw new BackupError('restore-target-is-current-database');
    } else {
      targetConnection = source;
    }

    const format = /\.sql$/i.test(record.path) ? 'plain' : 'custom';
    const overwrite = target.mode === 'overwrite-current';
    const args = format === 'plain'
      ? ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--single-transaction', '--dbname', targetConnection.database, '--file', record.path]
      : [
        // In-place restore has an explicit confirmOverwrite gate. --clean drops
        // only objects present in this dump before recreating them; without it
        // pg_restore cannot restore over an existing schema.
        ...(overwrite ? ['--clean', '--if-exists'] : []),
        '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '--dbname', targetConnection.database, record.path,
      ];

    let resume;
    let stopError = null;
    try {
      resume = await input.stopWrites({ reason: 'restore', backupId: id, mode: target.mode });
      if (typeof resume !== 'function' && typeof input.resumeWrites !== 'function') {
        throw new Error('stop-writes-must-return-resume');
      }
    } catch (error) {
      throw new BackupError('restore-stop-failed', safeError(error));
    }

    try {
      let result;
      try {
        result = await runner({
          command: format === 'plain' ? psqlPath : pgRestorePath,
          args,
          env: targetConnection.env,
          cwd: directory,
          timeoutMs,
        });
      } catch (error) {
        throw new BackupError(error?.code === 'ENOENT' ? 'restore-tool-missing' : 'restore-failed', safeError(error));
      }
      if (!result || result.code !== 0) {
        throw new BackupError(result?.timedOut ? 'restore-timeout' : 'restore-failed', safeError(result?.stderr || `exit ${result?.code}`));
      }

      let verified = null;
      if (typeof input.verify === 'function') {
        try {
          const check = await input.verify({ backupId: id, mode: target.mode, database: targetConnection.database });
          verified = check?.ok === true;
          if (!verified) throw new BackupError('restore-verify-failed', safeError(check?.error || 'integrity check failed'));
        } catch (error) {
          if (error instanceof BackupError) throw error;
          throw new BackupError('restore-verify-failed', safeError(error));
        }
      } else {
        warnings.push('integrity-check-skipped');
        logger.warn?.('backup.restore-not-verified', { id });
      }

      logger.info?.('backup.restored', { id, mode: target.mode, database: targetConnection.database });
      return {
        restored: true,
        id,
        mode: target.mode,
        database: targetConnection.database,
        format,
        verified,
        warnings,
      };
    } catch (error) {
      // A restore command failure rolls its transaction back. Verification runs
      // after commit, so a verification failure does not undo a successful restore.
      stopError = error;
      logger.error?.('backup.restore-failed', { id, mode: target.mode, code: error?.code ?? null, message: safeError(error) });
      throw error instanceof BackupError ? error : new BackupError('restore-failed', safeError(error));
    } finally {
      try {
        if (typeof resume === 'function') await resume();
        else if (typeof input.resumeWrites === 'function') await input.resumeWrites();
      } catch (error) {
        logger.warn?.('backup.resume-writes-failed', { id, message: safeError(error) });
        if (!stopError) warnings.push('resume-writes-failed');
      }
    }
  }

  /** Restore the newest completed backup (settings page “恢复最近备份”). */
  async function restoreLatest(input = {}) {
    const record = await latestCompleted();
    if (!record) throw new BackupError('backup-not-found');
    return restore(record.id, input);
  }

  /**
   * Status/capability snapshot for the settings page. Never throws: a failed
   * metadata read is reported as an error field so the UI stays usable.
   */
  async function status() {
    const base = {
      module: 'backup',
      directory,
      retentionDays,
      database: redact(databaseUrl) || null,
      capabilities: CAPABILITIES,
      lastBackup: null,
      running: null,
      backups: 0,
      totalBytes: 0,
      error: null,
    };
    try {
      const records = await list({ limit: 500 });
      base.backups = records.length;
      base.totalBytes = records.reduce((sum, record) => sum + (record.bytes ?? 0), 0);
      base.lastBackup = records[0] ?? null;
      base.running = records.find(record => record.status === 'running') ?? null;
      base.lastCompleted = records.find(record => record.status === 'completed') ?? null;
    } catch (error) {
      base.error = safeError(error);
      logger.warn?.('backup.status-failed', { message: base.error });
    }
    return base;
  }

  return {
    ownerId,
    directory,
    retentionDays,
    capabilities: CAPABILITIES,
    backup,
    list,
    get,
    latestCompleted,
    restoreToken,
    restore,
    restoreLatest,
    prune,
    status,
    sql: SQL,
  };
}

module.exports = {
  createBackupService,
  BackupError,
  SQL,
  CAPABILITIES,
  DEFAULT_OWNER_ID,
  DEFAULT_RETENTION_DAYS,
  connectionEnv,
  spawnRunner,
  restoreToken: id => {
    if (typeof id !== 'string' || !id.trim()) throw new BackupError('invalid-id');
    return `RESTORE-${id}`;
  },
  redact,
  safeError,
};
