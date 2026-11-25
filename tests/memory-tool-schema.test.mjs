import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runChatAgent } from '../electron/chat-agent.mjs';

// 这一组测试守的是「提示说的能力 = 模型能传的参数 = 底层真正收到的值」这条链。
// 用 fetchModel 截获真实请求体，再用 stub 记录底层入参；不碰 Electron / 磁盘。
const { createAgentMemorySearch } = createRequire(import.meta.url)('../electron/services/agent-memory-search.cjs');

const entry = { id: 'memory-schema-model', name: 'Memory schema', vision: false, efforts: [] };
const provider = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };

function chunk(delta, finishReason) {
  return 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  }) + '\n\n';
}

function toolCallReply(name, args) {
  return new Response(
    chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function textReply(text) {
  return new Response(chunk({ content: text }, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

// 底层 memorySearch 的可记录替身：search 是函数本体，readSource 挂在属性上（与生产形状一致）。
function recordingMemory() {
  const searches = [];
  const reads = [];
  const search = async input => {
    searches.push(input);
    return [{ id: 'm1', text: '记忆命中' }];
  };
  search.readSource = async input => {
    reads.push(input);
    return { ok: true, id: input.id, mode: input.mode, text: '原文片段', nextOffset: null };
  };
  return { search, searches, reads };
}

async function capture({ memorySearch, toolName, toolArgs }) {
  let payload;
  let calls = 0;
  await runChatAgent({
    key: 'test', provider, entry, signal: new AbortController().signal,
    request: { messages: [{ role: 'user', text: '回忆一下之前的项目参数' }] },
    emit: () => {}, memorySearch,
    fetchModel: async (_url, options) => {
      payload = JSON.parse(options.body);
      calls += 1;
      return calls === 1 ? toolCallReply(toolName, toolArgs) : textReply('好的');
    },
  });
  return payload;
}

function systemText(payload) {
  return (payload.messages || [])
    .filter(message => message.role === 'system')
    .map(message => (typeof message.content === 'string'
      ? message.content
      : (message.content || []).map(part => part.text || '').join('')))
    .join('\n\n');
}

const toolsOf = payload => (payload.tools || []).map(tool => tool.function ?? tool);
const toolNamed = (payload, name) => toolsOf(payload).find(tool => tool.name === name);

test('memory_search declares the three source values and memory_read_source declares the three modes', async () => {
  const memory = recordingMemory();
  const payload = await capture({
    memorySearch: memory.search, toolName: 'memory_search', toolArgs: { query: '参数' },
  });
  const search = toolNamed(payload, 'memory_search');
  const readSource = toolNamed(payload, 'memory_read_source');
  assert.ok(search, 'memory_search 工具必须出现在本轮 payload 里');
  assert.ok(readSource, 'memory_read_source 工具必须出现在本轮 payload 里');
  assert.deepEqual(search.parameters.properties.source.enum, ['auto', 'memory', 'history'],
    'source 必须声明 auto/memory/history 三项，否则提示里的 source=history 会被 Schema 拒绝');
  assert.deepEqual(readSource.parameters.properties.mode.enum, ['message', 'around', 'conversation'],
    'mode 必须声明 message/around/conversation 三项');
  // 描述文案的单一来源是 packs/memory/manifest.mjs（技能层 SSOT）：这里只钉「写清了什么语义」，
  // 不钉具体措辞——中文/英文文案该由 manifest 决定，改文案不该连带改测试。
  assert.match(search.parameters.properties.source.description, /退回聊天历史/,
    'source 的说明要写清 auto 的回退语义');
  assert.match(readSource.parameters.properties.mode.description, /优先 message/,
    'mode 的说明要引导模型优先用最便宜的单条读取');
});

test('a memory_search request with source=history reaches the underlying search unchanged', async () => {
  const memory = recordingMemory();
  await capture({ memorySearch: memory.search, toolName: 'memory_search', toolArgs: { query: '项目参数', source: 'history' } });
  assert.equal(memory.searches.length, 1, '本轮应当只发起一次底层搜索');
  assert.equal(memory.searches[0].source, 'history', 'source 必须原样透传到底层 memorySearch');
});

test('a memory_read_source request with mode=conversation reaches readSource unchanged', async () => {
  const memory = recordingMemory();
  await capture({
    memorySearch: memory.search, toolName: 'memory_read_source',
    toolArgs: { id: 'm1', offset: 0, mode: 'conversation' },
  });
  assert.equal(memory.reads.length, 1, '本轮应当只读取一次原文');
  assert.equal(memory.reads[0].mode, 'conversation', 'mode 必须原样透传到底层 readSource');
  assert.equal(memory.reads[0].id, 'm1');
});

test('omitted source and mode fall back to auto and message instead of undefined', async () => {
  const memory = recordingMemory();
  await capture({ memorySearch: memory.search, toolName: 'memory_search', toolArgs: { query: '参数' } });
  assert.equal(memory.searches[0].source, 'auto', '不传 source 时默认 auto');
  const reads = recordingMemory();
  await capture({ memorySearch: reads.search, toolName: 'memory_read_source', toolArgs: { id: 'm1' } });
  assert.equal(reads.reads[0].mode, 'message', '不传 mode 时默认 message');
});

test('the memory prompt uses the same source and mode values as the schema', async () => {
  const memory = recordingMemory();
  const payload = await capture({ memorySearch: memory.search, toolName: 'memory_search', toolArgs: { query: '参数' } });
  const prompt = systemText(payload);
  assert.match(prompt, /source="history"/, '提示里必须用枚举里的 source 值');
  assert.match(prompt, /mode="conversation"/, '提示里必须写出枚举里的 mode 值');
  assert.match(prompt, /mode="around"/, '提示里必须写出 around 模式');
  assert.doesNotMatch(prompt, /request the full conversation only when needed/,
    '提示不能再用「full conversation」这种不在枚举里的措辞');
});

test('every declared source value is accepted by the executor and passed through', async () => {
  for (const source of ['auto', 'memory', 'history']) {
    const memory = recordingMemory();
    await capture({ memorySearch: memory.search, toolName: 'memory_search', toolArgs: { query: '参数', source } });
    assert.equal(memory.searches[0].source, source, `source=${source} 必须能透传到底是`);
  }
});

test('source=memory never falls back to chat history when no saved memory matches', async () => {
  const conversationId = JSON.stringify(['CodeMova', 'Beta', '预算记录']);
  const inputs = [];
  const repository = {
    settings: async () => ({ memoryEnabled: true }),
    async search(input) {
      inputs.push(input);
      if (!input.includeSessions) return [];
      return [{ kind: 'session', conversationId, messageId: 'turn-1', projectId: 'Beta', role: 'user', text: '预算为 30 Mbps。' }];
    },
    async readHistorySource() { return { messages: [] }; },
  };
  const search = createAgentMemorySearch(repository, { memoryScope: { projectId: 'Alpha', includeGlobal: true } }, true);
  const auto = await search({ query: '30 Mbps' });
  assert.equal(auto.length, 1, 'auto 在记忆零命中时仍应回退到历史');
  assert.equal(auto[0].kind, 'session');
  const historyCalls = inputs.filter(input => input.includeSessions === true).length;
  assert.deepEqual(await search({ query: '30 Mbps', source: 'memory' }), [],
    'source=memory 的语义是只搜记忆，零命中必须返回空而不是回退历史');
  assert.equal(inputs.filter(input => input.includeSessions === true).length, historyCalls,
    'source=memory 不应额外发起历史检索');
});
