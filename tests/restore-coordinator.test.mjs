import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRestoreCoordinator, gateMethods } = require('../electron/services/restore-coordinator.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('drains foreground and background operations, rejects new work and releases in order', async () => {
  const a = deferred(), b = deferred(), lease = deferred();
  const events = [];
  const coordinator = createRestoreCoordinator({ acquireExclusive: async () => {
    events.push('acquire');
    await lease.promise;
    return async () => { events.push('release'); };
  } });
  const repo = gateMethods({ write: () => a.promise }, coordinator);
  const foreground = repo.write();
  const background = coordinator.run(() => b.promise);
  const stopping = coordinator.stopWrites({ reason: 'restore' });
  await assert.rejects(repo.write(), { code: 'restore-in-progress' });
  await assert.rejects(coordinator.stopWrites({}), { code: 'restore-in-progress' });
  a.resolve(); await foreground;
  assert.deepEqual(events, []);
  b.resolve(); await background;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['acquire']);
  await assert.rejects(coordinator.run(() => {}), { code: 'restore-in-progress' });
  lease.resolve();
  const resume = await stopping;
  await resume(); await resume();
  assert.deepEqual(events, ['acquire', 'release']);
  assert.equal(await coordinator.run(() => 42), 42);
});

test('requires an external lease and remains closed on uncertain acquisition', async () => {
  const noLease = createRestoreCoordinator();
  await assert.rejects(noLease.stopWrites({}), /external-exclusive-coordination-required/);
  assert.equal(await noLease.run(() => 1), 1);
  const failing = createRestoreCoordinator({ acquireExclusive: async () => { throw Error('busy'); } });
  await assert.rejects(failing.stopWrites({}), /busy/);
  await assert.rejects(failing.run(() => 2), { code: 'restore-in-progress' });
  const invalid = createRestoreCoordinator({ acquireExclusive: async () => undefined });
  await assert.rejects(invalid.stopWrites({}), /must-return-release/);
  await assert.rejects(invalid.run(() => 2), { code: 'restore-in-progress' });
});

test('worker jobs wait without consuming retries until restore releases', async () => {
  const coordinator = createRestoreCoordinator({ acquireExclusive: async () => async () => {} });
  const resume = await coordinator.stopWrites({});
  let ran = false;
  const job = coordinator.runWorker(() => { ran = true; return 42; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ran, false);
  await resume();
  assert.equal(await job, 42);
  assert.equal(ran, true);
});

test('shutdown wakes workers stranded by an uncertain lease', async () => {
  const coordinator = createRestoreCoordinator({ acquireExclusive: async () => async () => { throw Error('release failed'); } });
  const resume = await coordinator.stopWrites({});
  await assert.rejects(resume(), /release failed/);
  const job = coordinator.runWorker(() => 1);
  coordinator.close();
  await assert.rejects(job, { code: 'runtime-closed' });
});

test('release failure keeps local writes blocked', async () => {
  const coordinator = createRestoreCoordinator({ acquireExclusive: async () => async () => { throw Error('release failed'); } });
  const resume = await coordinator.stopWrites({});
  await assert.rejects(resume(), /release failed/);
  await assert.rejects(coordinator.run(() => {}), { code: 'restore-in-progress' });
});

test('failed in-flight operation still drains', async () => {
  const operation = deferred();
  const coordinator = createRestoreCoordinator({ acquireExclusive: async () => () => {} });
  const work = coordinator.run(async () => { await operation.promise; throw Error('write failed'); });
  const stopping = coordinator.stopWrites({});
  operation.resolve();
  await assert.rejects(work, /write failed/);
  await (await stopping)();
});
