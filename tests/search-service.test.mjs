import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSearchService } = require('../electron/search/index.cjs');
const { createCache } = require('../electron/search/cache.cjs');
const { createBudget } = require('../electron/search/budget.cjs');
const { createProviders } = require('../electron/search/providers.cjs');

/** 离线 provider 桩：只记录调用，不发网络。 */
function makeProvider(id, {
  rows = {},
  hasExtract = true,
  extractText = '正文 alpha 关键词',
  failExtract = false,
  failQueries = [],
} = {}) {
  const calls = { search: [], extract: [] };
  const provider = {
    id,
    label: id,
    hasExtract,
    calls,
    async search(query, options) {
      calls.search.push({ query, options });
      if (failQueries.includes(query)) throw new Error(`${id} 挂了`);
      const list = typeof rows === 'function' ? rows(query) : (rows[query] || []);
      return list.map((entry, index) => ({
        url: entry.url,
        title: entry.title || entry.url,
        snippet: entry.snippet || '',
        content: entry.content || '',
        published: entry.published || null,
        provider: id,
        query,
        rank: entry.rank || index + 1,
      }));
    },
  };
  if (hasExtract) {
    provider.extract = async url => {
      calls.extract.push(url);
      if (failExtract) throw new Error('正文读取失败：超时');
      return { url, title: `${id} 页面`, text: extractText };
    };
  }
  return provider;
}

const SEARCH_ROWS = [
  { url: 'https://example.com/a' },
  { url: 'https://example.com/b' },
  { url: 'https://news.example.org/c' },
  { url: 'https://blog.test/d' },
];

test('service: fans out over 2 queries × 2 providers and survives one failing provider', async () => {
  const primary = makeProvider('anysearch', {
    rows: { alpha: [SEARCH_ROWS[0], SEARCH_ROWS[1]], beta: [SEARCH_ROWS[2]] },
  });
  const secondary = makeProvider('tavily', {
    rows: { alpha: [SEARCH_ROWS[3]] },
    failQueries: ['beta'],
  });
  const service = createSearchService({ providers: [primary, secondary], now: () => Date.now() });

  const result = await service.search({ queries: ['alpha', 'beta'], options: { readCount: 2 } });

  assert.equal(primary.calls.search.length, 2);
  assert.equal(secondary.calls.search.length, 2, '失败的 provider 也要被调用两次');
  assert.equal(result.rows.length, 4);
  assert.deepEqual(
    result.rows.map(row => row.key).sort(),
    ['https://blog.test/d', 'https://example.com/a', 'https://example.com/b', 'https://news.example.org/c'],
  );
  for (const row of result.rows) {
    assert.ok(Number.isFinite(row.score) && row.score > 0);
    assert.ok(row.provider && row.query);
    assert.ok(row.providers instanceof Set && row.queries instanceof Set);
  }
  assert.equal(result.meta.candidates, 4);
  assert.equal(result.meta.deduped, 4);
  assert.equal(result.evidence.length, 4, '证据集是候选集，读到的只是其中前 readCount 条');
  assert.equal(primary.calls.extract.length, 2);
  assert.equal(result.meta.read, 2);
  assert.ok(result.meta.passages >= 1);
  for (const item of result.evidence) {
    assert.equal(typeof item.site, 'string');
    assert.ok(Array.isArray(item.pages));
    assert.equal(item.readError, undefined);
  }
  const readItems = result.evidence.filter(item => item.pages.length > 0);
  assert.equal(readItems.length, 2, '只有 readCount 条带正文段落');
  assert.ok(readItems.every(item => item.chars > 0));
  assert.deepEqual(
    result.evidence.slice(0, 2).map(item => item.pages.length > 0),
    [true, true],
    '可读的排在前面，[1] 一定是带引用的页面',
  );
});

test('service: per-host limit is applied after reranking', async () => {
  const provider = makeProvider('anysearch', {
    rows: {
      q: [
        { url: 'https://example.com/a' },
        { url: 'https://example.com/b' },
        { url: 'https://example.com/c' },
        { url: 'https://other.org/x' },
      ],
    },
  });
  const service = createSearchService({ providers: [provider] });
  const result = await service.search({ queries: ['q'], options: { readCount: 0, perHost: 1 } });

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.filter(row => row.key.startsWith('https://example.com/')).length, 1);
  assert.equal(result.meta.candidates, 4);
  assert.equal(result.meta.deduped, 4);
  assert.equal(result.evidence.length, 2, '读 0 页也要把候选交给模型，否则会把「有命中」说成「没来源」');
  assert.ok(result.evidence.every(item => item.pages.length === 0 && item.chars === 0));
});

test('service: budget exhaustion stops reading, so no further extract happens', async () => {
  const provider = makeProvider('anysearch', {
    rows: {
      q: [
        { url: 'https://example.com/a' },
        { url: 'https://other.org/b' },
        { url: 'https://third.test/c' },
      ],
    },
  });
  const service = createSearchService({ providers: [provider] });
  const budget = createBudget({ reads: 1, chars: 120000, ms: 60000 });
  const result = await service.search({ queries: ['q'], options: { readCount: 3 }, budget });

  assert.equal(provider.calls.extract.length, 1, '预算只允许一次读取');
  assert.equal(result.evidence.length, 3, '没读到正文的候选照样以摘要形式交给模型');
  assert.equal(result.evidence.filter(item => item.pages.length > 0).length, 1);
  assert.equal(result.rows.length, 3, '候选仍然完整返回');
  assert.equal(result.meta.read, 1);
  assert.equal(result.meta.budgetExhausted, true);

  await service.search({ queries: ['q'], options: { readCount: 3 }, budget });
  assert.equal(provider.calls.extract.length, 1, '已耗尽的预算不再触发读取');
});

test('service: cache hit avoids a second provider call and a second extract', async () => {
  const calls = { search: 0, extract: 0 };
  const provider = makeProvider('anysearch', {
    rows: { q: [{ url: 'https://example.com/a' }] },
    extractText: '缓存测试正文',
  });
  const originalSearch = provider.search;
  const originalExtract = provider.extract;
  provider.search = async (...args) => {
    calls.search += 1;
    return originalSearch.apply(provider, args);
  };
  provider.extract = async (...args) => {
    calls.extract += 1;
    return originalExtract.apply(provider, args);
  };

  const cache = createCache();
  const service = createSearchService({ providers: [provider], cache });
  const options = { readCount: 1 };
  const first = await service.search({ queries: ['q'], options });
  const second = await service.search({ queries: ['q'], options });

  assert.equal(calls.search, 1, '第二次命中的是缓存');
  assert.equal(calls.extract, 1, '正文也走缓存');
  assert.deepEqual(second.rows, first.rows);
  assert.deepEqual(second.evidence, first.evidence);
  assert.ok(cache.size() >= 2);

  const direct = await service.read({ url: 'https://example.com/a', question: '缓存' });
  assert.equal(calls.extract, 1, 'read() 复用正文缓存');
  assert.ok(direct.pages.length >= 1);
});

test('service: read() failure degrades to a candidate carrying readError', async () => {
  const provider = makeProvider('anysearch', {
    rows: { q: [{ url: 'https://example.com/a' }, { url: 'https://other.org/b' }] },
    failExtract: true,
  });
  const service = createSearchService({ providers: [provider] });
  const result = await service.search({ queries: ['q'], options: { readCount: 2 } });

  assert.equal(result.rows.length, 2);
  assert.equal(result.evidence.length, 2);
  for (const item of result.evidence) {
    assert.match(item.readError, /正文读取失败/);
    assert.deepEqual(item.pages, []);
    assert.equal(item.chars, 0);
    assert.ok(item.url.startsWith('https://'));
    assert.ok(item.title);
  }
  assert.equal(result.meta.read, 0);
  assert.equal(result.meta.passages, 0);
});

test('service: read() validates the URL, needs an extract-capable provider and spends chars', async () => {
  const reader = makeProvider('anysearch', { extractText: 'x'.repeat(1500) });
  const service = createSearchService({ providers: [reader] });

  await assert.rejects(
    () => service.read({ url: 'javascript:alert(1)' }),
    error => error.code === 'invalid-url' && /链接不合法/.test(error.message),
  );
  assert.equal(reader.calls.extract.length, 0);

  const budget = createBudget();
  const before = budget.remaining('chars');
  const evidence = await service.read({ url: 'https://example.com/a', question: '问题', budget });
  assert.equal(evidence.site, 'example.com');
  assert.ok(evidence.pages.length >= 1);
  assert.equal(evidence.provider, 'anysearch');
  assert.ok(evidence.chars >= 1500);
  assert.ok(budget.remaining('chars') < before, '读取正文要按字数记账');

  const noExtract = createSearchService({ providers: [makeProvider('tavily', { hasExtract: false })] });
  await assert.rejects(
    () => noExtract.read({ url: 'https://example.com/a' }),
    error => error.code === 'no-extractor',
  );
});

test('service: queries are normalized (trim, dedupe, ≤5, ≤400 字) and empty input short-circuits', async () => {
  const provider = makeProvider('anysearch', { rows: { fallback: [] } });
  const service = createSearchService({ providers: [provider] });

  const empty = await service.search({ queries: ['  ', '', null] });
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.evidence, []);
  assert.equal(provider.calls.search.length, 0, '空查询不得外呼');

  const long = 'y'.repeat(500);
  await service.search({
    queries: [long, ' one ', 'one', 'two', 'three', 'four', 'five', 'six'],
    options: { readCount: 0 },
  });
  const queries = provider.calls.search.map(call => call.query);
  assert.equal(queries.length, 5, '每轮最多 5 条查询');
  assert.equal(queries[0].length, 400, '单条查询截断到 400 字');
  assert.equal(queries[1], 'one');
  assert.equal(new Set(queries).size, 5);
});

test('service: providers may be a promise or a factory, and no provider yields empty results', async () => {
  const provider = makeProvider('anysearch', { rows: { q: [{ url: 'https://example.com/a' }] } });
  const pending = createSearchService({ providers: Promise.resolve([provider]) });
  assert.deepEqual(pending.activeProviders(), []);
  const viaPromise = await pending.search({ queries: ['q'], options: { readCount: 0 } });
  assert.equal(viaPromise.rows.length, 1);
  assert.deepEqual(pending.activeProviders().map(item => item.id), ['anysearch']);
  assert.equal(pending.hasExtract(), true);

  const viaFactory = createSearchService({ providers: async () => [provider] });
  const viaFactoryResult = await viaFactory.search({ queries: ['q'], options: { readCount: 0 } });
  assert.equal(viaFactoryResult.rows.length, 1);

  const none = createSearchService({ providers: [] });
  const empty = await none.search({ queries: ['q'] });
  assert.deepEqual(empty, {
    rows: [],
    evidence: [],
    meta: { candidates: 0, deduped: 0, read: 0, passages: 0, budgetExhausted: false, failed: 0, failedSources: [] },
  });
  assert.deepEqual(await none.capabilities(['example.com']), []);
  assert.equal(none.hasExtract(), false);
});

test('service: capabilities proxy to the first capable provider', async () => {
  const provider = makeProvider('anysearch', { rows: {} });
  provider.capabilities = async domains => domains.map(domain => `sub.${domain}`);
  const service = createSearchService({ providers: [provider] });
  assert.deepEqual(await service.capabilities(['example.com']), ['sub.example.com']);
});

test('service: 注入的 embed 抛错时仍返回关键词选段（对话中绝不因向量不可用而失败）', async () => {
  const text = `${'关键词 alpha '.repeat(200)}目标段落 beta ${'尾部 gamma '.repeat(100)}`;
  const provider = makeProvider('anysearch', { rows: { q: [{ url: 'https://example.com/a' }] }, extractText: text });
  const embedCalls = [];
  const embed = async (texts, options) => {
    embedCalls.push({ texts, options });
    throw new Error('本地模型未缓存，拒绝联网下载');
  };
  const service = createSearchService({ providers: [provider], embed });

  const evidence = await service.read({ url: 'https://example.com/a', question: 'alpha 目标段落' });

  assert.equal(embedCalls.length, 2, '先查查询向量、再查段落向量');
  assert.deepEqual(embedCalls.map(call => call.options?.kind).sort(), ['passage', 'query']);
  assert.ok(Array.isArray(evidence.pages) && evidence.pages.length >= 1, 'embed 抛错后仍有关键词段落');
  assert.ok(evidence.pages.some(page => page.text.includes('目标段落')));
  assert.equal(evidence.chars, text.length);
  assert.equal(typeof evidence.site, 'string');
});

test('service: 注入可用 embed 时真的走向量选段（结果仍是 { text, start } 数组）', async () => {
  // 10 个 1000 字的块；只有第 8 块中间（绝对偏移 7500）含 TARGET，查询与 TARGET 在向量空间里同向。
  // 关键词版对 question='zzz' 无命中，只会按原文顺序取前几段，永远选不到 7500 那一段。
  const blocks = [];
  for (let index = 0; index < 10; index += 1) {
    blocks.push(index === 7
      ? `${'x'.repeat(500)}TARGET${'x'.repeat(500 - 6)}`
      : 'x'.repeat(1000));
  }
  const text = blocks.join('');
  const provider = makeProvider('anysearch', { rows: { q: [{ url: 'https://example.com/a' }] }, extractText: text });
  const kinds = [];
  const embed = async (texts, { kind } = {}) => {
    kinds.push(kind);
    return texts.map(value => (kind === 'query' || value.includes('TARGET') ? [1, 0] : [0, 1]));
  };
  const service = createSearchService({ providers: [provider], embed });

  const evidence = await service.read({ url: 'https://example.com/a', question: 'zzz' });

  assert.deepEqual(kinds.sort(), ['passage', 'query'], '查询与段落各调用一次 embed');
  const targetPage = evidence.pages.find(page => page.text.includes('TARGET'));
  assert.ok(targetPage, '向量选段命中了关键词版选不到的段落');
  assert.equal(targetPage.start, 7000, '段落偏移仍回指原文（该段从原文 7000 字开始）');
  for (const page of evidence.pages) {
    assert.deepEqual(Object.keys(page).sort(), ['start', 'text'], '选段形状不变');
  }
});

test('createProviders: only instantiates configured sources, anysearch first', async () => {
  const keys = { anysearch: 'ak', tavily: 'tk' };
  const credentials = { async key(id) { return keys[id]; } };
  const fetchImpl = async () => {
    throw new Error('测试不应发起网络请求');
  };
  const ids = providers => providers.map(provider => provider.id);

  assert.deepEqual(ids(await createProviders({ credentials, fetch: fetchImpl })), ['anysearch']);
  assert.deepEqual(
    ids(await createProviders({ credentials: { async key() { return undefined; } }, fetch: fetchImpl })),
    [],
    '没有 key 时 anysearch 不实例化',
  );
  assert.deepEqual(
    ids(await createProviders({
      credentials,
      config: { providers: { tavily: { enabled: false } } },
      fetch: fetchImpl,
    })),
    ['anysearch'],
    'P1 源默认关闭，即使有 key',
  );
  assert.deepEqual(
    ids(await createProviders({
      credentials,
      config: { providers: { tavily: { enabled: true }, searxng: { enabled: true, baseUrl: 'https://searx.example.com' } } },
      fetch: fetchImpl,
    })),
    ['anysearch', 'tavily', 'searxng'],
  );
  assert.deepEqual(
    ids(await createProviders({
      credentials,
      config: { order: ['searxng', 'anysearch'], providers: { searxng: { enabled: true, baseUrl: 'https://searx.example.com' } } },
      fetch: fetchImpl,
    })),
    ['searxng', 'anysearch'],
    '配置可覆盖优先级',
  );
  assert.deepEqual(
    ids(await createProviders({
      credentials,
      config: { providers: { searxng: { enabled: true, baseUrl: 'http://127.0.0.1:8080' } } },
      fetch: fetchImpl,
    })),
    ['anysearch'],
    '非法 baseUrl 直接跳过',
  );
  assert.deepEqual(
    ids(await createProviders({
      credentials: { async key(id) { return id === 'anysearch' ? 'ak' : undefined; } },
      config: { providers: { tavily: { enabled: true } } },
      fetch: fetchImpl,
    })),
    ['anysearch'],
    'tavily 启用但无 key 时不实例化',
  );
});
