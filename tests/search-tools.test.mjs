import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchTools, pickVerticalSearch, runChatAgent } from '../electron/chat-agent.mjs';

const entry = { id: 'search-model', name: 'Search', vision: false, efforts: ['low'] };
const provider = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
const signal = () => new AbortController().signal;
const request = () => ({ thinking: 'low', messages: [{ role: 'user', text: '查一下最新的公开数据' }] });

function chunk(delta, finish_reason = null) {
  return 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n';
}

function toolCompletion(id, name, args) {
  return new Response(
    chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null)
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function textCompletion(text) {
  return new Response(chunk({ content: text }, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

const ROW = {
  url: 'https://example.org/data', title: '示例数据', snippet: '', content: '',
  published: '2025-03-11', provider: 'fake', query: '香港 出口 2024', rank: 1,
};
const EVIDENCE = {
  ...ROW,
  site: 'example.org',
  pages: [{ text: '2024 年出口额为 123 亿港元。', start: 0 }],
  chars: 2400,
};

function fakeService({
  rows = [ROW], evidence = [EVIDENCE], meta = {}, extract = null, vertical = false, onSearch = null,
} = {}) {
  const calls = { search: [], read: [] };
  return {
    calls,
    hasExtract: () => typeof extract === 'function',
    // vertical: 只有暴露 capabilities 的源才算「支持垂直检索」，与真实 provider 同口径。
    activeProviders: () => [{
      id: 'fake',
      hasExtract: typeof extract === 'function',
      ...(vertical ? { capabilities: async () => [] } : {}),
    }],
    async search(input) {
      calls.search.push(input);
      // onSearch 返回 undefined 时走默认结果，便于单测里按调用序号切换空/有结果/抛错。
      const custom = typeof onSearch === 'function' ? await onSearch(input, calls.search.length) : undefined;
      if (custom !== undefined) return custom;
      return {
        rows,
        evidence,
        meta: { candidates: 2, deduped: 2, read: evidence.length, passages: evidence.length, ...meta },
      };
    },
    async read(input) {
      calls.read.push(input);
      if (typeof extract !== 'function') throw new Error('当前没有可读取正文的搜索源');
      return extract(input);
    },
  };
}

const BASE_OPTIONS = { readCount: 3, maxResults: 10, maxQueries: 3, limits: { queries: 12, reads: 8, chars: 120000, ms: 60000 } };

test('web_search: 一次多查询只发 running + done，结果带 sources/meta 和编号证据块', async () => {
  const service = fakeService({ extract: async () => EVIDENCE });
  const events = [];
  const payloads = [];
  await runChatAgent({
    key: 'k', searchKey: undefined, provider, entry, request: request(), signal: signal(),
    emit: event => events.push(event),
    searchService: service, searchOptions: BASE_OPTIONS,
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) {
        return toolCompletion('call_search', 'web_search', {
          queries: ['香港 出口 2024', 'Hong Kong exports 2024'],
          recency: 'year',
        });
      }
      return textCompletion('已找到来源。');
    },
  });

  const offered = payloads[0].tools.map(tool => tool.function.name);
  assert.ok(offered.includes('web_search'), offered.join(','));
  assert.ok(offered.includes('web_read'), 'hasExtract 时同时提供 web_read');

  const searches = events.filter(event => event.type === 'search');
  assert.deepEqual(searches.map(event => event.status), ['running', 'done']);
  assert.deepEqual(searches[0].queries, ['香港 出口 2024', 'Hong Kong exports 2024']);
  const done = searches[1];
  assert.equal(done.queries.length, 2);
  assert.equal(done.sources.length, 1);
  assert.deepEqual(Object.keys(done.sources[0]).sort(), ['id', 'published', 'site', 'title', 'url']);
  assert.equal(done.sources[0].site, 'example.org');
  assert.equal(done.sources[0].url, 'https://example.org/data');
  assert.equal(done.meta.read, 1);
  assert.deepEqual(done.meta.queries, ['香港 出口 2024', 'Hong Kong exports 2024']);

  // service 收到的是规范化后的查询、时效与 options；queries 额度由 agent 自己扣。
  assert.equal(service.calls.search.length, 1);
  assert.equal(service.calls.search[0].options.recency, 'year');
  assert.equal(service.calls.search[0].budget.remaining('queries'), 10);

  const toolMessage = payloads[1].messages.at(-1);
  assert.equal(toolMessage.role, 'tool');
  assert.match(toolMessage.content, /\[1\]/);
  assert.match(toolMessage.content, /检索说明/);
  assert.match(toolMessage.content, /2024 年出口额为 123 亿港元/);
});

test('web_read: 返回选中段落并先后发出 running / done 事件', async () => {
  const service = fakeService({
    extract: async () => ({
      ...EVIDENCE,
      title: '统计局页面',
      readError: undefined,
    }),
  });
  const events = [];
  const payloads = [];
  await runChatAgent({
    key: 'k', provider, entry, request: request(), signal: signal(),
    emit: event => events.push(event),
    searchService: service, searchOptions: BASE_OPTIONS,
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) {
        return toolCompletion('call_read', 'web_read', {
          url: 'https://example.org/data', question: '2024 年出口额', maxChars: 2000,
        });
      }
      return textCompletion('已读取。');
    },
  });

  const reads = events.filter(event => event.type === 'read');
  assert.deepEqual(reads.map(event => event.status), ['running', 'done']);
  assert.equal(reads[0].url, 'https://example.org/data');
  assert.equal(reads[1].title, '统计局页面');
  assert.ok(reads[1].chars > 0);
  assert.equal(service.calls.read.length, 1);
  assert.equal(service.calls.read[0].question, '2024 年出口额');

  const toolMessage = payloads[1].messages.at(-1);
  assert.match(toolMessage.content, /统计局页面/);
  assert.match(toolMessage.content, /2024 年出口额为 123 亿港元/);
});

test('web_read: 读取失败时发出 error 事件并返回 isError，而不是抛出', async () => {
  const events = [];
  const service = fakeService({ extract: async () => { throw new Error('AnySearch 配额不足'); } });
  const { tools } = createSearchTools({
    push: event => events.push(event), signal: signal(),
    searchService: service, searchOptions: BASE_OPTIONS,
  });
  const readTool = tools.find(tool => tool.name === 'web_read');
  assert.ok(readTool, 'web_read 应该下发');
  const result = await readTool.execute('call_read', { url: 'https://example.org/data' }, undefined);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /配额不足/);
  assert.deepEqual(events.map(event => event.status), ['running', 'error']);
  assert.match(events[1].detail, /配额不足/);
});

test('web_search: 查询额度用尽后返回 isError 与「检索预算」，不再外呼', async () => {
  const service = fakeService();
  const events = [];
  const payloads = [];
  await runChatAgent({
    key: 'k', provider, entry, request: request(), signal: signal(),
    emit: event => events.push(event),
    searchService: service,
    searchOptions: { ...BASE_OPTIONS, limits: { ...BASE_OPTIONS.limits, queries: 2 } },
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) {
        return toolCompletion('call_one', 'web_search', { queries: ['查询甲', '查询乙'] });
      }
      if (payloads.length === 2) {
        return toolCompletion('call_two', 'web_search', { queries: ['查询丙'] });
      }
      return textCompletion('按已有结果作答。');
    },
  });

  assert.equal(service.calls.search.length, 1, '额度用尽后不应再调用 service');
  const second = payloads[2].messages.at(-1);
  assert.equal(second.role, 'tool');
  assert.match(second.content, /检索预算/);
  const errors = events.filter(event => event.type === 'search' && event.status === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].detail, /检索预算/);
});

test('legacy: MOVA_SEARCH_MODE=legacy 完全回退旧版单查询工具（含 3 次上限）', async t => {
  const previous = process.env.MOVA_SEARCH_MODE;
  process.env.MOVA_SEARCH_MODE = 'legacy';
  t.after(() => {
    if (previous === undefined) delete process.env.MOVA_SEARCH_MODE;
    else process.env.MOVA_SEARCH_MODE = previous;
  });

  const service = fakeService();
  const events = [];
  const payloads = [];
  const queries = [];
  await runChatAgent({
    key: 'k', searchKey: 'legacy-key', provider, entry, request: request(), signal: signal(),
    emit: event => events.push(event),
    // 即使注入了 service，环境变量也必须让旧路径生效。
    searchService: service, searchOptions: BASE_OPTIONS,
    search: async (_key, query) => {
      queries.push(query);
      return [{ title: 'Example', url: 'https://example.org/source', snippet: 'Useful' }];
    },
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      const index = payloads.length;
      if (index <= 4) return toolCompletion(`call${index}`, 'web_search', { query: `q${index}` });
      return textCompletion('完成');
    },
  });

  const offered = payloads[0].tools.map(tool => tool.function.name);
  assert.ok(offered.includes('web_search'), offered.join(','));
  assert.ok(!offered.includes('web_read'), '旧路径没有 web_read');
  assert.equal(service.calls.search.length, 0, '旧路径不经过 service');

  // 结果仍然是旧的 JSON.stringify(sources)。
  const first = payloads[1].messages.at(-1);
  assert.equal(first.role, 'tool');
  assert.deepEqual(JSON.parse(first.content), [{ title: 'Example', url: 'https://example.org/source', snippet: 'Useful' }]);

  // 事件形状也是旧的：只有 query，没有 queries。
  const firstSearchEvent = events.find(event => event.type === 'search');
  assert.equal(firstSearchEvent.query, 'q1');
  assert.equal(firstSearchEvent.queries, undefined);

  // 第 4 次调用撞上 3 次上限。
  assert.deepEqual(queries, ['q1', 'q2', 'q3']);
  const fourth = payloads[4].messages.at(-1);
  assert.match(fourth.content, /本轮已达到 3 次搜索上限/);
});

test('没有 service 也没有 search 时不提供任何联网搜索工具', async () => {
  const payloads = [];
  await runChatAgent({
    key: 'k', provider, entry, request: request(), signal: signal(),
    emit: () => {},
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return textCompletion('无法联网。');
    },
  });
  const offered = payloads[0].tools.map(tool => tool.function.name);
  assert.ok(!offered.includes('web_search'), offered.join(','));
  assert.ok(!offered.includes('web_read'));
  assert.match(JSON.stringify(payloads[0].messages), /Web search is unavailable/);
});

test('没有正文读取能力时只下发 web_search', async () => {
  const service = fakeService({ extract: null });
  const payloads = [];
  await runChatAgent({
    key: 'k', provider, entry, request: request(), signal: signal(),
    emit: () => {},
    searchService: service, searchOptions: BASE_OPTIONS,
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return textCompletion('好');
    },
  });
  const offered = payloads[0].tools.map(tool => tool.function.name);
  assert.ok(offered.includes('web_search'));
  assert.ok(!offered.includes('web_read'));
  assert.doesNotMatch(JSON.stringify(payloads[0].messages), /Call web_read before quoting/);
});

// ── 垂直索引：pickVerticalSearch 路由表 ─────────────────────────────
function searchToolFor(service, options = BASE_OPTIONS) {
  const events = [];
  const { tools } = createSearchTools({
    push: event => events.push(event), signal: signal(), searchService: service, searchOptions: options,
  });
  return { tool: tools.find(item => item.name === 'web_search'), events };
}

test('pickVerticalSearch: 三个索引按「代码 → 论文 → 行情」先命中先返回', () => {
  const cases = [
    ['这个 Python 报错怎么修', 'code.snippet'],
    ['调用 api 报 502 怎么排查', 'code.snippet'],
    ['帮我看看这段代码的异常', 'code.snippet'],
    ['import 之后打包失败', 'code.snippet'],
    ['script.py 运行不起来', 'code.snippet'],
    ['github 上有没有现成实现', 'code.snippet'],
    ['写个正则匹配手机号', 'code.snippet'],
    ['arxiv 上最新的论文', 'academic.paper'],
    ['survey of transformer papers', 'academic.paper'],
    ['找几篇文献综述', 'academic.paper'],
    ['这个 doi 对应的研究', 'academic.paper'],
    ['AAPL 股价', 'finance.quote'],
    ['btc 行情 和 etf 资金流', 'finance.quote'],
    ['这家公司的财报 市盈 市值', 'finance.quote'],
    // 顺序即优先级：同时像代码和论文时给代码。
    ['论文里的 python 代码示例', 'code.snippet'],
  ];
  for (const [query, tag] of cases) {
    const picked = pickVerticalSearch(query);
    assert.ok(picked, query);
    assert.equal(picked.tag, tag, query);
  }
  // 行情索引带能力参数。
  assert.deepEqual(pickVerticalSearch('AAPL 股价'), { tag: 'finance.quote', params: { type: 'stock' } });
  assert.deepEqual(pickVerticalSearch('调用 api'), { tag: 'code.snippet' });
  // 词界：rapid 里的 api 不算命中；apiary 这类开头命中可以接受。
  assert.equal(pickVerticalSearch('rapid growth of exports in 2024'), null);
  assert.deepEqual(pickVerticalSearch('apiary keeping guide'), { tag: 'code.snippet' });
  assert.deepEqual(pickVerticalSearch('在句子中间提到 papers 也算学术'), { tag: 'academic.paper' });
  // 非字符串 / 空串 / 无关键词（含纯中文问题）一律 null。
  for (const value of [null, undefined, 42, true, ['python'], { query: 'python' }, '', '   ']) {
    assert.equal(pickVerticalSearch(value), null, String(value));
  }
  assert.equal(pickVerticalSearch('香港 出口 2024 年数据'), null);
  assert.equal(pickVerticalSearch('央行降息 最新进展'), null);
});

test('web_search: tag / params 原样透传给 service', async () => {
  const service = fakeService({ extract: async () => EVIDENCE, vertical: true });
  const { tool } = searchToolFor(service);
  const result = await tool.execute('call_tag', {
    query: 'python asyncio', tag: 'code.snippet', params: { lang: 'python' },
  }, undefined);

  assert.equal(result.isError, undefined);
  assert.equal(service.calls.search.length, 1);
  assert.equal(service.calls.search[0].options.tag, 'code.snippet');
  assert.deepEqual(service.calls.search[0].options.params, { lang: 'python' });

  // params 最多 6 个键，多的截掉；没有 tag 时 params 不下发。
  await tool.execute('call_many_params', {
    query: '港股', tag: 'finance.quote',
    params: { type: 'stock', symbol: 'AAPL', a: '1', b: '2', c: '3', d: '4', e: '5' },
  }, undefined);
  assert.equal(Object.keys(service.calls.search[1].options.params).length, 6);
  assert.equal(service.calls.search[1].options.params.type, 'stock');

  await tool.execute('call_params_no_tag', { query: '香港 出口 2024', params: { lang: 'zh' } }, undefined);
  assert.equal(service.calls.search[2].options.tag, undefined);
  assert.equal(service.calls.search[2].options.params, undefined);
});

test('web_search: 模型没给 tag 时按查询意图自动路由', async () => {
  const service = fakeService({ extract: async () => EVIDENCE, vertical: true });
  const { tool } = searchToolFor(service);
  const result = await tool.execute('call_auto', { query: '这个 Python 报错怎么修' }, undefined);

  assert.equal(result.isError, undefined);
  assert.equal(service.calls.search.length, 1);
  assert.equal(service.calls.search[0].options.tag, 'code.snippet');
  assert.equal(service.calls.search[0].options.params, undefined);

  // 通用问题不路由。
  await tool.execute('call_general', { query: '香港 出口 2024 年数据' }, undefined);
  assert.equal(service.calls.search[1].options.tag, undefined);
});

test('web_search: 显式 tag 优先于意图路由', async () => {
  const service = fakeService({ extract: async () => EVIDENCE, vertical: true });
  const { tool } = searchToolFor(service);
  await tool.execute('call_explicit', { query: '这个 Python 报错怎么修', tag: 'academic.paper' }, undefined);

  assert.equal(service.calls.search.length, 1);
  assert.equal(service.calls.search[0].options.tag, 'academic.paper');
  assert.equal(service.calls.search[0].options.params, undefined);
});

test('垂直索引零结果：只重试一次通用检索，并在文本里说明兜底', async () => {
  const service = fakeService({
    extract: async () => EVIDENCE,
    vertical: true,
    onSearch: input => (input.options.tag
      ? { rows: [], evidence: [], meta: { candidates: 0, deduped: 0, read: 0, passages: 0 } }
      : undefined),
  });
  const { tool, events } = searchToolFor(service);
  const result = await tool.execute('call_empty_tag', { query: '这个 Python 报错怎么修' }, undefined);

  assert.equal(result.isError, undefined);
  assert.equal(service.calls.search.length, 2, '带 tag 的一次 + 通用检索一次，绝不重试第三次');
  assert.equal(service.calls.search[0].options.tag, 'code.snippet');
  assert.equal(service.calls.search[1].options.tag, undefined);
  assert.equal(service.calls.search[1].options.params, undefined);
  const text = result.content[0].text;
  assert.match(text, /垂直检索无结果，已按通用搜索重试/);
  assert.match(text, /\[1\]/, '兜底结果照常给编号证据');
  assert.deepEqual(events.filter(event => event.type === 'search').map(event => event.status), ['running', 'done']);
});

test('垂直索引请求出错时整轮不重试', async () => {
  const service = fakeService({
    vertical: true,
    onSearch: input => {
      if (input.options.tag) throw new Error('AnySearch 请求失败');
    },
  });
  const { tool } = searchToolFor(service);
  const result = await tool.execute('call_tag_error', { query: '这个 Python 报错怎么修' }, undefined);

  assert.equal(result.isError, true);
  assert.equal(service.calls.search.length, 1, '出错不重试');
  assert.match(result.content[0].text, /AnySearch 请求失败/);
});

test('web_search: read:false 只取摘要（readCount 0）', async () => {
  const service = fakeService({ extract: async () => EVIDENCE, vertical: true });
  const { tool } = searchToolFor(service);
  const result = await tool.execute('call_snippet_only', { query: '香港 出口 2024', read: false }, undefined);

  assert.equal(result.isError, undefined);
  assert.equal(service.calls.search[0].options.readCount, 0);
  assert.equal(service.calls.search[0].options.maxResults, 10);
  assert.doesNotMatch(result.content[0].text, /读取失败/);
});

test('源不支持垂直检索：显式 tag 被丢弃并在文本里说明', async () => {
  // 默认 fakeService 的 provider 不暴露 capabilities。
  const service = fakeService();
  const { tool } = searchToolFor(service);
  const result = await tool.execute('call_no_capability', {
    query: '这个 Python 报错怎么修', tag: 'code.snippet', params: { lang: 'python' },
  }, undefined);

  assert.equal(result.isError, undefined);
  assert.equal(service.calls.search.length, 1);
  assert.equal(service.calls.search[0].options.tag, undefined);
  assert.equal(service.calls.search[0].options.params, undefined);
  assert.match(result.content[0].text, /该搜索源不支持垂直检索，已按通用搜索执行/);
});
