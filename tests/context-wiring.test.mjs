/**
 * 上下文台账接线（wiring）测试。
 *
 * 两层验证：
 * 1. `applyContextLedger` 的三种模式语义（off 完全不介入 / report 只上报 / ledger 才压缩）；
 * 2. 经由 `runChatAgent` 的真实请求体断言——默认 off 时 payload 与改造前一致。
 *
 * 注意：本模块已改为**异步**（否则 LLM 摘要器拿不到正文），所有调用都要 await。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyContextLedger, contextLedgerMode } from '../electron/context/wiring.mjs';
import { runChatAgent } from '../electron/chat-agent.mjs';

const entry = { id: 'ctx-model', name: 'Ctx', vision: false, efforts: [] };
const provider = { id: 'ctx', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };

function completion(text) {
  const chunk = `data: ${JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  })}\n\n`;
  return new Response(`${chunk}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** 造一段会撑爆估算的历史（每条都很长）。 */
function heavyHistory(count = 40) {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index + 1} 轮：${'细节'.repeat(400)}`,
  }));
  messages.push({ role: 'user', text: '最新问题：把空状态抽成组件' });
  return messages;
}

function portableOf(messages) {
  return { messages: messages.map(message => ({ ...message })) };
}

test('contextLedgerMode：未知值一律按 off（环境变量写错不改变行为）', () => {
  assert.equal(contextLedgerMode({}), 'off');
  assert.equal(contextLedgerMode({ MOVA_CONTEXT_LEDGER: '' }), 'off');
  assert.equal(contextLedgerMode({ MOVA_CONTEXT_LEDGER: 'REPORT' }), 'report');
  assert.equal(contextLedgerMode({ MOVA_CONTEXT_LEDGER: ' ledger ' }), 'ledger');
  assert.equal(contextLedgerMode({ MOVA_CONTEXT_LEDGER: 'yes' }), 'off');
});

test('off：返回同一个对象引用，不 emit 任何事件', async () => {
  const portable = portableOf(heavyHistory());
  const events = [];
  const result = await applyContextLedger({ portable, model: entry, emit: event => events.push(event), env: {} });
  assert.equal(result, portable, 'off 必须原样返回（连复制都不做）');
  assert.equal(events.length, 0);
});

test('report：只上报真实口径，历史一字节不改', async () => {
  const portable = portableOf(heavyHistory());
  const events = [];
  const result = await applyContextLedger({
    portable, model: entry, emit: event => events.push(event), env: { MOVA_CONTEXT_LEDGER: 'report' },
  });
  assert.equal(result, portable, 'report 不能改历史');
  const report = events.find(event => event.type === 'context')?.report;
  assert.ok(report, '必须发出 context 事件');
  assert.equal(report.mode, 'report');
  assert.equal(report.estimated, true, '必须标注是估算值');
  assert.ok(report.tokens.before > 0, '必须给出 token 估算');
  assert.equal(report.messages.total, portable.messages.length);
  assert.equal(report.compaction, null, 'report 模式不产生压缩');
  assert.equal(report.layers.length, 6, '六层必须齐全');
});

test('ledger：超过硬阈值时把旧区间换成一条摘要，且保留最新一条用户消息', async () => {
  const portable = portableOf(heavyHistory());
  const events = [];
  const result = await applyContextLedger({
    portable,
    // 故意给一个很小的窗口，让估算进入 overflow。
    model: { ...entry, contextWindow: 2000, maxTokens: 200 },
    emit: event => events.push(event),
    env: { MOVA_CONTEXT_LEDGER: 'ledger' },
  });
  assert.notEqual(result, portable, 'ledger 模式应当改动历史');
  assert.ok(result.messages.length < portable.messages.length, '压缩后消息数必须减少');
  const joined = result.messages.map(message => message.text).join('\n');
  assert.match(joined, /\[上下文摘要\]/, '摘要消息必须带明确标记');
  assert.match(joined, /最新问题：把空状态抽成组件/, '最新一条用户消息必须逐字保留');
  const report = events.find(event => event.type === 'context')?.report;
  assert.ok(report?.compaction, '必须报告压缩结果');
  assert.ok(report.compaction.covered > 0, '必须报告覆盖了多少条');
});

test('ledger：窗口很大时不压缩（不打断正常对话）', async () => {
  const portable = portableOf(heavyHistory(6));
  const events = [];
  const result = await applyContextLedger({
    portable, model: { ...entry, contextWindow: 1_000_000, maxTokens: 128_000 },
    emit: event => events.push(event), env: { MOVA_CONTEXT_LEDGER: 'ledger' },
  });
  assert.equal(result, portable, '没有超阈值就不该动历史');
  assert.equal(events.find(event => event.type === 'context')?.report.compaction, null);
});

test('ledger + 摘要器：注入的 summarize 会被采用（source 走 llm）', async () => {
  const portable = portableOf(heavyHistory());
  const events = [];
  const result = await applyContextLedger({
    portable,
    model: { ...entry, contextWindow: 2000, maxTokens: 200 },
    emit: event => events.push(event),
    env: { MOVA_CONTEXT_LEDGER: 'ledger' },
    summarize: async () => ({ text: 'LLM 精修摘要：只保留关键结论。', source: 'llm' }),
  });
  const joined = result.messages.map(message => message.text).join('\n');
  assert.match(joined, /LLM 精修摘要/, '有摘要器时必须用它产出的正文');
  const report = events.find(event => event.type === 'context')?.report;
  assert.equal(report?.compaction?.source, 'llm');
});

test('畸形输入不抛异常：空历史与缺字段都原样返回', async () => {
  await assert.doesNotReject(() => applyContextLedger({ portable: null, env: { MOVA_CONTEXT_LEDGER: 'ledger' } }));
  const empty = { messages: [] };
  assert.equal(await applyContextLedger({ portable: empty, env: { MOVA_CONTEXT_LEDGER: 'ledger' } }), empty);
  const weird = { messages: [{ role: 'user' }, { role: 'assistant', text: 123 }] };
  await assert.doesNotReject(() => applyContextLedger({ portable: weird, model: entry, env: { MOVA_CONTEXT_LEDGER: 'report' } }));
});

test('端到端：默认未设环境变量时，发给 provider 的 payload 与既有行为一致', async () => {
  const savedLedger = process.env.MOVA_CONTEXT_LEDGER;
  const savedSummary = process.env.MOVA_CONTEXT_SUMMARY;
  delete process.env.MOVA_CONTEXT_LEDGER;
  delete process.env.MOVA_CONTEXT_SUMMARY;
  try {
    let payload = null;
    const events = [];
    await runChatAgent({
      key: 'test', provider, entry,
      request: { messages: heavyHistory(30) },
      signal: new AbortController().signal,
      emit: event => events.push(event),
      fetchModel: async (_url, options) => { payload = JSON.parse(options.body); return completion('好的'); },
    });
    assert.ok(payload, '必须真的发出请求');
    assert.equal(events.some(event => event.type === 'context'), false, '默认关闭时不应发出 context 事件');
    assert.match(JSON.stringify(payload.messages), /最新问题：把空状态抽成组件/);
  } finally {
    if (savedLedger === undefined) delete process.env.MOVA_CONTEXT_LEDGER;
    else process.env.MOVA_CONTEXT_LEDGER = savedLedger;
    if (savedSummary === undefined) delete process.env.MOVA_CONTEXT_SUMMARY;
    else process.env.MOVA_CONTEXT_SUMMARY = savedSummary;
  }
});

test('端到端：report 模式下 context 事件出现在对话事件流里', async () => {
  const saved = process.env.MOVA_CONTEXT_LEDGER;
  process.env.MOVA_CONTEXT_LEDGER = 'report';
  try {
    const events = [];
    await runChatAgent({
      key: 'test', provider, entry,
      request: { messages: heavyHistory(20) },
      signal: new AbortController().signal,
      emit: event => events.push(event),
      fetchModel: async () => completion('好的'),
    });
    const report = events.find(event => event.type === 'context')?.report;
    assert.ok(report, 'report 模式必须发出 context 事件');
    assert.equal(report.mode, 'report');
  } finally {
    if (saved === undefined) delete process.env.MOVA_CONTEXT_LEDGER;
    else process.env.MOVA_CONTEXT_LEDGER = saved;
  }
});
