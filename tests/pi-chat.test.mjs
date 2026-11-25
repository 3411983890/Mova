import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChatAgent } from '../electron/chat-agent.mjs';
import { searchWeb } from '../electron/anysearch.cjs';
import { canonicalPath, createPermissionStore } from '../electron/permissions.cjs';

const entry = { id: 'test-gateway-model', name: 'Test Gateway', vision: false, efforts: ['low', 'high', 'max'] };
const provider = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
const request = { thinking: 'deep', messages: [{ role: 'user', text: 'Find a public source.' }] };
const signal = () => new AbortController().signal;

function completion(deltas, finish) {
  const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n';
  return new Response(deltas.map(delta => chunk(delta)).join('') + chunk({}, finish) + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('Pi runs search, replays reasoning and tool result, and emits real trace events', async () => {
  const payloads = [];
  const events = [];
  await runChatAgent({
    key: 'test-key', searchKey: 'test-search-key', provider, entry, request, signal: signal(),
    emit: event => events.push(event),
    search: async (_key, query) => {
      assert.equal(query, 'public source');
      return [{ title: 'Example', url: 'https://example.org/source', snippet: 'Useful evidence' }];
    },
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) return completion([
        { role: 'assistant', reasoning_content: 'Find evidence.' },
        { tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"public' } }] },
        { tool_calls: [{ index: 0, function: { arguments: ' source"}' } }] },
      ], 'tool_calls');
      assert.equal(payloads.length, 2);
      return completion([{ content: 'Found the source.' }], 'stop');
    },
  });
  assert.equal(payloads[0].model, entry.id);
  assert.equal(payloads[0].reasoning_effort, 'max');
  // Goal tools ship on every run, so assert membership rather than position.
  const offered = payloads[0].tools.map(tool => tool.function.name);
  assert.ok(offered.includes('web_search'), `web_search must be offered: ${offered.join(',')}`);
  assert.ok(offered.includes('set_goal') && offered.includes('set_plan'), 'goal tools ship with every run');
  const continuation = payloads[1].messages;
  assert.equal(continuation.at(-2).reasoning_content, 'Find evidence.');
  assert.equal(continuation.at(-1).role, 'tool');
  assert.match(continuation.at(-1).content, /Useful evidence/);
  assert.deepEqual(events.map(event => event.type), ['thinking', 'search', 'search', 'text']);
  assert.equal(events[2].sources[0].url, 'https://example.org/source');
});

test('streams an Anthropic Messages provider and keeps text deltas', async () => {
  const events = [];
  let requestedUrl;
  let requestedHeaders;
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":6,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好，"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我是 Claude。"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  await runChatAgent({
    key: 'test-key', searchKey: undefined, signal: signal(),
    provider: { id: 'anthropic-test', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:9999' },
    entry: { id: 'claude-sonnet-5-5', name: 'Claude 5.5 Sonnet', vision: true, efforts: ['low', 'medium', 'high'] },
    request: { thinking: 'medium', messages: [{ role: 'user', text: '打个招呼' }] },
    emit: event => events.push(event),
    fetchModel: async (url, options) => {
      requestedUrl = String(url);
      requestedHeaders = options.headers;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.ok(requestedUrl.startsWith('http://127.0.0.1:9999/v1/messages'), requestedUrl);
  assert.equal(new Headers(requestedHeaders).get('x-api-key'), 'test-key');
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.text).join(''), '你好，我是 Claude。');
});

test('uses the model-provided effort level instead of a fixed depth', async () => {
  let payload;
  await runChatAgent({
    key: 'test-key', signal: signal(),
    provider, entry: { id: 'test-gateway-model', name: 'Test', vision: false, efforts: ['high', 'xhigh'] },
    request: { thinking: 'xhigh', messages: [{ role: 'user', text: 'hi' }] },
    emit: () => {},
    fetchModel: async (_url, options) => {
      payload = JSON.parse(options.body);
      return completion([{ content: 'ok' }], 'stop');
    },
  });
  assert.equal(payload.reasoning_effort, 'xhigh');
});

test('AnySearch rejects unsafe URLs and returns deduplicated public sources', async () => {
  const search = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { query: 'public source', max_results: 5 });
    assert.equal(options.redirect, 'error');
    return Response.json({ code: 0, data: { results: [
      { url: 'javascript:alert(1)', title: 'Invalid' },
      { url: 'http://127.0.0.1/test', title: 'Local' },
      { url: 'https://example.org/source', title: 'Example', snippet: 'Useful' },
      { url: 'https://example.org/source', title: 'Duplicate' },
    ] } });
  };
  assert.deepEqual(await searchWeb('test-key', 'public source', signal(), search), [
    { url: 'https://example.org/source', title: 'Example', snippet: 'Useful' },
  ]);
});

test('project tools and their scope reach the model only when a root is granted', async t => {
  const base = await mkdtemp(join(tmpdir(), 'mova-pi-project-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(base, 'notes.txt'), 'hello');
  const permissions = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async () => 'allow',
  });
  await permissions.register([{ path: base }]);
  const id = canonicalPath(base).id;

  const payloads = [];
  const run = async roots => {
    payloads.length = 0;
    await runChatAgent({
      key: 'test-key', provider, entry, signal: signal(),
      request: { thinking: 'low', messages: [{ role: 'user', text: '看看项目' }] },
      emit: () => {},
      permissions, projectRoots: roots,
      fetchModel: async (_url, options) => {
        payloads.push(JSON.parse(options.body));
        return completion([{ content: 'ok' }], 'stop');
      },
    });
    return payloads[0];
  };

  const withoutGrant = await run([await permissions.get(id)]);
  // Goal/plan tools are conversation state, not file access: they exist on every
  // run. This test is about project file scope, so compare everything else.
  // 顺序不是契约（工具定义来自 skills/packs 的 manifest 顺序），所以按集合比。
  const GOAL_TOOLS = ['set_goal', 'accept_goal', 'update_goal', 'set_plan'];
  const toolNames = payload => (payload.tools ?? []).map(tool => tool.function.name);
  const fileTools = payload => toolNames(payload).filter(name => !GOAL_TOOLS.includes(name));
  assert.deepEqual([...toolNames(withoutGrant)].sort(), [...GOAL_TOOLS].sort(),
    'goal tools are available without any folder grant');
  assert.deepEqual(fileTools(withoutGrant), [], 'no file tools without a granted capability');
  assert.match(JSON.stringify(withoutGrant.messages), /cannot access local files/);

  await permissions.setCapability({ rootId: id, capability: 'read', value: true });
  const granted = await run([await permissions.get(id)]);
  assert.deepEqual([...fileTools(granted)].sort(), [
    'find_symbol', 'git_diff', 'git_status', 'list_files', 'project_tree', 'read_file', 'search_files',
  ], '只读授权只能拿到读类文件工具');
  assert.match(JSON.stringify(granted.messages), /project folders/);
  assert.match(JSON.stringify(granted.messages), /never claim to have read/);
});

test('the agent loop executes an approved write and returns the tool result to the model', async t => {
  const base = await mkdtemp(join(tmpdir(), 'mova-pi-write-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const permissions = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => (request.mode === 'grant' ? 'allow' : 'once'),
  });
  await permissions.register([{ path: base }]);
  const id = canonicalPath(base).id;
  await permissions.setCapability({ rootId: id, capability: 'read', value: true });
  await permissions.setCapability({ rootId: id, capability: 'write', value: true });

  const payloads = [];
  await runChatAgent({
    key: 'test-key', provider, entry, signal: signal(),
    request: { thinking: 'low', messages: [{ role: 'user', text: '写一个文件' }] },
    emit: () => {},
    permissions, projectRoots: [await permissions.get(id)], sessionKey: 'test-session',
    // 技能层的写操作先过 approval-bridge（路径闸门 → 能力位 → 人工审批 → 审计），
    // 所以除了 permissions 还要给「谁来点头」：这里用直接放行的 broker 代表用户点了「允许一次」。
    approvals: { async ask() { return 'once'; } },
    sender: { id: 'test-window', isDestroyed: () => false, send() {} },
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) {
        return completion([{
          tool_calls: [{
            index: 0, id: 'call_write', type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'hello from the model' }) },
          }],
        }], 'tool_calls');
      }
      return completion([{ content: '已写入 note.txt。' }], 'stop');
    },
  });

  assert.equal(await readFile(join(base, 'note.txt'), 'utf8'), 'hello from the model');
  const toolMessage = payloads[1].messages.at(-1);
  assert.equal(toolMessage.role, 'tool');
  assert.match(toolMessage.content, /note\.txt/);
  assert.match(toolMessage.content, /hello from the model|bytes/);
});
