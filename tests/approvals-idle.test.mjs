/**
 * 「审批条挂着就不算空闲」的契约。
 *
 * 为什么必须锁住：`model:complete` 的静默计时原来只认「收到 emit」，
 * 而等用户点审批的这段时间本来就没有 emit。用户思考超过 4 分钟，整个回合就被 abort；
 * 下层 ACP 客户端已经把空闲阈值放宽到 10 分钟（见 tests/acp-watchdog.test.mjs），
 * 上层却更早动手 —— 上层宽容、下层更宽容，才是这条 bug 的真实形状。
 *
 * 全部离线：假时钟（注入 now / setTimer / clearTimer）+ 纯内存 broker，不真等时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalBroker, APPROVAL_TIMEOUT_CODE, DEFAULT_TIMEOUT_MS } from '../electron/approvals.cjs';
import {
  DEFAULT_CEILING_MS,
  DEFAULT_IDLE_MS,
  IDLE_TIMEOUT_CODE,
  createIdleGuard,
  holdIdleDuringApprovals,
} from '../electron/services/idle-guard.mjs';

/** 让 Promise 的回调先跑完，再看计时器效果（broker 的 settle 会 resolve 一个 Promise）。 */
function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

/** 可手动推进的假时钟：advance() 只触发真的到期的计时器，不依赖真实时间。 */
function createClock(start = 1_000_000) {
  let time = start;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = seq;
      seq += 1;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** 还挂着的计时器数量：用来断言「没有残留」。 */
    count: () => timers.size,
    async advance(ms) {
      time += ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= time)
          .sort((left, right) => left[1].at - right[1].at);
        if (!due.length) return;
        for (const [id, timer] of due) {
          if (timers.get(id) !== timer) continue;
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function fakeSender(id = 1) {
  const sent = [];
  return {
    id,
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

/** broker + guard 共用同一个假时钟与同一个 sender。 */
function makeRig({ approvalTimeoutMs = 600_000, idleMs = 1000, ceilingMs = 600_000, senderId = 1 } = {}) {
  const clock = createClock();
  const broker = createApprovalBroker({
    timeoutMs: approvalTimeoutMs, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const expired = [];
  const guard = createIdleGuard({
    idleMs,
    ceilingMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: expiry => expired.push(expiry),
  });
  const sender = fakeSender(senderId);
  const release = holdIdleDuringApprovals({ approvals: broker, guard, senderId });
  return {
    clock, broker, guard, sender, expired,
    close: () => { release(); guard.dispose(); },
  };
}

test('审批挂起期间长时间没有 emit：空闲计时不触发，审批仍然挂着', async () => {
  const { clock, broker, guard, sender, expired, close } = makeRig();
  const pending = broker.ask(sender, { message: '写入 a.ts' });

  assert.equal(broker.hasPending(1), true);
  assert.equal(guard.held(), 1, '开一条审批就对空闲计一次 hold');

  // 5 倍空闲阈值的时间过去，一行 emit 都没有。
  await clock.advance(5 * 1000);
  assert.deepEqual(expired, [], '审批挂着的时候不允许判定空闲超时');
  assert.equal(guard.isIdle(), false);
  assert.equal(broker.pendingCount(1), 1, '审批还在等用户');

  assert.equal(broker.respond(sender.sent[0].payload.id, 'once', 1), true);
  assert.equal(await pending, 'once');
  close();
  assert.equal(clock.count(), 0, '收尾后不留任何计时器');
});

test('审批结束后空闲计时恢复：静默超阈值按既有 code=timeout 判定', async () => {
  const { clock, broker, guard, sender, expired, close } = makeRig({ idleMs: 1000 });
  const pending = broker.ask(sender, { message: '写入 b.ts' });
  await clock.advance(4000);
  assert.equal(guard.isExpired(), false);

  broker.respond(sender.sent[0].payload.id, 'once', 1);
  assert.equal(await pending, 'once');
  assert.equal(guard.held(), 0, '审批结束后必须把 hold 放掉，否则永远不会超时');

  await clock.advance(999);
  assert.equal(guard.isExpired(), false, '释放之后从释放那一刻重新算静默');
  await clock.advance(2);
  assert.equal(guard.isIdle(), true);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].code, IDLE_TIMEOUT_CODE, '错误码仍是 model-ipc 既有的 timeout');
  assert.equal(expired[0].kind, 'idle');

  close();
  assert.equal(clock.count(), 0);
});

test('审批等待超过上限：返回拒绝、code=approval_timeout、挂起计数归零', async () => {
  const { clock, broker, guard, sender, close } = makeRig({ approvalTimeoutMs: 500 });
  const events = [];
  broker.onChange(event => events.push(event));

  const pending = broker.ask(sender, { message: '运行 npm test' });
  assert.equal(events[0].event, 'open');
  await clock.advance(500);
  assert.equal(await pending, 'deny', '超时按拒绝返回，返回值形状不变');

  const closeEvent = events.at(-1);
  assert.equal(closeEvent.event, 'close');
  assert.equal(closeEvent.reason, 'timeout');
  assert.equal(closeEvent.code, APPROVAL_TIMEOUT_CODE);
  assert.equal(closeEvent.decision, 'deny');
  assert.equal(broker.pendingCount(), 0, '超时后挂起计数归零');
  assert.equal(broker.hasPending(1), false);
  assert.equal(guard.held(), 0, '超时同样要释放 hold');

  // 已经超时的请求，cancelSender 不能再结算一次，也不能留下 broker 的计时器。
  broker.cancelSender(1);
  assert.equal(broker.pendingCount(1), 0);
  assert.equal(events.filter(event => event.event === 'close').length, 1, '不会重复关闭同一条审批');
  close();
  assert.equal(clock.count(), 0, '退订 + dispose 之后没有任何残留计时器');
});

test('同一 sender 两个并发审批：结束一个仍算挂起，全部结束才恢复计时', async () => {
  const { clock, broker, guard, sender, expired, close } = makeRig({ idleMs: 1000 });
  const first = broker.ask(sender, { message: 'a' });
  const second = broker.ask(sender, { message: 'b' });
  assert.equal(broker.pendingCount(1), 2);
  assert.equal(guard.held(), 2);

  await clock.advance(5000);
  assert.deepEqual(expired, [], '两条审批都挂着时仍然不算空闲');

  const [firstPayload, secondPayload] = sender.sent.map(item => item.payload);
  broker.respond(firstPayload.id, 'once', 1);
  assert.equal(await first, 'once');
  assert.equal(guard.held(), 1, '还剩一条挂起，不能恢复空闲计时');
  await clock.advance(5000);
  assert.deepEqual(expired, [], '剩余审批仍享受「不算空闲」');

  broker.respond(secondPayload.id, 'deny', 1);
  assert.equal(await second, 'deny');
  assert.equal(guard.held(), 0);

  await clock.advance(1001);
  assert.equal(expired.length, 1, '全部结束之后才重新开始计时');
  close();
  assert.equal(clock.count(), 0);
});

test('别的窗口的审批不给本窗口续命', async () => {
  const { clock, broker, guard, sender, expired, close } = makeRig({ idleMs: 1000, senderId: 1 });
  const other = fakeSender(2);
  const otherPending = broker.ask(other, { message: '别的窗口的写入' });

  assert.equal(broker.pendingCount(2), 1);
  assert.equal(broker.pendingCount(1), 0);
  assert.equal(guard.held(), 0, '只认本窗口的审批');

  await clock.advance(1001);
  assert.equal(expired.length, 1, '本窗口没有挂起的审批，就照常判定空闲');
  assert.equal(guard.isIdle(), true);

  broker.cancelSender(2);
  assert.equal(await otherPending, 'deny');
  assert.equal(broker.pendingCount(), 0);
  close();
});

test('默认值与抽出前一致：静默 240s、硬上限 30 分钟、审批等待 120s', async () => {
  assert.equal(DEFAULT_IDLE_MS, 240_000);
  assert.equal(DEFAULT_CEILING_MS, 30 * 60_000);
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000);

  const clock = createClock();
  const broker = createApprovalBroker({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const sender = fakeSender();
  const pending = broker.ask(sender, { message: '默认等待' });
  await clock.advance(119_999);
  assert.equal(broker.pendingCount(), 1, '不到默认上限必须还在等');
  await clock.advance(1);
  assert.equal(await pending, 'deny');
  assert.equal(broker.pendingCount(), 0);
});

test('硬上限不被 touch / hold 顺延（与抽出前的 ceiling 计时一致）', async () => {
  const clock = createClock();
  const expired = [];
  const guard = createIdleGuard({
    idleMs: 300,
    ceilingMs: 500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: expiry => expired.push(expiry),
  });
  // 每 100ms 一次活动：静默计时一直被推后，硬上限钉在 500ms。
  for (let step = 0; step < 4; step += 1) {
    await clock.advance(100);
    guard.touch();
  }
  assert.deepEqual(expired, [], '有活动就不该撞静默阈值');
  await clock.advance(100);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].kind, 'ceiling');
  assert.equal(expired[0].code, IDLE_TIMEOUT_CODE);
  guard.dispose();
  assert.equal(clock.count(), 0);
});
