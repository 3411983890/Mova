import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createPitrService,
  PitrError,
  PREPARE_SCRIPT,
  parseRecoveryTarget,
  hostPathFromDockerSource,
  INSPECT_SEPARATOR,
  WAL_MOUNT,
  BASE_MOUNT,
} = require('../electron/services/pitr.cjs');

const DATABASE_URL = 'postgres://mova:mova_local_password@127.0.0.1:55432/mova';
const LIVE_VOLUME = 'mova-local_mova-db-data';
const IMAGE = 'pgvector/pgvector:pg16';
const NOW = new Date('2026-11-10T13:15:21.000Z');

function logger() {
  const entries = [];
  const record = level => (message, fields) => entries.push({ level, message, fields });
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

/** Spy on the fs module so tests can prove nothing destructive happened. */
function spyFs(real = fs) {
  const destructive = [];
  return {
    destructive,
    fs: {
      ...real,
      unlink: async target => {
        destructive.push(['unlink', target]);
        return real.unlink(target);
      },
      rm: async (target, options) => {
        destructive.push(['rm', target]);
        return real.rm(target, options);
      },
      rmdir: async (target, options) => {
        destructive.push(['rmdir', target]);
        return real.rmdir(target, options);
      },
    },
  };
}

/** Fake docker. `handler(args, spec)` may return a result or undefined. */
function fakeDocker(handler) {
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    const result = await handler(spec.args ?? [], spec);
    return result ?? { code: 0, stdout: '', stderr: '' };
  };
  runner.calls = calls;
  return runner;
}

function inspectPayload({ baseDir, archiveDir, running = true, mountsOverride = null, image = IMAGE } = {}) {
  const mounts = mountsOverride ?? [
    { Type: 'volume', Name: LIVE_VOLUME, Source: '/var/lib/docker/volumes/mova-local_mova-db-data/_data', Destination: '/var/lib/postgresql/data', RW: true },
    { Type: 'bind', Name: null, Source: archiveDir, Destination: WAL_MOUNT, RW: true },
    { Type: 'bind', Name: null, Source: baseDir, Destination: BASE_MOUNT, RW: true },
  ];
  return [
    JSON.stringify({ Running: running, Status: running ? 'running' : 'exited' }),
    JSON.stringify(mounts),
    JSON.stringify({ mova_local_default: { Aliases: ['mova-db'] } }),
    image,
  ].join(INSPECT_SEPARATOR);
}

const PSQL_STDOUT = [
  'config|on|1min|replica|16MB|16.15 (Debian 16.15-1.pgdg12+2)',
  'archiver|3|0|2026-11-10 13:14:00.123456+00||000000010000000000000003',
  '',
].join('\n');

const RECOVERY_LOG = [
  '2026-11-10 13:16:11.281 UTC [1] LOG:  starting PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2)',
  '2026-11-10 13:16:11.636 UTC [29] LOG:  starting archive recovery',
  '2026-11-10 13:16:11.649 UTC [29] LOG:  consistent recovery state reached at 0/9000100',
  '2026-11-10 13:16:11.652 UTC [29] LOG:  redo starts at 0/9000028',
  '2026-11-10 13:16:12.652 UTC [29] LOG:  redo done at 0/A000100',
  '2026-11-10 13:16:12.659 UTC [29] LOG:  selected new timeline ID: 2',
  '2026-11-10 13:16:12.713 UTC [1] LOG:  database system is ready to accept connections',
  '',
].join('\n');

/** Default docker simulation: a healthy local stack with archiving on. */
function simulate({
  baseDir,
  archiveDir,
  running = true,
  archiveMode = 'on',
  mountsOverride = null,
  verifyCode = 0,
  baseBackupCode = 0,
  failAfter = null,
  psql = PSQL_STDOUT,
} = {}) {
  let baseBackups = 0;
  return fakeDocker(async args => {
    const joined = args.join(' ');
    if (args[0] === 'inspect' && args[1] === '--format') {
      return { code: 0, stdout: inspectPayload({ baseDir, archiveDir, running, mountsOverride }), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === '--type') return { code: 1, stdout: '', stderr: 'No such object' };
    if (args[0] === 'exec' && joined.includes('pg_stat_archiver')) {
      return {
        code: 0,
        stdout: archiveMode === 'on' ? psql : psql.replace('config|on|', 'config|off|'),
        stderr: '',
      };
    }
    if (args[0] === 'exec' && args.includes('pg_isready')) {
      return { code: 0, stdout: '/var/run/postgresql:5432 - accepting connections\n', stderr: '' };
    }
    if (args[0] === 'exec' && joined.includes('pg_is_in_recovery')) {
      return { code: 0, stdout: 'f|16.15 (Debian 16.15-1.pgdg12+2)\n', stderr: '' };
    }
    if (args[0] === 'logs') return { code: 0, stdout: RECOVERY_LOG, stderr: '' };
    if (args[0] === 'exec' && args.includes('sh') && joined.includes('command -v pg_verifybackup')) {
      return { code: 0, stdout: '/usr/lib/postgresql/16/bin/pg_verifybackup\n', stderr: '' };
    }
    if (args[0] === 'exec' && args.includes('sh') && joined.includes('command -v pg_waldump')) {
      return { code: 0, stdout: '/usr/lib/postgresql/16/bin/pg_waldump\n', stderr: '' };
    }
    if (args[0] === 'exec' && args.includes('mkdir')) return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'exec' && args.includes('pg_basebackup')) {
      baseBackups += 1;
      const failure = failAfter !== null && baseBackups > failAfter ? 1 : baseBackupCode;
      if (failure !== 0) return { code: failure, stdout: '', stderr: 'pg_basebackup: error: could not connect' };
      const target = args[args.indexOf('-D') + 1];
      const id = target.split('/').pop();
      const directory = path.join(baseDir, id);
      await fs.mkdir(path.join(directory, 'base'), { recursive: true });
      await fs.writeFile(path.join(directory, 'PG_VERSION'), '16\n');
      await fs.writeFile(path.join(directory, 'postgresql.conf'), '# fake\n');
      await fs.writeFile(path.join(directory, 'backup_manifest'), '{"Files":[]}\n');
      await fs.writeFile(path.join(directory, 'base', '1'), 'x'.repeat(128));
      return { code: 0, stdout: '', stderr: 'waiting for checkpoint' };
    }
    if (args[0] === 'exec' && joined.includes('pg_verifybackup')) {
      return verifyCode === 0
        ? { code: 0, stdout: 'backup successfully verified\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'pg_verifybackup: error: "base/1" checksum mismatch' };
    }
    if (args[0] === 'exec' && joined.includes('pg_waldump')) {
      return verifyCode === 0
        ? { code: 0, stdout: 'rmgr: XLOG len (rec/tot): 24/ 24 ...\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'pg_waldump: error: could not find a valid WAL record' };
    }
    if (args[0] === 'run' && args.some(value => value.endsWith(':/check'))) {
      return { code: 0, stdout: 'some-file\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mova-pitr-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backupDir = path.join(root, 'backups');
  const baseDir = path.join(backupDir, 'base');
  const archiveDir = path.join(backupDir, 'wal');
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });

  const runner = options.runner ?? simulate({ baseDir, archiveDir, ...options.simulate });
  const log = logger();
  const spy = options.spy ?? spyFs();
  const service = createPitrService({
    dockerBin: 'docker',
    container: 'mova-db',
    databaseUrl: DATABASE_URL,
    backupDir,
    runner,
    logger: log,
    fs: spy.fs,
    env: { PATH: process.env.PATH },
    now: () => NOW,
    platform: options.platform ?? 'linux',
    clock: () => 0,
    sleep: async () => {},
    ...options.service,
  });
  return { service, runner, log, root, backupDir, baseDir, archiveDir, spy };
}

async function writeWal(directory, names, { size = 16 * 1024 * 1024 } = {}) {
  for (const name of names) {
    const handle = await fs.open(path.join(directory, name), 'w');
    await handle.truncate(size);
    await handle.close();
  }
}

const code = async (fn, expected) => {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${expected} but nothing was thrown`);
  assert.ok(error instanceof PitrError, `expected PitrError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, expected, `expected code ${expected}, got ${error.code} (${error.detail ?? ''})`);
  return error;
};

test('status reads real archive files, archiver stats and capabilities', async t => {
  const { service, baseDir, archiveDir } = await fixture(t);
  await writeWal(archiveDir, ['000000010000000000000003', '000000010000000000000004']);
  await fs.writeFile(path.join(archiveDir, '00000001.history'), '1\n');

  await service.baseBackup({ label: 'first' });
  const status = await service.status();

  assert.equal(status.module, 'pitr');
  assert.equal(status.container, 'mova-db');
  assert.equal(status.containerState.running, true);
  assert.equal(status.containerState.dataVolume.name, LIVE_VOLUME);
  assert.equal(status.wal.archiveMode, 'on');
  assert.equal(status.wal.archiveTimeout, '1min');
  assert.equal(status.wal.walLevel, 'replica');
  assert.equal(status.wal.files, 3, 'two segments plus one history file');
  assert.equal(status.wal.segments, 2);
  assert.ok(status.wal.bytes > 0);
  assert.equal(status.wal.mountOk, true);
  assert.equal(status.wal.mountVerified, true);
  assert.equal(status.archiver.archivedCount, 3);
  assert.equal(status.archiver.failedCount, 0);
  assert.equal(status.baseBackupCount, 1);
  assert.equal(status.lastBaseBackup.label, 'first');
  assert.equal(status.lastBaseBackup.verified, true);
  assert.equal(status.error, null);
  assert.equal(status.baseDir, baseDir);
  assert.equal(status.archiveDir, archiveDir);

  // Files exist and archiving is configured, but no restore has been verified.
  assert.equal(status.capabilities.walArchiving, true);
  assert.equal(status.capabilities.baseBackup, true);
  assert.equal(status.capabilities.restoreToNewCluster, true);
  assert.equal(status.capabilities.pointInTimeRecovery, false);
  assert.match(status.capabilities.reasons.pointInTimeRecovery, /verified restore/);
  assert.equal(status.warnings.includes('pitr-not-verified'), true);
});

test('status is honest when archive_mode is off, the archive is empty or the mount is elsewhere', async t => {
  const off = await fixture(t, { simulate: { archiveMode: 'off' } });
  const offStatus = await off.service.status();
  assert.equal(offStatus.wal.archiveMode, 'off');
  assert.equal(offStatus.capabilities.walArchiving, false);
  assert.equal(offStatus.capabilities.pointInTimeRecovery, false);
  assert.match(offStatus.capabilities.reasons.walArchiving, /archive_mode is off/);
  assert.equal(offStatus.warnings.includes('archive-mode-off'), true);

  const empty = await fixture(t);
  const emptyStatus = await empty.service.status();
  assert.equal(emptyStatus.wal.files, 0);
  assert.equal(emptyStatus.warnings.includes('archive-empty'), true);
  assert.match(emptyStatus.capabilities.reasons.pointInTimeRecovery, /WAL archive is empty/);

  // The container mounts a different directory: archiving may work, but not
  // where this process reads, so the capability must not be claimed.
  const elsewhere = path.join(os.tmpdir(), 'mova-pitr-elsewhere');
  const wrong = await fixture(t, {
    simulate: {
      mountsOverride: [
        { Type: 'volume', Name: LIVE_VOLUME, Source: '/var/lib/docker/volumes/x/_data', Destination: '/var/lib/postgresql/data' },
        { Type: 'bind', Name: null, Source: elsewhere, Destination: WAL_MOUNT },
        { Type: 'bind', Name: null, Source: elsewhere, Destination: BASE_MOUNT },
      ],
    },
  });
  const wrongStatus = await wrong.service.status();
  assert.equal(wrongStatus.wal.mountOk, true);
  assert.equal(wrongStatus.wal.mountVerified, false);
  assert.equal(wrongStatus.capabilities.walArchiving, false);
  assert.equal(wrongStatus.capabilities.baseBackup, false);
  assert.match(wrongStatus.capabilities.reasons.walArchiving, /not the configured directory/);
  assert.equal(wrongStatus.warnings.includes('archive-mount-unverified'), true);
});

test('status never throws when docker is missing and still lists files on disk', async t => {
  const { service, baseDir, archiveDir } = await fixture(t, {
    runner: fakeDocker(async () => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    }),
  });
  await writeWal(archiveDir, ['000000010000000000000005']);
  const status = await service.status();
  assert.equal(status.docker.ok, false);
  assert.match(status.error, /docker/);
  assert.equal(status.capabilities.walArchiving, false);
  assert.equal(status.capabilities.pointInTimeRecovery, false);
  assert.equal(status.wal.files, 1, 'files on disk are still reported');
  assert.equal(status.baseDir, baseDir);
  assert.equal(status.warnings.includes('docker-inspect-failed'), true);
});

test('baseBackup builds pg_basebackup, records metadata/checksums and never overwrites', async t => {
  const { service, runner, baseDir, spy } = await fixture(t);
  const first = await service.baseBackup({ label: 'nightly' });

  assert.equal(first.id, 'base-20261110T131521Z');
  assert.equal(first.status, 'completed');
  assert.equal(first.label, 'nightly');
  assert.equal(first.format, 'plain');
  assert.equal(first.verified, true);
  assert.equal(first.verifyMethod, 'pg_verifybackup');
  assert.match(first.checksum.tree, /^[0-9a-f]{64}$/);
  assert.match(first.checksum.manifest, /^[0-9a-f]{64}$/);
  assert.ok(first.bytes > 0);
  assert.equal(first.path, path.join(baseDir, first.id));

  const baseCall = runner.calls.find(call => call.args.includes('pg_basebackup'));
  assert.deepEqual(baseCall.args.slice(0, 5), ['exec', '-u', 'postgres', 'mova-db', 'pg_basebackup']);
  assert.deepEqual(baseCall.args.slice(5, 11), ['-D', `/base-backups/${first.id}`, '-Fp', '-X', 'stream', '--manifest-checksums=SHA256']);
  assert.deepEqual(baseCall.args.slice(11, 15), ['-U', 'mova', '-c', 'fast']);
  assert.equal(baseCall.args.includes('--no-password'), true);
  assert.equal(baseCall.args.join(' ').includes('mova_local_password'), false, 'no password on a command line');

  const metadata = JSON.parse(await fs.readFile(path.join(baseDir, `${first.id}.json`), 'utf8'));
  assert.equal(metadata.status, 'completed');
  assert.equal(metadata.id, first.id);
  assert.equal(metadata.database.user, 'mova');
  assert.equal(metadata.database.host, '127.0.0.1');
  assert.equal(JSON.stringify(metadata).includes('mova_local_password'), false);

  // Same clock again: a second backup gets its own directory, the first stays.
  const second = await service.baseBackup();
  assert.equal(second.id, 'base-20261110T131521Z-2');
  const stillThere = JSON.parse(await fs.readFile(path.join(baseDir, `${first.id}.json`), 'utf8'));
  assert.equal(stillThere.checksum.tree, first.checksum.tree);
  assert.equal((await service.listBaseBackups()).length, 2);
  assert.deepEqual(spy.destructive, [], 'nothing on disk is deleted');
});

test('baseBackup failure records a failed row and leaves earlier backups intact', async t => {
  const { service, baseDir } = await fixture(t, { simulate: { failAfter: 1 } });
  const good = await service.baseBackup();

  const error = await code(() => service.baseBackup(), 'base-backup-failed');
  assert.match(error.detail, /could not connect/);

  const rows = await service.listBaseBackups();
  assert.equal(rows.length, 2);
  const failed = rows.find(row => row.id !== good.id);
  assert.equal(failed.status, 'failed');
  assert.equal(rows.find(row => row.id === good.id).status, 'completed');
  // The earlier backup is untouched.
  assert.equal((await fs.stat(path.join(baseDir, good.id, 'PG_VERSION'))).isFile(), true);
  const status = await service.status();
  assert.equal(status.baseBackupCount, 1);
  assert.equal(status.failedBaseBackupCount, 1);
});

test('baseBackup refuses to run without the base backup mount', async t => {
  const { service } = await fixture(t, {
    simulate: {
      mountsOverride: [
        { Type: 'volume', Name: LIVE_VOLUME, Source: '/var/lib/docker/volumes/x/_data', Destination: '/var/lib/postgresql/data' },
      ],
    },
  });
  const error = await code(() => service.baseBackup(), 'base-backup-mount-missing');
  assert.match(error.hint, /docker compose up -d/);
});

test('restore refuses the live volume, live port and existing containers', async t => {
  const { service, baseDir } = await fixture(t);
  const record = await service.baseBackup();

  await code(() => service.restoreToNewCluster({ baseBackupId: record.id }), 'restore-target-required');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: 'v', targetDir: 'd' }), 'restore-target-ambiguous');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: LIVE_VOLUME }), 'restore-target-is-live');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: 'mova-db' }), 'restore-target-is-live');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: 'new-volume', targetPort: 55432 }), 'restore-target-is-live-port');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: 'new-volume', targetPort: 80 }), 'invalid-target-port');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: 'bad name!' }), 'invalid-target-volume');
  await code(() => service.restoreToNewCluster({ baseBackupId: 'missing', targetVolume: 'new-volume' }), 'base-backup-not-found');
  await code(() => service.restoreToNewCluster({ baseBackupId: '../etc', targetVolume: 'new-volume' }), 'invalid-base-backup-id');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetDir: baseDir }), 'restore-target-invalid');

  const rows = await service.listBaseBackups();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, record.id);
});

test('restore refuses targets that already contain data', async t => {
  const { service, root, backupDir, baseDir, archiveDir } = await fixture(t);
  const record = await service.baseBackup();

  const nonEmpty = path.join(root, 'existing');
  await fs.mkdir(nonEmpty, { recursive: true });
  await fs.writeFile(path.join(nonEmpty, 'PG_VERSION'), '16\n');
  await code(() => service.restoreToNewCluster({ baseBackupId: record.id, targetDir: nonEmpty }), 'restore-target-not-empty');

  const occupied = await fixture(t, {
    service: { backupDir },
    simulate: { baseDir, archiveDir },
    runner: fakeDocker(async args => {
      if (args[0] === 'inspect' && args[1] === '--format') {
        return { code: 0, stdout: inspectPayload({ baseDir, archiveDir }), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '--type' && args[2] === 'volume') return { code: 0, stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'run' && args.some(value => value.endsWith(':/check'))) return { code: 0, stdout: 'CLUSTER\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }),
  });
  await code(() => occupied.service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: 'reused' }), 'restore-target-not-empty');
});

test('restore creates a new container/volume/port and verifies promotion', async t => {
  const { service, runner, log, backupDir, baseDir, archiveDir } = await fixture(t);
  await writeWal(archiveDir, ['000000010000000000000003']);
  const record = await service.baseBackup();
  const callsBefore = runner.calls.length;

  const result = await service.restoreToNewCluster({
    baseBackupId: record.id,
    recoveryTarget: { type: 'time', value: '2026-11-10T13:14:00Z' },
    targetVolume: 'mova-pitr-test',
    targetPort: 55499,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
  assert.equal(result.port, 55499);
  assert.equal(result.target.type, 'volume');
  assert.equal(result.target.value, 'mova-pitr-test');
  assert.match(result.container, /^mova-pitr-restore-/);
  assert.notEqual(result.container, 'mova-db');
  assert.equal(result.connection.port, 55499);
  assert.equal(JSON.stringify(result).includes('mova_local_password'), false);
  assert.equal(result.evidence.walReplayed, true);
  assert.deepEqual(result.recoveryTarget, { type: 'time', value: '2026-11-10T13:14:00.000Z' });

  const restoreCalls = runner.calls.slice(callsBefore);
  const prepare = restoreCalls.find(call => call.args[0] === 'run' && call.args.includes('--rm'));
  assert.ok(prepare, 'a preparation container runs');
  const prepareJoined = prepare.args.join(' ');
  assert.match(prepareJoined, /mova-pitr-test:\/target/);
  assert.ok(prepare.args.includes(`${baseDir}:/base:ro`));
  assert.ok(prepare.args.includes(`${archiveDir}:/wal:ro`));
  assert.ok(prepare.args.includes(`MOVA_PITR_SRC=/base/${record.id}`));
  assert.ok(prepare.args.includes('MOVA_PITR_TARGET_TIME=2026-11-10T13:14:00.000Z'));
  assert.ok(prepare.args.includes('MOVA_PITR_TARGET_ACTION=promote'));
  assert.ok(prepare.args.includes('MOVA_PITR_WAL=/wal'));
  assert.equal(prepare.args.at(-1), '/work/prepare.sh');

  const start = restoreCalls.find(call => call.args[0] === 'run' && call.args.includes('-d'));
  const startJoined = start.args.join(' ');
  assert.match(startJoined, /-p 127\.0\.0\.1:55499:5432/);
  assert.match(startJoined, /mova-pitr-test:\/var\/lib\/postgresql\/data/);
  assert.match(startJoined, /:\/wal:ro/);
  assert.match(startJoined, /--label mova\.pitr\.restore=/);
  assert.equal(start.args.includes('mova-db'), false, 'the live container is not started or replaced');

  const written = JSON.parse(await fs.readFile(path.join(backupDir, 'restores', result.restoreId, 'restore.json'), 'utf8'));
  assert.equal(written.status, 'completed');
  assert.equal(written.verified, true);
  assert.equal(written.port, 55499);
  assert.equal(written.live.dataVolume, LIVE_VOLUME);
  assert.equal(await fs.readFile(path.join(backupDir, 'restores', result.restoreId, 'prepare.sh'), 'utf8'), PREPARE_SCRIPT);

  // A completed, verified restore flips the capability matrix.
  const status = await service.status();
  assert.equal(status.capabilities.pointInTimeRecovery, true);
  assert.equal(status.capabilities.verifiedRestoreId, result.restoreId);
  assert.equal(status.lastRestore.status, 'completed');

  const destructive = runner.calls.filter(call => ['rm', 'stop', 'kill'].includes(call.args[0])
    || (call.args[0] === 'volume' && call.args[1] === 'rm'));
  assert.deepEqual(destructive, [], 'no container or volume is removed on success');
  assert.equal(JSON.stringify(log.entries).includes('mova_local_password'), false);
});

test('failed preparation marks the record failed and removes nothing', async t => {
  const { service, runner, backupDir, baseDir, archiveDir } = await fixture(t, {
    runner: fakeDocker(async args => {
      const joined = args.join(' ');
      if (args[0] === 'inspect' && args[1] === '--format') {
        return { code: 0, stdout: inspectPayload({ baseDir, archiveDir }), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '--type') return { code: 1, stdout: '', stderr: 'No such object' };
      if (args[0] === 'exec' && args.includes('pg_basebackup')) {
        const id = args[args.indexOf('-D') + 1].split('/').pop();
        const directory = path.join(baseDir, id);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'PG_VERSION'), '16\n');
        await fs.writeFile(path.join(directory, 'backup_manifest'), '{}\n');
        await fs.writeFile(path.join(directory, 'postgresql.conf'), 'x\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'exec' && joined.includes('command -v pg_verifybackup')) {
        return { code: 0, stdout: '/usr/lib/postgresql/16/bin/pg_verifybackup\n', stderr: '' };
      }
      if (args[0] === 'run' && args.includes('--rm')) {
        return { code: 1, stdout: '', stderr: 'cp: cannot create regular file: Permission denied' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
  });
  const record = await service.baseBackup();
  const error = await code(
    () => service.restoreToNewCluster({ baseBackupId: record.id, targetVolume: 'mova-pitr-fail', targetPort: 55497 }),
    'restore-failed',
  );
  assert.equal(error.hint, 'the live database was not touched');

  assert.deepEqual(runner.calls.filter(call => call.args[0] === 'rm'), [], 'nothing is removed when preparation fails');
  const dirs = await fs.readdir(path.join(backupDir, 'restores'));
  assert.equal(dirs.length, 1);
  const failed = JSON.parse(await fs.readFile(path.join(backupDir, 'restores', dirs[0], 'restore.json'), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.verified, false);
  assert.match(failed.error, /Permission denied/);

  const status = await service.status();
  assert.equal(status.capabilities.pointInTimeRecovery, false, 'a failed restore never proves PITR');
});

test('verifyArchive is structural by default and only verified after pg_waldump', async t => {
  const { service, archiveDir } = await fixture(t);
  await writeWal(archiveDir, ['000000010000000000000003'], { size: 16 * 1024 * 1024 });

  const structural = await service.verifyArchive();
  assert.equal(structural.verified, false);
  assert.equal(structural.method, 'structure-only');
  assert.equal(structural.file, '000000010000000000000003');
  assert.equal(structural.bytes, 16 * 1024 * 1024);
  assert.equal(structural.warnings.includes('deep-verification-not-run'), true);

  const deep = await service.verifyArchive({ deep: true });
  assert.equal(deep.verified, true);
  assert.equal(deep.method, 'pg_waldump');

  const truncated = await fixture(t);
  await writeWal(truncated.archiveDir, ['000000010000000000000004'], { size: 4096 });
  const bad = await truncated.service.verifyArchive({ deep: true });
  assert.equal(bad.verified, false);
  assert.match(bad.error, /multiple of 16777216/);
  assert.equal(bad.warnings.includes('segment-size-mismatch'), true);

  const empty = await fixture(t);
  const none = await empty.service.verifyArchive();
  assert.equal(none.verified, false);
  assert.equal(none.files, 0);
  assert.equal(none.warnings.includes('archive-empty'), true);
});

test('recovery targets are validated instead of silently ignored', () => {
  assert.deepEqual(parseRecoveryTarget(undefined), null);
  assert.deepEqual(parseRecoveryTarget('2026-11-10T13:14:00Z'), { type: 'time', value: '2026-11-10T13:14:00.000Z' });
  assert.deepEqual(parseRecoveryTarget({ type: 'name', value: 'before_migration' }), { type: 'name', value: 'before_migration' });
  assert.deepEqual(parseRecoveryTarget({ type: 'lsn', value: '0/3f3f950' }), { type: 'lsn', value: '0/3F3F950' });
  assert.deepEqual(parseRecoveryTarget({ type: 'immediate' }), { type: 'immediate', value: null });
  assert.throws(() => parseRecoveryTarget('yesterday'), error => error.code === 'invalid-recovery-target');
  assert.throws(() => parseRecoveryTarget({ type: 'name', value: 'bad name' }), error => error.code === 'invalid-recovery-target');
  assert.throws(() => parseRecoveryTarget({ type: 'lsn', value: 'nope' }), error => error.code === 'invalid-recovery-target');
  assert.throws(() => parseRecoveryTarget({ type: 'xid', value: '1' }), error => error.code === 'invalid-recovery-target');
});

test('docker desktop mount sources map back to host paths', () => {
  assert.equal(
    hostPathFromDockerSource('/run/desktop/mnt/host/c/Users/x/.mova-backups/wal', 'win32'),
    'C:\\Users\\x\\.mova-backups\\wal',
  );
  assert.equal(hostPathFromDockerSource('/host_mnt/d/tmp/mova', 'win32'), 'D:\\tmp\\mova');
  assert.equal(hostPathFromDockerSource('/home/user/mova/wal', 'linux'), '/home/user/mova/wal');
  assert.equal(hostPathFromDockerSource('', 'win32'), '');
});

// ---------------------------------------------------------------------------
// CLI: flag parsing (`--flag=value` and `--flag value`), exit codes, redaction.
// ---------------------------------------------------------------------------

function cliHarness(overrides = {}) {
  const out = [];
  const err = [];
  const seen = [];
  const createService = options => {
    seen.push(options);
    return {
      baseDir: path.join(options.backupDir, 'base'),
      status: async () => ({
        module: 'pitr',
        container: 'mova-db',
        backupDir: options.backupDir,
        baseDir: path.join(options.backupDir, 'base'),
        archiveDir: path.join(options.backupDir, 'wal'),
        database: 'postgres://mova:***@127.0.0.1:55432/mova',
        docker: { ok: true, error: null },
        containerState: { running: true, image: IMAGE, dataVolume: { name: LIVE_VOLUME }, mounts: {}, network: 'x' },
        wal: {
          files: 3, bytes: 1024, archiveMode: 'on', archiveTimeout: '1min', walLevel: 'replica',
          segmentSize: '16MB', mountOk: true, mountVerified: true, latestAt: '2026-11-10T13:14:00.000Z',
        },
        archiver: { archivedCount: 3, failedCount: 0, lastArchivedAt: '2026-11-10T13:14:00.000Z' },
        baseBackupCount: 1,
        failedBaseBackupCount: 0,
        lastBaseBackup: { id: 'base-1', bytes: 2048, verified: true },
        restores: [],
        lastRestore: null,
        capabilities: { walArchiving: true, pointInTimeRecovery: true, baseBackup: true, restoreToNewCluster: true, reasons: {} },
        warnings: [],
        error: null,
        ...overrides.status,
      }),
      baseBackup: async input => ({
        id: 'base-1', status: 'completed', path: '/x', bytes: 10, fileCount: 2,
        checksum: { tree: 'abc' }, verified: true, createdAt: NOW.toISOString(), label: input?.label ?? null,
        ...overrides.backup,
      }),
      listBaseBackups: async () => [{ id: 'base-1', status: 'completed', verified: true, bytes: 10, createdAt: NOW.toISOString() }],
      verifyArchive: async () => ({
        file: '000000010000000000000003', archiveDir: '/wal', files: 1, bytes: 10,
        verified: false, method: 'structure-only', warnings: ['deep-verification-not-run'],
      }),
      restoreToNewCluster: async input => {
        seen.push({ restore: input });
        if (overrides.restoreThrows) throw overrides.restoreThrows;
        return {
          restoreId: 'restore-1',
          status: 'completed',
          verified: true,
          baseBackupId: input.baseBackupId,
          container: 'mova-pitr-restore-1',
          port: input.targetPort ?? 55433,
          target: input.targetVolume
            ? { type: 'volume', value: input.targetVolume }
            : { type: 'dir', value: input.targetDir },
          recoveryTarget: input.recoveryTarget ?? null,
          connection: { redactedUrl: 'postgres://mova@127.0.0.1:55433/mova', passwordHint: 'use MOVA_DB_PASSWORD' },
          evidence: {
            log: {
              archiveRecovery: true, consistentRecovery: true, replayStarted: true,
              redoDone: true, targetReached: true, timelineSwitched: true,
            },
          },
          warnings: [],
        };
      },
      ...overrides.service,
    };
  };
  return { out, err, seen, createService };
}

async function runCliWith(harness, argv, env = {}) {
  const { runCli } = await import('../scripts/pitr.mjs');
  return runCli({
    argv,
    env: { MOVA_DB_URL: DATABASE_URL, MOVA_BACKUPS_DIR: path.join(os.tmpdir(), 'mova-pitr-cli'), ...env },
    cwd: os.tmpdir(),
    stdout: text => harness.out.push(text),
    stderr: text => harness.err.push(text),
    createService: harness.createService,
  });
}

test('CLI accepts --flag=value and --flag value identically', async () => {
  const equals = cliHarness();
  assert.equal(await runCliWith(equals, ['restore', '--base=base-20261110T131521Z', '--target=mova-pitr-cli', '--volume', '--port=55499']), 0);
  const callA = equals.seen.find(entry => entry.restore)?.restore;
  assert.equal(callA.baseBackupId, 'base-20261110T131521Z');
  assert.equal(callA.targetVolume, 'mova-pitr-cli');
  assert.equal(callA.targetDir, undefined);
  assert.equal(callA.targetPort, 55499);

  const spaced = cliHarness();
  assert.equal(await runCliWith(spaced, ['restore', '--base', 'base-20261110T131521Z', '--target', 'mova-pitr-cli', '--volume', '--port', '55499']), 0);
  const callB = spaced.seen.find(entry => entry.restore)?.restore;
  assert.deepEqual(callB, callA, 'both syntaxes produce the same request');

  const dir = cliHarness();
  assert.equal(await runCliWith(dir, ['restore', '--base=base-1', '--target=./restored', '--dir', '--at=2026-11-10T13:14:00Z']), 0);
  const callC = dir.seen.find(entry => entry.restore)?.restore;
  assert.equal(callC.targetDir, path.resolve(os.tmpdir(), 'restored'));
  assert.deepEqual(callC.recoveryTarget, { type: 'time', value: '2026-11-10T13:14:00.000Z' });
  assert.equal(callC.targetPort, undefined, 'the service picks the default port');

  const immediate = cliHarness();
  assert.equal(await runCliWith(immediate, ['restore', '--base=base-1', '--target=v', '--volume', '--immediate']), 0);
  assert.deepEqual(immediate.seen.find(entry => entry.restore)?.restore.recoveryTarget, { type: 'immediate' });

  const backup = cliHarness();
  assert.equal(await runCliWith(backup, ['base-backup', '--label=before-upgrade']), 0);
  assert.equal(backup.seen[0].databaseUrl, DATABASE_URL, 'the service gets the configured URL');
  assert.match(backup.out.join(''), /base-1/);
});

test('CLI usage errors exit 2 and runtime failures exit 1', async () => {
  const harness = cliHarness();
  assert.equal(await runCliWith(harness, ['restore', '--target=v']), 2, 'missing --base');
  assert.equal(await runCliWith(harness, ['restore', '--base=b']), 2, 'missing --target');
  assert.equal(await runCliWith(harness, ['restore', '--base=b', '--target=v', '--at=2026-11-10T00:00:00Z', '--immediate']), 2, 'two targets');
  assert.equal(await runCliWith(harness, ['status', '--port=1']), 2, 'flag not valid for the command');
  assert.equal(await runCliWith(harness, ['nonsense']), 2, 'unknown command');
  assert.equal(await runCliWith(harness, []), 2, 'missing command');
  assert.equal(await runCliWith(harness, ['status', '--dir', '--volume']), 2, 'conflicting target flags');

  const strict = cliHarness({
    status: { capabilities: { walArchiving: true, pointInTimeRecovery: false, baseBackup: true, restoreToNewCluster: true, reasons: {} } },
  });
  assert.equal(await runCliWith(strict, ['status', '--strict']), 1, 'strict fails when PITR is unproven');
  assert.equal(await runCliWith(cliHarness(), ['status', '--strict']), 0);

  const noDocker = cliHarness({ status: { docker: { ok: false, error: 'docker unavailable' }, error: 'docker unavailable' } });
  assert.equal(await runCliWith(noDocker, ['status']), 1, 'unreachable docker is a runtime failure');

  const refused = cliHarness({
    restoreThrows: new PitrError('restore-target-is-live', LIVE_VOLUME, 'never restore into the live volume'),
  });
  assert.equal(await runCliWith(refused, ['restore', '--base=base-1', '--target=' + LIVE_VOLUME, '--volume']), 1);
  assert.match(refused.err.join('\n'), /restore-target-is-live/);
  assert.match(refused.err.join('\n'), /never restore into the live volume/);
});

test('CLI redacts secrets and emits parseable JSON', async () => {
  const leaky = cliHarness({
    restoreThrows: new PitrError('restore-failed', 'connection to server failed: password=mova_local_password'),
  });
  assert.equal(await runCliWith(leaky, ['restore', '--base=b', '--target=v', '--volume']), 1);
  assert.equal(leaky.err.join('\n').includes('mova_local_password'), false, 'stderr must be redacted');

  const json = cliHarness();
  assert.equal(await runCliWith(json, ['status', '--json']), 0);
  const payload = JSON.parse(json.out.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.module, 'pitr');
  assert.equal(payload.action, 'status');
  assert.equal(payload.value.capabilities.pointInTimeRecovery, true);

  const jsonError = cliHarness({ restoreThrows: new PitrError('restore-target-not-empty', '/tmp/x is not empty') });
  assert.equal(await runCliWith(jsonError, ['restore', '--base=b', '--target=/tmp/x', '--dir', '--json']), 1);
  const errorPayload = JSON.parse(jsonError.out.join(''));
  assert.equal(errorPayload.ok, false);
  assert.equal(errorPayload.code, 'restore-target-not-empty');
});
