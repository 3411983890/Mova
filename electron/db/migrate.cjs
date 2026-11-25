'use strict';
// PostgreSQL migration runner for the Mova single-user service schema.
// Deliberately dependency-light: only `pg` plus Node built-ins, so the runner
// can be used from Electron main, from a worker, or from the CLI.
//
// Usage (CLI):
//   node electron/db/migrate.cjs            # apply pending migrations
//   node electron/db/migrate.cjs up
//   node electron/db/migrate.cjs status     # list applied / pending files
//   node electron/db/migrate.cjs up --dry-run
//
// Connection string: MOVA_DB_URL (or --url=postgres://...). Passwords are never
// printed: the runner reports a redacted connection target only.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MIGRATION_DIR = path.join(__dirname, 'migrations');
// Shared with scripts/db-migrate.mjs: one ledger, one truth.
const MIGRATION_TABLE = 'mova_migrations';
const ADVISORY_LOCK_KEY = 7410001;
const FILE_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/i;

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function redactConnectionString(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:/@\s]+):([^@\s/]*)@/g, '://$1:***@');
  }
}

async function listMigrations(directory = MIGRATION_DIR) {
  const names = await fs.readdir(directory);
  return names
    .filter(name => FILE_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map(name => ({ name, path: path.join(directory, name) }));
}

async function readMigration(file) {
  const sql = await fs.readFile(file.path, 'utf8');
  return { ...file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

async function ensureMigrationTable(client) {
  await client.query(`create table if not exists ${MIGRATION_TABLE} (
    filename text primary key,
    checksum text not null,
    applied_at timestamptz not null default now(),
    duration_ms integer not null default 0
  )`);
}

async function appliedMigrations(client) {
  try {
    const result = await client.query(`select filename, checksum, applied_at from ${MIGRATION_TABLE} order by filename`);
    return result.rows;
  } catch (error) {
    // Table is created by ensureMigrationTable; a missing table simply means
    // "nothing applied yet" (fresh database).
    if (error?.code === '42P01') return [];
    throw error;
  }
}

async function status(options = {}) {
  const pool = options.pool || (await connect(options));
  const owned = !options.pool;
  try {
    const client = await pool.connect();
    try {
      const applied = await appliedMigrations(client);
      const files = await Promise.all((await listMigrations(options.directory)).map(readMigration));
      const byName = new Map(applied.map(row => [row.filename, row]));
      return files.map(file => {
        const record = byName.get(file.name);
        return {
          name: file.name,
          checksum: file.checksum,
          appliedAt: record ? new Date(record.applied_at).toISOString() : null,
          state: !record ? 'pending' : record.checksum === file.checksum ? 'applied' : 'checksum-mismatch',
        };
      });
    } finally {
      client.release();
    }
  } finally {
    if (owned) await pool.end();
  }
}

async function connect(options = {}) {
  const connectionString = options.connectionString || options.url || process.env.MOVA_DB_URL;
  if (!connectionString) throw coded('invalid-config', 'MOVA_DB_URL is not set');
  let pg;
  try {
    pg = require('pg');
  } catch {
    throw coded('pg-unavailable', 'the "pg" package is not installed');
  }
  const pool = new pg.Pool({ connectionString, max: options.max || 1, application_name: 'mova-migrate' });
  pool.on?.('error', () => {});
  return pool;
}

// Applies every pending migration inside its own transaction. Uses a session
// advisory lock so two Electron windows (or the worker) cannot race.
async function migrate(options = {}) {
  const pool = options.pool || (await connect(options));
  const owned = !options.pool;
  const log = options.log || (() => {});
  const applied = [];
  const skipped = [];
  try {
    const client = await pool.connect();
    try {
      await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
      await ensureMigrationTable(client);
      const files = await Promise.all((await listMigrations(options.directory)).map(readMigration));
      if (options.dryRun === true) {
        const records = await appliedMigrations(client);
        const byName = new Map(records.map(row => [row.filename, row]));
        for (const file of files) {
          const record = byName.get(file.name);
          if (record && record.checksum === file.checksum) skipped.push(file.name);
          else log(`--- would apply ${file.name} ---\n${file.sql}`);
        }
        return { applied, skipped, dryRun: true };
      }
      for (const file of files) {
        const records = await appliedMigrations(client);
        const record = records.find(row => row.filename === file.name);
        if (record) {
          if (record.checksum !== file.checksum) {
            throw coded('migration-checksum-mismatch', `${file.name} changed after it was applied; add a new migration instead`);
          }
          skipped.push(file.name);
          continue;
        }
        log(`applying ${file.name}`);
        const started = Date.now();
        await client.query('begin');
        try {
          await client.query(file.sql);
          await client.query(`insert into ${MIGRATION_TABLE} (filename, checksum, duration_ms) values ($1, $2, $3)`, [file.name, file.checksum, Date.now() - started]);
          await client.query('commit');
          applied.push(file.name);
        } catch (error) {
          try { await client.query('rollback'); } catch { /* connection already broken */ }
          throw coded('migration-failed', `${file.name}: ${error?.message || 'unknown error'}`);
        }
      }
      return { applied, skipped, dryRun: false };
    } finally {
      try { await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]); } catch { /* ignore */ }
      client.release();
    }
  } finally {
    if (owned) await pool.end();
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv.find(arg => !arg.startsWith('-')) || 'up';
  const dryRun = argv.includes('--dry-run');
  const urlArg = argv.find(arg => arg.startsWith('--url='));
  const connectionString = urlArg ? urlArg.slice('--url='.length) : process.env.MOVA_DB_URL;
  if (!connectionString) throw coded('invalid-config', 'MOVA_DB_URL or --url=... is required');
  const pool = await connect({ connectionString });
  const log = message => process.stdout.write(`${message}\n`);
  try {
    if (command === 'status') {
      const rows = await status({ pool });
      for (const row of rows) log(`${row.state.padEnd(17)} ${row.name}${row.appliedAt ? ` (${row.appliedAt})` : ''}`);
      return 0;
    }
    if (command !== 'up') throw coded('invalid-command', `unknown command: ${command}`);
    log(`target ${redactConnectionString(connectionString)}`);
    const result = await migrate({ pool, dryRun, log });
    if (!dryRun) {
      log(result.applied.length ? `applied: ${result.applied.join(', ')}` : 'no pending migrations');
      if (result.skipped.length) log(`already applied: ${result.skipped.join(', ')}`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`migration failed: ${error?.code || 'error'} ${error?.message || ''}\n`);
    process.exit(1);
  });
}

module.exports = { migrate, status, listMigrations, readMigration, connect, redactConnectionString, MIGRATION_DIR, MIGRATION_TABLE };
