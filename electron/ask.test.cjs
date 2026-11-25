const test = require('node:test');
const assert = require('node:assert/strict');
const { createAskBroker } = require('./ask.cjs');

test('ask responses belong to the requesting window and cancellation closes the card', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const events = [];
  const sender = { send: (...args) => events.push(args), isDestroyed: () => false };
  const other = { send() {}, isDestroyed: () => false };
  const broker = createAskBroker({ ipcMain, authorize: () => {} });
  const controller = new AbortController();
  const answer = broker.ask(sender, { question: 'Continue?' }, controller.signal);
  const id = events[0][1].id;
  assert.equal(await handlers.get('ask:respond')({ sender: other }, id, 'yes'), false);
  assert.equal(await handlers.get('ask:respond')({ sender }, id, 'yes'), true);
  assert.equal(await answer, 'yes');
  assert.deepEqual(events.at(-1), ['ask:close', id]);

  const pending = broker.ask(sender, { question: 'Next?' }, controller.signal);
  controller.abort();
  assert.equal(await pending, '');
});
