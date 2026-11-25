/**
 * ChatGPT OAuth 纯逻辑测试（§7.1 / §8.1）。
 *
 * 全部用注入的 fetch / verify / now，因此不需要网络与真 RSA：
 * 这样验签失败、过期、scope 被收回这些分支才能被稳定复现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  AGENT_NAME,
  CHATGPT_ISSUER,
  CHATGPT_CLIENT_ID,
  CHATGPT_REDIRECT_URI,
  CHATGPT_SCOPE,
  EXPIRY_MARGIN_MS,
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  isUsable,
  parseCallback,
  refreshAccessToken,
  validateIdToken,
} from '../electron/subscription/login.mjs';

/** 构造一个只需要被 base64url 解析的假 JWT（签名不参与断言）。 */
function fakeJwt(header, payload, signature = 'sig') {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode(payload)}.${Buffer.from(signature).toString('base64url')}`;
}

const HAPPY_HEADER = { alg: 'RS256', kid: 'k1' };
const JWKS = [{ kid: 'k1', kty: 'RSA', n: 'x', e: 'AQAB' }];

function happyClaims(overrides = {}) {
  return {
    iss: CHATGPT_ISSUER,
    aud: 'oaiapp_test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: 'n-1',
    sub: 'user-1',
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('createPkce: challenge 是 verifier 的 base64url(sha256)，state 与 nonce 各自独立', () => {
  let counter = 0;
  const pkce = createPkce({ random: size => Buffer.alloc(size, ++counter) });
  const expected = createHash('sha256').update(pkce.verifier).digest('base64url');
  assert.equal(pkce.challenge, expected, 'challenge 必须是 S256');
  assert.ok(pkce.state.length > 0, 'state 不能为空');
  assert.ok(pkce.nonce.length > 0, 'nonce 不能为空');
  assert.notEqual(pkce.state, pkce.nonce, 'state 与 nonce 不能相同');
});

test('buildAuthorizeUrl: 参数与 Codex 公开客户端逐字对齐', () => {
  const pkce = { verifier: 'v', challenge: 'c', state: 's', nonce: 'n' };
  const url = new URL(buildAuthorizeUrl({
    clientId: CHATGPT_CLIENT_ID, redirectUri: CHATGPT_REDIRECT_URI, pkce,
  }));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(url.searchParams.get('scope'), CHATGPT_SCOPE);
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'c');
  assert.equal(url.searchParams.get('state'), 's');
  assert.equal(url.searchParams.get('originator'), AGENT_NAME);
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  // 这两项属于「Sign in with ChatGPT → api.openai.com」那条实验流程，签出来的令牌不被订阅接口接受。
  assert.equal(url.searchParams.get('resource'), null, '不能带 resource');
  assert.equal(url.searchParams.get('nonce'), null, '不能带 nonce');
});

test('buildAuthorizeUrl: 缺 clientId / redirectUri / pkce 直接报错', () => {
  const pkce = { challenge: 'c', state: 's', nonce: 'n', verifier: 'v' };
  assert.throws(
    () => buildAuthorizeUrl({ redirectUri: 'http://127.0.0.1:1/cb', pkce }),
    error => error.code === 'request',
  );
  assert.throws(
    () => buildAuthorizeUrl({ clientId: 'x', redirectUri: 'http://127.0.0.1:1/cb' }),
    error => error.code === 'request',
  );
});

test('parseCallback: state 不匹配归 auth_cancelled，error 归 auth_denied', () => {
  assert.throws(
    () => parseCallback({ state: 'other', code: 'c' }, { state: 'expect' }),
    error => error.code === 'auth_cancelled',
  );
  assert.throws(
    () => parseCallback({ error: 'access_denied' }, { state: 'expect' }),
    error => error.code === 'auth_denied',
  );
  assert.throws(
    () => parseCallback({ state: 'expect' }, { state: 'expect' }),
    error => error.code === 'auth_cancelled',
    '缺 code 也要拒绝',
  );
});

test('parseCallback: 正常回调返回 code 与 client_id', () => {
  const result = parseCallback(
    new URLSearchParams({ state: 's', code: 'the-code', client_id: 'oaiapp_x' }),
    { state: 's' },
  );
  assert.deepEqual(result, { code: 'the-code', clientId: 'oaiapp_x' });
});

test('parseCallback: redirect_uri 不一致时拒绝（防换地址攻击）', () => {
  assert.throws(
    () => parseCallback(
      { state: 's', code: 'c', redirect_uri: 'http://evil/cb' },
      { state: 's', redirectUri: 'http://127.0.0.1:1/cb' },
    ),
    error => error.code === 'auth_denied',
  );
});

test('exchangeCode: 请求体字段正确，expiresAt 由 now + expires_in 推出', async () => {
  let seenBody = null;
  const fetch = async (url, init) => {
    assert.match(url, /\/oauth\/token$/);
    seenBody = new URLSearchParams(init.body);
    return jsonResponse({ access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 1800, scope: CHATGPT_SCOPE });
  };
  const record = await exchangeCode({
    fetch, code: 'c', verifier: 'v', clientId: 'oaiapp_x', redirectUri: 'http://127.0.0.1:1/cb', now: () => 1000,
  });
  assert.equal(seenBody.get('grant_type'), 'authorization_code');
  assert.equal(seenBody.get('code_verifier'), 'v');
  assert.equal(seenBody.get('redirect_uri'), 'http://127.0.0.1:1/cb');
  assert.equal(seenBody.get('resource'), null, '换 token 也不能带 resource');
  assert.equal(record.access, 'at');
  assert.equal(record.refresh, 'rt');
  assert.equal(record.expiresAt, 1000 + 1800_000);
});

test('exchangeCode: 400 归 auth_expired，429 归 rate_limited', async () => {
  await assert.rejects(
    exchangeCode({
      fetch: async () => jsonResponse({ error: 'invalid_grant' }, 400),
      code: 'c', verifier: 'v', clientId: 'x', redirectUri: 'http://127.0.0.1:1/cb',
    }),
    error => error.code === 'auth_expired',
  );
  await assert.rejects(
    exchangeCode({
      fetch: async () => jsonResponse({}, 429),
      code: 'c', verifier: 'v', clientId: 'x', redirectUri: 'http://127.0.0.1:1/cb',
    }),
    error => error.code === 'rate_limited',
  );
});

test('refreshAccessToken: Codex 令牌的 scope 里没有 chatgpt.tokens.use.direct 也照常刷新', async () => {
  let seenBody = null;
  const fetch = async (url, init) => {
    assert.match(url, /\/oauth\/token$/);
    seenBody = new URLSearchParams(init.body);
    return jsonResponse({ access_token: 'at', refresh_token: 'rt2', expires_in: 3600, scope: 'openid profile email offline_access' });
  };
  const record = await refreshAccessToken({ fetch, clientId: 'app_x', refreshToken: 'rt', now: () => 0 });
  assert.equal(record.access, 'at');
  assert.equal(record.refresh, 'rt2', '上游轮换了 refresh token 就必须带回来');
  assert.equal(seenBody.get('grant_type'), 'refresh_token');
  assert.equal(seenBody.get('resource'), null);
});

test('refreshAccessToken: 上游不再返回 refresh_token 时不覆盖旧值', async () => {
  const record = await refreshAccessToken({
    fetch: async () => jsonResponse({ access_token: 'at2', expires_in: 3600, scope: CHATGPT_SCOPE }),
    clientId: 'x', refreshToken: 'old-rt', now: () => 0,
  });
  assert.equal(record.access, 'at2');
  assert.equal('refresh' in record, false, '没轮换就不要带 refresh，调用方保留旧值');
  assert.equal(record.expiresAt, 3600_000);
});

test('validateIdToken: 正常路径返回 claims', async () => {
  const token = fakeJwt(HAPPY_HEADER, happyClaims());
  const claims = await validateIdToken({
    idToken: token, jwks: JWKS, clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => true,
  });
  assert.equal(claims.sub, 'user-1');
});

test('validateIdToken: 非 RS256 / 验签失败 / iss 不符都被拒', async () => {
  const claims = happyClaims();
  await assert.rejects(
    validateIdToken({ idToken: fakeJwt({ alg: 'none', kid: 'k1' }, claims), jwks: JWKS, clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => true }),
    error => error.code === 'auth_expired',
  );
  await assert.rejects(
    validateIdToken({ idToken: fakeJwt(HAPPY_HEADER, claims), jwks: JWKS, clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => false }),
    error => error.code === 'auth_expired',
  );
  await assert.rejects(
    validateIdToken({ idToken: fakeJwt(HAPPY_HEADER, happyClaims({ iss: 'https://evil' })), jwks: JWKS, clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => true }),
    error => error.code === 'auth_expired',
  );
});

test('validateIdToken: aud 支持数组，exp 过期与 nonce 不符都拒绝', async () => {
  const token = fakeJwt(HAPPY_HEADER, happyClaims({ aud: ['other', 'oaiapp_test'] }));
  const claims = await validateIdToken({ idToken: token, jwks: JWKS, clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => true });
  assert.equal(claims.sub, 'user-1');

  await assert.rejects(
    validateIdToken({ idToken: fakeJwt(HAPPY_HEADER, happyClaims({ exp: 1 })), jwks: JWKS, clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => true }),
    error => error.code === 'auth_expired',
  );
  await assert.rejects(
    validateIdToken({ idToken: fakeJwt(HAPPY_HEADER, happyClaims({ nonce: 'stale' })), jwks: JWKS, clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => true }),
    error => error.code === 'auth_expired',
  );
});

test('validateIdToken: JWKS 里找不到 kid 且有多把钥匙时拒绝', async () => {
  await assert.rejects(
    validateIdToken({
      idToken: fakeJwt({ alg: 'RS256', kid: 'missing' }, happyClaims()),
      jwks: [{ kid: 'a' }, { kid: 'b' }],
      clientId: 'oaiapp_test', nonce: 'n-1', verify: async () => true,
    }),
    error => error.code === 'auth_expired',
  );
});

test('isUsable: 距过期不足 60s 即视为不可用', () => {
  const now = 10_000;
  assert.equal(isUsable({ access: 'at', expiresAt: now + EXPIRY_MARGIN_MS + 1 }, now), true);
  assert.equal(isUsable({ access: 'at', expiresAt: now + EXPIRY_MARGIN_MS }, now), false);
  assert.equal(isUsable({ access: '', expiresAt: now + 10_000_000 }, now), false);
  assert.equal(isUsable(null, now), false);
});
