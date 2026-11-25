/**
 * 「等用户」的两条真实长等待路径必须登记人工等待：提问卡（`mova_ask_user` → electron/ask.cjs）
 * 与桌面人工接管（`desktop_handoff` → electron/desktop/index.cjs 的 handoff）。
 *
 * 为什么必须锁住：这两条路径都只有 await，没有一行 emit。
 *  - 提问卡：用户填表单/思考经常超过静默阈值（`request.idleTimeoutMs` 下限 30s，默认 240s）；
 *  - 桌面接管：默认等 10 分钟、最长 30 分钟。
 * 不登记就会被打成卡死、abort 整个回合（前端显示「模型连接中断，正在第 N/5 次自动重试」）。
 * 另外锁住「所有退出路径都必须 release」：回答 / 超时 / 取消 / 窗口销毁 / 抛错，
 * 任何一条漏了都会在登记表里留下一条永远不结束的 hold，从此再也不判超时。
 *
 * 全部离线：假时钟（tests/helpers/fake-clock.mjs）+ 纯内存对象。
 * 这里不调引擎的 start()：那会装真实 WH_MOUSE_LL 鼠标钩子并 spawn PowerShell worker，
 * 单测只驱动 handoff() 的等待语义，用 session.abort 结束它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAskBroker } from '../electron/ask.cjs';
import { createApprovalBroker } from '../electron/approvals.cjs';
import { createDesktopEngine } from '../electron/desktop/index.cjs';
import { createIdleGuard, holdIdleDuringApprovals } from '../electron/services/idle-guard.mjs';
import {
  createHumanWaitRegistry,
  holdIdleDuringHumanWait,
} from '../electron/services/human-wait.mjs';
import { createClock, flush } from './helpers/fake-clock.mjs';

const SIX_MINUTES = 6 * 60_000;

/**
 * 假窗口（WebContents 的最小形状）：ask 通道要 send / isDestroyed / once / removeListener，
 * 审批通道只会用到 send / isDestroyed / id。
 */
function fakeWindow(id = 1) {
  const sent = [];
  const listeners = new Map();
  let destroyed = false;
  return {
    id,
    sent,
    isDestroyed: () => destroyed,
    send(channel, payload) {
      if (destroyed) throw new Error('Object has been destroyed');
      sent.push({ channel, payload });
    },
    once(event, fn) {
      listeners.set(event, fn);
    },
    removeListener(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
    /** 模拟用户关窗口：走 Electron 的 'destroyed' 事件，之后再 send 就抛错。 */
    destroy() {
      destroyed = true;
      const fn = listeners.get('destroyed');
      listeners.delete('destroyed');
      fn?.();
    },
    requestOn(channel) {
      return sent.find(row => row.channel === channel)?.payload ?? null;
    },
  };
}

/**
 * 一轮对话的完整时间装置：假时钟 + 登记表 + guard（idleMs 用 1s 便于断言）+ 两条 hold 订阅。
 * `senderId` 与 model-ipc 一致（`sender.id`）。
 */
function makeTurn({ idleMs = 1000, senderId = 1 } = {}) {
  const clock = createClock();
  const humanWait = createHumanWaitRegistry({ now: clock.now });
  const expired = [];
  const guard = createIdleGuard({
    idleMs,
    ceilingMs: 30 * 60_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: expiry => expired.push(expiry),
  });
  const releaseHumanWaitHold = holdIdleDuringHumanWait({ humanWait, guard, senderId });
  return {
    clock, humanWait, guard, expired, releaseHumanWaitHold,
    close: () => { releaseHumanWaitHold(); guard.dispose(); },
  };
}

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
}

// ── 1. 提问卡 ──────────────────────────────────────────────────────────

test('提问卡挂起 6 分钟不判空闲超时；回答之后静默计时从回答那一刻重新开始', async () => {
  const turn = makeTurn({ idleMs: 1000, senderId: 1 });
  const { ipcMain, handlers } = fakeIpcMain();
  const broker = createAskBroker({ ipcMain, authorize: () => {}, humanWait: turn.humanWait });
  const sender = fakeWindow(1);

  const answer = broker.ask(sender, { question: '这两个方案选哪个？' });
  assert.equal(turn.humanWait.countFor(sender.id), 1, '发起提问就要登记一条人工等待');
  assert.equal(turn.humanWait.activeReasons(sender.id).includes('ask_user'), true);
  assert.equal(turn.guard.held(), 1, '登记表 → guard hold 一次（静默计时暂停）');

  // 用户在想：4 分钟不够，这里推 6 分钟。
  await turn.clock.advance(SIX_MINUTES);
  assert.deepEqual(turn.expired, [], '用户还在填提问卡，不许判空闲超时');
  assert.equal(turn.guard.isIdle(), false);

  const request = sender.requestOn('ask:request');
  assert.ok(request?.id, '卡片请求必须带 id');
  assert.equal(await handlers.get('ask:respond')({ sender }, request.id, '选 A'), true);
  assert.equal(await answer, '选 A');
  assert.equal(turn.humanWait.activeCount(), 0, '回答后登记表必须清空');
  assert.equal(turn.guard.held(), 0);

  await turn.clock.advance(999);
  assert.deepEqual(turn.expired, [], '挂起的那 6 分钟不算进静默时间');
  await turn.clock.advance(2);
  assert.equal(turn.expired.length, 1, '回答之后照常按 idleMs 判定超时');
  assert.equal(turn.expired[0].kind, 'idle');

  turn.close();
  assert.equal(turn.clock.count(), 0, '收尾后没有残留计时器');
});

test('提问卡的异常路径（send 抛错 / 窗口销毁）都不留人工等待残留', async () => {
  const turn = makeTurn({ idleMs: 1000, senderId: 1 });
  const { ipcMain } = fakeIpcMain();
  const broker = createAskBroker({ ipcMain, authorize: () => {}, humanWait: turn.humanWait });

  // 路径 A：卡片发不出去（渲染进程已经没了）→ ask 照原样 reject，登记必须已经释放。
  const broken = { ...fakeWindow(1), send() { throw new Error('renderer gone'); } };
  await assert.rejects(broker.ask(broken, { question: '还在吗？' }), /renderer gone/);
  assert.equal(turn.humanWait.activeCount(), 0, '抛错路径也要 release（finally 真的跑了）');
  assert.equal(turn.guard.held(), 0);

  // 路径 B：等回答期间窗口被销毁 → 既不会有 ask:respond，也不会 abort。
  const closing = fakeWindow(1);
  const pending = broker.ask(closing, { question: '要保存吗？' });
  assert.equal(turn.humanWait.activeCount(), 1);
  closing.destroy();
  assert.equal(await pending, '', '窗口销毁时按「用户没回答」收尾');
  assert.equal(turn.humanWait.activeCount(), 0, '窗口销毁也要 release');
  assert.equal(turn.guard.held(), 0);
  assert.equal(closing.sent.length, 1, '窗口已经销毁，不再补发 ask:close');

  await flush();
  turn.close();
  assert.equal(turn.clock.count(), 0);
});

// ── 2. 桌面人工接管 ────────────────────────────────────────────────────

test('桌面接管挂起 6 分钟不判空闲超时；会话被终止后释放并恢复计时', async () => {
  const turn = makeTurn({ idleMs: 1000, senderId: 7 });
  const events = [];
  turn.humanWait.onChange(event => events.push(event));
  const win = { webContents: { id: 7 } };
  const engine = createDesktopEngine({
    humanWait: turn.humanWait,
    getWin: () => win,
    logger: { info() {}, warn() {}, error() {} },
    settings: { enabled: true },
  });

  const pending = engine.handoff({ note: '请在弹出的网银页面完成付款' });
  assert.equal(turn.humanWait.countFor(7), 1, '接管期间要登记人工等待');
  assert.deepEqual(turn.humanWait.activeReasons(7), ['desktop_handoff']);
  assert.equal(turn.guard.held(), 1);

  await turn.clock.advance(SIX_MINUTES);
  assert.deepEqual(turn.expired, [], '桌面接管默认等 10 分钟，这期间不许判空闲超时');

  // 用户/上层终止这一轮：handoff 的下一次轮询看到 aborted 就退出。
  await engine.session.abort('user');
  const result = await pending;
  assert.deepEqual(result, { ok: false, code: 'aborted', note: '请在弹出的网银页面完成付款' });
  assert.equal(turn.humanWait.activeCount(), 0, '退出后登记表必须清空');
  assert.equal(turn.guard.held(), 0);
  assert.deepEqual(events.map(event => event.event), ['begin', 'end']);
  assert.deepEqual(events.map(event => event.reason), ['desktop_handoff', 'desktop_handoff']);

  await turn.clock.advance(999);
  assert.deepEqual(turn.expired, []);
  await turn.clock.advance(2);
  assert.equal(turn.expired.length, 1, '接管结束后静默计时照常恢复');

  turn.close();
  await engine.dispose();
  assert.equal(turn.clock.count(), 0);
});

test('桌面接管抛错时也释放人工等待（不靠 catch，靠 try/finally）', async () => {
  const turn = makeTurn({ idleMs: 1000, senderId: 3 });
  const win = { webContents: { id: 3 } };
  const engine = createDesktopEngine({
    humanWait: turn.humanWait,
    getWin: () => win,
    overlay: {
      setState: () => { throw new Error('overlay boom'); },
      update: () => {},
    },
    logger: { info() {}, warn() {}, error() {} },
    settings: { enabled: true },
  });

  await assert.rejects(engine.handoff({ note: '填验证码' }), /overlay boom/);
  assert.equal(turn.humanWait.activeCount(), 0, '抛错路径也要 release');
  assert.equal(turn.guard.held(), 0);
  assert.deepEqual(turn.humanWait.activeReasons(3), []);

  await turn.clock.advance(1001);
  assert.equal(turn.expired.length, 1, '异常之后 guard 不会永远停在暂停态');

  turn.close();
  await engine.dispose();
  assert.equal(turn.clock.count(), 0);
});

// ── 3. 两条来源同时挂起：hold 必须是计数式 ──────────────────────────────

test('审批挂起 + 提问卡挂起同时存在时，结束一个仍保持暂停（计数式 hold）', async () => {
  const turn = makeTurn({ idleMs: 1000, senderId: 1 });
  const approvals = createApprovalBroker({
    timeoutMs: 600_000, now: turn.clock.now, setTimer: turn.clock.setTimer, clearTimer: turn.clock.clearTimer,
  });
  const { ipcMain, handlers } = fakeIpcMain();
  const asks = createAskBroker({ ipcMain, authorize: () => {}, humanWait: turn.humanWait });
  const sender = fakeWindow(1);
  const releaseApprovalHold = holdIdleDuringApprovals({ approvals, guard: turn.guard, senderId: sender.id });

  const approval = approvals.ask(sender, { capability: 'write', message: '写入 a.ts' });
  const answer = asks.ask(sender, { question: '同时问你一句' });
  assert.equal(turn.guard.held(), 2, '审批一条 + 提问卡一条，各 hold 一次');

  await turn.clock.advance(30_000);
  assert.deepEqual(turn.expired, [], '两条都在等用户，不算空闲');

  // 审批先结束：提问卡还在等用户 → 必须继续保持暂停。
  assert.equal(approvals.respond(sender.requestOn('approval:request').id, 'once', sender.id), true);
  assert.equal(await approval, 'once');
  assert.equal(turn.guard.held(), 1, '放掉审批那一个 hold，提问卡的还在');
  await turn.clock.advance(60_000);
  assert.deepEqual(turn.expired, [], '用户还在填提问卡');

  // 提问卡回答完：两条都没了，才恢复计时。
  const request = sender.requestOn('ask:request');
  assert.equal(await handlers.get('ask:respond')({ sender }, request.id, '好'), true);
  assert.equal(await answer, '好');
  assert.equal(turn.guard.held(), 0);
  assert.equal(turn.humanWait.activeCount(), 0);
  assert.equal(approvals.pendingCount(), 0);

  await turn.clock.advance(1001);
  assert.equal(turn.expired.length, 1, '两个都结束之后照常判定超时');

  releaseApprovalHold();
  turn.close();
  assert.equal(turn.clock.count(), 0);
});
