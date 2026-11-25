// Mova 工具表（electron/mcp/tools.mjs）的单元测试。
// 全部纯内存：handler 由测试注入，因此不依赖 Electron、磁盘或网络。
// 断言偏「模型真正看到的东西」：list() 的形状、描述行数、结果文本长度与错误文案。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORE_TOOL_NAMES, createToolTable, describeAll } from '../electron/mcp/tools.mjs';

function tableWith(handlers) {
  return createToolTable({ handlers });
}

function names(list) {
  return list.map(tool => tool.name);
}

test('CORE_TOOL_NAMES lists the twelve default-exposed tools', () => {
  assert.equal(CORE_TOOL_NAMES.length, 12, '默认暴露的工具应为 12 个');
  for (const name of CORE_TOOL_NAMES) {
    assert.match(name, /^mova_[a-z_]+$/, `工具名应带 mova_ 前缀：${name}`);
  }
  assert.ok(CORE_TOOL_NAMES.includes('mova_read_file'), '必须包含 mova_read_file');
  assert.ok(CORE_TOOL_NAMES.includes('mova_tools_search'), '发现工具必须默认暴露');
});

test('every tool description stays within two lines', () => {
  const rows = describeAll();
  assert.ok(rows.length >= 12, '目录应至少有 12 项');
  for (const row of rows) {
    assert.equal(typeof row.description, 'string', `${row.name} 缺少描述`);
    assert.ok(row.description.trim().length > 0, `${row.name} 描述为空`);
    assert.ok(
      row.description.split('\n').length <= 2,
      `${row.name} 的描述超过 2 行：${row.description}`,
    );
  }
});

test('list() only exposes tools that have a handler', () => {
  const table = tableWith({
    mova_read_file: async () => 'ok',
    mova_web_search: async () => 'ok',
  });
  const listed = names(table.list());
  assert.deepEqual(
    listed,
    ['mova_read_file', 'mova_web_search', 'mova_tools_search'],
    '未提供 handler 的工具必须从 list() 里剔除',
  );
  assert.ok(!listed.includes('mova_write_file'), '缺 handler 的写工具不应出现');
});

test('list() items carry only the MCP tool fields', () => {
  const table = tableWith({ mova_list_files: async () => 'ok' });
  for (const item of table.list()) {
    assert.deepEqual(Object.keys(item).sort(), ['description', 'inputSchema', 'name'], '工具条目应只有 name/description/inputSchema');
    assert.equal(item.inputSchema.type, 'object', `${item.name} 的 schema 应为 object`);
    assert.equal(item.inputSchema.additionalProperties, false, `${item.name} 的 schema 应禁止额外字段`);
    assert.ok(!('risk' in item), '内部字段 risk 不应出现在 MCP 形状里');
    assert.ok(!('core' in item), '内部字段 core 不应出现在 MCP 形状里');
  }
});

test('a table with no handlers still exposes the discovery tool', () => {
  const table = createToolTable();
  assert.equal(table.list().length, 1, '没有 handler 时只应剩发现工具');
  assert.equal(table.list()[0].name, 'mova_tools_search');
});

test("search('文件') hits the file tools", () => {
  const table = tableWith({
    mova_read_file: async () => 'ok',
    mova_list_files: async () => 'ok',
    mova_write_file: async () => 'ok',
    mova_apply_patch: async () => 'ok',
    mova_web_search: async () => 'ok',
  });
  const hits = names(table.search('文件'));
  assert.ok(hits.includes('mova_read_file'), '应命中 mova_read_file');
  assert.ok(hits.includes('mova_list_files'), '应命中 mova_list_files');
  assert.ok(hits.length <= 8, '搜索结果不得超过 8 个');
});

test('search() ranks name matches and caps the result at eight', () => {
  const handlers = Object.fromEntries(CORE_TOOL_NAMES.map(name => [name, async () => 'ok']));
  const table = tableWith(handlers);
  const web = names(table.search('web'));
  assert.deepEqual(web.slice(0, 2).sort(), ['mova_web_read', 'mova_web_search'], 'web 应优先命中两个联网工具');

  const empty = table.search('   ');
  assert.equal(empty.length, 8, '空 query 应返回前 8 个');
  assert.equal(empty[0].name, 'mova_read_file', '空 query 按目录顺序返回');
});

test('call() reports unknown tools instead of throwing', async () => {
  const table = tableWith({ mova_read_file: async () => 'ok' });
  const result = await table.call('mova_does_not_exist', {});
  assert.equal(result.isError, true, '未知工具必须返回 isError');
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /unknown_tool/, '错误码应写进文本');
});

test('call() reports a tool that has no handler as unknown', async () => {
  const table = tableWith({ mova_read_file: async () => 'ok' });
  const result = await table.call('mova_delete_path', { path: 'a.txt' });
  assert.equal(result.isError, true, '未启用的工具不能被执行');
  assert.match(result.content[0].text, /unknown_tool/);
});

test('a throwing handler is folded into an isError result with its message', async () => {
  const table = tableWith({
    mova_write_file: async () => {
      throw new Error('磁盘满了 permission denied');
    },
  });
  const result = await table.call('mova_write_file', { path: 'a.txt', content: 'x' });
  assert.equal(result.isError, true, 'handler 抛错应收敛成 isError');
  assert.match(result.content[0].text, /磁盘满了 permission denied/, '文案必须含原始 message 摘要');
  assert.match(result.content[0].text, /tool_failed/);
});

test('plain object results are serialised as json text', async () => {
  const table = tableWith({ mova_list_files: async () => ({ entries: [{ name: 'a.txt' }], truncated: false }) });
  const result = await table.call('mova_list_files', {});
  assert.equal(result.isError, undefined, '正常结果不应带 isError');
  assert.deepEqual(JSON.parse(result.content[0].text), { entries: [{ name: 'a.txt' }], truncated: false });
});

test('mcp-shaped results pass through, including isError', async () => {
  const table = tableWith({
    mova_read_file: async () => ({ content: [{ type: 'text', text: 'hello' }], isError: true }),
  });
  const result = await table.call('mova_read_file', { path: 'a.txt' });
  assert.equal(result.isError, true, 'isError 应透传');
  assert.equal(result.content[0].text, 'hello');
});

test('oversized text is truncated to 8k with a note', async () => {
  const table = tableWith({ mova_read_file: async () => 'x'.repeat(20_000) });
  const result = await table.call('mova_read_file', { path: 'big.txt' });
  const text = result.content[0].text;
  assert.ok(text.length <= 8_192, `截断后长度不得超过 8192，实际 ${text.length}`);
  assert.match(text, /已截断/, '截断结果必须带说明');
  assert.match(text, /20000/, '说明里应保留原始字符数');
});

test('oversized mcp content items are truncated too', async () => {
  const table = tableWith({ mova_web_read: async () => ({ content: [{ type: 'text', text: 'y'.repeat(9_000) }] }) });
  const result = await table.call('mova_web_read', { url: 'https://example.com' });
  assert.ok(result.content[0].text.length <= 8_192, 'content 里的文本也要截断');
  assert.match(result.content[0].text, /已截断/);
});

test('mova_tools_search works without a handler and returns schema summaries', async () => {
  const table = tableWith({ mova_read_file: async () => 'ok' });
  const result = await table.call('mova_tools_search', { query: '文件' });
  assert.equal(result.isError, undefined, '发现工具不应报错');
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.hidden, [], '当前构建没有未默认暴露的工具');
  assert.ok(Array.isArray(payload.matches), 'matches 应为数组');
  assert.ok(payload.matches.some(item => item.name === 'mova_read_file'), 'query 应能查回 schema');
  const hit = payload.matches.find(item => item.name === 'mova_read_file');
  assert.equal(hit.inputSchema.type, 'object', '每条匹配都要带输入 schema');
  assert.match(payload.note, /12 个核心工具/, '没有可发现工具时要说明原因');
});

test('has() follows handler availability and accepts names without the prefix', () => {
  const table = tableWith({ read_file: async () => 'ok' });
  assert.equal(table.has('mova_read_file'), true, '省略前缀注入的 handler 也应可用');
  assert.equal(table.has('read_file'), true, 'has 支持省略前缀');
  assert.equal(table.has('mova_write_file'), false, '缺 handler 的工具应不可用');
});
