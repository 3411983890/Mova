const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createProcedureStore, stepsFromTrace, patternOf } = require('./procedures.cjs');

async function withStore(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mova-procedures-'));
  try {
    return await fn(createProcedureStore({ directory }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('normalizes path ids and keeps trace values out of steps', () => {
  assert.equal(patternOf('https://shop.test/orders/12345?x=1'), '/orders/:id');
  assert.equal(patternOf('https://shop.test/orders/550e8400-e29b-41d4-a716-446655440000'), '/orders/:id');
  const steps = stepsFromTrace([
    { op: 'navigate', url: 'https://shop.test/orders' },
    { op: 'fill', selector: 'input[name="q"]', value: 'secret@example.com' },
    { op: 'click', selector: 'button[type="submit"]' },
  ]);
  assert.deepEqual(steps, [
    { op: 'navigate', url: 'https://shop.test/orders' },
    { op: 'fill', target: 'input[name="q"]' },
    { op: 'click', target: 'button[type="submit"]' },
  ]);
});

test('saves, finds, reports and removes a procedure', async () => {
  await withStore(async store => {
    const saved = await store.save({
      url: 'https://shop.test/orders',
      title: '导出订单',
      intent: ['导出', '订单'],
      steps: [{ op: 'click', target: 'button[data-testid="export"]' }],
    });
    assert.match(saved.id, /^sk_/);
    assert.equal(saved.origin, 'https://shop.test');
    assert.equal(saved.pathPattern, '/orders');

    const hits = await store.find({ url: 'https://shop.test/orders/42', intent: '导出' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, saved.id);
    assert.equal(hits[0].steps, 1);

    const stats = await store.report(saved.id, { ok: true, ms: 1200 });
    assert.equal(stats.ok, 1);
    assert.equal((await store.get(saved.id)).stats.avgMs, 360);

    assert.equal(await store.remove(saved.id), true);
    await assert.rejects(store.get(saved.id), /不存在/);
  });
});

test('auto-saves a trace once and dedupes the same step fingerprint', async () => {
  await withStore(async store => {
    const trace = [
      { op: 'fill', selector: '#q', value: 'x' },
      { op: 'click', selector: '#go' },
    ];
    const first = await store.saveFromTrace({ trace, url: 'https://shop.test/list', title: '搜索' });
    assert.equal(first.reused, false);
    const second = await store.saveFromTrace({ trace, url: 'https://shop.test/list', title: '搜索' });
    assert.equal(second.reused, true);
    assert.equal((await store.list()).length, 1);
  });
});

test('does not auto-save a single step and keeps skills out of other origins', async () => {
  await withStore(async store => {
    assert.equal(await store.saveFromTrace({ trace: [{ op: 'click', selector: '#go' }], url: 'https://a.test/' }), null);
    const saved = await store.save({ url: 'https://a.test/', title: 'A', steps: [{ op: 'click', target: '#a' }] });
    assert.equal((await store.find({ url: 'https://b.test/' })).length, 0);
    assert.equal((await store.find({ url: 'https://a.test/' }))[0].id, saved.id);
  });
});
