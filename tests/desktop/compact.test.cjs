'use strict';
// compact.cjs 单测：规则来自 Mova桌面操作开发方案.md §5.2
// （仓库的 eslint 配置只给 tests/**/*.mjs 声明 node 全局，.cjs 测试文件在这里自己声明）
/* global require */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compact, shouldRender, stateFlags } = require('../../electron/desktop/compact.cjs');
const { normalizeNodes, buildTree } = require('../../electron/desktop/tree.cjs');

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

function windowTree(children) {
  const root = node({ ref: 'w1.1', role: 'window', name: '2026销售.xlsx - Excel', depth: 0, patterns: ['window'], parent: '' });
  return [root, ...children];
}

test('refs stay on the line head and the header names the window', () => {
  const nodes = windowTree([
    node({ ref: 'w1.2', role: 'button', name: '确定', depth: 1, parent: 'w1.1' }),
  ]);
  const result = compact(nodes);
  assert.match(result.lines[0], /^# window w1\.1 "2026销售\.xlsx - Excel"/);
  assert.ok(result.lines.some((line) => line.trim().startsWith('[w1.2] Button "确定"')));
  assert.equal(typeof result.toString(), 'string');
  assert.equal(result.toString(), result.text);
});

test('interactive controls and named containers survive, unnamed wrappers do not', () => {
  const nodes = windowTree([
    node({ ref: 'w1.2', role: 'pane', name: '', depth: 1, parent: 'w1.1', patterns: [] }),
    node({ ref: 'w1.3', role: 'edit', name: '', depth: 2, parent: 'w1.2', value: '', patterns: ['value'] }),
    node({ ref: 'w1.4', role: 'pane', name: '数据透视表', depth: 1, parent: 'w1.1', patterns: [] }),
    node({ ref: 'w1.5', role: 'scrollbar', name: '', depth: 1, parent: 'w1.1', patterns: ['rangevalue'] }),
  ]);
  const result = compact(nodes);
  const body = result.lines.slice(1).join('\n');
  assert.match(body, /\[w1\.3\] Edit/);
  assert.match(body, /\[w1\.4\] Pane "数据透视表"/);
  assert.doesNotMatch(body, /Scrollbar/);
  assert.doesNotMatch(body, /\[w1\.2\]/);
  assert.equal(shouldRender({ role: 'scrollbar', name: 'x', patterns: [] }), false);
});

test('password value is always <secret> and never leaks the text', () => {
  const nodes = windowTree([
    node({ ref: 'w1.2', role: 'edit', name: '密码', depth: 1, parent: 'w1.1', value: 'hunter2', states: { password: true }, patterns: ['value'] }),
  ]);
  const result = compact(nodes);
  assert.match(result.text, /value=<secret>/);
  assert.doesNotMatch(result.text, /hunter2/);
});

test('state flags render disabled / selected / expanded', () => {
  const nodes = windowTree([
    node({ ref: 'w1.2', role: 'button', name: '确定', depth: 1, parent: 'w1.1', states: { enabled: false } }),
    node({ ref: 'w1.3', role: 'tabitem', name: '6月', depth: 1, parent: 'w1.1', states: { selected: true }, patterns: ['selectionitem'] }),
    node({ ref: 'w1.4', role: 'combobox', name: '数据透视表', depth: 1, parent: 'w1.1', states: { expanded: false }, patterns: ['expandcollapse'] }),
  ]);
  const result = compact(nodes);
  assert.match(result.text, /Button "确定" disabled/);
  assert.match(result.text, /Tabitem "6月" selected/);
  assert.match(result.text, /Combobox "数据透视表" collapsed/);
  assert.deepEqual(stateFlags(states({ enabled: false, selected: true })), ['disabled', 'selected']);
});

test('consecutive same-role items collapse into one ×N line', () => {
  const items = [1, 2, 3, 4].map((month, index) => node({
    ref: `w1.${index + 2}`,
    role: 'dataitem',
    name: `${month}月`,
    depth: 1,
    parent: 'w1.1',
    rect: [index * 40, 100, 38, 24],
    patterns: ['selectionitem'],
  }));
  const result = compact(windowTree(items));
  assert.match(result.text, /\[w1\.2–w1\.5\] Dataitem ×4 "1月"…"4月"/);
  assert.equal(result.lines.filter((line) => line.includes('Dataitem')).length, 1);
});

test('a large grid collapses to a summary without cells', () => {
  const cells = [];
  for (let i = 0; i < 20; i += 1) {
    cells.push(node({ ref: `w1.${i + 3}`, role: 'dataitem', name: `R${i}`, depth: 2, parent: 'w1.2', patterns: ['selectionitem'] }));
  }
  const nodes = windowTree([
    node({ ref: 'w1.2', role: 'grid', name: 'A1:H240', depth: 1, parent: 'w1.1', patterns: ['grid'] }),
    ...cells,
  ]);
  const result = compact(nodes);
  assert.match(result.text, /Grid "A1:H240" {2}rows=20 grid/);
  assert.doesNotMatch(result.text, /R19/);
});

test('small tables still expand their cells', () => {
  const cells = [0, 1].map((i) => node({ ref: `w1.${i + 3}`, role: 'dataitem', name: `R${i}`, depth: 2, parent: 'w1.2', patterns: ['selectionitem'] }));
  const nodes = windowTree([
    node({ ref: 'w1.2', role: 'grid', name: 'A1:B2', depth: 1, parent: 'w1.1', patterns: ['grid'] }),
    ...cells,
  ]);
  const result = compact(nodes);
  assert.match(result.text, /Grid "A1:B2"/);
  assert.match(result.text, /\[w1\.3\] Dataitem "R0"/);
});

test('budget truncation keeps interactive controls and says so', () => {
  const nodes = windowTree([]);
  for (let i = 0; i < 80; i += 1) {
    nodes.push(node({
      ref: `w1.${i + 2}`,
      role: 'text',
      name: `这是一段很长的静态文本 ${i} 用于把预算撑爆`,
      depth: 1,
      parent: 'w1.1',
      patterns: [],
    }));
  }
  nodes.push(node({ ref: 'w1.999', role: 'button', name: '确定', depth: 1, parent: 'w1.1' }));
  const result = compact(nodes, { maxChars: 600 });
  assert.equal(result.truncated, true);
  assert.ok(result.chars <= 600, `chars ${result.chars}`);
  assert.match(result.text, /truncated/);
  assert.match(result.text, /Button "确定"/);
  assert.ok(result.kept < 81);
});

test('boxes option adds the physical rect', () => {
  const nodes = windowTree([
    node({ ref: 'w1.2', role: 'button', name: '确定', depth: 1, parent: 'w1.1', rect: [120, 240, 88, 32] }),
  ]);
  const result = compact(nodes, { boxes: true });
  assert.match(result.text, /Button "确定" @120,240 88x32/);
});

test('normalizeNodes derives stable keys in aid > role|name|class > path order', () => {
  const nodes = normalizeNodes(windowTree([
    node({ ref: 'w1.2', role: 'button', name: '确定', automationId: 'okBtn', depth: 1, parent: 'w1.1' }),
    node({ ref: 'w1.3', role: 'button', name: '取消', depth: 1, parent: 'w1.1' }),
    node({ ref: 'w1.4', role: 'pane', name: '', depth: 1, parent: 'w1.1', patterns: [] }),
  ]));
  assert.equal(nodes[1].stableKey, 'aid:okBtn');
  assert.equal(nodes[2].stableKey, 'button|取消|Qt51514QWindowIcon');
  assert.match(nodes[3].stableKey, /^path:/);
  assert.equal(nodes[3].weak, true);
  const tree = buildTree(nodes);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.childrenOf(tree.roots[0]).length, 3);
  assert.equal(tree.stats.total, 4);
});
