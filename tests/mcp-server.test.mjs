// 本地 MCP server（electron/mcp/server.mjs）的端到端测试。
// 每个用例真起一个端口（port:0 随机分配）、真发 HTTP 请求，测完 close()，
// 因为这里要验证的恰恰是「协议外壳」：鉴权、状态码、JSON-RPC 错误码、监听范围与关闭语义。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolTable } from '../electron/mcp/tools.mjs';
import { startMovaToolServer } from '../electron/mcp/server.mjs';

const TOKEN = 'test-token-0f3a91c7d2b8';

function makeTable() {
  const seen = [];
  const table = createToolTable({
    handlers: {
      mova_read_file: async args => ({ path: args.path, content: 'hello from mova' }),
      mova_web_search: async (args, ctx) => {
        seen.push({ args, ctx });
        return { results: [{ title: 'hit' }] };
      },
      mova_write_file: async () => {
        throw new Error('审批被拒绝');
      },
    },
  });
  return { table, seen };
}

async function withServer(t) {
  const { table, seen } = makeTable();
  const server = await startMovaToolServer({ toolTable: table, token: TOKEN });
  t.after(() => server.close());
  return { ...server, seen };
}

function post(url, body, { token = TOKEN, headers = {} } = {}) {
  const final = { 'content-type': 'application/json', ...headers };
  if (token !== null) final.authorization = `Bearer ${token}`;
  return fetch(url, { method: 'POST', headers: final, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

function call(url, method, params) {
  return post(url, { jsonrpc: '2.0', id: 1, method, params });
}

test('the server only listens on 127.0.0.1', async t => {
  const server = await withServer(t);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'URL 必须指向回环地址的 /mcp');
  assert.ok(server.port > 0, 'port:0 应由系统分配一个真实端口');
  assert.equal(server.token, TOKEN, 'token 原样带回给调用方');
});

test('a request without a token is rejected with 401', async t => {
  const server = await withServer(t);
  const response = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null });
  assert.equal(response.status, 401, '没有 Authorization 必须 401');
});

test('a wrong token is rejected without echoing either token', async t => {
  const server = await withServer(t);
  const wrong = 'test-token-ffffffffffff';
  const response = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: wrong });
  assert.equal(response.status, 401, '错误 token 必须 401');
  const text = await response.text();
  assert.ok(!text.includes(TOKEN), '响应体不能回显正确 token');
  assert.ok(!text.includes(wrong), '响应体不能回显错误 token');
});

test('initialize advertises the tools capability', async t => {
  const server = await withServer(t);
  const response = await call(server.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.equal(typeof body.result.capabilities.tools, 'object', 'initialize 必须声明 tools 能力');
  assert.equal(body.result.serverInfo.name, 'mova-tools', 'serverInfo.name 应为 mova-tools');
  assert.equal(body.result.protocolVersion, '2025-06-18', '应回显客户端请求的协议版本');
});

test('tools/list returns the injected tools', async t => {
  const server = await withServer(t);
  const body = await (await call(server.url, 'tools/list', {})).json();
  const names = body.result.tools.map(tool => tool.name);
  assert.ok(names.includes('mova_read_file'), '应返回注入的文件工具');
  assert.ok(names.includes('mova_tools_search'), '发现工具应在列表里');
  assert.ok(!names.includes('mova_apply_patch'), '缺 handler 的工具不应出现');
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 应带 object schema`);
  }
});

test('tools/call returns tool content', async t => {
  const server = await withServer(t);
  const body = await (await call(server.url, 'tools/call', { name: 'mova_read_file', arguments: { path: 'notes.md' } })).json();
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(body.result.isError, undefined, '正常结果不带 isError');
  assert.equal(payload.path, 'notes.md');
  assert.equal(payload.content, 'hello from mova');
});

test('a failing handler still answers 200 with isError', async t => {
  const server = await withServer(t);
  const response = await call(server.url, 'tools/call', { name: 'mova_write_file', arguments: { path: 'a.txt', content: 'x' } });
  assert.equal(response.status, 200, '工具失败不能变成 HTTP 错误');
  const body = await response.json();
  assert.equal(body.result.isError, true, '结果应标记 isError');
  assert.match(body.result.content[0].text, /审批被拒绝/);
});

test('tools/call without a tool name is invalid params', async t => {
  const server = await withServer(t);
  const body = await (await call(server.url, 'tools/call', { arguments: {} })).json();
  assert.equal(body.error.code, -32602, '缺 name 应回 -32602');
});

test('an unknown method answers -32601', async t => {
  const server = await withServer(t);
  const body = await (await call(server.url, 'resources/list', {})).json();
  assert.equal(body.error.code, -32601, '未实现的方法应回 -32601');
});

test('invalid json answers -32700', async t => {
  const server = await withServer(t);
  const response = await post(server.url, '{"jsonrpc": "2.0", ');
  const body = await response.json();
  assert.equal(body.error.code, -32700, '非法 JSON 应回 -32700');
  assert.equal(body.id, null, '解析失败时 id 为 null');
});

test('a body over 1 MB is refused with 413', async t => {
  const server = await withServer(t);
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mova_read_file', arguments: { path: 'x'.repeat(1_200_000) } } });
  const response = await post(server.url, huge);
  assert.equal(response.status, 413, '超过 1MB 必须 413');
});

test('a notification without an id is accepted without a body', async t => {
  const server = await withServer(t);
  const response = await post(server.url, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response.status, 202, '通知应回 202');
  assert.equal(await response.text(), '', '通知不应有响应体');
});

test('GET on the endpoint is refused with 405', async t => {
  const server = await withServer(t);
  const response = await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 405, '只支持 POST');
  assert.equal(response.headers.get('allow'), 'POST');
});

test('不传 context 时 tools/call 的 ctx 与改造前一致（只有 transport）', async t => {
  const server = await withServer(t);
  const body = await (await call(server.url, 'tools/call', { name: 'mova_web_search', arguments: { query: 'q' } })).json();
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(server.seen[0].ctx, { transport: 'http' }, '旧行为不能变：只带 transport');
});

test('context 传对象：signal / callId 合并进 ctx，transport 仍是 http', async t => {
  const { table, seen } = makeTable();
  const controller = new AbortController();
  const server = await startMovaToolServer({
    toolTable: table,
    token: TOKEN,
    context: { transport: 'http', signal: controller.signal, callId: 'mcp-42' },
  });
  t.after(() => server.close());

  const body = await (await call(server.url, 'tools/call', { name: 'mova_web_search', arguments: { query: 'q' } })).json();
  assert.equal(body.result.isError, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ctx.transport, 'http', '传输仍是 http');
  assert.equal(seen[0].ctx.signal, controller.signal, 'signal 必须真的交给 handler（取消要能透传）');
  assert.equal(seen[0].ctx.callId, 'mcp-42', 'callId 用于前端同一行原地更新');
});

test('context 传函数：每次调用现算（含本轮 signal），畸形返回值不影响调用', async t => {
  const { table, seen } = makeTable();
  const controller = new AbortController();
  let asked = 0;
  const server = await startMovaToolServer({
    toolTable: table,
    token: TOKEN,
    context: ({ name }) => {
      asked += 1;
      if (name === 'mova_read_file') return null; // 接线层拿不到上下文：退回默认 ctx，不能报协议错
      return { transport: 'http', signal: controller.signal, callId: `call-${asked}` };
    },
  });
  t.after(() => server.close());

  await call(server.url, 'tools/call', { name: 'mova_web_search', arguments: { query: 'a' } });
  await call(server.url, 'tools/call', { name: 'mova_read_file', arguments: { path: 'x.md' } });
  assert.equal(seen[0].ctx.signal, controller.signal);
  assert.equal(seen[0].ctx.callId, 'call-1');
  assert.equal(asked, 2, '每次 tools/call 都要现算上下文');
});

test('close() stops accepting connections and is idempotent', async () => {
  const { table } = makeTable();
  const server = await startMovaToolServer({ toolTable: table, token: TOKEN });
  const ok = await call(server.url, 'tools/list', {});
  assert.equal(ok.status, 200, '关闭前应可访问');
  await server.close();
  await server.close(); // 幂等：重复关闭不应抛
  await assert.rejects(
    call(server.url, 'tools/list', {}),
    'close() 之后的连接必须被拒绝',
  );
});
