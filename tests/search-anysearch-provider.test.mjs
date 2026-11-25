import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAnySearchProvider } = require('../electron/search/providers/anysearch.cjs');
const { SearchProviderError } = require('../electron/search/providers/errors.cjs');

const SEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search';
const EXTRACT_ENDPOINT = 'https://api.anysearch.com/v1/extract';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 记录调用的 fetch 桩：完全离线。 */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function payload(results) {
  return json({ code: 0, data: { results } });
}

test('anysearch.search: minimal query sends the documented body and headers', async () => {
  const fetchImpl = stubFetch(() => payload([{ url: 'https://example.com/a', title: 'A', snippet: 'S' }]));
  const provider = createAnySearchProvider({ key: 'k-1', fetch: fetchImpl });

  await provider.search('  hello  ', {}, undefined);

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, SEARCH_ENDPOINT);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.Authorization, 'Bearer k-1');
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.options.body), {
    query: 'hello',
    max_results: 10,
    format: 'markdown',
  });
  assert.ok(call.options.signal, '必须带 AbortSignal');
  assert.equal(provider.id, 'anysearch');
  assert.equal(provider.label, 'AnySearch');
  assert.equal(provider.hasExtract, true);
});

test('anysearch.search: zone/language/tag/params are forwarded and format is omitted when markdown=false', async () => {
  const fetchImpl = stubFetch(() => payload([]));
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });

  await provider.search('q', {
    maxResults: 3,
    zone: 'cn',
    language: 'zh-CN',
    tag: 'news',
    params: { freshness: 'week' },
    markdown: false,
  }, undefined);

  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
    query: 'q',
    max_results: 3,
    zone: 'cn',
    language: 'zh-CN',
    tag: 'news',
    params: { freshness: 'week' },
  });
});

test('anysearch.search: max_results clamps to 1..10', async () => {
  const cases = [[0, 1], [-4, 1], [1, 1], [7, 7], [10, 10], [99, 10], [undefined, 10]];
  for (const [input, expected] of cases) {
    const fetchImpl = stubFetch(() => payload([]));
    const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });
    await provider.search('q', input === undefined ? {} : { maxResults: input }, undefined);
    assert.equal(JSON.parse(fetchImpl.calls[0].options.body).max_results, expected, `maxResults=${input}`);
  }
});

test('anysearch.search: maps results to Row, normalizes published and rank', async () => {
  const fetchImpl = stubFetch(() => payload([
    {
      url: 'https://www.example.com/a/?utm_source=x',
      title: '标题',
      snippet: '摘要',
      content: '正文',
      published: '2025-03-11T08:00:00Z',
    },
    { url: 'https://example.org/b', content: '只有正文' },
  ]));
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });
  const rows = await provider.search(' 查询词 ', { maxResults: 5 }, undefined);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    url: 'https://www.example.com/a/?utm_source=x',
    title: '标题',
    snippet: '摘要',
    content: '正文',
    published: '2025-03-11',
    provider: 'anysearch',
    query: '查询词',
    rank: 1,
  });
  assert.equal(rows[1].url, 'https://example.org/b');
  assert.equal(rows[1].title, 'example.org', '标题缺省用 hostname');
  assert.equal(rows[1].snippet, '');
  assert.equal(rows[1].content, '只有正文');
  assert.equal(rows[1].published, null);
  assert.equal(rows[1].rank, 2);
});

test('anysearch.search: rejects unsafe urls, keeps the first of duplicate hrefs and caps results', async () => {
  const fetchImpl = stubFetch(() => payload([
    { url: 'javascript:alert(1)', title: 'bad' },
    { url: 'http://127.0.0.1/x', title: 'local' },
    { url: 'https://example.com/dup', title: 'first' },
    { url: 'https://example.com/dup', title: 'second' },
    { url: 'https://example.com/2', title: 'two' },
    { url: 'https://example.com/3', title: 'three' },
  ]));
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });
  const rows = await provider.search('q', { maxResults: 2 }, undefined);
  assert.deepEqual(rows.map(row => row.title), ['first', 'two']);
  assert.deepEqual(rows.map(row => row.rank), [1, 2]);
});

test('anysearch.search: code !== 0 throws SearchProviderError without the response body', async () => {
  const fetchImpl = stubFetch(() => json({ code: 4001, message: 'api_key=SECRET' }));
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });
  await assert.rejects(
    () => provider.search('q', {}, undefined),
    error => {
      assert.ok(error instanceof SearchProviderError);
      assert.equal(error.name, 'SearchProviderError');
      assert.equal(error.provider, 'anysearch');
      assert.equal(error.status, 0);
      assert.match(error.message, /code=4001/);
      assert.ok(!error.message.includes('SECRET'));
      return true;
    },
  );
});

test('anysearch.search: 401/402/422/429 map to SearchProviderError with status only', async () => {
  for (const status of [401, 402, 422, 429]) {
    const fetchImpl = stubFetch(() => json({ error: 'api_key=SECRET' }, status));
    const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });
    await assert.rejects(
      () => provider.search('q', {}, undefined),
      error => {
        assert.ok(error instanceof SearchProviderError, `status ${status}`);
        assert.equal(error.status, status);
        assert.equal(error.provider, 'anysearch');
        assert.ok(!error.message.includes('SECRET'), `HTTP ${status} 不得泄露响应体`);
        assert.ok(error.message.length > 0);
        return true;
      },
    );
  }
});

test('anysearch.search: HTTP 402 body is never parsed or read', async () => {
  const state = { jsonCalled: false, textCalled: false, cancelled: false };
  const response = {
    ok: false,
    status: 402,
    body: {
      cancel: async () => { state.cancelled = true; },
    },
    json: async () => {
      state.jsonCalled = true;
      return { error: 'api_key=SECRET' };
    },
    text: async () => {
      state.textCalled = true;
      return 'api_key=SECRET';
    },
  };
  const fetchImpl = async () => response;
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });

  await assert.rejects(
    () => provider.search('q', {}, undefined),
    error => {
      assert.equal(error.status, 402);
      assert.ok(!error.message.includes('SECRET'));
      return true;
    },
  );
  assert.equal(state.jsonCalled, false, '402 响应体绝不能被解析');
  assert.equal(state.textCalled, false, '402 响应体绝不能被读取');
  assert.equal(state.cancelled, true, '只丢弃流');
});

test('anysearch.search: timeout aborts through AbortSignal.any and reports a readable error', async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    assert.ok(options.signal instanceof AbortSignal);
    options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl, timeoutMs: 10 });
  await assert.rejects(
    () => provider.search('q', {}, undefined),
    error => error instanceof SearchProviderError && error.status === 0 && /超时/.test(error.message),
  );
});

test('anysearch.extract: returns url/title/text and rejects invalid urls or non-string content', async () => {
  const fetchImpl = stubFetch(() => json({ code: 0, data: { title: '页面标题', content: '# 正文' } }));
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });

  const page = await provider.extract('https://www.example.com/a/', undefined);
  assert.deepEqual(page, { url: 'https://www.example.com/a/', title: '页面标题', text: '# 正文' });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, EXTRACT_ENDPOINT);
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.options.body), { url: 'https://www.example.com/a/' });

  const before = fetchImpl.calls.length;
  await assert.rejects(
    () => provider.extract('http://127.0.0.1/secret', undefined),
    error => error instanceof SearchProviderError && error.status === 400,
  );
  assert.equal(fetchImpl.calls.length, before, '非法链接不得发起请求');

  for (const body of [{ code: 0, data: { content: 42 } }, { code: 7, data: { content: 'x' } }]) {
    const rejectFetch = stubFetch(() => json(body));
    const rejectProvider = createAnySearchProvider({ key: 'k', fetch: rejectFetch });
    await assert.rejects(
      () => rejectProvider.extract('https://example.com/a', undefined),
      error => error instanceof SearchProviderError && error.status === 422,
    );
  }
});

test('anysearch.extract: HTTP 422 maps to a 422 SearchProviderError', async () => {
  const fetchImpl = stubFetch(() => json({ error: 'unprocessable' }, 422));
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });
  await assert.rejects(
    () => provider.extract('https://example.com/a', undefined),
    error => error instanceof SearchProviderError && error.status === 422 && /无法处理/.test(error.message),
  );
});

test('anysearch.capabilities: builds repeated domain params and returns the list', async () => {
  const fetchImpl = stubFetch(() => json({ code: 0, data: { domains: ['a.example', { domain: 'b.example' }, 7] } }));
  const provider = createAnySearchProvider({ key: 'k', fetch: fetchImpl });

  const domains = await provider.capabilities(['a.example', 'b.example', '  '], undefined);
  assert.deepEqual(domains, ['a.example', 'b.example']);

  const requested = new URL(fetchImpl.calls[0].url);
  assert.equal(requested.origin + requested.pathname, 'https://api.anysearch.com/v1/sub-domains');
  assert.deepEqual(requested.searchParams.getAll('domain'), ['a.example', 'b.example']);
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, 'Bearer k');

  assert.deepEqual(await provider.capabilities([], undefined), []);
  assert.equal(fetchImpl.calls.length, 1, '空域名列表不发请求');
});
