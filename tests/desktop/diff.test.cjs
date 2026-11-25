'use strict';
// diff.cjs 单测：ΔTree 对齐 / 输出格式 / fallback 阈值
/* global require */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { diffTrees, CHANGE_THRESHOLD } = require('../../electron/desktop/diff.cjs');

function states(overrides = {}) {
  return {
    enabled: true,
    focusable: true,
    offscreen: false,
    password: false,
    selected: null,
    expanded: null,
    toggled: null,
    focused: false,
    ...overrides,
  };
}

function node(overrides = {}) {
  const base = {
    ref: 'w1.1',
    role: 'button',
    name: '',
    automationId: '',
    className: 'Qt51514QWindowIcon',
    rect: [10, 20, 100, 30],
    depth: 0,
    parent: '',
    value: null,
    patterns: ['invoke'],
  };
  const merged = { ...base, ...overrides };
  merged.states = states(overrides.states);
  return merged;
}

test('first snapshot asks the caller to render the full tree', () => {
  const result = diffTrees(null, [node({ ref: 'w1.1', role: 'window', name: '微信' })]);
  assert.equal(result.changed, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'first-snapshot');
  assert.match(result.text, /first snapshot/);
  assert.equal(result.changedCount, 0);
});

test('aligns by automationId and reports changed / added / removed', () => {
  const previous = [
    node({ ref: 'w1.1', role: 'window', name: '微信', depth: 0, patterns: ['window'] }),
    node({ ref: 'w1.2', role: 'edit', name: '搜索', automationId: 'searchBox', depth: 1, value: '', patterns: ['value'] }),
    node({ ref: 'w1.3', role: 'button', name: '发送', automationId: 'sendBtn', depth: 1, rect: [10, 300, 80, 30] }),
    node({ ref: 'w1.4', role: 'button', name: '旧按钮', automationId: 'oldBtn', depth: 1, rect: [10, 400, 80, 30] }),
  ];
  const next = [
    node({ ref: 'w1.1', role: 'window', name: '微信', depth: 0, patterns: ['window'] }),
    node({ ref: 'w1.2', role: 'edit', name: '搜索', automationId: 'searchBox', depth: 1, value: '文件传输助手', patterns: ['value'] }),
    node({ ref: 'w1.3', role: 'button', name: '发送', automationId: 'sendBtn', depth: 1, rect: [10, 300, 80, 30], states: { enabled: false } }),
    node({ ref: 'w1.5', role: 'button', name: '新按钮', automationId: 'newBtn', depth: 1, rect: [10, 900, 80, 30] }),
  ];
  const result = diffTrees(previous, next, { window: '微信' });
  assert.equal(result.changed, true);
  assert.equal(result.fallback, false);
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.removed, 1);
  assert.equal(result.stats.changed, 2);
  assert.equal(result.changedCount, 4);
  assert.match(result.text, /^# diff 微信 {2}\+1 -1 ~2$/m);
  assert.match(result.text, /^\+ .*Button "新按钮"/m);
  assert.match(result.text, /^- .*Button "旧按钮"/m);
  assert.match(result.text, /^~ .*Edit "搜索".*value:""→"文件传输助手"/m);
  assert.match(result.text, /^~ .*Button "发送".*\+disabled/m);
});

test('a relabelled control at the same spot is one ~ line, not a -/+ pair', () => {
  const previous = [node({ ref: 'w1.2', role: 'button', name: '发送', automationId: '', className: 'Button', rect: [10, 10, 90, 30] })];
  const next = [node({ ref: 'w1.2', role: 'button', name: '发送中', automationId: '', className: 'Button', rect: [10, 10, 90, 30] })];
  const result = diffTrees(previous, next);
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.removed, 0);
  assert.equal(result.stats.changed, 1);
  assert.match(result.text, /^~ .*Button "发送中".*name:"发送"→"发送中"/m);
});

test('a name change on an automationId-keyed node shows up as ~ not as -/+', () => {
  const previous = [node({ ref: 'w1.2', automationId: 'okBtn', name: '确定', depth: 1 })];
  const next = [node({ ref: 'w1.2', automationId: 'okBtn', name: 'OK', depth: 1 })];
  const result = diffTrees(previous, next);
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.removed, 0);
  assert.equal(result.stats.changed, 1);
  assert.match(result.text, /^~ .*Button "OK".*name:"确定"→"OK"/m);
});
test('rect jitter under 8px is ignored, a bigger move is reported', () => {
  const previous = [node({ ref: 'w1.2', name: '确定', automationId: 'a1', rect: [100, 100, 80, 30] })];
  const jitter = diffTrees(previous, [node({ ref: 'w1.2', name: '确定', automationId: 'a1', rect: [105, 104, 80, 30] })]);
  assert.equal(jitter.changed, false);
  assert.match(jitter.text, /没有变化/);

  const moved = diffTrees(previous, [node({ ref: 'w1.2', name: '确定', automationId: 'a1', rect: [160, 100, 80, 30] })]);
  assert.equal(moved.changed, true);
  assert.match(moved.text, /@100,100→160,100/);
});

test('a brand new top-level window is pinned on top and marked modal', () => {
  const previous = [node({ ref: 'w1.1', role: 'window', name: '微信', depth: 0, patterns: ['window'] })];
  const next = [
    node({ ref: 'w1.1', role: 'window', name: '微信', depth: 0, patterns: ['window'] }),
    node({ ref: 'w2.1', role: 'window', name: '创建数据透视表', depth: 0, patterns: ['window'] }),
    node({ ref: 'w2.2', role: 'button', name: '确定', depth: 1, parent: 'w2.1' }),
  ];
  const result = diffTrees(previous, next);
  assert.equal(result.modal, '创建数据透视表');
  assert.match(result.lines[0], /^\+ window "创建数据透视表" modal$/);
  assert.match(result.text, /\(modal: "创建数据透视表"\)/);
  assert.match(result.text, /^\+ .*\[w2\.2\] Button "确定"/m);
});

test('falls back when most of the tree changed', () => {
  const previous = [];
  const next = [];
  for (let i = 0; i < 40; i += 1) {
    previous.push(node({ ref: `w1.${i + 1}`, role: 'listitem', name: `旧${i}`, automationId: `old-${i}`, rect: [i * 10, 0, 8, 8] }));
    next.push(node({ ref: `w1.${i + 1}`, role: 'listitem', name: `新${i}`, automationId: `new-${i}`, rect: [i * 10, 400, 8, 8] }));
  }
  const result = diffTrees(previous, next);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'too-many-changes');
  assert.ok(result.changedCount > 40 * CHANGE_THRESHOLD);
});

test('accepts {nodes} wrappers and tolerates empty input', () => {
  const snapshot = { nodes: [node({ ref: 'w1.1', role: 'window', name: '微信', depth: 0, patterns: ['window'] })] };
  const same = diffTrees(snapshot, { nodes: snapshot.nodes });
  assert.equal(same.changed, false);
  assert.match(same.text, /没有变化/);

  const empty = diffTrees(null, []);
  assert.equal(empty.changed, false);
  assert.equal(empty.fallback, true);
});

test('secret values are masked and a pure value edit stays invisible', () => {
  const previous = [node({ ref: 'w1.2', role: 'edit', name: '密码', automationId: 'pw', value: 'hunter2', states: { password: true }, rect: [0, 0, 100, 30] })];
  const next = [node({ ref: 'w1.2', role: 'edit', name: '密码', automationId: 'pw', value: 'hunter3', states: { password: true }, rect: [0, 0, 100, 30] })];

  // 只改密码内容：脱敏后不可见，且不泄漏
  const onlyValue = diffTrees(previous, next);
  assert.equal(onlyValue.changed, false);
  assert.doesNotMatch(onlyValue.text, /hunter/);

  // 有其他变化时，行内也只能出现 value=<secret>
  const moved = diffTrees(previous, [node({ ref: 'w1.2', role: 'edit', name: '密码', automationId: 'pw', value: 'hunter3', states: { password: true }, rect: [0, 200, 100, 30] })]);
  assert.equal(moved.changed, true);
  assert.match(moved.text, /value=<secret>/);
  assert.doesNotMatch(moved.text, /hunter/);
});
