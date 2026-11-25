/**
 * CLI 模型（订阅额度）共享契约。
 *
 * 这个文件是**唯一**的取值来源：主进程、预加载脚本、渲染层都从这里 import，
 * 不允许任何模块自己写字符串字面量（通道名、错误码、状态值）。
 * 纯数据 + 纯函数，无任何依赖，因此浏览器和 Node 都能安全加载。
 *
 * @see Mova-CLI模型-开发文档.md §5 §9.4 §18.2
 */

/** IPC 通道（invoke 用 REQUEST，事件推送用 EVENT）。 */
export const CHANNELS = Object.freeze({
  list: 'subscription:list',
  login: 'subscription:login',
  /** 手动完成登录：浏览器连不上 127.0.0.1（代理/VPN/防火墙）时的兜底，粘贴回调链接即可。 */
  completeLogin: 'subscription:login:complete',
  cancelLogin: 'subscription:cancel',
  logout: 'subscription:logout',
  select: 'subscription:select',
  refresh: 'subscription:refresh',
  settingsGet: 'subscription:settings',
  settingsSet: 'subscription:settings:set',
  models: 'subscription:models',
  channelTest: 'subscription:channel:test',
  pickCliPath: 'subscription:cli-path:pick',
  /** CLI 探测结果：未安装/版本过旧时前端弹「安装指引」，所以必须能单独查。 */
  cliStatus: 'subscription:cli-status',
  event: 'subscription:event',
});

/**
 * `subscription:event` 的载荷形状。
 * 只有 `kind:'login'` 用来推进登录面板状态，其余一律当作「数据变了，重新拉一次 list」。
 */
export const EVENT_KINDS = Object.freeze(['login', 'accounts', 'usage', 'selection']);

/**
 * 设置项里属于「会话模型」的四项：后端可以暂时忽略，但渲染层会写进来，
 * 保存时必须原样回写，否则用户改完模型切页再回来会被重置。
 */
export const MODEL_SETTING_KEYS = Object.freeze(['chatgptModel', 'geminiModel', 'thinkingEffort', 'imageInput']);

/** provider 取值。池子按 provider 隔离，不做跨 provider 兜底。 */
export const PROVIDERS = Object.freeze(['chatgpt', 'gemini']);

/** 账号状态。`ready` 才参与调度；`limited` 到期自动回 ready。 */
export const ACCOUNT_STATES = Object.freeze(['ready', 'limited', 'expired', 'error']);

/** ChatGPT 的两条上游通道。 */
export const CHATGPT_CHANNELS = Object.freeze(['chatgpt-plan', 'codex']);

/** 登录状态机取值（与 §7.1 一致）。 */
export const LOGIN_STATES = Object.freeze(['idle', 'waiting', 'verifying', 'authorized', 'failed', 'cancelled']);

/** 额度读取失败原因（决定 UI 显示 unknown 还是 stale）。 */
export const USAGE_REASONS = Object.freeze(['unsupported', 'probeFailed', 'noProject']);

/**
 * 错误码 → 中文文案。§9.4 的失败分类与 §18.3 的错误码合并在这里，
 * 便于主进程抛错、渲染层直接取文案，不用各自维护一份映射。
 */
export const ERROR_TEXT = Object.freeze({
  not_configured: '还没有登录任何账号',
  auth_expired: '登录已过期，请重新登录',
  auth_cancelled: '已取消登录',
  auth_timeout: '登录等待超时，请重新发起',
  auth_denied: '授权被拒绝',
  duplicate_account: '这个账号已经连接，请在浏览器中选择另一个账号',
  quota_exhausted: '该账号额度已用完',
  no_account_available: '没有可用账号：额度都已用完或未登录',
  rate_limited: '请求过于频繁，请稍后再试',
  model_access: '该账号没有这个模型的权限',
  network: '连接失败，请检查网络或代理',
  proxy: '代理不可用，请检查系统代理设置',
  credential: '凭据存储不可用',
  cli_missing: '没有找到 antigravity CLI，请先安装',
  cli_incompatible: 'CLI 版本与当前 Mova 不兼容',
  // CLI 装好了但 CLI 自己还没登录：`agy models` 返回空清单，这是最常见的一种「授权没完成」。
  // 单独给一个 code，用户才知道要去终端跑一次 agy，而不是在 Mova 里反复点重试。
  cli_not_logged_in: 'CLI 已安装，但还没有在这台机器上登录 Google 账号：请先在终端运行一次 agy 完成登录',
  // ---- 额度探针（ConPTY `/usage`）的错误码 ------------------------------------
  // 探测失败必须能被分类：向导/条款、工作区信任、超时、CLI 缺失、解析失败各自对应不同的
  // 用户动作（去终端跑一次 / 换个网络 / 重装 CLI / 等一会儿再试），收敛成一句「读取失败」
  // 就只能让用户瞎试。前两个是**安全红线**相关：命中即放弃本轮，绝不替用户确认。
  cli_onboarding_required: '请先在终端运行一次 agy 完成首次向导（配色 / 条款），再回来刷新额度',
  cli_trust_required: 'CLI 需要终端工作区确认，请先在终端完成一次授权，再回来刷新额度',
  usage_cli_missing: '没有找到 antigravity CLI，读不到订阅额度',
  usage_probe_timeout: '读取额度超时，已保留上次的快照，稍后会自动重试',
  usage_probe_spawn_failed: '没能启动额度探针进程，稍后会自动重试',
  usage_probe_unavailable: '当前系统没有可用的伪终端，读不到订阅额度',
  usage_parse_failed: '读到了 /usage 输出，但没解析出额度，稍后会自动重试',
  acp_protocol: 'Gemini 会话协议异常',
  request: '请求参数不合法',
});

/** 错误码集合，供 isValidCode 使用。 */
export const ERROR_CODES = Object.freeze(Object.keys(ERROR_TEXT));

/** 单次错误对象：主进程抛、IPC 透传、渲染层按 code 取文案。 */
export class SubscriptionError extends Error {
  /**
   * @param {keyof typeof ERROR_TEXT} code
   * @param {{ detail?: string, cause?: unknown, retryable?: boolean }} [extra]
   */
  constructor(code, extra = {}) {
    const text = ERROR_TEXT[code] ?? ERROR_TEXT.request;
    super(text);
    this.name = 'SubscriptionError';
    this.code = code in ERROR_TEXT ? code : 'request';
    this.detail = typeof extra.detail === 'string' ? extra.detail.slice(0, 400) : undefined;
    this.retryable = extra.retryable === true;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }

  /** 给渲染层的安全形状：不含令牌、不含上游响应体。 */
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

/** 把任意异常收敛成可展示的 code，绝不把上游原文透传出去。 */
export function toErrorCode(error) {
  if (error && typeof error.code === 'string' && error.code in ERROR_TEXT) return error.code;
  return 'request';
}

/**
 * 额度使用的本地判定：到点即恢复，留 30s 容错时钟偏移。
 * @param {{ state?: string, limitedUntil?: number }} account
 * @param {number} now
 */
export function isAvailable(account, now) {
  if (!account) return false;
  if (account.state === 'expired' || account.state === 'error') return false;
  if (account.limitedUntil && account.limitedUntil > now + 30_000) return false;
  return true;
}

/** 账号在 UI 上的有效状态（把到期的 limited 显示成 ready）。 */
export function effectiveState(account, now) {
  if (!account) return 'error';
  if (account.state === 'limited' && !(account.limitedUntil > now + 30_000)) return 'ready';
  return ACCOUNT_STATES.includes(account.state) ? account.state : 'error';
}

/** 一次选择决策的记录形状（§9.3）。 */
export function selectionEvent(input) {
  return Object.freeze({
    at: Date.now(),
    provider: input.provider,
    picked: input.picked ?? null,
    reason: input.reason,
    skipped: Array.isArray(input.skipped) ? input.skipped : [],
  });
}
