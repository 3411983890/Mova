/**
 * 负责：一轮对话的「静默超时 / 单次尝试硬上限」计时，以及在审批条挂起期间把**静默计时按下去**。
 * 不负责：abort 谁、错误怎么变成 IPC 错误码、重试策略（都在 electron/model-ipc.cjs）；
 *          也不认识 electron、approvals 的内部结构——只用 broker 公开的 onChange / 事件字段。
 * 被谁调用：electron/model-ipc.cjs（每次尝试一个 guard）；tests/approvals-idle.test.mjs。
 *
 * 为什么单独抽出来：`model:complete` 的静默计时原来只认「收到 emit」，
 * 而「等用户点审批」这段时间本来就没有 emit，于是用户想超过 4 分钟就被判定卡死、
 * 整个回合被 abort（下层 ACP 客户端已经把空闲阈值放宽到 10 分钟，上层反而更早动手）。
 * 把这个判定抽成纯函数模块后：默认值、触发条件、错误码与抽出前逐字一致，
 * 同时能注入假时钟被 `node --test` 直接驱动。
 */

/**
 * 超时统一 code：与抽出前 model-ipc 的 `ModelError('timeout')` 同码。
 * 换实现位置不换用户能看到的错误码，重试策略（RETRYABLE 里有 'timeout'）因此不受影响。
 */
export const IDLE_TIMEOUT_CODE = 'timeout';

/** 默认静默阈值：4 分钟没有 emit 才算卡死（与抽出前 model-ipc 的默认值一致）。 */
export const DEFAULT_IDLE_MS = 240_000;

/** 单次尝试的硬上限：30 分钟（与抽出前 model-ipc 的默认值一致）。 */
export const DEFAULT_CEILING_MS = 30 * 60_000;

/** 正的毫秒数归一：非数字 / <=0 一律当没配，交给默认值。 */
function positiveMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

/**
 * 一个 guard = 一次尝试的两个计时器（静默 + 硬上限）。
 *
 * 语义与 model-ipc 抽出前的 `armIdle()` / `ceiling` 完全一致：
 * - 静默计时每次 `touch()` 重新起算；硬上限只在构造时起一次、不被 touch 顺延；
 * - 任一计时器到期 → 记 `expired` → 调一次 `onExpire(expiry)`（model-ipc 在里面 abort 本轮）；
 * - `dispose()` 清掉全部计时器，之后 touch/hold/release 都是空操作。
 *
 * 新增的只有 `hold()` / `release()`：审批挂起期间**暂停**静默计时，
 * 而不是每次审批事件 touch 一下——用户可能盯着审批条看 10 分钟，
 * touch 一次只多给 4 分钟，照样会被误杀。
 *
 * @param {{
 *   idleMs?: number,
 *   ceilingMs?: number,
 *   now?: () => number,
 *   setTimer?: (fn: Function, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   onExpire?: (expiry: { kind: 'idle'|'ceiling', code: string, silenceMs: number, idleMs: number, ceilingMs: number }) => void,
 * }} [options]
 * @returns {{
 *   idleMs: number,
 *   ceilingMs: number,
 *   touch: () => void,
 *   hold: () => boolean,
 *   release: () => boolean,
 *   held: () => number,
 *   isIdle: () => boolean,
 *   isExpired: () => boolean,
 *   expiry: () => object|null,
 *   silenceMs: () => number,
 *   dispose: () => void,
 * }}
 */
export function createIdleGuard({
  idleMs = DEFAULT_IDLE_MS,
  ceilingMs = DEFAULT_CEILING_MS,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle),
  onExpire = null,
} = {}) {
  const idleTimeout = positiveMs(idleMs) ?? DEFAULT_IDLE_MS;
  const ceilingTimeout = positiveMs(ceilingMs) ?? DEFAULT_CEILING_MS;
  let lastActivityAt = now();
  let idleTimer = null;
  let ceilingTimer = null;
  let holds = 0;
  let expiry = null;
  let disposed = false;

  function clearIdle() {
    if (idleTimer === null) return;
    clearTimer(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    if (disposed || expiry || holds > 0) return;
    idleTimer = setTimer(() => expire('idle'), idleTimeout);
  }

  /** 判定超时：先清计时器再回调，回调里再触发 dispose 也不会二次清同一句柄。 */
  function expire(kind) {
    if (disposed || expiry) return;
    clearIdle();
    if (ceilingTimer !== null) { clearTimer(ceilingTimer); ceilingTimer = null; }
    expiry = {
      kind,
      code: IDLE_TIMEOUT_CODE,
      at: now(),
      silenceMs: Math.max(0, Math.round(now() - lastActivityAt)),
      idleMs: idleTimeout,
      ceilingMs: ceilingTimeout,
    };
    try {
      onExpire?.(expiry);
    } catch {
      // 回调抛错不能把「已经判定超时」这个结论吞掉：调用方在回调里 abort 本轮。
    }
  }

  // 硬上限从构造起算，与抽出前 `const ceiling = setTimeout(...)` 的位置一致。
  ceilingTimer = setTimer(() => expire('ceiling'), ceilingTimeout);
  armIdle();

  return {
    idleMs: idleTimeout,
    ceilingMs: ceilingTimeout,
    touch() {
      if (disposed || expiry) return;
      lastActivityAt = now();
      if (holds === 0) armIdle();
    },
    hold() {
      if (disposed || expiry) return false;
      holds += 1;
      clearIdle();
      return true;
    },
    release() {
      if (disposed || holds === 0) return false;
      holds -= 1;
      if (holds > 0) return true;
      // 用户想完了：从「释放的那一刻」重新开始算静默，而不是把挂起的时间也算进去。
      lastActivityAt = now();
      armIdle();
      return true;
    },
    held: () => holds,
    isIdle: () => expiry?.kind === 'idle',
    isExpired: () => expiry !== null,
    expiry: () => expiry,
    silenceMs: () => Math.max(0, Math.round(now() - lastActivityAt)),
    dispose() {
      disposed = true;
      clearIdle();
      if (ceilingTimer !== null) { clearTimer(ceilingTimer); ceilingTimer = null; }
    },
  };
}

/**
 * 审批挂起期间不算空闲：broker 每开一条审批就对 guard `hold()`，最后一条结束再 `release()`。
 *
 * 只认与本轮同一个 sender 的审批：别的窗口（edge 扩展 / 另一个工作窗口）挂着审批条，
 * 不代表这一轮在等用户。返回退订函数；退订时把还挂着的 hold 全部释放，
 * 否则 guard 会永远停在「暂停」状态，下一次超时判定就再也不会发生。
 *
 * @param {{ approvals?: { onChange?: Function }|null, guard?: object|null, senderId?: number|string|null }} [options]
 * @returns {() => void} 退订（幂等）
 */
export function holdIdleDuringApprovals({ approvals = null, guard = null, senderId = null } = {}) {
  const noop = () => {};
  if (!guard || typeof guard.hold !== 'function' || typeof guard.release !== 'function') return noop;
  if (typeof approvals?.onChange !== 'function') return noop;
  const watched = new Set();
  const matches = event => senderId === null || senderId === undefined || event.senderId === senderId;

  const unsubscribe = approvals.onChange(event => {
    if (!event || typeof event.id !== 'string' || !matches(event)) return;
    if (event.event === 'open') {
      if (watched.has(event.id)) return;
      watched.add(event.id);
      guard.hold();
      return;
    }
    if (event.event === 'close' && watched.delete(event.id)) guard.release();
  });

  return () => {
    try { unsubscribe?.(); } catch { /* 退订失败也不能留下 hold */ }
    const leftover = watched.size;
    watched.clear();
    for (let index = 0; index < leftover; index += 1) guard.release();
  };
}
