'use strict';

/**
 * Mova 桌面操作 · 终止守护（guard）
 *
 * 两件事（见 `Mova桌面操作开发方案.md` §12.5 / §12.6）：
 * 1. **长按 Ctrl+Shift ≥ 600ms 终止**：50ms 轮询 `GetAsyncKeyState`（纯修饰键组合无法用
 *    globalShortcut 注册，钩子又容易被安全软件拦，轮询是主方案）；
 * 2. **真人接管检测**：`GetLastInputInfo` 的时间戳变化，且**不在我们自己注入的时间窗 ±80ms 内**。
 *
 * 只在 start() 与 stop() 之间轮询；触发一次后自动 stop()，避免重复回调。
 *
 * ```js
 * const guard = createGuard({ onAbort: (reason) => session.abort(reason), onUserInput: () => {} });
 * guard.start();
 * // 注入前后由 input.cjs 通过 onInjection 自动打点；外部也可手动 guard.markInjection()。
 * guard.userActiveRecently(600); // → boolean
 * guard.stop();
 * ```
 */

const input = require('./input.cjs');

/** 纯修饰键组合：轮询 GetAsyncKeyState 判断，不使用热键注册。 */
const VK_CONTROL = 0x11;
const VK_SHIFT = 0x10;

/** 长按阈值：低于 600ms 容易在正常 Ctrl+Shift+X 快捷键里误触，高于 1s 用户觉得不灵。 */
const DEFAULT_HOLD_MS = 600;

/** 我们自己的注入会更新 GetLastInputInfo，所以这个窗口内的 tick 不算“真人输入”。 */
const DEFAULT_INJECTION_WINDOW_MS = 80;

/** 注入标记最多保留的条数（够覆盖 32 次动作，足以应付并发的一次点击 + 一次移动）。 */
const MAX_MARKS = 64;

/** onUserInput 的最小间隔，避免连续打字时每 50ms 回调一次。 */
const USER_INPUT_THROTTLE_MS = 200;

/**
 * @param {object} options
 * @param {(reason: 'hotkey') => void} [options.onAbort]
 * @param {(info: {tick:number, ageMs:number}) => void} [options.onUserInput]
 * @param {number} [options.pollMs=50]
 * @param {number} [options.holdMs=600]
 * @param {number} [options.injectionWindowMs=80]
 * @param {{warn?: Function, error?: Function}} [options.logger]
 */
function createGuard(options = {}) {
  const {
    onAbort,
    onUserInput,
    pollMs = 50,
    holdMs = DEFAULT_HOLD_MS,
    injectionWindowMs = DEFAULT_INJECTION_WINDOW_MS,
    logger = null,
  } = options || {};

  /** @type {{tick:number, at:number, count:number}[]} 最近若干次注入的时间窗 */
  let marks = [];
  let timer = null;
  let running = false;
  let heldSince = 0;
  let lastSeenTick = 0;
  let lastUserNotifyAt = 0;
  let unsubscribeInjection = null;
  let warnedUnavailable = false;

  function warnOnce(error) {
    if (warnedUnavailable) return;
    warnedUnavailable = true;
    const message = `[guard] 输入轮询不可用：${error && error.message ? error.message : error}`;
    if (logger && typeof logger.warn === 'function') logger.warn(message);
    else console.warn(message);
  }

  /** 32 位 tick 的有符号差（回绕安全）。 */
  function tickDiff(a, b) {
    return ((((a - b) % 0x100000000) + 0x180000000) % 0x100000000) - 0x80000000;
  }

  function isInjectionTick(tick) {
    for (const mark of marks) {
      if (Math.abs(tickDiff(tick, mark.tick)) <= injectionWindowMs) return true;
    }
    return false;
  }

  /**
   * 标记一次“这是我们自己注入的输入”。input.cjs 在每次 SendInput 后自动调用；
   * 外部也可手动调用（例如别的通道注入时）。
   * @param {{tick?:number, at?:number, count?:number}} [mark]
   */
  function markInjection(mark) {
    let tick = mark && Number.isFinite(mark.tick) ? mark.tick : Number.NaN;
    if (!Number.isFinite(tick)) {
      try {
        tick = input.nowTick();
      } catch {
        return;
      }
    }
    marks.push({ tick: tick >>> 0, at: Date.now(), count: mark && mark.count ? mark.count : 0 });
    if (marks.length > MAX_MARKS) marks = marks.slice(marks.length - MAX_MARKS);
  }

  /**
   * 最近 `ms` 毫秒内是否有**真人**输入（排除我们自己的注入窗口）。
   * @param {number} [ms=600]
   */
  function userActiveRecently(ms = 600) {
    const windowMs = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : 600;
    let info;
    try {
      info = input.lastInputInfo();
    } catch {
      return false;
    }
    if (!info) return false;
    if (!(info.ageMs <= windowMs)) return false;
    return !isInjectionTick(info.tick);
  }

  function fire(reason) {
    if (!running) return;
    // 先停，再回调：回调里抛异常也不会二次触发。
    stop();
    try {
      if (typeof onAbort === 'function') onAbort(reason);
    } catch (error) {
      if (logger && typeof logger.error === 'function') logger.error('[guard] onAbort 抛错', error);
      else console.error('[guard] onAbort 抛错', error);
    }
  }

  function poll() {
    if (!running) return;
    let ctrl;
    let shift;
    try {
      ctrl = (input.getAsyncKeyState(VK_CONTROL) & input.KEY_DOWN_MASK) !== 0;
      shift = (input.getAsyncKeyState(VK_SHIFT) & input.KEY_DOWN_MASK) !== 0;
    } catch (error) {
      warnOnce(error);
      stop();
      return;
    }

    const now = Date.now();
    if (ctrl && shift) {
      if (!heldSince) heldSince = now;
      if (now - heldSince >= holdMs) {
        fire('hotkey');
        return;
      }
    } else {
      heldSince = 0;
    }

    // 真人接管检测：tick 变了才算“有新输入”，且必须落在注入窗口之外。
    let info;
    try {
      info = input.lastInputInfo();
    } catch (error) {
      warnOnce(error);
      stop();
      return;
    }
    if (!info) return;
    if (info.tick === lastSeenTick) return;
    lastSeenTick = info.tick;
    if (isInjectionTick(info.tick)) return;
    if (now - lastUserNotifyAt < USER_INPUT_THROTTLE_MS) return;
    lastUserNotifyAt = now;
    try {
      if (typeof onUserInput === 'function') onUserInput({ tick: info.tick, ageMs: info.ageMs });
    } catch (error) {
      if (logger && typeof logger.error === 'function') logger.error('[guard] onUserInput 抛错', error);
      else console.error('[guard] onUserInput 抛错', error);
    }
  }

  function start() {
    if (running) return true;
    try {
      // 先确认绑定可用，避免每 50ms 抛一次。
      input.lastInputInfo();
      input.getAsyncKeyState(VK_CONTROL);
    } catch (error) {
      warnOnce(error);
      return false;
    }
    running = true;
    heldSince = 0;
    lastUserNotifyAt = 0;
    try {
      lastSeenTick = input.lastInputTick();
    } catch {
      lastSeenTick = 0;
    }
    // input.cjs 每次注入后自动打点，这里订阅即可；外部手动打点仍然可用。
    if (typeof input.onInjection === 'function') {
      try {
        unsubscribeInjection = input.onInjection(markInjection);
      } catch {
        unsubscribeInjection = null;
      }
    }
    const interval = Number.isFinite(Number(pollMs)) ? Math.max(20, Math.floor(Number(pollMs))) : 50;
    timer = setInterval(poll, interval);
    return true;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
    heldSince = 0;
    if (typeof unsubscribeInjection === 'function') {
      try {
        unsubscribeInjection();
      } catch {
        /* 取消订阅失败不影响停止 */
      }
    }
    unsubscribeInjection = null;
  }

  return {
    start,
    stop,
    userActiveRecently,
    markInjection,
    isRunning: () => running,
    /** 当前长按已持续多少毫秒（主窗口状态条画进度环用；未按下为 0）。 */
    heldFor: () => (heldSince ? Date.now() - heldSince : 0),
  };
}

module.exports = { createGuard, VK_CONTROL, VK_SHIFT };
