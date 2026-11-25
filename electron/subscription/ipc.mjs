/**
 * 订阅（CLI 模型）服务层 + `subscription:*` IPC 注册。
 *
 * 负责：凭据加解密（safeStorage 异步接口）、登录流程、令牌刷新、额度刷新、设置持久化、
 * 账号视图/模型目录，以及事件广播。
 * 不负责：OAuth/探针/调度的纯逻辑（contract/store/pool/usage/login 各管一段），
 * 也不负责请求编排与界面（chat-agent、渲染层）。
 * 被谁调用：electron/main.cjs（安装/卸载）；model-ipc 通过 runtime 注册表拿 service 取令牌与选号。
 *
 * 关键决策：
 * - safeStorage 异步加密不可用时**拒绝写入**（§6）：宁可报 credential，也不退化成明文。
 * - 刷新一律在 `store.modify` 的写链里做，避免并发双刷把 refresh token 刷废；失败保留旧记录并标记 expired。
 * - ChatGPT 只认「浏览器授权」：用 Codex CLI 的公开 PKCE 客户端登录，凭据归 Mova 自己。
 *   不读 `~/.codex/auth.json`——那是本机 Codex 的登录态，不是这个产品的账号。
 * - Gemini 的凭据归 agy 自己所有：Mova 只调 ACP 的 logout/authenticate，不落任何 Google secret。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ACCOUNT_STATES, CHANNELS, CHATGPT_CHANNELS, ERROR_TEXT, EVENT_KINDS, LOGIN_STATES,
  MODEL_SETTING_KEYS, PROVIDERS, SubscriptionError, toErrorCode,
} from './contract.mjs';
import { createAccountStore, maskAccount } from './store.mjs';
import { createPool } from './pool.mjs';
import { setSubscriptionRuntime } from './runtime.mjs';
import { probeChatgpt, probeGemini } from './usage.mjs';
// Gemini 的订阅额度只能从 CLI 自己的交互式面板拿（ACP 不提供配额 RPC，见方案 §1.2）：
// ConPTY 跑一次 `/usage` + 纯函数解析，另配一个节流器与 429 回写。
import { USAGE_CODES, probeGeminiCli, probeGeminiUsageViaPrint } from './gemini-usage-cli.mjs';
import { createUsageProbeScheduler } from './gemini-usage-schedule.mjs';
import { applyRateLimitToUsage, parseRateLimitSignal } from './gemini-usage-limit.mjs';
import { loginGemini } from './gemini-login.mjs';
// Gemini 的登录/登出/模型清单全走 ACP 问本机 CLI：凭据始终归 agy 自己所有。
import {
  acpAuthenticate, acpDescribe, acpForceRelogin, acpLogout, pickGoogleMethod,
} from './acp-auth.mjs';
import { effortsFromLabel, groupModels, resolveVariantId } from './cli-models.mjs';
import { codexClaims } from './codex-oauth.mjs';
import subscriptionModels from '../subscription-models.cjs';
import {
  CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_PORT, buildAuthorizeUrl, createPkce, exchangeCode, isUsable,
  parseCallback, refreshAccessToken,
} from './login.mjs';

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_PATH = '/auth/callback';
const SETTINGS_FILE = 'subscription-settings.json';
const CHANNEL_TEST_TIMEOUT_MS = 15_000;
/** 设置里允许的刷新节奏（分钟）…
 */
const REFRESH_INTERVALS = Object.freeze([5, 15, 60, -1]);
/**
 * 额度探针的并发上限…
 * 全串行会让多账号刷新排到十几秒；上限 3 是…
 */
const USAGE_PROBE_CONCURRENCY = 3;

/** 内置模型目录：真实清单将来由上游/CLI 探测替换，这里先给一版可用的（…
 */
const MODEL_CATALOG = Object.freeze({
  chatgpt: Object.freeze([
    Object.freeze({ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'gpt-5.6-luna · 272K 上下文 · 支持图片与推理强度' }),
    Object.freeze({ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'gpt-5.6-sol · 400K 上下文 · 支持图片与推理强度' }),
    Object.freeze({ id: 'gpt-5.1-mini', label: 'GPT-5.1 mini', note: 'gpt-5.1-mini · 128K 上下文 · 轻量任务优先' }),
  ]),
  gemini: Object.freeze([
    Object.freeze({ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', note: 'gemini-3.1-pro · 1M 上下文 · 由 antigravity CLI 执行' }),
    Object.freeze({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'gemini-3.8-flash · 1M 上下文 · 速度优先' }),
    Object.freeze({ id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', note: 'gemini-3.1-flash-lite · 1M 上下文 · 最低成本' }),
  ]),
});

/** 会话模型的四项默认…
 */
const MODEL_KEY_DEFAULTS = Object.freeze({
  chatgptModel: '',
  geminiModel: '',
  thinkingEffort: 'medium',
  imageInput: true,
});

/** 缺省设置（…
 */
const DEFAULT_SETTINGS = Object.freeze({
  autoSwitch: true,
  preferredAccountId: null,
  remindBelowPercent: null,
  refreshIntervalMins: 5,
  channel: 'chatgpt-plan',
  geminiRunner: 'acp',
  exposeToolsToCli: true,
  cliPath: '',
  ...MODEL_KEY_DEFAULTS,
});

const asBool = value => (typeof value === 'boolean' ? value : undefined);
const asString = limit => value => (typeof value === 'string' ? value.slice(0, limit) : undefined);

/** 单字段校验：返回 undefined 表示「这个…
 */
const SETTING_RULES = {
  autoSwitch: asBool,
  preferredAccountId: value => (value === null ? null : typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : undefined),
  remindBelowPercent: value => {
    if (value === null) return null;
    const percent = Number(value);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : undefined;
  },
  refreshIntervalMins: value => (REFRESH_INTERVALS.includes(Number(value)) ? Number(value) : undefined),
  channel: value => (CHATGPT_CHANNELS.includes(value) ? value : undefined),
  geminiRunner: value => (value === 'acp' || value === 'off' ? value : undefined),
  exposeToolsToCli: asBool,
  cliPath: asString(4096),
  chatgptModel: asString(120),
  geminiModel: asString(120),
  thinkingEffort: asString(32),
  imageInput: asBool,
};
// 契约里那四项即使换了字段名也要能原样回写：兜底规则保证不会把渲染层的值吞掉…
for (const key of MODEL_SETTING_KEYS) {
  SETTING_RULES[key] ??= value => (['string', 'number', 'boolean'].includes(typeof value) ? value : undefined);
}
Object.freeze(SETTING_RULES);

/** 合并设置：非法字段保持原值，未出现的字段不动（PATCH 语义）…
 */
function coerceSettings(input, base) {
  const next = { ...base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return next;
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = rule(input[key]);
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value;
  return '';
}

/**
 * 分批跑任务，逐条收敛成败（allSettled 语义）…
 */
async function settleInBatches(items, limit, run) {
  const size = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1;
  const outcomes = [];
  for (let index = 0; index < items.length; index += size) {
    const batch = items.slice(index, index + size);
    outcomes.push(...await Promise.allSettled(batch.map(item => run(item))));
  }
  return outcomes;
}

/** 登录结果页与换取令牌之间唯一的「读声明」入口：身份全在 access token 里（见 codex-oauth.mjs）。 */
function page(text) {
  return `<!doctype html><meta charset="utf-8"><title>Mova</title>`
    + `<body style="font:14px/1.6 system-ui;background:#1d1d1d;color:#ededed;padding:32px">${text}</body>`;
}

function sendHtml(res, status, html) {
  try {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch {
    // 浏览器可能已经断开；回调结果已经落盘，这里不影响流程。
  }
}

/**
 * @param {{
 *   ipcMain: { handle: Function, removeHandler?: Function },
 *   app?: { getPath?: Function, getName?: Function },
 *   shell?: { openExternal: Function },
 *   safeStorage: { isAsyncEncryptionAvailable: Function, encryptStringAsync: Function, decryptStringAsync: Function },
 *   userDataDir?: string,
 *   fetch?: Function,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   dialog?: object,                  // 可…
 *   getWindows?: () => any[],         // 可…
 *   loginTimeoutMs?: number,          // 可…
 *   loginGemini?: Function,           // 可…
 *   probeGemini?: Function,           // 可…
 *   probeGeminiCli?: Function,        // 可…
 */
export function installSubscriptionIpc({
  ipcMain, app, shell, safeStorage, userDataDir, fetch: fetchOption, logger,
  dialog: dialogOption, getWindows: getWindowsOption, now, loginTimeoutMs = LOGIN_TIMEOUT_MS,
  // 回调端口：默认 1455（上游唯一接受的地址）；测试用 0 换随机端口，避免并行用例抢占同一个端口。
  redirectPort = CHATGPT_REDIRECT_PORT,
  // Gemini 的两处外部依赖：登录与探针；注入时整段替换，测试不碰真实 CLI / 网络。
  loginGemini: loginGeminiOption, probeGemini: probeGeminiOption, probeGeminiCli: probeGeminiCliOption,
  // CLI 定位探针（agy 在不在、版本够不够）。注入后 `list` / `cliStatus` 都不再碰真实文件系统。
  cliStatus: cliStatusOption,
  // 额度探针要用的代理环境变量（`providerId => env|null`）。注入后测试不碰 VPN 运行时。
  vpnEnvForModel: vpnEnvOption,
  // 带代理的 fetch（`providerId => fetch|null`）。ChatGPT 的额度探针与令牌刷新都走它。
  vpnFetchForModel: vpnFetchOption,
  // 只替换「默认探针的 ConPTY 传输层」：`probeGeminiCli` 注入会整段换掉默认探针
  //（含 print 优先与代理环境变量），这个选项留着给这一层单独做单测。
  geminiCliTransport: geminiCliTransportOption,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new SubscriptionError('request', { detail: 'ipcMain' });
  if (!safeStorage || typeof safeStorage.encryptStringAsync !== 'function') {
    throw new SubscriptionError('credential', { detail: 'safeStorage' });
  }
  const baseDir = typeof userDataDir === 'string' && userDataDir.length > 0
    ? userDataDir
    : app?.getPath?.('userData');
  if (typeof baseDir !== 'string' || baseDir.length === 0) throw new SubscriptionError('request', { detail: 'userDataDir' });

  const clock = typeof now === 'function' ? now : Date.now;
  const httpFetch = typeof fetchOption === 'function' ? fetchOption : globalThis.fetch;
  // 模型目录（subscription-models.json）和 providers.cjs 用同一份文件：登录成功就写进去。
  /** Gemini 的登录与探针默认用真实实现，注入时整段替换（签名保持一致）。 */
  const loginGeminiImpl = typeof loginGeminiOption === 'function' ? loginGeminiOption : loginGemini;
  const probeGeminiImpl = typeof probeGeminiOption === 'function' ? probeGeminiOption : probeGemini;
  /**
   * CLI 托管账号（`type: 'cli'`）的额度探针：默认实现 = 先定位 `agy`，再拉 ConPTY 跑 `/usage`。
   * 注入时整段替换（签名 `({ accountId }) => Promise<{ checkedAt, windows, reason?, detail?, email?, status, ms }>`），
   * 测试因此不需要真的起进程、也不需要真的找 CLI。
   */
  const geminiCliProbe = typeof probeGeminiCliOption === 'function' ? probeGeminiCliOption : defaultGeminiCliProbe;
  /** 默认探针内部用的 ConPTY 传输层（只在这一层做注入，见 options.geminiCliTransport）。 */
  const geminiCliTransport = typeof geminiCliTransportOption === 'function' ? geminiCliTransportOption : probeGeminiCli;
  /**
   * 探针节流器：单飞 + 30s 冷却 + 失败指数退避（§5.2）。一次探针要起两个进程（PowerShell 桥 + agy），
   * 设置页定时刷新、用户连点、429 后的校准都走这里，避免同时起多个 agy 把 CLI 登录态锁住。
   */
  const geminiUsageScheduler = createUsageProbeScheduler({ now: clock });
  // 日志出口：只做收口，任何一次日志出错都不许影响主流程。
  const log = {
    info: (message, data) => { try { (logger?.info ?? (() => {}))(message, data); } catch { /* 日志不许影响主流程 */ } },
    warn: (message, detail) => {
      try { (logger?.warn ?? console.warn)(message, detail ?? ''); } catch { /* 同上 */ }
    },
  };

  // ┢…
  const store = createAccountStore({
    dir: baseDir,
    encrypt: text => safeStorage.encryptStringAsync(text),
    decrypt: data => safeStorage.decryptStringAsync(data),
    readFile,
    writeFile,
    rename,
    mkdir,
    rm,
    now: clock,
  });

  /**
   * 写操作的前置闸门：拿不到加密就不写，绝不逢…
   * 注意 Electron 45 …
   * 现在不是）…
 */
  async function encryptionAvailable() {
    try {
      const pending = safeStorage.isAsyncEncryptionAvailable();
      const value = pending && typeof pending.then === 'function' ? await pending : pending;
      return value === true;
    } catch {
      return false;
    }
  }
  async function assertWritable() {
    if (!(await encryptionAvailable())) throw new SubscriptionError('credential', { detail: 'unavailable' });
  }

  // ┢…
  async function writeAtomic(path, data) {
    const temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  const settingsPath = join(baseDir, SETTINGS_FILE);
  let settingsCache = null;
  async function loadSettings() {
    if (settingsCache) return settingsCache;
    let text = null;
    try {
      text = await readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        settingsCache = { ...DEFAULT_SETTINGS };
        return settingsCache;
      }
      log.warn('subscription settings unreadable, using defaults', error?.message || String(error));
      settingsCache = { ...DEFAULT_SETTINGS };
      return settingsCache;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      settingsCache = coerceSettings(parsed, DEFAULT_SETTINGS);
    } catch (error) {
      // 损坏时回退默认值并留日志：设置页必须能打开，用户才能自救。
      log.warn('subscription settings corrupt, using defaults', error?.message || String(error));
      settingsCache = { ...DEFAULT_SETTINGS };
    }
    return settingsCache;
  }
  async function patchSettings(input) {
    const next = coerceSettings(input, await loadSettings());
    await writeAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    settingsCache = next;
    return next;
  }

  // pool 持有这个**活对象**：设置页改优先账号后下一次 pick 立即生效。
  const settingsState = { ...DEFAULT_SETTINGS };
  async function currentSettings() {
    Object.assign(settingsState, await loadSettings());
    return settingsState;
  }
  function publicSettings() {
    const view = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) view[key] = settingsState[key];
    return view;
  }
  async function updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new SubscriptionError('request', { detail: 'patch' });
    }
    const next = await patchSettings(patch);
    Object.assign(settingsState, next);
    return publicSettings();
  }

  const pool = createPool({ store, now: clock, settings: settingsState });

  // ┢…
  let windowsGetter = typeof getWindowsOption === 'function' ? getWindowsOption : null;
  if (!windowsGetter) {
    // Electron 的窗口列表只能从 electron 模块取；动态 import 让本文件在纯 Node 测试里也能加载。
    void import('electron')
      .then((module) => { windowsGetter ??= () => module.BrowserWindow.getAllWindows(); })
      .catch(() => { windowsGetter ??= () => []; });
  }
  function emit(payload) {
    if (!payload || !EVENT_KINDS.includes(payload.kind)) return;
    let windows = [];
    try { windows = windowsGetter?.() ?? []; } catch { windows = []; }
    for (const win of windows) {
      try { win?.webContents?.send(CHANNELS.event, payload); } catch { /* 窗口已关闭 */ }
    }
  }

  // ┢…
  /**
   * 账号视图（脱敏）。只放渲染层真的会读的字段——`use-subscription.js` 的
   * `normalizeAccount()` 会读 `lastUsedAt` / `workspace` / `cli`，少一个界面上就少一句实话：
   * 没有 `lastUsedAt` → ChatGPT 卡片永远写「还没有调用」；没有 `cli` → Gemini 卡片永远写
   * 「CLI 未就绪」，而它其实刚刚读过额度。
   */
  function toAccountView(source, extras = {}) {
    const row = source && typeof source === 'object' ? source : {};
    const view = {
      id: String(row.accountId ?? row.id ?? ''),
      provider: PROVIDERS.includes(row.provider) ? row.provider : 'chatgpt',
      email: typeof row.email === 'string' ? row.email : '',
      plan: typeof row.plan === 'string' ? row.plan : '',
      state: ACCOUNT_STATES.includes(row.state) ? row.state : 'error',
      active: row.active === true,
    };
    if (Number.isFinite(row.limitedUntil)) view.limitedUntil = row.limitedUntil;
    if (Number.isFinite(row.lastUsedAt)) view.lastUsedAt = row.lastUsedAt;
    if (typeof row.workspace === 'string' && row.workspace) view.workspace = row.workspace;
    if (typeof row.lastError === 'string' && row.lastError) view.lastError = row.lastError;
    if (row.usage && typeof row.usage === 'object') view.usage = row.usage;
    if (extras.cli && typeof extras.cli === 'object') view.cli = extras.cli;
    return view;
  }

  /** `{major, minor, patch}` → `"1.5.8"`；读不出来返回 undefined（界面说「版本未知」）。 */
  function cliVersionText(version) {
    if (!version || typeof version !== 'object') return undefined;
    const parts = [version.major, version.minor, version.patch].map(Number);
    return parts.every(Number.isFinite) ? parts.join('.') : undefined;
  }

  function requireProvider(input) {
    const provider = typeof input === 'string' ? input : input?.provider;
    if (!PROVIDERS.includes(provider)) throw new SubscriptionError('request', { detail: 'provider' });
    return provider;
  }
  function optionalProvider(input) {
    const provider = typeof input === 'string' ? input : input?.provider;
    return PROVIDERS.includes(provider) ? provider : null;
  }
  function requireAccountId(input) {
    const accountId = input?.accountId;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new SubscriptionError('request', { detail: 'accountId' });
    }
    return accountId;
  }
  async function findRecord(providerHint, accountId) {
    for (const provider of providerHint ? [providerHint] : PROVIDERS) {
      const record = await store.read(provider, accountId);
      if (record) return record;
    }
    return null;
  }

  /**
   * 刷新 access token。
   * 在 `store.modify` 的写链里做，并且只在写盘成功后返回新令牌：
   * OpenAI 的 refresh token 是一次性轮换，两个并发刷新会让整个登录态作废。
   */
  async function accessTokenFor(record, { force = false, fetch = httpFetch } = {}) {
    if (!record || typeof record !== 'object') throw new SubscriptionError('not_configured');
    // force：上层拿到 401 之后要强刷一次，不能被本地 expiresAt 挡住。
    if (!force && isUsable(record, clock())) return record.access;
    await assertWritable();
    let failure = null;
    try {
      const updated = await store.modify(record.provider, record.accountId, async (current) => {
        if (!current) return undefined;
        if (!force && isUsable(current, clock())) return undefined;
        // 写链内再判一次：别的调用方可能刚刷过，双刷会…
        if (typeof current.refresh !== 'string' || current.refresh.length === 0) {
          throw new SubscriptionError('auth_expired', { detail: 'no_refresh_token' });
        }
        const refreshed = await refreshAccessToken({
          fetch,
          clientId: firstString(current.clientId, CHATGPT_CLIENT_ID),
          refreshToken: current.refresh,
          now: clock,
        });
        // 没轮换时刷新结果不含 refresh，store 的合并会保留旧值。
        return { ...refreshed, state: 'ready', limitedUntil: 0, lastError: '' };
      });
      if (updated && isUsable(updated, clock())) return updated.access;
    } catch (error) {
      failure = error instanceof SubscriptionError ? error : new SubscriptionError('network', { cause: error });
    }
    // 刷新失败：**保留旧记录**（令牌一个字节都不动），只标记 expired，用户还能重试或重新登录。
    const reason = failure ? failure.code : 'auth_expired';
    await pool.markExpired(record.provider, record.accountId, reason).catch(() => {});
    log.warn(`subscription refresh failed ${String(record.accountId).slice(0, 8)}`, reason);
    throw failure ?? new SubscriptionError('auth_expired', { detail: 'refresh' });
  }

  // ┢…
  const flows = new Map();
  let flowCounter = 0;
  /**
   * Gemini 的登录没…
 */
  let geminiLogin = null;

  /**
   * 关闭回调服务器…
   * **默认不调…
   * 表现为浏览器收到 ECONNRESET / 「拒绝连接…
 */
  function closeServer(server, { force = false } = {}) {
    if (!server) return;
    try { server.close(); } catch { /* 已关闭 */ }
    if (force) {
      try { server.closeAllConnections?.(); } catch { /* 旧 Node 没有这个方法 */ }
    }
  }

  function finishFlow(flow, state, { force = false } = {}) {
    flow.state = state;
    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }
    closeServer(flow.server, { force });
    flow.server = null;
    if (flows.get(flow.provider) === flow) flows.delete(flow.provider);
  }

  function emitLogin(flow, state, extra = {}) {
    const next = LOGIN_STATES.includes(state) ? state : 'failed';
    emit({ kind: 'login', provider: flow.provider, state: next, flowId: flow.flowId, ...extra });
  }

  function failFlow(flow, error, { force = false } = {}) {
    if (!flow || ['authorized', 'failed', 'cancelled'].includes(flow.state)) return;
    const state = error?.code === 'auth_cancelled' ? 'cancelled' : 'failed';
    emitLogin(flow, state, { message: error?.message || ERROR_TEXT.request });
    finishFlow(flow, state, { force });
  }

  /**
   * 起回调服务器。先试 1455：OpenAI 对这个客户端的 `redirect_uri` 做字面串校验，
   * `http://localhost:1455/auth/callback` 是唯一被登记过的地址。
   * 端口被占（本机 Codex CLI 或上一次未结束的登录）时退回随机端口：那次登录的授权页
   * 会跳到 `127.0.0.1:<随机>`，仍然能被本机浏览器打到；打不到时还可以用「粘贴回调地址」。
   */
  function listen(server, port = CHATGPT_REDIRECT_PORT) {
    const attempt = target => new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('error', onError);
        if (target !== 0) { attempt(0).then(resolve, reject); return; }
        reject(error);
      };
      server.once('error', onError);
      server.listen(target, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const address = server.address();
        // 固定端口时必须报 localhost（不是 127.0.0.1），否则上游会判 redirect_uri_mismatch。
        const host = address?.port === CHATGPT_REDIRECT_PORT ? 'http://localhost' : 'http://127.0.0.1';
        resolve(`${host}:${address?.port}${CALLBACK_PATH}`);
      });
    });
    return attempt(port);
  }

  /** …
 */
  async function completeFlow(flow, searchParams) {
    flow.state = 'verifying';
    emitLogin(flow, 'verifying');
    // 关键：OpenAI 会在回调里带**它本次实际注册的** client_id（`oaiapp_…`），
    // 换 token 必须用它，否则 invalid_client——表现就是「浏览器授权成功，但 Mova 说授权失败」。
    const parsed = parseCallback(searchParams, { state: flow.pkce.state, redirectUri: flow.redirectUri });
    const code = parsed.code;
    const clientId = firstString(parsed.clientId, flow.clientId, CHATGPT_CLIENT_ID);
    flow.clientId = clientId;
    const tokens = await exchangeCode({
      // 换令牌也要走 ChatGPT 那条线路：`auth.openai.com` 同样在国内直连不通，
      // 而且这一步失败会让人以为「浏览器授权成功但 Mova 没收到」。
      fetch: await chatgptVpnFetch(),
      code,
      verifier: flow.pkce.verifier,
      clientId,
      redirectUri: flow.redirectUri,
      now: clock,
    });
    const idToken = typeof tokens.idToken === 'string' && tokens.idToken.length > 0 ? { idToken: tokens.idToken } : {};
    // 身份从 access token 的声明里读：chatgpt_account_id / chatgpt_plan_type / profile.email。
    // 这正是 wham/usage 与 codex/responses 需要的头，所以它必须存在，不然登录不算成功。
    const claims = codexClaims(tokens.access);
    // codexClaims 的 accountId 就是「chatgpt-account-id 头」要的值，落到记录里换个更直白的名字。
    const chatgptAccountId = claims.accountId;
    const { email, plan } = claims;
    if (!chatgptAccountId) {
      throw new SubscriptionError('auth_expired', { detail: 'access_token_without_account_id' });
    }
    /**
     * 账号身份按「sub → chatgpt_account_id → email」的顺序认：
     * 同一个 ChatGPT 账号换一份令牌重登时，必须落到同一条记录上（覆盖，不新增）。
     */
    const accountId = sha256Hex(firstString(claims.subject, chatgptAccountId, email) || tokens.access);
    // 同一账号再次登录 = 换一份新令牌，不是新账号：直接覆盖旧记录，不再抛 duplicate_account。
    const relogin = await store.read(flow.provider, accountId);
    if (relogin) {
      log.info('subscription account relogin', { provider: flow.provider, account: String(accountId).slice(0, 8) });
    }
    const record = {
      type: 'codex-oauth',
      provider: flow.provider,
      accountId,
      access: tokens.access,
      refresh: typeof tokens.refresh === 'string' ? tokens.refresh : '',
      state: 'ready',
      limitedUntil: 0,
      lastError: '',
      expiresAt: tokens.expiresAt,
      clientId: flow.clientId ?? CHATGPT_CLIENT_ID,
      createdAt: clock(),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...idToken,
      ...(email ? { email } : {}),
      ...(plan ? { plan } : {}),
      chatgptAccountId,
    };
    await store.upsert(flow.provider, record);
    const account = toAccountView(maskAccount(record));
    emitLogin(flow, 'authorized', { account });
    // 登录面板只认 kind:'login'，列表要靠 accounts 事件才会重新拉。
    emit({ kind: 'accounts', provider: flow.provider });
    return { email };
  }

  async function onCallback(flow, req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendHtml(res, 400, page('请求不合法。'));
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      sendHtml(res, 404, page('没有这个回调地址。'));
      return;
    }
    if (flow.state !== 'waiting') {
      sendHtml(res, 200, page('这次登录已经处理过了。'));
      return;
    }
    let outcome;
    try {
      outcome = await completeFlow(flow, url.searchParams);
    } catch (error) {
      const failure = error instanceof SubscriptionError ? error : new SubscriptionError('network', { cause: error });
      // 回调失败必须留一条日志：用户只看到「登录失败」，而真正的原因（端点、参数、令牌声明）
      // 只有在这里才拿得到。detail 里不含任何令牌，只有错误标签。
      log.warn('subscription login callback failed', {
        code: failure.code,
        detail: typeof failure.detail === 'string' ? failure.detail.slice(0, 200) : '',
        reason: failure.cause?.message ? String(failure.cause.message).slice(0, 200) : '',
      });
      // **先写响应再关流程**：反过来会让 closeAllConnections 掐掉这条连接，用户只看到「拒绝连接」。
      sendHtml(res, 200, page(`登录失败：${failure.message}`));
      res.once('finish', () => failFlow(flow, failure));
      return;
    }
    sendHtml(res, 200, page(`已连接 ${outcome.email || '账号'}，可以关闭这个页面了。`));
    res.once('finish', () => finishFlow(flow, 'authorized'));
  }

  async function startLogin(input) {
    const provider = requireProvider(input);
    if (provider !== 'chatgpt') {
      /**
       * Gemini：登录…
       * 实测 1.5.8 的全部子命令：acp / agent(s) / changelog / help / install / mcp / mic-serve /
       * models / plugin(s) / remote-control / update。旧实现…
       * 用户看到的就是…
       * 正确判据：`agy models` 能列出模型，就说明这台机器已经登录过 Google 账号（CLI 自己存着），
       * 直接登记成一条账号即可；列不出来才让用户去终端跑丢…
 */
      await assertWritable();
      if (geminiLogin) throw new SubscriptionError('request', { detail: 'login_in_progress' });

      // 注入实现（测试与替代外壳）：整段替换登录逻辑，签名与 loginGemini 一致。
      if (typeof loginGeminiOption === 'function') {
        const controller = new AbortController();
        geminiLogin = controller;
        const geminiSettings = await currentSettings();
        const [{ access }, { execFile }, { homedir }] = await Promise.all([
          import('node:fs/promises'),
          import('node:child_process'),
          import('node:os'),
        ]);
        const result = await loginGeminiImpl({
          signal: controller.signal,
          settings: geminiSettings,
          platform: process.platform,
          env: process.env,
          home: homedir(),
          profileDir: join(baseDir, 'gemini-profile'),
          access: async candidate => {
            try { await access(candidate); return true; } catch { return false; }
          },
          exec: (command, args, options = {}) => {
            let child = null;
            const pending = new Promise((resolve) => {
              child = execFile(command, args, {
                env: options.env ?? process.env,
                windowsHide: true,
                timeout: options.timeoutMs ?? 5000,
                signal: options.signal,
              }, (error, stdout, stderr) => {
                resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0 });
              });
            });
            pending.kill = () => { try { child?.kill(); } catch { /* 已经退出了 */ } };
            return pending;
          },
          readFile,
          mkdir,
          now: clock,
          timeoutMs: loginTimeoutMs,
          onProgress: state => emit({ kind: 'login', provider: 'gemini', state }),
        }).finally(() => { if (geminiLogin === controller) geminiLogin = null; });
        if (!result?.ok) throw new SubscriptionError(result?.code, { detail: result?.detail });
        const accountId = result.account?.accountId;
        if (typeof accountId !== 'string' || !accountId) throw new SubscriptionError('credential', { detail: 'accountId' });
        const token = result.token ?? {};
        await store.upsert('gemini', {
          type: 'oauth',
          provider: 'gemini',
          accountId,
          refresh: token.refresh_token,
          google: {
            clientId: token.client_id,
            clientSecret: token.client_secret,
            ...(token.project_id ? { projectId: token.project_id } : {}),
          },
          state: 'ready',
          limitedUntil: 0,
          lastError: '',
          createdAt: clock(),
        });
        emit({ kind: 'login', provider: 'gemini', state: 'authorized' });
        emit({ kind: 'accounts', provider: 'gemini' });
        return { provider: 'gemini', state: 'authorized', accountId };
      }

      const controller = new AbortController();
      geminiLogin = controller;
      try {
        emit({ kind: 'login', provider: 'gemini', state: 'verifying' });
        // 先用缓存；只有缓存说「没找到」时才强探一次（刚装…
        let cli = await getCliStatus();
        if (!cli?.found) cli = await getCliStatus({ force: true });
        if (!cli?.found) throw new SubscriptionError('cli_missing', { detail: cli?.detail ?? '' });
        if (cli.compatible === false) throw new SubscriptionError('cli_incompatible', { detail: cli?.detail ?? '' });

        const describe = await acpDescribeCli(cli.command);
        if (!describe.ok) throw new SubscriptionError('acp_protocol', { detail: describe.detail });

        /**
         * **每次「登录」都必须真的弹一次浏览器授权**，不能因为「现在能开出会话」就当成已登录。
         *
         * 原因：agy 把登录态放在系统级位置（Windows 凭据管理器 / 固定用户目录），
         * 不跟随 HOME / --app-data-dir 切换，所以「有模型」只说明这台机器上某个 Google 账号还登着，
         * 并不说明用户此刻要点的是那个账号。于是固定走 logout → 换新进程 → authenticate：
         * 进程 A 清掉旧登录态，进程 B 才真的拉起账号选择页。
         */
        const method = pickGoogleMethod(describe.authMethods);
        if (!method) {
          const ids = describe.authMethods.map(item => item.id).join('/') || '';
          throw new SubscriptionError('cli_not_logged_in', { detail: `CLI 可用的登录方式：${ids}` });
        }
        emit({ kind: 'login', provider: 'gemini', state: 'waiting' });
        const auth = await acpForceReloginCli(cli.command, method.id);
        if (!auth.ok || !Array.isArray(auth.models) || auth.models.length === 0) {
          throw new SubscriptionError('cli_not_logged_in', { detail: auth.detail || '登录后仍然拿不到模型清单' });
        }
        const models = auth.models;
        const tierName = auth.tier?.name || '';

        // 一个 CLI 只有一份登录态：accountId 固定，重复登录是覆盖而不是新增。
        const accountId = sha256Hex('gemini-cli-local');
        // 落库：凭据归 CLI，这里只记「这台机器已经登录过」。
        await store.upsert('gemini', {
          type: 'cli',
          provider: 'gemini',
          accountId,
          email: '本机 antigravity CLI',
          plan: tierName || 'CLI',
          state: 'ready',
          limitedUntil: 0,
          lastError: '',
          createdAt: clock(),
          modelCount: models.length,
          ...(auth.tier ? { tier: auth.tier } : {}),
        });
        // 模型目录同步写：登录成功后右下角菜单里立刻是真模型（ACP 报的清单）。
        const saved = await saveGeminiModels(models);
        emit({ kind: 'login', provider: 'gemini', state: 'authorized' });
        emit({ kind: 'accounts', provider: 'gemini' });
        return { provider: 'gemini', state: 'authorized', accountId, modelCount: models.length, savedModels: saved };
      } finally {
        if (geminiLogin === controller) geminiLogin = null;
      }
    }
    // ChatGPT：只走浏览器授权（Codex 公开 PKCE 客户端）。
    // 这里刻意**不**复用本机 Codex 的登录态：那是 CLI 的账号，不是用户在 Mova 里登录的账号。
    await assertWritable();
    if (flows.has(provider)) throw new SubscriptionError('request', { detail: 'login_in_progress' });
    if (!shell || typeof shell.openExternal !== 'function') throw new SubscriptionError('request', { detail: 'shell' });

    const pkce = createPkce();
    flowCounter += 1;
    const flow = {
      flowId: `flow-${flowCounter}-${randomUUID()}`,
      provider,
      state: 'waiting',
      pkce,
      // 回调地址在 listen 成功后才定（1455 被占时是随机端口），换 token 必须原样回传它。
      redirectUri: '',
      clientId: CHATGPT_CLIENT_ID,
      startedAt: clock(),
      timer: null,
      server: null,
    };
    const server = createServer((req, res) => { void onCallback(flow, req, res); });
    flow.server = server;
    try {
      flow.redirectUri = await listen(server, redirectPort);
    } catch (error) {
      closeServer(server);
      flow.server = null;
      throw new SubscriptionError('network', { detail: 'listen', cause: error });
    }
    flows.set(provider, flow);
    flow.timer = setTimeout(() => failFlow(flow, new SubscriptionError('auth_timeout')), loginTimeoutMs);
    flow.timer.unref?.();

    const authorizeUrl = buildAuthorizeUrl({
      clientId: CHATGPT_CLIENT_ID,
      redirectUri: flow.redirectUri,
      pkce,
    });
    emitLogin(flow, 'waiting');
    try {
      await shell.openExternal(authorizeUrl);
    } catch (error) {
      failFlow(flow, new SubscriptionError('network', { detail: 'open_external', cause: error }));
      throw new SubscriptionError('network', { detail: 'open_external' });
    }
    log.info(`subscription login started ${provider}`);
    return { provider, flowId: flow.flowId, state: flow.state, authorizeUrl };
  }

  /**
   * 手动完成登录：浏览器**到不…
   * 为什么会到不了：系统代理把回环地坢…
 */
  async function completeLoginManual(input) {
    const provider = requireProvider(input);
    const flow = flows.get(provider);
    if (!flow) throw new SubscriptionError('auth_cancelled', { detail: 'no_flow' });
    if (typeof input?.flowId === 'string' && input.flowId && input.flowId !== flow.flowId) {
      throw new SubscriptionError('auth_cancelled', { detail: 'stale_flow' });
    }
    if (flow.state !== 'waiting') throw new SubscriptionError('auth_cancelled', { detail: `state_${flow.state}` });

    const raw = typeof input?.url === 'string' ? input.url.trim() : '';
    if (!raw) throw new SubscriptionError('request', { detail: 'url' });
    let params;
    try {
      // 允许整条 URL，也允许只粘 `?code=...&state=...` 这种尾巴。
      params = new URL(raw, 'http://127.0.0.1').searchParams;
    } catch {
      throw new SubscriptionError('request', { detail: 'url' });
    }
    if (!params.get('code') && !params.get('error') && !raw.includes('=')) {
      params = new URLSearchParams({ code: raw, state: flow.pkce.state });
    }
    if (!params.get('state')) {
      // 只粘了 code（浏览器地址栏里 state 已丢）：用本轮 flow 的 state 补齐。
      params.set('state', flow.pkce.state);
    }
    try {
      const outcome = await completeFlow(flow, params);
      finishFlow(flow, 'authorized', { force: true });
      return { provider, state: 'authorized', email: outcome.email ?? null };
    } catch (error) {
      const failure = error instanceof SubscriptionError ? error : new SubscriptionError('network', { cause: error });
      failFlow(flow, failure, { force: true });
      throw failure;
    }
  }

  async function cancelLogin(input) {
    const provider = requireProvider(input);
    const flow = flows.get(provider);
    if (!flow) {
      // Gemini 走的是本机 CLI 的登录：没有回调服务器，只有一个 AbortController。
      if (geminiLogin) {
        const controller = geminiLogin;
        geminiLogin = null;
        controller.abort();
        emit({ kind: 'login', provider: 'gemini', state: 'cancelled' });
        return { cancelled: true, provider };
      }
      return { cancelled: false, provider };
    }
    // 过期的 flowId（界面还留着上一轮）不能取消新一轮。
    if (typeof input?.flowId === 'string' && input.flowId && input.flowId !== flow.flowId) {
      return { cancelled: false, provider };
    }
    // 用户主动取消：这是我们唯一能动的一次，先推事件再收尾。
    failFlow(flow, new SubscriptionError('auth_cancelled'));
    return { cancelled: true, provider };
  }

  // ┢…
  async function listAll() {
    await currentSettings();
    // CLI 状态必须随首屏一起给出：渲染层拿到 null 会一直显示「正在检测 CLI…」，
    // 而实际上 CLI 好好装着、额度都读出来了（`use-subscription.js` 首屏不再单独发 cliStatus）。
    // getCliStatus 自带 20s TTL 缓存 + 3.5s 硬超时，命中缓存时几乎零成本，不会拖慢 list。
    const cli = await getCliStatus().catch(() => null);
    const geminiCli = cli
      ? { ready: cli.found === true && cli.compatible !== false, version: cliVersionText(cli.version) }
      : null;
    const accounts = [];
    for (const provider of PROVIDERS) {
      const snapshot = await pool.snapshot(provider);
      for (const row of snapshot.accounts) {
        // `cli` 只对 Gemini 有意义：ChatGPT 订阅走 OAuth，不经过本机 CLI。
        accounts.push(toAccountView(row, provider === 'gemini' && geminiCli ? { cli: geminiCli } : {}));
      }
    }
    // 顺带把设置和内置模型目录一起返回：渲染层一次调用就能把整页画出来。
    return { accounts, settings: publicSettings(), models: MODEL_CATALOG, cli: cli ?? null };
  }

  async function logout(input) {
    await assertWritable();
    const accountId = requireAccountId(input);
    const record = await findRecord(optionalProvider(input), accountId);
    if (!record) throw new SubscriptionError('not_configured', { detail: 'account' });
    // 本机 CLI 托管的账号要先让 CLI 自己登出，否则下次登录会沿用旧凭据。
    if (record.type === 'cli' && record.provider === 'gemini') {
    // 本机 CLI 托管…
      const cli = await getCliStatus();
      if (cli?.found && cli.command) {
        const out = await acpLogoutCli(cli.command).catch(() => ({ ok: false, detail: 'logout_failed' }));
        if (!out.ok) log.warn('subscription gemini logout not supported', { detail: out.detail });
      }
    }
    await store.remove(record.provider, record.accountId);
    await currentSettings();
    if (settingsState.preferredAccountId === record.accountId) {
      settingsState.preferredAccountId = null;
      await patchSettings({ preferredAccountId: null }).catch((error) => {
        log.warn('subscription preferred account not persisted', error?.message || String(error));
      });
    }
    emit({ kind: 'accounts', provider: record.provider });
    return { removed: true, provider: record.provider, accountId: record.accountId };
  }

  async function select(input) {
    await currentSettings();
    const accountId = typeof input?.accountId === 'string' && input.accountId ? input.accountId : null;
    let provider = optionalProvider(input);
    if (accountId) {
      const record = await findRecord(provider, accountId);
      if (!record) throw new SubscriptionError('not_configured', { detail: 'account' });
      provider = record.provider;
    }
    const settings = await updateSettings({ preferredAccountId: accountId });
    emit({ kind: 'selection', ...(provider ? { provider } : {}) });
    return settings;
  }

  /**
   * 探针的固定工作目录（userData 下的空目录）。
   *
   * 为什么不直接用当前目录：`agy` 在任意项目目录里会先问「是否信任这个文件夹」，
   * 那是需要人点的确认框，我们的探针既不能替用户点、也不该把用户的项目目录卷进来。
   * 空目录同样不会命中任何项目配置，TUI 起来后就是「新会话」。
   */
  let usageProbeDir = '';
  async function ensureUsageProbeDir() {
    if (usageProbeDir) return usageProbeDir;
    const target = join(baseDir, 'gemini-usage-probe');
    try {
      await mkdir(target, { recursive: true });
      usageProbeDir = target;
    } catch {
      // 建目录失败不该让探针消失：退回 userData 根目录同样不会触发信任向导。
      usageProbeDir = baseDir;
    }
    return usageProbeDir;
  }

  /**
   * 默认实现：定位 CLI → 取额度。
   *
   * **首选 `agy --print "/usage"`**：输出是干净 TSV、重置时间直接给 ISO 绝对时间，
   * 而且**在未受信任的目录里也能跑**。这一点是决定性的——TUI 那条路要求 agy 先信任探针目录
   * （一个空文件夹），每次都要问一遍「Do you trust the contents of this project?」，
   * 护栏（正确地）拒绝后额度就永远读不到：用户看到的正是「设置了账号但一直显示额度未知」。
   *
   * 老版本 CLI 万一不认 `--print`，回退到原有的 ConPTY 实现；两条都失败时报 `--print` 的
   * 原因（它更具体，例如 `cli_trust_required` / `cli_not_logged_in`）。
   */
  /**
   * Gemini 额度探针要走的线路（与对话链路同一条 `subscription:gemini`）。
   *
   * 为什么必须有：`/usage` 是本机 `agy` 直接去问 Google，国内直连必失败——表现就是
   * 「聊天在跑，额度却永远显示额度未知」。对话链路已经按线路分配了代理端口，
   * 探针不跟着走就会出现「同一个 CLI、同一个账号，一个通一个不通」。
   *
   * 永不抛、永不阻断：VPN 没装 / 内核没起 / 这条 provider 没配线路 → 返回 null（直连），
   * 探针自己会把失败原因报出来。先 `refresh()` 是为了把端口缓存热起来——
   * 冷启动时 `ports` 是空的，`envForModel()` 会误判成「直连」。
   */
  async function geminiProbeEnv() {
    try {
      if (typeof vpnEnvOption === 'function') return (await vpnEnvOption('subscription:gemini')) ?? null;
      const mod = await import('../vpn/runtime.mjs');
      const runtime = typeof mod.getVpnRuntime === 'function' ? mod.getVpnRuntime() : null;
      if (!runtime || typeof runtime.envForModel !== 'function') {
        log.info('gemini usage probe route', { viaProxy: false, reason: 'vpn_runtime_unavailable' });
        return null;
      }
      // 刻意**不**在这里调 `runtime.refresh()`：它会探测整段端口的占用，实测能把一次探针拖到
      // 12s 超时（探针没了，用户看到的还是「额度未知」）。线路缓存由开机自启（startCore →
      // ensureCache）和设置页读取预热；万一真的是冷的，这一轮直连、日志里写明原因，下一轮就有。
      const env = runtime.envForModel('subscription:gemini', '') ?? null;
      // 成功和失败都要留记录：只记失败会让人误以为「没走代理」，而实际上这一轮是走了的。
      const route = typeof runtime.routeFor === 'function' ? runtime.routeFor('subscription:gemini', '') : null;
      log.info('gemini usage probe route', {
        viaProxy: Boolean(env),
        port: route?.port ?? null,
        mode: route?.mode ?? null,
        source: route?.source ?? null,
        degraded: route?.degraded ?? null,
        reason: env ? null : (route?.reason || 'no_route'),
      });
      return env;
    } catch (error) {
      log.warn('gemini usage probe env failed', { detail: String(error?.message || error).slice(0, 160) });
      return null;
    }
  }

  async function defaultGeminiCliProbe() {
    const at = clock();
    const cli = await getCliStatus().catch(() => null);
    if (!cli?.found || typeof cli.command !== 'string' || cli.command.length === 0) {
      return {
        checkedAt: at, windows: [], reason: 'probeFailed', detail: USAGE_CODES.cliMissing,
        email: null, status: 'cli_missing', ms: 0, viaProxy: false,
      };
    }
    const cwd = await ensureUsageProbeDir();
    // 与对话链路共用的代理环境变量：`agy` 读 HTTPS_PROXY，读不到就直连 Google（国内必失败）。
    const env = await geminiProbeEnv();
    const viaProxy = Boolean(env);
    const withEnv = env ? { env } : {};
    /**
     * 失败也要带 `viaProxy`：早先它只在成功路径上附加，于是失败日志里永远是
     * `viaProxy:false`——看起来像「没走 VPN」，实际上可能走了、只是 CLI 还在等上游。
     */
    const timed = result => ({ ...(result ?? {}), viaProxy });
    const viaPrint = await probeGeminiUsageViaPrint({ command: cli.command, cwd, now: clock, ...withEnv })
      .catch(() => null);
    if (viaPrint && Array.isArray(viaPrint.windows) && viaPrint.windows.length > 0) return timed(viaPrint);
    const viaTty = await geminiCliTransport({ command: cli.command, cwd, now: clock, ...withEnv }).catch(() => null);
    if (viaTty && Array.isArray(viaTty.windows) && viaTty.windows.length > 0) return timed(viaTty);
    if (viaPrint || viaTty) {
      // 两条路都失败了：报 `--print` 的结论（它更具体，且是首选路径）。
      const primary = viaPrint ?? viaTty;
      return timed(primary);
    }
    return {
      checkedAt: at, windows: [], reason: 'probeFailed', detail: USAGE_CODES.parseFailed,
      email: null, status: 'failed', ms: 0, viaProxy,
    };
  }

  /**
   * CLI 托管账号的额度快照（+ 面板里读到的真实邮箱）。
   *
   * 三层收口，任何一层出问题都只降级成「读不到 + 原因」：
   * 1. 节流器决定这次到底跑不跑（命中冷却/退避就沿用上一次结论）；
   * 2. 探针自己不抛错，失败给稳定错误码（`usage_probe_timeout` 等）；
   * 3. 这里只把 `UsageSnapshot` 的形状交出去，`email` 单独返回——它要写进账号记录，不属于额度。
   */
  async function cliUsageSnapshot(record) {
    const at = clock();
    const outcome = await geminiUsageScheduler.run(record.accountId, () => geminiCliProbe({ accountId: record.accountId }));
    const probed = outcome.result;
    if (!probed || typeof probed !== 'object') {
      log.warn('subscription gemini usage probe skipped', { skipped: outcome.skipped ?? 'no_result', provider: 'gemini' });
      return { usage: { checkedAt: at, windows: [], reason: 'probeFailed', detail: 'usage_probe_timeout' }, email: '' };
    }
    const windowCount = Array.isArray(probed.windows) ? probed.windows.length : 0;
    if (outcome.skipped) {
      log.info('subscription gemini usage probe reused', { skipped: outcome.skipped, windows: windowCount });
      // 节流/退避命中时**优先用已落盘的快照**：它可能带着 429 回写的 `resetsAt` / `limitedUntil`，
      // 拿调度器里那份旧结论覆盖回去等于把刚校准的信息抹掉。
      const stored = record.usage;
      if (stored && Array.isArray(stored.windows) && stored.windows.length > 0) return { usage: stored, email: '' };
    } else {
      // 日志只记状态与耗时，**不记** `/usage` 原文：面板里有真实邮箱（§5.1/§6 的红线）。
      log.info('subscription gemini usage probe', {
        status: typeof probed.status === 'string' ? probed.status : 'unknown',
        ms: Number.isFinite(probed.ms) ? probed.ms : null,
        windows: windowCount,
        // 这一轮是走线路还是直连。国内直连读不到额度，没有这一位就只能猜。
        viaProxy: probed.viaProxy === true,
        detail: typeof probed.detail === 'string' ? probed.detail.slice(0, 80) : null,
      });
    }
    const email = typeof probed.email === 'string' ? probed.email.trim() : '';
    return {
      usage: {
        checkedAt: Number.isFinite(probed.checkedAt) ? probed.checkedAt : at,
        windows: Array.isArray(probed.windows) ? probed.windows : [],
        ...(probed.reason ? { reason: probed.reason } : {}),
        ...(typeof probed.detail === 'string' ? { detail: probed.detail.slice(0, 120) } : {}),
      },
      email: /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 200 ? email : '',
    };
  }

  /**
   * 单个账号的额度探针：失败也要留一条带 reason 的快照，UI 显示 unknown/stale 而不是空白…
   * 这样 `refresh` 的…
 */
  /**
   * ChatGPT 订阅该走的线路（与对话链路同一条 `subscription:chatgpt`）。
   *
   * 为什么必须有：额度探针打的是 `chatgpt.com/backend-api/wham/usage`，刷新令牌打的是
   * `auth.openai.com`——国内直连会一直超时，界面上就是「额度读不到、稍后自动重试」，
   * 而对话那边因为走了线路是好的。同一个订阅、同一段网络，一个通一个不通，只会让人以为账号坏了。
   *
   * 拿不到线路（VPN 没装 / 没分配 / 内核没起）就退回全局 fetch，行为与改动前逐字一致。
   */
  async function chatgptVpnFetch() {
    try {
      if (typeof vpnFetchOption === 'function') return (await vpnFetchOption('subscription:chatgpt')) ?? httpFetch;
      const mod = await import('../vpn/runtime.mjs');
      const runtime = typeof mod.getVpnRuntime === 'function' ? mod.getVpnRuntime() : null;
      if (!runtime || typeof runtime.fetchForModel !== 'function') return httpFetch;
      return runtime.fetchForModel('subscription:chatgpt', '') ?? httpFetch;
    } catch {
      return httpFetch;
    }
  }

  async function refreshUsage(record) {
    const at = clock();
    let usage;
    let probeFailed = false;
    /** `/usage` 面板里读到的真实 Google 邮箱：有就顺手把占位名换掉（§5.2）。 */
    let probedEmail = '';
    if (record.provider === 'chatgpt') {
      // 一次解析、三处复用：刷新令牌、首探、401 后强刷都要走同一条线路，各算一次既慢又可能算出不同结果。
      const probeFetch = await chatgptVpnFetch();
      let accessToken = '';
      try {
        accessToken = await accessTokenFor(record, { fetch: probeFetch });
      } catch (error) {
        accessToken = '';
        // 拿不到令牌也要留一条日志：否则界面上只有「额度读不到」，
        // 排查时完全看不出是刷新失败还是接口变了。
        log.warn('subscription chatgpt access token unavailable', {
          account: String(record.accountId).slice(0, 8),
          code: toErrorCode(error),
        });
      }
      usage = accessToken
        ? await probeChatgpt({
          fetch: probeFetch,
          accessToken,
          accountId: record.accountId,
          chatgptAccountId: record.chatgptAccountId,
          now: clock,
        })
        : { checkedAt: at, windows: [], reason: 'probeFailed', detail: 'no_token' };
      // 与 Gemini 那条同名日志对齐：这一轮到底走没走线路，出错时是唯一能自证的信息。
      log.info('subscription chatgpt usage probe', {
        windows: Array.isArray(usage.windows) ? usage.windows.length : 0,
        viaProxy: probeFetch !== httpFetch,
        reason: usage.reason ?? null,
        detail: typeof usage.detail === 'string' ? usage.detail.slice(0, 80) : null,
      });
      // 401 = 上游明确拒了这枚令牌。本地 expiresAt 可能还没到，所以先强刷一次；
      // 强刷之后还是 401 才说明令牌本身失效，才把账号标成「需要重新登录」。
      if (usage.reason === 'probeFailed' && usage.detail === 'http_401') {
        const refreshed = await accessTokenFor(record, { force: true, fetch: probeFetch }).catch(() => '');
        if (refreshed) {
          usage = await probeChatgpt({
            fetch: probeFetch,
            accessToken: refreshed,
            accountId: record.accountId,
            chatgptAccountId: record.chatgptAccountId,
            now: clock,
          });
        }
        if (usage.reason === 'probeFailed' && usage.detail === 'http_401') {
          // 强刷之后仍然 401：令牌本身是好的（刷新成功），…
          // 也不该一直标「读取失败…
          log.warn('subscription chatgpt usage unauthorised', {
            account: String(record.accountId).slice(0, 8),
            afterRefresh: Boolean(refreshed),
            treatedAs: 'unsupported',
          });
        }
      }
      probeFailed = usage.reason === 'probeFailed';
    } else {
      // CLI 托管时（type:"cli"）额度只能从 CLI 自己的 `/usage` 面板拿：ACP 侧没有配额 RPC
      // （方案 §1.2 实测），所以这里改成 ConPTY 探针，读不到就给原因而不是「unsupported」。
      if (record.type === 'cli') {
        const probed = await cliUsageSnapshot(record);
        usage = probed.usage;
        probedEmail = probed.email;
      } else {
        try {
          usage = await probeGeminiImpl({
            fetch: httpFetch,
            refreshToken: record.refresh,
            clientId: record.google?.clientId,
            clientSecret: record.google?.clientSecret,
            projectId: record.google?.projectId,
            now: clock,
          });
        } catch (error) {
          usage = { checkedAt: at, windows: [], reason: 'probeFailed' };
          log.warn('subscription gemini probe threw', toErrorCode(error));
        }
      }
      // noProject 是「还没选项目」，不是失败：不写 lastError，也不把它当失败重试。
      probeFailed = usage.reason === 'probeFailed';
    }
    const previous = record.usage;
    const next = usage.windows.length === 0 && Array.isArray(previous?.windows) && previous.windows.length > 0
      ? { ...previous, checkedAt: at, stale: true, reason: usage.reason ?? 'probeFailed' }
      : usage;
    await store.modify(record.provider, record.accountId, (current) => {
      if (!current) return undefined;
      const patch = { usage: next };
      if (probeFailed) patch.lastError = 'probeFailed';
      // 只清我们自己写的那条：pool 写的 expired/network 原因不能被一次成功的探针抹掉…
      else if (current.lastError === 'probeFailed') patch.lastError = '';
      // 真实邮箱：`agy` 登录成功后我们只知道「本机 antigravity CLI」，这里才拿到账号本身。
      if (probedEmail) patch.email = probedEmail;
      return { ...current, ...patch };
    }).catch((error) => log.warn('subscription usage not persisted', error?.message || String(error)));
    emit({ kind: 'usage', provider: record.provider });
    return next;
  }

  async function refresh(input) {
    await assertWritable();
    const accountId = typeof input?.accountId === 'string' && input.accountId ? input.accountId : null;
    const provider = optionalProvider(input);
    const targets = [];
    if (accountId) {
      const record = await findRecord(provider, accountId);
      if (!record) throw new SubscriptionError('not_configured', { detail: 'account' });
      targets.push(record);
    } else {
      for (const id of provider ? [provider] : PROVIDERS) {
        for (const view of await store.list(id)) {
          const record = await store.read(id, view.accountId);
          if (record) targets.push(record);
        }
      }
    }
    // 每个账号各自跑一次探针，并发上限 3：同 provider 的账号互不等待，但也不会丢…
    let updated = 0;
    const failed = [];
    const outcomes = await settleInBatches(targets, USAGE_PROBE_CONCURRENCY, record => refreshUsage(record));
    outcomes.forEach((outcome, index) => {
      const record = targets[index];
      if (outcome.status === 'rejected') {
        failed.push({ id: record.accountId, provider: record.provider, reason: toErrorCode(outcome.reason) });
        log.warn(`subscription usage probe failed ${String(record.accountId).slice(0, 8)}`, toErrorCode(outcome.reason));
        return;
      }
      if (outcome.value?.reason === 'probeFailed') {
        failed.push({ id: record.accountId, provider: record.provider, reason: 'probeFailed' });
        // 探针「没抛但没数据」也要留一条日志：否则界面上只看到额度没变，代码里毫无线索。
        log.warn('subscription usage probe returned no data', {
          provider: record.provider,
          account: String(record.accountId).slice(0, 8),
          detail: typeof outcome.value.detail === 'string' ? outcome.value.detail : null,
        });
        return;
      }
      updated += 1;
    });
    // 返回与 list 同形状：渲染层拿到就能直接替换状态，省一次往返。
    return { updated, failed, ...(await listAll()) };
  }

  // ┢…
  const CHANNEL_ENDPOINTS = Object.freeze({
    'chatgpt-plan': Object.freeze({ url: 'https://api.openai.com/v1/responses', model: 'gpt-5.1-mini' }),
    codex: Object.freeze({ url: 'https://chatgpt.com/backend-api/codex/responses', model: 'gpt-5.6-luna' }),
  });

  async function channelTest(input) {
    await currentSettings();
    const raw = typeof input === 'string' ? input : (input?.kind ?? input?.channel ?? input?.provider);
    const kind = raw === 'gemini' ? 'gemini' : CHATGPT_CHANNELS.includes(raw) ? raw : settingsState.channel;
    if (kind === 'gemini') {
      return { status: 'unknown', detail: 'Gemini 由 antigravity CLI 执行，无法在主进程自检' };
    }
    let account;
    try {
      account = (await pool.pick('chatgpt')).account;
    } catch {
      return { status: 'unknown', detail: ERROR_TEXT.not_configured };
    }
    let accessToken;
    try {
      accessToken = await accessTokenFor(account);
    } catch (error) {
      return { status: 'failed', detail: toErrorCode(error) };
    }
    const endpoint = CHANNEL_ENDPOINTS[kind];
    try {
      const response = await httpFetch(endpoint.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(kind === 'chatgpt-plan' ? { 'openai-beta': 'responses=experimental', originator: 'Mova' } : {}),
        },
        body: JSON.stringify({ model: endpoint.model, input: 'ping', max_output_tokens: 1, store: false }),
        signal: AbortSignal.timeout(CHANNEL_TEST_TIMEOUT_MS),
      });
      if (!response) return { status: 'failed', detail: 'no_response' };
      if (response.ok) return { status: 'ok' };
      return { status: 'failed', detail: `http_${response.status}` };
    } catch (error) {
      // 超时/DNS/代理一律当成 failed 结果返回：设置页要显示状态点，不是弹异常。
      const detail = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network';
      return { status: 'failed', detail };
    }
  }

  // ┢…
  async function resolveDialog() {
    if (dialogOption) return dialogOption;
    try {
      const module = await import('electron');
      return module.dialog;
    } catch {
      return null;
    }
  }

  async function pickCliPath() {
    const dialog = await resolveDialog();
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      throw new SubscriptionError('request', { detail: 'dialog' });
    }
    const result = await dialog.showOpenDialog({
      title: '选择 antigravity CLI',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }]
        : [{ name: '可执行文件', extensions: ['*'] }],
    });
    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      // 用户取消不是错误：返回空路径，界面按「没选」处理，既不改设置也不记失败日志。
      return { path: '' };
    }
    const path = String(result.filePaths[0]);
    await updateSettings({ cliPath: path });
    // 用户刚指定了路径：缓存里的旧结论（「没找到」）立刻作废。
    cliStatusCache = { at: 0, value: null, pending: null };
    return { path };
  }

  // ┢…
  const registered = new Map();
  function handle(channel, operation) {
    const listener = async (_event, ...args) => {
      try {
        return { ok: true, value: await operation(...args) };
      } catch (error) {
        const code = toErrorCode(error);
        const message = error instanceof SubscriptionError
          ? error.message
          : firstString(error?.message, ERROR_TEXT[code]) || ERROR_TEXT.request;
        // code 是给界面看的分类；message 已经…
        // 「用户在浏览器里点了拒绝」完全不同…
        log.warn(`subscription ${channel} failed`, {
          code,
          message: message.slice(0, 200),
          detail: error instanceof SubscriptionError ? String(error.detail ?? '').slice(0, 200) : '',
        });
        return { ok: false, error: code, message: message.slice(0, 200) };
      }
    };
    ipcMain.handle(channel, listener);
    registered.set(channel, listener);
  }

  handle(CHANNELS.list, () => listAll());
  handle(CHANNELS.login, input => startLogin(input));
  handle(CHANNELS.completeLogin, input => completeLoginManual(input));
  handle(CHANNELS.cancelLogin, input => cancelLogin(input));
  handle(CHANNELS.logout, input => logout(input));
  handle(CHANNELS.select, input => select(input));
  handle(CHANNELS.refresh, input => refresh(input));
  handle(CHANNELS.settingsGet, async () => {
    await currentSettings();
    return publicSettings();
  });
  handle(CHANNELS.settingsSet, patch => updateSettings(patch));
  handle(CHANNELS.models, async (input) => {
    const provider = optionalProvider(input);
    return provider ? MODEL_CATALOG[provider] : MODEL_CATALOG;
  });
  handle(CHANNELS.channelTest, input => channelTest(input));
  handle(CHANNELS.pickCliPath, () => pickCliPath());
  // CLI 探测单独开一个只读通道：未安装与版本过旧给的安装指引不同，不能笼统报「不可用」。
  handle(CHANNELS.cliStatus, options => getCliStatus(options ?? {}));

  function dispose() {
    // 正在等浏览器授权的 Gemini 登录：abort 之后它自己会收敛成 cancelled。
    if (geminiLogin) {
      const controller = geminiLogin;
      geminiLogin = null;
      try { controller.abort(); } catch { /* 已经结束 */ }
    }
    for (const flow of [...flows.values()]) {
      if (flow.timer) clearTimeout(flow.timer);
      closeServer(flow.server, { force: true });
    }
    flows.clear();
    for (const channel of registered.keys()) {
      try { ipcMain.removeHandler?.(channel); } catch { /* handler 可能已被移除 */ }
    }
    registered.clear();
  }

  /**
   * …
 */
  /**
   * CLI 探测：找不到或版本过旧都如实回报…
   * ┢…
   * `list()` 每次都会带上它，而探测本身要…
   * 上限 5s）…
   * 结果就是设置页首屏一直停…
 */
  const CLI_STATUS_TTL_MS = 20_000;
  const CLI_STATUS_HARD_TIMEOUT_MS = 3_500;
  let cliStatusCache = { at: 0, value: null, pending: null };

  async function probeCliStatus() {
    // 注入优先：测试据此完全不碰文件系统，也不必真的跑一次 agy。
    if (typeof cliStatusOption === 'function') {
      try {
        return await cliStatusOption();
      } catch (error) {
        return { found: false, code: 'cli_missing', detail: `CLI 探测失败：${String(error?.message ?? error).slice(0, 120)}`, tried: [] };
      }
    }
    const startedAt = clock();
    const settings = await currentSettings();
    let result;
    try {
      const [{ locateCli }, { access }, { execFile }, { homedir }] = await Promise.all([
        import('./cli.mjs'),
        import('node:fs/promises'),
        import('node:child_process'),
        import('node:os'),
      ]);
      result = await locateCli({
        settings,
        platform: process.platform,
        env: process.env,
        home: homedir(),
        access: async candidate => { try { await access(candidate); return true; } catch { return false; } },
        exec: (command, args, options = {}) => new Promise(resolve => {
          execFile(command, args, { timeout: options.timeoutMs ?? 5000, windowsHide: true }, (error, stdout, stderr) => {
            resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0 });
          });
        }),
      });
    } catch (error) {
      // 探测失败不是致命错误：上层会退回「用 settings.cliPath」或提示未安装。
      result = { found: false, code: 'cli_missing', detail: `CLI 探测失败：${String(error?.message ?? error).slice(0, 120)}`, tried: [] };
    }
    // 探测耗时进日志：以后排查「设置页为什么转圈」先看这一条。
    log.info('cli-probe', {
      version: typeof result?.version === 'string' ? result.version : null,
      ms: clock() - startedAt,
      found: result?.found === true,
      // version/compatible 保留「未知…
      compatible: result?.compatible ?? null,
      command: typeof result?.command === 'string' ? result.command : null,
      detail: typeof result?.detail === 'string' ? result.detail.slice(0, 200) : null,
    });
    // 探测落定：缓存由 getCliStatus 统一写，这里只如实返回结果。
    return result;
  }

  /** 不挂定时器的 await：只用来给探测兜丢…
 */
  function delay(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /**
   * 对外的探测入口：默认走缓存，`{ force: true }` 跳过缓存（…
 */
  async function getCliStatus(options = {}) {
    const force = options?.force === true;
    if (!force && cliStatusCache.value && clock() - cliStatusCache.at < CLI_STATUS_TTL_MS) {
      return cliStatusCache.value;
    }
    // 并发合并：事件风暴里同时来十几次，也只探一次，其余等同一个 promise。
    if (!cliStatusCache.pending) {
      cliStatusCache.pending = probeCliStatus()
        .then(value => {
          cliStatusCache = { at: clock(), value, pending: null };
          return value;
        })
        .catch(error => {
          cliStatusCache.pending = null;
          throw error;
        });
    }
    const pending = cliStatusCache.pending;
    const settled = await Promise.race([pending.then(value => ({ value }), () => null), delay(CLI_STATUS_HARD_TIMEOUT_MS).then(() => null)]);
    if (settled) return settled.value;
    // 探测还在跑：这一次先给上一次的结论（或「未知」），不让设置页一直转圈。
    return cliStatusCache.value ?? { found: false, code: 'cli_missing', detail: 'CLI 探测尚未完成', tried: [] };
  }

  /**
   * 给…
 */
  async function listAcpModels(command) {
    const described = await acpDescribeCli(command);
    return {
      ok: described.ok && described.models.length > 0,
      models: described.models.map(model => ({
        id: model.id,
        name: model.label || model.id,
        vision: true,
        efforts: effortsFromLabel(model.label || ''),
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      })),
      detail: described.detail,
    };
  }

  /**
   * 用一…
 */
  async function acpDescribeCli(command) {
    const { spawn } = await import('node:child_process');
    return acpDescribe({ spawn, command, env: process.env, cwd: baseDir });
  }

  /** 触发丢…
 */
  async function acpLoginCli(command, methodId) {
    const { spawn } = await import('node:child_process');
    return acpAuthenticate({ spawn, command, methodId, env: process.env, cwd: baseDir });
  }

  /**
   * 强制重新授权：logout（进程 A）→ 关掉 → authenticate（进程 B）→ session/new 验真。
   * 两个阶段必须是两个进程：agy 的登录态在系统级位置，同进程里 logout 后可能仍读到旧缓存。
   */
  async function acpForceReloginCli(command, methodId) {
    const { spawn } = await import('node:child_process');
    return acpForceRelogin({ spawn, command, methodId, env: process.env, cwd: baseDir });
  }

  /** ACP logout（agent 不支持就如实回报）…
 */
  async function acpLogoutCli(command) {
    const { spawn } = await import('node:child_process');
    return acpLogout({ spawn, command, env: process.env, cwd: baseDir });
  }

  /**
   * 把 ACP 报的模型清单写进目录。
   *
   * 关键动作是**合并**：agy 把每个思考档位当成独立模型列（`gemini-4-argon-low/medium/high`），
   * 原样落库就是 18 行同名菜单。这里按「家族 + variants」合并成 7 条，
   * 档位到真实 id 的映射存在 `variants` 里，发请求时再换回去（见 model-ipc 的 acpModelId）。
   */
  async function saveGeminiModels(models) {
    if (!Array.isArray(models) || models.length === 0) return 0;
    const grouped = groupModels(models.map(model => ({
      id: model.id,
      label: model.label || model.name || model.id,
      vision: true,
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    })));
    const saved = await subscriptionModels.saveProvider('gemini', {
      models: grouped,
    }).catch((error) => {
      log.warn('subscription gemini catalog save failed', { code: toErrorCode(error) });
      return null;
    });
    if (saved) {
      log.info('subscription gemini models saved', { raw: models.length, merged: grouped.length });
    }
    return saved ? grouped.length : 0;
  }

  /**
   * 给 model-ipc 的「这一轮用哪个号」：选一个可用账号 + 一份可用的 access token。
   *
   * 为什么放在服务层：选号要看额度余量与冷却时间（pool），取令牌要过写链里的刷新，
   * 这两件事都只有这里知道；model-ipc 只拿到一个不透明的结果。
   * 返回 null 表示「没有可用账号」，由调用方转成用户能看懂的错误。
   */
  async function acquireChatgptTurn() {
    const picked = await pool.pick('chatgpt').catch((error) => {
      log.warn('subscription no chatgpt account available', { code: toErrorCode(error) });
      return null;
    });
    const record = picked?.account;
    if (!record || typeof record !== 'object' || !record.accountId) return null;
    const accessToken = await accessTokenFor(record).catch((error) => {
      log.warn('subscription chatgpt token unavailable', { code: toErrorCode(error) });
      return '';
    });
    if (typeof accessToken !== 'string' || !accessToken) return null;
    // 记一次「用过」：下一次选号会把更久没用的号排在前面。
    void pool.noteUsed?.('chatgpt', record.accountId)?.catch?.(() => {});
    return {
      accountId: record.accountId,
      accessToken,
      chatgptAccountId: firstString(record.chatgptAccountId),
      email: firstString(record.email),
    };
  }

  /**
   * 把一轮的结果回写给账号池：
   * - `limited`：这个号这一窗口内别再选它（配额用完 / 429）；
   * - `expired`：令牌失效或账号没权限，标记后由用户重新登录；
   * - 其他情况不记，避免把一次网络抖动算到账号头上。
   */
  async function reportChatgptTurn(accountId, outcome = {}) {
    if (typeof accountId !== 'string' || !accountId) return { ok: false };
    if (outcome?.limited === true) {
      const resetsAt = Number(outcome.resetsAt);
      await pool.markLimited('chatgpt', accountId, Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : clock() + 5 * 60_000)
        .catch(error => log.warn('subscription markLimited failed', { code: toErrorCode(error) }));
      return { ok: true, state: 'limited' };
    }
    if (outcome?.expired === true) {
      await pool.markExpired('chatgpt', accountId, typeof outcome.reason === 'string' ? outcome.reason : 'auth_expired')
        .catch(error => log.warn('subscription markExpired failed', { code: toErrorCode(error) }));
      return { ok: true, state: 'expired' };
    }
    return { ok: true, state: 'ready' };
  }

  /**
   * Gemini 通道遇到 429 / 限流时调用（方案 §5.3「被动触发 + 主动校准」）。
   *
   * 两条信息源：上游错误文本（gRPC `RESOURCE_EXHAUSTED`、`retryDelay`、`Retry-After`）或
   * 调用方已经算好的 `resetsAt`。拿到恢复时间后做两件事：
   * 1. 账号进冷却（`pool.markLimited`，下一轮选号跳过它）；
   * 2. 额度快照里对应的窗口写上 `resetsAt`，界面的倒计时立刻变成真实值而不是「未知」。
   *
   * 解析与写入都是纯函数（`parseRateLimitSignal` / `applyRateLimitToUsage`），这里只做落盘与广播。
   * 注意：**不写 `usedPercent`**——429 只说「这个窗口没了」，说不到具体百分比，编造一个
   * 100% 会把「额度未知」变成「额度用尽」，那是更坏的信息。
   */
  async function noteGeminiRateLimit(input = {}) {
    const accountId = typeof input?.accountId === 'string' ? input.accountId : '';
    if (!accountId) return { ok: false, detail: 'accountId' };
    const at = clock();
    const signal = typeof input?.text === 'string' && input.text
      ? parseRateLimitSignal(input.text, at)
      : { limited: input?.resetsAt !== undefined, resetsAt: Number(input?.resetsAt) };
    if (!signal.limited) return { ok: false, detail: 'not_rate_limited' };
    const resetsAt = Number.isFinite(signal.resetsAt) && signal.resetsAt > at ? signal.resetsAt : at + 5 * 60_000;

    await pool.markLimited('gemini', accountId, resetsAt)
      .catch(error => log.warn('subscription gemini markLimited failed', { code: toErrorCode(error) }));

    const record = await store.read('gemini', accountId).catch(() => null);
    if (record) {
      const usage = applyRateLimitToUsage(record.usage, { resetsAt, at });
      await store.modify('gemini', accountId, current => (current ? { ...current, usage } : undefined))
        .catch(error => log.warn('subscription gemini limit not persisted', { code: toErrorCode(error) }));
      // 主动校准：下一次 `/usage` 会把真实百分比补回来（30s 冷却内不会白起进程）。
      void refreshUsage({ ...record, usage }).catch(() => {});
    }
    log.info('subscription gemini rate limited', { resetsAt, matched: signal.matched ?? null });
    emit({ kind: 'accounts', provider: 'gemini' });
    return { ok: true, state: 'limited', resetsAt };
  }

  const service = {
    list: listAll,
    login: startLogin,
    cancelLogin,
    logout,
    select,
    refresh,
    settings: async () => { await currentSettings(); return publicSettings(); },
    getSettings: async () => { await currentSettings(); return publicSettings(); },
    getCliStatus,
    /** 给外部（模型目录的「获取可用模型」）用的「问 CLI 要模型清单」。 */
    listAcpModels,
    updateSettings,
    models: async () => MODEL_CATALOG,
    channelTest,
    pickCliPath,
    accessTokenFor,
    acquireChatgptTurn,
    reportChatgptTurn,
    /** Gemini 通道 429 的被动校准入口（ACP 侧拿到限流错误后调用）。 */
    noteGeminiRateLimit,
    pool,
  };

  // 登记到进程内注册表：model-ipc 在构造请求时按它决定「能不能走 ACP」。
  setSubscriptionRuntime(service);
  // 预热 CLI 探测：第一次打开设置页 / 模型页就不用再等一次冷启动探测。
  void getCliStatus().catch(() => {});
  return { dispose, service };
}
