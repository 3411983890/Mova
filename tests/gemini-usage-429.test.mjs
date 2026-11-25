/**
 * ACP 429 / 限流的回写（方案 §5.3）。
 *
 * 两条纯函数：`parseRateLimitSignal`（错误文本 → 恢复时间）与
 * `applyRateLimitToUsage`（恢复时间 → 额度快照的 `resetsAt`）。都不碰网络与磁盘，
 * 所以能用真实的上游错误样例钉死行为而不必真的触发一次限流。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyRateLimitToUsage, parseRateLimitSignal } from '../electron/subscription/gemini-usage-limit.mjs';

const T0 = 1_794_601_170_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

test('gRPC RESOURCE_EXHAUSTED + retryDelay 换算成绝对恢复时间', () => {
  const signal = parseRateLimitSignal(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for gemini-4-argon","details":[{"retryDelay":"47s"}]}}',
    T0,
  );
  assert.equal(signal.limited, true);
  assert.equal(signal.resetsAt, T0 + 47_000);
});

test('HTTP Retry-After（秒）按秒换算，不是按毫秒', () => {
  const signal = parseRateLimitSignal('HTTP 429 Too Many Requests\r\nRetry-After: 30', T0);
  assert.equal(signal.limited, true);
  assert.equal(signal.resetsAt, T0 + 30_000, 'Retry-After 的语义是秒');
});

test('「reset after 2h」「try again in 5m」这类相对时间也能换算', () => {
  assert.equal(parseRateLimitSignal('quota exceeded; reset after 2h', T0).resetsAt, T0 + 2 * HOUR);
  assert.equal(parseRateLimitSignal('429 too many requests, try again in 5m', T0).resetsAt, T0 + 5 * MIN);
});

test('绝对时间（ISO / epoch）直接采用，不再叠加当前时间', () => {
  const iso = parseRateLimitSignal('RESOURCE_EXHAUSTED: quota resets at 2026-11-14T12:00:00Z', T0);
  assert.equal(iso.resetsAt, Date.parse('2026-11-14T12:00:00Z'));

  const epoch = parseRateLimitSignal('rate limited, resets at 1794721050', T0);
  assert.equal(epoch.resetsAt, 1_794_721_050_000, '10 位数字按秒级 epoch 解释');
});

test('确认被限流但文本没给时间 → limited:true 且没有 resetsAt（调用方退回默认冷却）', () => {
  const signal = parseRateLimitSignal('You have exceeded your quota for this model.', T0);
  assert.equal(signal.limited, true);
  assert.equal(signal.resetsAt, undefined);
});

test('中文限流文案同样认得出', () => {
  assert.equal(parseRateLimitSignal('请求失败：额度已用尽，请稍后再试', T0).limited, true);
});

test('无关错误不算限流，绝不误判', () => {
  for (const text of ['', '   ', 'network error', 'ECONNRESET', 'model not found', null, undefined]) {
    assert.equal(parseRateLimitSignal(text, T0).limited, false, `${JSON.stringify(text)} 不该被当成限流`);
  }
});

/** 一份「读到了额度」的快照，用来断言回写只碰该碰的地方。 */
function baseUsage() {
  return {
    checkedAt: T0 - 10 * MIN,
    windows: [
      { id: 'gemini-5h', label: 'Gemini · 5 小时窗口', usedPercent: 42, windowDurationMins: 300 },
      { id: 'gemini-weekly', label: 'Gemini · 每周窗口', usedPercent: 71, resetsAt: T0 + 3 * HOUR, windowDurationMins: 10080 },
      { id: '3p-5h', label: '第三方模型（Claude/GPT）· 5 小时', usedPercent: 90, windowDurationMins: 300 },
    ],
  };
}

test('把恢复时间写进 5 小时窗口，其它窗口与百分比一个字节都不动', () => {
  const usage = baseUsage();
  const snapshot = JSON.stringify(usage);
  const resetsAt = T0 + 47 * MIN;

  const next = applyRateLimitToUsage(usage, { resetsAt, at: T0 });

  assert.equal(next.windows.find(w => w.id === 'gemini-5h').resetsAt, resetsAt, '5h 窗口拿到恢复时间');
  assert.equal(next.windows.find(w => w.id === 'gemini-5h').usedPercent, 42, '不编造百分比');
  assert.equal(next.windows.find(w => w.id === '3p-5h').resetsAt, undefined, '第三方窗口不受影响');
  assert.equal(next.windows.find(w => w.id === 'gemini-weekly').resetsAt, T0 + 3 * HOUR);
  assert.equal(next.limitedUntil, resetsAt, '快照级也记一份，便于调度与文案使用');
  assert.equal(JSON.stringify(usage), snapshot, '入参不得被就地修改');
  assert.equal(next.checkedAt, usage.checkedAt, '没有新数据就不要把 checkedAt 往前推');
});

test('没有 5 小时窗口时，写进已用最高的那一个', () => {
  const usage = {
    checkedAt: T0,
    windows: [
      { id: 'gemini-weekly', usedPercent: 12 },
      { id: 'gemini-argon-weekly', usedPercent: 96 },
    ],
  };
  const next = applyRateLimitToUsage(usage, { resetsAt: T0 + 30 * MIN, at: T0 });
  assert.equal(next.windows.find(w => w.id === 'gemini-argon-weekly').resetsAt, T0 + 30 * MIN);
  assert.equal(next.windows.find(w => w.id === 'gemini-weekly').resetsAt, undefined);
});

test('空快照 / 非对象入参也不抛错，只记 limitedUntil', () => {
  const next = applyRateLimitToUsage(undefined, { resetsAt: T0 + 10 * MIN, at: T0 });
  assert.deepEqual(next.windows, []);
  assert.equal(next.limitedUntil, T0 + 10 * MIN);

  const empty = applyRateLimitToUsage({ checkedAt: T0, windows: [], reason: 'probeFailed' }, { resetsAt: T0 + MIN, at: T0 });
  assert.equal(empty.limitedUntil, T0 + MIN);
  assert.equal(empty.reason, 'probeFailed', '原来的 reason 不该被抹掉');
});

test('恢复时间非法或已过去时原样返回，不造假数据', () => {
  const usage = baseUsage();
  for (const patch of [{ resetsAt: T0 - 1, at: T0 }, { resetsAt: Number.NaN, at: T0 }, { at: T0 }]) {
    assert.equal(applyRateLimitToUsage(usage, patch), usage, '不合法就不改，连对象都不换');
  }
});
