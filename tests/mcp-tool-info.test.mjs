// MCP 工具「按需加载 schema」（方案 §5 P0-4）的回归测试。
// 只测 chat-agent 暴露给模型的那一层：mcpManager 用假对象、模型用 fetchModel 注入，
// 因此不依赖 Electron、磁盘或真实 MCP 子进程。断言以「模型下一轮真正看到的文本」为准，
// 因为体积守卫和缺参提示都只有在那一层才可信。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChatAgent } from '../electron/chat-agent.mjs';

const entry = { id: 'mcp-model', name: 'MCP', vision: false, efforts: [] };
const provider = { id: 'mcp', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
// mcp_call 把 win.webContents 交给 mcpManager（真实路径用它挂审批卡），这里给个假窗口即可。
const win = { webContents: { id: 1 } };

function completion(text) {
  const chunk = 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  }) + '\n\n';
  return new Response(chunk + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

function toolCallOf(name, args, callId) {
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n';
  return new Response(chunk({ tool_calls: [{ index: 0, id: callId, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] }, null)
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

// 每一轮模型调用消费脚本里的一条工具调用；脚本跑完后回终结文本，循环才结束。
async function runTurn({ mcpManager, script }) {
  const payloads = [];
  const queue = [...script];
  await runChatAgent({
    key: 'test', provider, entry, win, mcpManager,
    request: { messages: [{ role: 'user', text: '用一下这些 MCP 工具' }] },
    signal: new AbortController().signal, emit: () => {},
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      const next = queue.shift();
      return next ? toolCallOf(next.name, next.arguments, `call-${payloads.length}`) : completion('好的');
    },
  });
  return payloads;
}

// 模型看到的工具结果：取最后一条 tool 消息的文本（OpenAI 兼容协议下就是纯文本）。
function lastToolText(payload) {
  const rows = payload.messages.filter(message => message.role === 'tool');
  assert.ok(rows.length, '期望对话里出现工具结果消息');
  const content = rows.at(-1).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text ?? '').join('');
  return JSON.stringify(content);
}

function fakeManager(rows) {
  const calls = [];
  return {
    calls,
    async read() { return typeof rows === 'function' ? rows() : rows; },
    async call(serverId, name, args) {
      calls.push({ serverId, name, args });
      return { content: [{ type: 'text', text: `ok:${name}` }] };
    },
  };
}

const readFileRow = (schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) => ({
  id: 'srv-files', name: 'Files', enabled: true, disabledTools: [],
  tools: [{ name: 'read_file', description: 'read a file from disk', inputSchema: schema }],
});

test('mcp_search returns hasSchema and required but never the full schema', async () => {
  const manager = fakeManager([readFileRow()]);
  const payloads = await runTurn({ mcpManager: manager, script: [{ name: 'mcp_search', arguments: { query: 'read' } }] });
  const text = lastToolText(payloads[1]);
  const results = JSON.parse(text);
  assert.equal(results.length, 1, '应该搜到一个工具');
  assert.equal(results[0].hasSchema, true, '有 schema 的工具应标记 hasSchema');
  assert.deepEqual(results[0].required, ['path'], 'required 应只给字段名');
  assert.ok(!('inputSchema' in results[0]), '搜索结果项不得带 inputSchema 字段');
  assert.doesNotMatch(JSON.stringify(results), /inputSchema/, '体积守卫：搜索结果里不得出现完整 schema');
  assert.match(JSON.stringify(results[0]), /read a file from disk/, '用途描述应保留');
});

test('mcp_search reports no schema for tools that have none', async () => {
  const manager = fakeManager([{
    id: 'srv-bare', name: 'Bare', enabled: true, disabledTools: [],
    tools: [{ name: 'ping', description: 'ping the server' }],
  }]);
  const payloads = await runTurn({ mcpManager: manager, script: [{ name: 'mcp_search', arguments: { query: 'ping' } }] });
  const results = JSON.parse(lastToolText(payloads[1]));
  assert.equal(results[0].hasSchema, false, '没有 schema 的工具 hasSchema 应为 false');
  assert.deepEqual(results[0].required, [], '没有 schema 时 required 为空数组');
});

test('mcp_search description tells the model to call mcp_tool_info first', async () => {
  const manager = fakeManager([readFileRow()]);
  const payloads = await runTurn({ mcpManager: manager, script: [] });
  const definition = payloads[0].tools.find(tool => (tool.function?.name ?? tool.name) === 'mcp_search');
  assert.ok(definition, '本轮应暴露 mcp_search');
  assert.match(JSON.stringify(definition), /Call mcp_tool_info before the first call to this tool\./,
    'mcp_search 描述里应有首次调用前的提示句');
});

test('mcp_tool_info returns the full input schema', async () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string', description: '项目内相对路径' }, encoding: { type: 'string', enum: ['utf8', 'utf16'] } },
    required: ['path'],
  };
  const manager = fakeManager([readFileRow(schema)]);
  const payloads = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_tool_info', arguments: { id: 'srv-files:read_file' } },
  ] });
  const info = JSON.parse(lastToolText(payloads[1]));
  assert.equal(info.id, 'srv-files:read_file');
  assert.equal(info.name, 'read_file');
  assert.equal(info.server, 'Files');
  assert.deepEqual(info.inputSchema, schema, '应原样返回完整 schema');
  assert.ok(!info.truncated, '未超长时不应标记 truncated');
});

test('mcp_tool_info truncates an oversized schema and flags it', async () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'x'.repeat(7000) } },
    required: ['path'],
  };
  const manager = fakeManager([readFileRow(schema)]);
  const payloads = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_tool_info', arguments: { id: 'srv-files:read_file' } },
  ] });
  const text = lastToolText(payloads[1]);
  const info = JSON.parse(text);
  assert.equal(info.truncated, true, '超 6000 字符应标记 truncated');
  assert.equal(typeof info.inputSchema, 'string', '超长时 schema 以字符串返回');
  // 截断点是 6000，后面只追加一句极短的说明，所以上限放宽一丁点。
  assert.ok(info.inputSchema.length <= 6060, `截断后 schema 不应超过 6000 字符（含说明），实际 ${info.inputSchema.length}`);
  assert.ok(text.length < 6400, `截断后整体输出应远小于原 schema，实际 ${text.length}`);
  assert.match(info.inputSchema, /truncated/, '截断处应注明');
});

test('mcp_tool_info reports an unknown id as an error', async () => {
  const manager = fakeManager([readFileRow()]);
  const payloads = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_tool_info', arguments: { id: 'srv-files:no_such_tool' } },
  ] });
  // isError 由 pi-agent-core 内部标记，模型侧只看得到文案；因此这里断言文案可读且不含 schema。
  const text = lastToolText(payloads[1]);
  assert.match(text, /Unknown MCP tool/, '未知 id 应给出可读错误');
  assert.match(text, /srv-files:no_such_tool/, '错误里应回显用户给的 id');
  assert.match(text, /mcp_search/, '错误里应指引正确的查找方式');
});

test('mcp_tool_info returns a null schema for tools without one', async () => {
  const manager = fakeManager([{
    id: 'srv-bare', name: 'Bare', enabled: true, disabledTools: [],
    tools: [{ name: 'ping', description: 'ping the server' }],
  }]);
  const payloads = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_tool_info', arguments: { id: 'srv-bare:ping' } },
  ] });
  const info = JSON.parse(lastToolText(payloads[1]));
  assert.equal(info.inputSchema, null, '没有 schema 时应显式返回 null');
  assert.equal(info.id, 'srv-bare:ping');
});

test('mcp_call rejects a missing required argument without touching the MCP server', async () => {
  const manager = fakeManager([readFileRow()]);
  const payloads = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_call', arguments: { id: 'srv-files:read_file', arguments: { encoding: 'utf8' } } },
  ] });
  const text = lastToolText(payloads[1]);
  assert.match(text, /Missing required argument: path/, '应指出缺失的字段名');
  assert.equal(manager.calls.length, 0, '校验失败时不得发起 IPC / MCP 调用');
});

test('mcp_call forwards complete arguments to the MCP manager', async () => {
  const manager = fakeManager([readFileRow()]);
  const payloads = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_call', arguments: { id: 'srv-files:read_file', arguments: { path: 'README.md' } } },
  ] });
  assert.equal(manager.calls.length, 1, '参数齐全时应调用一次');
  assert.deepEqual(manager.calls[0], { serverId: 'srv-files', name: 'read_file', args: { path: 'README.md' } },
    '参数应原样透传');
  assert.match(lastToolText(payloads[1]), /ok:read_file/, '工具返回值应回给模型');
});

test('mcp_call skips validation for tools without a schema', async () => {
  const manager = fakeManager([{
    id: 'srv-bare', name: 'Bare', enabled: true, disabledTools: [],
    tools: [{ name: 'ping', description: 'ping the server' }],
  }]);
  const payloads = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_call', arguments: { id: 'srv-bare:ping', arguments: {} } },
  ] });
  assert.equal(manager.calls.length, 1, '没有 schema 时不做校验，保持原有行为');
  assert.match(lastToolText(payloads[1]), /ok:ping/);
});

test('mcp_call validation follows a changed schema on the next turn', async () => {
  // 第一轮目录里 path 是唯一必填；第二轮目录改成 path+encoding，缓存必须按新 schema 判定。
  let schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const manager = fakeManager(() => [readFileRow(schema)]);
  const first = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_call', arguments: { id: 'srv-files:read_file', arguments: { path: 'a.md' } } },
  ] });
  assert.equal(manager.calls.length, 1, '第一轮参数齐全应调用成功');
  assert.match(lastToolText(first[1]), /ok:read_file/);

  schema = {
    type: 'object',
    properties: { path: { type: 'string' }, encoding: { type: 'string' } },
    required: ['path', 'encoding'],
  };
  const second = await runTurn({ mcpManager: manager, script: [
    { name: 'mcp_call', arguments: { id: 'srv-files:read_file', arguments: { path: 'a.md' } } },
  ] });
  assert.match(lastToolText(second[1]), /Missing required argument: encoding/, '目录变化后应按新 schema 判定');
  assert.equal(manager.calls.length, 1, '第二轮被拦下，不应再发起调用');
});

test('mcp_search shows the new required fields after the catalog changes', async () => {
  let schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const manager = fakeManager(() => [readFileRow(schema)]);
  const first = await runTurn({ mcpManager: manager, script: [{ name: 'mcp_search', arguments: { query: 'file' } }] });
  assert.deepEqual(JSON.parse(lastToolText(first[1]))[0].required, ['path']);

  schema = { type: 'object', properties: { path: { type: 'string' }, mode: { type: 'string' } }, required: ['path', 'mode'] };
  const second = await runTurn({ mcpManager: manager, script: [{ name: 'mcp_search', arguments: { query: 'file' } }] });
  assert.deepEqual(JSON.parse(lastToolText(second[1]))[0].required, ['path', 'mode'], '目录变化后 required 应更新');
});
