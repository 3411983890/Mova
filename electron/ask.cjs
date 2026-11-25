'use strict';

/**
 * 负责：提问卡片这条人工等待通道——把问题发给窗口、等用户回答、超时/取消时收尾；
 *       并在「发出请求 → 拿到回答」整段在 humanWait 登记表里挂一条 `ask_user`。
 * 不负责：卡片怎么渲染（渲染层）、审批条（走 electron/approvals.cjs 的 ask）、
 *          等待上限的取值（就是下面的 ASK_TIMEOUT_MS，登记人工等待不改变它）。
 * 被谁调用：electron/main.cjs（建实例，并注入同一个 humanWait）、electron/chat-agent.mjs 的
 *           ask_user 工具与 ACP 反向请求、electron/skills/packs/goal-plan/handlers.mjs、
 *           electron/ask.test.cjs、tests/human-wait-paths.test.mjs（假时钟验证登记/释放）。
 */

const { randomUUID } = require('node:crypto');

/**
 * 提问卡最长等 2 分钟：与接入人工等待之前完全一致（不因为登记了 humanWait 就延长）。
 * 说明：240s 静默阈值比它长，但 `request.idleTimeoutMs` 下限是 30s（见 model-ipc 的 clampMs），
 * 所以「用户盯着卡片想」仍然可能撞上更短的静默阈值——这才是必须登记人工等待的原因。
 */
const ASK_TIMEOUT_MS = 120000;

/**
 * 提问通道：一次问一个，回答按 `ask:respond` 回到同一个 sender。
 *
 * @param {{
 *   ipcMain: { handle: Function },
 *   authorize: (event: object) => unknown,
 *   humanWait?: { begin: Function }|null,
 * }} options `humanWait` 由 main.cjs 注入，必须与 model-ipc 订阅的是同一个实例。
 */
function createAskBroker({ ipcMain, authorize, humanWait = null }) {
  const pending = new Map();

  /**
   * 登记一条「正在等用户填提问卡」的人工等待，返回幂等的释放函数。
   *
   * 为什么要登记：用户填表单/思考经常超过静默阈值，这段时间一行 emit 都没有，
   * 空闲看门狗会把它当成卡死并 abort 整个回合。
   * senderId 取 `sender.id`（WebContents id）——model-ipc 里 `holdIdleDuringHumanWait({ senderId: sender.id })`
   * 用的就是同一个粒度；换成别的 id（例如 conversationId）hold 不会生效。
   * 没有注入登记表（纯 Node 调用）时退化成空操作：旁路故障不能把提问本身搞挂。
   */
  function beginHumanWait(sender) {
    if (!humanWait || typeof humanWait.begin !== 'function') return () => {};
    try {
      return humanWait.begin(sender?.id ?? null, 'ask_user');
    } catch {
      return () => {};
    }
  }

  ipcMain.handle('ask:respond', (event, id, answer) => {
    authorize(event);
    const item = pending.get(id);
    if (!item || item.sender !== event.sender) return false;
    item.finish(typeof answer === 'string' ? answer.slice(0, 4000) : '');
    return true;
  });

  /**
   * 发一张提问卡并等回答。
   *
   * @param {object} sender 发起这一轮的 WebContents（id 与 model-ipc 的 sender 相同）
   * @param {object} input 卡片内容
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>} 回答；超时/取消/窗口销毁时为空串，卡片发不出去时照原样 reject
   */
  async function ask(sender, input, signal) {
    if (!sender || sender.isDestroyed?.() || signal?.aborted) return '';
    // 从这一刻起就是真的在等用户：整段包在 try/finally 里。
    // 五条退出路径全部落到同一个 release：回答、120s 超时、signal 取消、窗口销毁、任何异常。
    // release 本身幂等，重复调也只生效一次。
    const releaseHumanWait = beginHumanWait(sender);
    try {
      return await new Promise(resolve => {
        const id = randomUUID();
        let onAbort = null;
        let onDestroyed = null;
        // 收尾：登记表项、计时器、两个监听器一次全清，绝不留下「等一个已经没人等的回答」。
        const teardown = () => {
          const item = pending.get(id);
          if (!item) return false;
          pending.delete(id);
          clearTimeout(item.timer);
          if (onAbort) {
            try { signal?.removeEventListener('abort', onAbort); } catch { /* 已 detach */ }
          }
          if (onDestroyed) {
            try { sender.removeListener?.('destroyed', onDestroyed); } catch { /* 已销毁 */ }
          }
          return true;
        };
        const finish = value => {
          if (!teardown()) return;
          if (!sender.isDestroyed?.()) sender.send('ask:close', id);
          resolve(value);
        };
        onAbort = () => finish('');
        // 窗口销毁时既不会有 ask:respond，也不会 abort：不主动收尾会把登记表挂到 120s 超时。
        onDestroyed = () => finish('');
        const timer = setTimeout(() => finish(''), ASK_TIMEOUT_MS);
        pending.set(id, { sender, timer, finish });
        signal?.addEventListener('abort', onAbort, { once: true });
        try { sender.once?.('destroyed', onDestroyed); } catch { /* 不支持事件也不影响提问 */ }
        try {
          sender.send('ask:request', { id, ...input });
        } catch (error) {
          // 卡片没发出去：先清干净再照原样抛给调用方（不把它降级成「用户跳过了」）。
          teardown();
          throw error;
        }
      });
    } finally {
      releaseHumanWait();
    }
  }

  return { ask };
}
module.exports = { createAskBroker };
