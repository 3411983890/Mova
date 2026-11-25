/**
 * ChatGPT 订阅：直接复用 Codex CLI 已经登录好的那份凭据。
 *
 * 为什么这么做（对照 github.com/pingdotgg/t3code 的做法）：
 * t3code 不自己实现 OAuth —— 它驱动 `codex app-server`，登录走 `account/login/start`、
 * 额度走 `account/rateLimits/read`、模型走 `model/list`，凭据全归 CLI。
 * 本机没有 `codex` 可执行文件，但**登录态是完整的**（`~/.codex/auth.json`：
 * `auth_mode: "chatgpt"`、`tokens.access_token`、`tokens.refresh_token`、
 * `tokens.oauth_provenance.client_id`、`tokens.account_id`）。
 *
 * 所以这里取最小等价做法：读那份文件，用其中的 `access_token` + `account_id`（即
 * `chatgpt-account-id` 头）与官方 `client_id` 去刷新。**不再自建 OAuth 客户端** ——
 * 之前用自签的 `dynamic_agent_client` 去打 `chatgpt.com/backend-api/wham/usage`，
 * 结果必然是 401（缺 account 头、client 也不对）。
 *
 * 本模块只读、不写 CLI 的文件；token 只在内存与主进程加密存储里流转，绝不进日志。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Codex 默认把凭据放在 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）。 */
export function codexAuthFile({ env = process.env, home = homedir() } = {}) {
  const explicit = typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : '';
  return join(explicit || join(home, '.codex'), 'auth.json');
}

/** base64url → JSON。解不出来就返回 null（调用方按「字段缺失」处理）。 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** 秒级 `exp` → 毫秒时间戳。缺字段返回 undefined（调用方会当成「不可用」）。 */
function expiryOf(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
}

function pickString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

/**
 * 解析 `auth.json` 的内容。
 *
 * @returns {{ ok: boolean, detail: string, tokens: {
 *   access: string, refresh: string, idToken: string, accountId: string,
 *   clientId: string, issuer: string, email: string, plan: string, expiresAt: number|undefined,
 * } | null }}
 */
export function parseCodexAuth(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, detail: 'empty', tokens: null };
  const authMode = pickString(payload.auth_mode);
  // 只认 chatgpt 登录态：api key 模式没有 refresh token，也没有 account_id。
  if (authMode && authMode !== 'chatgpt') {
    return { ok: false, detail: `auth_mode=${authMode}`, tokens: null };
  }
  const tokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : {};
  const access = pickString(tokens.access_token);
  const refresh = pickString(tokens.refresh_token);
  const idToken = pickString(tokens.id_token);
  if (!access || !refresh) return { ok: false, detail: 'missing_tokens', tokens: null };
  const provenance = tokens.oauth_provenance && typeof tokens.oauth_provenance === 'object' ? tokens.oauth_provenance : {};
  const claims = decodeJwtPayload(idToken);
  const auth = claims && claims['https://api.openai.com/auth'] && typeof claims['https://api.openai.com/auth'] === 'object'
    ? claims['https://api.openai.com/auth']
    : {};
  return {
    ok: true,
    detail: '',
    tokens: {
      access,
      refresh,
      idToken,
      // 上游的 account id（uuid）：额度接口必须带这个头，否则 401。
      accountId: pickString(tokens.account_id, claims?.chatgpt_account_id, auth?.chatgpt_account_id),
      // 官方 client id：刷新令牌时必须用它，自签的会被拒。
      clientId: pickString(provenance.client_id, tokens.client_id),
      issuer: pickString(provenance.issuer),
      email: pickString(claims?.email),
      plan: pickString(claims?.chatgpt_plan_type, auth?.chatgpt_plan_type, claims?.plan_type),
      expiresAt: expiryOf(access) ?? expiryOf(idToken),
    },
  };
}

/** 读文件 + 解析。失败一律返回 `{ ok:false, detail }`，不抛。 */
export async function readCodexAuth({ readFile, env, home } = {}) {
  const file = codexAuthFile({ env, home });
  if (typeof readFile !== 'function') return { ok: false, detail: 'no_readFile', file, tokens: null };
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'not_found' : 'unreadable';
    return { ok: false, detail: code, file, tokens: null };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'invalid_json', file, tokens: null };
  }
  return { ...parseCodexAuth(payload), file };
}

/**
 * 把 Codex 登录态变成账号记录（我们的 store/pool 认的形状）。
 * `hash` 由调用方注入（ipc.mjs 用 sha256Hex），保持这个模块零依赖、可测。
 */
export function codexRecord(tokens, { now = Date.now, hash } = {}) {
  if (!tokens || typeof tokens !== 'object') return null;
  const identity = pickString(tokens.accountId, tokens.email);
  if (!identity) return null;
  const accountId = typeof hash === 'function' ? hash(`codex:${identity}`) : `codex:${identity}`;
  return {
    type: 'codex',
    provider: 'chatgpt',
    accountId,
    access: tokens.access,
    refresh: tokens.refresh,
    clientId: tokens.clientId || undefined,
    chatgptAccountId: tokens.accountId || undefined,
    expiresAt: tokens.expiresAt,
    ...(tokens.email ? { email: tokens.email } : {}),
    ...(tokens.plan ? { plan: tokens.plan } : {}),
    state: 'ready',
    limitedUntil: 0,
    lastError: '',
    createdAt: now(),
    importedFrom: 'codex-cli',
  };
}

/**
 * ChatGPT 订阅的模型清单：读 Codex CLI 自己的缓存 `models_cache.json`。
 *
 * 为什么是文件而不是接口：ChatGPT/Codex 侧没有可用的 HTTP 枚举接口（t3code 也是让
 * codex app-server 走 `model/list`，那份清单同样是 CLI 内置的）。本机没装 codex 可执行
 * 文件，但缓存就在 `~/.codex/models_cache.json`（实测 10 个模型，带 slug / 显示名 /
 * 每一档 reasoning effort / context_window）。
 */
export function codexModelsFile({ env = process.env, home = homedir() } = {}) {
  const explicit = typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : '';
  return join(explicit || join(home, '.codex'), 'models_cache.json');
}

/** 我们的思考档位白名单（与 providers.cjs 的 EFFORTS 一致）；上游多出来的档位如实丢弃。 */
const KNOWN_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** `models_cache.json` → 模型目录形状。认不出的条目直接跳过。 */
export function parseCodexModels(payload) {
  const list = Array.isArray(payload?.models) ? payload.models : [];
  const models = [];
  const seen = new Set();
  for (const entry of list) {
    const id = typeof entry?.slug === 'string' ? entry.slug.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry?.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : id;
    const efforts = [];
    for (const level of Array.isArray(entry?.supported_reasoning_levels) ? entry.supported_reasoning_levels : []) {
      const effort = typeof level?.effort === 'string' ? level.effort.trim().toLowerCase() : '';
      if (KNOWN_EFFORTS.includes(effort) && !efforts.includes(effort)) efforts.push(effort);
    }
    const modalities = Array.isArray(entry?.input_modalities) ? entry.input_modalities.map(item => String(item).toLowerCase()) : [];
    const contextWindow = Number(entry?.context_window ?? entry?.max_context_window);
    models.push({
      id,
      name,
      vision: modalities.includes('image'),
      efforts: KNOWN_EFFORTS.filter(effort => efforts.includes(effort)),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    });
  }
  return models;
}

/** 读缓存文件；失败一律返回 `{ ok:false, detail }`，不抛。 */
export async function readCodexModels({ readFile, env, home } = {}) {
  const file = codexModelsFile({ env, home });
  if (typeof readFile !== 'function') return { ok: false, models: [], detail: 'no_readFile', file };
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, models: [], detail: error?.code === 'ENOENT' ? 'not_found' : 'unreadable', file };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, models: [], detail: 'invalid_json', file };
  }
  const models = parseCodexModels(payload);
  return { ok: models.length > 0, models, detail: models.length > 0 ? '' : 'empty', file };
}
