/**
 * 两条聊天链路的**技能运行时装配**测试（纯内存，零 Electron、零网络、零进程）。
 *
 * 为什么单独一个文件：Step 3 把 Gemini 侧的工具装配从手写 `buildMovaHandlers` 换成 `SkillRuntime`、
 * Step 6 又把 pi-ai 主循环的「文件 / 目标 / 记忆 / 上下文」也换过来之后，最大的风险不是「抛错」
 * 而是「静默少一个工具」——模型看不到 `web_read`，用户只会觉得模型变笨了。所以这里逐条钉住
 * 「缺哪个依赖 → 少的正好是哪个工具 + 发一条 notice」，以及 pi-ai 投影与 MCP 工具表同源。
 *
 * 依赖形状一律照 electron/skills/host-adapters.mjs 的契约造：
 *   approvals（broker.ask(sender, request, signal)）/ permissions（list()+check({rootId})）/ gate（resolveInRoots）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE_TOOL_NAMES } from '../electron/mcp/tools.mjs';
import { DEFAULT_PACKS } from '../electron/skills/packs/index.mjs';
import { toPiAiTools } from '../electron/skills/adapters/pi-ai.mjs';
import { createSkillRuntimeForTurn } from '../electron/skills/turn-runtime.mjs';
import { createBrowserToolsFactory } from '../electron/chat-agent.mjs';

/**
 * 按 pack 的 manifest 造一份「名字对得上」的最小工具数组：
 * 浏览/桌面包期望宿主给工具数组，画板包期望 `designRuntime.tools()`。
 * 这些包的具体行为由各自的 tests/skills-*-pack.test.mjs 覆盖，这里只保证「依赖齐全时不被裁」。
 */
function manifestTools(packId) {
  const pack = DEFAULT_PACKS.find(item => item.manifest.id === packId);
  return (pack?.manifest.tools ?? []).map(def => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: def.name }) }] }),
  }));
}

/** 当前工作目录当项目根：闸门是假的，不需要真磁盘。 */
const ROOT = Object.freeze({
  id: 'root-1',
  name: 'demo',
  path: process.cwd(),
  capabilities: Object.freeze({ read: true, write: true, exec: true }),
});

/** 假闸门：只证明「路径经过了校验」，越界与否不在本文件的范围（见 tests/skills-approval-integration）。 */
function fakeGate() {
  const calls = [];
  return {
    calls,
    gate: {
      async resolveInRoots(target, label) {
        calls.push({ target, label });
        return `${ROOT.path}/${String(target).replace(/^[./\\]+/, '')}`;
      },
    },
  };
}

/** 假能力位 store：真契约只认 rootId，路径反查在 createPermissionsAdapter 里。 */
function fakePermissionStore({ granted = true } = {}) {
  const checks = [];
  return {
    checks,
    store: {
      async list() { return { roots: [{ id: ROOT.id, path: ROOT.path }] }; },
      async check(input) { checks.push(input); return granted ? { ok: true } : { ok: false, reason: 'not-granted' }; },
      async authorize(input) { checks.push({ authorize: true, ...input }); return { ok: true, via: 'preset' }; },
    },
  };
}

/**
 * 假 `createProjectTools` 工厂：返回 agent-tools 那 15 个工具名。
 * 工厂形态是接线契约的一部分（每次调用新建一份，diff 才拿得到），所以这里记录每次的入参。
 */
function fakeProjectTools() {
  const names = [
    'read_file', 'list_files', 'write_file', 'search_files', 'project_tree', 'find_symbol',
    'git_status', 'git_diff', 'list_changes', 'replace_in_file', 'delete_path', 'move_path',
    'apply_changes', 'undo_change', 'run_command',
  ];
  const opened = [];
  const factory = ({ emit, callId } = {}) => {
    opened.push({ callId });
    return names.map(name => ({
      name,
      label: name,
      async execute() {
        emit?.({
          type: 'tool', id: callId ?? name, name, label: name, status: 'done',
          detail: `${name} 完成`,
          ...(name === 'write_file' ? { diff: { path: 'notes.md', before: 'old', after: 'new' } } : {}),
        });
        return { content: [{ type: 'text', text: `${name} ok` }] };
      },
    }));
  };
  return { factory, opened, names };
}

/** 假长期记忆检索（带 readSource 才有 memory_read_source）。 */
function fakeMemorySearch() {
  const search = async ({ query }) => [{ id: 'mem-1', text: `命中 ${query}` }];
  search.readSource = async ({ id }) => ({ ok: true, id, text: '原文' });
  return search;
}

function fakeSearchService() {
  return {
    async search({ queries }) {
      return { rows: [{ url: 'https://example.com/a', title: queries[0] }], evidence: [] };
    },
    async read() { return { url: 'https://example.com/a', title: '示例', text: '正文' }; },
    hasExtract() { return true; },
  };
}

function fakeSender() {
  return { id: 'win-1', isDestroyed: () => false, send() {} };
}

/** 一轮完整依赖：要什么有什么。`warnings` 收集装配期写下的日志（缺工具只写日志、不上屏）。 */
function fullDeps({ emit = () => {}, overrides = {} } = {}) {
  const { gate } = fakeGate();
  const { store } = fakePermissionStore();
  const projectTools = fakeProjectTools();
  const warnings = [];
  const deps = {
    approvals: { async ask() { return 'once'; } },
    permissions: store,
    gate,
    sender: fakeSender(),
    emit,
    projectRoots: [ROOT],
    roots: [ROOT.path],
    aim: { goal: { title: '把工具接线跑通', status: 'active' }, plan: { steps: [{ label: '装配', status: 'active' }] } },
    conversationId: 'conv-1',
    sessionKey: 'win-1:session',
    historyDir: null,
    temporary: false,
    search: async (key, query) => [{ url: 'https://example.com/a', title: query }],
    searchService: fakeSearchService(),
    searchOptions: { maxResults: 5 },
    searchKey: 'key-1',
    memorySearch: fakeMemorySearch(),
    memoryRuntime: { async saveMemory(input) { return { id: 'mem-2', kind: input?.kind ?? 'fact' }; } },
    contextTools: {
      handlers: {
        context_status: async () => ({ content: [{ type: 'text', text: '用量 1%' }] }),
        context_compact: async () => ({ content: [{ type: 'text', text: '已压缩' }] }),
        context_read: async () => ({ content: [{ type: 'text', text: '原文' }] }),
      },
    },
    projectTools: projectTools.factory,
    asks: { async ask() { return '用户回答'; } },
    // 三个「会动界面」的包：宿主注入形态分别是工具数组 / 工具数组 / 工具工厂。
    browser: manifestTools('browser-automation'),
    desktop: manifestTools('desktop-control'),
    designRuntime: { tools: () => manifestTools('design-canvas') },
    logger: { debug() {}, info() {}, warn: text => warnings.push(String(text)), error() {} },
  };
  return { deps: { ...deps, ...overrides }, projectTools, warnings };
}

function names(toolTable) {
  return toolTable.list().map(tool => tool.name);
}

function noticesOf(events) {
  return events.filter(event => event?.type === 'notice').map(event => event.text);
}

test('完整依赖：11 个核心能力工具 + 2 个元工具全部进 tools/list，且不发 notice', () => {
  const events = [];
  const { deps } = fullDeps({ emit: event => events.push(event) });
  const { runtime, toolTable } = createSkillRuntimeForTurn(deps);

  const listed = names(toolTable);
  assert.equal(listed.length, 13, `tools/list 应当正好 13 个（11 能力 + 2 元工具），实际：${listed.join(',')}`);
  for (const core of CORE_TOOL_NAMES) {
    assert.equal(toolTable.has(core), true, `核心工具 ${core} 必须在 tools/list 或别名解析里可达`);
  }
  // 旧名 mova_update_plan 必须仍然解析到 set_plan（模型的历史记忆里是这个名）。
  assert.equal(toolTable.has('mova_update_plan'), true, 'mova_update_plan 必须作为别名继续可用');
  assert.deepEqual(noticesOf(events), [], '依赖齐全时不该有「缺核心工具」的旁白');

  // runtime 侧的可观测事实：DEFAULT_PACKS 全部装载，没有包被跳过。
  assert.equal(runtime.packs.length, 8, `应当 8 个 pack 全部生效，实际：${runtime.packs.map(p => p.id).join(',')}`);
  assert.deepEqual(runtime.registry.skipped, [], '依赖齐全时不该有跳过的包');
});

test('diff 走「每次调用新建的工厂」：write_file 的变更卡来自 agent-tools 的 emit 事件', async () => {
  const events = [];
  const { deps, projectTools } = fullDeps({ emit: event => events.push(event) });
  const { runtime } = createSkillRuntimeForTurn(deps);

  const result = await runtime.invoke('write_file', { path: 'notes.md', content: 'new' });
  assert.equal(result.isError, undefined, `写文件应当被批准，实际：${result.content?.[0]?.text}`);
  // 工厂至少被调用两次：注册时的能力探测 + 这次真实调用。
  assert.ok(projectTools.opened.length >= 2, 'projectTools 必须是工厂（每次调用新建），不能复用同一份实例');
  const done = events.filter(event => event.type === 'tool' && event.status === 'done').pop();
  assert.ok(done, '应当收到一条 tool done 事件');
  assert.deepEqual(done.diff, { path: 'notes.md', before: 'old', after: 'new' }, 'diff 必须挂在 done 事件上（前端变更卡）');
});

test('去掉 search：少的正好是 mova_web_search / mova_web_read，只记日志不上屏', () => {
  const events = [];
  const { deps, warnings } = fullDeps({ emit: event => events.push(event), overrides: { search: null, searchService: null, searchKey: '' } });
  const { runtime, toolTable } = createSkillRuntimeForTurn(deps);

  assert.equal(toolTable.has('mova_web_search'), false);
  assert.equal(toolTable.has('mova_web_read'), false);
  // 其余核心工具一个都不能跟着消失。
  for (const name of CORE_TOOL_NAMES.filter(item => !['mova_web_search', 'mova_web_read'].includes(item))) {
    assert.equal(toolTable.has(name), true, `${name} 不该因为缺 search 而消失`);
  }
  // 用户明确要求「删掉那条提醒」：缺核心工具只在日志里留全文，时间线里一条都不出现。
  assert.deepEqual(noticesOf(events), [], '不该再有「本轮缺少 N 个核心工具」的旁白');
  const logged = warnings.find(text => /本轮缺少 2 个核心工具：mova_web_search、mova_web_read/.test(text));
  assert.ok(logged, `日志里必须留下完整原因，实际：${warnings.join(' | ')}`);
  assert.match(logged, /web-research/, '原因里要能看出是哪个包缺依赖');
  assert.equal(runtime.packs.some(pack => pack.id === 'web-research'), false);
});

test('去掉 memorySearch：少 mova_memory_search 与 mova_memory_write（写记忆也依赖检索能力）', () => {
  const events = [];
  const { deps, warnings } = fullDeps({ emit: event => events.push(event), overrides: { memorySearch: null } });
  const { toolTable } = createSkillRuntimeForTurn(deps);

  assert.equal(toolTable.has('mova_memory_search'), false);
  assert.equal(toolTable.has('mova_memory_write'), false);
  assert.equal(toolTable.has('mova_read_file'), true, '记忆包缺失不影响文件工具');
  assert.deepEqual(noticesOf(events), []);
  assert.ok(warnings.some(text => /本轮缺少 2 个核心工具：mova_memory_search、mova_memory_write/.test(text)));
});

test('去掉 memoryRuntime：只少 mova_memory_write（只读记忆仍然可用）', () => {
  const events = [];
  const { deps, warnings } = fullDeps({ emit: event => events.push(event), overrides: { memoryRuntime: null } });
  const { toolTable } = createSkillRuntimeForTurn(deps);

  assert.equal(toolTable.has('mova_memory_search'), true, '检索不依赖写入通道');
  assert.equal(toolTable.has('mova_memory_read_source'), true, 'memorySearch.readSource 在，回查工具就该在');
  assert.equal(toolTable.has('mova_memory_write'), false);
  assert.deepEqual(noticesOf(events), []);
  assert.ok(warnings.some(text => /本轮缺少 1 个核心工具：mova_memory_write/.test(text)));
});

test('去掉 aim：一个工具都不少，也不发 notice（首轮没有目标是正常状态）', () => {
  const events = [];
  const { deps } = fullDeps({ emit: event => events.push(event), overrides: { aim: null } });
  const { toolTable, runtime } = createSkillRuntimeForTurn(deps);

  assert.equal(names(toolTable).length, 13);
  for (const core of CORE_TOOL_NAMES) assert.equal(toolTable.has(core), true);
  assert.deepEqual(noticesOf(events), []);
  assert.equal(runtime.packs.some(pack => pack.id === 'goal-plan'), true, 'goal-plan 不依赖 aim，必须照常装载');
});

test('去掉 contextTools：只少 3 个 on_demand 上下文工具，核心工具一个不少、不发 notice', () => {
  const events = [];
  const { deps } = fullDeps({ emit: event => events.push(event), overrides: { contextTools: null } });
  const { toolTable, runtime } = createSkillRuntimeForTurn(deps);

  assert.equal(toolTable.has('mova_context_status'), false);
  assert.equal(names(toolTable).length, 13, '上下文工具不是 core，不占 tools/list');
  for (const core of CORE_TOOL_NAMES) assert.equal(toolTable.has(core), true);
  assert.deepEqual(noticesOf(events), [], 'on_demand 工具的缺失不该打扰用户');
  assert.deepEqual(
    runtime.listMissingDependencies().map(item => item.pack),
    ['context-ledger'],
    '缺 contextTools 只应跳过 context-ledger',
  );
});

test('去掉 asks：只少 mova_ask_user（目标/计划工具不受影响）', () => {
  const events = [];
  const { deps, warnings } = fullDeps({ emit: event => events.push(event), overrides: { asks: null } });
  const { toolTable } = createSkillRuntimeForTurn(deps);

  assert.equal(toolTable.has('mova_ask_user'), false);
  assert.equal(toolTable.has('mova_set_goal'), true);
  assert.equal(toolTable.has('mova_set_plan'), true);
  assert.deepEqual(noticesOf(events), []);
  assert.ok(warnings.some(text => /本轮缺少 1 个核心工具：mova_ask_user/.test(text)));
});

test('空 projectRoots：文件类工具整体消失（不静默放行，也不崩，且不上屏）', () => {
  const events = [];
  const { deps, warnings } = fullDeps({ emit: event => events.push(event), overrides: { projectRoots: [], roots: [], projectTools: null } });
  const { runtime, toolTable } = createSkillRuntimeForTurn(deps);

  for (const name of ['mova_read_file', 'mova_list_files', 'mova_write_file', 'mova_apply_patch']) {
    assert.equal(toolTable.has(name), false, `没有项目根时不该暴露 ${name}`);
  }
  for (const core of ['mova_set_goal', 'mova_web_search', 'mova_memory_search', 'mova_ask_user']) {
    assert.equal(toolTable.has(core), true, `非文件类核心工具 ${core} 不该被牵连`);
  }
  // 「没有项目文件夹」是正常状态：只在日志里记，不再打扰用户。
  assert.deepEqual(noticesOf(events), [], '没有项目文件夹不该弹「缺核心工具」');
  assert.ok(warnings.some(text => /本轮缺少 4 个核心工具/.test(text)));
  assert.equal(typeof runtime.invoke, 'function', '缺依赖也必须拿到可用的 runtime');
});

test('临时会话：文件工具照常加载，只有记忆工具消失', () => {
  // 用户口径：临时聊天也可以文件读写（只要权限开着），只是不加载记忆工具。
  // 记忆那侧靠 `memorySearch: null`（主进程对 temporary 请求不给检索闭包）实现，
  // 不是靠技能层的 allowTemporary 一刀切——project-fs 的 sessionPolicy 明确允许临时会话。
  const events = [];
  const { deps, warnings } = fullDeps({
    emit: event => events.push(event),
    overrides: { temporary: true, memorySearch: null, memoryRuntime: null },
  });
  const { runtime, toolTable } = createSkillRuntimeForTurn(deps);

  for (const name of ['mova_read_file', 'mova_list_files', 'mova_write_file', 'mova_apply_patch']) {
    assert.equal(toolTable.has(name), true, `临时会话必须仍有 ${name}`);
  }
  assert.equal(toolTable.has('mova_memory_search'), false, '临时会话不加载记忆检索');
  assert.equal(toolTable.has('mova_memory_write'), false, '临时会话不写记忆');
  assert.equal(runtime.packs.some(pack => pack.id === 'project-fs'), true, 'project-fs 不该因临时会话被跳过');
  assert.equal(runtime.packs.some(pack => pack.id === 'memory'), false, 'memory 包确实被跳过');
  assert.deepEqual(noticesOf(events), [], '这条路径也不许再弹提醒');
  assert.ok(warnings.length >= 1, '日志照旧留一条');
});

test('pi-ai 投影：完整依赖下每个核心工具都能按名字找到，且和 MCP 侧同一份定义', () => {
  const { deps } = fullDeps();
  const { runtime } = createSkillRuntimeForTurn(deps);
  const tools = toPiAiTools(runtime);
  const names = tools.map(tool => tool.name);

  for (const core of CORE_TOOL_NAMES) {
    // `mova_tools_search` 是 MCP 侧的元工具（由 toMcpToolTable 提供；pi-ai 用 mcp_search），不是技能。
    if (core === 'mova_tools_search') continue;
    const entry = runtime.resolve(core);
    assert.ok(entry, `核心工具 ${core} 必须能被运行时解析（别名也算）`);
    assert.equal(names.includes(entry.def.name), true,
      `核心工具 ${core} 必须以 ${entry.def.name} 出现在 pi-ai 工具表里（实际：${names.join(',')}）`);
  }
  // 投影只收 piAi 暴露位为 true 的工具：piAi:false 的定义一个都不能漏出来。
  for (const entry of runtime.listEntries()) {
    assert.equal(names.includes(entry.def.name), entry.def.exposure.piAi === true,
      `${entry.def.name} 的 pi-ai 可见性与 manifest 的 exposure.piAi 不一致`);
  }
});

test('browserOnly=true：空的项目工具工厂 → 文件类工具整体不出现在 pi-ai 工具表里', () => {
  const { deps } = fullDeps({ overrides: { projectRoots: [], roots: [], projectTools: null, browserOnly: true } });
  const { runtime } = createSkillRuntimeForTurn({ ...deps, reportMissingCore: false });
  const names = toPiAiTools(runtime).map(tool => tool.name);

  for (const name of ['read_file', 'list_files', 'write_file', 'apply_patch', 'run_command']) {
    assert.equal(names.includes(name), false, `Edge 会话不该暴露 ${name}`);
  }
  assert.equal(names.includes('set_goal'), true, '目标工具与项目文件夹无关，必须照常暴露');
});

test('pi-ai 投影把 signal 与 callId 原样交给 handler（长任务要能取消）', async () => {
  const { deps } = fullDeps();
  const { runtime } = createSkillRuntimeForTurn(deps);
  const tools = toPiAiTools(runtime);
  const controller = new AbortController();
  // 用一个假的记忆检索把 ctx 记下来：它是最不依赖宿主的一类工具。
  const seen = [];
  const probe = createSkillRuntimeForTurn({
    ...deps,
    memorySearch: async (input, signal) => {
      seen.push({ input, signal });
      return [];
    },
  });
  const memorySearch = toPiAiTools(probe.runtime).find(tool => tool.name === 'memory_search');
  assert.ok(memorySearch, 'memory_search 必须在 pi-ai 工具表里');
  await memorySearch.execute('call-42', { query: '参数' }, controller.signal);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, controller.signal, 'signal 必须透传到 handler，否则停止按钮管不到工具');
  assert.ok(tools.length > 0, '正常路径也装配成功');
});

test('audit：授权决策写进调用方注入的那一个 audit 实例（两条链路同源，不是每回合新建）', async () => {
  const entries = [];
  // permissions.cjs 的 createAuditLog 返回的就是这种 `(entry) => Promise<void>` 函数形态。
  const audit = async entry => entries.push(entry);
  const { deps } = fullDeps({ overrides: { audit } });
  const { runtime } = createSkillRuntimeForTurn(deps);

  const result = await runtime.invoke('write_file', { path: 'notes.md', content: 'x' });
  assert.equal(result.isError, undefined, `写文件应当被批准，实际：${result.content?.[0]?.text}`);
  assert.equal(entries.length >= 1, true, '授权决策必须落审计，否则「谁批准了这次写入」永远缺失');
  assert.equal(entries[0].action, 'skill/write_file');
  assert.equal(entries[0].decision, 'approved');
  assert.ok(entries[0].path, '审计里要有被批准的路径');
});

test('缺核心工具只写日志，时间线里一条旁白都没有', () => {
  const events = [];
  const { deps, warnings } = fullDeps({
    emit: event => events.push(event),
    overrides: { search: null, searchService: null, searchKey: '' },
  });
  createSkillRuntimeForTurn(deps);

  assert.deepEqual(noticesOf(events), [], '用户要求删掉的那条提醒不能再出现');
  assert.equal(
    warnings.some(text => /本轮缺少 2 个核心工具/.test(text)),
    true,
    `日志里必须保留完整原因，实际：${warnings.join(' | ')}`,
  );
});

// ── 内置浏览器（右侧浏览器视图）的依赖形态 ───────────────────────────────────
// 线上 P0：ACP 支路把**控制器对象** `{ tools() }` 直接塞进 `deps.browser`，而 pack 只认
// 「工具数组」或「工厂」，于是 `createHandlers()` 返回 `{}`——16 个 browser_* 工具一个都没注册。
// 它们全是 on_demand、不在 CORE_TOOL_NAMES 里，所以 `reportMissingCore` 也不会发言：
// 用户看到的就是「模型根本不知道自己有内置浏览器」。这两条用例把「必须转工厂」钉死。

/** 假浏览器控制器：真实形态是 `{ tools(options) => 工具数组 }`（electron/browser/controller.cjs）。 */
function fakeBrowserController() {
  const tools = manifestTools('browser-automation');
  const opened = [];
  return {
    tools,
    opened,
    controller: {
      tools(options = {}) {
        opened.push(options);
        return tools;
      },
    },
  };
}

test('deps.browser 收到控制器对象时一个浏览器工具都不注册（线上 P0 的形态，且完全静默）', () => {
  const { controller } = fakeBrowserController();
  const events = [];
  const { runtime, toolTable } = createSkillRuntimeForTurn(fullDeps({
    emit: event => events.push(event),
    overrides: { browser: controller },
  }).deps);

  assert.equal(toolTable.has('mova_browser_navigate'), false, '控制器对象直接注入：浏览器工具必须缺席');
  assert.equal(runtime.packs.some(pack => pack.id === 'browser-automation'), false, '整包不生效（没有任何工具同时具备定义与实现）');
  assert.equal(
    runtime.listMissingDependencies().some(item => item.pack === 'browser-automation'),
    false,
    '它不是「缺依赖」，所以连 listMissingDependencies 都看不见',
  );
  assert.deepEqual(noticesOf(events), [], '浏览器工具不是核心工具：一条 notice 都不会发（这就是「静默」的定义）');
});

test('createBrowserToolsFactory 转一层工厂后：16 个浏览器工具全部注册，且能被 mova_skill_search / 调用链命中', async () => {
  const { tools: browserTools, controller, opened } = fakeBrowserController();
  const browserNames = browserTools.map(tool => tool.name);
  const events = [];
  const { runtime, toolTable } = createSkillRuntimeForTurn(fullDeps({
    emit: event => events.push(event),
    overrides: { browser: createBrowserToolsFactory(controller, { emit: event => events.push(event) }) },
  }).deps);

  assert.equal(runtime.packs.some(pack => pack.id === 'browser-automation'), true, '工厂形态下整包必须生效');
  // 判「注册上」只认 has()：tools/list 只出核心集 + 2 个元工具（adapters/mcp.mjs），
  // 浏览器工具是 exposure.mcp:'on_demand'，按设计不进 tools/list。
  for (const name of browserNames) {
    assert.equal(toolTable.has(`mova_${name}`), true, `mova_${name} 必须注册上（工厂形态）`);
  }
  assert.equal(toolTable.has('mova_browser_navigate'), true, 'mova_browser_navigate 是用户那条报障里最关键的一个');

  const listed = toolTable.list().map(tool => tool.name);
  assert.equal(listed.includes('mova_browser_navigate'), false, 'on_demand 工具不进 tools/list（改 exposure 不在本次范围）');
  const discovered = toolTable.search('浏览器').map(tool => tool.name);
  assert.equal(discovered.includes('mova_browser_navigate'), true, '必须能被 mova_skill_search 查到，否则模型永远发现不了它');

  // mova_skill_call 的实际路径：授权通过 → handler 真的调到控制器给的 execute，并在时间线上出现工具行。
  const result = await runtime.invoke('mova_browser_navigate', { url: 'https://example.com/a' });
  assert.notEqual(result.isError, true, `浏览器工具应当能执行，实际：${result.content?.[0]?.text}`);
  assert.equal(
    events.some(event => event.type === 'tool' && event.name === 'browser_navigate'),
    true,
    '时间线上必须出现 browser_navigate 那一行（否则用户看不到它真的动了浏览器）',
  );
  assert.equal(opened.length >= 1, true, '控制器对象必须被调用过（探测一次 + 真正调用一次）');
});

test('浏览器工厂：openTools 给的 emit 原样透传给控制器，没给时退回本轮 emit（子工具事件不丢）', () => {
  const { tools: browserTools, controller, opened } = fakeBrowserController();
  const outerEmit = () => {};
  const timing = { span() {} };
  const approve = async () => 'once';
  const factory = createBrowserToolsFactory(controller, { emit: outerEmit, approve, timing });

  assert.equal(typeof factory, 'function', '控制器对象必须转成工厂');
  const innerEmit = () => {};
  const listed = factory({ callId: 'call-1', signal: undefined, emit: innerEmit });
  assert.equal(listed.length, browserTools.length, '工厂必须原样返回控制器给的 16 个工具');
  const last = opened.at(-1);
  assert.equal(last.emit, innerEmit, 'per-call emit 必须原样进控制器（子工具事件挂在本次 callId 上）');
  assert.equal(last.approve, approve, '审批闭包必须进控制器（否则站点风险动作一律 approval-unavailable）');
  assert.equal(last.timing, timing, 'timing 账本必须进控制器（审批/接管等待要计入本轮耗时）');

  factory();
  assert.equal(opened.at(-1).emit, outerEmit, '没有 per-call emit 时退回本轮 emit，绝不让事件静默消失');

  // 形态判断：数组 / 工厂原样透传；认不出的对象返回 null（让 registry 按缺依赖整包跳过，而不是假装有浏览器）。
  assert.equal(createBrowserToolsFactory(browserTools), browserTools);
  const asFactory = () => browserTools;
  assert.equal(createBrowserToolsFactory(asFactory), asFactory);
  assert.equal(createBrowserToolsFactory({}), null);
  assert.equal(createBrowserToolsFactory(null), null);
});
