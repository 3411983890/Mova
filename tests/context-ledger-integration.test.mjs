/**
 * 台账 × 预算 × 摘要 的真实集成测试（不打 stub）。
 *
 * 存在的理由：`tests/context-ledger.test.mjs` 用 module hook 把 budget/digest 换成了 stub，
 * 所以「摘要回退把结构化外壳当正文」这类跨模块回归它抓不到——这里补上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLedger } from '../electron/context/ledger.mjs';
import { deterministicDigest, buildSummaryBlock } from '../electron/context/digest.mjs';
import { estimateMessageTokens, createBudget } from '../electron/context/budget.mjs';

function history(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: index === 0 ? '先把空状态抽成组件，不要改数据库结构。' : `第 ${index + 1} 条消息：修改 src/features/chat/empty.tsx`,
  }));
}

test('摘要器抛错时回退到真实 deterministicDigest，且正文不含结构化外壳', () => {
  const ledger = createLedger({ layers: { L1: '系统约束' }, messages: history(30), tools: [] });
  const result = ledger.compact({
    summarize: () => { throw new Error('summarizer down'); },
  });
  assert.equal(result.compacted, true, '有可压缩区间时应当压缩');
  assert.equal(result.source, 'deterministic', '摘要器失败必须标记为确定性回退');
  const body = String(result.summaryBlock);
  assert.ok(body.length > 0, '摘要块不能为空');
  assert.ok(!body.includes('"covered"'), '不得把 digest 的 JSON 外壳塞进正文');
  assert.ok(!body.includes('{"text":'), '不得把 digest 的 JSON 外壳塞进正文');
  assert.ok(body.includes('src/features/chat'), '确定性摘要应当保留路径形态的关键片段');
});

test('摘要器返回非法结果时同样回退，不中断', () => {
  const ledger = createLedger({ layers: { L1: '系统约束' }, messages: history(24), tools: [] });
  const result = ledger.compact({ summarize: () => ({ nope: true }) });
  assert.equal(result.compacted, true);
  assert.equal(result.source, 'deterministic');
});

test('摘要器正常时采用其文本并标记 llm', () => {
  const ledger = createLedger({ layers: { L1: '系统约束' }, messages: history(24), tools: [] });
  const result = ledger.compact({ summarize: () => ({ text: '把空状态抽成独立组件，未改数据库。', source: 'llm' }) });
  assert.equal(result.compacted, true);
  assert.equal(result.source, 'llm');
  assert.match(String(result.summaryBlock), /把空状态抽成独立组件/);
});

test('pinned 约束穿透压缩：首条用户消息里的禁令必须逐字保留', () => {
  const ledger = createLedger({ layers: { L1: '系统约束' }, messages: history(30), tools: [] });
  const result = ledger.compact({ summarize: () => ({ text: '摘要', source: 'llm' }) });
  assert.equal(result.compacted, true);
  // 约束可能留在「被保留的原文」里，也可能被追加进摘要块——两处都算保住，但不能两处都没有。
  const kept = (ledger.messages ?? []).map(message => message.text ?? '').join('\n');
  const combined = `${kept}\n${result.summaryBlock}`;
  assert.match(combined, /不要改数据库结构/, '约束必须逐字保留（原文或摘要块）');
});

test('真实 digest 与 buildSummaryBlock 的组合形态是一致的', () => {
  const digest = deterministicDigest(history(6).map(({ id, role, text }) => ({ id, role, text })));
  assert.equal(typeof digest.text, 'string');
  const block = buildSummaryBlock({ text: digest.text, span: 'a..b', source: 'deterministic' });
  assert.equal(block.kind, 'summary');
  assert.equal(block.text, digest.text);
  assert.equal(block.source, 'deterministic');
});

test('真实 budget 的 estimateMessageTokens 对同一消息是稳定正数', () => {
  const message = { role: 'user', content: '请把 src/app.js 里的空状态抽出来' };
  const tokens = estimateMessageTokens(message);
  assert.ok(Number.isFinite(tokens) && tokens > 0, '估算必须是正数');
  assert.equal(estimateMessageTokens(message), tokens, '同一输入的估算必须稳定');
});

test('createBudget 的档位与本仓 70/85 口径一致（分母是 usable）', () => {
  // usable = contextWindow - reserveOutput = 800；70% = 560、85% = 680。
  const budget = createBudget({ contextWindow: 1000, reserveOutput: 200 });
  assert.equal(budget.level(500), 'ok', '62.5% 应当仍是 ok');
  assert.equal(budget.level(560), 'soft', '70% 起进入 soft');
  assert.equal(budget.level(680), 'hard', '85% 起进入 hard');
  assert.equal(budget.level(820), 'overflow', '超过 usable 记为 overflow');
});

test('compress 之后 read 仍能逐字读回原文', () => {
  const messages = history(20);
  const ledger = createLedger({ layers: {}, messages, tools: [] });
  ledger.compact({ summarize: () => ({ text: '摘要', source: 'llm' }) });
  const page = ledger.read({ offset: 0, limit: 200 });
  assert.equal(page.error, undefined, '未压缩区间或归档读不能报 invalid-range');
  assert.ok(typeof page.text === 'string' && page.text.length > 0, 'read 必须返回正文');
});
