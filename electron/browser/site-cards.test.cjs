const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createSiteCardStore, patternOf } = require('./site-cards.cjs');
const { createMemoryMirror, summaryOf } = require('./memory-mirror.cjs');

async function withStore(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mova-site-cards-'));
  try { return await fn(createSiteCardStore({ directory })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('records landmarks and normalizes numeric paths', async () => {
  assert.equal(patternOf('https://shop.test/orders/42?x=1'), '/orders/:id');
  await withStore(async cards => {
    const card = await cards.update({
      url: 'https://shop.test/orders/42',
      title: '订单列表',
      entries: [
        { role: 'searchbox', name: '搜索订单', ref: '[ref=e1]' },
        { role: 'table', name: '订单列表', ref: '[ref=e2]' },
        { role: 'button', name: '导出', ref: '[ref=e3]' },
      ],
    });
    assert.equal(card.pathPattern, '/orders/:id');
    assert.equal(card.landmarks.search.name, '搜索订单');
    assert.equal(card.landmarks.list.role, 'table');
    assert.equal(card.landmarks.primaryAction.name, '导出');

    const found = await cards.get('https://shop.test/orders/43');
    assert.equal(found.visits, 1);
    await cards.update({ url: 'https://shop.test/orders/43', title: '订单列表', entries: [] });
    assert.equal((await cards.get('https://shop.test/orders/43')).visits, 2);
    assert.equal((await cards.list()).length, 1);
  });
});

test('memory mirror stores only a short index card', async () => {
  const calls = [];
  const memory = { async saveMemory(input) { calls.push(input); return { id: 'm1' }; } };
  const mirror = createMemoryMirror({ getMemory: () => memory });
  const procedure = {
    id: 'sk_1',
    origin: 'https://shop.test',
    pathPattern: '/orders',
    title: '导出订单',
    intent: ['导出'],
    steps: [{ op: 'click' }, { op: 'fill' }],
    verify: { kind: 'text', value: '导出成功' },
    stats: { ok: 7, fail: 1 },
  };
  const text = summaryOf(procedure);
  assert.match(text, /^\[站点技能\]/);
  assert.match(text, /点击 → 填写/);
  assert.match(text, /7\/8/);
  assert.ok(text.length < 2000);
  assert.deepEqual(await mirror.mirror(procedure), { id: 'm1' });
  assert.equal(calls[0].kind, 'note');
  assert.equal(calls[0].key, 'browser.procedure.sk_1');
  assert.equal(calls[0].source, 'automatic');
});

test('memory mirror fails soft when memory is unavailable', async () => {
  const mirror = createMemoryMirror({ getMemory: () => null });
  assert.equal(await mirror.mirror({ id: 'sk_1' }), null);
});
