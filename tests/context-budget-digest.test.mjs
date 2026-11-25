import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimateTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  createBudget,
  calibrate,
} from '../electron/context/budget.mjs';
import {
  deterministicDigest,
  buildSummaryBlock,
  mergeSummaryBlocks,
  emergencyPlaceholder,
} from '../electron/context/digest.mjs';

// 固定一份 1000 窗口 / 200 输出预留的预算：usable=800，边界好算。
function budgetFixture(options = {}) {
  return createBudget({ contextWindow: 1000, reserveOutput: 200, ...options });
}

test('estimateTokens grows monotonically for Chinese, ASCII and fenced code', () => {
  for (const unit of ['中', 'a', '```\nconst a = 1;\n```']) {
    const short = estimateTokens(unit.repeat(50));
    const long = estimateTokens(unit.repeat(100));
    assert.ok(long > short, '字符数翻倍后估算必须增长');
    assert.equal(long, short * 2, '同一类内容线性增长，不能出现跳变');
  }
});

test('estimateTokens charges Chinese far more than the same count of ASCII characters', () => {
  const cjk = estimateTokens('中'.repeat(100));
  const ascii = estimateTokens('a'.repeat(100));
  assert.equal(cjk, 150, '100 个 CJK 字符按 1.5 token/字 计');
  assert.equal(ascii, 28, '100 个 ASCII 字符按 0.28 token/字符 计');
  assert.ok(cjk > ascii * 5, '中文不能按 ASCII 单价估，否则 70% 阈值会被吃穿');
});

test('fenced code is charged slightly above plain ASCII per character', () => {
  const body = 'const value = alpha + beta;';
  const asCode = estimateTokens('```\n' + body + '\n```');
  assert.ok(asCode > estimateTokens(body), '代码块（含符号）单价高于普通 ASCII');
});

test('estimateTokens treats empty and whitespace-only input as zero', () => {
  assert.equal(estimateTokens(''), 0, '空串是 0');
  assert.equal(estimateTokens('   \n\t '), 0, '纯空白是 0');
  assert.equal(estimateTokens(null), 0, 'null 是 0');
  assert.equal(estimateTokens(undefined), 0, 'undefined 是 0');
  assert.ok(estimateTokens(12345) >= 1, '非字符串也要给出保守估算');
});

test('every image block costs a fixed 800 tokens in either message shape', () => {
  const plain = { role: 'user', text: '看看这张图' };
  const base = estimateMessageTokens(plain);
  const historyShape = { role: 'user', text: '看看这张图', images: ['img-1'] };
  const providerShape = {
    role: 'user',
    content: [{ type: 'text', text: '看看这张图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
  };
  assert.equal(estimateMessageTokens(historyShape), base + 800, '历史形态（images id）按 800 固定开销');
  assert.equal(estimateMessageTokens(providerShape), base + 800, '请求形态（图片块）按同一固定开销');
  assert.equal(estimateMessageTokens({ ...historyShape, images: ['a', 'b'] }), base + 1600, '两张图翻倍');
});

test('estimateMessageTokens counts tool results and tool calls, not just text', () => {
  const toolResult = { role: 'toolResult', toolName: 'read_file', content: [{ type: 'text', text: '文件内容'.repeat(50) }] };
  assert.ok(estimateMessageTokens(toolResult) > estimateTokens('文件内容'.repeat(50)), '工具结果必须计入');
  const withCall = { role: 'assistant', content: [{ type: 'toolCall', name: 'read_file', arguments: { path: 'a.mjs' } }] };
  assert.ok(estimateMessageTokens(withCall) > 4, '工具调用参数也要计入');
});

test('estimateRequestTokens adds system, messages and tool schemas', () => {
  const messages = [{ role: 'user', text: '帮我改 tests/a.test.mjs' }];
  const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  assert.equal(estimateRequestTokens({}), 0, '空请求是 0');
  const messagesOnly = estimateRequestTokens({ messages });
  assert.ok(estimateRequestTokens({ system: '你是 Mova。', messages }) > messagesOnly, 'system 必须计入');
  assert.ok(estimateRequestTokens({ messages, tools }) > messagesOnly, '工具声明必须计入');
  assert.ok(messagesOnly > 10, '消息逐条计入，不能整体算 0');
});

test('level() maps 69.9%, 70%, 85% and over-100% to ok/soft/hard/overflow', () => {
  const budget = budgetFixture();
  const usable = budget.usable;
  assert.equal(usable, 800, '可用预算 = 窗口 - 输出预留');
  assert.equal(budget.level(usable * 0.699), 'ok', '69.9% 仍是 ok');
  assert.equal(budget.level(usable * 0.7), 'soft', '70% 进入 soft');
  assert.equal(budget.level(usable * 0.849), 'soft', '84.9% 仍是 soft');
  assert.equal(budget.level(usable * 0.85), 'hard', '85% 进入 hard');
  assert.equal(budget.level(usable), 'hard', '正好用满可用预算算 hard（输出还有预留）');
  assert.equal(budget.level(usable * 1.001), 'overflow', '超过可用预算即 overflow');
  assert.equal(budget.ratio(usable / 2), 0.5, 'ratio 以可用预算为分母');
  assert.equal(budget.remaining(usable * 0.7), 240, 'remaining 是可用预算的余量');
  assert.equal(budget.remaining(usable * 2), 0, 'remaining 不返回负数，溢出由 level 表达');
});

test('createBudget defaults the output reserve to 30% and validates its inputs', () => {
  const wide = createBudget({ contextWindow: 100_000 });
  assert.equal(wide.usable, 70_000, '默认预留 30% 给输出');
  assert.equal(wide.softAt, 49_000, 'soft 档的 token 位置要能直接给面板用');
  assert.throws(() => createBudget({}), /contextWindow/, '缺窗口必须早失败，不能按默认值静默估算');
  assert.throws(() => createBudget({ contextWindow: 0 }), /contextWindow/, '窗口必须为正');
  assert.throws(() => createBudget({ contextWindow: 1000, reserveOutput: 1000 }), /reserveOutput/, '输出预留吃掉整个窗口');
  const custom = budgetFixture({ thresholds: { soft: 0.6 } });
  assert.equal(custom.thresholds.soft, 0.6, '阈值可以单改 soft');
  assert.equal(custom.thresholds.hard, 0.85, '未指定的 hard 保持默认');
});

test('shouldCompact fires at soft for a first compaction and stays quiet below it', () => {
  const budget = budgetFixture();
  assert.equal(budget.shouldCompact(budget.usable * 0.5), false, 'ok 档不该触发压缩');
  assert.equal(budget.shouldCompact(budget.usable * 0.7), true, '首次到 70% 应该压缩');
  assert.equal(budget.shouldCompact(budget.usable * 0.9), true, 'hard 档必须压缩');
  assert.equal(budget.shouldCompact(budget.usable * 1.2), true, '溢出必须压缩');
});

test('hysteresis blocks a repeat compaction until usage falls 10 points below the last one', () => {
  const budget = budgetFixture();
  const options = { lastCompactAt: 1_763_000_000_000, lastUsed: 0.84 };
  assert.equal(budget.shouldCompact(budget.usable * 0.84, options), false, '压缩后用量没回落，不重复压缩');
  assert.equal(budget.shouldCompact(budget.usable * 0.75, options), false, '只回落 9 个百分点，仍属同一次压缩');
  assert.equal(budget.shouldCompact(budget.usable * 0.74, options), true, '低于 75%（回落满 10 个百分点）恢复可触发');
  assert.equal(budget.shouldCompact(budget.usable * 0.9, options), true, 'hard 档不受滞回限制，否则会溢出');
  assert.equal(budget.shouldCompact(budget.usable * 0.75, { lastCompactAt: null, lastUsed: 0.84 }), true, '没有压缩史时不套滞回');
  // lastUsed 允许直接给 token 数（调用方手里往往只有 token）。
  const inTokens = { lastCompactAt: 1_763_000_000_000, lastUsed: budget.usable * 0.84 };
  assert.equal(budget.shouldCompact(budget.usable * 0.75, inTokens), false, 'token 口径的 lastUsed 等价于比例口径');
});

test('calibrate returns a clamped EMA coefficient and defaults to 1', () => {
  assert.equal(calibrate(), 1, '没有观测量时保持 1');
  const raised = calibrate(2);
  assert.ok(raised > 1 && raised < 2, '一次观测按 EMA 部分吸收，不直接跳到 2');
  assert.equal(calibrate(2, { previous: 1, alpha: 1 }), 2, 'alpha=1 时直接采用观测量');
  assert.equal(calibrate(10, { previous: 1.2 }), 3, '系数上限 3');
  assert.equal(calibrate(0.01, { previous: 1, alpha: 1 }), 0.5, '系数下限 0.5');
  assert.equal(calibrate('nope', { previous: 1.4 }), 1.4, '非法观测值不改变既有系数');
});

test('deterministicDigest keeps concrete paths, commands and the tool result first line', () => {
  const messages = [
    { id: 'm1', role: 'user', text: '请把 tests/context-budget-digest.test.mjs 跑一遍，注意不要把中文注释删掉' },
    {
      id: 'm2',
      role: 'tool',
      name: 'run_command',
      status: 'done',
      text: '> node --test tests/context-budget-digest.test.mjs\n通过 18 个用例，耗时 1.2s',
    },
  ];
  const { text, covered } = deterministicDigest(messages);
  assert.match(text, /tests\/context-budget-digest\.test\.mjs/, '路径不能被摘要吃掉');
  assert.match(text, /node --test/, '命令必须保留');
  assert.match(text, /run_command/, '工具名要保留');
  assert.match(text, /^用户: /, '第一条是用户消息，时间顺序不能乱');
  assert.doesNotMatch(text, /耗时/, '工具结果只保留首行，细节靠 context_read 回查');
  assert.deepEqual(covered, ['m1', 'm2'], 'covered 按时间顺序给出真正写进摘要的消息 id');
});

test('deterministicDigest keeps only the first 80 characters of a user message', () => {
  const long = '这是一段很长的用户说明。'.repeat(20);
  const { text } = deterministicDigest([{ id: 'u1', role: 'user', text: long }]);
  assert.ok(text.includes(long.slice(0, 80)), '用户消息前 80 字必须逐字保留');
  assert.ok(!text.includes(long.slice(90)), '超出 80 字的部分不进入摘要');
  assert.ok(text.length <= 1200, '默认上限 1200 字符');
});

test('deterministicDigest drops the oldest lines first when over budget', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    role: 'user',
    text: `第 ${i} 条：请继续检查 src/features/chat/context-budget.mjs 这一处改动`,
  }));
  const { text, covered } = deterministicDigest(messages, { maxChars: 300 });
  assert.ok(text.length <= 300, '摘要不得超过 maxChars');
  assert.equal(covered.at(-1), 'm39', '最新的消息必须留下');
  assert.ok(!covered.includes('m0'), '最旧的消息先被丢掉');
  assert.deepEqual(covered, messages.slice(-covered.length).map(message => message.id), '留下的是连续的最新一段');
});

test('deterministicDigest is byte-identical on repeated runs and never mutates input', () => {
  const messages = [
    { id: 'a', role: 'user', text: '改一下 electron/context/budget.mjs 的阈值' },
    { id: 'b', role: 'assistant', text: '好的，先看 app.js:1499 的默认窗口，再跑 npm test' },
    { id: 'c', role: 'tool', name: 'read_file', status: 'error', text: 'ENOENT: no such file or directory' },
    { id: 'd', role: 'user', text: '继续' },
  ];
  const snapshot = structuredClone(messages);
  const first = deterministicDigest(messages, { maxChars: 400 });
  const second = deterministicDigest(messages, { maxChars: 400 });
  assert.equal(first.text, second.text, '同一输入两次输出必须字节相同');
  assert.deepEqual(first.covered, second.covered, 'covered 也必须稳定');
  assert.deepEqual(messages, snapshot, '摘要不得改动原文');
  assert.match(first.text, /失败/, '工具失败要标出来，否则摘要会误导后续模型');
});

test('deterministicDigest tolerates odd entries and empty spans', () => {
  assert.deepEqual(deterministicDigest([]), { text: '', covered: [] }, '空历史产出空摘要');
  assert.deepEqual(deterministicDigest(null), { text: '', covered: [] }, '非数组也不抛错');
  const { text, covered } = deterministicDigest([null, { role: 'system', text: '规则' }, { role: 'user', text: '你好' }]);
  assert.equal(text, '用户: 你好', 'system 与空条目不进摘要');
  assert.deepEqual(covered, ['idx:2'], '没有 id 的消息用索引兜底');
  assert.equal(deterministicDigest([{ role: 'user', text: 'x' }], { maxChars: 0 }).text, '', 'maxChars=0 时不留内容');
});

test('buildSummaryBlock always produces the same summary shape', () => {
  const block = buildSummaryBlock({ text: '  继续改 budget.mjs  ', span: { from: 2, to: 9 }, source: 'llm' });
  assert.deepEqual(block, { kind: 'summary', span: { from: 2, to: 9 }, source: 'llm', text: '继续改 budget.mjs' }, '字段与顺序稳定');
  const fallback = buildSummaryBlock({ text: 'x' });
  assert.equal(fallback.source, 'deterministic', '没有来源时标明这是程序抽取');
  assert.equal(fallback.span, null, '没有区间时为 null，交给调用方补');
  assert.deepEqual(buildSummaryBlock({ text: 'y', span: { from: 'x' } }).span, null, '坏区间被丢弃');
});

test('mergeSummaryBlocks keeps the newest blocks and honours maxChars', () => {
  const blocks = [
    buildSummaryBlock({ text: 'A'.repeat(900), span: { from: 0, to: 10 }, source: 'llm' }),
    buildSummaryBlock({ text: 'B'.repeat(900), span: { from: 10, to: 20 }, source: 'llm' }),
    buildSummaryBlock({ text: 'C'.repeat(900), span: { from: 20, to: 30 }, source: 'deterministic' }),
  ];
  const merged = mergeSummaryBlocks(blocks, { maxChars: 1000 });
  assert.ok(merged.text.length <= 1000, '合并结果不得超过 maxChars');
  assert.equal(merged.text.length, 1000, '装得下就装满，不要浪费预算');
  assert.ok(merged.text.endsWith('C'.repeat(900)), '最新的摘要必须完整保留');
  assert.ok(!merged.text.includes('A'), '最旧的摘要先被丢掉');
  assert.equal(merged.kind, 'summary', '合并结果仍是摘要锚点');
  assert.equal(merged.source, 'mixed', '来源不同时标 mixed');
  assert.deepEqual(merged.span, { from: 10, to: 30 }, 'span 覆盖保留下来的区间');
  assert.equal(mergeSummaryBlocks([]).text, '', '空输入产出空摘要');
});

test('emergencyPlaceholder replaces a tool result with a pointer to its tail', () => {
  const body = 'x'.repeat(50_000) + '最后一行：tests/a.test.mjs 通过';
  const message = { id: 'tool-7', name: 'read_file', role: 'tool', text: body };
  const placeholder = emergencyPlaceholder(message);
  assert.ok(placeholder.length < 200, '占位文本必须远小于原结果');
  assert.match(placeholder, /tool-7/, 'span id 要留在占位里，方便 context_read 回查');
  assert.match(placeholder, /read_file/, '工具名要留下，否则回查时不知道在找什么');
  assert.match(placeholder, /6000/, '必须写明可回查最后 6000 字符');
  assert.ok(!placeholder.includes('最后一行：'), '正文不再进入上下文');
  assert.equal(emergencyPlaceholder(message), placeholder, '同输入两次结果一致');
  assert.match(emergencyPlaceholder(message, { preview: 1200 }), /1200/, 'preview 可覆盖');
});
