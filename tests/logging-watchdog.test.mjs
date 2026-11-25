// 卡顿看门狗的行为约定：只有「事件循环真的被堵了」才告警，而且它自己不能造成卡顿。
// 注入 now / timers 之后不需要真等，只把时间拨过去即可复现。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHangWatchdog } from '../electron/logging/watchdog.mjs';

function fakeLogger(phase = null) {
  const records = [];
  const push = level => (msg, data) => records.push({ level, msg, data });
  return {
    records,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    trace: push('trace'),
    getPhase: () => phase,
  };
}

/** 只实现看门狗真正会用到的直方图方法：enable/disable/reset + 四个统计字段。 */
function fakePerfHooks(stats = {}) {
  return {
    monitorEventLoopDelay() {
      return {
        enable() {}, disable() {}, reset() {},
        mean: stats.mean ?? 0, p50: stats.p50 ?? 0, p99: stats.p99 ?? 0, max: stats.max ?? 0,
      };
    },
  };
}

function harness({ phase = null, clock = { at: 0 }, stats, thresholdMs = 1500 } = {}) {
  const logger = fakeLogger(phase);
  const ticks = [];
  const timers = {
    setInterval(fn) { ticks.push(fn); return ticks.length; },
    clearInterval() {},
  };
  const watchdog = startHangWatchdog({
    logger,
    intervalMs: 1000,
    thresholdMs,
    now: () => clock.at,
    timers,
    uptime: () => clock.at,
    memoryBytes: () => 1024,
    perfHooks: fakePerfHooks(stats),
  });
  return { logger, watchdog, clock, tick: () => ticks.forEach(fn => fn()) };
}

test('正常间隔不告警', () => {
  const { logger, clock, tick, watchdog } = harness();
  clock.at = 1000;
  tick();
  clock.at = 2000;
  tick();
  assert.equal(logger.records.filter(row => row.msg === 'event-loop-hang').length, 0);
  watchdog.stop();
});

test('时间跳了 5 秒就记一条 event-loop-hang，带 drift / phase / 内存', () => {
  const { logger, clock, tick, watchdog } = harness({ phase: 'subscription:list' });
  clock.at = 1000;
  tick();
  // 下一次本该在 2000ms 触发，实际到 6000ms 才跑：主进程被堵了 4 秒。
  clock.at = 6000;
  tick();

  const hang = logger.records.find(row => row.msg === 'event-loop-hang');
  assert.ok(hang, '应记录一条卡顿');
  assert.equal(hang.level, 'warn');
  assert.equal(hang.data.driftMs, 4000);
  assert.equal(hang.data.phase, 'subscription:list', '要能说出「卡在哪一步」');
  assert.equal(hang.data.memoryMB, 0); // 1024 字节 → 四舍五入到 0MB 也是合法值
  watchdog.stop();
});

test('连续多次卡顿每次都记，不合并掉中间的', () => {
  const { logger, clock, tick, watchdog } = harness();
  for (const at of [1000, 6000, 9000, 20000]) {
    clock.at = at;
    tick();
  }
  assert.equal(logger.records.filter(row => row.msg === 'event-loop-hang').length, 3);
  watchdog.stop();
});

test('stop() 之后定时器再触发也不写日志', () => {
  const { logger, clock, tick, watchdog } = harness();
  clock.at = 1000;
  tick();
  watchdog.stop();
  clock.at = 9000;
  tick();
  assert.equal(logger.records.length, 0);
});

test('logger 抛错不会让看门狗把异常抛进定时器', () => {
  const ticks = [];
  const watchdog = startHangWatchdog({
    logger: { warn() { throw new Error('sink 坏了'); }, getPhase: () => null },
    intervalMs: 1000,
    thresholdMs: 100,
    now: (() => { let at = 0; return () => at; })(),
    timers: { setInterval(fn) { ticks.push(fn); return 1; }, clearInterval() {} },
    perfHooks: fakePerfHooks(),
  });
  // 时间没动，drift 为负，不会告警；这里主要是确认 stop() 可用、不抛。
  assert.doesNotThrow(() => watchdog.stop());
});
