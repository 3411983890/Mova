import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUOTE_LIMIT,
  QUOTE_TEXT_LIMIT,
  USER_TEXT_BUDGET,
  formatQuoteLine,
  mergeUserText,
  normalizeQuote,
  parseUserText,
  renderQuotes,
  withinUserBudget,
  fileRefOfLabel,
} from '../src/features/chat/quote-source.js';
import { canAddQuote, quoteSummary, quoteTitle } from '../src/features/chat/quote-chips.js';

const chat = (text, extra = {}) => normalizeQuote({ text, source: { kind: 'chat', ...extra } });

test('四种来源格式化：聊天 / 文件 / 网页 / 元素', () => {
  assert.equal(
    formatQuoteLine(chat('这段解释很清楚')),
    '[引用 · 助手回复] 这段解释很清楚',
  );
  assert.equal(
    formatQuoteLine(normalizeQuote({ text: 'const x = 1', source: { kind: 'file', path: 'src/app.js', line: 42 } })),
    '[引用 · 文件 src/app.js:42] const x = 1',
  );
  assert.equal(
    formatQuoteLine(normalizeQuote({ text: '页面上的这段文字', source: { kind: 'web', url: 'https://www.example.com/a?b=1' } })),
    '[引用 · 网页 example.com] 页面上的这段文字',
  );
  assert.equal(
    formatQuoteLine(normalizeQuote({ text: '立即购买', source: { kind: 'element', tag: 'button' } })),
    '[引用 · button · 立即购买] 立即购买',
  );
  // 显式 label 优先，缺字段也不抛错（右侧面板/网页可能只给一半字段）。
  assert.equal(
    formatQuoteLine(normalizeQuote({ text: '选中的元素', source: { kind: 'element', label: 'button · 立即购买' } })),
    '[引用 · button · 立即购买] 选中的元素',
  );
  assert.equal(formatQuoteLine(normalizeQuote({ text: '只有文本' })), '[引用 · 助手回复] 只有文本');
  assert.equal(normalizeQuote({ text: '   ' }), null);
  assert.equal(normalizeQuote(null), null);
});

test('chip 文案：来源 + 摘要，元素来源不重复拼文本', () => {
  assert.equal(quoteSummary(chat('这段解释很清楚')), '助手回复 · 这段解释很清楚');
  assert.equal(
    quoteSummary(normalizeQuote({ text: '立即购买', source: { kind: 'element', tag: 'button' } })),
    'button · 立即购买',
  );
  const long = normalizeQuote({ text: 'y'.repeat(600), source: { kind: 'file', path: 'src/app.js', line: 3 } });
  assert.ok(quoteSummary(long).startsWith('文件 src/app.js:3 · yyy'));
  assert.ok(quoteTitle(long).length <= 300);
});

test('1000 字截断：附「已截断，原 N 字」，且重复规范化不叠加', () => {
  const quote = chat('字'.repeat(1200));
  assert.equal(quote.text.slice(0, QUOTE_TEXT_LIMIT), '字'.repeat(QUOTE_TEXT_LIMIT));
  assert.match(quote.text, /……（已截断，原 1200 字）$/);
  const exact = chat('a'.repeat(QUOTE_TEXT_LIMIT));
  assert.equal(exact.text.length, QUOTE_TEXT_LIMIT);
  assert.ok(!exact.text.includes('已截断'));
  assert.equal(normalizeQuote(quote).text, quote.text);
  // 空白压缩：多行选区在引用行里只占一行
  assert.equal(chat('第一行\n\n第二行   第三行').text, '第一行 第二行 第三行');
});

test('去重：text + kind + label 相同不重复添加', () => {
  const first = { ...chat('重复的段落'), id: 'quote-1' };
  const same = chat(' 重复的段落 ');
  const other = normalizeQuote({ text: '重复的段落', source: { kind: 'file', path: 'a.md' } });
  assert.equal(canAddQuote([first], same).reason, 'duplicate');
  assert.equal(canAddQuote([first], other).ok, true);
  assert.equal(canAddQuote([], null).reason, 'empty');
});

test('上限：同一草稿最多 5 条', () => {
  assert.equal(QUOTE_LIMIT, 5);
  const list = Array.from({ length: QUOTE_LIMIT }, (_, index) => ({ ...chat(`第 ${index} 段`), id: `quote-${index}` }));
  assert.equal(canAddQuote(list, chat('第 6 段')).reason, 'limit');
  assert.equal(canAddQuote(list.slice(0, QUOTE_LIMIT - 1), chat('第 5 段')).ok, true);
  // 渲染同样只认前 5 条
  const lines = renderQuotes(Array.from({ length: 7 }, (_, index) => chat(`第 ${index} 段`)));
  assert.equal(lines.split('\n').length, QUOTE_LIMIT);
});

test('parseUserText：正常解析开头引用行 + 正文', () => {
  const merged = mergeUserText([
    chat('这段解释很清楚'),
    normalizeQuote({ text: 'const x = 1', source: { kind: 'file', path: 'src/app.js', line: 42 } }),
  ], '我自己输入的问题');
  assert.equal(merged, [
    '[引用 · 助手回复] 这段解释很清楚',
    '[引用 · 文件 src/app.js:42] const x = 1',
    '',
    '我自己输入的问题',
  ].join('\n'));
  const parsed = parseUserText(merged);
  assert.equal(parsed.matched, true);
  assert.deepEqual(parsed.quotes.map(quote => quote.label), ['助手回复', '文件 src/app.js:42']);
  assert.deepEqual(parsed.quotes.map(quote => quote.text), ['这段解释很清楚', 'const x = 1']);
  assert.equal(parsed.body, '我自己输入的问题');
  // 只有引用、没有正文
  const onlyQuotes = parseUserText(renderQuotes([chat('只有引用')]));
  assert.equal(onlyQuotes.matched, true);
  assert.equal(onlyQuotes.body, '');
});

test('parseUserText：越界（超过 5 行）只认前 5 行，其余留作正文', () => {
  const lines = Array.from({ length: 7 }, (_, index) => `[引用 · 助手回复] 第 ${index} 段`);
  const parsed = parseUserText(`${lines.join('\n')}\n\n正文`);
  assert.equal(parsed.matched, true);
  assert.equal(parsed.quotes.length, 5);
  assert.equal(parsed.quotes.at(-1).text, '第 4 段');
  assert.match(parsed.body, /^\[引用 · 助手回复\] 第 5 段/);
  assert.match(parsed.body, /正文$/);
});

test('parseUserText：不匹配整段按原文显示', () => {
  const plain = '这不是引用\n只是普通文本';
  const parsed = parseUserText(plain);
  assert.equal(parsed.matched, false);
  assert.equal(parsed.body, plain);
  assert.equal(parsed.quotes.length, 0);
  // 标签超过 40 字、缺少正文、非行首都不算引用行
  assert.equal(parseUserText(`[引用 · ${'x'.repeat(41)}] 内容`).matched, false);
  assert.equal(parseUserText('[引用 · 助手回复]').matched, false);
  assert.equal(parseUserText('前言\n[引用 · 助手回复] 内容').matched, false);
});

test('合并后按 60k 字符预算判断', () => {
  const quotes = Array.from({ length: QUOTE_LIMIT }, (_, index) =>
    normalizeQuote({ text: 'x'.repeat(QUOTE_TEXT_LIMIT), source: { kind: 'chat', label: `来源 ${index}` } }));
  const normal = mergeUserText(quotes, '问题');
  assert.ok(normal.length < USER_TEXT_BUDGET);
  assert.equal(withinUserBudget(normal), true);
  const huge = mergeUserText(quotes, 'y'.repeat(USER_TEXT_BUDGET));
  assert.ok(huge.length > USER_TEXT_BUDGET);
  assert.equal(withinUserBudget(huge), false);
  // 重试路径：已经合并过的文本不会重复插入引用
  assert.equal(mergeUserText(quotes, normal), normal);
  // 没有引用时原样返回
  assert.equal(mergeUserText([], '普通消息'), '普通消息');
  assert.equal(mergeUserText(null, '普通消息'), '普通消息');
});

test('file quote labels turn back into linkable references', () => {
  assert.deepEqual(fileRefOfLabel('文件 src/app/main.tsx:12'), { path: 'src/app/main.tsx', line: 12 });
  assert.deepEqual(fileRefOfLabel('文件 docs/说明.md'), { path: 'docs/说明.md', line: 0 });
  assert.equal(fileRefOfLabel('网页 example.com'), null);
  assert.equal(fileRefOfLabel('助手回复'), null);
  assert.equal(fileRefOfLabel('文件 '), null);
});
