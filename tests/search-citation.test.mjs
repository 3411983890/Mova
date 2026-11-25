import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateCitations, describeIssues } = require('../electron/search/citation.cjs');

const EXPORTS = {
  url: 'https://stats.gov.hk/exports',
  site: 'stats.gov.hk',
  title: '香港出口统计',
  pages: [{ text: '2024 年香港出口额为 1288 亿港元，同比增长 6.5%，主要市场为内地与东盟。', start: 0 }],
};
const LATIN = {
  url: 'https://example.com/report',
  title: 'Trade report',
  pages: [{ text: 'The report says the export volume reached 1288 billion Hong Kong dollars in 2024, up 6.5 percent year on year.', start: 0 }],
};
const THIRD = {
  url: 'https://example.org/notes',
  pages: [{ text: '香港出口数据由统计处按月公布，包含内地与东盟两个市场。', start: 0 }],
};
const EVIDENCE = [EXPORTS, LATIN, THIRD];

test('markers: [1] / [1,3] / [1-3] 三种写法都能识别，编号按出现顺序统计', () => {
  const answer = '出口见 [1]。对比见 [1, 3]。区间见 [1-3]。';
  const result = validateCitations(answer, EVIDENCE);
  assert.equal(result.total, 1 + 2 + 3, '[1] 记 1 处，[1,3] 记 2 处，[1-3] 记 3 处');
  assert.deepEqual(result.used, [1, 2, 3], '[1-3] 展开成 1、2、3');
  assert.deepEqual(result.missing, []);
});

test('used: 去重后升序，重复引用不影响 used', () => {
  const result = validateCitations('先 [2]，再 [1]，最后又是 [2]。', EVIDENCE);
  assert.equal(result.total, 3);
  assert.deepEqual(result.used, [1, 2]);
  assert.deepEqual(result.missing, []);
});

test('missing: 编号越界或小于 1 都算缺失，且升序去重', () => {
  const result = validateCitations('甲 [3]，乙 [0]，丙 [9]。', EVIDENCE.slice(0, 2));
  assert.deepEqual(result.used, [0, 3, 9]);
  assert.deepEqual(result.missing, [0, 3, 9]);
  assert.equal(result.ok, false);
  assert.match(describeIssues(result), /\[0、3、9\]/);
});

test('missing: [1-3] 展开后逐条核对，超出证据长度的部分记为缺失', () => {
  const result = validateCitations('区间 [1-3]。', EVIDENCE.slice(0, 2));
  assert.equal(result.total, 3);
  assert.deepEqual(result.used, [1, 2, 3]);
  assert.deepEqual(result.missing, [3]);

  const full = validateCitations('区间 [1-3]。', EVIDENCE);
  assert.deepEqual(full.missing, []);
});

test('support: 中文断言由证据支撑时 ok=true，describeIssues 返回空串', () => {
  const answer = '2024 年香港出口额为 1288 亿港元 [1]。';
  const result = validateCitations(answer, EVIDENCE);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.ok, true);
  assert.equal(describeIssues(result), '');
});

test('support: 中文断言与证据无关时进 unsupported，但不影响 missing', () => {
  const answer = '东京人口为 1400 万 [1]。';
  const result = validateCitations(answer, EVIDENCE);
  assert.deepEqual(result.missing, []);
  assert.equal(result.ok, false);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0].n, 1);
  assert.match(result.unsupported[0].claim, /东京人口为/);
  assert.match(describeIssues(result), /东京人口为/);
});

test('support: 英文断言（Latin 词 + 数字）可核验 / 不可核验', () => {
  const good = validateCitations('The export volume reached 1288 billion Hong Kong dollars in 2024 [1].', [LATIN]);
  assert.equal(good.ok, true, JSON.stringify(good));

  const bad = validateCitations('The unemployment rate fell to 2.1 percent in Tokyo [1].', [LATIN]);
  assert.equal(bad.ok, false);
  assert.equal(bad.unsupported.length, 1);
});

test('digits: 断言里的数字必须逐字出现在证据里', () => {
  const supported = validateCitations('同比增长 6.5% [1]。', [EXPORTS]);
  assert.equal(supported.ok, true, JSON.stringify(supported));

  const wrong = validateCitations('同比增长 7.5% [1]。', [EXPORTS]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.unsupported.length, 1);
  assert.deepEqual(wrong.missing, []);
});

test('digits: 引用编号里的数字不算断言里的数字', () => {
  // 证据第 2 条里没有独立的 "2"，但 [2] 只是编号：这条断言应当按内容判断而不是被编号带偏。
  const evidence = [LATIN, { pages: [{ text: '香港出口数据由统计处按月公布。' }] }];
  const result = validateCitations('香港出口数据由统计处按月公布 [2]。', evidence);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('threshold: 覆盖率不足在默认阈值下通过、在更严阈值下失败', () => {
  const evidence = [{ pages: [{ text: '香港出口数据' }] }];
  const answer = '香港进口数据 [1]。';
  const loose = validateCitations(answer, evidence);
  assert.equal(loose.ok, true, '覆盖率 0.6 高于默认 0.5');
  const strict = validateCitations(answer, evidence, { threshold: 0.9 });
  assert.equal(strict.ok, false);
  assert.equal(strict.unsupported.length, 1);
});

test('code fences: 围栏里的内容不算断言，也不产生引用', () => {
  const answer = '香港出口额为 1288 亿港元 [1]。\n```js\nconst rows = [9];\n```\n结束。';
  const result = validateCitations(answer, EVIDENCE);
  assert.equal(result.total, 1);
  assert.deepEqual(result.used, [1]);
  assert.deepEqual(result.missing, [], '围栏里的 [9] 不应被当成引用');
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('sentence: 只有含引用的句子才算断言（无引用的句子被忽略）', () => {
  const answer = '这一段没有任何引用，也不该被检查。另一段引用了 [1] 但没有对应内容。';
  const result = validateCitations(answer, EVIDENCE);
  assert.equal(result.total, 1);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0].n, 1);
});

test('描述: 只有 missing 时 isError 语义对应的文案不出现「证据不足」', () => {
  const result = validateCitations('见 [9]。', EVIDENCE);
  const text = describeIssues(result);
  assert.match(text, /引用校验未通过/);
  assert.match(text, /\[9\]/);
  assert.doesNotMatch(text, /证据不足/);
});

test('空输入: 没有引用时 total=0、ok=true；证据为空时任何引用都缺失', () => {
  const none = validateCitations('没有引用的答案。', EVIDENCE);
  assert.deepEqual(none, { total: 0, used: [], missing: [], unsupported: [], ok: true });
  assert.equal(describeIssues(none), '');

  const emptyEvidence = validateCitations('见 [1]。', []);
  assert.deepEqual(emptyEvidence.missing, [1]);
  assert.equal(emptyEvidence.ok, false);

  const notString = validateCitations(null, null);
  assert.equal(notString.total, 0);
  assert.equal(notString.ok, true);
});

// ── 批次证据（每次工具调用各自从 1 编号）──────────────────────────────
const filler = n => ({ url: `https://filler.test/${n}`, pages: [{ text: `第 ${n} 段无关内容。`, start: 0 }] });

test('batches: [2] 只在第二个批次里存在时仍然算可核验（不再误报缺失）', () => {
  const batches = [
    [filler(1)], // 这一批只有 1 条，[2] 在本批超界
    [{ url: 'https://example.com/report' }, EXPORTS],
  ];
  const answer = '2024 年香港出口额为 1288 亿港元 [2]。';
  const result = validateCitations(answer, batches);

  assert.deepEqual(result.used, [2]);
  assert.deepEqual(result.missing, [], '只要任一批次有第 2 条就不是缺失');
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('batches: 其它批次条目不足不影响另一批次的 [5]；真正不存在的编号仍报缺失', () => {
  const six = [filler(1), filler(2), filler(3), filler(4), EXPORTS, filler(6)];
  const groups = [[LATIN], six];

  const found = validateCitations('2024 年香港出口额为 1288 亿港元 [5]。', groups);
  assert.deepEqual(found.missing, []);
  assert.deepEqual(found.unsupported, []);
  assert.equal(found.ok, true, JSON.stringify(found));

  const beyond = validateCitations('另见 [7]。', groups);
  assert.deepEqual(beyond.missing, [7], '没有任何批次存在第 7 条');
  assert.equal(beyond.ok, false);
});

test('single-array: 传 Evidence[] 时编号仍按整轮下标 + 1，结果与旧行为一致', () => {
  const supported = validateCitations('2024 年香港出口额为 1288 亿港元 [1]。', EVIDENCE);
  assert.deepEqual(supported, { total: 1, used: [1], missing: [], unsupported: [], ok: true });

  const short = validateCitations('2024 年香港出口额为 1288 亿港元 [3]。', EVIDENCE.slice(0, 2));
  assert.deepEqual(short.missing, [3]);
  assert.equal(short.ok, false);

  // 单数组里即使混入空值也按「下标存在」处理，不会退化成批次语义。
  const sparse = validateCitations('见 [2]。', [EXPORTS, undefined]);
  assert.deepEqual(sparse.missing, []);
});
