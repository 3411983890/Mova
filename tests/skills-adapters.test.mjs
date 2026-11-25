// electron/skills/adapters/* 与 electron/skills/index.mjs 的联调测试。
// 用真的 buildSkillRuntime + 假 pack（handler 全是内存函数），验证两条链路的适配层：
// pi-ai 的 tools[] 形状、MCP 工具表的 tools/list 边界、mova_skill_search/call 两步调用、结果截断。
// 不碰 electron、不起 HTTP server、不读磁盘。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMcpToolTable } from '../electron/skills/adapters/mcp.mjs';
import { toPiAiTools } from '../electron/skills/adapters/pi-ai.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';

function tool(name, { exposure = { piAi: true, mcp: 'on_demand' }, risk = 'read', ...rest } = {}) {
  return {
    name,
    label: `${name} 展示名`,
    description: `Do ${name} with the given text.`,
    mcpSummary: `${name} 一行摘要。`,
    risk,
    approval: { mode: 'policy' },
    exposure,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    examples: [{ title: '示例', arguments: { text: 'hi' } }],
    ...rest,
  };
}

const PACK = {
  manifest: {
    apiVersion: 1,
    id: 'demo-pack',
    version: '1.0.0',
    title: '演示技能包',
    summary: '演示用技能包：读文件、编辑画板、内部工具。',
    capabilities: ['demo.read', 'demo.write'],
    dependencies: [],
    permissions: { fs: 'read', exec: false, net: false, desktop: false, browser: false, canvas: true, memory: 'none' },
    deprecation: null,
    tools: [
      tool('read_file', { exposure: { piAi: true, mcp: 'core' } }),
      tool('design_apply', { exposure: { piAi: true, mcp: 'on_demand' }, risk: 'write' }),
      tool('internal_only', { exposure: { piAi: false, mcp: 'off' } }),
    ],
  },
  createHandlers: () => ({
    read_file: async (args, ctx) => ({ content: [{ type: 'text', text: `hello ${args.text} via ${ctx.transport}` }] }),
    design_apply: async () => ({
      content: [{ type: 'text', text: '已更新 3 个节点' }],
      detail: '已更新 3 个节点',
      diff: { path: 'canvas', before: 'a', after: 'b' },
      image: { id: 'sha256.png', name: '画板截图' },
    }),
    internal_only: async () => 'secret',
  }),
};

function makeRuntime({ emit, handlers } = {}) {
  const pack = handlers
    ? { manifest: PACK.manifest, createHandlers: () => handlers }
    : PACK;
  return buildSkillRuntime({ packs: [pack], deps: { emit } });
}

test('toPiAiTools 只投影 exposure.piAi 的工具，并带上调用所需的全部字段', () => {
  const tools = toPiAiTools(makeRuntime());
  assert.deepEqual(tools.map(item => item.name), ['read_file', 'design_apply'], 'piAi:false 的 internal_only 不进 agent 工具表');
  for (const item of tools) {
    assert.deepEqual(Object.keys(item).sort(), ['description', 'execute', 'label', 'name', 'parameters']);
    assert.equal(item.parameters.type, 'object');
    assert.equal(item.parameters.additionalProperties, false);
  }
});

test('pi-ai execute 走 runtime.invoke 并标记 transport:pi-ai，onTiming 拿到耗时', async () => {
  const samples = [];
  const tools = toPiAiTools(makeRuntime(), { onTiming: sample => samples.push(sample) });
  const readFile = tools.find(item => item.name === 'read_file');
  const result = await readFile.execute('mcp-1', { text: 'mova' }, undefined);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /hello mova via pi-ai/, '执行上下文必须带上 pi-ai 通道标记');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].name, 'read_file');
  assert.equal(samples[0].callId, 'mcp-1');
  assert.equal(samples[0].ok, true);
  assert.ok(samples[0].durationMs >= 0);
});

test('MCP tools/list 只给核心集 + 两个元工具，on_demand 不直出', () => {
  const table = toMcpToolTable(makeRuntime());
  const names = table.list().map(item => item.name);
  assert.deepEqual(names, ['mova_read_file', 'mova_skill_search', 'mova_skill_call'], 'tools/list 必须保持极小');
  for (const item of table.list()) {
    assert.deepEqual(Object.keys(item).sort(), ['description', 'inputSchema', 'name'], 'MCP 描述符只能有这三个字段');
    assert.ok(item.description.split('\n').length <= 2, `${item.name} 的描述超过 2 行`);
    assert.equal(item.inputSchema.additionalProperties, false, `${item.name} 的 schema 必须禁止额外字段`);
  }
});

test('has() 认得核心名、省略前缀名、on_demand 名、旧别名与两个元工具', () => {
  const table = toMcpToolTable(makeRuntime());
  for (const name of ['mova_read_file', 'read_file', 'design_apply', 'mova_design_apply']) {
    assert.equal(table.has(name), true, `${name} 应该可解析（tools/call 允许直接调非核心工具）`);
  }
  for (const name of ['mova_skill_search', 'mova_tools_search', 'mova_skill_call']) {
    assert.equal(table.has(name), true, `${name} 是元工具，必须永远可用`);
  }
  assert.equal(table.has('internal_only'), false, 'exposure.mcp:off 的工具在 MCP 边界必须不存在');
  assert.equal(table.has('mova_internal_only'), false);
  assert.equal(table.has('mova_does_not_exist'), false);
});

test('exposure.mcp:off 的工具在 MCP 边界完全不可达（has / call / search / mova_skill_call 全拒）', async () => {
  const table = toMcpToolTable(makeRuntime());
  assert.equal(table.has('internal_only'), false, 'has() 必须为 false');

  const direct = await table.call('internal_only', {});
  assert.equal(direct.isError, true);
  assert.match(direct.content[0].text, /unknown_tool/, '直接调用必须报 unknown_tool，不能执行');

  const viaCall = await table.call('mova_skill_call', { name: 'internal_only', arguments: {} });
  assert.equal(viaCall.isError, true);
  assert.match(viaCall.content[0].text, /unknown_tool/, 'mova_skill_call 不能成为绕过 exposure 的后门');

  assert.deepEqual(table.search('internal'), [], '检索结果里也不能出现 off 的工具');
  const searched = await table.call('mova_skill_search', { query: 'internal' });
  assert.equal(JSON.parse(searched.content[0].text).matches.length, 0, 'mova_skill_search 同样查不到');
});

test('mova_skill_search 返回可读的检索结果，旧名 mova_tools_search 同样可用', async () => {
  const table = toMcpToolTable(makeRuntime());
  const result = await table.call('mova_skill_search', { query: 'design' });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.matches[0].name, 'design_apply');
  assert.equal(payload.matches[0].pack, 'demo-pack');

  const legacy = await table.call('mova_tools_search', { query: 'design' });
  assert.equal(JSON.parse(legacy.content[0].text).matches[0].name, 'design_apply', '旧名必须继续工作');
});

test('mova_skill_call 转调 runtime.invoke（先查 schema 再调用，不用重拉 tools/list）', async () => {
  const events = [];
  const table = toMcpToolTable(makeRuntime({ emit: event => events.push(event) }));
  const result = await table.call('mova_skill_call', { name: 'design_apply', arguments: { text: 'x' } });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /已更新 3 个节点/);

  assert.deepEqual(events.map(event => event.status), ['running', 'done'], '两次事件同一 id 原地更新');
  assert.equal(events[0].id, events[1].id, 'running 与 done 必须同 id');
  assert.match(events[0].id, /^mcp-\d+$/, 'id 规则统一为 mcp-<seq>');
  assert.equal(events[1].detail, '已更新 3 个节点');
  assert.deepEqual(events[1].diff, { path: 'canvas', before: 'a', after: 'b' }, 'diff 透传到 done 事件');
  assert.equal(events[1].image.id, 'sha256.png', '截图挂在 tool 事件的 image 字段上');
});

test('mova_skill_call 缺 name 时报 invalid_arguments 而不是崩掉会话', async () => {
  const table = toMcpToolTable(makeRuntime());
  const result = await table.call('mova_skill_call', { arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid_arguments/);
});

test('未知工具返回 isError + unknown_tool（MCP 里永不抛）', async () => {
  const table = toMcpToolTable(makeRuntime());
  const result = await table.call('mova_nope', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown_tool/);
  const runtime = makeRuntime();
  const direct = await runtime.invoke('also_nope', {});
  assert.equal(direct.isError, true, 'invoke 自己也必须收敛成 isError');
});

test('超长文本按 maxTextChars 截断并说明原文长度', async () => {
  const runtime = makeRuntime({ handlers: { read_file: async () => 'x'.repeat(20_000) } });
  const table = toMcpToolTable(runtime, { maxTextChars: 500 });
  const result = await table.call('read_file', {});
  const text = result.content[0].text;
  assert.ok(text.length <= 500, `截断后长度不得超过 500，实际 ${text.length}`);
  assert.match(text, /已截断/);
  assert.match(text, /8192/, '运行时先按 MAX_TEXT_CHARS 截断，说明里记的是这一层的原始长度');
});

test('pi-ai 通道也按 MAX_TEXT_CHARS(8192) 截断（两条链路同一个预算）', async () => {
  const runtime = makeRuntime({ handlers: { read_file: async () => 'x'.repeat(20_000) } });
  const tools = toPiAiTools(runtime);
  const readFile = tools.find(item => item.name === 'read_file');
  const result = await readFile.execute('mcp-9', { text: 'y' }, undefined);
  const text = result.content[0].text;
  assert.ok(text.length <= 8192, `pi-ai 结果不得超过 8192，实际 ${text.length}`);
  assert.match(text, /已截断/);
  assert.match(text, /20000/, '说明里要保留原始字符数（这一层是第一次截断）');
});

test('ctx.transport 不被适配层覆盖，signal 原样透传（长任务要能取消）', async () => {
  const seen = [];
  const runtime = makeRuntime({
    handlers: {
      read_file: async (args, ctx) => {
        seen.push({ transport: ctx.transport, signal: ctx.signal });
        return 'ok';
      },
    },
  });
  const table = toMcpToolTable(runtime);
  const controller = new AbortController();
  await table.call('read_file', {}, { transport: 'http', signal: controller.signal });
  assert.equal(seen[0].transport, 'http', 'server.mjs 传的是 http，适配层不能改写成 mcp');
  assert.equal(seen[0].signal, controller.signal, 'signal 必须透传，否则长任务无法取消');

  await table.call('read_file', {}, {});
  assert.equal(seen[1].transport, 'mcp', '没有上层 transport 时补默认值 mcp');
});

test('search(query) 返回带 schema 的描述符（与 createToolTable().search 同形）', () => {
  const table = toMcpToolTable(makeRuntime());
  const hits = table.search('design');
  assert.equal(hits[0].name, 'mova_design_apply');
  assert.equal(hits[0].inputSchema.additionalProperties, false);
  assert.equal(typeof hits[0].description, 'string');
});

test('检索结果超出预算时降级为「只给名字」，而不是把 JSON 截半', async () => {
  const bigSchema = () => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [
      `field_${index}`, { type: 'string', description: 'x'.repeat(80) },
    ])),
    required: [],
  });
  const tools = Array.from({ length: 8 }, (_, index) => tool(`bulk_${index}`, { inputSchema: bigSchema() }));
  const pack = {
    manifest: { ...PACK.manifest, id: 'bulk-pack', tools },
    createHandlers: () => Object.fromEntries(tools.map(item => [item.name, async () => 'ok'])),
  };
  const table = toMcpToolTable(buildSkillRuntime({ packs: [pack], deps: {} }));
  const result = await table.call('mova_skill_search', { includeSchema: true, limit: 8 });
  const text = result.content[0].text;
  assert.ok(text.length <= 8192, `结果不得超过 8192 字符，实际 ${text.length}`);
  const payload = JSON.parse(text);
  assert.ok(payload.matches.length >= 1, '至少还留一条结果');
  assert.match(payload.note, /降级/, '降级必须在 note 里说明怎么继续查');
  assert.ok(
    payload.matches.some(match => match.inputSchema === undefined),
    '超预算的条目应被降级成「只给名字」',
  );
  for (const match of payload.matches) {
    if (match.inputSchema === undefined) assert.ok(match.name, '降级后的条目仍要能按名字再查一次');
  }
});

test('没有 emit 时不产生任何事件（纯单测/无人观看通道零副作用）', async () => {
  const runtime = makeRuntime();
  const result = await runtime.invoke('read_file', { text: 'x' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'hello x via direct', '没有 transport 时标记为 direct');
});

test('handler 抛错被收敛成 isError，且 error 事件与 running 同 id', async () => {
  const events = [];
  const runtime = makeRuntime({
    emit: event => events.push(event),
    handlers: {
      read_file: async () => {
        throw new Error('磁盘满了');
      },
    },
  });
  const result = await runtime.invoke('read_file', { text: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /磁盘满了/);
  assert.deepEqual(events.map(event => event.status), ['running', 'error']);
  assert.equal(events[0].id, events[1].id);
});

test('throw 带 code:denied 时事件状态是 denied（前端显示「已拒绝」而不是红色失败）', async () => {
  const events = [];
  const runtime = makeRuntime({
    emit: event => events.push(event),
    handlers: {
      read_file: async () => {
        const error = new Error('用户拒绝了这次写入');
        error.code = 'approval_denied';
        throw error;
      },
    },
  });
  const result = await runtime.invoke('read_file', { text: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /approval_denied/);
  assert.deepEqual(events.map(event => event.status), ['running', 'denied']);
});

test('approval-bridge 的全部拒绝码都映射成 denied 事件（不是 error）', async () => {
  const codes = [
    'denied', 'approval_denied', 'approval_unavailable', 'approval_failed',
    'permission_denied', 'permission_unavailable', 'permission_failed',
    'path_denied', 'path_gate_missing', 'aborted',
  ];
  for (const code of codes) {
    const events = [];
    const runtime = makeRuntime({
      emit: event => events.push(event),
      handlers: {
        read_file: async () => {
          const error = new Error(`refused: ${code}`);
          error.code = code;
          throw error;
        },
      },
    });
    const result = await runtime.invoke('read_file', { text: 'x' });
    assert.equal(result.isError, true, `${code} 必须是 isError`);
    assert.deepEqual(events.map(event => event.status), ['running', 'denied'], `${code} 应显示成 denied`);
  }
});

test('handler 返回 { isError:true } 时事件状态必须是 error（不能显示「完成」）', async () => {
  const events = [];
  const runtime = makeRuntime({
    emit: event => events.push(event),
    handlers: {
      read_file: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied', message: '没有权限' }) }],
        isError: true,
      }),
    },
  });
  const result = await runtime.invoke('read_file', { text: 'x' });
  assert.equal(result.isError, true, 'isError 必须原样交给模型');
  assert.deepEqual(events.map(event => event.status), ['running', 'error'], '模型收到错误时前端不能显示完成');
  assert.match(events[1].detail, /permission_denied/, 'error 事件要带可读原因');
});

test('并发调用同一 callId 时事件仍按 running→done 的顺序成对到达', async () => {
  const events = [];
  const runtime = makeRuntime({
    emit: event => events.push(event),
    handlers: {
      read_file: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return 'ok';
      },
    },
  });
  await Promise.all([
    runtime.invoke('read_file', { text: 'a' }, { callId: 'mcp-42' }),
    runtime.invoke('read_file', { text: 'b' }, { callId: 'mcp-42' }),
  ]);
  assert.deepEqual(
    events.map(event => `${event.id}:${event.status}`),
    ['mcp-42:running', 'mcp-42:done', 'mcp-42:running', 'mcp-42:done'],
    '同一个 id 的两次调用不能交错成 running,running,done,done',
  );
});
