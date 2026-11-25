import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checksumSql,
  migrationStatus,
  parseMigrateArgs,
  runCli as runMigrateCli,
  runMigrations,
  sortMigrationFiles,
} from '../scripts/db-migrate.mjs';
import {
  createServicesManager,
  parseServiceArgs,
  redactSecrets,
  runCli as runServicesCli,
} from '../scripts/services.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const ENV_EXAMPLE = readFileSync(path.join(ROOT, '.env.example'), 'utf8');

function serviceBlock(yaml, name) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing service ${name}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[index]) || /^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function serviceNames(yaml) {
  const section = yaml.split(/^services:\s*$/m)[1]?.split(/^volumes:\s*$/m)[0] ?? '';
  return [...section.matchAll(/^ {2}([A-Za-z0-9_.-]+):\s*$/gm)].map((match) => match[1]);
}

function publishedPorts(block) {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'ports:');
  if (start === -1) return [];
  const ports = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s+-\s+"([^"]+)"/);
    if (match) ports.push(match[1]);
    else if (lines[index].trim() && !lines[index].trim().startsWith('#')) break;
  }
  return ports;
}

function parseEnvExample(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return values;
}

// ---------------------------------------------------------------------------
// docker-compose contract
// ---------------------------------------------------------------------------

test('docker-compose declares the required services, loopback ports, volumes, and healthchecks', () => {
  const names = serviceNames(COMPOSE);
  for (const required of ['mova-db', 'mova-redis', 'mova-minio']) {
    assert.ok(names.includes(required), `missing service ${required}`);
  }
  assert.equal(names.length, 3, `unexpected extra services: ${names.join(', ')}`);
  assert.doesNotMatch(COMPOSE, /mova-minio-init|minio\/mc/);

  const db = serviceBlock(COMPOSE, 'mova-db');
  assert.match(db, /image:\s*pgvector\/pgvector:pg16/);
  assert.ok(db.includes('127.0.0.1:${MOVA_DB_PORT:-55432}:5432'));
  assert.match(db, /^\s+healthcheck:\s*$/m);
  assert.match(db, /pg_isready/);
  assert.ok(db.includes('mova-db-data:/var/lib/postgresql/data'));
  assert.ok(db.includes('POSTGRES_DB: ${MOVA_DB_NAME:-mova}'));
  assert.ok(db.includes('POSTGRES_USER: ${MOVA_DB_USER:-mova}'));
  assert.ok(db.includes('POSTGRES_PASSWORD: ${MOVA_DB_PASSWORD:-mova_local_password}'));

  const redis = serviceBlock(COMPOSE, 'mova-redis');
  assert.match(redis, /image:\s*redis:7-alpine/);
  assert.ok(redis.includes('127.0.0.1:${MOVA_REDIS_PORT:-56379}:6379'));
  assert.equal(publishedPorts(redis).length, 1);
  assert.ok(redis.includes('--appendonly'));
  assert.ok(redis.includes('"yes"'));
  assert.match(redis, /^\s+healthcheck:\s*$/m);
  assert.ok(redis.includes('redis-cli'));

  const minio = serviceBlock(COMPOSE, 'mova-minio');
  assert.match(minio, /image:\s*\$\{MOVA_MINIO_IMAGE:-bitnamilegacy\/minio:latest\}/);
  assert.ok(minio.includes('127.0.0.1:${MOVA_MINIO_PORT:-59090}:9000'));
  assert.ok(minio.includes('127.0.0.1:${MOVA_MINIO_CONSOLE_PORT:-59091}:9001'));
  assert.equal(publishedPorts(minio).length, 2);
  assert.match(minio, /^\s+healthcheck:\s*$/m);
  assert.ok(minio.includes('curl", "-f", "http://127.0.0.1:9000/minio/health/live"'));
  assert.ok(minio.includes('MINIO_ROOT_USER: ${MOVA_S3_ACCESS_KEY:-mova}'));
  assert.ok(minio.includes('MINIO_ROOT_PASSWORD: ${MOVA_S3_SECRET_KEY:-mova_local_password}'));
  assert.ok(minio.includes('MINIO_DEFAULT_BUCKETS: ${MOVA_S3_BUCKET:-mova-artifacts}'));
  assert.ok(minio.includes('mova-minio-data:/bitnami/minio/data'));

  for (const name of ['mova-db', 'mova-redis', 'mova-minio']) {
    const ports = publishedPorts(serviceBlock(COMPOSE, name));
    assert.ok(ports.length > 0, `${name} publishes no ports`);
    for (const port of ports) assert.ok(port.startsWith('127.0.0.1:'), `${name} exposes ${port}`);
  }
  assert.doesNotMatch(COMPOSE, /0\.0\.0\.0/);
});

// MinIO host ports are 59090/59091 instead of the contract's 59000/59001:
// Windows reserves 58986-59085 on this machine, so 59000/59001 cannot bind.
test('.env.example matches the service contract and compose defaults', () => {
  const env = parseEnvExample(ENV_EXAMPLE);
  const contract = {
    MOVA_MODE: 'postgres',
    MOVA_DB_URL: 'postgres://mova:mova_local_password@127.0.0.1:55432/mova',
    MOVA_REDIS_URL: 'redis://127.0.0.1:56379',
    MOVA_S3_ENDPOINT: 'http://127.0.0.1:59090',
    MOVA_S3_REGION: 'us-east-1',
    MOVA_S3_BUCKET: 'mova-artifacts',
    MOVA_S3_ACCESS_KEY: 'mova',
    MOVA_S3_SECRET_KEY: 'mova_local_password',
    MOVA_AUTOSTART_SERVICES: 'true',
    MOVA_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
    MOVA_EMBEDDING_DIM: '384',
    MOVA_BACKUP_RETENTION_DAYS: '30',
  };
  for (const [key, value] of Object.entries(contract)) {
    assert.equal(env[key], value, `${key} drifted from Mova服务版接口约定.md`);
  }
  for (const key of ['MOVA_EMBEDDING_CACHE_DIR', 'MOVA_HF_ENDPOINT', 'MOVA_BACKUP_DIR']) {
    assert.ok(Object.hasOwn(env, key), `missing ${key}`);
  }

  for (const key of [
    'MOVA_DB_PORT',
    'MOVA_DB_NAME',
    'MOVA_DB_USER',
    'MOVA_DB_PASSWORD',
    'MOVA_REDIS_PORT',
    'MOVA_MINIO_PORT',
    'MOVA_MINIO_CONSOLE_PORT',
    'MOVA_S3_ACCESS_KEY',
    'MOVA_S3_SECRET_KEY',
    'MOVA_S3_BUCKET',
    'MOVA_MINIO_IMAGE',
  ]) {
    assert.ok(env[key], `${key} has no local default in .env.example`);
    assert.ok(COMPOSE.includes(`:-${env[key]}}`), `compose does not use ${key} default`);
  }

  const secretPatterns = /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  assert.doesNotMatch(ENV_EXAMPLE, secretPatterns);
  assert.doesNotMatch(COMPOSE, secretPatterns);
});

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

function fakeDatabase({ ledgerExists = true, failOn = null } = {}) {
  const state = {
    ledger: new Map(),
    queries: [],
    ended: false,
    ledgerCreated: false,
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql).trim();
      state.queries.push({ sql: text, params });
      if (/^create table if not exists mova_migrations/i.test(text)) {
        state.ledgerCreated = true;
        return { rows: [] };
      }
      if (/^select filename, checksum, applied_at from mova_migrations/i.test(text)) {
        if (!ledgerExists) {
          const error = new Error('relation "mova_migrations" does not exist');
          error.code = '42P01';
          throw error;
        }
        return {
          rows: [...state.ledger.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([filename, value]) => ({
              filename,
              checksum: value.checksum,
              applied_at: value.appliedAt ?? null,
            })),
        };
      }
      if (/^insert into mova_migrations/i.test(text)) {
        state.ledger.set(params[0], { checksum: params[1], duration: params[2] });
        return { rowCount: 1, rows: [] };
      }
      if (/^select pg_advisory_(lock|unlock)\(\$1\)/i.test(text)) return { rows: [] };
      if (/^(begin|commit|rollback)$/i.test(text)) return { rows: [] };
      if (failOn && text.includes(failOn)) throw new Error(`simulated SQL failure at ${failOn}`);
      return { rows: [] };
    },
    async end() {
      state.ended = true;
    },
  };
  return { client, state };
}

async function withMigrationDir(files, callback) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mova-migrations-'));
  try {
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(dir, name), sql, 'utf8');
    }
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIGRATION_FILES = {
  '10_tenth.sql': 'create table tenth_marker (id int);',
  '2_second.sql': 'create table second_marker (id int);',
  '1_first.sql': 'create table first_marker (id int);',
  'README.md': 'not a migration',
};

test('migrations run in natural filename order and are recorded in the ledger', async () => {
  await withMigrationDir(MIGRATION_FILES, async (dir) => {
    let tick = 0;
    const database = fakeDatabase();
    const result = await runMigrations({
      dir,
      env: { MOVA_DB_URL: 'postgres://mova:secret@127.0.0.1:55432/mova' },
      connect: async () => database.client,
      now: () => {
        tick += 25;
        return tick;
      },
    });

    assert.deepEqual(result.applied, ['1_first.sql', '2_second.sql', '10_tenth.sql']);
    assert.equal(result.alreadyApplied, 0);
    assert.equal(database.state.ledger.size, 3);
    const order = database.state.queries
      .map((query) => query.sql)
      .filter((sql) => /create table (first|second|tenth)_marker/.test(sql));
    assert.deepEqual(order, [
      'create table first_marker (id int);',
      'create table second_marker (id int);',
      'create table tenth_marker (id int);',
    ]);
    for (const entry of database.state.ledger.values()) {
      assert.match(entry.checksum, /^[a-f0-9]{64}$/);
      assert.ok(entry.duration >= 0);
    }

    const rerun = await runMigrations({
      dir,
      env: { MOVA_DB_URL: 'postgres://mova:secret@127.0.0.1:55432/mova' },
      connect: async () => database.client,
    });
    assert.deepEqual(rerun.applied, []);
    assert.equal(rerun.alreadyApplied, 3);
  });
});

test('migrations are immutable: changed checksum fails before anything is applied', async () => {
  await withMigrationDir(MIGRATION_FILES, async (dir) => {
    const database = fakeDatabase();
    const env = { MOVA_DB_URL: 'postgres://mova:secret@127.0.0.1:55432/mova' };
    await runMigrations({ dir, env, connect: async () => database.client });
    await writeFile(path.join(dir, '2_second.sql'), 'create table second_marker (id bigint);', 'utf8');

    await assert.rejects(
      runMigrations({ dir, env, connect: async () => database.client }),
      (error) => {
        assert.equal(error.code, 'migration_changed');
        assert.match(error.message, /2_second\.sql/);
        assert.match(error.message, /immutable/);
        return true;
      },
    );
  });
});

test('a failing migration rolls back its transaction and blocks later files', async () => {
  await withMigrationDir(
    {
      '1_first.sql': 'create table first_marker (id int);',
      '2_second.sql': 'create table boom_marker (id int);',
      '3_third.sql': 'create table third_marker (id int);',
    },
    async (dir) => {
      const database = fakeDatabase({ failOn: 'boom_marker' });
      await assert.rejects(
        runMigrations({
          dir,
          env: { MOVA_DB_URL: 'postgres://mova:secret@127.0.0.1:55432/mova' },
          connect: async () => database.client,
        }),
        (error) => {
          assert.equal(error.code, 'migration_failed');
          assert.match(error.message, /2_second\.sql/);
          assert.match(error.message, /rolled back/);
          return true;
        },
      );

      assert.deepEqual([...database.state.ledger.keys()], ['1_first.sql']);
      assert.ok(database.state.queries.some((query) => /^rollback$/i.test(query.sql)));
      assert.equal(
        database.state.queries.filter((query) => query.sql.includes('third_marker')).length,
        0,
      );
    },
  );
});

test('migration --status reads the ledger without creating or writing anything', async () => {
  await withMigrationDir(
    {
      '1_first.sql': 'create table first_marker (id int);',
      '2_second.sql': 'create table second_marker (id int);',
      '3_third.sql': 'create table third_marker (id int);',
    },
    async (dir) => {
      const database = fakeDatabase();
      database.state.ledger.set('1_first.sql', {
        checksum: checksumSql('create table first_marker (id int);'),
        appliedAt: '2026-01-01T00:00:00.000Z',
      });
      const result = await migrationStatus({
        dir,
        env: { MOVA_DB_URL: 'postgres://mova:secret@127.0.0.1:55432/mova' },
        connect: async () => database.client,
      });

      assert.equal(result.ledger, 'ok');
      assert.deepEqual(result.applied, ['1_first.sql']);
      assert.deepEqual(result.pending, ['2_second.sql', '3_third.sql']);
      assert.equal(result.ok, true);
      assert.ok(!database.state.queries.some((query) => /^create table/i.test(query.sql)));
      assert.ok(!database.state.queries.some((query) => /^(insert|begin|commit|rollback)/i.test(query.sql)));
    },
  );
});

test('migration --status reports a missing ledger and checksum mismatches', async () => {
  await withMigrationDir(MIGRATION_FILES, async (dir) => {
    const env = { MOVA_DB_URL: 'postgres://mova:secret@127.0.0.1:55432/mova' };
    const missing = await migrationStatus({
      dir,
      env,
      connect: async () => fakeDatabase({ ledgerExists: false }).client,
    });
    assert.equal(missing.ledger, 'missing');
    assert.deepEqual(missing.applied, []);
    assert.deepEqual(missing.pending, ['1_first.sql', '2_second.sql', '10_tenth.sql']);

    const changedDatabase = fakeDatabase();
    changedDatabase.state.ledger.set('1_first.sql', { checksum: 'deadbeef', appliedAt: null });
    const changed = await migrationStatus({
      dir,
      env,
      connect: async () => changedDatabase.client,
    });
    assert.equal(changed.ok, false);
    assert.deepEqual(changed.changed, ['1_first.sql']);

    const missingFileDatabase = fakeDatabase();
    missingFileDatabase.state.ledger.set('99_removed.sql', { checksum: 'abc', appliedAt: null });
    const removed = await migrationStatus({
      dir,
      env,
      connect: async () => missingFileDatabase.client,
    });
    assert.equal(removed.ok, false);
    assert.deepEqual(removed.missing, ['99_removed.sql']);
  });
});

test('missing migration directory fails before connecting and connection errors are redacted', async () => {
  let connected = false;
  await assert.rejects(
    runMigrations({
      dir: path.join(tmpdir(), `mova-missing-${process.pid}-${Date.now()}`),
      env: { MOVA_DB_URL: 'postgres://mova:secret@127.0.0.1:55432/mova' },
      connect: async () => {
        connected = true;
        return fakeDatabase().client;
      },
    }),
    (error) => error.code === 'migrations_dir_missing',
  );
  assert.equal(connected, false);

  await withMigrationDir(MIGRATION_FILES, async (dir) => {
    await assert.rejects(
      runMigrations({
        dir,
        env: {
          MOVA_DB_URL: 'postgres://mova:top-secret-pw@127.0.0.1:55432/mova',
        },
        connect: async () => {
          throw new Error('password authentication failed for postgres://mova:top-secret-pw@127.0.0.1:55432/mova');
        },
      }),
      (error) => {
        assert.equal(error.code, 'connect_failed');
        assert.doesNotMatch(error.message, /top-secret-pw/);
        assert.match(error.message, /\*\*\*/);
        return true;
      },
    );
  });
});

test('the migration CLI rejects destructive resets and returns usage exit code 2', async () => {
  assert.throws(() => parseMigrateArgs(['--reset']), (error) => error.code === 'usage');
  let stdout = '';
  let stderr = '';
  const code = await runMigrateCli({
    argv: ['--reset'],
    cwd: ROOT,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /not supported/);
  assert.match(stderr, /Usage:/);
});

test('sortMigrationFiles uses natural numeric ordering', () => {
  assert.deepEqual(sortMigrationFiles(['10_c.sql', '2_b.sql', '1_a.sql']), [
    '1_a.sql',
    '2_b.sql',
    '10_c.sql',
  ]);
});

// ---------------------------------------------------------------------------
// services.mjs: injected Docker runner / clock / fs
// ---------------------------------------------------------------------------

const TEST_CWD = path.join(tmpdir(), 'mova-services-fixture');
const COMPOSE_FILE = path.join(TEST_CWD, 'docker-compose.yml');

function testEnv(overrides = {}) {
  return {
    MOVA_AUTOSTART_SERVICES: 'true',
    MOVA_SERVICE_POLL_MS: '2000',
    MOVA_DOCKER_START_TIMEOUT_MS: '10000',
    MOVA_SERVICE_HEALTH_TIMEOUT_MS: '10000',
    MOVA_DB_PASSWORD: 'db-password-for-test',
    MOVA_S3_SECRET_KEY: 's3-password-for-test',
    MOVA_DOCKER_DESKTOP_PATH: 'C:\\Fake\\Docker Desktop.exe',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    ...overrides,
  };
}

function createClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    sleep: async (ms) => {
      value += ms;
    },
  };
}

function createRunner(handler) {
  const calls = [];
  const run = async (command, args = [], options = {}) => {
    const call = { command, args, options };
    calls.push(call);
    const response = await handler(call);
    return { code: 0, stdout: '', stderr: '', ...(response ?? {}) };
  };
  return { calls, run };
}

function psOutput({ db = 'healthy', redis = 'healthy', minio = 'healthy' } = {}) {
  return JSON.stringify([
    { Service: 'mova-db', State: 'running', Health: db },
    { Service: 'mova-redis', State: 'running', Health: redis },
    { Service: 'mova-minio', State: 'running', Health: minio },
  ]);
}

function healthyHandler({ onUp, onDown } = {}) {
  return ({ args }) => {
    if (args[0] === '--version') return { code: 0, stdout: 'Docker version 28.0.0, build test\n' };
    if (args[0] === 'info') return { code: 0, stdout: '28.0.0\n' };
    if (args.includes('ps')) return { code: 0, stdout: psOutput() };
    if (args.includes('up') && onUp) onUp();
    if (args.includes('down') && onDown) onDown();
    return { code: 0, stdout: '' };
  };
}

function makeManager({ env = testEnv(), runner, clock = createClock(), fs = { existsSync: () => true }, logger, migrate } = {}) {
  return createServicesManager({
    env,
    cwd: TEST_CWD,
    platform: 'win32',
    run: runner.run,
    fs,
    now: clock.now,
    sleep: clock.sleep,
    logger,
    migrate:
      migrate ??
      (async () => ({ ok: true, applied: [], alreadyApplied: 0, database: 'postgres://mova@127.0.0.1:55432/mova' })),
  });
}

test('status probes Docker and generates the expected compose ps command', async () => {
  const runner = createRunner(healthyHandler());
  const manager = makeManager({ runner });
  const result = await manager.status();

  assert.equal(result.ok, true);
  assert.equal(result.docker.cli, 'ok');
  assert.equal(result.docker.daemon, 'up');
  assert.equal(result.docker.desktop.installed, true);
  assert.deepEqual(
    result.services.map((service) => [service.name, service.state, service.health]),
    [
      ['mova-db', 'running', 'healthy'],
      ['mova-redis', 'running', 'healthy'],
      ['mova-minio', 'running', 'healthy'],
    ],
  );

  const versionCall = runner.calls.find((call) => call.args[0] === '--version');
  const infoCall = runner.calls.find((call) => call.args[0] === 'info');
  const psCall = runner.calls.find((call) => call.args.includes('ps'));
  assert.ok(versionCall);
  assert.ok(infoCall);
  assert.deepEqual(psCall.args, [
    'compose',
    '-p',
    'mova-local',
    '-f',
    COMPOSE_FILE,
    'ps',
    '-a',
    '--format',
    'json',
  ]);
  const childPathKey = Object.keys(psCall.options.env).find((key) => key.toLowerCase() === 'path');
  assert.ok(childPathKey, 'compose child process must inherit PATH');
  assert.match(psCall.options.env[childPathKey], /Docker[\\/]Docker[\\/]resources[\\/]bin/i);
  assert.doesNotMatch(JSON.stringify(result), /db-password-for-test|s3-password-for-test/);
});

test('up starts compose, waits for health, respects the migration switch, and keeps the daemon untouched', async () => {
  const events = [];
  const runner = createRunner(healthyHandler({ onUp: () => events.push('up') }));
  const clock = createClock();
  const migrateCalls = [];
  const manager = makeManager({
    runner,
    clock,
    migrate: async () => {
      migrateCalls.push('migrate');
      return { ok: true, applied: ['001_init.sql'], alreadyApplied: 0, database: 'postgres://mova@127.0.0.1:55432/mova' };
    },
  });

  const result = await manager.up({ migrate: true, timeoutMs: 10_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.migrations.applied, ['001_init.sql']);
  assert.deepEqual(migrateCalls, ['migrate']);
  assert.deepEqual(events, ['up']);
  const upCall = runner.calls.find((call) => call.args.includes('up'));
  assert.deepEqual(upCall.args.slice(-2), ['up', '-d']);
  assert.ok(!runner.calls.some((call) => call.options.detached));

  const noMigrateCalls = [];
  const second = await makeManager({
    runner,
    clock,
    migrate: async () => {
      noMigrateCalls.push('migrate');
      return { ok: true, applied: [] };
    },
  }).up({ migrate: false, timeoutMs: 10_000 });
  assert.equal(second.ok, true);
  assert.equal(second.migrations, null);
  assert.deepEqual(noMigrateCalls, []);
});

test('ensure autostarts Docker Desktop, waits for the daemon, then runs compose up and migrations', async () => {
  let daemonUp = false;
  let psCalls = 0;
  const events = [];
  const runner = createRunner(({ args, options }) => {
    if (options.detached) {
      events.push('desktop');
      daemonUp = true;
      return { code: 0 };
    }
    if (args[0] === '--version') return { code: 0, stdout: 'Docker version 28.0.0\n' };
    if (args[0] === 'info') {
      return daemonUp ? { code: 0, stdout: '28.0.0\n' } : { code: 1, stderr: 'error during connect' };
    }
    if (args.includes('ps')) {
      psCalls += 1;
      const ready = psCalls > 1;
      return { code: 0, stdout: psOutput({ db: ready ? 'healthy' : 'starting' }) };
    }
    if (args.includes('up')) {
      events.push('up');
      return { code: 0 };
    }
    return { code: 0 };
  });
  const logs = [];
  const manager = makeManager({
    runner,
    clock: createClock(),
    logger: (line) => logs.push(line),
    migrate: async () => {
      events.push('migrate');
      return { ok: true, applied: ['001_init.sql'], alreadyApplied: 0, database: 'postgres://mova@127.0.0.1:55432/mova' };
    },
  });

  const result = await manager.ensure({ migrate: true, timeoutMs: 10_000 });
  assert.equal(result.ok, true);
  assert.equal(daemonUp, true);
  assert.deepEqual(events, ['desktop', 'up', 'migrate']);
  assert.ok(logs.some((line) => line.includes('Starting Docker Desktop')));
  assert.ok(logs.every((line) => !line.includes('db-password-for-test')));
});

test('ensure exits 1 when migrations fail even though every service is healthy', async () => {
  const runner = createRunner(healthyHandler());
  let stdout = '';
  const code = await runServicesCli({
    argv: ['ensure', '--json'],
    env: testEnv(),
    cwd: TEST_CWD,
    run: runner.run,
    fs: { existsSync: () => true },
    now: createClock().now,
    sleep: createClock().sleep,
    migrate: async () => ({ ok: false, error: 'simulated migration failure' }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });

  assert.equal(code, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.services.every((service) => service.healthy), true);
  assert.match(result.message, /Migration failed: simulated migration failure/);
});

test('ensure without autostart fails fast when the daemon is down and reports exit code 1', async () => {
  const runner = createRunner(({ args }) => {
    if (args[0] === '--version') return { code: 0, stdout: 'Docker version 28.0.0\n' };
    if (args[0] === 'info') return { code: 1, stderr: 'Cannot connect to the Docker daemon' };
    return { code: 0 };
  });
  const env = testEnv({ MOVA_AUTOSTART_SERVICES: 'false' });
  let stdout = '';
  let stderr = '';
  const code = await runServicesCli({
    argv: ['ensure', '--json'],
    env,
    cwd: TEST_CWD,
    run: runner.run,
    fs: { existsSync: () => true },
    now: createClock().now,
    sleep: createClock().sleep,
    migrate: async () => ({ ok: true, applied: [] }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });

  assert.equal(code, 1);
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.match(result.error, /daemon is not running/i);
  assert.ok(!runner.calls.some((call) => call.options.detached));
  assert.ok(!runner.calls.some((call) => call.args.includes('up')));
});

test('missing Docker CLI yields an actionable failure and exit code 1', async () => {
  const runner = createRunner(() => ({ code: 127, stderr: 'spawn docker ENOENT' }));
  const env = testEnv();
  let stdout = '';
  const code = await runServicesCli({
    argv: ['ensure', '--json'],
    env,
    cwd: TEST_CWD,
    run: runner.run,
    fs: { existsSync: () => false },
    now: createClock().now,
    sleep: createClock().sleep,
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });

  assert.equal(code, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.match(result.error, /Docker CLI not found/);
  assert.match(result.error, /Docker Desktop 4\.99/);
});

test('passwords and S3 secrets are redacted from status, errors, and container logs', async () => {
  const secrets = ['db-password-for-test', 's3-password-for-test'];
  assert.equal(redactSecrets('a db-password-for-test b s3-password-for-test c', secrets), 'a *** b *** c');
  assert.equal(
    redactSecrets('postgres://mova:db-password-for-test@127.0.0.1:55432/mova', secrets),
    'postgres://mova:***@127.0.0.1:55432/mova',
  );

  const env = testEnv();
  const statusRunner = createRunner(({ args }) => {
    if (args[0] === '--version') return { code: 0, stdout: 'Docker version 28.0.0\n' };
    if (args[0] === 'info') {
      return {
        code: 1,
        stderr: `connect failed postgres://mova:${env.MOVA_DB_PASSWORD}@127.0.0.1:55432/mova (${env.MOVA_S3_SECRET_KEY})`,
      };
    }
    return { code: 0 };
  });
  const status = await makeManager({ env, runner: statusRunner }).status();
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /db-password-for-test|s3-password-for-test/);
  assert.match(status.message, /\*\*\*/);

  const logsRunner = createRunner(({ args }) => {
    if (args[0] === '--version') return { code: 0, stdout: 'Docker version 28.0.0\n' };
    if (args.includes('logs')) {
      return {
        code: 0,
        stdout: `connecting postgres://mova:${env.MOVA_DB_PASSWORD}@127.0.0.1:55432/mova\n`,
      };
    }
    return { code: 0 };
  });
  const logs = await makeManager({ env, runner: logsRunner }).logs({ service: 'mova-db', tail: 50 });
  assert.equal(logs.ok, true);
  assert.doesNotMatch(logs.output, /db-password-for-test/);
  assert.match(logs.output, /\*\*\*/);
  const logCall = logsRunner.calls.find((call) => call.args.includes('logs'));
  assert.deepEqual(logCall.args.slice(-5), ['logs', '--no-color', '--tail', '50', 'mova-db']);
});

test('status reports unhealthy services and exits 1; healthy status exits 0', async () => {
  const unhealthyRunner = createRunner(({ args }) => {
    if (args[0] === '--version') return { code: 0, stdout: 'Docker version 28.0.0\n' };
    if (args[0] === 'info') return { code: 0, stdout: '28.0.0\n' };
    if (args.includes('ps')) return { code: 0, stdout: psOutput({ db: 'unhealthy' }) };
    return { code: 0 };
  });

  let stdout = '';
  const failedCode = await runServicesCli({
    argv: ['status', '--json'],
    env: testEnv(),
    cwd: TEST_CWD,
    run: unhealthyRunner.run,
    fs: { existsSync: () => true },
    now: createClock().now,
    sleep: createClock().sleep,
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });
  assert.equal(failedCode, 1);
  const failed = JSON.parse(stdout);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /mova-db/);

  const healthyRunner = createRunner(healthyHandler());
  let healthyOut = '';
  const healthyCode = await runServicesCli({
    argv: ['status', '--json'],
    env: testEnv(),
    cwd: TEST_CWD,
    run: healthyRunner.run,
    fs: { existsSync: () => true },
    now: createClock().now,
    sleep: createClock().sleep,
    stdout: (text) => {
      healthyOut += text;
    },
    stderr: () => {},
  });
  assert.equal(healthyCode, 0);
  assert.equal(JSON.parse(healthyOut).ok, true);
});

test('down keeps volumes unless explicitly requested', async () => {
  const runner = createRunner(healthyHandler());
  const manager = makeManager({ runner });

  const first = await manager.down();
  assert.equal(first.ok, true);
  const firstCall = runner.calls.find((call) => call.args.includes('down'));
  assert.deepEqual(firstCall.args.slice(-1), ['down']);
  assert.ok(!firstCall.args.includes('--volumes'));

  const second = await manager.down({ volumes: true });
  assert.equal(second.ok, true);
  const downCalls = runner.calls.filter((call) => call.args.includes('down'));
  assert.ok(downCalls.at(-1).args.includes('--volumes'));
});

test('CLI argument parsing and exit codes are stable', async () => {
  const parsed = parseServiceArgs(['up', '--json', '--no-migrate', '--timeout', '5000']);
  assert.equal(parsed.command, 'up');
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.noMigrate, true);
  assert.equal(parsed.flags.timeoutMs, 5000);

  assert.throws(() => parseServiceArgs(['up', '--volumes']), /--volumes is only valid/);
  assert.throws(() => parseServiceArgs(['status', '--no-migrate']), /only valid with `up` or `ensure`/);
  assert.throws(() => parseServiceArgs(['bogus']), /Unknown command/);
  assert.throws(() => parseServiceArgs([]), /Missing command/);

  let stdout = '';
  let stderr = '';
  const usageCode = await runServicesCli({
    argv: ['bogus'],
    cwd: TEST_CWD,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.equal(usageCode, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /Unknown command: bogus/);
  assert.match(stderr, /Usage:/);

  let help = '';
  const helpCode = await runServicesCli({
    argv: ['--help'],
    cwd: TEST_CWD,
    stdout: (text) => {
      help += text;
    },
    stderr: () => {},
  });
  assert.equal(helpCode, 0);
  assert.match(help, /ensure/);
  assert.match(help, /Exit codes:/);
});
