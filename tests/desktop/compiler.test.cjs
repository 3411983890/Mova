'use strict';
// 记忆闭环的“已知缺口”护栏。
// 事实（2026-11-12 实测）：
//  - compile(trace, opts) 是 **async**，返回 {ok, appKey, title, intent, params, steps, stepCount, verify, source}
//  - 它认的 trace 形状是 {op, stableKey|path|name|role|rect, ts}
//  - session.act 现在写的是 {at, type, ref, ok, ...} → 没有 op，被过滤掉 → {ok:false, code:'too-short'}
// 修好（见 design/desktop-handoff.md §3.1 的 A/B 两条）之后，把 todo 改成正式断言。
const test = require('node:test');
const assert = require('node:assert');

const { compile, stepsFromTrace } = require('../../electron/desktop/compiler.cjs');

test('compile 是 async，且“方案格式”的 trace 能编出步骤', async () => {
  const trace = [
    { op: 'click', stableKey: 'aid:SaveBtn', ts: 1, ok: true },
    { op: 'click', stableKey: 'aid:OkBtn', ts: 2, ok: true },
    { op: 'key', value: 'enter', ts: 3, ok: true },
  ];
  const result = await compile(trace, { appKey: 'notepad.exe', title: '保存文件' });
  assert.equal(result.ok, true);
  assert.equal(result.stepCount, 3);
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].target.stableKey, 'aid:SaveBtn');
});

test('session.act 的真实 trace 形状（op + locator）能编出步骤', async () => {
  // 这就是 electron/desktop/session.cjs 现在压进 trace 的字段；locator 已经扁平和嵌套各写一遍。
  const sessionTrace = [
    { at: 1, ts: 1, type: 'click', op: 'click', ref: 'w1.b7', locator: { stableKey: 'aid:Save', name: '保存', role: 'button' }, ok: true },
    { at: 2, ts: 2, type: 'click', op: 'click', ref: 'w1.b8', locator: { stableKey: 'aid:Ok', name: '确定', role: 'button' }, ok: true },
    { at: 3, ts: 3, type: 'key', op: 'key', value: 'enter', ok: true },
  ];
  const result = await compile(sessionTrace, { appKey: 'notepad.exe' });
  assert.equal(result.ok, true);
  assert.equal(result.stepCount, 3);
  assert.deepEqual(result.steps[0].target, { stableKey: 'aid:Save' });
  assert.equal(result.steps[2].keys, 'enter');
});

test('只有 ref 没有 locator 的旧 trace 仍然编不出来（缺口边界不变）', async () => {
  const legacy = [
    { at: 1, type: 'click', ref: 'w1.b7', ok: true },
    { at: 2, type: 'type', ref: 'w1.a1', ok: true },
    { at: 3, type: 'key', value: 'enter', ok: true },
  ];
  const result = await compile(legacy, { appKey: 'notepad.exe' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'too-short');
});

test('工具层 recentTrace() 的 rows 可以直接编译成技能（记忆闭环的关键契约）', async () => {
  // tools.cjs 里 rows.push({op, stableKey, role, name, rect, ts, ok}) —— 正好是 compiler 要的形状
  const rows = [
    { op: 'click', stableKey: 'aid:Save', role: 'button', name: '保存', rect: [100, 200, 80, 28], ts: 1, ok: true },
    { op: 'click', stableKey: 'aid:Ok', role: 'button', name: '确定', rect: [300, 400, 80, 28], ts: 2, ok: true },
    { op: 'key', keys: 'enter', ts: 3, ok: true },
  ];
  const result = await compile(rows, { appKey: 'notepad.exe', title: '保存' });
  assert.equal(result.ok, true);
  assert.equal(result.stepCount, 3);
  assert.deepEqual(result.steps[0].target, { stableKey: 'aid:Save' });
});

test('stepsFromTrace 会跳过失败的动作', () => {
  const trace = [
    { op: 'click', stableKey: 'aid:A', ts: 1, ok: true },
    { op: 'click', stableKey: 'aid:B', ts: 2, ok: false },
    { op: 'click', stableKey: 'aid:C', ts: 3, ok: true },
    { op: 'key', value: 'enter', ts: 4, ok: true },
  ];
  const steps = stepsFromTrace(trace);
  assert.equal(steps.ok, true);
  assert.ok(!JSON.stringify(steps).includes('aid:B'));
});
