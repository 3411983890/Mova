import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createBackupService,
  BackupError,
  SQL,
  CAPABILITIES,
  connectionEnv,
  redact,
  restoreToken,
} = require('../electron/services/backup.cjs');

const DATABASE_URL = 'postgres://mova:mova_local_password@127.0.0.1:55432/mova';
const OWNER_ID = '00000000-0000-4000-8000-000000000001';

function logger() {
  const entries = [];
  const record = level => (message, fields) => entries.push({ level, message, fields });
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

/** Minimal in-memory `mova_backups`. */
function fakeDb({ rows = [], failInsert = false, failComplete = false, failList = false } = {}) {
  const state = { rows: [...rows], calls: [], failInsert, failComplete, failList };
  state.query = async (sql, params = []) => {
    state.calls.push({ sql, params });
    if (sql === SQL.insertBackup) {
      if (state.failInsert) throw Object.assign(new Error('insert failed'), { code: '23505' });
      const row = { id: params[0], owner_id: params[1], kind: params[2], path: params[3], bytes: null, status: 'running', error: null, created_at: '2026-11-10T03:00:00.000Z', completed_at: null };
      state.rows.push(row);
      return { rows: [row] };
    }
    if (sql === SQL.completeBackup) {
      if (state.failComplete) throw new Error('update failed');
      const row = state.rows.find(item => item.id === params[0]);
      Object.assign(row, { status: 'completed', bytes: params[1], completed_at: '2026-11-10T03:01:00.000Z', error: null });
      return { rows: [row] };
    }
    if (sql === SQL.failBackup) {
      const row = state.rows.find(item => item.id === params[0]);
      Object.assign(row, { status: 'failed', error: params[1], completed_at: '2026-11-10T03:01:00.000Z' });
      return { rows: [row] };
    }
    if (sql === SQL.listBackups) {
      if (state.failList) throw new Error('list failed');
      return { rows: [...state.rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, params[1]) };
    }
    if (sql === SQL.getBackup) {
      const row = state.rows.find(item => item.id === params[0] && item.owner_id === params[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql === SQL.expiredBackups) {
      const cutoff = new Date(params[1]).getTime();
      const keepId = params[2];
      const expired = state.rows
        .filter(row => row.status === 'completed' && new Date(row.created_at).getTime() < cutoff && row.id !== keepId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, params[3]);
      return { rows: expired.map(row => ({ id: row.id, path: row.path, created_at: row.created_at })) };
    }
    if (sql === SQL.deleteBackup) {
      const index = state.rows.findIndex(item => item.id === params[0]);
      if (index >= 0) state.rows.splice(index, 1);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
  };
  return state;
}

function fakeRunner({ code = 0, stderr = '', writes = true, throws = null } = {}) {
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    if (throws) throw throws;
    if (writes && code === 0) {
      const fileIndex = spec.args.indexOf('--file');
      const target = fileIndex >= 0 ? spec.args[fileIndex + 1] : spec.args[spec.args.length - 1];
      await fs.writeFile(target, 'PGDMP fake dump');
    }
    return { code, stderr, stdout: '' };
  };
  runner.calls = calls;
  return runner;
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mova-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const db = options.db ?? fakeDb();
  const runner = options.runner ?? fakeRunner();
  const log = logger();
  const service = createBackupService({
    query: db.query,
    directory,
    databaseUrl: DATABASE_URL,
    ownerId: OWNER_ID,
    retentionDays: 30,
    runner,
    logger: log,
    env: { PATH: process.env.PATH },
    now: () => new Date('2026-11-10T03:00:00.000Z'),
    id: () => '11111111-1111-4111-8111-111111111111',
    ...options.service,
  });
  return { service, db, runner, log, directory };
}

const code = async (fn, value) => {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${value} but nothing was thrown`);
  assert.ok(error instanceof BackupError, `expected BackupError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, value);
};

test('logical backup writes metadata, keeps secrets out of argv, and never claims WAL/PITR', async t => {
  const { service, db, runner, directory, log } = await fixture(t);
  const record = await service.backup({ kind: 'manual' });
  assert.equal(record.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(record.status, 'completed');
  assert.equal(record.kind, 'manual');
  assert.equal(record.bytes, 'PGDMP fake dump'.length);
  assert.equal(record.completedAt, '2026-11-10T03:01:00.000Z');
  assert.equal(path.dirname(record.path), directory);
  assert.match(path.basename(record.path), /^mova-manual-20261110T030000Z\.dump$/);
  assert.equal(await fs.readFile(record.path, 'utf8'), 'PGDMP fake dump');

  // metadata lifecycle: running -> completed
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, 'completed');
  assert.equal(db.rows[0].owner_id, OWNER_ID);
  assert.equal(db.calls.filter(call => call.sql === SQL.insertBackup).length, 1);

  // spawn spec: custom format, no credential in argv, credentials only in env
  assert.equal(runner.calls.length, 1);
  const [spec] = runner.calls;
  assert.equal(spec.command, 'pg_dump');
  assert.deepEqual(spec.args.slice(0, 3), ['--format', 'custom', '--file']);
  assert.notEqual(spec.args[3], record.path, 'dumps land in a .partial side file first');
  assert.match(spec.args[3], /\.partial$/);
  assert.deepEqual(spec.args.slice(4, 6), ['--no-owner', '--no-privileges']);
  assert.equal(spec.args.includes('--dbname'), false);
  assert.equal(spec.args.join(' ').includes('mova_local_password'), false);
  assert.equal(spec.args.join(' ').includes('postgres://'), false);
  assert.equal(spec.env.PGPASSWORD, 'mova_local_password');
  assert.equal(spec.env.PGDATABASE, 'mova');
  assert.equal(spec.env.PGHOST, '127.0.0.1');
  assert.equal(spec.env.PGPORT, '55432');
  assert.equal(spec.cwd, directory);
  assert.equal(JSON.stringify(log.entries).includes('mova_local_password'), false, 'logs must not contain the DB password');

  // capability honesty
  assert.equal(CAPABILITIES.walArchiving, false);
  assert.equal(CAPABILITIES.pointInTimeRecovery, false);
  assert.equal(CAPABILITIES.logicalBackup, true);
  assert.match(CAPABILITIES.note, /未实现 WAL/);
  const status = await service.status();
  assert.equal(status.capabilities.pointInTimeRecovery, false);
  assert.equal(status.capabilities.walArchiving, false);
  assert.equal(status.lastBackup.id, record.id);
  assert.equal(status.backups, 1);
  assert.equal(status.totalBytes, record.bytes);
  assert.equal(status.running, null);
  assert.equal(status.error, null);
});

test('plain format and custom filenames are validated', async t => {
  const { service, runner } = await fixture(t);
  const plain = await service.backup({ filename: 'manual-2026-11-10.sql' });
  assert.equal(plain.status, 'completed');
  assert.deepEqual(runner.calls[0].args.slice(0, 2), ['--format', 'plain']);
  await code(() => service.backup({ filename: '../escape.dump' }), 'invalid-filename');
  await code(() => service.backup({ filename: 'notes.txt' }), 'invalid-filename');
  await code(() => service.backup({ filename: 'a/b.dump' }), 'invalid-filename');
  await code(() => service.backup({ format: 'tar' }), 'invalid-format');
  await code(() => service.backup({ kind: 'daily' }), 'invalid-kind');
  assert.equal(runner.calls.length, 1);
});

test('pg_dump failure marks the row failed, removes only the new partial file, keeps old backups', async t => {
  const oldPath = path.join(os.tmpdir(), 'mova-backup-old', 'old.dump');
  const db = fakeDb({
    rows: [{ id: 'old-1', owner_id: OWNER_ID, kind: 'scheduled', path: oldPath, bytes: 10, status: 'completed', error: null, created_at: '2026-10-01T03:00:00.000Z', completed_at: '2026-10-01T03:01:00.000Z' }],
  });
  const runner = fakeRunner({ code: 1, stderr: 'pg_dump: error: connection to server failed: password=mova_local_password' });
  const { service, directory } = await fixture(t, { db, runner });
  await code(() => service.backup({}), 'backup-failed');
  assert.equal(db.rows.length, 2);
  const failed = db.rows.find(row => row.id === '11111111-1111-4111-8111-111111111111');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /connection to server failed/);
  assert.equal(failed.error.includes('mova_local_password'), false, 'failure text must be redacted');
  assert.equal(db.rows.find(row => row.id === 'old-1').status, 'completed');
  assert.deepEqual(await fs.readdir(directory), [], 'the aborted dump is cleaned up');
  assert.equal(db.calls.some(call => call.sql === SQL.expiredBackups), false, 'a failed backup never prunes');
});

test('a failed dump never overwrites an existing backup file at the same path', async t => {
  const { service, directory } = await fixture(t, { runner: fakeRunner({ code: 2, stderr: 'pg_dump: error: aborting' }) });
  const target = path.join(directory, 'manual-2026-11-10.dump');
  await fs.writeFile(target, 'previous good dump');
  await code(() => service.backup({ filename: 'manual-2026-11-10.dump' }), 'backup-failed');
  assert.equal(await fs.readFile(target, 'utf8'), 'previous good dump');
  assert.deepEqual(await fs.readdir(directory), ['manual-2026-11-10.dump']);
});

test('metadata failures are surfaced and never delete data', async t => {  const db = fakeDb({ failComplete: true });
  const { service, directory, runner } = await fixture(t, { db });
  await code(() => service.backup({}), 'backup-metadata-failed');
  assert.equal(runner.calls.length, 1);
  assert.equal(db.rows[0].status, 'running', 'an unverified dump must not be reported as completed');
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1, 'the completed dump file is preserved for manual inspection');
  assert.equal(db.calls.some(call => call.sql === SQL.expiredBackups), false);

  const insertFailing = fakeDb({ failInsert: true });
  const fixture2 = await fixture(t, { db: insertFailing, runner: fakeRunner() });
  await code(() => fixture2.service.backup({}), 'backup-metadata-failed');
  assert.equal(fixture2.runner.calls.length, 0, 'no dump is attempted without a metadata row');
});

test('missing tools, thrown runners and empty dumps fail without touching old backups', async t => {
  const oldRow = { id: 'old-1', owner_id: OWNER_ID, kind: 'scheduled', path: '/nonexistent/old.dump', bytes: 10, status: 'completed', error: null, created_at: '2026-10-01T03:00:00.000Z', completed_at: '2026-10-01T03:01:00.000Z' };
  const missingTool = await fixture(t, { db: fakeDb({ rows: [oldRow] }), runner: fakeRunner({ throws: Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' }) }) });
  await code(() => missingTool.service.backup({}), 'backup-tool-missing');
  assert.equal(missingTool.db.rows.find(row => row.id === 'old-1').status, 'completed');

  const empty = await fixture(t, { db: fakeDb({ rows: [oldRow] }), runner: fakeRunner({ writes: false }) });
  await code(() => empty.service.backup({}), 'backup-failed');
  assert.equal(empty.db.rows.find(row => row.id === 'old-1').status, 'completed');

  const directoryMissing = createBackupService({
    query: fakeDb().query,
    directory: path.join(os.tmpdir(), 'mova-backup-file-not-dir', 'x'),
    databaseUrl: DATABASE_URL,
    ownerId: OWNER_ID,
    runner: fakeRunner(),
    fs: { ...fs, mkdir: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
    env: {},
  });
  await code(() => directoryMissing.backup({}), 'backup-dir-unavailable');
});

test('backup configuration is validated up front', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mova-backup-cfg-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = { query: fakeDb().query, directory, databaseUrl: DATABASE_URL, ownerId: OWNER_ID };
  assert.throws(() => createBackupService({ ...base, retentionDays: 0 }), error => error.code === 'invalid-retention');
  assert.throws(() => createBackupService({ ...base, retentionDays: 1.5 }), error => error.code === 'invalid-retention');
  assert.throws(() => createBackupService({ ...base, directory: 'relative/dir' }), error => error.code === 'backup-dir-missing');
  assert.throws(() => createBackupService({ ...base, query: undefined }), error => error.code === 'query-required');
  const envDefaults = createBackupService({ query: fakeDb().query, directory, env: { MOVA_DB_URL: DATABASE_URL, MOVA_BACKUP_RETENTION_DAYS: '14' } });
  assert.equal(envDefaults.retentionDays, 14);
  const noUrl = createBackupService({ query: fakeDb().query, directory, env: {} });
  await code(() => noUrl.backup({}), 'database-url-missing');
  assert.throws(() => connectionEnv('mysql://user:pw@host/db'), error => error.code === 'invalid-database-url');
  assert.throws(() => connectionEnv('not a url'), error => error.code === 'invalid-database-url');
  assert.equal(connectionEnv(DATABASE_URL, {}).redactedUrl, 'postgres://mova:***@127.0.0.1:55432/mova');
  assert.equal(redact('postgres://mova:secret@host/db'), 'postgres://mova:***@host/db');
});

test('retention prunes expired files and rows only, keeping the fresh backup', async t => {
  const { service, db, directory } = await fixture(t);
  const oldFile = path.join(directory, 'old.dump');
  await fs.writeFile(oldFile, 'old');
  const expiredId = '22222222-2222-4222-8222-222222222222';
  db.rows.push({ id: expiredId, owner_id: OWNER_ID, kind: 'scheduled', path: oldFile, bytes: 3, status: 'completed', error: null, created_at: '2026-10-01T03:00:00.000Z', completed_at: '2026-10-01T03:01:00.000Z' });
  const fresh = await service.backup({ kind: 'scheduled' });
  assert.equal(db.rows.some(row => row.id === expiredId), false);
  assert.equal(db.rows.some(row => row.id === fresh.id), true);
  await assert.rejects(fs.stat(oldFile), error => error.code === 'ENOENT');
  assert.equal((await service.list())[0].id, fresh.id);
  const records = await service.list();
  assert.deepEqual(records.map(record => record.id), [fresh.id]);

  // Prune keeps the row when the file cannot be removed (non-ENOENT).
  const protectedFile = path.join(directory, 'protected.dump');
  await fs.writeFile(protectedFile, 'keep');
  db.rows.push({ id: '33333333-3333-4333-8333-333333333333', owner_id: OWNER_ID, kind: 'scheduled', path: protectedFile, bytes: 4, status: 'completed', error: null, created_at: '2026-09-01T03:00:00.000Z', completed_at: '2026-09-01T03:01:00.000Z' });
  const stubborn = createBackupService({
    query: db.query,
    directory,
    databaseUrl: DATABASE_URL,
    ownerId: OWNER_ID,
    runner: fakeRunner(),
    now: () => new Date('2026-11-10T03:00:00.000Z'),
    fs: { ...fs, unlink: async target => { if (target === protectedFile) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return fs.unlink(target); } },
    env: {},
  });
  const removed = await stubborn.prune();
  assert.deepEqual(removed, []);
  assert.equal(db.rows.some(row => row.id === '33333333-3333-4333-8333-333333333333'), true);
});

test('restore requires explicit confirmation, stop-writes and a target; never runs without them', async t => {
  const { service, db, runner } = await fixture(t);
  const record = await service.backup({});
  const token = service.restoreToken(record.id);
  assert.equal(token, `RESTORE-${record.id}`);
  assert.equal(restoreToken(record.id), token);

  await code(() => service.restore(record.id, {}), 'restore-requires-confirmation');
  await code(() => service.restore(record.id, { confirmToken: 'RESTORE-nope', stopWrites: async () => () => {} }), 'restore-requires-confirmation');
  await code(() => service.restore(record.id, { confirmToken: token }), 'restore-requires-stop-writes');
  await code(() => service.restore(record.id, { confirmToken: token, stopWrites: async () => () => {} }), 'restore-target-required');
  await code(() => service.restore(record.id, { confirmToken: token, stopWrites: async () => () => {}, restoreToNewDatabase: 'bad name!' }), 'invalid-target-database');
  await code(() => service.restore(record.id, { confirmToken: token, stopWrites: async () => () => {}, restoreToNewDatabase: 'mova_restored' }), 'restore-requires-target-url');
  await code(() => service.restore(record.id, { confirmToken: token, stopWrites: async () => () => {}, restoreToNewDatabase: 'mova_restored', targetDatabaseUrl: DATABASE_URL }), 'restore-target-is-current-database');
  await code(() => service.restore(record.id, { confirmToken: token, stopWrites: async () => () => {}, overwriteCurrent: true }), 'restore-overwrite-unconfirmed');
  assert.equal(runner.calls.length, 1, 'only pg_dump ran; no restore command was attempted');
  assert.equal(db.rows.length, 1);
});

test('restore only accepts completed backups whose file still exists', async t => {
  const { service, db, directory } = await fixture(t);
  db.rows.push({ id: 'not-done', owner_id: OWNER_ID, kind: 'manual', path: path.join(directory, 'x.dump'), bytes: null, status: 'running', error: null, created_at: '2026-11-10T03:00:00.000Z', completed_at: null });
  const token = service.restoreToken('not-done');
  const target = { confirmToken: token, stopWrites: async () => () => {}, restoreToNewDatabase: 'mova_restored', targetDatabaseUrl: 'postgres://mova:mova_local_password@127.0.0.1:55432/mova_restored' };
  await code(() => service.restore('not-done', target), 'backup-not-completed');
  await code(() => service.restore('missing', { ...target, confirmToken: service.restoreToken('missing') }), 'backup-not-found');

  const completed = await service.backup({});
  await fs.unlink(completed.path);
  await code(() => service.restore(completed.id, {
    confirmToken: service.restoreToken(completed.id),
    stopWrites: async () => () => {},
    restoreToNewDatabase: 'mova_restored',
    targetDatabaseUrl: 'postgres://mova:mova_local_password@127.0.0.1:55432/mova_restored',
  }), 'backup-file-missing');
});

test('restore to a new database is transactional, stops/resumes writes and verifies', async t => {
  const { service, runner } = await fixture(t);
  const record = await service.backup({});
  runner.calls.length = 0;
  const events = [];
  const result = await service.restore(record.id, {
    confirmToken: service.restoreToken(record.id),
    restoreToNewDatabase: 'mova_restored',
    targetDatabaseUrl: 'postgres://mova:mova_local_password@127.0.0.1:55432/mova_restored',
    stopWrites: async info => {
      events.push({ type: 'stop', info });
      return async () => events.push({ type: 'resume' });
    },
    verify: async info => {
      events.push({ type: 'verify', info });
      return { ok: true, checks: ['tables'] };
    },
  });
  assert.deepEqual(result, { restored: true, id: record.id, mode: 'new-database', database: 'mova_restored', format: 'custom', verified: true, warnings: [] });
  assert.deepEqual(events.map(event => event.type), ['stop', 'verify', 'resume']);
  assert.equal(events[0].info.mode, 'new-database');
  assert.equal(events[2].info, undefined);
  assert.equal(runner.calls.length, 1);
  const [spec] = runner.calls;
  assert.equal(spec.command, 'pg_restore');
  assert.deepEqual(spec.args, ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '--dbname', 'mova_restored', record.path]);
  assert.equal(spec.args.includes('--clean'), false, 'restore must never drop the current database');
  assert.equal(spec.args.join(' ').includes('mova_local_password'), false);
  assert.equal(spec.env.PGPASSWORD, 'mova_local_password');
  assert.equal(spec.env.PGDATABASE, 'mova_restored');
});

test('failed restore keeps current data, resumes writes and reports the error', async t => {
  const { service, runner } = await fixture(t);
  const record = await service.backup({});
  runner.calls.length = 0;
  const failingRunner = fakeRunner({ code: 1, stderr: 'pg_restore: error: could not execute query' });
  const failing = await fixture(t, {
    runner: failingRunner,
    db: fakeDb({ rows: [{ id: record.id, owner_id: OWNER_ID, kind: 'manual', path: record.path, bytes: record.bytes, status: 'completed', error: null, created_at: '2026-11-10T03:00:00.000Z', completed_at: '2026-11-10T03:01:00.000Z' }] }),
    service: { directory: path.dirname(record.path) },
  });
  let resumed = false;
  await code(() => failing.service.restore(record.id, {
    confirmToken: failing.service.restoreToken(record.id),
    restoreToNewDatabase: 'mova_restored',
    targetDatabaseUrl: 'postgres://mova:mova_local_password@127.0.0.1:55432/mova_restored',
    stopWrites: async () => async () => {
      resumed = true;
    },
    verify: async () => ({ ok: true }),
  }), 'restore-failed');
  assert.equal(resumed, true, 'writes must be resumed even when restore fails');
  assert.equal(failing.db.rows[0].status, 'completed', 'backup metadata is untouched by a failed restore');
  assert.equal(failingRunner.calls.length, 1);
});

test('restore verification failure is reported and writes resume', async t => {
  const { service, runner } = await fixture(t);
  const record = await service.backup({});
  let resumed = false;
  await code(() => service.restore(record.id, {
    confirmToken: service.restoreToken(record.id),
    overwriteCurrent: true,
    confirmOverwrite: true,
    stopWrites: async () => async () => {
      resumed = true;
    },
    verify: async () => ({ ok: false, error: 'table count mismatch' }),
  }), 'restore-verify-failed');
  assert.equal(resumed, true);
  const spec = runner.calls.at(-1);
  assert.deepEqual(spec.args.slice(0, 7), ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '--dbname']);
  assert.equal(spec.env.PGDATABASE, 'mova', 'overwrite mode targets the configured database');
  assert.equal(spec.args.includes('--clean'), true, 'explicit overwrite confirmation enables the dump-scoped clean');
});

test('restore warns instead of claiming verification when no integrity check is injected', async t => {
  const { service } = await fixture(t);
  const record = await service.backup({});
  const result = await service.restore(record.id, {
    confirmToken: service.restoreToken(record.id),
    overwriteCurrent: true,
    confirmOverwrite: true,
    stopWrites: async () => () => {},
  });
  assert.equal(result.verified, null);
  assert.deepEqual(result.warnings, ['integrity-check-skipped']);
  assert.equal(result.mode, 'overwrite-current');
});

test('restore requires stop-writes before it runs and maps stop failures', async t => {
  const { service, runner } = await fixture(t);
  const record = await service.backup({});
  runner.calls.length = 0;
  await code(() => service.restore(record.id, {
    confirmToken: service.restoreToken(record.id),
    overwriteCurrent: true,
    confirmOverwrite: true,
    stopWrites: async () => { throw new Error('worker still alive'); },
  }), 'restore-stop-failed');
  assert.equal(runner.calls.length, 0);
});

test('restore refuses a stop hook without any resume mechanism', async t => {
  const { service, runner } = await fixture(t);
  const record = await service.backup({});
  runner.calls.length = 0;
  await code(() => service.restore(record.id, {
    confirmToken: service.restoreToken(record.id),
    overwriteCurrent: true,
    confirmOverwrite: true,
    stopWrites: async () => undefined,
  }), 'restore-stop-failed');
  assert.equal(runner.calls.length, 0);
});

test('restore reports a missing restore tool distinctly', async t => {
  const { service } = await fixture(t);
  const record = await service.backup({});
  const missing = await fixture(t, {
    runner: fakeRunner({ throws: Object.assign(new Error('spawn pg_restore ENOENT'), { code: 'ENOENT' }) }),
    db: fakeDb({ rows: [{ id: record.id, owner_id: OWNER_ID, kind: 'manual', path: record.path, bytes: record.bytes, status: 'completed', error: null, created_at: '2026-11-10T03:00:00.000Z', completed_at: '2026-11-10T03:01:00.000Z' }] }),
    service: { directory: path.dirname(record.path) },
  });
  await code(() => missing.service.restore(record.id, {
    confirmToken: missing.service.restoreToken(record.id),
    overwriteCurrent: true,
    confirmOverwrite: true,
    stopWrites: async () => () => {},
  }), 'restore-tool-missing');
});

test('status never throws when metadata is unreadable and never advertises PITR', async t => {
  const db = fakeDb({ failList: true });
  const { service } = await fixture(t, { db });
  const status = await service.status();
  assert.equal(status.error, 'list failed');
  assert.equal(status.capabilities.pointInTimeRecovery, false);
  assert.equal(status.capabilities.walArchiving, false);
  assert.equal(status.backups, 0);
  assert.equal(status.lastBackup, null);
});

test('latestCompleted and list limits', async t => {
  const { service, db } = await fixture(t);
  const first = await service.backup({});
  db.rows.push({ id: 'failed-1', owner_id: OWNER_ID, kind: 'scheduled', path: '/tmp/x.dump', bytes: null, status: 'failed', error: 'boom', created_at: '2026-11-09T03:00:00.000Z', completed_at: '2026-11-09T03:01:00.000Z' });
  assert.equal((await service.latestCompleted()).id, first.id);
  assert.equal((await service.list({ limit: 1 })).length, 1);
  assert.equal((await service.list({ limit: 10_000 })).length, 2, 'out-of-range limits fall back to the default');
});
