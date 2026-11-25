const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createStorageState, originOf } = require('./storage-state.cjs');

function fakeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'mova-storage-'));
  return { dir, getPath: () => dir };
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: buffer => buffer.toString().replace(/^enc:/, ''),
  };
}

function fakeTarget(url = 'https://shop.test/login') {
  const cookies = [{ name: 'sid', value: 'abc', domain: 'shop.test', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }];
  let storage = { token: 't1', theme: 'dark' };
  return {
    url,
    cookies,
    get storage() { return storage; },
    set storage(value) { storage = value; },
    guest: {
      session: {
        cookies: {
          async get() { return cookies; },
          async set(cookie) { cookies.push(cookie); },
        },
      },
    },
    async evaluate(expression) {
      if (expression.includes('Object.fromEntries')) return JSON.stringify(storage);
      const match = expression.match(/const data = (.*?); for/);
      if (match) storage = JSON.parse(match[1]);
      return true;
    },
  };
}

test('normalizes origins', () => {
  assert.equal(originOf('https://shop.test/login?x=1'), 'https://shop.test');
  assert.equal(originOf('file:///tmp/a'), '');
  assert.equal(originOf('not a url'), '');
});

test('exports encrypted state without returning values', async () => {
  const app = fakeApp();
  const state = createStorageState({ app, safeStorage: fakeSafeStorage() });
  const target = fakeTarget();
  const result = await state.exportState(target);
  assert.equal(result.origin, 'https://shop.test');
  assert.equal(result.cookies, 1);
  assert.equal(result.localStorageKeys, 2);
  assert.equal(JSON.stringify(result).includes('abc'), false);
  const encrypted = readFileSync(result.path, 'utf8');
  assert.equal(encrypted.includes('shop.test'), false);
});

test('imports cookies and localStorage for the same origin', async () => {
  const app = fakeApp();
  const safeStorage = fakeSafeStorage();
  const state = createStorageState({ app, safeStorage });
  const source = fakeTarget();
  await state.exportState(source);

  const target = fakeTarget();
  target.cookies.length = 0;
  target.storage = {};
  const result = await state.importState(target);
  assert.equal(result.origin, 'https://shop.test');
  assert.equal(result.cookies, 1);
  assert.equal(result.localStorageKeys, 2);
  assert.equal(target.cookies[0].name, 'sid');
  assert.deepEqual(target.storage, { token: 't1', theme: 'dark' });
});

test('refuses to import into another origin', async () => {
  const app = fakeApp();
  const state = createStorageState({ app, safeStorage: fakeSafeStorage() });
  await state.exportState(fakeTarget());
  await assert.rejects(state.importState(fakeTarget('https://evil.test/login')), /其他站点/);
});
