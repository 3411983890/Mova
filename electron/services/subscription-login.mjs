/**
 * 服务版 ChatGPT 登录编排（§4.3 / §7.1）。
 *
 * 负责：授权 URL 拼装、state/nonce 配对、授权码换 token、ID token 校验、稳定的 accountId 指纹，
 *       以及「一次性 flow → putCredential」这一段编排。
 * 不负责：回调 HTTP 服务、flow 落库（`subscription-service.mjs`）、加解密（AAD 由 service 内部算）、
 *       额度探针。**不 import `electron` / `pg` / 不读 `process.env`**：`fetch` 与 `verify` 全部注入，
 *       所以纯 `node --test` 就能跑完所有失败分支。
 * 被谁调用：服务端 `/oauth/callback/<flowId>` 路由，与发起登录的 HTTP 入口。
 *
 * 为什么 accountId = sha256(sub)：refresh_token 每台机器、每次授权都不同，用它做指纹会把同一
 * 账号认成两个（§8.2 的教训）；`sub` 才是上游稳定的身份。
 * 为什么 nonce 由 state 派生：`subscription_flows` 没有 nonce 列（表结构已定，006 迁移不可改），
 * 服务端不能新增列，于是 nonce = sha256('mova:nonce:' + state)，授权与回调两侧同式复算。
 */
import { createHash } from 'node:crypto';

import { SubscriptionError, toErrorCode } from '../subscription/contract.mjs';

export const SERVER_CHATGPT_ISSUER = 'https://auth.openai.com';
export const SERVER_CHATGPT_RESOURCE = 'https://api.openai.com/v1';
/** 与桌面端 `CHATGPT_SCOPE` 逐字一致：少一个 scope 上游就不发 refresh token（§7.1）。 */
export const SERVER_CHATGPT_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const SERVER_AGENT_NAME = 'Mova';

const AUTHORIZE_PATH = '/api/accounts/oauth/authorize';
const TOKEN_PATH = '/api/accounts/oauth/token';
const DEFAULT_EXPIRES_IN = 3600;
const NONCE_PREFIX = 'mova:nonce:';
const DEFAULT_PROVIDER = 'chatgpt';

function requireString(value, detail) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SubscriptionError('request', { detail });
  }
  return value.trim();
}

function refuse(code, detail) {
  return new SubscriptionError(code, { detail });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clockMs(now) {
  const value = typeof now === 'function' ? now() : now;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) throw new SubscriptionError('request', { detail: 'now' });
  return ms;
}

/** S256：`challenge = base64url(sha256(ascii(verifier)))`（RFC 7636）。 */
function challengeFromVerifier(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * nonce 与 state 的配对式。导出是因为「授权侧」与「回调侧」必须算同一个值——
 * 只被测试调用的派生函数是死代码，这个不是。
 */
export function nonceForState(state) {
  return createHash('sha256').update(`${NONCE_PREFIX}${requireString(state, 'state')}`).digest('base64url');
}

/**
 * 授权 URL：参数与 §7.1 逐字对齐。`hostId` 可选——服务版没有「本机固定 uuid」这个概念，
 * 只在部署方显式配置时才带 `ext_agent_host_id`。
 */
export function buildAuthorizeUrl({
  issuer = SERVER_CHATGPT_ISSUER,
  clientId,
  redirectUri,
  state,
  challenge,
  hostId,
  scope = SERVER_CHATGPT_SCOPE,
  resource = SERVER_CHATGPT_RESOURCE,
  nonce,
} = {}) {
  requireString(clientId, 'clientId');
  requireString(redirectUri, 'redirectUri');
  const stateValue = requireString(state, 'state');
  const challengeValue = requireString(challenge, 'challenge');

  const url = new URL(AUTHORIZE_PATH, issuer);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('scope', scope);
  params.set('resource', resource);
  params.set('state', stateValue);
  params.set('code_challenge', challengeValue);
  params.set('code_challenge_method', 'S256');
  params.set('nonce', typeof nonce === 'string' && nonce.length > 0 ? nonce : nonceForState(stateValue));
  params.set('agent_name_hint', SERVER_AGENT_NAME);
  if (typeof hostId === 'string' && hostId.trim().length > 0) params.set('ext_agent_host_id', hostId.trim());
  return url.toString();
}

/** 回调参数三种形态都收：URLSearchParams（真实路由）、查询串、普通对象（测试）。 */
function toParams(input) {
  if (input instanceof URLSearchParams) return input;
  if (typeof input === 'string') return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
  if (isObject(input)) {
    return new URLSearchParams(Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]));
  }
  return new URLSearchParams();
}

async function postToken({ fetch: httpFetch, issuer, body, signal }) {
  if (typeof httpFetch !== 'function') throw new SubscriptionError('request', { detail: 'fetch' });
  let response;
  try {
    response = await httpFetch(new URL(TOKEN_PATH, issuer).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // 原始错误可能带 URL 或 transport 细节，只留在 cause，不进 detail/日志正文。
    throw new SubscriptionError('network', { cause: error, retryable: true });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const upstream = typeof payload?.error === 'string' ? payload.error.slice(0, 200) : `http_${response.status}`;
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new SubscriptionError('auth_expired', { detail: upstream });
    }
    if (response.status === 429) throw new SubscriptionError('rate_limited', { retryable: true });
    throw new SubscriptionError('network', { detail: upstream, retryable: true });
  }
  if (!isObject(payload)) throw new SubscriptionError('network', { detail: 'bad_body', retryable: true });
  return payload;
}

/**
 * 授权码换 token。返回记录片段里的令牌**只允许**交给 `service.putCredential`，
 * 不要转发给渲染层、不要写日志（§6）。
 */
export async function exchangeCode({
  fetch: httpFetch,
  issuer = SERVER_CHATGPT_ISSUER,
  clientId,
  code,
  verifier,
  redirectUri,
  resource = SERVER_CHATGPT_RESOURCE,
  signal,
  now = Date.now,
} = {}) {
  requireString(code, 'code');
  requireString(verifier, 'verifier');
  requireString(clientId, 'clientId');
  requireString(redirectUri, 'redirectUri');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
  });
  const payload = await postToken({ fetch: httpFetch, issuer, body, signal });
  const access = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (access.length === 0) throw new SubscriptionError('auth_expired', { detail: 'missing_access_token' });
  const rawExpires = Number(payload.expires_in);
  const expiresIn = Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : DEFAULT_EXPIRES_IN;
  return {
    access,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token ? { refresh: payload.refresh_token } : {}),
    ...(typeof payload.id_token === 'string' && payload.id_token ? { idToken: payload.id_token } : {}),
    ...(typeof payload.scope === 'string' && payload.scope ? { scope: payload.scope } : {}),
    expiresIn,
    expiresAt: clockMs(now) + expiresIn * 1000,
  };
}

function decodeJwt(idToken) {
  if (typeof idToken !== 'string') throw new SubscriptionError('auth_expired', { detail: 'id_token' });
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new SubscriptionError('auth_expired', { detail: 'id_token' });
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new SubscriptionError('auth_expired', { detail: 'id_token' });
  }
  if (!isObject(header) || !isObject(payload)) throw new SubscriptionError('auth_expired', { detail: 'id_token' });
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

/**
 * ID token 校验：alg=RS256、验签、iss/aud/exp/nonce/sub（与桌面端同款校验点）。
 * `verify({ alg, kid, signingInput, signature })` 由调用方注入：生产实现自己按 kid 取 JWKS 并用
 * `node:crypto` 验 RSA，测试注入假实现——所以这里不需要把 JWKS 也塞进参数。
 */
export async function validateClaims({
  idToken,
  clientId,
  nonce,
  now = Date.now,
  verify,
  issuer = SERVER_CHATGPT_ISSUER,
} = {}) {
  if (typeof verify !== 'function') throw new SubscriptionError('request', { detail: 'verify' });
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  if (header.alg !== 'RS256') throw refuse('auth_expired', 'alg');

  let signatureOk = false;
  try {
    signatureOk = (await verify({
      alg: header.alg,
      kid: typeof header.kid === 'string' ? header.kid : null,
      signingInput,
      signature,
    })) === true;
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw refuse('auth_expired', 'signature');

  if (payload.iss !== issuer) throw refuse('auth_expired', 'iss');
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (typeof clientId !== 'string' || clientId.length === 0 || !audience.includes(clientId)) {
    throw refuse('auth_expired', 'aud');
  }
  const expiresAt = Number(payload.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= clockMs(now)) throw refuse('auth_expired', 'exp');
  if (typeof nonce === 'string' && nonce.length > 0 && payload.nonce !== nonce) {
    throw refuse('auth_expired', 'nonce');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw refuse('auth_expired', 'sub');
  return payload;
}

/** 稳定指纹：同一 `sub` 永远得到同一个 accountId（换 token 不影响身份）。 */
function accountIdOfSub(sub) {
  return createHash('sha256').update(requireString(sub, 'sub'), 'utf8').digest('hex');
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * 发起登录：把 flow 落库（一次性、带过期），再拼授权 URL。
 *
 * `fetch` 不在这里用：客户端注册发生在服务启动阶段，登录发起是纯本地动作；
 * 保留参数是为了让调用方把同一份配置整体转发给 begin/complete（两者签名对称）。
 * `flow` 若已带 `flowId`（调用方已自己落库），这里不再重复插入，只用它拼 URL。
 */
export async function beginServerLogin({ flow, service, fetch, issuer, clientId, redirectUri } = {}) {
  const descriptor = isObject(flow) ? flow : {};
  const state = requireString(descriptor.state, 'state');
  const provider = firstString(descriptor.provider) ?? DEFAULT_PROVIDER;
  const verifier = firstString(descriptor.verifier);

  const challenge = firstString(descriptor.challenge)
    ?? (verifier ? challengeFromVerifier(verifier) : null);
  if (!challenge) throw new SubscriptionError('request', { detail: 'challenge' });

  let flowId = firstString(descriptor.flowId);
  if (!flowId) {
    if (!isObject(service) || typeof service.createFlow !== 'function') {
      throw new SubscriptionError('request', { detail: 'service.createFlow' });
    }
    ({ flowId } = await service.createFlow({
      tenantId: descriptor.tenantId,
      userId: descriptor.userId,
      provider,
      state,
      verifier,
      ...(descriptor.ttlMs === undefined ? {} : { ttlMs: descriptor.ttlMs }),
    }));
  }

  const authorizeUrl = buildAuthorizeUrl({ issuer, clientId, redirectUri, state, challenge });
  return { flowId, authorizeUrl };
}

/**
 * 完成登录：一次性 flow → 换 token → 验 ID token → 落库。
 *
 * 全程收敛成 `{ ok:true, account }` / `{ ok:false, code }`，不向上抛：
 * HTTP 回调层只负责把 code 渲染成页面，越权与过期在这里统一成 auth_denied。
 * 返回值不含任何令牌；令牌只出现在 `record` 里，由 `service.putCredential` 交给 cipher
 * （AAD 由 service 内部按四个身份键算，编排层不接触 AAD，也不会自己 encrypt）。
 *
 * @param {object} options
 * @param {string} options.tenantId / options.userId 回调路由从会话里解出的身份；
 *        `consumeFlow` 必须带这两段，否则拿到别人的 flowId 就能替别人登录（§4.3）。
 */
export async function completeServerLogin({
  tenantId,
  userId,
  flowId,
  params,
  service,
  fetch: httpFetch,
  cipher,
  issuer = SERVER_CHATGPT_ISSUER,
  clientId,
  redirectUri,
  now = Date.now,
  verify,
} = {}) {
  // cipher 是保留位：加密只在 service 内部发生。显式接收它，是为了让调用方与冒烟测试都能
  // 断言「编排层没有自己去 encrypt」——这里是文件里唯一提到它的地方。
  void cipher;

  try {
    if (!isObject(service) || typeof service.consumeFlow !== 'function' || typeof service.putCredential !== 'function') {
      throw new SubscriptionError('request', { detail: 'service' });
    }
    const owner = {
      tenantId: requireString(tenantId, 'tenantId'),
      userId: requireString(userId, 'userId'),
      flowId: requireString(flowId, 'flowId'),
    };

    // 1) 一次性取走：拿不到 = 不存在 / 已用过 / 已过期，一律 auth_denied（不区分，避免探测）。
    const flow = await service.consumeFlow(owner);
    if (!flow) throw refuse('auth_denied', 'flow');

    // 2) 回调本身带的错误与 state：state 必须与这条 flow 记录的一致。
    const query = toParams(params);
    const upstreamError = query.get('error');
    if (upstreamError) throw refuse('auth_denied', upstreamError.slice(0, 200));
    const returnedState = query.get('state');
    if (!returnedState || returnedState !== flow.state) throw refuse('auth_denied', 'state');
    const code = query.get('code');
    if (!code) throw refuse('auth_denied', 'code');

    // 3) 换 token（PKCE verifier 来自 flow 行，用完即随行删除）。
    const tokens = await exchangeCode({
      fetch: httpFetch,
      issuer,
      clientId,
      code,
      verifier: typeof flow.verifier === 'string' ? flow.verifier : '',
      redirectUri,
      now,
    });

    // 4) 验 ID token：iss/aud/exp/nonce/sub + 验签。没有 id_token 就没有稳定身份，直接失败。
    if (typeof tokens.idToken !== 'string' || tokens.idToken.length === 0) {
      throw refuse('auth_expired', 'missing_id_token');
    }
    const claims = await validateClaims({
      idToken: tokens.idToken,
      clientId,
      nonce: nonceForState(flow.state),
      now,
      verify,
      issuer,
    });

    // 5) 稳定指纹。
    const accountId = accountIdOfSub(claims.sub);
    const auth = isObject(claims['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] : {};
    const email = firstString(claims.email);
    const plan = firstString(claims.chatgpt_plan_type, auth.chatgpt_plan_type, claims.plan_type);
    const chatgptAccountId = firstString(claims.chatgpt_account_id, auth.chatgpt_account_id);
    const provider = firstString(flow.provider) ?? DEFAULT_PROVIDER;

    const record = {
      type: 'oauth',
      provider,
      accountId,
      access: tokens.access,
      refresh: typeof tokens.refresh === 'string' ? tokens.refresh : '',
      state: 'ready',
      limitedUntil: 0,
      lastError: '',
      expiresAt: tokens.expiresAt,
      clientId,
      createdAt: clockMs(now),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
      ...(email ? { email } : {}),
      ...(plan ? { plan } : {}),
      ...(chatgptAccountId ? { chatgptAccountId } : {}),
    };

    // 6) 落库：只给身份四键 + record（+ 展示列）。AAD 由 service 内部算。
    await service.putCredential({
      tenantId: owner.tenantId,
      userId: owner.userId,
      provider,
      accountId,
      record,
      email,
      plan,
      expiresAt: tokens.expiresAt,
    });

    // 7) 对外只回身份与展示字段，绝不回令牌。
    return {
      ok: true,
      account: {
        provider,
        accountId,
        ...(email ? { email } : {}),
        ...(plan ? { plan } : {}),
      },
    };
  } catch (error) {
    // 未知名一律收敛成 request：不把驱动的 'ECONNREFUSED' 之类透给客户端。
    // detail 只可能是一句短标签，不含响应体、不含令牌（见各 throw 点）。
    return { ok: false, code: toErrorCode(error) };
  }
}
