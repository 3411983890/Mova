import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createSearchTools, runChatAgent } from '../electron/chat-agent.mjs';

const require = createRequire(import.meta.url);
const { createSearchService } = require('../electron/search/index.cjs');
const { validateCitations } = require('../electron/search/citation.cjs');

// ── 假数据 ──────────────────────────────────────────────────────────
// 每个 topic = 一个领域问题：期望站点、事实句、标题、模板枚举。全部离线。
// 5 个类别 × 12 个 topic = 60 个用例；类别只影响提问措辞，不影响假 provider 的行为。
const CATEGORIES = ['时效', '对比', '长尾', '文档', '中文站内'];

const TOPICS = [
  { domain: 'stats.gov.hk', name: '香港出口额', title: '香港出口统计', fact: '2024 年香港出口额为 1288 亿港元' },
  { domain: 'reuters.com', name: '央行降息', title: 'Rate cut report', fact: 'The central bank cut its policy rate by 25 basis points in June 2024' },
  { domain: 'developer.mozilla.org', name: 'Response.json', title: 'Response.json()', fact: 'Response.json() returns a promise that resolves with the parsed JSON body' },
  { domain: 'arxiv.org', name: 'Transformer 翻译', title: 'Attention is all you need', fact: 'The transformer model reaches 28.4 BLEU on the WMT 2014 English to German task' },
  { domain: 'wikipedia.org', name: '哈尔滨冰雪大世界', title: 'Harbin Ice and Snow World', fact: 'Harbin Ice and Snow World opened in 1999 and covers 600000 square metres' },
  { domain: 'github.com', name: 'node:sqlite', title: 'node:sqlite', fact: 'Node 24 ships the built-in node:sqlite module for local storage' },
  { domain: 'docs.python.org', name: 'asyncio.run', title: 'asyncio.run', fact: 'asyncio.run() creates a new event loop and closes it after the coroutine finishes' },
  { domain: 'nodejs.org', name: 'AbortSignal.timeout', title: 'AbortSignal.timeout', fact: 'AbortSignal.timeout() aborts after the given number of milliseconds' },
  { domain: 'xinhuanet.com', name: '粮食产量', title: '粮食产量', fact: '2024 年全国粮食总产量为 14130 亿斤' },
  { domain: 'people.com.cn', name: '项目投产', title: '项目投产', fact: '该项目于 2023 年 5 月正式投产，年产能为 120 万吨' },
  { domain: 'apnews.com', name: '月面着陆', title: 'Lunar landing', fact: 'The spacecraft landed on the lunar south pole in February 2025' },
  { domain: 'nature.com', name: '叠层电池效率', title: 'Tandem cell', fact: 'The measured efficiency of the tandem cell reached 33.7 percent' },
];

const PHRASINGS = [
  name => `${name} 最新进展 2025 年数据`,
  name => `${name} 对比 两种方案 的差异 优劣`,
  name => `${name} 有没有 具体细节 实施 案例 说明 与 踩坑`,
  name => `${name} 官方文档 接口说明 参数`,
  name => `${name} 站内 中文 报道 权威 解读`,
];

/** 12 topics × 5 phrasings：每个 topic 的 5 句提问各落在一个类别里。 */
const CASES = CATEGORIES.flatMap((category, index) => TOPICS.map(topic => ({
  category,
  index,
  name: `${category} · ${topic.name}`,
  question: PHRASINGS[index](topic.name),
  topic,
})));

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 6 行候选：2 行期望站点 + 4 行离题垃圾站。 */
function rowsFor(topic) {
  const expected = [
    { url: `https://www.${topic.domain}/fact`, title: topic.title, snippet: '', content: '', published: null },
    { url: `https://${topic.domain}/other`, title: `${topic.title}（补充页）`, snippet: '', content: '', published: null },
  ];
  const junk = [0, 1, 2, 3].map(i => ({
    url: `https://junk${i}.example/off-topic`,
    title: `离题结果 ${i}`,
    snippet: '与问题无关的内容。',
    content: '',
    published: null,
  }));
  return [...expected, ...junk];
}

function fakeProvider(topic) {
  const rows = rowsFor(topic);
  return {
    id: 'fake',
    label: 'Fake',
    hasExtract: true,
    async search(query) {
      return rows.map((row, index) => ({ ...row, provider: 'fake', query, rank: index + 1 }));
    },
    async extract(url) {
      const host = hostOf(url);
      const row = rows.find(item => item.url === url) || {};
      if (host === topic.domain && url.endsWith('/fact')) {
        return { url, title: topic.title, text: `${topic.title}。本页结论：${topic.fact}。` };
      }
      return { url, title: `${host} 页面`, text: `${host} 上的一篇无关文章，讨论天气与交通。` };
    },
  };
}

function toolsetFor(topic) {
  const service = createSearchService({ providers: [fakeProvider(topic)], now: () => Date.now() });
  const seen = [];
  const wrapped = {
    ...service,
    async search(input) {
      const result = await service.search(input);
      seen.push(result);
      return result;
    },
  };
  const events = [];
  const toolset = createSearchTools({
    push: event => events.push(event),
    signal: new AbortController().signal,
    searchService: wrapped,
    searchOptions: {
      readCount: 4, maxResults: 10, maxQueries: 3,
      limits: { queries: 12, reads: 8, chars: 120000, ms: 60000 },
    },
  });
  const tool = name => toolset.tools.find(item => item.name === name);
  return { toolset, events, seen, research: tool('web_research'), verify: tool('verify_citations'), service };
}

/** 证据块里包含事实句的那一块 → 它的 [n] 与域名。 */
function factBlock(evidenceText, fact) {
  const blocks = evidenceText.split('\n\n').filter(block => block.includes(fact));
  return blocks;
}

// ── 每个用例 ────────────────────────────────────────────────────────
for (const item of CASES) {
  test(`golden ${item.category}: ${item.topic.name}`, async () => {
    const { research, verify, seen, events } = toolsetFor(item.topic);

    const answer = await research.execute('call_research', { question: item.question, readCount: 4 });
    assert.equal(answer.isError, undefined, '检索不应失败');
    const evidenceText = answer.content[0].text;
    assert.match(evidenceText, /补搜建议/, '必须带「补搜建议」尾巴');

    // 事件：一次 running + 一次 done，done 带 sources 与「已自动阅读 N 页」。
    const searches = events.filter(event => event.type === 'search');
    assert.deepEqual(searches.map(event => event.status), ['running', 'done']);
    assert.equal(searches[1].meta.note, `已自动阅读 ${searches[1].meta.read} 页`);
    assert.ok(Array.isArray(searches[1].sources));

    const { rows, evidence } = seen.at(-1);

    // (a) 期望站点出现在融合后的前 5 条里。
    const topHosts = rows.slice(0, 5).map(row => hostOf(row.url));
    assert.ok(topHosts.includes(item.topic.domain), `top5=${topHosts.join(',')}`);

    // (b) 事实页被编号，并且编号能对回期望站点。
    const blocks = factBlock(evidenceText, item.topic.fact);
    assert.equal(blocks.length, 1, '事实句只应出现在一个证据块里');
    const marker = Number(/^\[(\d+)\]/.exec(blocks[0])?.[1]);
    assert.ok(Number.isInteger(marker) && marker >= 1, blocks[0].slice(0, 60));
    assert.equal(hostOf(evidence[marker - 1].url), item.topic.domain);

    // (c) 手写答案引用那个 [n] 能通过校验（纯函数 + 工具面两条路径）。
    const draft = `${item.topic.fact} [${marker}]。`;
    const direct = validateCitations(draft, evidence);
    assert.equal(direct.ok, true, JSON.stringify(direct));
    assert.equal(direct.missing.length, 0);
    const verified = await verify.execute('call_verify', { answer: draft });
    assert.equal(verified.isError, undefined, verified.content[0].text);
    assert.match(verified.content[0].text, /引用校验：1 处引用，尽数可核验。/);

    // (d) 引用不存在的 [9] 必须报 missing:[9]。
    const bogus = validateCitations(`${item.topic.fact} [9]。`, evidence);
    assert.deepEqual(bogus.missing, [9]);
    assert.equal(bogus.ok, false);
    const rejected = await verify.execute('call_verify_bad', { answer: `${item.topic.fact} [9]。` });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /\[9\]/);
  });
}

test('golden: 用例组合覆盖 5 个类别，每类 12 个，共 60 个', () => {
  assert.equal(CASES.length, 60);
  for (const category of CATEGORIES) {
    assert.equal(CASES.filter(item => item.category === category).length, 12, category);
  }
});

test('golden: 空结果给出「没有找到可用的公开来源」且不抛错', async () => {
  for (const category of CATEGORIES) {
    const events = [];
    const empty = {
      hasExtract: () => true,
      activeProviders: () => [{ id: 'fake', hasExtract: true }],
      async search() {
        return { rows: [], evidence: [], meta: { candidates: 0, deduped: 0, read: 0, passages: 0 } };
      },
      async read() { throw new Error('不应读取'); },
    };
    const { tools } = createSearchTools({
      push: event => events.push(event), signal: new AbortController().signal,
      searchService: empty, searchOptions: { readCount: 4, maxResults: 10, maxQueries: 3 },
    });
    const research = tools.find(tool => tool.name === 'web_research');
    const result = await research.execute('call_empty', { question: `${category} 空结果` });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /没有找到可用的公开来源/);
    assert.match(text, /检索说明/);
    assert.match(text, /补搜建议/);
    assert.deepEqual(events.filter(event => event.type === 'search').map(event => event.status), ['running', 'done']);
  }
});

test('golden: web_research 的查询数扣减与预算耗尽文案', async () => {
  const events = [];
  const calls = [];
  const service = {
    hasExtract: () => false,
    activeProviders: () => [],
    async search(input) {
      calls.push(input);
      return { rows: [], evidence: [], meta: { candidates: 0, deduped: 0, read: 0, passages: 0 } };
    },
  };
  const { tools } = createSearchTools({
    push: event => events.push(event), signal: new AbortController().signal,
    searchService: service,
    searchOptions: { readCount: 4, maxResults: 10, maxQueries: 5, limits: { queries: 2, reads: 8, chars: 120000, ms: 60000 } },
  });
  const research = tools.find(tool => tool.name === 'web_research');
  const first = await research.execute('call_a', { question: '第一个问题' });
  assert.equal(first.isError, undefined);
  assert.deepEqual(calls[0].queries, ['第一个问题']);
  assert.equal(calls[0].options.readCount, 0, '没有正文能力时不排队读正文');

  const second = await research.execute('call_b', { question: '第二个问题', queries: ['a', 'b'] });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /检索预算/);
  const errors = events.filter(event => event.type === 'search' && event.status === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].detail, /检索预算/);
});

test('golden: 没有证据时 verify_citations 直接提示先检索', async () => {
  const { verify } = toolsetFor(TOPICS[0]);
  const result = await verify.execute('call_verify_empty', { answer: '见 [1]。' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /还没有任何证据/);
});

// ── 工具面接入 ──────────────────────────────────────────────────────
const ENTRY = { id: 'golden-model', name: 'Golden', vision: false, efforts: ['low'] };
const PROVIDER = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };

function sse(delta, finish = null) {
  return 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: ENTRY.id,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n';
}

function textCompletion(text) {
  return new Response(sse({ content: text }, 'stop') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('golden: 服务分支同时下发 web_research 与 verify_citations，提示词同步', async () => {
  const payloads = [];
  await runChatAgent({
    key: 'k', provider: PROVIDER, entry: ENTRY,
    request: { thinking: 'low', messages: [{ role: 'user', text: '查一下最新的公开数据' }] },
    signal: new AbortController().signal,
    emit: () => {},
    searchService: {
      hasExtract: () => false,
      activeProviders: () => [],
      async search() { return { rows: [], evidence: [], meta: {} }; },
    },
    searchOptions: { readCount: 4, maxResults: 10, maxQueries: 3 },
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return textCompletion('好');
    },
  });

  const names = payloads[0].tools.map(tool => tool.function.name);
  assert.ok(names.includes('web_search'), names.join(','));
  assert.ok(names.includes('web_research'), names.join(','));
  assert.ok(names.includes('verify_citations'), names.join(','));
  assert.ok(!names.includes('web_read'), '没有正文能力时不下发 web_read');

  const prompt = JSON.stringify(payloads[0].messages);
  assert.match(prompt, /verify_citations/);
  assert.match(prompt, /web_research/);
});

test('golden: legacy 分支的工具面与预算保持原样（不新增工具）', () => {
  const legacy = createSearchTools({
    push: () => {}, signal: new AbortController().signal, searchKey: 'legacy-key', legacy: true,
  });
  assert.deepEqual(legacy.tools.map(tool => tool.name), ['web_search']);
  assert.equal(legacy.budget, null);
  assert.deepEqual(legacy.tools[0].parameters.required, ['query']);
});
