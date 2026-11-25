/**
 * 按场景置顶工具（方案 §3.1 的 P0）单元测试：`pickPinnedTools` / `toMcpToolTable({ pinned })` /
 * `pinnedSkillsFor` 三件套 + `createSkillRuntimeForTurn` 的接线。
 *
 * 纯内存：pack 是字面量 + async handler，不碰 Electron / 网络 / 磁盘。
 *
 * 钉住的三条纪律：
 * 1) 置顶只按「依赖存在」判定，且**不去猜用户意图**（映射只有一处：turn-runtime 的 pinnedSkillsFor）；
 * 2) `tools/list` 顺序 = core → pinned → 元工具，core 的稳定前缀不许被置顶打乱；
 * 3) **总数硬上限 20**（13 个既有条目 + 最多 7 个置顶），且没有置顶时 list() 与改造前逐字一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_LIST_TOOLS, MAX_PINNED_PER_PACK, MAX_PINNED_TOOLS, pickPinnedTools, toMcpToolTable,
} from '../electron/skills/adapters/mcp.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { DEFAULT_PACKS } from '../electron/skills/packs/index.mjs';
import { createSkillRuntimeForTurn, pinnedSkillsFor } from '../electron/skills/turn-runtime.mjs';

function tool(name, { exposure = { piAi: true, mcp: 'on_demand' } } = {}) {
  return {
    name,
    label: `${name} 展示名`,
    description: `Do ${name}.`,
    mcpSummary: `${name} 一行摘要。`,
    risk: 'read',
    approval: { mode: 'policy' },
    exposure,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    examples: [{ title: '示例', arguments: { text: 'hi' } }],
  };
}

function pack(id, tools) {
  return {
    manifest: {
      apiVersion: 1,
      id,
      version: '1.0.0',
      title: `${id} 展示名`,
      summary: `${id} 一行摘要。`,
      capabilities: ['demo.capability'],
      dependencies: [],
      permissions: { fs: 'none', exec: false, net: false, desktop: false, browser: false, canvas: true, memory: 'none' },
      deprecation: null,
      tools,
    },
    createHandlers: () => Object.fromEntries(tools.map(item => [item.name, async () => 'ok'])),
  };
}

const CORE_TOOLS = Array.from({ length: 11 }, (_, index) => tool(`core_${index}`, { exposure: { piAi: true, mcp: 'core' } }));

const PACKS = [
  pack('core-pack', CORE_TOOLS),
  pack('browser-automation', [
    tool('browser_navigate'), tool('browser_snapshot'), tool('browser_read'),
    tool('browser_wait'), tool('browser_act'),
  ]),
  pack('design-canvas', [
    tool('design_open'), tool('design_read'), tool('design_apply'), tool('design_undo'),
  ]),
  pack('desktop-control', [
    tool('desktop_windows'), tool('desktop_snapshot'), tool('desktop_act'),
  ]),
  pack('tiny-pack', [tool('tiny_first'), tool('tiny_second')]),
  // exposure.mcp:'off'：MCP 边界上不存在，置顶也不能把它捞出来。
  pack('hidden-pack', [tool('internal_only', { exposure: { piAi: false, mcp: 'off' } })]),
];

function makeRuntime() {
  return buildSkillRuntime({ packs: PACKS, deps: {} });
}

const namesOf = rows => rows.map(row => row.name);

test('pickPinnedTools 按包取声明顺序的前 3 个（导航 → 快照 → 正文这一组才有用）', () => {
  const pinned = pickPinnedTools(makeRuntime(), { pinnedPacks: ['browser-automation'] });
  assert.deepEqual(namesOf(pinned), ['mova_browser_navigate', 'mova_browser_snapshot', 'mova_browser_read']);
  assert.equal(pinned.length, MAX_PINNED_PER_PACK, '单包上限就是 3 个');
  for (const row of pinned) {
    assert.deepEqual(Object.keys(row).sort(), ['description', 'inputSchema', 'name'], '必须与 core 描述符同形');
    assert.equal(row.inputSchema.additionalProperties, false);
  }
});

test('包内工具不足 3 个时按实际数量置顶（不补、不造）', () => {
  assert.deepEqual(
    namesOf(pickPinnedTools(makeRuntime(), { pinnedPacks: ['tiny-pack'] })),
    ['mova_tiny_first', 'mova_tiny_second'],
  );
});

test('未知 pack / 空项 / 非字符串项一律跳过，不抛错', () => {
  const runtime = makeRuntime();
  assert.deepEqual(pickPinnedTools(runtime, { pinnedPacks: ['no-such-pack'] }), []);
  assert.deepEqual(pickPinnedTools(runtime, { pinnedPacks: ['', null, 42, undefined] }), []);
  assert.deepEqual(pickPinnedTools(runtime, {}), []);
  assert.deepEqual(pickPinnedTools(runtime), []);
});

test('置顶工具名（而不是包）时只置顶那一个，顺序就是调用方给的顺序', () => {
  const pinned = pickPinnedTools(makeRuntime(), { pinnedPacks: ['design_undo', 'mova_desktop_snapshot'] });
  assert.deepEqual(namesOf(pinned), ['mova_design_undo', 'mova_desktop_snapshot']);
});

test('exposure.mcp:off 的工具不会被置顶（置顶不是绕过 exposure 的后门）', () => {
  const runtime = makeRuntime();
  assert.deepEqual(pickPinnedTools(runtime, { pinnedPacks: ['hidden-pack'] }), []);
  assert.deepEqual(pickPinnedTools(runtime, { pinnedPacks: ['internal_only', 'mova_internal_only'] }), []);
});

test('pinned 总条数硬上限 7：超出的按优先级从尾部截断', () => {
  const requested = [
    'browser-automation', 'design-canvas', 'desktop-control', // 3+3+3 = 9
  ];
  const pinned = pickPinnedTools(makeRuntime(), { pinnedPacks: requested });
  assert.equal(pinned.length, MAX_PINNED_TOOLS);
  assert.deepEqual(namesOf(pinned), [
    'mova_browser_navigate', 'mova_browser_snapshot', 'mova_browser_read',
    'mova_design_open', 'mova_design_read', 'mova_design_apply',
    'mova_desktop_windows',
  ], '优先级 = 调用方给的顺序，截断只砍尾部');
});

test('tools/list 顺序：core → pinned → 元工具，总数 ≤ 20，且 core 的稳定前缀不被插队', () => {
  const runtime = makeRuntime();
  const pinned = pickPinnedTools(runtime, { pinnedPacks: ['browser-automation', 'design-canvas', 'desktop-control'] });
  const table = toMcpToolTable(runtime, { pinned });
  const listed = namesOf(table.list());

  assert.ok(listed.length <= MAX_LIST_TOOLS, `tools/list 不得超过 ${MAX_LIST_TOOLS} 条，实际 ${listed.length}`);
  assert.equal(listed.length, 11 + MAX_PINNED_TOOLS + 2, '11 个 core + 7 个置顶 + 2 个元工具');

  const core = listed.slice(0, 11);
  assert.deepEqual(core, CORE_TOOLS.map(row => `mova_${row.name}`), 'core 段必须是 manifest 声明顺序，逐字稳定');
  assert.deepEqual(listed.slice(11, 18), namesOf(pinned), 'pinned 追加在 core 之后');
  assert.deepEqual(listed.slice(-2), ['mova_skill_search', 'mova_skill_call'], '元工具永远在最后');
});

test('置顶与 core / 元工具重名时去重（同一个工具不能在 tools/list 出现两次）', () => {
  const runtime = makeRuntime();
  const pinned = pickPinnedTools(runtime, { pinnedPacks: ['core_0', 'tiny_first'] });
  const listed = namesOf(toMcpToolTable(runtime, { pinned }).list());
  assert.equal(listed.filter(name => name === 'mova_core_0').length, 1, 'core 工具不能再被置顶一次');
  assert.equal(listed.length, 11 + 1 + 2, '只有 tiny_first 真的加了进去');
  assert.equal(listed[11], 'mova_tiny_first', '新置顶项仍然插在 core 之后、元工具之前');
});

test('未传 pinned / 传空数组时 list() 与改造前逐字一致（顺序、内容、条数都不变）', () => {
  const runtime = makeRuntime();
  const withoutOption = toMcpToolTable(runtime).list();
  const withEmpty = toMcpToolTable(runtime, { pinned: [] }).list();

  assert.equal(JSON.stringify(withEmpty), JSON.stringify(withoutOption), '空置顶必须等于不传置顶');
  assert.deepEqual(namesOf(withoutOption), [
    ...CORE_TOOLS.map(row => `mova_${row.name}`), 'mova_skill_search', 'mova_skill_call',
  ], '没有置顶时 tools/list 就是「core + 2 个元工具」');
  for (const row of withoutOption) {
    assert.deepEqual(Object.keys(row).sort(), ['description', 'inputSchema', 'name']);
  }
});

test('传入无法解析的 pinned 时静默丢弃（不崩、不改变条数）', () => {
  const runtime = makeRuntime();
  const table = toMcpToolTable(runtime, { pinned: [{ name: 'mova_does_not_exist' }, { name: 'internal_only' }, {}] });
  assert.deepEqual(namesOf(table.list()), [...CORE_TOOLS.map(row => `mova_${row.name}`), 'mova_skill_search', 'mova_skill_call']);
});

// ── 生产接线：依赖 → 置顶工具的映射只有一处（turn-runtime 的 pinnedSkillsFor）──────────

test('pinnedSkillsFor 只按依赖是否存在决定置顶哪一组（浏览器 → 画板 → 桌面）', () => {
  assert.deepEqual(pinnedSkillsFor({ browser: { kind: 'controller' } }), [
    'browser_navigate', 'browser_snapshot', 'browser_read',
  ]);
  assert.deepEqual(pinnedSkillsFor({ designRuntime: { tools() {} } }), [
    'design_open', 'design_read', 'design_apply',
  ]);
  assert.deepEqual(pinnedSkillsFor({ desktop: { kind: 'engine' } }), [
    'desktop_snapshot', 'desktop_act', 'desktop_screenshot',
  ]);
  assert.deepEqual(pinnedSkillsFor({ browser: null, designRuntime: null, desktop: null }), [], '没有依赖就一个都不置顶');
  assert.deepEqual(pinnedSkillsFor(), []);
  assert.equal(
    pinnedSkillsFor({ browser: {}, designRuntime: {}, desktop: {} }).length,
    9,
    '三组同时命中时给 9 个，实际条数由 pickPinnedTools 截到 7',
  );
});

/** 按真实 manifest 造一份「名字对得上」的浏览器工具数组（浏览器包接受数组或工厂）。 */
function browserToolsFromManifest() {
  const browserPack = DEFAULT_PACKS.find(item => item.manifest.id === 'browser-automation');
  return browserPack.manifest.tools.map(def => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  }));
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('turn-runtime 接线：给了 browser 依赖才置顶，且 tools/list 总数仍 ≤ 20', () => {
  const browser = browserToolsFromManifest();
  const pinnedSkills = pinnedSkillsFor({ browser });
  const { toolTable } = createSkillRuntimeForTurn({
    browser, pinnedSkills, reportMissingCore: false, logger: silentLogger,
  });
  const listed = namesOf(toolTable.list());

  assert.ok(listed.length <= MAX_LIST_TOOLS, `总数不得超过 ${MAX_LIST_TOOLS}，实际 ${listed.length}`);
  assert.deepEqual(
    listed.filter(name => name.startsWith('mova_browser_')),
    ['mova_browser_navigate', 'mova_browser_snapshot', 'mova_browser_read'],
    '置顶的正好是这三个（其余浏览器工具仍然按需发现）',
  );
  assert.equal(toolTable.has('mova_browser_batch'), true, '没置顶不等于不可用：仍可经 mova_skill_call 调用');
  assert.equal(listed.includes('mova_browser_batch'), false);
});

test('没有对应依赖时 pinnedSkills 为空，tools/list 与「完全没接置顶」逐字一致', () => {
  const browser = browserToolsFromManifest();
  const unplugged = createSkillRuntimeForTurn({
    browser, reportMissingCore: false, logger: silentLogger,
  }).toolTable.list();
  const explicitlyEmpty = createSkillRuntimeForTurn({
    browser, pinnedSkills: pinnedSkillsFor({ browser: null, designRuntime: null, desktop: null }),
    reportMissingCore: false, logger: silentLogger,
  }).toolTable.list();

  assert.equal(JSON.stringify(explicitlyEmpty), JSON.stringify(unplugged), '空的 pinnedSkills 不能改变一个字节');
  assert.equal(unplugged.some(row => row.name.startsWith('mova_browser_')), false, '浏览器工具默认仍然不直出');
});
