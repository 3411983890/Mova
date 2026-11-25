const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { sanitizeFilename, isBlocked, uniquePath } = require('./downloads.cjs');

test('sanitizes filenames and keeps a usable fallback', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?.csv'), 'a_b_c_d_e_.csv');
  assert.equal(sanitizeFilename('...'), 'download');
});

test('blocks executable extensions case-insensitively', () => {
  for (const name of ['setup.exe', 'run.BAT', 'x.ps1', 'x.msi', 'x.vbs']) assert.equal(isBlocked(name), true, name);
  for (const name of ['report.csv', 'image.png', 'data.json', 'archive.zip']) assert.equal(isBlocked(name), false, name);
});

test('never overwrites an existing download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mova-downloads-'));
  try {
    const first = uniquePath(directory, 'report.csv');
    await writeFile(first, 'x');
    const second = uniquePath(directory, 'report.csv');
    assert.equal(second, join(directory, 'report (1).csv'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
