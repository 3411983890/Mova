/**
 * 「人工等待（浏览器接管）也不能被静默计时杀掉」的契约。
 *
 * 为什么必须锁住：`browser_handoff` 把浏览器交给用户后最长要等 10 分钟，
 * 期间既不调 `approvals.ask`、也一行 emit 都没有。旧实现只认 emit 续期，
 * 240s 一到就 abort 整个回合，前端显示「模型连接中断，正在第 N/5 次自动重试」。
 * 审批那条链路已经有 tests/approvals-idle.test.mjs 锁住，这里锁另一条：
 * 登记表 → guard hold → 静默计时暂停；并且 hold 必须是**计数式**的，
 * 否则「审批 + 人工等待同时挂起」时放掉其中一个就会提前恢复计时。
 *
 * 全部离线：假时钟（注入 now / setTimer / clearTimer）+ 纯内存对象，不真等时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalBroker } from '../electron/approvals.cjs';
import {
  IDLE_TIMEOUT_CODE,
  createIdleGuard,
  holdIdleDuringApprovals,
} from '../electron/services/idle-guard.mjs';
import {
  createHumanWaitRegistry,
  holdIdleDuringHumanWait,
} from '../electron/services/human-wait.mjs';
import { createClock } from './helpers/fake-clock.mjs';

function fakeSender(id = 1) {
  const sent = [];
  return {
    id,
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

/**
 * guard + 登记表共用同一个假时钟。
 * ceilingMs 用 30 分钟：本文件要推进「10 分钟人工等待」，不能被硬上限提前打断。
 */
function makeRig({ idleMs = 1000, ceilingMs = 30 * 60_000, senderId = 1 } = {}) {
  const clock = createClock();
  const humanWait = createHumanWaitRegistry({ now: clock.now });
  const expired = [];
  const guard = createIdleGuard({
    idleMs,
    ceilingMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: expiry => expired.push(expiry),
  });
  const release = holdIdleDuringHumanWait({ humanWait, guard, senderId });
  return {
    clock, humanWait, guard, expired, release,
    close: () => { release(); guard.dispose(); },
  };
}

// ── 1. 登记表本身 ──────────────────────────────────────────────────────

test('登记表：release 幂等、按窗口分别计数、onChange 只在计数真的变化时通知一次', () => {
  const registry = createHumanWaitRegistry({ now: () => 5000 });
  const events = [];
  const unsubscribe = registry.onChange(event => events.push(event));

  const releaseFirst = registry.begin(7, 'browser_handoff');
  const releaseSecond = registry.begin(7, 'browser_handoff');
  assert.equal(registry.countFor(7), 2, '同一个窗口的两条等待分别计数');
  assert.equal(registry.activeCount(), 2);
  assert.deepEqual(registry.activeReasons(7), ['browser_handoff']);
  assert.deepEqual(events.map(event => event.event), ['begin', 'begin']);
  assert.equal(releaseFirst.token, 'hw1');

  assert.equal(releaseFirst(), true);
  assert.equal(releaseFirst(), false, '重复释放只生效一次（工具异常路径会既 catch 又 finally）');
  assert.equal(registry.countFor(7), 1, '第二条等待没有被一起减掉');
  assert.deepEqual(events.map(event => event.event), ['begin', 'begin', 'end']);

  assert.equal(releaseSecond(), true);
  releaseSecond();
  assert.equal(registry.countFor(7), 0);
  assert.equal(registry.activeCount(), 0, 'release 必须删表，不能泄漏');
  assert.deepEqual(registry.activeReasons(7), []);
  assert.equal(events.length, 4, '幂等释放不再重复通知');

  unsubscribe();
  registry.begin(7, 'browser_handoff');
  assert.equal(events.length, 4, '退订之后不再收到事件');
});

test('登记表：senderId 缺省归到全局组，end() 也接受 token 字符串', () => {
  const registry = createHumanWaitRegistry();
  const release = registry.begin();
  assert.equal(registry.countFor(), 1, '不传 senderId 就是全局组');
  assert.equal(registry.countFor('*'), 1);
  assert.equal(registry.countFor(9), 0);
  assert.equal(registry.end(release.token), true, '只拿到字符串 token 也能结束');
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.end(release.token), false, '已经结束的 token 不能再结束一次');
});

// ── 2. guard 的 hold 必须是计数式 ──────────────────────────────────────

test('审批 hold + 人工等待 hold 同时存在：放掉一个仍然 held，全放掉才恢复计时', async () => {
  const clock = createClock();
  const humanWait = createHumanWaitRegistry({ now: clock.now });
  const expired = [];
  const guard = createIdleGuard({
    idleMs: 1000,
    ceilingMs: 30 * 60_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: expiry => expired.push(expiry),
  });
  const broker = createApprovalBroker({
    timeoutMs: 600_000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const sender = fakeSender(1);
  const offApproval = holdIdleDuringApprovals({ approvals: broker, guard, senderId: 1 });
  const offHuman = holdIdleDuringHumanWait({ humanWait, guard, senderId: 1 });

  const releaseHuman = humanWait.begin(1, 'browser_handoff');
  const pending = broker.ask(sender, { message: '写入 a.ts' });
  assert.equal(guard.held(), 2, '两条来源各 hold 一次');

  await clock.advance(30_000);
  assert.deepEqual(expired, [], '有 hold 就不该判定空闲');

  // 审批先结束：人工接管还在等用户，必须继续保持暂停。
  broker.respond(sender.sent[0].payload.id, 'once', 1);
  assert.equal(await pending, 'once');
  assert.equal(guard.held(), 1, '放掉审批那一个 hold，人工等待的还在');
  await clock.advance(60_000);
  assert.deepEqual(expired, [], '人工接管还在等用户，仍然不算空闲');

  releaseHuman();
  assert.equal(guard.held(), 0);
  await clock.advance(999);
  assert.deepEqual(expired, [], '释放之后从释放那一刻重新算静默');
  await clock.advance(2);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].kind, 'idle');
  assert.equal(expired[0].code, IDLE_TIMEOUT_CODE, '错误码仍是既有 timeout');

  offApproval();
  offHuman();
  guard.dispose();
  assert.equal(clock.count(), 0, '退订 + dispose 之后没有任何残留计时器');
});

// ── 3. holdIdleDuringHumanWait 本体 ─────────────────────────────────────

test('人工接管期间 10 分钟没有 emit 也不判超时；释放后按 idleMs 正常超时', async () => {
  const { clock, humanWait, guard, expired, close } = makeRig({ idleMs: 1000 });
  const releaseHuman = humanWait.begin(1, 'browser_handoff');
  assert.equal(guard.held(), 1);

  await clock.advance(10 * 60_000);
  assert.deepEqual(expired, [], '人工接管最长 10 分钟，这期间不允许判空闲超时');
  assert.equal(guard.isIdle(), false);

  releaseHuman();
  assert.equal(guard.held(), 0);
  await clock.advance(999);
  assert.deepEqual(expired, [], '释放前攒下的静默时间不算进去');
  await clock.advance(2);
  assert.equal(expired.length, 1, '释放后照常按 idleMs 判定');
  assert.equal(expired[0].kind, 'idle');
  close();
  assert.equal(clock.count(), 0);
});

test('订阅建立前就已经有人在等：订阅时立刻补上 hold（不能只在变化时才对账）', async () => {
  const clock = createClock();
  const humanWait = createHumanWaitRegistry({ now: clock.now });
  const expired = [];
  const guard = createIdleGuard({
    idleMs: 500,
    ceilingMs: 30 * 60_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: expiry => expired.push(expiry),
  });
  const releaseHuman = humanWait.begin(1, 'browser_handoff');
  const release = holdIdleDuringHumanWait({ humanWait, guard, senderId: 1 });
  assert.equal(guard.held(), 1, '订阅前就有人在等，订阅那一刻就必须 hold');

  await clock.advance(10_000);
  assert.deepEqual(expired, []);

  releaseHuman();
  release();
  assert.equal(guard.held(), 0);
  await clock.advance(501);
  assert.equal(expired.length, 1);
  guard.dispose();
  assert.equal(clock.count(), 0);
});

test('退订时把还挂着的 hold 放掉：guard 不会永远停在暂停态', async () => {
  const { clock, humanWait, guard, expired, release } = makeRig({ idleMs: 500 });
  humanWait.begin(1, 'browser_handoff');
  assert.equal(guard.held(), 1);

  release(); // 相当于 model-ipc finally 里的退订
  release();
  assert.equal(guard.held(), 0, '退订必须归还 hold，否则再也不会超时');

  await clock.advance(501);
  assert.equal(expired.length, 1);
  guard.dispose();
  assert.equal(clock.count(), 0);
});

// ── 4. 只认本窗口 ──────────────────────────────────────────────────────

test('别的窗口的人工接管不给本窗口续命', async () => {
  const { clock, humanWait, guard, expired, close } = makeRig({ idleMs: 1000, senderId: 1 });
  const releaseOther = humanWait.begin(2, 'browser_handoff');
  assert.equal(humanWait.countFor(2), 1);
  assert.equal(humanWait.countFor(1), 0);
  assert.equal(guard.held(), 0, '只认本窗口的人工等待');

  await clock.advance(1001);
  assert.equal(expired.length, 1, '本窗口没人等，就照常判定空闲');
  assert.equal(guard.isIdle(), true);

  releaseOther();
  close();
  assert.equal(clock.count(), 0);
});

test('没有注入登记表时退化成空操作（纯 Node 环境不炸）', () => {
  const release = holdIdleDuringHumanWait({ humanWait: null, guard: null, senderId: 1 });
  assert.equal(typeof release, 'function');
  assert.doesNotThrow(() => release());
});
