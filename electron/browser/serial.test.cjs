const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSerialQueue } = require('./serial.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('runs operations one at a time in call order', async () => {
  const run = createSerialQueue();
  const events = [];
  const first = run(async () => { events.push('a:start'); await delay(30); events.push('a:end'); return 'a'; });
  const second = run(async () => { events.push('b:start'); await delay(1); events.push('b:end'); return 'b'; });
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('a failed operation does not block the next one', async () => {
  const run = createSerialQueue();
  await assert.rejects(run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await run(async () => 'ok'), 'ok');
});

test('parallel queues are independent', async () => {
  const a = createSerialQueue();
  const b = createSerialQueue();
  const started = [];
  await Promise.all([
    a(async () => { started.push('a'); await delay(40); }),
    b(async () => { started.push('b'); await delay(1); }),
  ]);
  assert.deepEqual(started, ['a', 'b']);
});
