import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const passage = require('../electron/search/passage.cjs');

const { chunk, select, selectByKeywords, cosine, jaccard } = passage;

const FILLER = 'z';
// 向量测试用固定 400 字窗口、无重叠：每块恰好一个检索词，断言稳定。
const WINDOW = { size: 400, overlap: 0 };

/** 定长块，块内只有一个可检索词；配合固定词表的假 embed 使用。 */
function pageText(word, length = 400) {
  // 词后面补空格到固定 16 字，保证每块的填充串完全一致（否则 MMR 的 jaccard 会被填充串长度带偏）。
  const head = String(word).padEnd(16, ' ');
  return head + FILLER.repeat(Math.max(0, length - head.length));
}

/** 固定词表的词袋向量：同一输入永远得到同一向量，离线且确定性。 */
function makeEmbed(vocabulary = ['alpha', 'beta', 'gamma']) {
  const calls = [];
  const embed = async (texts, options = {}) => {
    calls.push({ texts: [...texts], kind: options?.kind ?? null });
    return texts.map(text => {
      const lowered = String(text).toLowerCase();
      return vocabulary.map(word => {
        let count = 0;
        let at = lowered.indexOf(word);
        while (at !== -1) {
          count += 1;
          at = lowered.indexOf(word, at + word.length);
        }
        return count;
      });
    });
  };
  return { embed, calls };
}

test('chunk: 定长切块、保留 start 偏移、块间重叠且末尾块短于窗口', () => {
  const text = 'a'.repeat(3000);
  const pages = chunk(text, { size: 1200, overlap: 200 });
  assert.deepEqual(pages.map(page => page.start), [0, 1000, 2000]);
  assert.deepEqual(pages.map(page => page.text.length), [1200, 1200, 1000]);
  // 相邻块共享 200 字的重叠区。
  assert.equal(pages[0].text.slice(-200), pages[1].text.slice(0, 200));
  assert.equal(pages[1].text.slice(-200), pages[2].text.slice(0, 200));
  assert.equal(pages[0].text, text.slice(0, 1200));

  // 空文本 / 非字符串不产生段落，也不抛错。
  assert.deepEqual(chunk('   '), []);
  assert.deepEqual(chunk(null), []);
  // overlap 超过半个窗口时被夹到窗口的一半（step = 200）。
  const clamped = chunk('b'.repeat(1500), { size: 400, overlap: 999 });
  assert.deepEqual(clamped.map(page => page.start), [0, 200, 400, 600, 800, 1000, 1200, 1400]);
});

test('select: 没有 embed 时同步走关键词版，返回数组而非 Promise', () => {
  const doc = pageText('alpha') + pageText('beta') + pageText('gamma');
  const result = select(doc, 'gamma', WINDOW);
  assert.equal(Array.isArray(result), true, '关键词版必须保持同步返回');
  assert.equal(result.length, 1);
  assert.equal(result[0].start, 800);
});

test('select: 传入 embed 走向量版，排序由向量决定而不是词频', async () => {
  const doc = pageText('alpha') + pageText('beta') + pageText('gamma');
  const keyword = selectByKeywords(doc, 'alpha', WINDOW);
  assert.equal(keyword[0].start, 0, '关键词版会挑第一段');

  // 故意让向量把第三段排在最近：只有走向量版才会得到 start=800。
  const embed = async texts => (texts.length === 1
    ? [[1, 0, 0]]
    : texts.map((_, index) => (index === 2 ? [1, 0, 0] : [0, 1, 0])));
  const top = await select(doc, 'alpha', { ...WINDOW, embed, topK: 1 });
  assert.equal(Array.isArray(top), true);
  assert.equal(top[0].start, 800, '第一段由向量决定，与词频无关');
  // 多段结果仍按原文顺序返回。
  const many = await select(doc, 'alpha', { ...WINDOW, embed });
  assert.deepEqual(many.map(page => page.start), [...many.map(page => page.start)].sort((a, b) => a - b));
});

test('select: 向量版按 topK 与 maxChars 收口，片段不超出字数预算', async () => {
  const doc = pageText('alpha') + pageText('beta') + pageText('gamma');
  const { embed } = makeEmbed();
  const picked = await select(doc, 'gamma', { ...WINDOW, embed, topK: 2, maxChars: 500 });
  assert.ok(picked.length >= 1);
  const used = picked.reduce((sum, page) => sum + page.text.length, 0);
  assert.ok(used <= 500, `累计 ${used} 字超过预算`);
  assert.equal(picked[0].start, 0, '结果按原文顺序');
  assert.ok(picked.every(page => page.text.length <= 400));

  const single = await select(doc, 'gamma', { ...WINDOW, embed, topK: 1 });
  assert.equal(single.length, 1);
  assert.equal(single[0].start, 800);
});

test('select: MMR 剔除近重复段落，重复文本只留一段', async () => {
  // 4 个 400 字块内容完全一致：jaccard = 1，只有第一段能被选中。
  const doc = FILLER.repeat(1600);
  const { embed, calls } = makeEmbed();
  assert.equal(chunk(doc, WINDOW).length, 4);
  const picked = await select(doc, 'alpha', { ...WINDOW, embed, topK: 4 });
  assert.equal(picked.length, 1, '近重复段落必须被 MMR 丢掉');
  assert.equal(picked[0].start, 0);
  assert.equal(calls.length, 2, '问题一次 + 段落一批，共两次 embed 调用');
  assert.deepEqual(calls.map(call => call.kind), ['query', 'passage']);
});

test('select: embed 抛错时落回关键词版（结果与 selectByKeywords 完全一致）', async () => {
  const doc = pageText('alpha') + pageText('beta') + pageText('gamma');
  const failing = async () => { throw new Error('模型未加载'); };
  const viaVector = await select(doc, 'beta', { ...WINDOW, embed: failing });
  const viaKeyword = selectByKeywords(doc, 'beta', WINDOW);
  assert.deepEqual(viaVector, viaKeyword);
  assert.equal(viaVector[0].start, 400);
});

test('select: embed 返回坏形状时同样落回关键词版', async () => {
  const doc = pageText('alpha') + pageText('beta') + pageText('gamma');
  const expected = selectByKeywords(doc, 'beta', { ...WINDOW, topK: 2, maxChars: 700 });
  const shapes = [
    async texts => texts.map((_, index) => (index === 0 ? [1, 2, 3] : [1, 2])), // 维度不齐
    async () => [[1, 2], [1, 2]], // 行数少于 chunk 数
    async () => null,
    async texts => texts.map(() => [1, Number.NaN, 2]),
  ];
  for (const embed of shapes) {
    const picked = await select(doc, 'beta', { ...WINDOW, embed, topK: 2, maxChars: 700 });
    assert.deepEqual(picked, expected, '坏形状必须等价于关键词版');
  }
});

test('select: 单段文档直接用关键词版，不调用 embed', async () => {
  let called = 0;
  const embed = async texts => {
    called += 1;
    return texts.map(() => [1, 0, 0]);
  };
  const picked = await select('只有一段很短的正文字。', '短文', { embed });
  assert.equal(called, 0, '单段文档没有必要向量化');
  assert.equal(picked.length, 1);
  assert.match(picked[0].text, /很短/);
});

test('select: 向量版在词袋 embed 下命中最相关段落（确定性）', async () => {
  const doc = pageText('alpha') + pageText('beta') + pageText('gamma');
  const { embed } = makeEmbed();
  const first = await select(doc, 'gamma', { ...WINDOW, embed, topK: 1 });
  const second = await select(doc, 'gamma', { ...WINDOW, embed, topK: 1 });
  assert.deepEqual(first, second, '同一输入必须得到同一结果');
  assert.equal(first[0].start, 800);
  assert.match(first[0].text, /^gamma /);
});

test('cosine / jaccard: 基础性质（零向量、相同集合、空集合）', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0, '维度不同视为不可比');
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard([], ['b']), 0);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
});
