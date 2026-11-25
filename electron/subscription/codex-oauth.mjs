/**
 * ChatGPT 订阅通道的登录与令牌护理。
 *
 * 为什么自己不写 OAuth：`@earendil-works/pi-ai` 已经带了官方实现
 * （`providers/openai-codex` → `auth/oauth/openai-codex.js`），它用的就是 Codex CLI 的公开
 * PKCE 客户端：authorize `https://auth.openai.com/oauth/authorize`、token
 * `https://auth.openai.com/oauth/token`、回调 `http://localhost:1455/auth/callback`、
 * `scope=openid profile email offline_access`，并在 1455 被占用时退回「粘贴回调 URL」和设备码。
 * Mova 只做三件事：把浏览器打开、把用户粘贴的地址递进去、把结果按订阅记录的形状落盘。
 *
 * 为什么不能读 `~/.codex/auth.json`：那是本机 Codex 的登录态，不是本产品的账号；
 * 用户要求的是「点登录 → 浏览器授权 → Mova 自己拿到订阅令牌」。
 *
 * 令牌形状（pi-ai 返回）：`{ type: 'oauth', access, refresh, expires, accountId }`。
 * email / 套餐名 / 过期时间都从 access token 的 JWT 里读，不需要 id_token。
 */
import { createHash, randomUUID } from 'node:crypto';

/** Codex CLI 的公开 PKCE 客户端（无 client_secret）。 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_SCOPE = 'openid profile email offline_access';
/** 额度接口与对话接口都在这下面（不是 api.openai.com）。 */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const CODEX_USAGE_URL = `${CODEX_BASE_URL}/wham/usage`;

const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** 解 JWT payload；拿不到就是 null（不抛，调用方按「字段缺失」处理）。 */
export function decodeCodexJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * 从 access token 里取出账号身份。
 * 这三个字段是订阅链路的地基：没 chatgptAccountId 就打不了 wham/usage 与 codex/responses。
 */
export function codexClaims(accessToken) {
  const payload = decodeCodexJwt(accessToken);
  if (!payload) return { accountId: '', email: '', plan: '', expiresAt: 0, subject: '' };
  const auth = payload[AUTH_CLAIM] && typeof payload[AUTH_CLAIM] === 'object' ? payload[AUTH_CLAIM] : {};
  const profile = payload[PROFILE_CLAIM] && typeof payload[PROFILE_CLAIM] === 'object' ? payload[PROFILE_CLAIM] : {};
  const accountId = typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '';
  const email = typeof profile.email === 'string' ? profile.email : '';
  const plan = typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : '';
  const expiresAt = Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  return { accountId, email, plan, expiresAt, subject };
}

/** 账号主键：优先 chatgpt_account_id → 邮箱 → 令牌指纹（同一账号重登只更新、不新增）。 */
export function codexIdentityKey(claims, accessToken) {
  if (claims?.accountId) return `chatgpt:${claims.accountId}`;
  if (claims?.email) return `chatgpt:${claims.email.toLowerCase()}`;
  return `chatgpt:${createHash('sha256').update(String(accessToken ?? '')).digest('hex')}`;
}

/**
 * pi-ai 的凭据 → Mova 的订阅记录字段。
 * 不落 id_token：身份信息已经全在 access token 的声明里。
 */
export function codexRecordFromCredential(credential, { now = Date.now() } = {}) {
  const access = typeof credential?.access === 'string' ? credential.access : '';
  const refresh = typeof credential?.refresh === 'string' ? credential.refresh : '';
  if (!access || !refresh) throw new Error('codex credential incomplete');
  const claims = codexClaims(access);
  const expiresAt = Number(credential?.expires) || claims.expiresAt || now + 3600_000;
  return {
    type: 'codex-oauth',
    provider: 'chatgpt',
    accountId: codexIdentityKey(claims, access),
    chatgptAccountId: claims.accountId,
    email: claims.email,
    plan: claims.plan,
    access,
    refresh,
    expiresAt,
    clientId: CODEX_CLIENT_ID,
    redirectUri: CODEX_REDIRECT_URI,
  };
}

/**
 * 刷新。pi-ai 的 refresh 会整份换掉 credential（含新的 refresh token），
 * 所以调用方必须在 `store.modify` 的写链里做，避免并发双刷把 refresh token 刷废。
 */
export async function refreshCodexCredential(credential, { oauth, signal } = {}) {
  const client = oauth ?? await codexOAuth();
  const next = await client.refresh(credential, signal ?? new AbortController().signal);
  return {
    access: next.access,
    refresh: next.refresh || credential.refresh,
    expires: Number(next.expires) || 0,
    accountId: next.accountId || credential.accountId,
  };
}

let cachedOAuth = null;
/** 懒加载 pi-ai 的 Codex OAuth 实现（首次调用才 import，测试里可整体替换）。 */
export async function codexOAuth() {
  if (cachedOAuth) return cachedOAuth;
  const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex');
  const provider = openaiCodexProvider();
  const oauth = provider?.auth?.oauth;
  if (!oauth || typeof oauth.login !== 'function') throw new Error('codex oauth unavailable');
  cachedOAuth = oauth;
  return oauth;
}

/** 测试用：清掉缓存。 */
export function resetCodexOAuth() {
  cachedOAuth = null;
}

/**
 * 起一次浏览器登录。
 *
 * 返回的三样东西对应 IPC 的三个动作：
 * - `authorizeUrl`：解析出授权地址（UI 展示 + 兜底「手动打开」）；
 * - `credential`：登录完成的凭据；
 * - `complete(input)`：用户把浏览器最终跳转的 URL（或 code）粘回来时调用；
 * - `cancel()`：取消。
 *
 * 交互只保留一种选择：浏览器登录。设备码是 1455 被占用时的兜底，由 pi-ai 内部处理。
 */
export function createCodexLogin({
  openBrowser, oauth, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, agentName = 'Mova',
} = {}) {
  const flowId = randomUUID();
  const controller = new AbortController();
  let settled = false;
  let manualPending = null;
  let resolveUrl;
  let rejectUrl;
  const authorizeUrl = new Promise((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject; });
  // 没人等 authorizeUrl 时不要产生 unhandled rejection。
  authorizeUrl.catch(() => {});

  const timer = setTimeout(() => {
    if (settled) return;
    controller.abort();
  }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

  const interaction = {
    signal: controller.signal,
    async prompt(prompt) {
      if (prompt?.type === 'select') return 'browser';
      if (prompt?.type === 'manual_code') {
        // 等到用户粘贴，或等到取消。
        return await new Promise((resolve, reject) => {
          manualPending = { resolve, reject };
          controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }
      throw new Error(`unsupported prompt: ${prompt?.type}`);
    },
    notify(event) {
      if (event?.type === 'auth_url' && typeof event.url === 'string') {
        resolveUrl(event.url);
        try { openBrowser?.(event.url); } catch { /* 打不开浏览器也要让用户能复制地址 */ }
      }
    },
  };

  const credential = (async () => {
    const client = oauth ?? await codexOAuth();
    try {
      const result = await client.login(interaction, { agentName });
      settled = true;
      return codexRecordFromCredential(result, { now: now() });
    } catch (error) {
      settled = true;
      rejectUrl(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();

  return {
    flowId,
    authorizeUrl,
    credential,
    /** 用户把浏览器最终跳转地址（或授权码）粘回来。 */
    complete(input) {
      if (settled) return false;
      if (!manualPending) return false;
      const value = String(input ?? '').trim();
      if (!value) return false;
      const pending = manualPending;
      manualPending = null;
      pending.resolve(value);
      return true;
    },
    cancel() {
      if (settled) return false;
      settled = true;
      try { controller.abort(); } catch { /* 已结束 */ }
      manualPending?.reject(new Error('cancelled'));
      manualPending = null;
      rejectUrl(new Error('cancelled'));
      return true;
    },
  };
}
