import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChatAgent } from '../electron/chat-agent.mjs';

const entry = { id: 'context-model', name: 'Context', vision: false, efforts: [] };
const provider = { id: 'context', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
function completion(text) {
  const chunk = 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  }) + '\n\n';
  return new Response(chunk + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

test('long conversations are compacted before the provider without losing the newest request', async () => {
  const history = Array.from({ length: 700 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `older-${i} ` + 'x'.repeat(400) }));
  history.push({ role: 'user', text: '最新问题：继续当前任务' });
  let payload;
  await runChatAgent({
    key: 'test', provider, entry, request: { messages: history }, signal: new AbortController().signal,
    emit: () => {}, fetchModel: async (_url, options) => { payload = JSON.parse(options.body); return completion('好的'); },
  });
  assert.ok(payload.messages.length <= 102);
  assert.match(JSON.stringify(payload.messages.at(-1)), /最新问题：继续当前任务/);
  const serialized = JSON.stringify(payload.messages);
  assert.match(serialized, /Earlier conversation excerpts/);
  assert.match(serialized, /history-data/);
  // The excerpt keeps a few old head/tail messages only, never all 700.
  assert.ok((serialized.match(/older-\d+ /g) || []).length < 120);
});

test('memory_search is exposed as a tool and described as data, not instructions', async () => {
  let payload;
  let searches = 0;
  await runChatAgent({
    key: 'test', provider, entry, request: { messages: [{ role: 'user', text: '你记得我之前说的数字吗' }] },
    signal: new AbortController().signal, emit: () => {},
    memorySearch: async () => { searches++; return [{ id: 'm1', text: '1887' }]; },
    fetchModel: async (_url, options) => { payload = JSON.parse(options.body); return completion('1887'); },
  });
  assert.ok(payload.tools.some(tool => tool.function?.name === 'memory_search' || tool.name === 'memory_search'));
  assert.match(JSON.stringify(payload.messages), /Use memory_search/);
  assert.match(JSON.stringify(payload.messages), /Do not search automatically/);
  assert.equal(searches, 0);
  assert.doesNotMatch(JSON.stringify(payload.messages), /1887/);
});

test('model can make more than three focused memory searches in a turn', async () => {
  const queries = [];
  const payloads = [];
  const events = [];
  await runChatAgent({
    key: 'test', provider, entry, request: { messages: [{ role: 'user', text: '回忆几个项目细节' }] },
    signal: new AbortController().signal, emit: event => events.push(event),
    memorySearch: async ({ query }) => { queries.push(query); return [{ id: query, text: `result ${query}` }]; },
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      const index = payloads.length;
      if (index > 4) return completion('完成');
      const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n';
      return new Response(chunk({ tool_calls: [{ index: 0, id: `call${index}`, type: 'function',
        function: { name: 'memory_search', arguments: JSON.stringify({ query: `q${index}` }) } }] }, null)
        + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  assert.deepEqual(queries, ['q1', 'q2', 'q3', 'q4']);
  assert.match(JSON.stringify(payloads[4].messages), /result q4/);
  assert.equal(events.filter(event => event.type === 'memory' && event.status === 'done').length, 4);
});

test('oversize input is rejected with an actionable code, not truncated', async () => {
  await assert.rejects(runChatAgent({
    key: 'test', provider, entry, request: { messages: [{ role: 'user', text: 'x'.repeat(60001) }] },
    signal: new AbortController().signal, emit: () => {}, fetchModel: async () => completion('unused'),
  }), error => error.code === 'input_too_long');
});
