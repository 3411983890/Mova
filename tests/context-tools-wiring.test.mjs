/**
 * 上下文工具的接线测试：模型**看得见**、**用得上**、**下一轮真生效**。
 *
 * 存在的理由：这三件事以前一件都不成立——
 * `context_status` / `context_compact` / `context_read` 在 chat-agent 里出现 0 次，
 * 所以用户问「能不能压缩上下文」，模型只能老实回答「不能」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runChatAgent, __contextTestHooks } from '../electron/chat-agent.mjs';

const entry = { id: 'ctx-tools-model', name: 'Ctx', vision: false, efforts: [], contextWindow: 200_000, maxTokens: 8_000 };
const provider = { id: 'ctx-tools', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };

function completion(text = '好的') {
  const chunk = `data: ${JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  })}\n\n`;
  return new Response(`${chunk}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** 造一段够长的历史：让 status 里出现真实 token 数，也让 compact 有区间可压。 */
function history(count = 24) {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index + 1} 轮：${'细节'.repeat(200)}`,
  }));
  messages.push({ role: 'user', text: '现在告诉我能不能压缩上下文' });
  return messages;
}

async function turn(request, capture) {
  await runChatAgent({
    key: 'test', provider, entry, request,
    signal: new AbortController().signal,
    emit: () => {},
    fetchModel: async (_url, options) => { capture.payload = JSON.parse(options.body); return completion(); },
  });
  return capture.payload;
}

function toolNames(payload) {
  return (payload.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean);
}

test('模型能看到三个上下文工具', async () => {
  const payload = await turn({ conversationId: 'conv-tools-1', messages: history() }, {});
  const names = toolNames(payload);
  for (const name of ['context_status', 'context_compact', 'context_read']) {
    assert.ok(names.includes(name), `工具列表里必须有 ${name}（实际：${names.join(', ')}）`);
  }
});

test('没有会话 key 时不暴露上下文工具（避免把摘要串到别的会话）', async () => {
  const payload = await turn({ messages: history(6) }, {});
  const names = toolNames(payload);
  assert.equal(names.includes('context_compact'), false, '没有 conversationId/sessionKey 时不应暴露');
});

test('工具描述是被动的模型也能看懂的「何时该调」', async () => {
  const payload = await turn({ conversationId: 'conv-tools-2', messages: history(6) }, {});
  const compact = (payload.tools ?? []).find(tool => (tool.function?.name ?? tool.name) === 'context_compact');
  const description = compact?.function?.description ?? compact?.description ?? '';
  assert.ok(description.length > 80, '描述不能只有一句话');
  // 文案的单一来源是 packs/context-ledger/manifest.mjs：这里钉「必须给出可判断的时机」，
  // 不钉具体措辞（触发阈值 / 下一次生效 / 什么时候别调，任一即可）。
  assert.match(description, /85%|context_status|next request|still short|budget/i,
    '必须点名触发条件或「什么时候别调」，否则模型只会瞎压');
});

test('applyPendingCompaction 只替换开头 N 条，并保留最新的一问一答', () => {
  const portable = { messages: history(10).map(message => ({ ...message })) };
  const next = __contextTestHooks.applyPendingCompaction(portable, { coveredCount: 5, summaryBlock: '摘要正文' });
  assert.equal(next.messages.length, portable.messages.length - 5 + 1, 'N 条换 1 条');
  assert.match(next.messages[0].text, /\[上下文摘要\] 摘要正文/, '摘要必须在最前面');
  const tail = next.messages.at(-1).text;
  assert.match(tail, /现在告诉我能不能压缩上下文/, '最新一条用户消息必须原样保留');
});

test('applyPendingCompaction 的退化输入原样返回', () => {
  const portable = { messages: history(4) };
  assert.equal(__contextTestHooks.applyPendingCompaction(portable, null), portable, '没有 payload 不动');
  assert.equal(__contextTestHooks.applyPendingCompaction(portable, { summaryBlock: '' }), portable, '空摘要不动');
  assert.equal(__contextTestHooks.applyPendingCompaction(portable, { coveredCount: 0, summaryBlock: 'x' }), portable, '0 条不动');
  // 想压掉全部时也要至少留两条
  const aggressive = __contextTestHooks.applyPendingCompaction(portable, { coveredCount: 99, summaryBlock: 'x' });
  assert.ok(aggressive.messages.length >= 2, '不能把整段历史都压没');
});

test('上一轮压过之后，下一次请求真的带上摘要（且只生效一次）', async () => {
  const conversationId = 'conv-tools-e2e';
  const messages = history(20);
  const baseline = await turn({ conversationId, messages }, {});
  const beforeCount = baseline.messages.length;

  // 模拟模型上一轮调用了 context_compact：写一条待生效压缩
  __contextTestHooks.pendingCompactions.set(conversationId, {
    summaryBlock: '这里是上一段对话的摘要：用户在做 CLI 模型设置页。',
    coveredIds: ['m1', 'm2', 'm3'],
    coveredCount: 6,
    source: 'deterministic',
    createdAt: Date.now(),
    archive: [],
  });

  const after = await turn({ conversationId, messages }, {});
  const joined = JSON.stringify(after.messages);
  assert.match(joined, /\[上下文摘要\]/, '下一次请求必须带上摘要块');
  assert.ok(after.messages.length < beforeCount, `压缩后消息数应当减少（${beforeCount} → ${after.messages.length}）`);

  // 一次性：再下一轮不应重复出现
  const afterAgain = await turn({ conversationId, messages }, {});
  assert.doesNotMatch(JSON.stringify(afterAgain.messages), /\[上下文摘要\]/, '待生效压缩只能用一次');
});

test('不同会话互不影响', async () => {
  __contextTestHooks.pendingCompactions.set('conv-A', {
    summaryBlock: 'A 的摘要', coveredCount: 4, source: 'deterministic', createdAt: Date.now(), archive: [],
  });
  const other = await turn({ conversationId: 'conv-B', messages: history(16) }, {});
  assert.doesNotMatch(JSON.stringify(other.messages), /A 的摘要/, 'B 会话不能拿到 A 的摘要');
  // 清掉残留，避免影响其它用例
  __contextTestHooks.pendingCompactions.take('conv-A');
});
