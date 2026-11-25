/**
 * 负责：把 ACP 对话里的 429 / 限流错误**降级**成额度信息——从错误文本里取恢复时间（纯函数），
 *      再把它回写进已有的额度快照（同样是纯函数，返回新对象）。
 * 不负责：进程调度（gemini-usage-schedule.mjs）、探针（gemini-usage-cli.mjs）、
 *       落盘与 `pool.markLimited`（ipc.mjs 的 `noteGeminiRateLimit`）。
 * 被谁调用：electron/subscription/ipc.mjs 的 `noteGeminiRateLimit`；
 *      tests/gemini-usage-429.test.mjs。
 *
 * 为什么单独成模块：429 是「被动校准」唯一的信息源，但它的文本来自上游（gRPC 状态串、
 * Google 的 `retryDelay`、REST 的 `Retry-After`），形状不稳定。把它写成纯函数，
 * 就能用真实错误样例钉死行为，而不必真的触发一次限流。
 *
 * 只做两件事，绝不编造额度：不写 `usedPercent`（429 只说「这个窗口没了」，
 * 说不到具体百分比），只写 `resetsAt` 与快照级 `limitedUntil`。
 */
import { durationToMs } from './gemini-usage-cli.mjs';

/** 认得出「被限流」的特征词：gRPC 状态名、HTTP 码、英文与中文的限流说法。 */
const LIMITED_PATTERNS = Object.freeze([
  /resource[_ ]exhausted/i,
  /\b429\b/,
  /quota (?:has been )?exceeded/i,
  // 语序反过来写法上游也用：「you have exceeded your quota」。
  /exceeded (?:your |the )?(?:quota|limit)/i,
  /rate[ _]?limit(?:ed|_exceeded)?/i,
  /too many requests/i,
  /(?:额度|配额)(?:已)?(?:用尽|超限|不足)/,
]);

/** 「多久之后恢复」的各种写法，按可信度排列。 */
const RETRY_AFTER_LEAD = /(?:retry\s*(?:-|_)?\s*after|retrydelay|reset\s*(?:-|_)?\s*after|resets?\s*(?:-|_)?\s*after|try\s+again\s+in|resets?\s+in|reset\s+in)\s*[:=]?\s*["']?/i;
/** `resets at 2026-01-01T00:00:00Z` / `reset at 1794605550000`。 */
const RESET_AT_LEAD = /(?:resets?|available|retry)\s*(?:-|_)?\s*(?:at|on)\s*[:=]?\s*["']?/i;

/**
 * 从限流错误文本里取恢复时间。
 *
 * @param {string} text 上游错误文本（IPC 日志、ACP `session/prompt` 的 error message…均可）
 * @param {number} [now] 当前时间；用于把「秒级 Retry-After」换算成绝对时间戳
 * @returns {{ limited: boolean, resetsAt?: number, matched?: string }}
 *   `limited:false` 表示这段文本根本不是限流错误；`limited:true` 但无 `resetsAt`
 *   表示确认被限流、但文本没给恢复时间（调用方应退回默认冷却）。
 */
export function parseRateLimitSignal(text, now = Date.now()) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  if (raw.trim().length === 0) return { limited: false };
  const matched = LIMITED_PATTERNS.find(pattern => pattern.test(raw));
  if (!matched) return { limited: false };
  const at = Number.isFinite(now) ? now : Date.now();

  // 1) 「retry-after: 30」「retryDelay: "47s"」「reset after 3600s」「try again in 5m」
  const lead = RETRY_AFTER_LEAD.exec(raw);
  if (lead) {
    const tail = raw.slice(lead.index + lead[0].length);
    const delta = durationToMs(tail);
    if (delta !== undefined) return { limited: true, resetsAt: at + delta, matched: 'duration' };
    // 纯数字：`retry-after: 30` 按秒（HTTP 语义），长的按毫秒（上游偶尔直接给 epoch ms）
    const bare = /^\s*(\d{1,16})/.exec(tail);
    if (bare) {
      const value = Number(bare[1]);
      if (Number.isFinite(value) && value > 0) {
        const resetsAt = value >= 1e12 ? value : value >= 1e9 ? value * 1000 : at + value * 1000;
        return { limited: true, resetsAt, matched: 'seconds' };
      }
    }
  }
  // 2) 绝对时间：ISO 串或 epoch
  const absolute = RESET_AT_LEAD.exec(raw);
  if (absolute) {
    const tail = raw.slice(absolute.index + absolute[0].length);
    const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(tail);
    if (iso) {
      const parsed = Date.parse(iso[0].replace(' ', 'T'));
      if (Number.isFinite(parsed)) return { limited: true, resetsAt: parsed, matched: 'iso' };
    }
    const epoch = /^\s*(\d{10,16})/.exec(tail);
    if (epoch) {
      const value = Number(epoch[1]);
      const resetsAt = value >= 1e12 ? value : value * 1000;
      if (Number.isFinite(resetsAt)) return { limited: true, resetsAt, matched: 'epoch' };
    }
  }
  return { limited: true };
}

/** 回写目标：优先 5 小时/会话窗口（限流最先打满的就是它），否则取已用最高的那个。 */
function pickTargetWindow(windows) {
  const short = windows.find(window => /5h|session|five|hour/i.test(String(window?.id ?? '')));
  if (short) return short;
  let best = null;
  for (const window of windows) {
    const used = Number(window?.usedPercent);
    if (!Number.isFinite(used)) continue;
    if (!best || used > Number(best.usedPercent ?? -1)) best = window;
  }
  return best ?? windows[0] ?? null;
}

/**
 * 把限流恢复时间回写进额度快照（纯函数，不改入参）。
 *
 * @param {{ checkedAt?: number, windows?: Array<object>, reason?: string }} usage 现有快照
 * @param {{ resetsAt?: number, at?: number }} patch
 * @returns {object} 新快照；`resetsAt` 非法或已过去时原样返回入参（不造假数据）
 */
export function applyRateLimitToUsage(usage, patch = {}) {
  const at = Number.isFinite(patch.at) ? patch.at : Date.now();
  const until = Number(patch.resetsAt);
  const base = usage && typeof usage === 'object' ? usage : { checkedAt: at, windows: [] };
  if (!Number.isFinite(until) || until <= at) return base;

  const windows = Array.isArray(base.windows) ? base.windows.map(window => ({ ...window })) : [];
  const target = windows.length > 0 ? pickTargetWindow(windows) : null;
  if (target) target.resetsAt = until;
  return {
    ...base,
    checkedAt: Number.isFinite(base.checkedAt) ? base.checkedAt : at,
    windows,
    limitedUntil: until,
  };
}
