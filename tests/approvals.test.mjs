import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApprovalBroker, installApprovalIpc } from '../electron/approvals.cjs';

function fakeSender(id = 1) {
  const sent = [];
  return {
    id,
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

test('an approval reaches the renderer and resolves with its decision', async () => {
  const broker = createApprovalBroker({ timeoutMs: 1000 });
  const sender = fakeSender();
  const pending = broker.ask(sender, { title: '允许修改文件？', message: '写入 a.ts' });
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].channel, 'approval:request');
  const { id } = sender.sent[0].payload;
  assert.equal(broker.pendingCount(), 1);

  assert.equal(broker.respond(id, 'once', 999), false, 'another window cannot answer');
  assert.equal(broker.respond(id, 'maybe', sender.id), false, 'unknown decisions are ignored');
  assert.equal(broker.respond(id, 'session', sender.id), true);
  assert.equal(await pending, 'session');
  assert.equal(broker.pendingCount(), 0);
});

test('a timed-out approval denies and closes the bar', async () => {
  const broker = createApprovalBroker({ timeoutMs: 20 });
  const sender = fakeSender();
  const decision = await broker.ask(sender, { message: '运行 npm test' });
  assert.equal(decision, 'deny');
  assert.equal(sender.sent.at(-1).channel, 'approval:close');
});

test('cancelling a window denies everything it still has open', async () => {
  const broker = createApprovalBroker({ timeoutMs: 5000 });
  const sender = fakeSender(7);
  const first = broker.ask(sender, { message: 'a' });
  const second = broker.ask(sender, { message: 'b' });
  assert.equal(broker.pendingCount(), 2);
  broker.cancelSender(7);
  assert.equal(await first, 'deny');
  assert.equal(await second, 'deny');
  assert.equal(broker.pendingCount(), 0);
});

test('a destroyed window is denied without sending anything', async () => {
  const broker = createApprovalBroker();
  const sender = { id: 3, isDestroyed: () => true, send: () => { throw new Error('should not send'); } };
  assert.equal(await broker.ask(sender, { message: 'x' }), 'deny');
});

test('approval IPC authorizes the sender and reports expired ids', async () => {
  const broker = createApprovalBroker({ timeoutMs: 1000 });
  const handlers = new Map();
  installApprovalIpc(() => { throw new Error('no'); }, {
    broker, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  });
  assert.deepEqual(await handlers.get('approval:respond')({ sender: { id: 1 } }, 'id', 'once'), { ok: false, error: 'unauthorized' });

  const allowed = new Map();
  installApprovalIpc(() => ({}), { broker, ipcMain: { handle: (name, callback) => allowed.set(name, callback) } });
  const respond = allowed.get('approval:respond');
  assert.deepEqual(await respond({ sender: { id: 1 } }, 'missing', 'once'), { ok: false, error: 'expired' });

  const sender = fakeSender(4);
  const pending = broker.ask(sender, { message: 'x' });
  const { id } = sender.sent.at(-1).payload;
  assert.deepEqual(await respond({ sender: { id: 4 } }, id, 'deny'), { ok: true });
  assert.equal(await pending, 'deny');
});

test('an already cancelled run is denied without showing a bar', async () => {
  const broker = createApprovalBroker({ timeoutMs: 1000 });
  const sender = fakeSender();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await broker.ask(sender, { message: '写入 a.ts' }, controller.signal), 'deny');
  assert.deepEqual(sender.sent, [], 'nothing is sent for a request that cannot be answered');
  assert.equal(broker.pendingCount(), 0);
});

test('cancelling the run closes its pending approval and refuses a late answer', async () => {
  const broker = createApprovalBroker({ timeoutMs: 5000 });
  const sender = fakeSender(5);
  const controller = new AbortController();
  const pending = broker.ask(sender, { message: '运行 npm test' }, controller.signal);
  assert.equal(broker.pendingCount(), 1);
  const { id } = sender.sent[0].payload;

  controller.abort();
  assert.equal(await pending, 'deny');
  assert.deepEqual(sender.sent.at(-1), { channel: 'approval:close', payload: { id } });
  assert.equal(broker.pendingCount(), 0);
  assert.equal(broker.respond(id, 'once', 5), false, 'a cancelled request can no longer be allowed');
});

test('a settled approval removes its abort listener', async () => {
  const broker = createApprovalBroker({ timeoutMs: 5000 });
  const sender = fakeSender(9);
  const calls = [];
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (type, listener) => { calls.push(['add', type]); listeners.add(listener); },
    removeEventListener: (type, listener) => { calls.push(['remove', type]); listeners.delete(listener); },
  };
  const pending = broker.ask(sender, { message: '写入 b.ts' }, signal);
  assert.deepEqual(calls, [['add', 'abort']]);
  assert.equal(listeners.size, 1);

  const { id } = sender.sent[0].payload;
  assert.equal(broker.respond(id, 'once', 9), true);
  assert.equal(await pending, 'once');
  assert.deepEqual(calls, [['add', 'abort'], ['remove', 'abort']]);
  assert.equal(listeners.size, 0, 'the run no longer settles a finished request');
});
