const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createTimingLog } = require('./timing-log.cjs');

const silent = { warn() {} };

test('writes one JSONL line per run and reads them back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createTimingLog({ directory: dir, now: () => Date.UTC(2026, 10, 13, 6, 0, 0), logger: silent });
  log.write({ label: 'app', wallMs: 5000, modelMs: 3000, toolMs: 1500, humanMs: 500 });
  log.write({ label: 'edge', wallMs: 7000, modelMs: 4000, toolMs: 2500, humanMs: 0 });
  await log.flush();

  const rows = await log.recent(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, 'app');
  assert.equal(rows[0].v, 1);
  assert.equal(rows[0].at, '2026-11-13T06:00:00.000Z');
  assert.equal(rows[1].edge, undefined);
  const file = join(dir, 'timing-2026-11-13.jsonl');
  assert.match(await readFile(file, 'utf8'), /"label":"edge"/);
});

test('a corrupt line never breaks reading the history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createTimingLog({ directory: dir, logger: silent });
  await writeFile(join(dir, 'timing-2026-11-13.jsonl'), '{"ok":1}\n{broken\n{"ok":2}\n', 'utf8');
  const rows = await log.recent(5);
  assert.deepEqual(rows.map(row => row.ok), [1, 2]);
});

test('an oversized file is rotated instead of growing without bound', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createTimingLog({ directory: dir, maxBytes: 20, now: () => Date.UTC(2026, 10, 13), logger: silent });
  await writeFile(join(dir, 'timing-2026-11-13.jsonl'), 'x'.repeat(64), 'utf8');
  log.write({ label: 'app', wallMs: 1 });
  await log.flush();
  const text = await readFile(join(dir, 'timing-2026-11-13.jsonl'), 'utf8');
  assert.equal(text.includes('xxxx'), false, '超限文件先删再写，不会无限增长');
  assert.match(text, /"label":"app"/);
});

test('a write failure is reported once and never thrown into the conversation', async t => {
  const warnings = [];
  const log = createTimingLog({
    directory: join(tmpdir(), 'mova-timing-missing', '\u0000bad'),
    logger: { warn: message => warnings.push(message) },
  });
  log.write({ label: 'app' });
  log.write({ label: 'app' });
  await log.flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /无法写入计时日志/);
});
