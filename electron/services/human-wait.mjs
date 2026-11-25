/**
 * 负责：登记「这一轮正在等用户本人操作」这件事（浏览器人工接管等），按窗口（senderId）计数，
 *       并把「有人工等待」翻译成 idle-guard 的一次 hold；等待结束就释放。
 * 不负责：决定一种等待最长能等多久（各调用点自己定，例如 browser handoff 的 10 分钟上限）、
 *          也不负责审批条（审批走 electron/approvals.cjs 的 ask / onChange）。
 * 被谁调用：electron/model-ipc.cjs（每次尝试订阅一次）、electron/browser/controller.cjs（handoff 期间 begin）、
 *           electron/main.cjs（建一个进程内实例并注入上面两处）；tests/human-wait-idle.test.mjs。
 *
 * 为什么单独抽出来：审批之外还有一类合法的人工等待——`browser_handoff` 把浏览器交给用户
 * （最长 10 分钟），期间既不调 `approvals.ask`，也一行 emit 都没有。240s 静默计时照样把它
 * 判定成卡死并 abort 整个回合，前端就显示「模型连接中断，正在第 N/5 次自动重试」。
 * 这里只提供「有人在等」的纯内存信号源，计时语义仍留在 idle-guard（那里才能被假时钟驱动）。
 *
 * 新增人工等待路径（提问卡 `ask_user`、桌面 `desktop_handoff` 等）必须在 `main.cjs` 用**同一个实例**注入，
 * 不要各建各的：model-ipc 订阅的是 main.cjs 建的那一个，另建一个新登记表等于没登记。
 */

/** senderId 缺省时的全局组：拿不到窗口身份（例如纯 Node 调用）就记在这里，不丢事件。 */
const GLOBAL_GROUP = '*';

/** 单调递增的 token 序号：只在本进程内唯一，够用于 Map 键与诊断日志。 */
let sequence = 0;

/** reason 归一：只用于诊断与日志，不参与任何判定，所以截断即可，不抛错。 */
function reasonText(reason) {
  return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 80) : 'human-wait';
}

/** senderId 归一：null / undefined / 空串都算「没给」，落到全局组。 */
function groupOf(senderId) {
  if (senderId === null || senderId === undefined || senderId === '') return GLOBAL_GROUP;
  return senderId;
}

/**
 * `end(token)` 的入参归一：既接受 `begin()` 返回的那个 release 函数（最常见），
 * 也接受它身上的 `.token` 字符串（异步路径里只保存字符串时用得上）。
 * @returns {string|null}
 */
function tokenOf(token) {
  if (typeof token === 'function') return typeof token.token === 'string' ? token.token : null;
  return typeof token === 'string' && token ? token : null;
}

/**
 * 人工等待登记表：`begin` 记一条，`release` 删一条，计数按窗口归组。
 *
 * 设计要点：
 * - `release()` **幂等**：工具异常路径常常既 catch 又 finally，重复释放只生效一次，
 *   绝不能把别人的等待一起减掉（计数错一位就会让静默计时提前恢复，等于没修）。
 * - 内部用 `Map<token, {senderId, reason, since}>`，`release` 必须 `delete`，
 *   否则长时间运行的进程里这张表会随每次接管稳定增长。
 * - `onChange` 只在**真的变化**时通知：多一次「begin」就会多一次 hold，durable 泄漏会更难查。
 *
 * @param {{ now?: () => number, logger?: { debug?: Function, warn?: Function }|null }} [options]
 * @returns {{
 *   begin: (senderId?: number|string|null, reason?: string) => (() => boolean) & { token?: string, senderId?: unknown },
 *   end: (token: string|Function) => boolean,
 *   countFor: (senderId?: number|string|null) => number,
 *   activeCount: () => number,
 *   activeReasons: (senderId?: number|string|null) => string[],
 *   onChange: (listener: Function) => (() => void),
 * }}
 */
export function createHumanWaitRegistry({ now = Date.now, logger = null } = {}) {
  const entries = new Map();
  const listeners = new Set();

  /** 观察者是旁路：单个订阅者抛错不能反噬「登记/释放」本身。 */
  function emitChange(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* 旁路 */ }
    }
  }

  function log(msg, data) {
    try { logger?.debug?.(msg, data); } catch { /* 日志不可用不影响等待本身 */ }
  }

  /** @param {number|string|null|undefined} [senderId] 传了就只数这个窗口，不传就是全局组。 */
  function countFor(senderId) {
    const group = groupOf(senderId);
    let total = 0;
    for (const entry of entries.values()) if (entry.senderId === group) total += 1;
    return total;
  }

  /**
   * 结束一条人工等待。token 不认识（已经释放过 / 从未存在）时返回 false，不做任何事。
   * @param {string|Function} token
   * @returns {boolean} 这次调用是否真的删掉了一条记录
   */
  function end(token) {
    const key = tokenOf(token);
    if (!key) return false;
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    const event = {
      event: 'end',
      token: key,
      senderId: entry.senderId,
      reason: entry.reason,
      waitedMs: Math.max(0, Math.round(now() - entry.since)),
      count: countFor(entry.senderId),
      total: entries.size,
    };
    log('human wait end', event);
    emitChange(event);
    return true;
  }

  /**
   * 登记一条人工等待。
   * @param {number|string|null} [senderId] 发起等待的窗口；缺省落到全局组 '*'
   * @param {string} [reason] 诊断用原因（例如 'browser_handoff'）
   * @returns {(() => boolean) & { token: string, senderId: unknown }} release：幂等，重复调只生效一次
   */
  function begin(senderId, reason) {
    const group = groupOf(senderId);
    sequence += 1;
    const token = `hw${sequence}`;
    const since = now();
    entries.set(token, { senderId: group, reason: reasonText(reason), since });
    log('human wait begin', { token, senderId: group, reason: reasonText(reason), total: entries.size });
    emitChange({
      event: 'begin',
      token,
      senderId: group,
      reason: reasonText(reason),
      count: countFor(group),
      total: entries.size,
    });
    const release = () => end(token);
    release.token = token;
    release.senderId = group;
    return release;
  }

  /**
   * 订阅计数变化。返回退订函数（幂等）。
   * @param {(event: { event: 'begin'|'end', token: string, senderId: unknown, reason: string, count: number, total: number, waitedMs?: number }) => void} listener
   * @returns {() => void}
   */
  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return {
    begin,
    end,
    countFor,
    /** 全进程还挂着的人工等待总数（诊断用；正常空闲时应为 0）。 */
    activeCount: () => entries.size,
    /** 某个窗口（不传 = 全局组）当前挂着的原因，按登记顺序去重。 */
    activeReasons(senderId) {
      const group = groupOf(senderId);
      const reasons = [];
      for (const entry of entries.values()) {
        if (entry.senderId === group && !reasons.includes(entry.reason)) reasons.push(entry.reason);
      }
      return reasons;
    },
    onChange,
  };
}

/**
 * 人工等待期间不算空闲：本窗口只要还有一条人工等待挂着，就对 guard `hold()` 一次；
 * 全部结束再 `release()`。
 *
 * 为什么是「对账」而不是「事件计数」：begin/end 事件可能成串到达（同一轮里换了好几次接管、
 * 或者订阅建立前就已经有人在等），按事件加减 hold 一旦错位就永久偏移。
 * 这里每次变化都按 `countFor(senderId) > 0` 重新对账，重复通知因此天然幂等。
 *
 * 只认与本轮同一个 sender 的人工等待：别的窗口把浏览器交给用户，不代表这一轮在等用户
 *（否则一个窗口的接管会给所有窗口续命，超时判定就永不触发）。
 *
 * @param {{
 *   humanWait?: { onChange?: Function, countFor?: Function, activeCount?: Function }|null,
 *   guard?: { hold?: Function, release?: Function }|null,
 *   senderId?: number|string|null,
 * }} [options]
 * @returns {() => void} 退订（幂等）；退订时把还挂着的 hold 放掉，绝不让 guard 停在「暂停」
 */
export function holdIdleDuringHumanWait({ humanWait = null, guard = null, senderId = null } = {}) {
  const noop = () => {};
  if (!guard || typeof guard.hold !== 'function' || typeof guard.release !== 'function') return noop;
  if (typeof humanWait?.onChange !== 'function' || typeof humanWait.countFor !== 'function') return noop;
  const allSenders = senderId === null || senderId === undefined;
  let held = false;

  /** 目标状态：有人工等待就 hold 一次，没有就释放。 */
  const wantsHold = () => {
    if (allSenders) return (typeof humanWait.activeCount === 'function' ? humanWait.activeCount() : 0) > 0;
    return humanWait.countFor(senderId) > 0;
  };

  function sync() {
    const want = wantsHold();
    if (want === held) return;
    if (want) {
      // guard 已 dispose / 已判定超时时 hold() 返回 false：不能把 held 记成真，否则退订时会多放一次。
      if (guard.hold()) held = true;
      return;
    }
    guard.release();
    held = false;
  }

  // 先订阅再对账：反过来的话，两步之间结束的等待会让这里永远多一个 hold。
  const unsubscribe = humanWait.onChange(sync);
  sync();

  return () => {
    try { unsubscribe?.(); } catch { /* 退订失败也不能留下 hold */ }
    if (!held) return;
    held = false;
    guard.release();
  };
}
