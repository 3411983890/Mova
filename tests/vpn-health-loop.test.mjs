/**
 * 负责：`createHealthLoop` 的定时器与生命周期（假定时器，不真的等 5 分钟）。
 * 不负责：单次判定/切换（`tests/vpn-health.test.mjs`）。
 * 被谁调用：`node --test`。
 *
 * 为什么单独测：这个定时器会跟着内核一起起停。测不住的话两个后果——
 * 应用退出后还挂着一个 interval（进程退不掉），或者内核停了巡检还在跑（一直报 controller_unreachable）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEALTH_INTERVAL_MS, createHealthLoop } from '../electron/vpn/health.mjs';

/** 假定时器：不真等，手动触发。 */
function fakeTimers() {
  const created = [];
  return {
    created,
    setIntervalImpl: (fn, ms) => {
      const timer = {
        fn, ms, cleared: false, unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      created.push(timer);
      return timer;
    },
    clearIntervalImpl: timer => { timer.cleared = true; },
  };
}

test('默认 5 分钟；start 起一个已 unref 的定时器，stop 清掉', async () => {
  const timers = fakeTimers();
  let ticks = 0;
  const loop = createHealthLoop({
    onTick: () => { ticks += 1; },
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });

  assert.equal(loop.intervalMs, HEALTH_INTERVAL_MS);
  assert.equal(HEALTH_INTERVAL_MS, 300_000, '用户要求 5 分钟一次');
  assert.equal(loop.running, false);

  const started = loop.start();
  assert.equal(started.started, true);
  assert.equal(started.intervalMs, 300_000);
  assert.equal(loop.running, true);
  assert.equal(timers.created.length, 1);
  assert.equal(timers.created[0].ms, 300_000);
  assert.equal(timers.created[0].unrefCalled, true, '必须 unref，否则定时器会挂住进程退出');

  // 重复 start 不叠加定时器。
  const again = loop.start();
  assert.equal(again.started, false);
  assert.equal(timers.created.length, 1, '重复 start 不能再起一个 interval');

  // 手动跑两轮（真实环境由 interval 触发）。
  await loop.tick();
  await loop.tick();
  assert.equal(ticks, 2);

  const stopped = loop.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(loop.running, false);
  assert.equal(timers.created[0].cleared, true);

  // 停了之后再 tick 不许再执行 onTick。
  await loop.tick();
  assert.equal(ticks, 2, 'stop 之后 tick 不应该再跑 onTick');
});

test('onTick 抛错只记日志，不打断循环（下一轮照常跑）', async () => {
  const timers = fakeTimers();
  const warnings = [];
  let calls = 0;
  const loop = createHealthLoop({
    onTick: () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('boom'), { code: 'internal' });
      return 'ok';
    },
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    logger: { warn: (message, payload) => warnings.push([message, payload]) },
  });
  loop.start();

  assert.equal(await loop.tick(), null, '抛错的一轮返回 null');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'health-loop-tick-failed');
  assert.equal(await loop.tick(), 'ok', '下一轮必须照常执行');
  assert.equal(loop.running, true, '单轮失败不能把循环停掉');
  loop.stop();
});

test('非法 intervalMs 被夹到安全值，不会变成 0 毫秒疯狂触发', () => {
  const timers = fakeTimers();
  const zero = createHealthLoop({
    intervalMs: 0,
    onTick: () => {},
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });
  assert.ok(zero.intervalMs >= 100, `intervalMs 应被夹到 ≥100，实际 ${zero.intervalMs}`);

  const negative = createHealthLoop({
    intervalMs: -5_000,
    onTick: () => {},
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });
  assert.equal(negative.intervalMs, 100);

  const nan = createHealthLoop({
    intervalMs: Number.NaN,
    onTick: () => {},
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });
  assert.equal(nan.intervalMs, HEALTH_INTERVAL_MS, 'NaN 回落到默认 5 分钟');
});

test('stop 幂等：重复 stop 不抛，也不会清两次', () => {
  const timers = fakeTimers();
  const loop = createHealthLoop({
    onTick: () => {},
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });
  loop.start();
  assert.equal(loop.stop().stopped, true);
  assert.equal(loop.stop().stopped, false, '第二次 stop 报告未在运行');
});
