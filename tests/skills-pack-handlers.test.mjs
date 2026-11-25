// electron/skills/packs/**/handlers.mjs 的行为测试：依赖齐全 / 依赖缺失、参数非法、
// 以及「写类 handler 在 ctx.authorize() 拒绝时零副作用」。
// 全部纯内存 fake：没有真实网络、没有真实文件写入、没有 electron。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHandlers as createContextLedgerHandlers } from '../electron/skills/packs/context-ledger/handlers.mjs';
import { createHandlers as createGoalPlanHandlers } from '../electron/skills/packs/goal-plan/handlers.mjs';
import { createHandlers as createMemoryHandlers } from '../electron/skills/packs/memory/handlers.mjs';
import { createHandlers as createProjectFsHandlers } from '../electron/skills/packs/project-fs/handlers.mjs';
import { createHandlers as createWebResearchHandlers } from '../electron/skills/packs/web-research/handlers.mjs';

/* ── 共用工具 ───────────────────────────────────────────────────────── */

function textOf(result) {
  const part = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text') : null;
  return typeof part?.text === 'string' ? part.text : '';
}

/** 错误结果的唯一形状：`{ "error": code, "message": ... }`（与 mcp/normalize.mjs 一致）。 */
function errorOf(result) {
  const text = textOf(result);
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload.error === 'string' ? payload : null;
  } catch {
    return null;
  }
}

function collector() {
  const events = [];
  return { events, emit: event => events.push(event) };
}

/** 授权被拒：并记录调用次数，用来证明 handler 真的走了闸门。 */
function denyAuthorize(code = 'approval_denied') {
  const calls = [];
  return {
    calls,
    authorize: async (def, args) => {
      calls.push(args);
      return { allowed: false, code, reason: '用户拒绝了这次操作' };
    },
  };
}

function allowAuthorize() {
  const calls = [];
  return {
    calls,
    authorize: async (def, args) => {
      calls.push(args);
      return { allowed: true };
    },
  };
}

/**
 * 记录**第三参**（`ctx.authorize(def, args, options)`）：审批卡的变更预览只能从这里交出去，
 * handler 不许自己弹卡（否则就是双弹卡，见 electron/chat-agent.mjs 的 `approvalPreset:'full'`）。
 */
function allowAuthorizeWithOptions() {
  const calls = [];
  return {
    calls,
    authorize: async (def, args, options) => {
      calls.push({ def, args, options });
      return { allowed: true };
    },
  };
}

/* ── project-fs ────────────────────────────────────────────────────── */

function readOnlyTool(name, { calls, result } = {}) {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(id, args) {
      if (calls) calls.push({ name, id, args });
      return result ?? { content: [{ type: 'text', text: JSON.stringify({ ok: name, path: args?.path ?? null }) }] };
    },
  };
}

/** 工厂形态（带 emit）：write_file 的 diff 只能从这个事件里拿到。 */
function projectToolsWithEvents({ writes }) {
  return ({ emit }) => [
    {
      name: 'write_file',
      label: '写入文件',
      description: 'write_file',
      parameters: {},
      async execute(id, args) {
        writes.push({ tool: 'write_file', args });
        emit({
          type: 'tool',
          id,
          name: 'write_file',
          label: '写入文件',
          status: 'done',
          detail: `${args.path} · ${args.content.length} 字节`,
          diff: { kind: 'write', path: args.path, before: '旧内容', after: args.content },
        });
        return { content: [{ type: 'text', text: JSON.stringify({ path: args.path }) }] };
      },
    },
    {
      name: 'replace_in_file',
      label: '修改文件',
      description: 'replace_in_file',
      parameters: {},
      async execute(id, args) {
        writes.push({ tool: 'replace_in_file', args });
        emit({
          type: 'tool', id, name: 'replace_in_file', label: '修改文件', status: 'done',
          detail: `${args.path} · 1 处`, diff: { kind: 'replace', path: args.path, before: args.oldText, after: args.newText },
        });
        return { content: [{ type: 'text', text: JSON.stringify({ path: args.path }) }] };
      },
    },
    readOnlyTool('read_file'),
    readOnlyTool('run_command'),
  ];
}

test('project-fs：没有注入 projectTools（或注入空表）时什么都不暴露', () => {
  assert.deepEqual(createProjectFsHandlers({}), {});
  assert.deepEqual(createProjectFsHandlers({ projectTools: null }), {});
  assert.deepEqual(createProjectFsHandlers({ projectTools: false }), {});
  assert.deepEqual(createProjectFsHandlers({ projectTools: [] }), {});
});

test('project-fs：数组形态只暴露真实存在的工具，只读工具不申请授权', async () => {
  const calls = [];
  const deny = denyAuthorize();
  const handlers = createProjectFsHandlers({ projectTools: [readOnlyTool('read_file', { calls }), readOnlyTool('list_files', { calls })] });
  assert.deepEqual(Object.keys(handlers).sort(), ['list_files', 'read_file']);
  const result = await handlers.read_file({ path: 'package.json' }, { callId: 'mcp-1', authorize: deny.authorize });
  assert.equal(errorOf(result), null, '正常读取不该是错误结果');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: 'package.json' });
  assert.equal(deny.calls.length, 0, '只读工具不走人工审批闸门');
});

test('project-fs：write_file 拿到授权后落盘，并把 diff 以 {path,before,after} 返回', async () => {
  const writes = [];
  const allow = allowAuthorize();
  const box = collector();
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });
  const result = await handlers.write_file(
    { path: 'src/a.js', content: '新内容\n' },
    { callId: 'mcp-7', emit: box.emit, authorize: allow.authorize },
  );
  assert.equal(errorOf(result), null);
  assert.equal(writes.length, 1, '授权通过后必须真的调用写函数');
  assert.deepEqual(allow.calls, [{ path: 'src/a.js', content: '新内容\n' }], '授权请求要带上真实参数（含路径）');
  assert.deepEqual(result.diff, { path: 'src/a.js', before: '旧内容', after: '新内容\n' }, 'write_file 必须回传 diff');
  assert.ok(box.events.some(event => event.type === 'tool' && event.id === 'mcp-7' && event.diff), '工具事件要挂到同一 callId 上');
});

test('project-fs：ctx.authorize() 拒绝时零副作用，并给出拒绝码', async () => {
  const writes = [];
  const deny = denyAuthorize();
  const box = collector();
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });
  const result = await handlers.write_file(
    { path: 'src/a.js', content: 'x' },
    { callId: 'mcp-8', emit: box.emit, authorize: deny.authorize },
  );
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).error, 'approval_denied');
  assert.deepEqual(writes, [], '拒绝后绝不能调用写函数（先问再写）');
  assert.ok(box.events.some(event => event.type === 'notice' && /拒绝/.test(event.text)), '拒绝要留一条旁白给用户看');
});

test('project-fs：没有 ctx.authorize 时按最保守策略拒绝，绝不静默放行', async () => {
  const writes = [];
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });
  const result = await handlers.write_file({ path: 'a.js', content: 'x' }, { callId: 'mcp-9' });
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).error, 'permission_unavailable');
  assert.deepEqual(writes, []);
});

test('project-fs：参数非法时返回 invalid_arguments 且不落盘', async () => {
  const writes = [];
  const deny = denyAuthorize();
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });

  const missingContent = await handlers.write_file({ path: 'a.js' }, { authorize: deny.authorize });
  assert.equal(missingContent.isError, true);
  assert.equal(errorOf(missingContent).error, 'invalid_arguments');

  const longPath = await handlers.write_file({ path: 'a'.repeat(401), content: '' }, { authorize: deny.authorize });
  assert.equal(errorOf(longPath).error, 'invalid_arguments');

  const wrongType = await handlers.write_file({ path: 'a.js', content: 42 }, { authorize: deny.authorize });
  assert.equal(errorOf(wrongType).error, 'invalid_arguments');

  assert.deepEqual(writes, [], '参数不合法时绝不能调用写函数');
  assert.equal(deny.calls.length, 0, '参数不合法时不该浪费一次审批');
});

test('project-fs：run_command 是 exec 类，必须过闸门，且 command/argv 互斥', async () => {
  const calls = [];
  const allow = allowAuthorize();
  const handlers = createProjectFsHandlers({ projectTools: [readOnlyTool('run_command', { calls })] });

  const both = await handlers.run_command({ command: 'ls', argv: ['ls'] }, { authorize: allow.authorize });
  assert.equal(errorOf(both).error, 'invalid_arguments');
  assert.equal(calls.length, 0);

  const neither = await handlers.run_command({}, { authorize: allow.authorize });
  assert.equal(errorOf(neither).error, 'invalid_arguments');

  const ok = await handlers.run_command({ command: 'node --version' }, { callId: 'mcp-3', authorize: allow.authorize });
  assert.equal(errorOf(ok), null);
  assert.equal(calls.length, 1, '拿到授权后才执行命令');
  assert.deepEqual(allow.calls, [{ command: 'node --version' }]);
});

test('project-fs：apply_patch 把统一 diff 拆成 hunk 后逐个委托 replace_in_file', async () => {
  const writes = [];
  const allow = allowAuthorize();
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });
  const patch = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-const a = 1;',
    '+const a = 2;',
    '@@ -8,2 +8,2 @@',
    '-const b = 3;',
    '+const b = 4;',
  ].join('\n');
  const result = await handlers.apply_patch({ path: 'src/a.ts', patch }, { callId: 'mcp-4', authorize: allow.authorize });
  assert.equal(errorOf(result), null);
  assert.equal(allow.calls.length, 1, '一次补丁只问一次审批');
  assert.equal(writes.length, 2, '两个 hunk 各自委托一次 replace_in_file');
  assert.deepEqual(writes.map(item => item.tool), ['replace_in_file', 'replace_in_file']);
  assert.deepEqual(writes[0].args, { path: 'src/a.ts', oldText: 'const a = 1;', newText: 'const a = 2;' });
  assert.deepEqual(writes[1].args, { path: 'src/a.ts', oldText: 'const b = 3;', newText: 'const b = 4;' });
  assert.deepEqual(result.diff, { path: 'src/a.ts', before: 'const b = 3;', after: 'const b = 4;' }, '最后一个 hunk 的 diff 透传');
});

test('project-fs：apply_patch 支持 oldText/newText 精确替换，并在补丁畸形时报 invalid_arguments', async () => {
  const writes = [];
  const allow = allowAuthorize();
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });

  const exact = await handlers.apply_patch(
    { path: 'src/a.ts', oldText: 'x = 1', newText: 'x = 2' },
    { callId: 'mcp-5', authorize: allow.authorize },
  );
  assert.equal(errorOf(exact), null);
  assert.deepEqual(writes[0].args, { path: 'src/a.ts', oldText: 'x = 1', newText: 'x = 2' });

  writes.length = 0;
  const noHunk = await handlers.apply_patch({ path: 'src/a.ts', patch: 'just some text' }, { authorize: allow.authorize });
  assert.equal(errorOf(noHunk).error, 'invalid_arguments');

  const onlyAdds = await handlers.apply_patch({ path: 'src/a.ts', patch: '@@ -1,0 +1,1 @@\n+new line' }, { authorize: allow.authorize });
  assert.equal(errorOf(onlyAdds).error, 'invalid_arguments', '纯新增的 hunk 没有定位锚点，应拒绝并提示改用 write_file');

  const neither = await handlers.apply_patch({ path: 'src/a.ts' }, { authorize: allow.authorize });
  assert.equal(errorOf(neither).error, 'invalid_arguments');
  assert.deepEqual(writes, []);
});

test('project-fs：写类工具在授权时把变更预览交给 ctx.authorize（审批卡要能看见改什么）', async () => {
  const writes = [];
  const allow = allowAuthorizeWithOptions();
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });

  await handlers.write_file({ path: 'src/a.js', content: '新内容\n' }, { callId: 'mcp-10', authorize: allow.authorize });
  const writeOptions = allow.calls[0].options;
  assert.equal(
    typeof writeOptions?.preview, 'function',
    'write_file 的 before 要读盘，而绝对路径只有闸门知道：所以交的是 ({ path }) => 预览 的延迟构造器',
  );

  await handlers.replace_in_file(
    { path: 'src/a.js', oldText: '旧片段', newText: '新片段' },
    { callId: 'mcp-11', authorize: allow.authorize },
  );
  assert.deepEqual(
    allow.calls[1].options.preview,
    { kind: 'replace', path: 'src/a.js', before: '旧片段', after: '新片段' },
    'replace_in_file 复用 agent-tools 的预览结构（被替换片段 → 新片段，不读整份文件）',
  );

  await handlers.apply_patch(
    {
      path: 'src/a.ts',
      patch: '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n@@ -8,2 +8,2 @@\n-const b = 3;\n+const b = 4;',
    },
    { callId: 'mcp-12', authorize: allow.authorize },
  );
  assert.deepEqual(
    allow.calls[2].options.preview,
    { kind: 'replace', path: 'src/a.ts', before: 'const a = 1;\nconst b = 3;', after: 'const a = 2;\nconst b = 4;' },
    'apply_patch 的预览按 hunk 顺序拼删/加的行，与它逐个委托 replace_in_file 的执行方式同源',
  );

  const runAllow = allowAuthorizeWithOptions();
  await handlers.run_command({ command: 'node --version' }, { callId: 'mcp-13', authorize: runAllow.authorize });
  assert.equal(runAllow.calls[0].options.preview, undefined, 'run_command 不是文件变更：不该硬造一个预览');
});

test('project-fs：apply_patch 被拒时零副作用（hunk 一个都不执行）', async () => {
  const writes = [];
  const deny = denyAuthorize();
  const handlers = createProjectFsHandlers({ projectTools: projectToolsWithEvents({ writes }) });
  const result = await handlers.apply_patch(
    { path: 'src/a.ts', patch: '@@ -1,1 +1,1 @@\n-a\n+b' },
    { callId: 'mcp-6', authorize: deny.authorize },
  );
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).error, 'approval_denied');
  assert.deepEqual(writes, []);
});

test('project-fs：工具执行抛错时收敛成 isError，绝不向上抛', async () => {
  const handlers = createProjectFsHandlers({
    projectTools: [{
      name: 'read_file',
      label: '读取文件',
      description: 'read_file',
      parameters: {},
      async execute() { throw Object.assign(new Error('磁盘炸了'), { code: 'io_error' }); },
    }],
  });
  const result = await handlers.read_file({ path: 'a.js' }, { callId: 'mcp-1' });
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).error, 'io_error');
});

/* ── goal-plan ────────────────────────────────────────────────────── */

test('goal-plan：没有 aim 也提供 4 个状态工具，但 update_goal 会明确说「没有目标」', async () => {
  const handlers = createGoalPlanHandlers({});
  assert.deepEqual(Object.keys(handlers).sort(), ['accept_goal', 'set_goal', 'set_plan', 'update_goal']);
  const result = await handlers.update_goal({ status: 'done' }, {});
  assert.equal(result.isError, true, '没有目标时改状态必须是错误结果');
  assert.match(textOf(result), /set_goal/);
});

test('goal-plan：状态从 deps.aim 继承（旧实现每轮都新建空对象的坑）', async () => {
  const box = collector();
  const handlers = createGoalPlanHandlers({
    aim: { goal: { title: '上一轮的目标', status: 'active', accepted: true }, plan: { steps: [{ label: '旧步骤', status: 'done' }] } },
  });
  // 不调用 set_goal，直接改状态：只有真的继承到了 aim 才会成功。
  const result = await handlers.update_goal({ status: 'blocked', summary: '缺权限' }, { emit: box.emit });
  assert.equal(errorOf(result), null, `继承失败时这里会报「No goal is set」：${textOf(result)}`);
  const goalEvent = box.events.find(event => event.type === 'goal');
  assert.equal(goalEvent.goal.title, '上一轮的目标');
  assert.equal(goalEvent.goal.status, 'blocked');
  assert.equal(goalEvent.goal.summary, '缺权限');
});

test('goal-plan：set_goal / set_plan 发 goal / plan 事件，参数校验逐字段', async () => {
  const box = collector();
  const handlers = createGoalPlanHandlers({});

  const goal = await handlers.set_goal({ title: '接入技能包', detail: '先包装核心工具' }, { emit: box.emit });
  assert.equal(errorOf(goal), null);
  assert.equal(box.events.at(-1).type, 'goal');
  assert.equal(box.events.at(-1).goal.title, '接入技能包');
  assert.equal(box.events.at(-1).goal.accepted, false);

  // 旧的 mova_update_plan 入参形状：{ steps: [{label, status}] }
  const plan = await handlers.set_plan({ steps: [{ label: '读代码', status: 'done' }, { label: '写 pack', status: 'active' }] }, { emit: box.emit });
  assert.equal(errorOf(plan), null);
  assert.equal(box.events.at(-1).type, 'plan');
  assert.deepEqual(box.events.at(-1).plan.steps, [
    { label: '读代码', status: 'done' },
    { label: '写 pack', status: 'active' },
  ]);
  assert.match(textOf(plan), /1\/2/);

  for (const bad of [
    { title: '' },
    { title: 'x'.repeat(121) },
    { title: 'ok', detail: 'x'.repeat(401) },
  ]) {
    const result = await handlers.set_goal(bad, {});
    assert.equal(errorOf(result)?.error, 'invalid_arguments', `set_goal(${JSON.stringify(bad).slice(0, 40)}) 应被拒`);
  }
  for (const bad of [
    {},
    { steps: [] },
    { steps: Array.from({ length: 13 }, (_, index) => ({ label: `s${index}` })) },
    { steps: [{ status: 'done' }] },
    { steps: [{ label: 'x'.repeat(121) }] },
    { steps: [{ label: 'ok', status: 'weird' }] },
  ]) {
    const result = await handlers.set_plan(bad, {});
    assert.equal(errorOf(result)?.error, 'invalid_arguments', `set_plan(${JSON.stringify(bad).slice(0, 40)}) 应被拒`);
  }
});

test('goal-plan：ask_user 复用 ask.cjs 的签名（sender, input, signal），选项越界即拒绝', async () => {
  const sender = { id: 'win-1' };
  const asked = [];
  const asks = { ask: async (who, input, signal) => { asked.push({ who, input, signal }); return '好，按方案 A'; } };
  const handlers = createGoalPlanHandlers({ asks, sender });

  const result = await handlers.ask_user({ question: '用哪个方案？', options: ['A', 'B'] }, {});
  assert.equal(textOf(result), '好，按方案 A');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].who, sender);
  assert.deepEqual(asked[0].input.options, [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }]);
  assert.equal(asked[0].input.question, '用哪个方案？');

  const tooMany = await handlers.ask_user({ question: 'q', options: ['1', '2', '3', '4', '5'] }, {});
  assert.equal(errorOf(tooMany).error, 'invalid_arguments');
  const tooLong = await handlers.ask_user({ question: 'q', options: ['x'.repeat(61)] }, {});
  assert.equal(errorOf(tooLong).error, 'invalid_arguments');
  const longQuestion = await handlers.ask_user({ question: 'q'.repeat(401) }, {});
  assert.equal(errorOf(longQuestion).error, 'invalid_arguments');
  const longChoice = await handlers.ask_user({ question: 'q', choices: [{ label: 'x'.repeat(61) }] }, {});
  assert.equal(errorOf(longChoice).error, 'invalid_arguments');
  assert.equal(asked.length, 1, '不合法的参数一个都不该发到用户面前');
});

test('goal-plan：没有 asks / sender 就不暴露 ask_user；没有 approvals 就不暴露 request_approval', async () => {
  assert.equal(createGoalPlanHandlers({}).ask_user, undefined);
  assert.equal(createGoalPlanHandlers({ asks: { ask: async () => 'x' } }).ask_user, undefined);
  assert.equal(createGoalPlanHandlers({ sender: { id: 'w' } }).ask_user, undefined);
  assert.equal(createGoalPlanHandlers({}).request_approval, undefined);
  assert.equal(createGoalPlanHandlers({ approvals: { ask: async () => 'once' } }).request_approval, undefined);
});

test('goal-plan：request_approval 走 approvals.ask(sender, request, signal) 并区分批准/拒绝', async () => {
  const sender = { id: 'win-2' };
  const asked = [];
  const handlers = createGoalPlanHandlers({
    sender,
    approvals: { ask: async (who, request, signal) => { asked.push({ who, request, signal }); return 'once'; } },
  });
  const approved = await handlers.request_approval({ action: '删除 dist/', detail: '生成物，可重建' }, {});
  assert.match(textOf(approved), /已批准/);
  assert.equal(asked[0].who, sender);
  assert.equal(asked[0].request.capability, 'exec');
  assert.equal(asked[0].request.allowSession, false);

  const denying = createGoalPlanHandlers({ sender, approvals: { ask: async () => 'deny' } });
  const denied = await denying.request_approval({ action: 'x', detail: 'y' }, {});
  assert.match(textOf(denied), /拒绝/);
  assert.equal(errorOf(denied), null, '用户拒绝审批不是工具错误，模型需要读到这句话');

  const missing = await handlers.request_approval({ action: 'x' }, {});
  assert.equal(errorOf(missing).error, 'invalid_arguments');
});

/* ── web-research ─────────────────────────────────────────────────── */

function legacySearch({ rows }) {
  const calls = [];
  return {
    calls,
    search: async (key, query, signal) => {
      calls.push({ key, query, signal });
      return rows;
    },
  };
}

function fakeService({ rows = [], evidence = [], read = null, throwOnSearch = false, meta = {} } = {}) {
  const calls = { search: [], read: [] };
  return {
    calls,
    service: {
      async search(request) {
        calls.search.push(request);
        if (throwOnSearch) throw new Error('上游 502');
        return { rows, evidence, meta };
      },
      async read(request) {
        calls.read.push(request);
        if (typeof read === 'function') return read(request);
        return { url: request.url, title: '示例页', pages: [{ text: 'Node 24 ships ESM improvements' }] };
      },
    },
  };
}

test('web-research：没有检索能力时整包不暴露；只有 legacy 时没有 web_read / web_research', () => {
  assert.deepEqual(createWebResearchHandlers({}), {});
  assert.deepEqual(createWebResearchHandlers({ searchService: {} }), {});
  const legacy = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search });
  assert.deepEqual(Object.keys(legacy).sort(), ['verify_citations', 'web_search']);
});

test('web-research：依赖齐全时 4 个工具都在', () => {
  const { service } = fakeService();
  const handlers = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search, searchService: service });
  assert.deepEqual(Object.keys(handlers).sort(), ['verify_citations', 'web_read', 'web_research', 'web_search']);
});

test('web-research：web_search 发 search 事件（running → done）并返回带编号的证据块', async () => {
  const box = collector();
  const { service, calls } = fakeService({
    evidence: [{ url: 'https://a.example/x', title: 'A', pages: [{ text: 'Node 24 ships ESM improvements' }] }],
    meta: { candidates: 3, read: 1 },
  });
  const handlers = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search, searchService: service });
  const result = await handlers.web_search({ query: 'node 24 esm' }, { callId: 'mcp-11', emit: box.emit });

  assert.equal(errorOf(result), null);
  assert.ok(textOf(result).includes('[1]'), '证据块必须带 [1] 编号');
  assert.equal(box.events[0].type, 'search');
  assert.equal(box.events[0].status, 'running');
  assert.equal(box.events[0].id, 'mcp-11');
  assert.equal(box.events.at(-1).status, 'done');
  assert.deepEqual(box.events.at(-1).sources, [{ id: 'https://a.example/x', url: 'https://a.example/x', title: 'A', site: 'a.example', published: null }]);
  assert.deepEqual(calls.search[0].queries, ['node 24 esm']);
});

test('web-research：没有查询词时发 error 事件并返回 invalid_arguments', async () => {
  const box = collector();
  const handlers = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search });
  const result = await handlers.web_search({}, { callId: 'mcp-12', emit: box.emit });
  assert.equal(errorOf(result).error, 'invalid_arguments');
  assert.equal(box.events[0].status, 'running');
  assert.equal(box.events.at(-1).status, 'error');

  const badRecency = await handlers.web_search({ query: 'q', recency: 'week' }, {});
  assert.equal(errorOf(badRecency).error, 'invalid_arguments');
});

test('web-research：legacy 分支只调 search(key, query) 并串到同一个 web_search 工具上', async () => {
  const legacy = legacySearch({ rows: [{ url: 'https://b.example/y', title: 'B', snippet: 'snippet 内容' }] });
  const handlers = createWebResearchHandlers({ search: legacy.search, searchKey: 'k-1' });
  const result = await handlers.web_search({ query: '查一下' }, { callId: 'mcp-13' });
  assert.equal(errorOf(result), null);
  assert.equal(legacy.calls.length, 1);
  assert.equal(legacy.calls[0].key, 'k-1');
  assert.equal(legacy.calls[0].query, '查一下');
});

test('web-research：web_read 只认 http/https，成功时发 read 事件并截断正文', async () => {
  const box = collector();
  const { service } = fakeService({
    read: () => ({ url: 'https://c.example/z', title: 'C', pages: [{ text: 'x'.repeat(600) }] }),
  });
  const handlers = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search, searchService: service });

  const bad = await handlers.web_read({ url: 'ftp://c.example/z' }, {});
  assert.equal(errorOf(bad).error, 'invalid_arguments');
  const missing = await handlers.web_read({}, {});
  assert.equal(errorOf(missing).error, 'invalid_arguments');

  const ok = await handlers.web_read({ url: 'https://c.example/z', maxChars: 500 }, { callId: 'mcp-14', emit: box.emit });
  assert.equal(errorOf(ok), null);
  assert.ok(textOf(ok).includes('已截断'), '超过 maxChars 要截断并说明');
  assert.equal(box.events[0].type, 'read');
  assert.equal(box.events.at(-1).status, 'done');
  assert.ok(box.events.at(-1).chars > 0);
});

test('web-research：检索服务抛错时收敛成 isError + error 事件', async () => {
  const box = collector();
  const { service } = fakeService({ throwOnSearch: true });
  const handlers = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search, searchService: service });
  const result = await handlers.web_search({ query: 'q' }, { callId: 'mcp-15', emit: box.emit });
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).error, 'search_failed');
  assert.equal(box.events.at(-1).status, 'error');
  assert.match(box.events.at(-1).detail, /502/);
});

test('web-research：verify_citations 只核对本轮返回过的证据', async () => {
  const { service } = fakeService({
    evidence: [{ url: 'https://d.example/w', title: 'D', pages: [{ text: 'Node 24 ships ESM improvements' }] }],
  });
  const handlers = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search, searchService: service });

  const empty = await handlers.verify_citations({ answer: 'x [1]' }, {});
  assert.equal(errorOf(empty).error, 'no_evidence');

  await handlers.web_search({ query: 'node 24 esm' }, { callId: 'mcp-16' });
  const good = await handlers.verify_citations({ answer: 'Node 24 ships ESM improvements [1].' }, {});
  assert.equal(errorOf(good), null);
  assert.match(textOf(good), /尽数可核验/);

  const bad = await handlers.verify_citations({ answer: '没有出处的断言 [9]。' }, {});
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /引用校验/);

  const noMarker = await handlers.verify_citations({ answer: '没有标记的段落。' }, {});
  assert.equal(errorOf(noMarker), null);
  assert.match(textOf(noMarker), /没有 \[n\]/);

  const invalid = await handlers.verify_citations({}, {});
  assert.equal(errorOf(invalid).error, 'invalid_arguments');
});

test('web-research：web_research 需要多源服务，readCount 越界即拒绝', async () => {
  const { service, calls } = fakeService({
    evidence: [{ url: 'https://e.example/v', title: 'E', pages: [{ text: '正文' }] }],
    meta: { read: 3 },
  });
  const handlers = createWebResearchHandlers({ search: legacySearch({ rows: [] }).search, searchService: service });
  const result = await handlers.web_research({ question: '研究一下', readCount: 3 }, { callId: 'mcp-17' });
  assert.equal(errorOf(result), null);
  assert.equal(calls.search[0].options.readCount, 3);
  assert.deepEqual(calls.search[0].queries, ['研究一下']);

  const bad = await handlers.web_research({ question: 'q', readCount: 99 }, {});
  assert.equal(errorOf(bad).error, 'invalid_arguments');
  const missing = await handlers.web_research({}, {});
  assert.equal(errorOf(missing).error, 'invalid_arguments');
});

/* ── memory ───────────────────────────────────────────────────────── */

function fakeMemorySearch({ hits = [], readSource = null } = {}) {
  const calls = [];
  const fn = async (input, signal) => {
    calls.push({ input, signal });
    return hits;
  };
  if (readSource) fn.readSource = async (input, signal) => { calls.push({ readSource: input, signal }); return readSource; };
  return { fn, calls };
}

test('memory：没有 memorySearch 就整包不暴露；缺 readSource / memoryRuntime 时少对应工具', () => {
  assert.deepEqual(createMemoryHandlers({}), {});
  const { fn } = fakeMemorySearch();
  assert.deepEqual(Object.keys(createMemoryHandlers({ memorySearch: fn })), ['memory_search']);
  const { fn: withRead } = fakeMemorySearch({ readSource: { ok: true } });
  assert.deepEqual(Object.keys(createMemoryHandlers({ memorySearch: withRead })).sort(), ['memory_read_source', 'memory_search']);
  assert.deepEqual(
    Object.keys(createMemoryHandlers({ memorySearch: withRead, memoryRuntime: { saveMemory: async () => ({}) } })).sort(),
    ['memory_read_source', 'memory_search', 'memory_write'],
  );
});

test('memory：memory_search 归一命中、每条带来源 id，并发出 memory 事件', async () => {
  const box = collector();
  const { fn, calls } = fakeMemorySearch({
    hits: [{ id: 'mem-1', text: '偏好中文提交信息', projectId: null, source: 'user' }],
  });
  const handlers = createMemoryHandlers({ memorySearch: fn });
  const result = await handlers.memory_search({ query: '提交信息', limit: 5 }, { callId: 'mcp-21', emit: box.emit });
  assert.equal(errorOf(result), null);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, 'mem-1');
  assert.equal(payload[0].text, '偏好中文提交信息');
  assert.deepEqual(calls[0].input, { query: '提交信息', scope: 'current', limit: 5, source: 'auto' });
  assert.equal(box.events[0].type, 'memory');
  assert.equal(box.events[0].status, 'running');
  assert.equal(box.events.at(-1).count, 1);

  const badScope = await handlers.memory_search({ query: 'q', scope: 'everywhere' }, {});
  assert.equal(errorOf(badScope).error, 'invalid_arguments');
  const tooLong = await handlers.memory_search({ query: 'q'.repeat(401) }, {});
  assert.equal(errorOf(tooLong).error, 'invalid_arguments');
  const missing = await handlers.memory_search({}, {});
  assert.equal(errorOf(missing).error, 'invalid_arguments');
});

test('memory：memory_read_source 按来源 id 取原文，取不到即 isError', async () => {
  const { fn } = fakeMemorySearch({ readSource: { ok: true, id: 'mem-1', text: '原文', nextOffset: null } });
  const handlers = createMemoryHandlers({ memorySearch: fn });
  const ok = await handlers.memory_read_source({ id: 'mem-1' }, { callId: 'mcp-22' });
  assert.equal(errorOf(ok), null);
  assert.equal(JSON.parse(textOf(ok)).text, '原文');

  const missingRange = createMemoryHandlers({
    memorySearch: fakeMemorySearch({ readSource: { ok: false, code: 'invalid-range' } }).fn,
  });
  const failed = await missingRange.memory_read_source({ id: 'mem-1' }, { callId: 'mcp-23' });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /分页范围无效/);

  const badMode = await handlers.memory_read_source({ id: 'mem-1', mode: 'all' }, {});
  assert.equal(errorOf(badMode).error, 'invalid_arguments');
  const noId = await handlers.memory_read_source({}, {});
  assert.equal(errorOf(noId).error, 'invalid_arguments');
});

test('memory：memory_write 拒绝时零副作用（saveMemory 一次都没调）', async () => {
  const saved = [];
  const deny = denyAuthorize();
  const box = collector();
  const handlers = createMemoryHandlers({
    memorySearch: fakeMemorySearch().fn,
    memoryRuntime: { saveMemory: async input => { saved.push(input); return { id: 'm-9' }; } },
    projectId: 'proj-1',
    conversationId: 'conv-1',
  });
  const result = await handlers.memory_write({ text: '记住这个' }, { callId: 'mcp-24', emit: box.emit, authorize: deny.authorize });
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).error, 'approval_denied');
  assert.deepEqual(saved, [], '拒绝后绝不能落盘');
  assert.ok(box.events.some(event => event.type === 'notice'));

  const noChannel = await handlers.memory_write({ text: '记住这个' }, { callId: 'mcp-25' });
  assert.equal(errorOf(noChannel).error, 'permission_unavailable');
  assert.deepEqual(saved, []);
});

test('memory：memory_write 允许时带上下文落盘，参数非法与敏感内容都收敛成 isError', async () => {
  const saved = [];
  const allow = allowAuthorize();
  const handlers = createMemoryHandlers({
    memorySearch: fakeMemorySearch().fn,
    memoryRuntime: { saveMemory: async input => { saved.push(input); return { id: 'm-10', kind: input.kind, projectId: input.projectId }; } },
    projectId: 'proj-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
  });
  const ok = await handlers.memory_write({ text: ' 偏好中文提交信息 ', kind: 'preference' }, { callId: 'mcp-26', authorize: allow.authorize });
  assert.equal(errorOf(ok), null);
  assert.equal(JSON.parse(textOf(ok)).id, 'm-10');
  assert.deepEqual(saved[0], {
    text: '偏好中文提交信息',
    kind: 'preference',
    projectId: 'proj-1',
    source: 'user',
    conversationId: 'conv-1',
    messageId: 'msg-1',
  });

  const badKind = await handlers.memory_write({ text: 'x', kind: 'secret' }, { authorize: allow.authorize });
  assert.equal(errorOf(badKind).error, 'invalid_arguments');
  const tooLong = await handlers.memory_write({ text: 'x'.repeat(4_001) }, { authorize: allow.authorize });
  assert.equal(errorOf(tooLong).error, 'invalid_arguments');
  assert.equal(saved.length, 1, '参数不合法时一次都不该写');

  const rejecting = createMemoryHandlers({
    memorySearch: fakeMemorySearch().fn,
    memoryRuntime: { saveMemory: async () => { throw Object.assign(new Error('sensitive-content'), { code: 'sensitive-content' }); } },
  });
  const sensitive = await rejecting.memory_write({ text: 'password: 123456' }, { authorize: allow.authorize });
  assert.equal(sensitive.isError, true);
  assert.equal(errorOf(sensitive).error, 'sensitive-content');
  assert.match(textOf(sensitive), /敏感/);
});

/* ── context-ledger ───────────────────────────────────────────────── */

function fakeContextTools({ onCompact } = {}) {
  const calls = [];
  return {
    calls,
    contextTools: {
      definitions: [],
      handlers: {
        context_status: (args, ctx) => { calls.push({ name: 'context_status', args, ctx }); return { content: [{ type: 'text', text: '用量 12%' }] }; },
        context_compact: (args, ctx) => {
          calls.push({ name: 'context_compact', args, ctx });
          if (onCompact) return onCompact(args, ctx);
          return { content: [{ type: 'text', text: `已压缩 ${args.keepRecent ?? 8}` }] };
        },
        context_read: (args, ctx) => { calls.push({ name: 'context_read', args, ctx }); return { content: [{ type: 'text', text: `页 ${args.offset ?? 0}` }] }; },
      },
    },
  };
}

test('context-ledger：缺 contextTools 或它没有 handlers 时不暴露任何工具', () => {
  assert.deepEqual(createContextLedgerHandlers({}), {});
  assert.deepEqual(createContextLedgerHandlers({ contextTools: null }), {});
  assert.deepEqual(createContextLedgerHandlers({ contextTools: {} }), {});
  assert.deepEqual(createContextLedgerHandlers({ contextTools: { handlers: {} } }), {});
  const partial = createContextLedgerHandlers({ contextTools: { handlers: { context_status: () => 'ok' } } });
  assert.deepEqual(Object.keys(partial), ['context_status'], '缺实现就不暴露');
});

test('context-ledger：3 个工具转调既有实现，并把 signal / emit 传下去', async () => {
  const box = collector();
  const { contextTools, calls } = fakeContextTools();
  const handlers = createContextLedgerHandlers({ contextTools });
  assert.deepEqual(Object.keys(handlers).sort(), ['context_compact', 'context_read', 'context_status']);

  const signal = new AbortController().signal;
  await handlers.context_status({}, { callId: 'mcp-31', emit: box.emit, signal });
  await handlers.context_compact({ keepRecent: 10, reason: '窗口快满' }, { emit: box.emit, signal });
  await handlers.context_read({ offset: 100, limit: 2_000 }, { emit: box.emit, signal });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, {});
  assert.deepEqual(calls[1].args, { keepRecent: 10, reason: '窗口快满' });
  assert.deepEqual(calls[2].args, { offset: 100, limit: 2_000 });
  for (const call of calls) {
    assert.equal(call.ctx.signal, signal, '取消信号必须传给既有实现');
    assert.equal(call.ctx.emit, box.emit, '事件通道必须传给既有实现');
  }
});

test('context-ledger：参数非法时返回 invalid_arguments，且不调用既有实现', async () => {
  const { contextTools, calls } = fakeContextTools();
  const handlers = createContextLedgerHandlers({ contextTools });

  for (const [name, args] of [
    ['context_status', { extra: 1 }],
    ['context_compact', { keepRecent: 2 }],
    ['context_compact', { keepRecent: 31 }],
    ['context_compact', { keepRecent: 8.5 }],
    ['context_compact', { reason: 'x'.repeat(201) }],
    ['context_read', { offset: -1 }],
    ['context_read', { limit: 0 }],
    ['context_read', { limit: 6_001 }],
  ]) {
    const result = await handlers[name](args, {});
    assert.equal(errorOf(result)?.error, 'invalid_arguments', `${name}(${JSON.stringify(args)}) 应被拒`);
  }
  assert.deepEqual(calls, [], '参数不合法时不该调用既有实现');
});

test('context-ledger：既有实现抛错也收敛成 isError，绝不向上抛', async () => {
  const { contextTools } = fakeContextTools({ onCompact: () => { throw new Error('台账坏了'); } });
  const handlers = createContextLedgerHandlers({ contextTools });
  const result = await handlers.context_compact({ keepRecent: 8 }, {});
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).error, 'tool_failed');
  assert.match(textOf(result), /台账坏了/);
});
