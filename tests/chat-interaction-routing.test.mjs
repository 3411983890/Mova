import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createInteractionRouter } from '../src/features/chat/interaction-router.mjs';
import { recoverModelSelection } from '../src/features/chat/model-selection.mjs';
import { installInteractionNotifications, conversationFromSessionKey } from '../electron/interaction-notifications.cjs';

function fixture() {
  const notifications = [], dismissed = [], opened = [], closed = [], replies = [];
  const router = createInteractionRouter({ notify: item => notifications.push(item), dismiss: id => dismissed.push(id) });
  let request, close;
  const channel = router.channel({
    onRequest(fn) { request = fn; return () => {}; },
    onClose(fn) { close = fn; return () => {}; },
    async respond(...args) { replies.push(args); return true; },
  }, 'ask');
  channel.onRequest(item => opened.push(item.id));
  channel.onClose(item => closed.push(item.id));
  const context = (conversationId, visible = true) => router.setContext({ conversationId, visible });
  return { router, channel, request: item => request(item), close: id => close(id), context, notifications, dismissed, opened, closed, replies };
}

test('background requests stay out of the current chat and notify only once', () => {
  const f = fixture();
  f.context('A');
  f.request({ id: 'q', conversationId: 'B' });
  f.context('A');
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.notifications, [{ id: 'ask:q', conversationId: 'B', kind: 'ask' }]);
  f.context('B');
  assert.deepEqual(f.opened, ['q']);
  assert.ok(f.dismissed.includes('ask:q'));
  f.context('A');
  assert.deepEqual(f.closed, ['q']);
  f.context('B');
  assert.deepEqual(f.opened, ['q', 'q']);
});

test('blur/settings hide the request without answering it; focus restores it', async () => {
  const f = fixture();
  f.context('A');
  f.request({ id: 'q', conversationId: 'A' });
  f.context('A', false);
  assert.deepEqual(f.closed, ['q']);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(await f.channel.respond('q', 'stale click'), { ok: false, error: 'inactive-chat' });
  assert.deepEqual(f.replies, []);
  f.context('A');
  await f.channel.respond('q', 'answer');
  assert.deepEqual(f.replies, [['q', 'answer']]);
  assert.deepEqual(f.closed, ['q', 'q']);
});

test('expired background requests never reappear and clear their notification', () => {
  const f = fixture();
  f.context('A');
  f.request({ id: 'q', conversationId: 'B' });
  f.close('q');
  f.context('B');
  assert.deepEqual(f.opened, []);
  assert.ok(f.dismissed.includes('ask:q'));
});

test('approval and question channels keep independent pending queues', () => {
  const f = fixture();
  let requestApproval;
  const shown = [], hidden = [];
  const approvals = f.router.channel({ onRequest(fn) { requestApproval = fn; } }, 'approval');
  approvals.onRequest(item => shown.push(item.id));
  approvals.onClose(item => hidden.push(item.id));
  f.context('A');
  f.request({ id: 'q', conversationId: 'A' });
  requestApproval({ id: 'p', conversationId: 'B' });
  assert.deepEqual(shown, []);
  f.context('B');
  assert.deepEqual(f.closed, ['q']);
  assert.deepEqual(shown, ['p']);
  f.context('A');
  assert.deepEqual(hidden, ['p']);
});

const entries = [
  { providerId: 'one', model: { id: 'a' } },
  { providerId: 'two', model: { id: 'b' } },
  { providerId: 'three', model: { id: 'b' } },
];
test('legacy chats recover their own last model instead of another chat default', () => {
  assert.deepEqual(recoverModelSelection([{ reply: { model: 'b' } }], entries, { providerId: 'one', modelId: 'a' }), { providerId: 'two', modelId: 'b' });
  assert.deepEqual(recoverModelSelection([{ reply: { model: 'b', providerId: 'three' } }], entries), { providerId: 'three', modelId: 'b' });
  assert.deepEqual(recoverModelSelection([], entries, { providerId: 'two', modelId: 'b' }), { providerId: 'two', modelId: 'b' });
  assert.equal(recoverModelSelection([], [], null), null);
});

function notificationFixture() {
  const handlers = {}, instances = [];
  const sender = new EventEmitter();
  sender.id = 1;
  sender.isDestroyed = () => false;
  const sent = [], actions = [];
  sender.send = (...args) => sent.push(args);
  const win = {
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus'),
  };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor() { super(); instances.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; }
  }
  installInteractionNotifications({ ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, Notification, authorize: () => win });
  return { handlers, sender, sent, actions, instances };
}
test('system notification focuses only on click and routes to the owning chat', () => {
  const f = notificationFixture();
  const input = { id: 'ask:q', conversationId: '["CodeMova","P","B"]', kind: 'ask' };
  assert.equal(f.handlers['interaction:notify']({ sender: f.sender }, input), true);
  assert.deepEqual(f.actions, []);
  f.instances[0].emit('click');
  assert.deepEqual(f.actions, ['restore', 'show', 'focus']);
  assert.deepEqual(f.sent, [['interaction:open', input.conversationId]]);
  assert.equal(f.instances[0].closed, true);
});
test('dismissed notifications cannot route a stale click; sender cleanup closes notifications', () => {
  const f = notificationFixture();
  const event = { sender: f.sender };
  f.handlers['interaction:notify'](event, { id: 'q', conversationId: 'B' });
  f.handlers['interaction:dismiss'](event, 'q');
  f.instances[0].emit('click');
  assert.deepEqual(f.sent, []);
  f.handlers['interaction:notify'](event, { id: 'p', conversationId: 'B' });
  f.sender.emit('destroyed');
  assert.equal(f.instances[1].closed, true);
});
test('permission approval session key preserves the exact chat identity', () => {
  const id = '["CodeMova","P","title:with:colons"]';
  assert.equal(conversationFromSessionKey(`7:${JSON.stringify([id, 'default', []])}`), id);
  assert.equal(conversationFromSessionKey('invalid'), null);
});
