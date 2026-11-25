/**
 * ChatGPT 订阅（Codex OAuth）纯逻辑。
 *
 * 负责：PKCE/state 生成、授权 URL 拼装、回调解析、换 token、刷新、可用性判定。
 * 不负责：起本地回调服务器、开浏览器、safeStorage 落盘、重试节奏（都由服务层做）。
 * 被谁调用：subscription 服务层的登录流程与「刷新在锁内做」的刷新流程。
 *
 * 关键决策（为什么是这几个参数）：走 Codex CLI 的公开 PKCE 客户端，
 * `client_id=app_EMoamEEZ73f0CkXaXp7hrann`、授权 `/oauth/authorize`、换码 `/oauth/token`、
 * `scope=openid profile email offline_access`、回调必须是 `http://localhost:1455/auth/callback`。
 * **不能**带 `resource=https://api.openai.com/v1`：那条是「Sign in with ChatGPT → api.openai.com」
 * 的实验流程，签出来的令牌不被 `chatgpt.com/backend-api/wham/usage` 接受（必 401）。
 * 网络与验签全部注入（`fetch` / `verify`），所以测试不需要真网络和真 RSA。
 * 令牌只出现在返回值里，绝不进错误对象或 detail（§6 日志要求）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { SubscriptionError } from './contract.mjs';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
/** Codex CLI 的公开 OAuth 客户端（无 client_secret）。 */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_SCOPE = 'openid profile email offline_access';
/** 浏览器回调固定在这里：OpenAI 对这个客户端做精确串校验，换端口会被拒。 */
export const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CHATGPT_REDIRECT_PORT = 1455;
export const AGENT_NAME = 'Mova';
/** 过期前留 60s 余量（§5.1）。 */
export const EXPIRY_MARGIN_MS = 60_000;

const AUTHORIZE_PATH = '/oauth/authorize';
const TOKEN_PATH = '/oauth/token';
const DEFAULT_EXPIRES_IN = 3600;

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function requireString(value, detail) {
  if (typeof value !== 'string' || value.length === 0) throw new SubscriptionError('request', { detail });
  return value;
}

/** `{ verifier, challenge, state, nonce }`；`random(n)` 注入以便测试稳定。 */
export function createPkce({ random } = {}) {
  const source = typeof random === 'function' ? random : size => randomBytes(size);
  const verifier = base64url(source(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(source(16));
  const nonce = base64url(source(16));
  return { verifier, challenge, state, nonce };
}

/**
 * 授权 URL：参数与 pi-ai / Codex CLI 的实现逐字对齐。
 * 少一个 `codex_cli_simplified_flow` 会多出选择步骤；带 `resource` 则会签发不被订阅接口接受的令牌。
 */
export function buildAuthorizeUrl({
  issuer = CHATGPT_ISSUER,
  clientId,
  redirectUri,
  pkce,
  scope = CHATGPT_SCOPE,
  agentName = AGENT_NAME,
} = {}) {
  requireString(clientId, 'clientId');
  requireString(redirectUri, 'redirectUri');
  if (!pkce || !pkce.challenge || !pkce.state) throw new SubscriptionError('request', { detail: 'pkce' });
  const url = new URL(AUTHORIZE_PATH, issuer);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('scope', scope);
  params.set('code_challenge', pkce.challenge);
  params.set('code_challenge_method', 'S256');
  params.set('state', pkce.state);
  params.set('id_token_add_organizations', 'true');
  params.set('codex_cli_simplified_flow', 'true');
  params.set('originator', agentName);
  return url.toString();
}

function toParams(input) {
  if (input instanceof URLSearchParams) return input;
  if (typeof input === 'string') return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
  if (input && typeof input === 'object') {
    return new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
  }
  return new URLSearchParams();
}

/**
 * 回调解析：只接受本次 `state`；`error` 一律归 auth_denied，
 * state 不匹配归 auth_cancelled（通常是旧页面/重复回调，用户视角就是「没登上」）。
 */
export function parseCallback(searchParams, { state, redirectUri } = {}) {
  const params = toParams(searchParams);
  const error = params.get('error');
  if (error) throw new SubscriptionError('auth_denied', { detail: error });
  const returnedState = params.get('state');
  if (!state || !returnedState || returnedState !== state) {
    throw new SubscriptionError('auth_cancelled', { detail: 'state_mismatch' });
  }
  const code = params.get('code');
  if (!code) throw new SubscriptionError('auth_cancelled', { detail: 'missing_code' });
  const returnedRedirect = params.get('redirect_uri');
  if (returnedRedirect && redirectUri && returnedRedirect !== redirectUri) {
    throw new SubscriptionError('auth_denied', { detail: 'redirect_mismatch' });
  }
  return { code, clientId: params.get('client_id') ?? null };
}

async function postToken({ fetch, issuer, body, signal }) {
  if (typeof fetch !== 'function') throw new SubscriptionError('request', { detail: 'fetch' });
  let response;
  try {
    response = await fetch(new URL(TOKEN_PATH, issuer).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new SubscriptionError('network', { cause: error, retryable: true });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const upstream = typeof payload?.error === 'string' ? payload.error : `http_${response.status}`;
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new SubscriptionError('auth_expired', { detail: upstream });
    }
    if (response.status === 429) throw new SubscriptionError('rate_limited', { retryable: true });
    throw new SubscriptionError('network', { detail: upstream, retryable: true });
  }
  if (!payload || typeof payload !== 'object') throw new SubscriptionError('network', { detail: 'bad_body', retryable: true });
  return payload;
}

function toRecord(payload, clock) {
  const access = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!access) throw new SubscriptionError('auth_expired', { detail: 'missing_access_token' });
  const rawExpires = Number(payload.expires_in);
  const expiresIn = Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : DEFAULT_EXPIRES_IN;
  const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
  return {
    access,
    // refresh 只在轮换时出现：没轮换就别覆盖旧值（上游可能不再返回它）。
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token ? { refresh: payload.refresh_token } : {}),
    ...(typeof payload.id_token === 'string' && payload.id_token ? { idToken: payload.id_token } : {}),
    ...(scope ? { scope } : {}),
    expiresIn,
    expiresAt: clock() + expiresIn * 1000,
  };
}

/** 授权码换 token；`now` 可注入，返回带 `expiresAt` 的记录片段。 */
export async function exchangeCode({
  fetch,
  issuer = CHATGPT_ISSUER,
  code,
  verifier,
  clientId,
  redirectUri,
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
  });
  const payload = await postToken({ fetch, issuer, body, signal });
  return toRecord(payload, typeof now === 'function' ? now : Date.now);
}

/**
 * 刷新 access token。返回片段里**不含** `refresh` 时调用方要保留旧 refresh token
 * （OpenAI 的 refresh token 是一次性轮换：并发双刷会让整个登录态作废）。
 */
export async function refreshAccessToken({
  fetch,
  issuer = CHATGPT_ISSUER,
  clientId,
  refreshToken,
  signal,
  now = Date.now,
} = {}) {
  requireString(clientId, 'clientId');
  requireString(refreshToken, 'refreshToken');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const payload = await postToken({ fetch, issuer, body, signal });
  return toRecord(payload, typeof now === 'function' ? now : Date.now);
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
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
    throw new SubscriptionError('auth_expired', { detail: 'id_token' });
  }
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
}

/**
 * ID token 校验：alg=RS256、JWKS 验签、iss/aud/exp/nonce/sub。
 * `verify(alg, data, key, sig)` 由调用方注入（生产用 node:crypto，测试用假实现）。
 */
export async function validateIdToken({
  idToken,
  jwks,
  clientId,
  nonce,
  now = Date.now,
  verify,
  issuer = CHATGPT_ISSUER,
} = {}) {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  if (header.alg !== 'RS256') throw new SubscriptionError('auth_expired', { detail: 'alg' });
  const keys = Array.isArray(jwks) ? jwks : Array.isArray(jwks?.keys) ? jwks.keys : [];
  const key = keys.find(candidate => candidate?.kid && candidate.kid === header.kid)
    ?? (keys.length === 1 ? keys[0] : null);
  if (!key) throw new SubscriptionError('auth_expired', { detail: 'jwks' });
  let signatureOk = false;
  try {
    signatureOk = typeof verify === 'function'
      ? (await verify('RS256', signingInput, key, signature)) === true
      : false;
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new SubscriptionError('auth_expired', { detail: 'signature' });
  if (payload.iss !== issuer) throw new SubscriptionError('auth_expired', { detail: 'iss' });
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (typeof clientId !== 'string' || !audience.includes(clientId)) {
    throw new SubscriptionError('auth_expired', { detail: 'aud' });
  }
  const expiresAt = Number(payload.exp) * 1000;
  const at = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(expiresAt) || expiresAt <= at) throw new SubscriptionError('auth_expired', { detail: 'exp' });
  if (typeof nonce === 'string' && nonce.length > 0 && payload.nonce !== nonce) {
    throw new SubscriptionError('auth_expired', { detail: 'nonce' });
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new SubscriptionError('auth_expired', { detail: 'sub' });
  }
  return payload;
}

/** 过期前 60s 即视为不可用（§5.1 / §6 刷新时机）。 */
export function isUsable(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.access !== 'string' || record.access.length === 0) return false;
  const expiresAt = Number(record.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - EXPIRY_MARGIN_MS > now;
}
