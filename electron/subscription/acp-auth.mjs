/**
 * Gemini 的「登录」与「模型清单」——全部通过 ACP 问本机 antigravity CLI。
 *
 * 为什么是这条路（对照 github.com/pingdotgg/t3code 的 packages/provider-acp-registry/src/server/auth.ts）：
 * - 登录方式由 agent 自己报：`initialize` 的 `authMethods`（本机 agy 1.5.8 报的是
 *   `oauth-personal` / `oauth-business` / `gemini-api-key` / `agent-platform`）。
 * - 真正的登录动作是 ACP 的 `authenticate({ methodId })`；浏览器由 agent 自己拉起。
 *   —— 不是我们之前猜的 `agy auth login`（1.5.8 根本没有 auth 子命令，1.2 秒非零退出）。
 * - 「已登录」的唯一证据是能开出一个会话：`session/new` 成功。
 * - 模型清单来自 `session/new` 返回的 `models.availableModels`：
 *   `[{ modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' }, …]`
 *   —— 不是 `agy models`（那条命令实测经常返回空清单，正是它把登录卡住的）。
 * - 退出用 ACP 的 `logout`（agent 在 `agentCapabilities.auth.logout` 里声明支持）。
 *
 * 本模块只做「说 ACP」，不碰凭据文件、不存 token：凭据一直归 CLI 自己所有。
 * 纯逻辑（normalize*）与 IO（run）分开，方便直接测。
 */
import { createAcpClient } from '../acp/client.mjs';
import { toErrorCode } from './contract.mjs';

/** ACP 协议版本：本机 agy 与我们的探针都用 1。 */
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = Object.freeze({ name: 'Mova', version: '0.1.0' });
/** 开会话/初始化不该超过这个时间；真正等用户授权的那次请求另算。 */
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 180_000;

/**
 * `models.availableModels` → 我们的目录形状。
 * 认不出的条目直接丢弃：宁可少给一个模型，也不能给一个点下去必然报错的 id。
 */
export function normalizeAcpModels(raw) {
  const list = Array.isArray(raw?.availableModels) ? raw.availableModels : [];
  const models = [];
  const seen = new Set();
  for (const entry of list) {
    const id = typeof entry?.modelId === 'string' ? entry.modelId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    models.push({ id, label: name });
  }
  return models;
}

/** `authMethods` → 精简形状。type 缺失按规范当 `agent`（即需要显式 authenticate）。 */
export function normalizeAuthMethods(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter(method => method && typeof method.id === 'string' && method.id.length > 0)
    .map(method => ({
      id: method.id,
      name: typeof method.name === 'string' && method.name ? method.name : method.id,
      description: typeof method.description === 'string' ? method.description : '',
      type: typeof method.type === 'string' && method.type ? method.type : 'agent',
    }));
}

/** 浏览器登录优先用个人 Google 账号，其次企业版；两者都没有就让上层报错。 */
export function pickGoogleMethod(methods) {
  const list = Array.isArray(methods) ? methods : [];
  return list.find(method => method.id === 'oauth-personal')
    ?? list.find(method => method.id === 'oauth-business')
    ?? list.find(method => method.type === 'agent' && /google|oauth/i.test(method.id))
    ?? null;
}

function describeError(error) {
  const code = toErrorCode(error);
  const detail = typeof error?.detail === 'string' ? error.detail : String(error?.message ?? error);
  return `${code}: ${detail.slice(0, 200)}`;
}

/**
 * 起一个 ACP 连接跑一段操作，结束时一定关掉。
 * `spawn` 由调用方注入（生产是 node:child_process 的 spawn，测试里是假进程）。
 */
async function run({ spawn, command, args = ['acp'], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS }, operation) {
  if (typeof spawn !== 'function') return { ok: false, detail: 'no_spawn' };
  if (typeof command !== 'string' || command.length === 0) return { ok: false, detail: 'no_command' };
  const client = createAcpClient({ spawn, timeoutMs });
  try {
    client.start({ command, args, cwd, env });
    // agent 可能在登录流程里发 elicitation 请求：我们这里没有 UI 通道，统一婉拒，
    // 让 agent 退回它自己的浏览器流程（agy 1.5.8 就是这么做的）。
    client.onRequest(async () => ({ action: 'decline' }));
    return await operation(client);
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  } finally {
    try { client.close(); } catch { /* 关不掉也不该让调用方失败 */ }
  }
}

function initialize(client) {
  return client.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: CLIENT_INFO,
  });
}

/**
 * 问 agent：登录方式有哪些？现在能不能开会话（= 是否已登录）？模型有哪些？
 *
 * @returns {Promise<{ ok: boolean, agentInfo: object|null, authMethods: Array,
 *   models: Array, authorized: boolean, canLogout: boolean, detail: string }>}
 */
export async function acpDescribe(options = {}) {
  const result = await run(options, async (client) => {
    const init = await initialize(client);
    const authMethods = normalizeAuthMethods(init?.authMethods);
    const canLogout = Boolean(init?.agentCapabilities?.auth?.logout);
    const agentInfo = init?.agentInfo && typeof init.agentInfo === 'object' ? init.agentInfo : null;
    let models = [];
    let tier = null;
    let detail = '';
    try {
      const session = await client.request('session/new', { cwd: options.cwd ?? process.cwd(), mcpServers: [] });
      models = normalizeAcpModels(session?.models);
      tier = readAcpTier(session);
    } catch (error) {
      // 开会话失败通常就是「还没登录」：把原因留着，界面据此提示去授权。
      detail = describeError(error);
    }
    return { ok: true, agentInfo, authMethods, models, tier, authorized: models.length > 0, canLogout, detail };
  });
  return {
    agentInfo: null, authMethods: [], models: [], tier: null, authorized: false, canLogout: false, ...result,
  };
}

/**
 * `session/new` 的 `_meta.antigravity.tier` → `{ id, name }`。
 * 用来在界面上写清「这个号是 Google AI Pro 还是免费额度」，拿不到就返回 null。
 */
export function readAcpTier(session) {
  const tier = session?._meta?.antigravity?.tier;
  if (!tier || typeof tier !== 'object') return null;
  const id = typeof tier.id === 'string' ? tier.id.trim() : '';
  const name = typeof tier.name === 'string' ? tier.name.trim() : '';
  if (!id && !name) return null;
  return { id, name: name || id };
}

/**
 * 触发一次登录：`authenticate({ methodId })`，然后**用开会话证明成功**。
 * 浏览器由 agent 自己打开；这里只等它把凭据落好。
 */
export async function acpAuthenticate(options = {}) {
  const methodId = typeof options.methodId === 'string' ? options.methodId : '';
  if (!methodId) return { ok: false, models: [], detail: 'no_method' };
  const result = await run({ ...options, timeoutMs: options.timeoutMs ?? AUTH_TIMEOUT_MS }, async (client) => {
    const init = await initialize(client);
    const methods = normalizeAuthMethods(init?.authMethods);
    const method = methods.find(item => item.id === methodId);
    if (!method) return { ok: false, models: [], detail: `agent 没有声明登录方式 ${methodId}` };
    await client.request('authenticate', { methodId });
    // 登录是否真的成功，只认「能开会话」这一条（与 t3code 的 verify 完全一致）。
    const session = await client.request('session/new', { cwd: options.cwd ?? process.cwd(), mcpServers: [] });
    const models = normalizeAcpModels(session?.models);
    return { ok: models.length > 0, models, tier: readAcpTier(session), detail: models.length > 0 ? '' : '登录后仍然拿不到模型清单' };
  });
  return { models: [], tier: null, ...result };
}

/** 退出登录：ACP `logout`。agent 不支持就如实回报，不假装成功。 */
export async function acpLogout(options = {}) {
  const result = await run(options, async (client) => {
    const init = await initialize(client);
    if (!init?.agentCapabilities?.auth?.logout) {
      return { ok: false, detail: 'agent 没有声明 logout 能力' };
    }
    await client.request('logout', {});
    return { ok: true, detail: '' };
  });
  return { ok: false, detail: '', ...result };
}

/**
 * 强制走一次「新的」Google 授权：先 `logout`，再 `authenticate`。
 *
 * 为什么要两步、且必须是两个进程：agy 1.5.8 的登录态在系统级位置（Windows 凭据管理器 /
 * 固定的用户目录），不跟随 HOME / --app-data-dir 切换，所以「已登录」时直接 authenticate
 * 可能沿用旧凭据。先在**进程 A** 里 logout 把它清成未登录，关掉进程，再用**进程 B**
 * 发 authenticate，浏览器才会真的弹出账号选择。
 *
 * 两个步骤都可以注入（测试与替代外壳）；默认就是上面两个真实实现。
 * logout 失败不算致命：有些版本在未登录状态下会直接报错，这时继续 authenticate 即可。
 */
export async function acpForceRelogin({
  logout = acpLogout, authenticate = acpAuthenticate, ...options
} = {}) {
  const methodId = typeof options.methodId === 'string' && options.methodId ? options.methodId : 'oauth-personal';
  let logoutResult = { ok: false, detail: 'skipped' };
  try {
    logoutResult = await logout(options);
  } catch (error) {
    logoutResult = { ok: false, detail: describeError(error) };
  }
  // 换进程：run() 每次都会新起一个子进程并在结束时关掉，这里刻意分成两次调用。
  const authOptions = { ...options, methodId };
  const auth = await authenticate(authOptions);
  return {
    ...auth,
    loggedOut: logoutResult?.ok === true,
    logoutDetail: typeof logoutResult?.detail === 'string' ? logoutResult.detail : '',
    methodId,
  };
}
