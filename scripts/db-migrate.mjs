#!/usr/bin/env node
/**
 * Mova PostgreSQL migration runner.
 *
 * Applies `electron/db/migrations/*.sql` in natural filename order and records
 * every successful file in the `mova_migrations` ledger. Each migration runs in
 * its own transaction; the runner never drops or resets a database.
 *
 * Usage:
 *   node scripts/db-migrate.mjs            # apply pending migrations
 *   node scripts/db-migrate.mjs --status   # show applied/pending, change nothing
 *
 * Tests inject `connect()` so no PostgreSQL server is required.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LEDGER_TABLE = 'mova_migrations';
const DEFAULT_LOCK_KEY = 724011337;
const SORT_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });

const LEDGER_SQL = `create table if not exists ${LEDGER_TABLE} (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now(),
  duration_ms integer not null
)`;

export class MigrationError extends Error {
  constructor(message, { code = 'migration_failed', file, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MigrationError';
    this.code = code;
    if (file) this.file = file;
  }
}

export class MigrationUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationUsageError';
    this.code = 'usage';
  }
}

/** Natural sort: 2_foo.sql before 10_bar.sql, deterministic for zero-padded names. */
export function sortMigrationFiles(files) {
  return [...files].sort((left, right) => SORT_COLLATOR.compare(left, right));
}

/** Normalize line endings and a UTF-8 BOM so checksums survive git checkouts. */
export function normalizeSql(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function checksumSql(text) {
  return createHash('sha256').update(normalizeSql(text), 'utf8').digest('hex');
}

export function redactConnectionString(value) {
  return String(value ?? '').replace(
    /(postgres(?:ql)?:\/\/[^:/?#\s]+:)([^@/?#\s]*)(@)/gi,
    '$1***$3',
  );
}

export function describeConnection(connectionString) {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return redactConnectionString(connectionString);
  }
}

export function resolveConnectionString({ env = process.env, connectionString } = {}) {
  if (connectionString) return connectionString;
  if (env.MOVA_DB_URL) return env.MOVA_DB_URL;
  const user = env.MOVA_DB_USER || 'mova';
  const password = env.MOVA_DB_PASSWORD || 'mova_local_password';
  const host = env.MOVA_DB_HOST || '127.0.0.1';
  const port = env.MOVA_DB_PORT || '55432';
  const database = env.MOVA_DB_NAME || 'mova';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export function migrationsDirFor(cwd = process.cwd()) {
  return path.join(cwd, 'electron', 'db', 'migrations');
}

/**
 * Load and checksum every migration file before touching the database.
 * @returns {Promise<Array<{name: string, sql: string, checksum: string}>>}
 */
export async function loadMigrations(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new MigrationError(`Migrations directory not found: ${dir}`, {
        code: 'migrations_dir_missing',
        cause: error,
      });
    }
    throw new MigrationError(`Cannot read migrations directory ${dir}: ${error.message}`, {
      code: 'migrations_dir_unreadable',
      cause: error,
    });
  }

  const names = sortMigrationFiles(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
      .map((entry) => entry.name),
  );

  if (names.length === 0) {
    throw new MigrationError(`No .sql migration files found in ${dir}`, {
      code: 'no_migrations',
    });
  }

  const migrations = [];
  for (const name of names) {
    const sql = normalizeSql(await readFile(path.join(dir, name), 'utf8'));
    migrations.push({ name, sql, checksum: checksumSql(sql) });
  }
  return migrations;
}

/** The runner owns transactions; a migration that commits by itself would break atomicity. */
export function findTransactionControl(sql) {
  const match = String(sql).match(/^\s*(begin|commit|rollback)\s*;\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

function isUndefinedTable(error) {
  return error?.code === '42P01' || /relation .* does not exist/i.test(String(error?.message ?? ''));
}

async function readLedger(client, { required }) {
  try {
    const result = await client.query(
      `select filename, checksum, applied_at from ${LEDGER_TABLE} order by filename`,
    );
    return { exists: true, rows: result?.rows ?? [] };
  } catch (error) {
    if (!required && isUndefinedTable(error)) return { exists: false, rows: [] };
    throw error;
  }
}

export async function connectPostgres(connectionString) {
  const pgModule = await import('pg');
  const pg = pgModule.default ?? pgModule;
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

function errorText(error) {
  return redactConnectionString(String(error?.message ?? error));
}

/**
 * Apply pending migrations.
 * @returns {Promise<{ok: true, database: string, applied: string[], alreadyApplied: number, total: number}>}
 */
export async function runMigrations(options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    logger = () => {},
    connect = connectPostgres,
    now = Date.now,
  } = options;
  const dir = options.dir ?? migrationsDirFor(cwd);
  const lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;
  const migrations = await loadMigrations(dir);
  const connectionString = resolveConnectionString({ env, connectionString: options.connectionString });

  let client;
  try {
    client = await connect(connectionString);
  } catch (error) {
    throw new MigrationError(
      `Could not connect to PostgreSQL at ${describeConnection(connectionString)}: ${errorText(error)}`,
      { code: 'connect_failed', cause: error },
    );
  }

  let locked = false;
  try {
    await client.query(LEDGER_SQL);
    await client.query('select pg_advisory_lock($1)', [lockKey]);
    locked = true;

    const ledger = await readLedger(client, { required: true });
    const onDisk = new Map(migrations.map((migration) => [migration.name, migration]));
    const applied = new Map(ledger.rows.map((row) => [row.filename, row]));

    for (const row of ledger.rows) {
      const migration = onDisk.get(row.filename);
      if (!migration) {
        throw new MigrationError(
          `Applied migration file is missing: ${row.filename}. Restore the file; deleting ledger rows is not supported.`,
          { code: 'migration_missing', file: row.filename },
        );
      }
      if (migration.checksum !== row.checksum) {
        throw new MigrationError(
          `Migration changed after it was applied: ${row.filename}. Migrations are immutable; add a new migration instead.`,
          { code: 'migration_changed', file: row.filename },
        );
      }
    }

    const pending = migrations.filter((migration) => !applied.has(migration.name));
    logger(`Migrations: ${ledger.rows.length} applied, ${pending.length} pending`);

    for (const migration of pending) {
      const control = findTransactionControl(migration.sql);
      if (control) {
        throw new MigrationError(
          `Migration ${migration.name} contains a top-level ${control.toUpperCase()}; the runner owns the transaction. Remove it and try again.`,
          { code: 'migration_transaction_control', file: migration.name },
        );
      }

      const startedAt = now();
      await client.query('begin');
      try {
        await client.query(migration.sql);
        const duration = Math.max(0, now() - startedAt);
        await client.query(
          `insert into ${LEDGER_TABLE} (filename, checksum, duration_ms) values ($1, $2, $3)`,
          [migration.name, migration.checksum, duration],
        );
        await client.query('commit');
        logger(`Applied ${migration.name}`);
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          /* keep the original migration error */
        }
        throw new MigrationError(
          `Migration failed: ${migration.name}\n${errorText(error)}\nThe transaction was rolled back; fix the migration and run again.`,
          { code: 'migration_failed', file: migration.name, cause: error },
        );
      }
    }

    return {
      ok: true,
      database: describeConnection(connectionString),
      applied: pending.map((migration) => migration.name),
      alreadyApplied: ledger.rows.length,
      total: migrations.length,
    };
  } finally {
    if (locked) {
      try {
        await client.query('select pg_advisory_unlock($1)', [lockKey]);
      } catch {
        /* connection close releases the session lock anyway */
      }
    }
    if (client && typeof client.end === 'function') {
      try {
        await client.end();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/**
 * Read-only migration status. Does not create or modify the ledger.
 */
export async function migrationStatus(options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    connect = connectPostgres,
  } = options;
  const dir = options.dir ?? migrationsDirFor(cwd);
  const migrations = await loadMigrations(dir);
  const connectionString = resolveConnectionString({ env, connectionString: options.connectionString });

  let client;
  try {
    client = await connect(connectionString);
  } catch (error) {
    throw new MigrationError(
      `Could not connect to PostgreSQL at ${describeConnection(connectionString)}: ${errorText(error)}`,
      { code: 'connect_failed', cause: error },
    );
  }

  try {
    const ledger = await readLedger(client, { required: false });
    const onDisk = new Set(migrations.map((migration) => migration.name));
    const applied = new Map(ledger.rows.map((row) => [row.filename, row]));
    const changed = [];
    const missing = [];

    const rows = migrations.map((migration) => {
      const row = applied.get(migration.name);
      if (!row) return { filename: migration.name, status: 'pending' };
      if (row.checksum !== migration.checksum) {
        changed.push(migration.name);
        return { filename: migration.name, status: 'changed', appliedAt: row.applied_at };
      }
      return { filename: migration.name, status: 'applied', appliedAt: row.applied_at };
    });

    for (const row of ledger.rows) {
      if (!onDisk.has(row.filename)) {
        missing.push(row.filename);
        rows.push({ filename: row.filename, status: 'missing', appliedAt: row.applied_at });
      }
    }

    return {
      ok: changed.length === 0 && missing.length === 0,
      database: describeConnection(connectionString),
      ledger: ledger.exists ? 'ok' : 'missing',
      applied: rows.filter((row) => row.status === 'applied').map((row) => row.filename),
      pending: rows.filter((row) => row.status === 'pending').map((row) => row.filename),
      changed,
      missing,
      rows,
    };
  } finally {
    if (client && typeof client.end === 'function') {
      try {
        await client.end();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

export function parseMigrateArgs(argv = []) {
  const options = { status: false, json: false, dir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--status') options.status = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new MigrationUsageError('--dir requires a path');
      options.dir = value;
      index += 1;
    } else if (arg === '--reset') {
      throw new MigrationUsageError(
        '--reset is not supported: this tool never drops data. Create or restore a database manually if you really need a reset.',
      );
    } else {
      throw new MigrationUsageError(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseDotEnv(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    values[key] = value.replace(/\\n/g, '\n');
  }
  return values;
}

export function loadDotEnv(file, env = process.env) {
  if (!existsSync(file)) return env;
  try {
    const values = parseDotEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch {
    /* a broken .env must not hide the real CLI error */
  }
  return env;
}

const USAGE = `Usage: node scripts/db-migrate.mjs [options]

Applies electron/db/migrations/*.sql in natural filename order, one transaction
per file, and records them in the mova_migrations ledger.

Options:
  --status        Show applied/pending migrations without changing anything
  --dir <path>    Override the migrations directory
  --json          Print a single machine-readable JSON result
  -h, --help      Show this help

Connection:
  MOVA_DB_URL, or MOVA_DB_USER/MOVA_DB_PASSWORD/MOVA_DB_HOST/MOVA_DB_PORT/MOVA_DB_NAME
  A .env file in the working directory is loaded without overriding real env vars.

Exit codes:
  0  success / status has no checksum or missing-file problems
  1  connection, ledger, or migration failure
  2  usage error (unknown flag, including --reset)

There is intentionally no destructive reset option.
`;

function printStatus(result, stdout) {
  stdout(`Database: ${result.database}\n`);
  stdout(`Ledger: ${result.ledger}\n`);
  if (result.applied.length > 0) {
    stdout(`Applied (${result.applied.length}):\n`);
    for (const name of result.applied) stdout(`  ${name}\n`);
  } else {
    stdout('Applied (0)\n');
  }
  if (result.pending.length > 0) {
    stdout(`Pending (${result.pending.length}):\n`);
    for (const name of result.pending) stdout(`  ${name}\n`);
  } else {
    stdout('Pending (0)\n');
  }
  if (result.changed.length > 0) {
    stdout(`Changed after apply (${result.changed.length}):\n`);
    for (const name of result.changed) stdout(`  ${name}\n`);
  }
  if (result.missing.length > 0) {
    stdout(`Ledger entries without a file (${result.missing.length}):\n`);
    for (const name of result.missing) stdout(`  ${name}\n`);
  }
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  connect,
  now,
} = {}) {
  let options;
  try {
    options = parseMigrateArgs(argv);
  } catch (error) {
    stderr(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    stdout(USAGE);
    return 0;
  }

  const cliEnv = { ...env };
  loadDotEnv(path.join(cwd, '.env'), cliEnv);
  const dir = options.dir ? path.resolve(cwd, options.dir) : migrationsDirFor(cwd);

  try {
    if (options.status) {
      const result = await migrationStatus({ env: cliEnv, cwd, dir, connect });
      if (options.json) stdout(`${JSON.stringify(result)}\n`);
      else printStatus(result, stdout);
      return result.ok ? 0 : 1;
    }

    const result = await runMigrations({
      env: cliEnv,
      cwd,
      dir,
      connect,
      now,
      logger: options.json ? () => {} : (line) => stderr(`${line}\n`),
    });
    if (options.json) stdout(`${JSON.stringify(result)}\n`);
    else if (result.applied.length > 0) {
      stdout(`Applied ${result.applied.length} migration(s) to ${result.database}:\n`);
      for (const name of result.applied) stdout(`  ${name}\n`);
    } else {
      stdout(`Database is up to date (${result.alreadyApplied} migration(s), ${result.database}).\n`);
    }
    return 0;
  } catch (error) {
    const message = redactConnectionString(error?.message ?? error);
    if (options.json) stdout(`${JSON.stringify({ ok: false, code: error?.code ?? 'error', error: message })}\n`);
    else stderr(`${message}\n`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${redactConnectionString(error?.stack ?? error)}\n`);
      process.exitCode = 1;
    });
}
