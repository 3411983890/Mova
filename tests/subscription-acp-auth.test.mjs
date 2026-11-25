// ACP 侧的纯逻辑：模型清单、登录方式、挑哪个登录方式。
// 真实形状来自本机 agy 1.5.8 的实测输出（initialize.authMethods / session.new.models）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeAcpModels, normalizeAuthMethods, pickGoogleMethod, readAcpTier, acpForceRelogin,
} from '../electron/subscription/acp-auth.mjs';

test('normalizeAcpModels reads models.availableModels into catalog entries', () => {
  const models = normalizeAcpModels({
    currentModelId: 'gemini-4-argon-medium',
    availableModels: [
      { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
      { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    ],
  });
  assert.deepEqual(models, [
    { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  ]);
});

test('normalizeAcpModels drops unusable rows and de-dupes ids', () => {
  const models = normalizeAcpModels({
    availableModels: [
      { modelId: 'a', name: 'A' },
      { modelId: 'a', name: 'A again' },
      { modelId: '', name: 'no id' },
      { name: 'no modelId' },
      null,
    ],
  });
  assert.deepEqual(models, [{ id: 'a', label: 'A' }], '认不出的条目宁可丢掉，也不能给个点下去报错的 id');
});

test('normalizeAcpModels tolerates every degenerate input', () => {
  assert.deepEqual(normalizeAcpModels(null), []);
  assert.deepEqual(normalizeAcpModels({}), []);
  assert.deepEqual(normalizeAcpModels({ availableModels: 'nope' }), []);
  // name 缺失时用 id 当显示名，不能留空。
  assert.deepEqual(normalizeAcpModels({ availableModels: [{ modelId: 'x' }] }), [{ id: 'x', label: 'x' }]);
});

test('normalizeAuthMethods keeps the ids the agent actually advertises', () => {
  const methods = normalizeAuthMethods([
    { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
    { id: 'gemini-api-key', name: 'Gemini API key' },
    { id: '' },
    null,
  ]);
  assert.deepEqual(methods.map(method => method.id), ['oauth-personal', 'gemini-api-key']);
  // 缺 type 按规范当 agent（需要显式 authenticate）。
  assert.equal(methods[0].type, 'agent');
});

test('pickGoogleMethod prefers the personal Google flow', () => {
  const methods = normalizeAuthMethods([
    { id: 'agent-platform', name: 'Vertex' },
    { id: 'oauth-business', name: 'Enterprise' },
    { id: 'oauth-personal', name: 'Log in with Google' },
  ]);
  assert.equal(pickGoogleMethod(methods).id, 'oauth-personal');
});

test('pickGoogleMethod falls back to enterprise, then to nothing', () => {
  assert.equal(
    pickGoogleMethod(normalizeAuthMethods([{ id: 'oauth-business', name: 'Enterprise' }])).id,
    'oauth-business',
  );
  assert.equal(pickGoogleMethod(normalizeAuthMethods([{ id: 'gemini-api-key', name: 'key' }])), null);
  assert.equal(pickGoogleMethod([]), null);
  assert.equal(pickGoogleMethod(undefined), null);
});

// ── 套餐名与「强制重新授权」 ──────────────────────────────────────────
test('readAcpTier reads _meta.antigravity.tier from a real session/new result', () => {
  const session = { _meta: { antigravity: { tier: { name: 'Google AI Pro', id: 'g1-pro-tier' } } } };
  assert.deepEqual(readAcpTier(session), { id: 'g1-pro-tier', name: 'Google AI Pro' });
});

test('readAcpTier degrades to null instead of inventing a plan', () => {
  assert.equal(readAcpTier(null), null);
  assert.equal(readAcpTier({}), null);
  assert.equal(readAcpTier({ _meta: {} }), null);
  assert.equal(readAcpTier({ _meta: { antigravity: { tier: {} } } }), null);
  // 只有名字时用名字当显示名，id 留空（不伪造一个假 id）。
  assert.deepEqual(readAcpTier({ _meta: { antigravity: { tier: { name: 'Free' } } } }), { id: '', name: 'Free' });
});

test('force relogin logs out first, then authenticates in a fresh step', async () => {
  const order = [];
  const result = await acpForceRelogin({
    logout: async options => { order.push(['logout', options.methodId ?? null]); return { ok: true, detail: '' }; },
    authenticate: async options => {
      order.push(['authenticate', options.methodId]);
      return { ok: true, models: [{ id: 'm', label: 'M' }], tier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, detail: '' };
    },
  });
  assert.deepEqual(order, [['logout', null], ['authenticate', 'oauth-personal']]);
  assert.equal(result.ok, true);
  assert.equal(result.loggedOut, true);
  assert.equal(result.methodId, 'oauth-personal');
  assert.deepEqual(result.models, [{ id: 'm', label: 'M' }]);
  assert.equal(result.tier.name, 'Google AI Pro');
});

test('a failing logout does not block the authorization', async () => {
  const result = await acpForceRelogin({
    logout: async () => ({ ok: false, detail: 'not logged in' }),
    authenticate: async () => ({ ok: true, models: [{ id: 'm', label: 'M' }], tier: null, detail: '' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.loggedOut, false);
  assert.equal(result.logoutDetail, 'not logged in');
});

test('force relogin keeps a caller-chosen method id and reports a failed authorization', async () => {
  let used = '';
  const result = await acpForceRelogin({
    methodId: 'oauth-business',
    logout: async () => { throw new Error('boom'); },
    authenticate: async options => { used = options.methodId; return { ok: false, models: [], detail: 'no models' }; },
  });
  assert.equal(used, 'oauth-business');
  assert.equal(result.ok, false);
  assert.equal(result.models.length, 0);
  assert.match(result.logoutDetail, /boom/);
});
