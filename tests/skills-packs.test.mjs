// electron/skills/packs/** 的清单级测试：manifest 合法性、全局命名唯一、core 集合与
// electron/mcp/tools.mjs 的 CORE_TOOL_NAMES 对齐、以及「缺依赖整包被裁 / 齐依赖全部生效」。
// 全部纯内存：fake deps 是普通对象，不碰文件系统、不碰 electron、不起网络。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE_TOOL_NAMES } from '../electron/mcp/tools.mjs';
import { SKILL_CALL_TOOL, SKILL_SEARCH_ALIAS, SKILL_SEARCH_TOOL } from '../electron/skills/adapters/mcp.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { assertValidManifest, validateManifest } from '../electron/skills/manifest-schema.mjs';
import { buildRegistry } from '../electron/skills/registry.mjs';
import {
  DEFAULT_PACKS, browserAutomationPack, contextLedgerPack, designCanvasPack,
  desktopControlPack, goalPlanPack, memoryPack, projectFsPack, webResearchPack,
} from '../electron/skills/packs/index.mjs';

function allTools() {
  return DEFAULT_PACKS.flatMap(pack => pack.manifest.tools.map(def => ({ pack: pack.manifest.id, def })));
}

/** 最小可用的宿主依赖包：每个 pack 声明的硬依赖都给一个能跑的对象。 */
function fullDeps() {
  const tool = name => ({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: name }) }] }),
  });
  const memorySearch = async () => [];
  memorySearch.readSource = async () => ({ ok: true, text: 'x' });
  return {
    projectTools: [tool('read_file'), tool('list_files'), tool('write_file'), tool('replace_in_file'), tool('run_command')],
    search: async () => [],
    memorySearch,
    memoryRuntime: { saveMemory: async input => ({ id: 'm1', ...input }) },
    contextTools: {
      definitions: [],
      handlers: {
        context_status: () => ({ content: [{ type: 'text', text: 'ok' }] }),
        context_compact: () => ({ content: [{ type: 'text', text: 'ok' }] }),
        context_read: () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    },
    // 三个「会动界面」的包：宿主给的是工具数组（浏览/桌面）或工厂（画板）。
    // 用各自 manifest 的 name 造一份最小可跑的工具，避免测试与真实工具体量绑死。
    browser: browserAutomationPack.manifest.tools.map(def => tool(def.name)),
    desktop: desktopControlPack.manifest.tools.map(def => tool(def.name)),
    designRuntime: { tools: () => designCanvasPack.manifest.tools.map(def => tool(def.name)) },
    sender: { id: 1 },
    conversationId: 'c1',
  };
}

test('8 个 pack 的 manifest 全部通过 assertValidManifest（含 examples / mcpSummary / schema 形状）', () => {
  assert.equal(DEFAULT_PACKS.length, 8, 'DEFAULT_PACKS 应当正好是这 8 个能力包');
  for (const pack of DEFAULT_PACKS) {
    assert.doesNotThrow(() => assertValidManifest(pack.manifest), `${pack.manifest.id} 的 manifest 不合法`);
    const result = validateManifest(pack.manifest);
    assert.deepEqual(result.errors, [], `${pack.manifest.id} 不应有任何校验错误`);
    assert.deepEqual(result.warnings, [], `${pack.manifest.id} 不应有未知字段告警`);
  }
});

test('pack id 唯一且是 kebab-case；每个 pack 都有 summary / capabilities / 七项 permissions', () => {
  const ids = DEFAULT_PACKS.map(pack => pack.manifest.id);
  assert.equal(new Set(ids).size, ids.length, `pack id 必须唯一：${ids.join(', ')}`);
  for (const pack of DEFAULT_PACKS) {
    assert.match(pack.manifest.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${pack.manifest.id} 必须是 kebab-case`);
    assert.equal(pack.manifest.apiVersion, 1);
    assert.equal(pack.manifest.version, '1.0.0');
    assert.ok(pack.manifest.summary.length > 8, 'summary 要是一句能读的中文摘要');
    assert.ok(pack.manifest.capabilities.every(bit => /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(bit)),
      `${pack.manifest.id} 的 capabilities 必须用点分语义位：${pack.manifest.capabilities.join(', ')}`);
    assert.deepEqual(
      Object.keys(pack.manifest.permissions).sort(),
      ['browser', 'canvas', 'desktop', 'exec', 'fs', 'memory', 'net'],
      `${pack.manifest.id} 的 permissions 必须七键齐全`,
    );
    assert.equal(typeof pack.createHandlers, 'function', `${pack.manifest.id} 必须导出 createHandlers`);
  }
});

test('工具名与暴露名全局唯一（name / mcpName / alias 共用一个命名空间）', () => {
  const seen = new Map();
  for (const { pack, def } of allTools()) {
    for (const name of [def.name, def.mcpName, ...(def.aliases ?? [])]) {
      const owner = seen.get(name);
      assert.equal(owner, undefined, `暴露名 ${name} 同时出现在 ${owner} 与 ${pack}`);
      seen.set(name, pack);
    }
  }
});

test('handler 侧不自己拼前缀：name 不以 mova_ 开头，mcpName 一律 mova_ 开头', () => {
  for (const { pack, def } of allTools()) {
    assert.ok(!def.name.startsWith('mova_'), `${pack}/${def.name} 的内部名不应带 mova_ 前缀（那是 mcpName 的事）`);
    assert.ok(def.mcpName.startsWith('mova_'), `${pack}/${def.name} 的 mcpName 必须以 mova_ 开头`);
  }
});

test('写/执行类工具一律 risk + approval:policy（不允许 approval.mode:none 混进来）', () => {
  for (const { pack, def } of allTools()) {
    if (def.risk !== 'write' && def.risk !== 'exec') continue;
    assert.equal(def.approval?.mode, 'policy', `${pack}/${def.name} 是 ${def.risk} 类，必须走审批闸门`);
    assert.equal(def.approval?.capability, def.risk, `${pack}/${def.name} 的能力位必须等于风险等级`);
    assert.equal(typeof def.approval?.allowSession, 'boolean', `${pack}/${def.name} 必须显式声明 allowSession`);
  }
});

test('core 集合与 CORE_TOOL_NAMES 对齐：11 个能力工具 + 适配器提供的 mova_tools_search', () => {
  const coreTools = allTools().filter(({ def }) => def.exposure.mcp === 'core');
  assert.equal(coreTools.length, 11, 'core 必须是 11 个能力工具（第 12 个是适配器的发现入口）');

  // CORE_TOOL_NAMES 的 12 项里，mova_tools_search 没有对应 handler，由 adapters/mcp.mjs 提供。
  assert.equal(CORE_TOOL_NAMES.length, 12);
  assert.ok(CORE_TOOL_NAMES.includes(SKILL_SEARCH_ALIAS), 'mova_tools_search 必须是发现入口的兼容别名');
  assert.equal(SKILL_SEARCH_ALIAS, 'mova_tools_search');
  const capabilityNames = CORE_TOOL_NAMES.filter(name => name !== SKILL_SEARCH_ALIAS);
  assert.equal(capabilityNames.length, 11, '去掉发现入口后应剩 11 个能力工具');

  // 正向：CORE_TOOL_NAMES 的每个能力名都能在 core 工具的「暴露名集合」里找到（含别名）。
  const reachable = new Set(coreTools.flatMap(({ def }) => [def.mcpName, ...(def.aliases ?? [])]));
  for (const name of capabilityNames) {
    assert.ok(reachable.has(name), `core 里缺少 ${name}：模型在 tools/list 里将看不到它`);
  }
  // 反向：每个 core 工具至少有一个暴露名在 CORE_TOOL_NAMES 里，没有多出来的 core 工具。
  for (const { pack, def } of coreTools) {
    const names = [def.mcpName, ...(def.aliases ?? [])];
    assert.ok(names.some(name => CORE_TOOL_NAMES.includes(name)),
      `${pack}/${def.name} 是 core，但 ${names.join(' / ')} 都不在 CORE_TOOL_NAMES 里`);
  }
});

test('mova_update_plan 以别名形式保留在 core 里，且解析到 set_plan', () => {
  const plan = goalPlanPack.manifest.tools.find(def => def.name === 'set_plan');
  assert.ok(plan, 'goal-plan 必须有 set_plan');
  assert.equal(plan.mcpName, 'mova_set_plan', '新名是 mova_set_plan');
  assert.deepEqual(plan.aliases, ['mova_update_plan'], '旧名 mova_update_plan 必须作为别名保留');
  assert.equal(plan.exposure.mcp, 'core');

  const registry = buildRegistry([goalPlanPack], {});
  assert.equal(registry.aliases.get('mova_update_plan'), 'set_plan', '别名必须解析回 set_plan');
  assert.equal(registry.aliases.get('mova_set_plan'), 'set_plan');
  assert.equal(registry.aliases.get('set_plan'), 'set_plan');
});

test('DEFAULT_PACKS 顺序稳定，且每一项都是 { manifest, createHandlers }', () => {
  assert.deepEqual(DEFAULT_PACKS.map(pack => pack.manifest.id), [
    'project-fs', 'goal-plan', 'web-research', 'memory', 'context-ledger',
    'browser-automation', 'design-canvas', 'desktop-control',
  ]);
  for (const pack of DEFAULT_PACKS) {
    assert.deepEqual(Object.keys(pack).sort(), ['createHandlers', 'manifest']);
  }
  assert.equal(projectFsPack.manifest.id, 'project-fs');
  assert.equal(goalPlanPack.manifest.id, 'goal-plan');
  assert.equal(webResearchPack.manifest.id, 'web-research');
  assert.equal(memoryPack.manifest.id, 'memory');
  assert.equal(contextLedgerPack.manifest.id, 'context-ledger');
  assert.equal(browserAutomationPack.manifest.id, 'browser-automation');
  assert.equal(designCanvasPack.manifest.id, 'design-canvas');
  assert.equal(desktopControlPack.manifest.id, 'desktop-control');
});

test('依赖齐全时 8 个 pack 全部进注册表；依赖全缺时全部按 missing_dependencies 被裁', () => {
  const loaded = buildRegistry(DEFAULT_PACKS, fullDeps());
  const loadedIds = loaded.packs.map(pack => pack.id).sort();
  assert.deepEqual(loadedIds, [
    'browser-automation', 'context-ledger', 'design-canvas', 'desktop-control',
    'goal-plan', 'memory', 'project-fs', 'web-research',
  ]);
  assert.deepEqual(loaded.skipped, [], '依赖齐全时不该有被跳过的包');

  const missing = buildRegistry(DEFAULT_PACKS, {});
  // goal-plan 是唯一没有硬依赖的包：没有 aim 也照样提供 4 个状态工具。
  assert.deepEqual([...missing.entries.keys()].sort(), ['accept_goal', 'set_goal', 'set_plan', 'update_goal']);
  const reasons = Object.fromEntries(missing.skipped.map(item => [item.pack, item]));
  assert.equal(reasons['project-fs'].reason, 'missing_dependencies');
  assert.deepEqual(reasons['project-fs'].missing, ['projectTools']);
  assert.deepEqual(reasons['web-research'].missing, ['search']);
  assert.deepEqual(reasons['memory'].missing, ['memorySearch']);
  assert.deepEqual(reasons['context-ledger'].missing, ['contextTools']);
  assert.deepEqual(reasons['browser-automation'].missing, ['browser']);
  assert.deepEqual(reasons['desktop-control'].missing, ['desktop']);
  assert.deepEqual(reasons['design-canvas'].missing, ['designRuntime', 'sender', 'conversationId']);
  // goal-plan 刻意不声明硬依赖：aim 在首轮就是 null，写进 dependencies 会让整包消失。
  assert.equal(reasons['goal-plan'], undefined, 'goal-plan 不应因缺 aim 被裁掉');
  assert.equal(missing.packs.map(pack => pack.id).includes('goal-plan'), true);
});

test('运行时能按 mcpName 解析到核心工具，并保留 mova_ 前缀的兼容解析', () => {
  const runtime = buildSkillRuntime({ packs: DEFAULT_PACKS, deps: fullDeps() });
  assert.ok(runtime.resolve('mova_read_file'), 'mova_read_file 必须能解析');
  assert.equal(runtime.resolve('mova_read_file').def.name, 'read_file');
  assert.ok(runtime.resolve('read_file'), '省前缀也要能解析');
  assert.equal(runtime.resolve('mova_update_plan').def.name, 'set_plan', '旧名解析到 set_plan');
  assert.ok(runtime.resolve('mova_set_goal'));
  assert.equal(runtime.resolve('mova_ask_user'), null, '没注入 asks/sender 时 ask_user 不该出现');
  for (const name of ['mova_read_file', 'mova_list_files', 'mova_write_file', 'mova_apply_patch', 'mova_web_search', 'mova_set_goal', 'mova_set_plan']) {
    assert.ok(runtime.resolve(name), `${name} 应当能在完整依赖下解析到实现`);
  }
  assert.ok(SKILL_CALL_TOOL === 'mova_skill_call');
  assert.ok(SKILL_SEARCH_TOOL === 'mova_skill_search');
});
