const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCredentialBroker, normalizeOrigin, maskUsername } = require('./credentials.cjs');

function fakeVault() {
  const entries = new Map();
  return {
    entries,
    async status() { return { configured: true, unlocked: true, count: entries.size }; },
    async put(input) { entries.set(input.name, input.value); return { updatedAt: '2026-11-11T00:00:00Z' }; },
    async get(name) {
      if (!entries.has(name)) { const error = new Error('not-found'); error.code = 'not-found'; throw error; }
      return entries.get(name);
    },
    async list() {
      return [...entries.keys()].map(name => ({ name, kind: 'password', preview: '****', updatedAt: '2026-11-11T00:00:00Z' }));
    },
  };
}

function fakeTarget() {
  const calls = [];
  let evaluates = 0;
  return {
    url: 'https://shop.test/login',
    calls,
    cdp: {
      async send(method, params) {
        calls.push([method, params]);
        if (method === 'Runtime.evaluate') {
          evaluates += 1;
          if (evaluates === 1) return { result: { objectId: 'pwd' } };
          if (evaluates === 2) return { result: { objectId: 'user' } };
          return { result: { value: 'button' } };
        }
        return { result: { value: true } };
      },
    },
  };
}

test('normalizes origins and masks usernames', () => {
  assert.equal(normalizeOrigin('https://shop.test/login?x=1'), 'https://shop.test');
  assert.equal(normalizeOrigin('file:///tmp/x'), '');
  assert.equal(maskUsername('alice'), 'a***e');
  assert.equal(maskUsername('ab'), '**');
});

test('saves username and password in one vault entry without newlines', async () => {
  const vault = fakeVault();
  const broker = createCredentialBroker({ getVault: () => vault });
  const saved = await broker.save({ origin: 'https://shop.test/login', username: 'alice', password: 'secret' });
  assert.equal(saved.ok, true);
  assert.equal(saved.username, 'a***e');
  assert.equal(vault.entries.get('browser:https://shop.test'), 'alice\nsecret');
  await assert.rejects(broker.save({ origin: 'https://shop.test', username: 'a\nb', password: 'x' }), /newlines/);
  await assert.rejects(broker.save({ origin: 'file:///x', username: 'a', password: 'x' }), /http/);
});

test('lists only browser entries and reads them back', async () => {
  const vault = fakeVault();
  const broker = createCredentialBroker({ getVault: () => vault });
  await broker.save({ origin: 'https://shop.test', username: 'alice', password: 'secret' });
  await vault.put({ name: 'github', value: 'not-a-browser-entry' });
  const list = await broker.list();
  assert.deepEqual(list.map(item => item.origin), ['https://shop.test']);
  assert.deepEqual(await broker.read('https://shop.test'), { origin: 'https://shop.test', username: 'alice', password: 'secret' });
});

test('fill focuses the username, then the password, and never puts the password in an expression', async () => {
  const vault = fakeVault();
  const broker = createCredentialBroker({ getVault: () => vault });
  await broker.save({ origin: 'https://shop.test', username: 'alice', password: 'secret' });
  const target = fakeTarget();
  const filled = await broker.fill(target, { origin: 'https://shop.test' });
  assert.equal(filled.ok, true);
  assert.equal(filled.username, 'a***e');
  const writes = target.calls
    .filter(call => call[0] === 'Runtime.callFunctionOn')
    .map(call => call[1].arguments?.[0]?.value)
    .filter(Boolean);
  assert.deepEqual(writes, ['alice', 'secret']);
  for (const [method, params] of target.calls) {
    if (method !== 'Runtime.evaluate') continue;
    assert.doesNotMatch(String(params.expression), /secret|alice/);
  }
});

test('refuses to fill after a cross-origin redirect and when no password field exists', async () => {
  const vault = fakeVault();
  const broker = createCredentialBroker({ getVault: () => vault });
  await broker.save({ origin: 'https://shop.test', username: 'alice', password: 'secret' });
  const target = fakeTarget();
  target.url = 'https://evil.test/login';
  await assert.rejects(broker.fill(target, { origin: 'https://shop.test' }), /跳转/);

  const noField = fakeTarget();
  noField.cdp.send = async method => {
    if (method === 'Runtime.evaluate') return { result: { value: { ok: false, reason: 'no-password' } } };
    return {};
  };
  await assert.rejects(broker.fill(noField, { origin: 'https://shop.test' }), /密码框/);
});

test('reports a locked vault and a missing credential distinctly', async () => {
  const locked = {
    async status() { return { configured: true, unlocked: false, count: 1 }; },
    async put() { const error = new Error('locked'); error.code = 'vault-locked'; throw error; },
    async get() { const error = new Error('locked'); error.code = 'vault-locked'; throw error; },
    async list() { const error = new Error('locked'); error.code = 'vault-locked'; throw error; },
  };
  const broker = createCredentialBroker({ getVault: () => locked });
  await assert.rejects(broker.read('https://shop.test'), /锁定/);
  const missing = createCredentialBroker({ getVault: () => fakeVault() });
  await assert.rejects(missing.read('https://shop.test'), /还没有保存/);
  const unavailable = createCredentialBroker({ getVault: () => null });
  const status = await unavailable.status();
  assert.equal(status.ok, false);
});
