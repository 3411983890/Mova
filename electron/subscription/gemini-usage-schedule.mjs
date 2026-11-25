/**
 * 负责：Gemini `/usage` 探针的调用节奏——单飞互斥、同账号最小冷却、连续失败指数退避。
 * 不负责：探针本身（gemini-usage-cli.mjs）、429 回写（gemini-usage-limit.mjs）、
 *       落盘与事件（ipc.mjs）。
 * 被谁调用：electron/subscription/ipc.mjs 的 `refreshUsage`；tests/gemini-usage-probe.test.mjs。
 *
 * 为什么需要它（方案 §5.2）：一次 `/usage` 探针要拉一个 ConPTY + 一个 `agy` 进程（3~5s，
 * 里面有 C# 编译与 TUI 渲染）。设置页的定时刷新、用户连点「刷新额度」、登录后的自动刷新
 * 可能同时到达，不节流就会同时起好几个 agy，把 CLI 自己的登录态锁住。
 *
 * 三个刻意的取舍：
 * - **单飞**：同 key 正在跑时直接返回同一个 Promise，绝不并发起第二个进程。
 * - **成功冷却 30s**：一次探针 3~5s，30s 内重复探测拿到的面板几乎不会变，纯浪费进程。
 *   （自动定时刷新默认 5 分钟一次，远大于冷却窗。）
 * - **失败退避 60s 起、指数到 15 分钟封顶**：CLI 没装 / 需要交互确认这类失败重试再多次
 *   也不会自愈，退避防止用户每点一次就起一个必然失败的进程。
 */

/** 同账号最小探测间隔。 */
export const MIN_INTERVAL_MS = 30_000;
/** 第一次失败后等多久再试。 */
export const BACKOFF_BASE_MS = 60_000;
/** 退避上限：再久就等于「这个账号这一轮不探了」，但下一次手动刷新仍会重试。 */
export const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * @param {{ now?: () => number, minIntervalMs?: number,
 *   backoffBaseMs?: number, backoffMaxMs?: number }} [options]
 */
export function createUsageProbeScheduler(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : MIN_INTERVAL_MS;
  const backoffBaseMs = Number.isFinite(options.backoffBaseMs) ? options.backoffBaseMs : BACKOFF_BASE_MS;
  const backoffMaxMs = Number.isFinite(options.backoffMaxMs) ? options.backoffMaxMs : BACKOFF_MAX_MS;

  /** key → { lastAt, retryAt, failures, result, pending } */
  const states = new Map();

  function stateOf(key) {
    let entry = states.get(key);
    if (!entry) {
      entry = { lastAt: 0, retryAt: 0, failures: 0, result: null, pending: null };
      states.set(key, entry);
    }
    return entry;
  }

  /**
   * 跑一次探针（或复用上一次的结果）。
   *
   * @param {string} key 账号标识（同一账号同一时刻只允许一个探针）
   * @param {() => Promise<any>} task 真正执行探测的函数
   * @returns {Promise<{ result: any, skipped: 'inflight'|'throttled'|'backoff'|null }>}
   */
  async function run(key, task) {
    const id = String(key ?? '');
    const entry = stateOf(id);
    // 单飞：并发调用共享同一个 Promise（`skipped` 由先到的调用决定，这里统一报 inflight）。
    if (entry.pending) return { result: await entry.pending, skipped: 'inflight' };

    const at = now();
    if (entry.retryAt > at) return { result: entry.result, skipped: 'backoff' };
    if (entry.lastAt > 0 && at - entry.lastAt < minIntervalMs) return { result: entry.result, skipped: 'throttled' };

    const pending = (async () => {
      let result = null;
      try {
        result = await task();
      } catch {
        // 探针约定不抛错；真抛了也按失败处理，绝不把异常丢给 IPC。
        result = null;
      }
      entry.result = result;
      entry.lastAt = now();
      if (result && result.reason === 'probeFailed') {
        entry.failures += 1;
        const delay = Math.min(backoffMaxMs, backoffBaseMs * Math.pow(2, entry.failures - 1));
        entry.retryAt = entry.lastAt + delay;
      } else {
        entry.failures = 0;
        entry.retryAt = 0;
      }
      return result;
    })();

    entry.pending = pending;
    try {
      const result = await pending;
      return { result, skipped: null };
    } finally {
      entry.pending = null;
    }
  }

  /** 冷启动 / 登出后清掉某个账号的节奏记录（下一次立刻可探）。 */
  function reset(key) {
    states.delete(String(key ?? ''));
  }

  /** 测试与排查用：某个账号当前处于哪种状态（不含令牌，纯数字）。 */
  function stats(key) {
    const entry = states.get(String(key ?? ''));
    if (!entry) return { lastAt: 0, retryAt: 0, failures: 0, inflight: false, hasResult: false };
    return {
      lastAt: entry.lastAt,
      retryAt: entry.retryAt,
      failures: entry.failures,
      inflight: entry.pending !== null,
      hasResult: entry.result !== null,
    };
  }

  return { run, reset, stats };
}
