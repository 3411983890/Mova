/**
 * CLI 模型设置页的纯展示逻辑。
 *
 * 只做「数据 → 文案 / 样式量」的换算：状态徽章、圆点、额度条宽度与色调、
 * 重置倒计时、账号与窗口排序、下拉选项。不碰 React / DOM / Electron，
 * 因此 tests/cli-models-view.test.mjs 可以直接 import（.jsx 文件 Node 加载不了，
 * 所以这部分单独成文件而不是塞进组件里）。
 *
 * 被谁调用：cli-models-settings.jsx（组件）与 tests/cli-models-view.test.mjs（测试）。
 *
 * @see Mova-CLI模型-开发文档.md §8.4 §12.1
 * @see Mova设置页设计规范.md §6.14 §6.16
 */
import { CHATGPT_CHANNELS, LOGIN_STATES, effectiveState } from '../../../electron/subscription/contract.mjs';

/** 账号状态 → 徽章文案与色调（tone 对应 .cm-pill[data-tone]）。 */
export const STATE_BADGES = Object.freeze({
  ready: { text: '可用', tone: 'ok' },
  limited: { text: '额度用尽', tone: 'warn' },
  expired: { text: '需要重新登录', tone: 'error' },
  error: { text: '读取失败', tone: 'error' },
  unknown: { text: '未检测', tone: 'unknown' },
});

/** 额度读不到时的原因文案：必须说清「读不到」，不能被理解成「已连接」。 */
const REASON_TEXT = Object.freeze({
  unsupported: '上游还没有开放额度查询，读不到剩余量。',
  probeFailed: '读取额度失败，稍后会自动重试；这期间不会把账号当成可用。',
  noProject: '这个账号没有可用的工作区，读不到额度。',
});

const LOGIN_HEADLINE = Object.freeze({
  idle: '准备登录',
  waiting: '等待浏览器授权',
  verifying: '正在校验授权…',
  authorized: '已授权',
  failed: '授权失败',
  cancelled: '已取消登录',
});

const LOGIN_STATUS = Object.freeze({
  idle: '正在打开浏览器…',
  waiting: '正在等待授权…',
  verifying: '正在校验授权…',
  authorized: '授权成功，正在读取额度…',
  failed: '授权失败，请重试或换一个账号',
  cancelled: '已取消登录',
});

const WEEKDAYS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

const CHANNEL_LABELS = Object.freeze({
  'chatgpt-plan': '计划额度（chatgpt-plan）',
  codex: 'Codex 通道（codex）',
});

/** 额度刷新间隔选项（-1 = 仅发送前）。 */
export const REFRESH_OPTIONS = Object.freeze([
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: -1, label: '仅发送前' },
]);

/** 思考强度选项。 */
export const EFFORT_OPTIONS = Object.freeze([
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
]);

/** ChatGPT 上游通道选项：取值只能来自契约里的 CHATGPT_CHANNELS。 */
export const CHANNEL_OPTIONS = Object.freeze(
  CHATGPT_CHANNELS.map(value => ({ value, label: CHANNEL_LABELS[value] ?? value })),
);

/** Gemini 执行器选项。 */
export const RUNNER_OPTIONS = Object.freeze([
  { value: 'acp', label: '后台 CLI（ACP）' },
  { value: 'off', label: '关闭 Gemini' },
]);

const pad = value => String(value).padStart(2, '0');
const num = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 账号状态（把到期的 limited 视作 ready，未知值收敛成 unknown）。 */
export function accountState(account, now = Date.now()) {
  if (!account) return 'unknown';
  const state = effectiveState(account, now);
  return STATE_BADGES[state] ? state : 'unknown';
}

/**
 * 状态徽章。
 *
 * 顺序刻意如此：凭据过期/错误最严重，先报；其次是「读不到额度」——
 * 读不到时一律 unknown（虚线灰），绝不显示成「可用 / 已连接」（§8.4 硬性要求）。
 */
export function accountBadge(account, now = Date.now()) {
  if (!account) return STATE_BADGES.unknown;
  const state = accountState(account, now);
  if (state === 'expired') return STATE_BADGES.expired;
  if (state === 'error') return STATE_BADGES.error;
  const usage = account.usage;
  if (!usage) return STATE_BADGES.unknown;
  if (usage.reason) return { text: '额度未知', tone: 'unknown' };
  if (!Array.isArray(usage.windows) || usage.windows.length === 0) return { text: '额度未知', tone: 'unknown' };
  if (usage.stale) return { text: '额度未刷新', tone: 'muted' };
  if (state === 'limited') return STATE_BADGES.limited;
  return STATE_BADGES.ready;
}

/** 账号行左侧圆点：ready 蓝 / limited 黄 / expired 红 / 未检测虚线灰。 */
export function accountDot(account, now = Date.now()) {
  const badge = accountBadge(account, now);
  if (badge.tone === 'ok') return 'is-on';
  if (badge.tone === 'warn') return 'is-warn';
  if (badge.tone === 'error') return 'is-danger';
  if (badge.tone === 'muted') return 'is-warn';
  return 'is-unknown';
}

/** 额度百分比：取整并夹在 0–100。入参是**已用量**。 */
export function quotaPercent(usedPercent) {
  const parsed = num(usedPercent);
  if (parsed === null) return 0;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * 剩余额度百分比（条子按「剩余」画：蓝条满格 = 一点没用）。
 * 读不到已用量时返回 null，调用方据此画空条而不是满条——把「不知道」画成「全都有」是最坏的误导。
 *
 * 注意 `Number(null) === 0`：必须先把 null/undefined/空串/布尔挑出来，
 * 否则「缺字段」会被当成「已用 0%」，于是画出满格。
 */
export function quotaRemaining(usedPercent) {
  if (usedPercent === null || usedPercent === undefined || usedPercent === ''
    || typeof usedPercent === 'boolean') return null;
  const parsed = num(usedPercent);
  if (parsed === null) return null;
  return 100 - Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * 额度条宽度 = 剩余比例（最少 2%，保证还有一点点时也看得见）。
 * 读不到额度时给 0：宁可空条，也不要假装额度充足。
 */
export function quotaWidth(usedPercent) {
  const remaining = quotaRemaining(usedPercent);
  if (remaining === null) return 0;
  return Math.max(2, remaining);
}

/**
 * 额度条色调按**剩余**判：剩余 ≤10% 红、≤30% 黄；账号被标记 limited 时整组转红。
 * 条子画的是剩余量，色调必须跟同一个量走，否则「条子快空了却是绿的」。
 */
export function quotaTone(usedPercent, options = {}) {
  if (options.limited) return 'danger';
  const remaining = quotaRemaining(usedPercent);
  if (remaining === null) return 'ok';
  if (remaining <= 10) return 'danger';
  if (remaining <= 30) return 'warn';
  return 'ok';
}

/** 额度行的数值文案：与进度条同口径，说的是**剩余**。 */
export function quotaValueText(usedPercent) {
  const remaining = quotaRemaining(usedPercent);
  return remaining === null ? '额度未知' : `剩余 ${remaining}%`;
}

/**
 * 重置倒计时：24 小时内「X 小时 Y 分后重置」，超过 24 小时按本地时区给「周日 09:00 重置」。
 * @param {number} resetsAt 毫秒时间戳
 * @param {number} now
 */
export function formatResetIn(resetsAt, now = Date.now()) {
  const at = num(resetsAt);
  if (at === null || at <= 0) return '重置时间未知';
  const delta = at - now;
  if (delta <= 60_000) return '即将重置';
  if (delta > 24 * 3600_000) {
    const date = new Date(at);
    return `${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())} 重置`;
  }
  const totalMinutes = Math.round(delta / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} 分后重置`;
  if (minutes === 0) return `${hours} 小时后重置`;
  return `${hours} 小时 ${minutes} 分后重置`;
}

/** 额度恢复时间（limited 账号）：把「重置」换成「恢复」。 */
export function formatRecoverIn(account, now = Date.now()) {
  const until = num(account?.limitedUntil);
  if (until === null || until <= 0) return '等待额度恢复';
  return formatResetIn(until, now).replace('后重置', '后恢复').replace(' 重置', ' 恢复');
}

/** 上次调用时间；没有记录时明说没有调用过，不占位成时间。 */
export function formatLastUsed(lastUsedAt) {
  const at = num(lastUsedAt);
  if (at === null || at <= 0) return '还没有调用';
  const date = new Date(at);
  return `上次调用 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 额度读不到的原因文案。 */
/**
 * 读不到额度时的那一句话。
 *
 * `detail` 是主进程探针给的细分原因（http_401 / network / no_token…）。同样是
 * `probeFailed`，401 和「连不上」对用户意味着完全不同的事，所以先按 detail 给最具体的一句。
 */
export function usageReasonText(reason, detail = '') {
  const code = String(detail ?? '');
  if (code === 'http_401' || code === 'http_403') {
    return '上游拒绝了额度查询（账号本身可用，只是读不到剩余量）。';
  }
  if (code === 'network') return '连不上 chatgpt.com，读不到剩余量（检查网络或代理）。';
  if (code === 'timeout') return '额度查询超时，稍后会自动重试。';
  if (code === 'no_token') return '本地令牌不可用，读不到剩余量（重新登录可以修好）。';
  if (code === 'cli_managed') return '这个账号由本机 CLI 托管，Mova 读不到它的剩余额度。';
  // Gemini 订阅额度的探针错误码（主进程 contract.mjs 的 ERROR_TEXT 同源；这里只做展示层措辞）。
  if (code === 'usage_cli_missing') return '没有找到 antigravity CLI，读不到订阅额度。';
  if (code === 'usage_probe_timeout') return '读取额度超时，已保留上次的快照，稍后会自动重试。';
  if (code === 'usage_probe_spawn_failed') return '没能启动额度探针进程，稍后会自动重试。';
  if (code === 'usage_probe_unavailable') return '当前系统没有可用的伪终端，读不到订阅额度。';
  if (code === 'usage_parse_failed') return '读到了 /usage 输出，但没解析出额度，稍后会自动重试。';
  if (code === 'usage_blocked') return '额度面板要求先同意条款，Mova 不会替你确认，已放弃本轮读取。';
  return REASON_TEXT[reason] ?? '暂时读不到额度，稍后会自动重试。';
}

/** 账号池里最紧的那个窗口的已用百分比（用于「剩余额度最多」排序）。 */
function pressure(account) {
  const windows = account?.usage?.windows;
  if (!Array.isArray(windows) || windows.length === 0) return 100;
  return windows.reduce((max, item) => Math.max(max, quotaPercent(item?.usedPercent)), 0);
}

const STATE_ORDER = Object.freeze({ ready: 0, limited: 1, expired: 2, error: 3, unknown: 4 });

/**
 * 账号排序：当前优先账号置顶，其余按状态（可用 → 用尽 → 过期）再按压力升序。
 * 返回新数组，不改入参（数据来自 IPC，渲染期不能就地改）。
 */
export function sortAccounts(accounts = [], now = Date.now()) {
  return [...accounts].sort((left, right) => {
    const leftActive = left?.active === true;
    const rightActive = right?.active === true;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    const stateDelta = (STATE_ORDER[accountState(left, now)] ?? 9) - (STATE_ORDER[accountState(right, now)] ?? 9);
    if (stateDelta !== 0) return stateDelta;
    const pressureDelta = pressure(left) - pressure(right);
    if (pressureDelta !== 0) return pressureDelta;
    return String(left?.email ?? left?.id ?? '').localeCompare(String(right?.email ?? right?.id ?? ''));
  });
}

/** 窗口排序：5 小时/会话窗口 → 每周窗口 → 其它 → 共享池垫底（§8.4）。 */
export function sortUsageWindows(windows = []) {
  const rank = window => {
    const id = String(window?.id ?? '');
    // 第三方共享额度必须先判：它的 id 里也带 `5h`（`3p-5h`），
    // 放在 session 分支后面会被误判成「5 小时窗口」而排到最前面。
    if (/shared|3p/i.test(id)) return 3;
    if (/session|5h|5-hour/i.test(id)) return 0;
    if (/week/i.test(id)) return 1;
    return 2;
  };
  return [...windows].sort((left, right) => rank(left) - rank(right));
}

/** 登录面板标题。 */
export function loginHeadline(state, provider = 'chatgpt') {
  // Gemini 不开浏览器：它的登录态就是本机 CLI 自己的那份，Mova 只读不写。
  // 说「等待浏览器授权」会让人干等一个永远不会出现的窗口。
  if (provider === 'gemini') {
    if (state === 'waiting') return '正在读取本机 CLI';
    if (state === 'verifying') return '正在读取模型清单…';
  }
  return LOGIN_STATES.includes(state) ? LOGIN_HEADLINE[state] : LOGIN_HEADLINE.idle;
}

export function loginStatusText(state, provider = 'chatgpt') {
  if (provider === 'gemini') {
    if (state === 'waiting') return '不需要操作：只要能列出模型就说明已经授权';
    if (state === 'verifying') return '正在问本机 agy 支持哪些模型，稍等几秒';
  }
  return LOGIN_STATES.includes(state) ? LOGIN_STATUS[state] : LOGIN_STATUS.idle;
}

/** 刷新间隔文案。 */
export function refreshIntervalLabel(minutes) {
  const option = REFRESH_OPTIONS.find(item => item.value === Number(minutes));
  return option ? option.label : '5 分钟';
}

/** provider 显示名。 */
export function providerLabel(provider) {
  return provider === 'gemini' ? 'Gemini' : 'ChatGPT';
}

/** 优先账号下拉的当前文案。 */
export function preferredAccountLabel(accounts = [], preferredAccountId) {
  const account = accounts.find(item => item.id === preferredAccountId);
  return account?.email || account?.id || '按剩余额度自动';
}
