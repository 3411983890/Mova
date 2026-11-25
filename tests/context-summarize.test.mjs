/**
 * LLM 摘要器（electron/context/summarize.mjs）与接线（wiring）的注入测试。
 *
 * 关注点只有三条：
 * 1. 进模型的输入已脱敏、限长，且上一段摘要被带入；
 * 2. 模型输出不可信——围栏/废话/字段缺失要容错，彻底非法要回退，绝不抛；
 * 3. wiring 有摘要器用摘要器、没有就保持既有确定性路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUMMARY_SCHEMA_HINT,
  buildSummaryPrompt,
  parseSummary,
  summarizeText,
  createLlmSummarizer,
} from '../electron/context/summarize.mjs';
import { applyContextLedger } from '../electron/context/wiring.mjs';

/** 造一个可记录每次请求的假 fetchModel；replies 里放对象或 Error。 */
function fakeModel(replies) {
  const calls = [];
  const fetchModel = async request => {
    calls.push(request);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetchModel, calls };
}

function summaryReply(summary, extra = {}) {
  return { text: JSON.stringify(summary), ...extra };
}

const FULL_SUMMARY = {
  goal: '把设置页拆成独立面板',
  constraints: ['不要改数据库结构', '保持 4000 字符上限'],
  decisions: [{ what: '先做只读面板', why: '用户要求先看效果', at: 'm8' }],
  done: [{ what: '拆出 chat-usage.js', evidence: 'write 成功，tests 未跑' }],
  open: ['未跑 npm test'],
  artifacts: [{ path: 'app.js', change: 'edited', note: '新增 bindChatContext' }],
  facts: [{ claim: '上下文窗口默认 1,000,000', source: 'app.js:1499' }],
  rejected: ['尝试复用 composer-usage.jsx，未接入'],
  nextStep: '补面板并跑测试',
};

// ---------------------------------------------------------------- buildSummaryPrompt

test('buildSummaryPrompt strips reasoning and turns images into a placeholder', () => {
  const { system, user } = buildSummaryPrompt({
    messages: [
      { role: 'assistant', text: '公开回答内容', reasoning: '秘密推理不该出现' },
      { role: 'assistant', content: [{ type: 'reasoning', text: '隐藏思考块' }, { type: 'text', text: '正文内容' }] },
      { role: 'user', text: '请看这张图', images: [{ data: 'AAAA' }] },
    ],
  });
  assert.ok(user.includes('公开回答内容'), '正文必须保留');
  assert.ok(!user.includes('秘密推理不该出现'), 'reasoning 字段不得进入摘要输入');
  assert.ok(!user.includes('隐藏思考块'), 'reasoning 内容块不得进入摘要输入');
  assert.ok(user.includes('[图片]'), '图片必须转成占位符');
  assert.ok(!user.includes('AAAA'), '图片数据不得出现在提示里');
  assert.ok(system.includes('JSON'), 'system 必须要求 JSON 输出');
});

test('buildSummaryPrompt truncates an over-long message to 400 chars', () => {
  const long = `开头${'长'.repeat(600)}结尾`;
  const { user } = buildSummaryPrompt({ messages: [{ role: 'user', text: long }] });
  const body = user.split('\n').find(line => line.startsWith('[m1]')).split(': ').slice(1).join(': ');
  assert.ok([...body].length <= 400, `单条必须截断到 400 字，实际 ${[...body].length}`);
  assert.ok(body.endsWith('…'), '截断必须带省略号');
  assert.ok(!user.includes('结尾'), '超出部分不得进入提示');
});

test('buildSummaryPrompt carries the previous summary inside the system prompt', () => {
  const previous = '上一段摘要：已经拆出 chat-usage.js';
  const { system, user } = buildSummaryPrompt({ previous, messages: [{ role: 'user', text: '继续' }], maxChars: 800 });
  assert.ok(system.includes(previous), 'previous 必须拼进 system');
  assert.ok(!user.includes(previous), 'previous 不该混进本轮原文');
  assert.ok(system.includes('800'), 'maxChars 预算必须写进提示');
  assert.ok(system.includes(SUMMARY_SCHEMA_HINT), 'schema 说明必须原样进 system');
});

// ---------------------------------------------------------------- parseSummary

test('parseSummary accepts plain JSON and normalizes every field', () => {
  const parsed = parseSummary(JSON.stringify(FULL_SUMMARY));
  assert.ok(parsed, '合法 JSON 必须解析成功');
  assert.equal(parsed.goal, FULL_SUMMARY.goal);
  assert.deepEqual(parsed.constraints, FULL_SUMMARY.constraints);
  assert.deepEqual(parsed.decisions, FULL_SUMMARY.decisions);
  assert.deepEqual(parsed.facts, FULL_SUMMARY.facts);
  assert.equal(parsed.nextStep, FULL_SUMMARY.nextStep);
});

test('parseSummary tolerates a ```json fence', () => {
  const parsed = parseSummary('```json\n{"goal":"目标 A"}\n```');
  assert.ok(parsed, '带围栏的输出必须能解析');
  assert.equal(parsed.goal, '目标 A');
});

test('parseSummary ignores prose before and after the object', () => {
  const parsed = parseSummary('好的，摘要如下：\n{"goal":"目标 B","open":["待跑测试"]}\n以上，请查收。');
  assert.ok(parsed, '前后废话不得导致解析失败');
  assert.equal(parsed.goal, '目标 B');
  assert.deepEqual(parsed.open, ['待跑测试']);
});

test('parseSummary fills missing fields with empty defaults', () => {
  const parsed = parseSummary('{"goal":"只有目标"}');
  assert.ok(parsed, '字段缺失仍应返回结构化摘要');
  assert.deepEqual(parsed.constraints, [], '缺失的数组字段必须是空数组');
  assert.deepEqual(parsed.done, []);
  assert.deepEqual(parsed.artifacts, []);
  assert.equal(parsed.nextStep, '', '缺失的字符串字段必须是空串');
});

test('parseSummary wraps a single value into the array field', () => {
  const parsed = parseSummary('{"constraints":"不要改数据库","done":"跑通测试"}');
  assert.deepEqual(parsed.constraints, ['不要改数据库'], '单值必须包成数组');
  assert.equal(parsed.done.length, 1);
  assert.equal(parsed.done[0].what, '跑通测试', '字符串项降级成 {what}');
});

test('parseSummary moves a fact without a source into open', () => {
  const parsed = parseSummary(JSON.stringify({
    facts: [{ claim: '有来源的断言', source: 'app.js:12' }, { claim: '没来源的断言' }],
  }));
  assert.deepEqual(parsed.facts, [{ claim: '有来源的断言', source: 'app.js:12' }], '无来源断言不得进 facts');
  assert.deepEqual(parsed.open, ['没来源的断言'], '无来源断言只能进 open');
});

test('parseSummary returns null on hopeless input instead of throwing', () => {
  for (const bad of ['', '完全不是 JSON', '[1,2,3]', 'null', '{"goal": }']) {
    assert.equal(parseSummary(bad), null, `非法输入必须返回 null：${bad}`);
  }
});

// ---------------------------------------------------------------- summarizeText

test('summarizeText renders the six groups in the documented order', () => {
  const text = summarizeText(FULL_SUMMARY);
  const order = ['目标：', '约束：', '已完成：', '未完成：', '关键产物：', '待办：'];
  const positions = order.map(label => text.indexOf(label));
  assert.ok(positions.every(index => index >= 0), '六组必须齐全');
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, '组的顺序必须固定');
  assert.match(text, /app\.js/, '关键产物必须带路径');
  assert.match(text, /不要改数据库结构/, '约束必须逐字保留');
});

test('summarizeText omits groups that have no content', () => {
  const text = summarizeText({ goal: '只做一件事' });
  assert.ok(text.includes('目标：'), '有内容的组必须输出');
  for (const label of ['约束：', '已完成：', '未完成：', '关键产物：', '待办：']) {
    assert.ok(!text.includes(label), `空组不得出现：${label}`);
  }
});

test('summarizeText keeps the whole text within maxChars', () => {
  const big = {
    goal: '目标'.repeat(200),
    constraints: Array.from({ length: 12 }, (_, i) => `约束 ${i} ${'长'.repeat(80)}`),
    done: Array.from({ length: 20 }, (_, i) => ({ what: `完成 ${i} ${'做'.repeat(60)}`, evidence: '证据' })),
    open: Array.from({ length: 20 }, (_, i) => `未完成 ${i}`),
    artifacts: Array.from({ length: 20 }, (_, i) => ({ path: `src/f${i}.ts`, change: 'edited' })),
    nextStep: '待办'.repeat(100),
  };
  assert.ok([...summarizeText(big)].length <= 1200, '默认预算 1200 必须守住');
  assert.ok([...summarizeText(big, { maxChars: 120 })].length <= 120, '自定义预算必须守住');
});

// ---------------------------------------------------------------- createLlmSummarizer

const COVERED = [
  { id: 'm1', role: 'user', text: '把设置页拆成独立面板，不要改数据库结构。' },
  { id: 'm2', role: 'assistant', text: '先拆出 chat-usage.js。' },
];

test('createLlmSummarizer uses the model output on first success and passes real usage through', async () => {
  const { fetchModel, calls } = fakeModel([summaryReply(FULL_SUMMARY, { usage: { input: 8123, output: 742 } })]);
  const summarize = await createLlmSummarizer({ fetchModel, model: { id: 'm' }, key: 'k' });
  const result = await summarize(COVERED);
  assert.equal(result.source, 'llm');
  assert.ok(result.text.includes('把设置页拆成独立面板'), '摘要正文必须来自模型输出');
  assert.deepEqual(result.usage, { input: 8123, output: 742 }, 'usage 必须透传服务端真值');
  assert.equal(calls.length, 1, '首次成功只应调用一次');
  assert.ok(calls[0].user.includes('不要改数据库结构'), '原文必须进 user');
  assert.equal(calls[0].purpose, 'compaction', '标记用途便于用量面板分列压缩开销');
});

test('createLlmSummarizer omits usage when the response has none', async () => {
  const { fetchModel } = fakeModel([summaryReply(FULL_SUMMARY)]);
  const summarize = await createLlmSummarizer({ fetchModel });
  const result = await summarize(COVERED);
  assert.equal(result.source, 'llm');
  assert.equal('usage' in result, false, '没有真值就不该出现 usage 键（不得用估算冒充）');
});

test('createLlmSummarizer retries once after invalid JSON and succeeds', async () => {
  const { fetchModel, calls } = fakeModel([{ text: '抱歉，我无法输出 JSON。' }, summaryReply(FULL_SUMMARY)]);
  const summarize = await createLlmSummarizer({ fetchModel, retries: 1 });
  const result = await summarize(COVERED);
  assert.equal(result.source, 'llm', '重试成功必须标为 llm');
  assert.equal(calls.length, 2, '必须重试一次');
  assert.ok(calls[1].user.includes('Output JSON only'), '重试必须追加「只输出 JSON」');
});

test('createLlmSummarizer falls back to deterministic text when both attempts are invalid', async () => {
  const { fetchModel, calls } = fakeModel([{ text: '不是 JSON' }, { text: '```json\n{坏掉的\n```' }]);
  const summarize = await createLlmSummarizer({ fetchModel, retries: 1 });
  const result = await summarize(COVERED);
  assert.equal(result.source, 'deterministic', '两次都非法必须回退');
  assert.ok(result.text.trim().length > 0, '回退文本必须非空');
  assert.ok(result.text.includes('不要改数据库结构'), '回退要尽量保住原文关键句');
  assert.equal(calls.length, 2, '重试次数必须有限');
  assert.equal('usage' in result, false, '回退路径没有真值用量');
});

test('createLlmSummarizer falls back when fetchModel throws, without throwing', async () => {
  const { fetchModel, calls } = fakeModel([new Error('network down'), new Error('rate limited')]);
  const summarize = await createLlmSummarizer({ fetchModel, retries: 1 });
  let result;
  await assert.doesNotReject(async () => { result = await summarize(COVERED); }, '摘要失败绝不能抛给上层');
  assert.equal(result.source, 'deterministic');
  assert.ok(result.text.trim().length > 0, '回退文本必须非空');
  assert.equal(calls.length, 2, '抛错也要在重试后停止');
});

test('createLlmSummarizer feeds the previous summary back into the next call', async () => {
  const { fetchModel, calls } = fakeModel([summaryReply(FULL_SUMMARY), summaryReply({ goal: '第二阶段' })]);
  const summarize = await createLlmSummarizer({ fetchModel });
  await summarize(COVERED);
  await summarize([{ id: 'm3', role: 'user', text: '继续' }]);
  assert.ok(calls[1].system.includes('把设置页拆成独立面板'), '上一段摘要必须拼进下一次的 system');
});

// ---------------------------------------------------------------- wiring × 摘要器

function heavyHistory(count = 40) {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index + 1} 轮：${'细节'.repeat(400)}`,
  }));
  messages.push({ role: 'user', text: '最新问题：把空状态抽成组件' });
  return messages;
}

const tinyModel = { id: 'ctx-model', name: 'Ctx', vision: false, efforts: [], contextWindow: 2000, maxTokens: 200 };

test('applyContextLedger uses the injected summarizer and reports source=llm', async () => {
  const portable = { messages: heavyHistory() };
  const events = [];
  const result = await applyContextLedger({
    portable,
    model: tinyModel,
    emit: event => events.push(event),
    env: { MOVA_CONTEXT_LEDGER: 'ledger' },
    summarize: () => ({ text: '把空状态抽成组件，未改数据库。', source: 'llm' }),
  });
  assert.notEqual(result, portable, '传了摘要器就必须真的压缩');
  assert.match(result.messages.map(m => m.text).join('\n'), /把空状态抽成组件/, '必须采用摘要器文本');
  const report = events.find(event => event.type === 'context')?.report;
  assert.ok(report?.compaction, '必须上报压缩');
  assert.equal(report.compaction.source, 'llm', '有摘要器时来源必须标为 llm');
});

test('applyContextLedger awaits an async summarizer and reports source=llm', async () => {
  // wiring 已改为异步：异步摘要器现在真的能拿到正文（同步版本只能回退确定性）。
  const portable = { messages: heavyHistory() };
  const events = [];
  const result = await applyContextLedger({
    portable,
    model: tinyModel,
    emit: event => events.push(event),
    env: { MOVA_CONTEXT_LEDGER: 'ledger' },
    summarize: async () => ({ text: '异步摘要', source: 'llm' }),
  });
  assert.notEqual(result, portable, '异步摘要器不能导致这一轮完全不压缩');
  assert.match(result.messages.map(m => m.text).join('\n'), /异步摘要/, '异步摘要的正文必须被采用');
  const report = events.find(event => event.type === 'context')?.report;
  assert.ok(report?.compaction, '必须仍有压缩上报');
  assert.equal(report.compaction.source, 'llm', '异步摘要器成功时来源是 llm');
});

test('applyContextLedger falls back to deterministic when the summarizer throws', async () => {
  const portable = { messages: heavyHistory() };
  const events = [];
  const result = await applyContextLedger({
    portable,
    model: tinyModel,
    emit: event => events.push(event),
    env: { MOVA_CONTEXT_LEDGER: 'ledger' },
    summarize: async () => { throw new Error('summarizer down'); },
  });
  assert.notEqual(result, portable, '摘要器失败也要压缩（回退确定性）');
  const report = events.find(event => event.type === 'context')?.report;
  assert.ok(report?.compaction, '必须仍有压缩上报');
  assert.equal(report.compaction.source, 'deterministic', '摘要器失败时回退确定性来源');
});

test('applyContextLedger keeps the deterministic source when no summarizer is passed', async () => {
  const portable = { messages: heavyHistory() };
  const events = [];
  await applyContextLedger({
    portable,
    model: tinyModel,
    emit: event => events.push(event),
    env: { MOVA_CONTEXT_LEDGER: 'ledger' },
  });
  const report = events.find(event => event.type === 'context')?.report;
  assert.ok(report?.compaction, '不传摘要器仍要压缩（既有行为不变）');
  assert.equal(report.compaction.source, 'deterministic', '不传摘要器必须保持确定性来源');
  assert.equal(report.estimated, true, '估算口径不变');
});
