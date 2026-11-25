import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatEvidence, toSourceSummary } = require('../electron/search/pack.cjs');

const CITE_HINT = '用 [n] 标注引用；若某断言找不到出处，写「未找到可核验来源」。';

function meta(overrides = {}) {
  return { queries: ['a', 'b'], candidates: 18, deduped: 11, read: 4, passages: 9, ...overrides };
}

test('toSourceSummary: canonical id, site without www, published defaults to null', () => {
  assert.deepEqual(
    toSourceSummary({ url: 'https://www.example.com/a/?utm_source=x', title: '标题', published: '2025-03-11' }),
    {
      id: 'https://example.com/a',
      url: 'https://www.example.com/a/?utm_source=x',
      title: '标题',
      site: 'example.com',
      published: '2025-03-11',
    },
  );
  assert.deepEqual(toSourceSummary({ url: 'https://example.com/a' }), {
    id: 'https://example.com/a',
    url: 'https://example.com/a',
    title: '',
    site: 'example.com',
    published: null,
  });
  assert.deepEqual(toSourceSummary({}), { id: '', url: '', title: '', site: '', published: null });
});

test('formatEvidence: numbered blocks, site/date line, url indent and quoted passages', () => {
  const text = formatEvidence([
    {
      url: 'https://www.example.com/a',
      title: '标题A',
      site: 'example.com',
      published: '2025-03-11',
      pages: [{ text: '段落一', start: 0 }, { text: '段落二', start: 10 }],
      chars: 20,
    },
    {
      url: 'https://news.example.org/b',
      title: '标题B',
      site: 'news.example.org',
      published: null,
      pages: [{ text: 'x'.repeat(900), start: 0 }],
      chars: 900,
    },
  ], meta());

  assert.ok(text.startsWith('[1] 标题A — example.com — 2025-03-11\n    https://www.example.com/a\n    “段落一 … 段落二”'), text);
  assert.ok(text.includes('[2] 标题B — news.example.org\n    https://news.example.org/b\n    “'), text);
  assert.ok(text.endsWith(`${CITE_HINT}`), '必须以引用提示结尾');
  assert.ok(
    text.includes('检索说明：queries=[a; b] 候选 18 条，去重 11 条，已读 4 页，取 9 段。'),
    text.split('\n').slice(-3).join('\n'),
  );

  const quoted = text.split('\n').filter(line => line.startsWith('    “'));
  assert.equal(quoted.length, 2);
  const second = quoted[1].trim().slice(1, -1);
  assert.equal(second.length, 600, '引用段落最多 600 字');
  assert.ok(second.startsWith('xxxx'));
});

test('formatEvidence: empty result message still carries the search note', () => {
  const text = formatEvidence([], meta({ queries: [], candidates: 0, deduped: 0, read: 0, passages: 0 }));
  assert.ok(text.startsWith('没有找到可用的公开来源。'));
  assert.ok(text.includes('检索说明：queries=[] 候选 0 条，去重 0 条，已读 0 页，取 0 段。'));
  assert.ok(text.endsWith(CITE_HINT));
  assert.ok(!text.includes('undefined'));
});

test('formatEvidence: missing published/content/pages never throws', () => {
  const text = formatEvidence([
    { url: 'https://example.com/x' },
    { url: 'https://example.com/y', title: '', pages: [], readError: '抓取超时' },
    { url: '', title: '只剩下标题' },
  ], meta({ queries: ['只有一个'], note: '部分来源不可读' }));

  assert.ok(text.includes('[1] example.com'), '标题缺失时回退站点');
  assert.ok(text.includes('（未读取正文）'), '无正文时要标注');
  assert.ok(text.includes('（读取失败：抓取超时）'));
  assert.ok(text.includes('只剩下标题'));
  assert.ok(text.includes('（部分来源不可读）'), 'meta.note 要出现在检索说明里');
  assert.ok(!text.includes('undefined'));
  assert.ok(!text.includes('null'));
});

test('formatEvidence: budget exhaustion is surfaced in the note line', () => {
  const text = formatEvidence([], meta({ budgetExhausted: true }));
  assert.ok(text.includes('预算已用尽'));
});
