const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRuntimeLogger } = require('./memory-runtime.cjs');

test('swallows a broken stdout pipe', () => {
  const logger = { debug() { throw new Error('EPIPE: broken pipe, write'); }, info() { throw new Error('EPIPE'); } };
  const runtime = createRuntimeLogger(logger);
  assert.doesNotThrow(() => runtime.info('services:ensure'));
  assert.doesNotThrow(() => runtime.error('boom'));
});

test('debug is quiet unless explicitly enabled', () => {
  let calls = 0;
  const runtime = createRuntimeLogger({ debug() { calls += 1; } });
  runtime.debug('queue tick');
  assert.equal(calls, 0);
});
