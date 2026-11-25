import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createQuotaService,
  validateQuotaBytes,
  isValidQuotaBytes,
  normalizeQuotaBytes,
  directoryBytes,
  QuotaError,
  DEFAULT_QUOTA_BYTES,
  MAX_QUOTA_BYTES,
} = require('../electron/services/quota.cjs');

const MIB = 1024 * 1024;

async function tmpdir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mova-quota-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Fake pg query: `bytes` is returned as pg does, a bigint string. */
function fakeQuery({ bytes = 0, fail = false } = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (fail) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return { rows: [{ bytes: String(bytes) }] };
  };
  query.calls = calls;
  return query;
}

const quotaError = (fn, expected) => assert.rejects(fn, error => error instanceof QuotaError && error.code === expected);

// ---------------------------------------------------------------------------
// Setting validation
// ---------------------------------------------------------------------------

test('quotaBytes validation: default 0 (unlimited), integers 0..1 TiB, nothing else', () => {
  assert.equal(DEFAULT_QUOTA_BYTES, 0);
  assert.equal(MAX_QUOTA_BYTES, 1099511627776);
  assert.equal(validateQuotaBytes(0), 0);
  assert.equal(validateQuotaBytes(MAX_QUOTA_BYTES), MAX_QUOTA_BYTES);
  for (const bad of [-1, 1.5, '1024', null, undefined, MAX_QUOTA_BYTES + 1, Number.NaN, Infinity]) {
    assert.throws(() => validateQuotaBytes(bad), error => error.code === 'invalid-quota', String(bad));
    assert.equal(isValidQuotaBytes(bad), false, String(bad));
  }
  assert.equal(isValidQuotaBytes(0), true);
  assert.equal(normalizeQuotaBytes(undefined), 0);
  assert.equal(normalizeQuotaBytes(null), 0);
  assert.equal(normalizeQuotaBytes(2048), 2048);
  assert.throws(() => normalizeQuotaBytes(-5), error => error.code === 'invalid-quota');
});

// ---------------------------------------------------------------------------
// Directory accounting
// ---------------------------------------------------------------------------

test('directoryBytes sums nested files, ignores missing directories and symlinks', async t => {
  const root = await tmpdir(t);
  await fs.mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.bin'), Buffer.alloc(100));
  await fs.writeFile(path.join(root, 'nested', 'b.bin'), Buffer.alloc(200));
  await fs.writeFile(path.join(root, 'nested', 'deep', 'c.bin'), Buffer.alloc(300));
  assert.equal(await directoryBytes(root), 600);
  assert.equal(await directoryBytes(path.join(root, 'missing')), 0);

  let linked = true;
  try {
    await fs.symlink(path.join(root, 'a.bin'), path.join(root, 'link.bin'));
  } catch {
    linked = false; // Windows without developer mode cannot create symlinks
  }
  if (linked) assert.equal(await directoryBytes(root), 600);

  const failing = { readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, lstat: fs.lstat };
  await assert.rejects(() => directoryBytes(root, { io: failing }), error => error.code === 'attachment-scan-failed');
  await assert.rejects(() => directoryBytes(''), error => error.code === 'invalid-directory');
});

// ---------------------------------------------------------------------------
// checkWrite
// ---------------------------------------------------------------------------

test('checkWrite allows writes under the quota and reports the projection', async t => {
  const directory = await tmpdir(t);
  await fs.writeFile(path.join(directory, 'image.png'), Buffer.alloc(1 * MIB));
  const query = fakeQuery({ bytes: 4 * MIB });
  const service = createQuotaService({ query, directory, settingsProvider: () => ({ quotaBytes: 10 * MIB }) });

  const result = await service.checkWrite({ bytes: 2 * MIB });
  assert.equal(result.ok, true);
  assert.equal(result.allowed, true);
  assert.equal(result.usedBytes, 5 * MIB);
  assert.equal(result.requestedBytes, 2 * MIB);
  assert.equal(result.quotaBytes, 10 * MIB);
  assert.equal(result.percent, 50);
  assert.equal(result.measured, true);
  assert.equal(query.calls.length, 1);
  assert.match(query.calls[0].sql, /pg_database_size\(current_database\(\)\)/);
  assert.deepEqual(await fs.readdir(directory), ['image.png']); // nothing deleted, nothing created
});

test('checkWrite treats exactly-full as allowed and one byte over as quota-exceeded', async t => {
  const directory = await tmpdir(t);
  await fs.writeFile(path.join(directory, 'a.bin'), Buffer.alloc(1000));
  const query = fakeQuery({ bytes: 9000 });
  const service = createQuotaService({ query, directory, settingsProvider: async () => ({ quotaBytes: 10_000 }) });

  assert.equal((await service.checkWrite({ bytes: 0 })).ok, true);
  const exact = await service.checkWrite({ bytes: 0 });
  assert.equal(exact.usedBytes, 10_000);

  await assert.rejects(() => service.checkWrite({ bytes: 1 }), error => {
    assert.equal(error.code, 'quota-exceeded');
    assert.equal(error.quotaBytes, 10_000);
    assert.equal(error.usedBytes, 10_000);
    assert.equal(error.requestedBytes, 1);
    assert.equal(error.percent, 100);
    return true;
  });
  await quotaError(() => service.checkWrite({ bytes: 5 * MIB }), 'quota-exceeded');
});

test('quotaBytes 0 (or unset) is unlimited: allowed without measuring or querying', async t => {
  const directory = await tmpdir(t);
  await fs.writeFile(path.join(directory, 'big.bin'), Buffer.alloc(100));
  const query = fakeQuery({ bytes: 1 * MIB });
  for (const settings of [{ quotaBytes: 0 }, {}, null]) {
    const service = createQuotaService({ query, directory, settingsProvider: () => settings });
    const result = await service.checkWrite({ bytes: 50 * MIB });
    assert.equal(result.ok, true);
    assert.equal(result.unlimited, true);
    assert.equal(result.quotaBytes, 0);
    assert.equal(result.percent, null);
    assert.equal(result.measured, false);
  }
  assert.equal(query.calls.length, 0);

  const noSettings = createQuotaService({ query, directory });
  assert.equal((await noSettings.checkWrite({ bytes: 1 })).unlimited, true);
  assert.equal((await noSettings.stats()).quotaBytes, 0);
});

test('checkWrite validates the requested byte count', async t => {
  const directory = await tmpdir(t);
  const query = fakeQuery({ bytes: 0 });
  const service = createQuotaService({ query, directory, settingsProvider: () => ({ quotaBytes: 1000 }) });
  for (const bytes of [-1, 1.5, '10', null]) {
    await quotaError(() => service.checkWrite({ bytes }), 'invalid-input');
  }
  assert.equal((await service.checkWrite()).ok, true);
  assert.equal((await service.checkWrite({})).ok, true);
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

test('stats reports database + attachments, quota and percent', async t => {
  const directory = await tmpdir(t);
  await fs.mkdir(path.join(directory, 'nested'));
  await fs.writeFile(path.join(directory, 'nested', 'image.png'), Buffer.alloc(2 * MIB));
  const service = createQuotaService({
    query: fakeQuery({ bytes: 6 * MIB }),
    directory,
    settingsProvider: () => ({ quotaBytes: 20 * MIB }),
    now: () => Date.UTC(2026, 10, 10, 0, 0, 0),
  });

  const stats = await service.stats();
  assert.equal(stats.databaseBytes, 6 * MIB);
  assert.equal(stats.attachmentBytes, 2 * MIB);
  assert.equal(stats.objectBytes, null);
  assert.equal(stats.bytes, 8 * MIB);
  assert.equal(stats.usedBytes, 8 * MIB);
  assert.equal(stats.quotaBytes, 20 * MIB);
  assert.equal(stats.unlimited, false);
  assert.equal(stats.percent, 40);
  assert.equal(stats.withinQuota, true);
  assert.equal(stats.complete, true);
  assert.deepEqual(stats.errors, []);
  assert.equal(stats.measuredAt, '2026-11-10T00:00:00.000Z');
});

test('stats never throws: failed sources are null and listed, known sources still sum', async t => {
  const directory = await tmpdir(t);
  await fs.writeFile(path.join(directory, 'image.png'), Buffer.alloc(500));
  const service = createQuotaService({
    query: fakeQuery({ fail: true }),
    directory,
    settingsProvider: () => ({ quotaBytes: 1 * MIB }),
    objectUsage: async () => { throw new Error('minio admin api unavailable'); },
  });
  const stats = await service.stats();
  assert.equal(stats.databaseBytes, null);
  assert.equal(stats.attachmentBytes, 500);
  assert.equal(stats.objectBytes, null);
  assert.equal(stats.bytes, 500);
  assert.equal(stats.percent, Math.round((500 / (1 * MIB)) * 1000) / 10);
  assert.equal(stats.complete, false);
  assert.deepEqual(stats.errors.map(error => error.code).sort(), ['database-size-unavailable', 'object-usage-unavailable']);
  assert.equal(stats.unlimited, false);

  const noQuery = createQuotaService({ directory: await tmpdir(t), settingsProvider: () => ({ quotaBytes: 0 }) });
  const empty = await noQuery.stats();
  assert.equal(empty.databaseBytes, null);
  assert.equal(empty.errors[0].code, 'database-unavailable');
  assert.equal(empty.attachmentBytes, 0);
  assert.equal(empty.unlimited, true);
});

test('an invalid stored quotaBytes is reported, never silently coerced', async t => {
  const directory = await tmpdir(t);
  const query = fakeQuery({ bytes: 10 });
  const service = createQuotaService({ query, directory, settingsProvider: () => ({ quotaBytes: -1 }) });

  const stats = await service.stats();
  assert.equal(stats.quotaBytes, null);
  assert.equal(stats.unlimited, false);
  assert.equal(stats.percent, null);
  assert.equal(stats.withinQuota, null);
  assert.equal(stats.complete, false);
  assert.ok(stats.errors.some(error => error.source === 'settings' && error.code === 'invalid-quota'));

  await quotaError(() => service.checkWrite({ bytes: 1 }), 'invalid-quota');
  await quotaError(() => service.checkWrite({ bytes: 1 }), 'invalid-quota');

  const throwingProvider = createQuotaService({ query, directory, settingsProvider: () => { throw new Error('db down'); } });
  assert.equal((await throwingProvider.stats()).quotaBytes, null);
  await quotaError(() => throwingProvider.checkWrite({ bytes: 1 }), 'settings-unavailable');
});

// ---------------------------------------------------------------------------
// Measurement failures / optional object usage
// ---------------------------------------------------------------------------

test('a configured quota with an unmeasurable database fails closed by default, configurable to allow', async t => {
  const directory = await tmpdir(t);
  const query = fakeQuery({ fail: true });
  const strict = createQuotaService({ query, directory, settingsProvider: () => ({ quotaBytes: 1 * MIB }) });
  await assert.rejects(() => strict.checkWrite({ bytes: 10 }), error => {
    assert.equal(error.code, 'quota-unavailable');
    assert.equal(error.quotaBytes, 1 * MIB);
    assert.deepEqual(error.errors.map(entry => entry.code), ['database-size-unavailable']);
    return true;
  });

  const lenient = createQuotaService({ query, directory, settingsProvider: () => ({ quotaBytes: 1 * MIB }), onMeasurementFailure: 'allow' });
  const result = await lenient.checkWrite({ bytes: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.measured, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors.map(entry => entry.code), ['database-size-unavailable']);
});

test('an attachment scan failure is reported and blocks a configured quota check', async t => {
  const directory = await tmpdir(t);
  const io = {
    readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    lstat: fs.lstat,
  };
  const service = createQuotaService({ query: fakeQuery({ bytes: 100 }), directory, io, settingsProvider: () => ({ quotaBytes: 1 * MIB }) });
  const stats = await service.stats();
  assert.equal(stats.attachmentBytes, null);
  assert.ok(stats.errors.some(error => error.code === 'attachment-scan-failed'));
  await quotaError(() => service.checkWrite({ bytes: 1 }), 'quota-unavailable');

  const missingDirectory = createQuotaService({ query: fakeQuery({ bytes: 100 }), directory: path.join(directory, 'nope'), settingsProvider: () => ({ quotaBytes: 1 * MIB }) });
  assert.equal((await missingDirectory.checkWrite({ bytes: 1 })).ok, true);
});

test('optional S3 usage is included when cheaply known and never fatal when unknown', async t => {
  const directory = await tmpdir(t);
  await fs.writeFile(path.join(directory, 'a.bin'), Buffer.alloc(1000));
  const query = fakeQuery({ bytes: 1000 });

  const known = createQuotaService({ query, directory, settingsProvider: () => ({ quotaBytes: 10_000 }), objectUsage: async () => 7000 });
  const stats = await known.stats();
  assert.equal(stats.objectBytes, 7000);
  assert.equal(stats.bytes, 9000);
  assert.equal(stats.complete, true);
  const under = await known.checkWrite({ bytes: 1000 });
  assert.equal(under.ok, true);
  assert.equal(under.usedBytes, 9000);
  await quotaError(() => known.checkWrite({ bytes: 1001 }), 'quota-exceeded');

  const unknown = createQuotaService({ query, directory, settingsProvider: () => ({ quotaBytes: 2000 }), objectUsage: async () => null });
  const unknownStats = await unknown.stats();
  assert.equal(unknownStats.objectBytes, null);
  assert.equal(unknownStats.errors.length, 0);
  assert.equal(unknownStats.complete, true);
  await quotaError(() => unknown.checkWrite({ bytes: 1 }), 'quota-exceeded');
});

test('settingsProvider accepts a function, an async function, or an object with settings()', async t => {
  const directory = await tmpdir(t);
  const query = fakeQuery({ bytes: 0 });
  const fromObject = createQuotaService({ query, directory, settingsProvider: { settings: async () => ({ quotaBytes: 2048 }) } });
  assert.equal((await fromObject.checkWrite({ bytes: 1 })).quotaBytes, 2048);
  assert.equal((await fromObject.stats()).quotaBytes, 2048);

  const repositoryLike = createQuotaService({ query, directory, settingsProvider: { settings: () => ({ quotaBytes: MAX_QUOTA_BYTES }) } });
  assert.equal((await repositoryLike.checkWrite({ bytes: MAX_QUOTA_BYTES })).ok, true);
  await quotaError(() => repositoryLike.checkWrite({ bytes: MAX_QUOTA_BYTES + 1 }), 'quota-exceeded');
});

test('no directory configured means no scan at all: the source is reported, not invented', async () => {
  const query = fakeQuery({ bytes: 100 });
  const service = createQuotaService({ query, settingsProvider: () => ({ quotaBytes: 1 * MIB }) });
  const stats = await service.stats();
  assert.equal(stats.attachmentBytes, null);
  assert.equal(stats.bytes, 100);
  assert.ok(stats.errors.some(error => error.source === 'attachments' && error.code === 'invalid-directory'));
  await quotaError(() => service.checkWrite({ bytes: 1 }), 'quota-unavailable');
});

test('the quota service only measures: it exposes no delete/purge path', () => {
  const service = createQuotaService({ query: fakeQuery({ bytes: 1 }), settingsProvider: () => ({ quotaBytes: 0 }) });
  assert.deepEqual(Object.keys(service).sort(), ['checkWrite', 'measure', 'quotaBytes', 'stats']);
  for (const name of ['delete', 'clear', 'purge', 'enforce', 'remove']) assert.equal(service[name], undefined);
});
