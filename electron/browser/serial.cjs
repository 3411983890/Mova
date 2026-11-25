'use strict';
// A tiny per-target serial queue. Two chat runs that touch the same tab must
// not interleave clicks; different tabs still run in parallel.

function createSerialQueue() {
  let tail = Promise.resolve();
  return function run(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}

module.exports = { createSerialQueue };
