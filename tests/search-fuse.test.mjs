import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalUrl, fuse } = require('../electron/search/fuse.cjs');

function row(url, rank, query, provider, overrides = {}) {
  return {
    url,
    title: `t${rank}`,
    snippet: '',
    content: '',
    published: null,
    provider,
    query,
    rank,
    ...overrides,
  };
}

// ------------------------------------------------------------ canonicalUrl

test('canonicalUrl: drops tracking params, hash, www, trailing slash and sorts query', () => {
  assert.equal(
    canonicalUrl('https://www.example.com/a/?utm_source=x&utm_medium=y&b=2&a=1#section'),
    'https://example.com/a?a=1&b=2',
  );
  assert.equal(canonicalUrl('https://example.com/p?b=2&a=1'), 'https://example.com/p?a=1&b=2');
  assert.equal(canonicalUrl('https://example.com/p?b=2&a=1#frag'), canonicalUrl('https://example.com/p?a=1&b=2'));
});

test('canonicalUrl: removes spm/from/share_*/ref_* but keeps real params', () => {
  assert.equal(
    canonicalUrl('https://example.com/p?spm=abc&from=rss&share_id=1&ref_src=tw&keep=1'),
    'https://example.com/p?keep=1',
  );
  assert.equal(canonicalUrl('https://example.com/p?UTM_Source=x&keep=1'), 'https://example.com/p?keep=1');
});

test('canonicalUrl: root keeps "/", repeated trailing slashes collapse, trailing dot host drops', () => {
  assert.equal(canonicalUrl('https://example.com'), 'https://example.com/');
  assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/');
  assert.equal(canonicalUrl('https://example.com/a/b///'), 'https://example.com/a/b');
  assert.equal(canonicalUrl('https://example.com./a'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://WWW.Example.COM/A/?utm_source=x'), 'https://example.com/A');
  assert.equal(canonicalUrl('https://example.com:8443/a/'), 'https://example.com:8443/a');
});

test('canonicalUrl: rejected schemes and hosts become empty keys', () => {
  const rejected = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://example.com/a',
    'http://127.0.0.1/x',
    'http://localhost:8080/x',
    'https://printer.local/x',
    'http://[::1]/x',
    'https://user:pass@example.com/a',
    'not a url',
    '',
    'https://' + 'a'.repeat(3000),
    42,
    null,
  ];
  for (const value of rejected) {
    assert.equal(canonicalUrl(value), '', `应拒绝：${String(value).slice(0, 40)}`);
  }
});

// -------------------------------------------------------------------- fuse

test('fuse: RRF with k=60 sums 1/(k+rank) per matching row', () => {
  const batches = [
    [row('https://example.com/a', 1, 'q1', 'anysearch'), row('https://example.com/b', 2, 'q1', 'anysearch')],
    [row('https://example.com/b', 1, 'q2', 'tavily')],
  ];
  const fused = fuse(batches);
  assert.equal(fused.length, 2);
  assert.equal(fused[0].url, 'https://example.com/b', '两路命中应排第一');
  assert.equal(fused[0].score, 1 / 62 + 1 / 61);
  assert.equal(fused[1].url, 'https://example.com/a');
  assert.equal(fused[1].score, 1 / 61);
  assert.deepEqual([...fused[0].providers], ['anysearch', 'tavily']);
  assert.deepEqual([...fused[0].queries], ['q1', 'q2']);
  assert.equal(fused[0].key, 'https://example.com/b');
});

test('fuse: k is configurable and rank falls back to batch position', () => {
  const flat = fuse([[row('https://example.com/a', 1, 'q', 'anysearch')]], { k: 0 });
  assert.equal(flat[0].score, 1);

  const unranked = fuse([[{ ...row('https://example.com/a', 1, 'q', 'anysearch'), rank: undefined, score: undefined }]]);
  assert.equal(unranked[0].score, 1 / 61);
});

test('fuse: same page across queries and providers merges once with sets', () => {
  const batches = [
    [row('https://www.example.com/a/?utm_source=x', 1, 'q1', 'anysearch', { published: null, snippet: '' })],
    [row('https://example.com/a', 1, 'q2', 'tavily', { published: '2025-01-02', snippet: 'snippet-b' })],
    [row('https://example.com/a/', 2, 'q3', 'searxng', { content: 'content-c' })],
  ];
  const fused = fuse(batches);
  assert.equal(fused.length, 1);
  assert.equal(fused[0].key, 'https://example.com/a');
  assert.equal(fused[0].score, 1 / 61 + 1 / 61 + 1 / 62);
  assert.deepEqual([...fused[0].providers].sort(), ['anysearch', 'searxng', 'tavily']);
  assert.deepEqual([...fused[0].queries].sort(), ['q1', 'q2', 'q3']);
  assert.equal(fused[0].published, '2025-01-02', 'published 取第一个非空值');
  assert.equal(fused[0].snippet, 'snippet-b');
  assert.equal(fused[0].content, 'content-c');
  assert.equal(fused[0].title, 't1', '标题保留首条');
});

test('fuse: empty and malformed batches are ignored, order is by score desc', () => {
  assert.deepEqual(fuse([]), []);
  assert.deepEqual(fuse([null, 'nope', []]), []);
  const fused = fuse([
    [row('https://example.com/x', 1, 'q', 'a'), row('https://example.com/y', 2, 'q', 'a')],
    [row('https://example.com/y', 1, 'q2', 'b'), row('https://example.com/z', 2, 'q2', 'b')],
  ]);
  assert.deepEqual(fused.map(entry => entry.url), [
    'https://example.com/y',
    'https://example.com/x',
    'https://example.com/z',
  ]);
  for (let index = 1; index < fused.length; index += 1) {
    assert.ok(fused[index - 1].score >= fused[index].score);
  }
});
