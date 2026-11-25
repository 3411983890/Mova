const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { createDesignFontLoader } = require('../electron/design-fonts.cjs');

test('design host fonts use Windows font directory, real weight files and deduplicated reads', async () => {
  const calls = [];
  const load = createDesignFontLoader({ fontDirectory: join('D:', 'Windows', 'Fonts'), read: async file => { calls.push(file); return Buffer.from('font'); } });
  const [a, b] = await Promise.all([load('Microsoft YaHei', 'Regular'), load('Microsoft YaHei UI', 'Regular')]);
  assert.ok(a instanceof Uint8Array); assert.equal(a, b);
  await load('Microsoft YaHei', 'SemiBold'); await load('Microsoft YaHei', 'Bold');
  await load('微软雅黑', 'Light'); await load('SimHei'); await load('SimSun');
  assert.deepEqual(calls, ['msyh.ttc', 'msyhbd.ttc', 'msyhl.ttc', 'simhei.ttf', 'simsun.ttc'].map(file => join('D:', 'Windows', 'Fonts', file)));
});

test('font IPC whitelist rejects paths and missing fonts can be retried', async () => {
  let reads = 0;
  const load = createDesignFontLoader({ read: async () => { if (++reads === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return Buffer.from('font'); } });
  assert.equal(await load('../secrets'), null);
  assert.equal(await load('C:\\private.ttf'), null);
  assert.equal(reads, 0);
  await assert.rejects(load({}, 'Regular'), /无效/);
  assert.equal(await load('Microsoft YaHei'), null);
  assert.ok(await load('Microsoft YaHei'));
  assert.equal(reads, 2);
});
