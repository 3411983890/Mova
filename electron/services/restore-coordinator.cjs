'use strict';

// Process-local admission and drain. The external lease is mandatory: it must
// exclude all other database clients (including other Mova processes) until
// its returned release function completes. A local gate cannot guarantee that.
function createRestoreCoordinator({ acquireExclusive } = {}) {
  let stopping = false;
  let active = 0;
  let drained = null;
  let closed = false;
  const waiters = new Set();

  async function run(work) {
    if (closed) throw Object.assign(new Error('runtime-closed'), { code: 'runtime-closed' });
    if (stopping) throw Object.assign(new Error('restore-in-progress'), { code: 'restore-in-progress' });
    active += 1;
    try { return await work(); }
    finally {
      active -= 1;
      if (!active && drained) { const notify = drained; drained = null; notify(); }
    }
  }

  async function runWorker(work) {
    while (stopping && !closed) await new Promise(resolve => waiters.add(resolve));
    return run(work);
  }

  function wakeWaiters() {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  function close() {
    closed = true;
    wakeWaiters();
  }

  async function stopWrites(info) {
    if (stopping) throw Object.assign(new Error('restore-in-progress'), { code: 'restore-in-progress' });
    if (typeof acquireExclusive !== 'function') throw new Error('external-exclusive-coordination-required');
    stopping = true;
    if (active) await new Promise(resolve => { drained = resolve; });
    // An acquisition failure may have partially acquired an external lock.
    // Without a valid release there is no proof that reopening is safe.
    const release = await acquireExclusive(info);
    if (typeof release !== 'function') throw new Error('exclusive-coordinator-must-return-release');
    let released = false;
    return async () => {
      if (released) return;
      // If release fails, remain closed: we cannot assert the system is safe.
      await release();
      released = true;
      stopping = false;
      wakeWaiters();
    };
  }
  return { run, runWorker, stopWrites, close };
}

// Gate all methods, not just an allowlist of presumed writers: even apparently
// read-only methods may update caches or enqueue work.
function gateMethods(target, coordinator, excluded = []) {
  const cache = new Map();
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function' || excluded.includes(property)) return value;
      if (!cache.has(property) || cache.get(property).original !== value) {
        cache.set(property, { original: value, wrapped: (...args) => coordinator.run(() => value.apply(object, args)) });
      }
      return cache.get(property).wrapped;
    },
  });
}

module.exports = { createRestoreCoordinator, gateMethods };
