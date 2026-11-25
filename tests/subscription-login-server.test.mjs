/**
 * 服务版登录编排测试（§4.3 / §7.1）。
 *
 * 全部用注入的 `fetch` / `verify` / `now` / `service`，不需要网络、真 RSA 或数据库，
 * 因此「state 不匹配、flow 已用、429、nonce 不符、验签失败」这些分支都能稳定复现。
 * 与 `tests/subscription-login.test.mjs`（桌面端 `electron/subscription/login.mjs`）分工不同：
 * 那个测纯协议逻辑，这个测服务端一次性 flow 与落库编排。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  SERVER_CHATGPT_ISSUER,
  SERVER_CHATGPT_RESOURCE,
  SERVER_CHATGPT_SCOPE,
  beginServerLogin,
  buildAuthorizeUrl,
  completeServerLogin,
  exchangeCode,
  nonceForState,
  validateClaims,
} from '../electron/services/subscription-login.mjs';

const TENANT = 'tenant-acme';
const USER = 'user-ada';
const CLIENT = 'oaiapp_server_test';
const REDIRECT = 'https://mova.example.com/oauth/callback/flow-1';
const FLOW_ID = 'flow-1';
const STATE = 'state-1';
const VERIFIER = 'verifier-1';
const PROVIDER = 'chatgpt';
const T0 = Date.UTC(2026, 10, 13, 10, 0, 0);
const SUB = 'chatgpt-sub-1';
const KID = 'k-1';
// 故意用明显的占位串：夹具里不允许出现真实形态的令牌。
const ACCESS_TOKEN = 'test-access-placeholder';
const REFRESH_TOKEN = 'test-refresh-placeholder';
const ID_TOKEN = 'test-idtoken-placeholder';

const challengeOf = verifier => createHash('sha256').update(verifier, 'ascii').digest('base64url');
const sha256Hex = value => createHash('sha256').update(value, 'utf8').digest('hex');

function fakeJwt(payload, header = { alg: 'RS256', kid: KID }) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode(payload)}.${Buffer.from('test-signature').toString('base64url')}`;
}

/** 一份「刚刚签发」的 ID token claims；各用例只覆盖自己关心的那一段。 */
function claims(overrides = {}) {
  return {
    iss: SERVER_CHATGPT_ISSUER,
    aud: CLIENT,
    exp: Math.floor(T0 / 1000) + 3600,
    nonce: nonceForState(STATE),
    sub: SUB,
    email: 'ada@example.com',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    ...overrides,
  };
}

function tokenBody(overrides = {}) {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    id_token: fakeJwt(claims()),
    expires_in: 3600,
    scope: SERVER_CHATGPT_SCOPE,
    token_type: 'Bearer',
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/** 记录调用：每个用例都能断言「请求体里带了 code_verifier」「只调了一次」。 */
function fakeFetch(response) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (fn.throws) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    return typeof response === 'function' ? response(url, init) : response;
  };
  fn.calls = calls;
  fn.throws = false;
  return fn;
}

function fakeCipher() {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    async encrypt() {
      calls.encrypt += 1;
      return Buffer.from('sealed', 'utf8');
    },
    async decrypt() {
      calls.decrypt += 1;
      return '{}';
    },
  };
}

/** flow 行的形状与 `service.getFlow/consumeFlow` 的返回值一致（驼峰）。 */
function flowRow(overrides = {}) {
  return {
    flowId: FLOW_ID,
    tenantId: TENANT,
    userId: USER,
    provider: PROVIDER,
    state: STATE,
    verifier: VERIFIER,
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 300_000).toISOString(),
    ...overrides,
  };
}

/**
 * 假服务：`consumeResults` 依次吐出（模拟「一次性」——队列空了就返回 null），
 * `putCredential` 只记录入参。
 */
function fakeService({ consumeResults = [flowRow()], createFlowId = 'flow-created' } = {}) {
  const consumes = [];
  const puts = [];
  const creates = [];
  const queue = [...consumeResults];
  return {
    consumes,
    puts,
    creates,
    service: {
      async consumeFlow(input) {
        consumes.push(input);
        return queue.length === 0 ? null : queue.shift();
      },
      async createFlow(input) {
        creates.push(input);
        return { flowId: createFlowId };
      },
      async putCredential(input) {
        puts.push(input);
        return { provider: input.provider, accountId: input.accountId, email: input.email ?? null, plan: input.plan ?? null };
      },
    },
  };
}

function completeOptions({ harness, fetch, params, cipher = fakeCipher(), ...overrides } = {}) {
  return {
    tenantId: TENANT,
    userId: USER,
    flowId: FLOW_ID,
    params: params ?? { state: STATE, code: 'code-1' },
    service: harness.service,
    fetch,
    cipher,
    issuer: SERVER_CHATGPT_ISSUER,
    clientId: CLIENT,
    redirectUri: REDIRECT,
    now: () => T0,
    verify: async () => true,
    ...overrides,
  };
}

const rejectsCode = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `期望 code=${code}，实际=${error?.code}`);
  return true;
});

// ---------------------------------------------------------------------------
// buildAuthorizeUrl / nonce 配对
// ---------------------------------------------------------------------------

test('buildAuthorizeUrl carries every §7.1 parameter and uses S256', () => {
  const url = new URL(buildAuthorizeUrl({
    issuer: SERVER_CHATGPT_ISSUER,
    clientId: CLIENT,
    redirectUri: REDIRECT,
    state: STATE,
    challenge: challengeOf(VERIFIER),
  }));
  const params = url.searchParams;

  assert.equal(`${url.origin}${url.pathname}`, `${SERVER_CHATGPT_ISSUER}/api/accounts/oauth/authorize`);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('client_id'), CLIENT);
  assert.equal(params.get('redirect_uri'), REDIRECT);
  assert.equal(params.get('scope'), SERVER_CHATGPT_SCOPE, 'scope 必须与桌面端逐字一致');
  assert.equal(params.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(params.get('resource'), SERVER_CHATGPT_RESOURCE);
  assert.equal(params.get('state'), STATE);
  assert.equal(params.get('code_challenge'), challengeOf(VERIFIER));
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('nonce'), nonceForState(STATE), 'nonce 由 state 派生，回调侧同式复算');
  assert.equal(params.get('agent_name_hint'), 'Mova');
  assert.equal(params.get('ext_agent_host_id'), null, '服务版没有本机 host id，默认不带');
  assert.ok(![...params.keys()].some(key => /verifier/i.test(key)), 'verifier 绝不能进 URL');

  const withHost = new URL(buildAuthorizeUrl({
    clientId: CLIENT, redirectUri: REDIRECT, state: STATE, challenge: challengeOf(VERIFIER), hostId: 'host-1',
  }));
  assert.equal(withHost.searchParams.get('ext_agent_host_id'), 'host-1', '显式配置时才带 host id');
});

test('buildAuthorizeUrl refuses incomplete parameters', async () => {
  for (const broken of [
    { redirectUri: REDIRECT, state: STATE, challenge: 'c' },
    { clientId: CLIENT, state: STATE, challenge: 'c' },
    { clientId: CLIENT, redirectUri: REDIRECT, challenge: 'c' },
    { clientId: CLIENT, redirectUri: REDIRECT, state: STATE },
  ]) {
    await rejectsCode((async () => buildAuthorizeUrl(broken))(), 'request');
  }
});

test('nonceForState is stable, state-bound and url-safe', () => {
  const first = nonceForState(STATE);
  assert.equal(first, nonceForState(STATE), '同 state 必须得到同 nonce');
  assert.notEqual(first, nonceForState('state-2'), '不同 state 必须不同 nonce');
  assert.match(first, /^[A-Za-z0-9_-]{43}$/, 'nonce 必须是 43 字符的 base64url(sha256)');
  assert.notEqual(first, STATE, 'nonce 不能等于 state 本身');
});

// ---------------------------------------------------------------------------
// exchangeCode
// ---------------------------------------------------------------------------

test('exchangeCode posts the PKCE verifier and maps upstream failures', async () => {
  const ok = fakeFetch(jsonResponse(200, tokenBody()));
  const tokens = await exchangeCode({
    fetch: ok, clientId: CLIENT, code: 'code-1', verifier: VERIFIER, redirectUri: REDIRECT, now: () => T0,
  });
  assert.equal(tokens.access, ACCESS_TOKEN);
  assert.equal(tokens.refresh, REFRESH_TOKEN);
  assert.equal(tokens.expiresAt, T0 + 3600_000, 'expiresAt 由注入的 now 推出来');
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, `${SERVER_CHATGPT_ISSUER}/api/accounts/oauth/token`);
  const body = new URLSearchParams(ok.calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), VERIFIER);

  const base = { clientId: CLIENT, code: 'code-1', verifier: VERIFIER, redirectUri: REDIRECT, now: () => T0 };
  await rejectsCode(exchangeCode({ ...base, fetch: fakeFetch(jsonResponse(400, { error: 'invalid_grant' })) }), 'auth_expired');
  await rejectsCode(exchangeCode({ ...base, fetch: fakeFetch(jsonResponse(429, { error: 'slow_down' })) }), 'rate_limited');
  await rejectsCode(exchangeCode({ ...base, fetch: fakeFetch(jsonResponse(500, null)) }), 'network');

  const offline = fakeFetch(jsonResponse(200, tokenBody()));
  offline.throws = true;
  await rejectsCode(exchangeCode({ ...base, fetch: offline }), 'network');
});

test('exchangeCode fails closed when the body has no access_token', async () => {
  await rejectsCode(exchangeCode({
    fetch: fakeFetch(jsonResponse(200, { token_type: 'Bearer', id_token: fakeJwt(claims()) })),
    clientId: CLIENT,
    code: 'code-1',
    verifier: VERIFIER,
    redirectUri: REDIRECT,
    now: () => T0,
  }), 'auth_expired');
});

// ---------------------------------------------------------------------------
// validateClaims
// ---------------------------------------------------------------------------

test('validateClaims accepts a well-formed RS256 token and returns the claims', async () => {
  const seen = [];
  const payload = await validateClaims({
    idToken: fakeJwt(claims()),
    clientId: CLIENT,
    nonce: nonceForState(STATE),
    now: () => T0,
    verify: async request => {
      seen.push(request);
      return true;
    },
  });
  assert.equal(payload.sub, SUB);
  assert.equal(seen[0].alg, 'RS256');
  assert.equal(seen[0].kid, KID, '验签名必须带上 kid 让调用方去 JWKS 选键');
  assert.match(seen[0].signingInput, /^[^.]+\./);
  assert.ok(Buffer.isBuffer(seen[0].signature));
});

test('validateClaims rejects each claim violation with auth_expired', async () => {
  const base = { clientId: CLIENT, nonce: nonceForState(STATE), now: () => T0, verify: async () => true };
  const cases = {
    expired: fakeJwt(claims({ exp: Math.floor(T0 / 1000) - 1 })),
    nonce: fakeJwt(claims({ nonce: 'other-nonce' })),
    aud: fakeJwt(claims({ aud: 'oaiapp_someone_else' })),
    iss: fakeJwt(claims({ iss: 'https://evil.example.com' })),
    alg: fakeJwt(claims(), { alg: 'HS256', kid: KID }),
    sub: fakeJwt(claims({ sub: '' })),
    malformed: 'not-a-jwt',
  };
  for (const [label, idToken] of Object.entries(cases)) {
    await assert.rejects(validateClaims({ ...base, idToken }), error => {
      assert.equal(error.code, 'auth_expired', `${label} 必须归 auth_expired`);
      return true;
    });
  }
  // 验签失败：verify 返回 false 或直接抛，都必须归 auth_expired。
  await rejectsCode(validateClaims({ ...base, idToken: fakeJwt(claims()), verify: async () => false }), 'auth_expired');
  await rejectsCode(validateClaims({
    ...base,
    idToken: fakeJwt(claims()),
    verify: async () => {
      throw new Error('bad key');
    },
  }), 'auth_expired');
});

// ---------------------------------------------------------------------------
// completeServerLogin：失败分支
// ---------------------------------------------------------------------------

test('completeServerLogin rejects a callback whose state does not match the flow', async () => {
  const harness = fakeService();
  const result = await completeServerLogin(completeOptions({
    harness,
    fetch: fakeFetch(jsonResponse(200, tokenBody())),
    params: { state: 'state-from-another-flow', code: 'code-1' },
  }));

  assert.deepEqual(result, { ok: false, code: 'auth_denied' });
  assert.equal(harness.puts.length, 0, 'state 不符时不得落库');
  assert.equal(harness.consumes.length, 1, 'flow 已经先被消费掉（防重放）');
});

test('completeServerLogin treats an unknown or already used flow as auth_denied', async () => {
  const params = { state: STATE, code: 'code-1' };
  const gone = await completeServerLogin(completeOptions({
    harness: fakeService({ consumeResults: [null] }),
    fetch: fakeFetch(jsonResponse(200, tokenBody())),
    params,
  }));
  assert.deepEqual(gone, { ok: false, code: 'auth_denied' });

  // 同一条 flow 用第二次：队列空了 → consumeFlow 返回 null → 同样 auth_denied。
  const replay = fakeService({ consumeResults: [flowRow()] });
  const first = await completeServerLogin(completeOptions({
    harness: replay, fetch: fakeFetch(jsonResponse(200, tokenBody())), params,
  }));
  assert.equal(first.ok, true);
  const second = await completeServerLogin(completeOptions({
    harness: replay, fetch: fakeFetch(jsonResponse(200, tokenBody())), params,
  }));
  assert.deepEqual(second, { ok: false, code: 'auth_denied' }, '重放必须被一次性 flow 挡住');
  assert.equal(replay.puts.length, 1, '只在第一次落库');
});

test('completeServerLogin maps token endpoint status to auth_expired and rate_limited', async () => {
  const params = { state: STATE, code: 'code-1' };
  const expired = await completeServerLogin(completeOptions({
    harness: fakeService(),
    fetch: fakeFetch(jsonResponse(400, { error: 'invalid_grant' })),
    params,
  }));
  assert.deepEqual(expired, { ok: false, code: 'auth_expired' });

  const limited = await completeServerLogin(completeOptions({
    harness: fakeService(),
    fetch: fakeFetch(jsonResponse(429, { error: 'slow_down' })),
    params,
  }));
  assert.deepEqual(limited, { ok: false, code: 'rate_limited' });
});

test('completeServerLogin rejects a missing id_token and a bad nonce/aud/exp', async () => {
  const params = { state: STATE, code: 'code-1' };
  const noIdToken = await completeServerLogin(completeOptions({
    harness: fakeService(),
    fetch: fakeFetch(jsonResponse(200, tokenBody({ id_token: undefined }))),
    params,
  }));
  assert.deepEqual(noIdToken, { ok: false, code: 'auth_expired' }, '没有 id_token 就没有稳定身份');

  for (const payload of [
    claims({ exp: Math.floor(T0 / 1000) - 1 }),
    claims({ nonce: 'other-nonce' }),
    claims({ aud: 'oaiapp_someone_else' }),
  ]) {
    const result = await completeServerLogin(completeOptions({
      harness: fakeService(),
      fetch: fakeFetch(jsonResponse(200, tokenBody({ id_token: fakeJwt(payload) }))),
      params,
    }));
    assert.deepEqual(result, { ok: false, code: 'auth_expired' });
  }

  const badSignature = await completeServerLogin(completeOptions({
    harness: fakeService(),
    fetch: fakeFetch(jsonResponse(200, tokenBody())),
    params,
    verify: async () => false,
  }));
  assert.deepEqual(badSignature, { ok: false, code: 'auth_expired' });
});

test('completeServerLogin refuses a call without tenant and user', async () => {
  const harness = fakeService();
  const params = { state: STATE, code: 'code-1' };
  for (const identity of [
    { tenantId: undefined, userId: undefined },
    { tenantId: undefined },
    { userId: undefined },
  ]) {
    const result = await completeServerLogin(completeOptions({ harness, fetch: fakeFetch(jsonResponse(200, tokenBody())), params, ...identity }));
    assert.deepEqual(result, { ok: false, code: 'request' }, '回调必须带会话里的租户与用户');
  }
  assert.equal(harness.consumes.length, 0, '身份不明时不允许碰 flow');
});

// ---------------------------------------------------------------------------
// completeServerLogin：成功路径
// ---------------------------------------------------------------------------

test('completeServerLogin stores exactly one credential under sha256(sub)', async () => {
  const harness = fakeService();
  const cipher = fakeCipher();
  const fetch = fakeFetch(jsonResponse(200, tokenBody()));
  const result = await completeServerLogin(completeOptions({ harness, fetch, cipher }));

  assert.equal(result.ok, true);
  assert.equal(harness.puts.length, 1, 'putCredential 只允许调用一次');
  const args = harness.puts[0];

  assert.deepEqual(Object.keys(args).sort(),
    ['accountId', 'email', 'expiresAt', 'plan', 'provider', 'record', 'tenantId', 'userId'],
    '入参只有身份四键 + record + 展示列（AAD 由 service 内部算，调用方不给 aad）');
  assert.equal(args.tenantId, TENANT);
  assert.equal(args.userId, USER);
  assert.equal(args.provider, PROVIDER);
  assert.equal(args.accountId, sha256Hex(SUB), 'accountId = sha256(sub)');
  assert.equal(args.accountId.length, 64);
  assert.equal(args.email, 'ada@example.com');
  assert.equal(args.plan, 'plus', 'plan 取自 ID token 的 openai auth 段');
  assert.equal(args.expiresAt, T0 + 3600_000);
  assert.equal(args.record.accountId, args.accountId, '记录自带的身份必须与行键一致');
  assert.equal(args.record.refresh, REFRESH_TOKEN, '令牌只进 record（随后由 service 交给 cipher）');
  assert.equal(args.record.access, ACCESS_TOKEN);
  assert.equal(args.record.type, 'oauth');
  assert.equal(cipher.calls.encrypt, 0, '编排层绝不自己加密：AAD 与加密都在 service 内部');

  const plaintextArgs = JSON.stringify({ ...args, record: undefined });
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN]) {
    assert.ok(!plaintextArgs.includes(secret), `record 之外的入参不得出现令牌：${secret}`);
  }
});

test('completeServerLogin returns no token fields at all', async () => {
  const harness = fakeService();
  const result = await completeServerLogin(completeOptions({ harness, fetch: fakeFetch(jsonResponse(200, tokenBody())) }));

  assert.deepEqual(Object.keys(result).sort(), ['account', 'ok']);
  assert.deepEqual(Object.keys(result.account).sort(), ['accountId', 'email', 'plan', 'provider']);
  const dumped = JSON.stringify(result);
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN]) {
    assert.ok(!dumped.includes(secret), '返回值不得出现任何令牌');
  }
  assert.ok(!/access|refresh|idToken|token"/i.test(dumped), `返回值不得出现令牌字段名：${dumped}`);
});

test('accountId is a stable fingerprint across two logins of the same account', async () => {
  const first = await completeServerLogin(completeOptions({
    harness: fakeService(), fetch: fakeFetch(jsonResponse(200, tokenBody())),
  }));
  // 第二次换一组令牌（refresh 变了，这正是 §8.2 的坑），身份必须不变。
  const second = await completeServerLogin(completeOptions({
    harness: fakeService(),
    fetch: fakeFetch(jsonResponse(200, tokenBody({ access_token: 'test-access-second', refresh_token: 'test-refresh-second' }))),
  }));

  assert.equal(first.account.accountId, second.account.accountId, '同 sub 两次登录必须是同一个 accountId');
  assert.equal(first.account.accountId, sha256Hex(SUB));
});

test('completeServerLogin tolerates a callback without optional claims', async () => {
  const harness = fakeService();
  const result = await completeServerLogin(completeOptions({
    harness,
    fetch: fakeFetch(jsonResponse(200, tokenBody({
      id_token: fakeJwt(claims({ email: undefined, 'https://api.openai.com/auth': undefined })),
    }))),
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.account).sort(), ['accountId', 'provider'], '没有 email/plan 就不带这两个键');
  assert.equal(harness.puts[0].email, null);
  assert.equal(harness.puts[0].plan, null);
});

// ---------------------------------------------------------------------------
// beginServerLogin
// ---------------------------------------------------------------------------

test('beginServerLogin persists the flow and returns an authorize URL with the S256 challenge', async () => {
  const harness = fakeService({ createFlowId: 'flow-server-1' });
  const { flowId, authorizeUrl } = await beginServerLogin({
    flow: { tenantId: TENANT, userId: USER, provider: PROVIDER, state: STATE, verifier: VERIFIER },
    service: harness.service,
    fetch: fakeFetch(jsonResponse(200, {})),
    issuer: SERVER_CHATGPT_ISSUER,
    clientId: CLIENT,
    redirectUri: REDIRECT,
  });

  assert.equal(flowId, 'flow-server-1');
  assert.equal(harness.creates.length, 1, 'flow 必须落库（一次性、5 分钟）');
  assert.deepEqual(harness.creates[0], {
    tenantId: TENANT, userId: USER, provider: PROVIDER, state: STATE, verifier: VERIFIER,
  });

  const url = new URL(authorizeUrl);
  assert.equal(url.searchParams.get('code_challenge'), challengeOf(VERIFIER), 'challenge 由 verifier 现场算');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), STATE);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.ok(!authorizeUrl.includes(VERIFIER), 'URL 里不得出现 verifier');
});

test('beginServerLogin reuses a flow the caller already persisted', async () => {
  const harness = fakeService();
  const { flowId } = await beginServerLogin({
    flow: { flowId: 'flow-existing', state: STATE, verifier: VERIFIER, tenantId: TENANT, userId: USER },
    service: harness.service,
    clientId: CLIENT,
    redirectUri: REDIRECT,
  });
  assert.equal(flowId, 'flow-existing');
  assert.equal(harness.creates.length, 0, '已经落库的 flow 不允许重复插入');
});
