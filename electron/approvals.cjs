'use strict';
const { randomUUID } = require('node:crypto');

const DECISIONS = Object.freeze(['deny', 'once', 'session']);

/**
 * 超时 / 被取消的稳定 code：只作为「关闭原因」随事件上报，不改变 `ask()` 的返回值。
 * `ask()` 仍然只回 'deny'，既有调用点（gate / mcp-manager / edge bridge）一个都不用改。
 */
const APPROVAL_TIMEOUT_CODE = 'approval_timeout';
const APPROVAL_CANCELLED_CODE = 'approval_cancelled';

/**
 * 默认等待上限（毫秒）：与抽出前一致，仍是 2 分钟。
 *
 * 为什么不再往下调、也不再往上抬：审批条必须有上限（否则窗口关了请求会永久挂着），
 * 但「用户慢慢想」不该被判超时——真正的长时间静默豁免由 model-ipc 的 idle-guard 负责
 * （审批挂起期间不计算静默），这里的上限只兜底「审批条没人回答」。
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 日志：懒拿 + 失败降级。
 *
 * 为什么不在模块顶层 require：本文件被纯 Node 单测直接 require，
 * 顶层加载日志系统会把测试变成「必须先装日志」；而且 getLogger 在 installLogging 之前
 * 返回空实现，顶层缓存下来就永远是空实现了。
 *
 * 为什么模块 id 拼在变量里而不是写字面量：tsconfig.electron.json 只点名了
 * permissions/agent-tools/approvals 三个文件，写成字面量会让 tsc 顺着 require
 * 把 electron/logging/** 一起拉进类型检查图（那边尚未标注类型），等于用一行日志
 * 把 typecheck 门禁拖红。运行时行为一样，都是 require 同一个 ESM 入口。
 */
function debugLog(msg, data) {
  try {
    const specifier = './logging/index.mjs';
    require(specifier)?.getLogger('approvals')?.debug?.(msg, data);
  } catch {
    // 日志系统不可用（例如更老的 Node 不支持 require(ESM)）不能影响审批本身。
  }
}

/**
 * Per-call approvals, answered in the app instead of an OS dialog.
 *
 * The trust anchor for *granting a capability* stays the native dialog. A
 * single write or command is a much smaller step, and a native modal for every
 * one of them blocks the whole window and cannot be dismissed when the run is
 * cancelled. The broker keeps each request tied to the webContents that asked
 * for it, times out to `deny`, and tells the renderer when a request is gone so
 * the bar never gets stuck. A request also follows the run's AbortSignal: once
 * the run is cancelled the bar closes and cannot be answered.
 *
 * 只读观察面（给「审批挂起就不算空闲」用，不改 ask/cancelSender 的语义）：
 * - `pendingCount(senderId?)` / `hasPending(senderId)`：当前挂起数；
 * - `onChange(fn)`：审批发起 / 结束各通知一次，`fn({ event:'open'|'close', id, senderId, ... })`。
 *
 * @param {{
 *   timeoutMs?: number,
 *   now?: () => number,
 *   setTimer?: (fn: Function, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} [options]
 *   `now` / `setTimer` / `clearTimer` 只给测试注入假时钟用，默认就是全局时钟。
 */
function createApprovalBroker({ timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, setTimer, clearTimer } = {}) {
  const pending = new Map();
  const listeners = new Set();
  const waitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.round(Number(timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const armTimer = typeof setTimer === 'function' ? setTimer : (fn, ms) => setTimeout(fn, ms);
  const stopTimer = typeof clearTimer === 'function' ? clearTimer : handle => clearTimeout(handle);

  /** 通知观察者；单个观察者抛错不能反噬审批链路（它可能在做 idle 续期）。 */
  function emitChange(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* 观察者是旁路 */ }
    }
  }

  function countFor(senderId) {
    if (senderId === undefined || senderId === null) return pending.size;
    let total = 0;
    for (const entry of pending.values()) if (entry.senderId === senderId) total += 1;
    return total;
  }

  /**
   * @param {string} id
   * @param {'deny'|'once'|'session'} decision
   * @param {boolean} notify 是否给渲染层发 approval:close
   * @param {{ reason?: string, code?: string|null }} [meta] 关闭原因，只用于事件与日志
   */
  function settle(id, decision, notify, meta = {}) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    stopTimer(entry.timer);
    // A settled request must stop following the run: a stale listener would fire
    // against a request that is already gone.
    if (entry.onAbort && typeof entry.signal?.removeEventListener === 'function') {
      try { entry.signal.removeEventListener('abort', entry.onAbort); } catch { /* Detached signal. */ }
    }
    const reason = typeof meta.reason === 'string' && meta.reason ? meta.reason : 'settled';
    const code = typeof meta.code === 'string' && meta.code ? meta.code : null;
    if (notify) {
      // 载荷保持 `{ id }` 不变：渲染层只按 id 出队，多塞字段会破坏既有契约与测试断言；
      // 「超时 / 用户拒绝 / 取消」的区别走 onChange 与 debug 日志，不进这条 IPC。
      try { if (!entry.sender.isDestroyed?.()) entry.sender.send('approval:close', { id }); } catch { /* Window closed. */ }
    }
    debugLog(`approval ${reason}`, {
      id,
      senderId: entry.senderId,
      decision,
      code,
      waitedMs: Math.max(0, Math.round(now() - entry.openedAt)),
      pending: pending.size,
    });
    emitChange({ event: 'close', id, senderId: entry.senderId, decision, reason, code, pending: pending.size });
    entry.resolve(decision);
    return true;
  }

  function ask(sender, request = {}, signal) {
    return new Promise(resolve => {
      if (!sender || sender.isDestroyed?.()) {
        resolve('deny');
        return;
      }
      // Cancelling the run already happened: there is nothing to ask, and
      // showing the bar would let a late click commit a cancelled write.
      if (signal?.aborted) {
        resolve('deny');
        return;
      }
      const id = randomUUID();
      const timer = armTimer(() => settle(id, 'deny', true, { reason: 'timeout', code: APPROVAL_TIMEOUT_CODE }), waitMs);
      const entry = {
        id, sender, senderId: sender.id, timer, resolve, signal: null, onAbort: null, openedAt: now(),
      };
      if (signal && typeof signal.addEventListener === 'function') {
        entry.signal = signal;
        entry.onAbort = () => settle(id, 'deny', true, { reason: 'aborted' });
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      pending.set(id, entry);
      debugLog('approval pending', { id, senderId: entry.senderId, waitMs, pending: pending.size });
      emitChange({ event: 'open', id, senderId: entry.senderId, waitMs, pending: pending.size });
      // An abort that landed between the check above and the listener would have
      // dispatched before the listener existed; settle it now that it is pending.
      if (entry.onAbort && signal.aborted) {
        settle(id, 'deny', true, { reason: 'aborted' });
        return;
      }
      try {
        sender.send('approval:request', { id, timeoutMs: waitMs, ...request });
      } catch {
        settle(id, 'deny', false, { reason: 'send-failed' });
      }
    });
  }

  function respond(id, decision, senderId) {
    const entry = pending.get(id);
    if (!entry || entry.sender.id !== senderId) return false;
    if (!DECISIONS.includes(decision)) return false;
    return settle(id, decision, false, { reason: 'answered' });
  }

  /** Denies everything still open for one window; used on navigation and close. */
  function cancelSender(senderId) {
    for (const id of [...pending.keys()]) {
      const entry = pending.get(id);
      if (entry.sender.id === senderId) settle(id, 'deny', true, { reason: 'cancelled', code: APPROVAL_CANCELLED_CODE });
    }
  }

  /**
   * 订阅「有审批起来 / 有审批结束」。返回退订函数。
   * @param {(event: { event: 'open'|'close', id: string, senderId: unknown, pending: number, reason?: string, code?: string|null }) => void} listener
   */
  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return {
    ask,
    respond,
    cancelSender,
    /** 不传 senderId 时是全局挂起数（旧签名）；传了就只数这个窗口。 */
    pendingCount: senderId => countFor(senderId),
    hasPending: senderId => countFor(senderId) > 0,
    onChange,
  };
}

function installApprovalIpc(authorize, options = {}) {
  const ipcMain = options.ipcMain || require('electron').ipcMain;
  const broker = options.broker;
  if (!broker) throw new TypeError('broker is required');
  ipcMain.handle('approval:respond', (event, id, decision) => {
    try { authorize(event); } catch { return { ok: false, error: 'unauthorized' }; }
    if (typeof id !== 'string' || typeof decision !== 'string') return { ok: false, error: 'request' };
    return broker.respond(id, decision, event.sender.id) ? { ok: true } : { ok: false, error: 'expired' };
  });
  return broker;
}

module.exports = {
  createApprovalBroker,
  installApprovalIpc,
  DECISIONS,
  APPROVAL_TIMEOUT_CODE,
  APPROVAL_CANCELLED_CODE,
  DEFAULT_TIMEOUT_MS,
};
