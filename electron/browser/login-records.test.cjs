const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createLoginRecords } = require('./login-records.cjs');

function fakeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'mova-login-records-'));
  return { getPath: () => dir };
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: buffer => buffer.toString().replace(/^enc:/, ''),
  };
}

function fakeTarget() {
  const cookies = [{ name: 'sid', value: 'abc', domain: 'shop.test', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }];
  let storage = { token: 't1' };
  return {
    url: 'https://shop.test/account',
    cookies,
    get storage() { return storage; },
    set storage(value) { storage = value; },
    guest: { session: { cookies: { async get() { return cookies; }, async set(cookie) { cookies.push(cookie); } } } },
    async evaluate(expression) {
      if (expression.includes('Object.fromEntries')) return JSON.stringify(storage);
      const match = expression.match(/const data = (.*?); for/);
      if (match) storage = JSON.parse(match[1]);
      return true;
    },
  };
}

test('saves and restores per-origin cookies', async () => {
  const records = createLoginRecords({ app: fakeApp(), safeStorage: fakeSafeStorage() });
  const source = fakeTarget();
  const saved = await records.save('https://shop.test', source);
  assert.equal(saved.cookies, 1);
  assert.equal(await records.has('https://shop.test'), true);
  assert.equal(await records.has('https://other.test'), false);

  const target = fakeTarget();
  target.cookies.length = 0;
  target.storage = {};
  const applied = await records.apply('https://shop.test', target);
  assert.equal(applied.cookies, 1);
  assert.equal(target.cookies[0].name, 'sid');
  assert.deepEqual(target.storage, { token: 't1' });
});

test('refuses an origin with no record', async () => {
  const records = createLoginRecords({ app: fakeApp(), safeStorage: fakeSafeStorage() });
  await assert.rejects(records.apply('https://missing.test', fakeTarget()), /没有可用/);
});

test('conversation scope keeps records inside their own conversation', async () => {
  const records = createLoginRecords({ app: fakeApp(), safeStorage: fakeSafeStorage() });
  const target = fakeTarget();

  // 默认为「当前对话」范围：带着会话标识保存，只有同一会话能复用它。
  await records.save(target.url, target, { conversationId: 'conv-a' });
  assert.equal(await records.has(target.url, 'conv-a'), true);
  assert.equal(await records.has(target.url, 'conv-b'), false, '别的对话不能复用');
  await assert.rejects(records.apply(target.url, target, { conversationId: 'conv-b' }), /另一个对话/);

  // 「所有对话」范围用 null，任意调用方都能复用。
  await records.save(target.url, target, { conversationId: null });
  assert.equal(await records.has(target.url, 'conv-b'), true);
  await records.apply(target.url, target, { conversationId: 'conv-b' });
});
