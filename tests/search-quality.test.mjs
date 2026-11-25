import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rerank, queryTerms, lexicalOverlap } = require('../electron/search/score.cjs');
const { chunk } = require('../electron/search/passage.cjs');
const { formatEvidence } = require('../electron/search/pack.cjs');
const { createSearchService } = require('../electron/search/index.cjs');

// ── 通用桩 ──────────────────────────────────────────────────────────
// 全部离线：provider 只返回内存里的行，extract 只回放固定正文。

const ZH_QUERY = '香港故宫文化博物馆 2025 年特展';
const EN_QUERY = 'Hong Kong Palace Museum 2025 exhibition highlights';

/** 与 fuse() 输出同 shape 的一条候选。 */
function fusedRow({ url, title, snippet = '', score, query }) {
  return {
    url,
    title,
    snippet,
    content: '',
    published: null,
    provider: 'anysearch',
    query,
    rank: 1,
    key: url,
    score,
    providers: new Set(['anysearch']),
    queries: new Set(query ? [query] : []),
  };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 假 provider：rows 是 { [query]: Row[] } 或 (query) => Row[]。
 * extract 对 failUrls 里的链接抛错，其余返回 extractText（可以是函数）。
 */
function fakeProvider({ rows = {}, failUrls = [], extractText = '默认正文。' } = {}) {
  const calls = { search: [], extract: [] };
  const provider = {
    id: 'fake',
    label: 'Fake',
    hasExtract: true,
    calls,
    async search(query) {
      calls.search.push(query);
      const list = typeof rows === 'function' ? rows(query) : (rows[query] || []);
      return list.map((row, index) => ({
        url: row.url,
        title: row.title || row.url,
        snippet: row.snippet || '',
        content: '',
        published: null,
        provider: 'fake',
        query,
        rank: index + 1,
      }));
    },
    async extract(url) {
      calls.extract.push(url);
      if (failUrls.includes(url)) throw new Error('正文读取失败：422');
      const text = typeof extractText === 'function' ? extractText(url) : extractText;
      return { url, title: `${hostOf(url)} 页面`, text };
    },
  };
  return provider;
}

// ── 1. 排序回归：live 那次「官方页 vs 离题页」 ────────────────────────
test('ranking: 查询词面命中把官方页顶到离题页之前（0.015 vs 0.016 的 live 场景）', () => {
  const official = fusedRow({
    url: 'https://www.hkpm.org.hk/tc/home',
    title: '香港故宮文化博物館｜首頁',
    snippet: '香港故宫文化博物馆将于 3 月 15 日举办年度特展，详见官网。',
    score: 0.015,
    query: ZH_QUERY,
  });
  const offTopic = fusedRow({
    url: 'https://www.smithsonianmag.com/events/spring-2025',
    title: 'Smithsonian Event Calendar',
    snippet: 'Upcoming events at the Smithsonian in Washington DC.',
    score: 0.016,
    query: EN_QUERY,
  });

  // 词表口径：CJK 二元组 + 长度 ≥3 的拉丁词。
  assert.deepEqual(queryTerms('香港 2025 年特展'), ['2025', '香港', '年特', '特展']);
  assert.deepEqual(queryTerms(''), []);
  assert.deepEqual(queryTerms(undefined), []);

  // 官方页标题/摘要里 11 个查询词命中了 9 个（「年特」被「年度特展」挡住）；离题页 0 个。
  const zhTerms = queryTerms(ZH_QUERY);
  assert.equal(zhTerms.length, 11);
  assert.equal(lexicalOverlap(offTopic), 0);
  assert.ok(Math.abs(lexicalOverlap(official) - 9 / 11) < 1e-12, String(lexicalOverlap(official)));

  const ranked = rerank([offTopic, official], { perHost: 3 });
  assert.deepEqual(ranked.map(row => hostOf(row.url)), ['hkpm.org.hk', 'smithsonianmag.com']);
  assert.equal(ranked[0].weight, 1, '两侧权重相同，胜负只来自查询词命中');

  // 没有 query（或没有命中）时排序与旧行为一致：score 高的在前。
  const blind = rerank([
    fusedRow({ url: official.url, title: official.title, snippet: official.snippet, score: 0.015 }),
    fusedRow({ url: offTopic.url, title: offTopic.title, snippet: offTopic.snippet, score: 0.016 }),
  ], { perHost: 3 });
  assert.deepEqual(blind.map(row => hostOf(row.url)), ['smithsonianmag.com', 'hkpm.org.hk']);
  assert.equal(lexicalOverlap({ title: '任何标题' }), 0);
});

// ── 2. 切块：不切断 URL / 单词，偏移可回指 ──────────────────────────
test('chunk: 长 URL 与中英混排按句/行边界对齐，偏移可回指且不丢字', () => {
  const URL = 'https://www.hkpm.org.hk/tc/join-and-support/membership-and-benefits/terms-and-conditions?ref=nav&spm=abc123';
  const PHRASE = '目标是确认特展的门票安排与开放时间';
  const ZH = '香港故宫文化博物馆位于西九文化区，常年举办特展与教育活动，开放时间为上午十点至下午六点。';
  const EN = 'The Hong Kong Palace Museum opens at ten in the morning and closes at six in the evening on most days.';
  // 前缀故意不留句末标点，逼第一刀落在 URL 中间，交给 URL 守卫处理。
  const runIn = '香港故宫文化博物馆会员条款与细则说明如下详见官方网站入口'.repeat(5);
  const body = [`${runIn}：${URL}`, `${PHRASE}。 ${EN}`, ZH, EN].join('\n');

  const urlStart = body.indexOf(URL);
  const urlEnd = urlStart + URL.length;
  const pages = chunk(body, { size: urlStart + 25, overlap: 200 });

  assert.ok(pages.length >= 3, `应当切出多块，实际 ${pages.length}`);
  const spans = [...body.matchAll(/https?:\/\/[^\s<>"'）)】\]，。；、]+/g)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  assert.ok(spans.some(span => span.start === urlStart && span.end === urlEnd));

  let previousStart = -1;
  let covered = 0;
  for (const page of pages) {
    const end = page.start + page.text.length;
    // 偏移必须能原样回指原文，且落在正文范围内。
    assert.equal(body.slice(page.start, end), page.text, 'text 必须等于 body.slice(start, end)');
    assert.ok(page.start >= 0 && end <= body.length);
    assert.ok(page.start > previousStart, 'start 必须单调递增');
    assert.ok(page.text.length > 0);
    previousStart = page.start;
    assert.ok(page.start <= covered, '相邻块不得留下未覆盖的字');
    covered = Math.max(covered, end);

    for (const span of spans) {
      const insideStart = page.start > span.start && page.start < span.end;
      const insideEnd = end > span.start && end < span.end;
      assert.equal(insideStart, false, `chunk 起点切在 URL 中间：${page.text.slice(0, 40)}`);
      assert.equal(insideEnd, false, `chunk 终点切在 URL 中间：${page.text.slice(-40)}`);
    }
    // 英文单词不得被切两半（两侧都是拉丁字母即视为切在词中）。
    const wordChar = /[A-Za-z]/;
    if (page.start > 0) {
      assert.equal(
        wordChar.test(body[page.start - 1]) && wordChar.test(body[page.start]),
        false,
        `chunk 起点切在单词中间：${page.text.slice(0, 24)}`,
      );
    }
    if (end < body.length) {
      assert.equal(
        wordChar.test(body[end - 1]) && wordChar.test(body[end]),
        false,
        `chunk 终点切在单词中间：${page.text.slice(-24)}`,
      );
    }
  }
  assert.equal(covered, body.length, '所有块必须覆盖全文，不允许漏字');

  // 用返回的偏移回指原文，仍然拿得到要找的句子（重叠区可能有多块同时覆盖）。
  const at = body.indexOf(PHRASE);
  const holding = pages.filter(page => page.start <= at && at < page.start + page.text.length);
  assert.ok(holding.length >= 1, '至少一块覆盖目标句');
  assert.equal(body.slice(at, at + PHRASE.length), PHRASE);
  for (const page of holding) assert.ok(page.text.includes(PHRASE));
});

// ── 3. 引用：从半截 URL 开始的那次 live 输出 ─────────────────────────
test('pack: 引用从句子/行边界开始，超过 600 字截断，读不到正文时退回摘要', () => {
  const fragment = 'pm.org.hk/tc/join-and-support/membership)';
  const passage = '2025 年 3 月至 6 月，香港故宫文化博物馆将举办「天方奇毯」特展，'
    + '展出逾百件地毯珍品，展期三个月，门票于二月开售。详情请见官方网站。';
  const page = `${fragment}\n${passage}\n${'补充说明：会员可优先购票。'.repeat(40)}`;

  const rendered = formatEvidence([{
    url: 'https://www.hkpm.org.hk/tc/join-and-support/membership',
    title: '会员与支持',
    site: 'hkpm.org.hk',
    pages: [{ text: page, start: 0 }],
    chars: page.length,
  }], { queries: [ZH_QUERY], candidates: 1, deduped: 1, read: 1, passages: 1 });

  const quoteLine = rendered.split('\n').find(line => line.startsWith('    “'));
  assert.ok(quoteLine, rendered);
  const quote = quoteLine.trim().slice(1, -1);
  assert.ok(quote.startsWith('2025 年 3 月至 6 月'), `引用应当从行边界开始：${quote.slice(0, 40)}`);
  assert.equal(quote.includes('pm.org.hk'), false, '不得从半截 URL 开始');
  assert.ok(quote.length <= 600, `引用 ${quote.length} 字超过上限`);
  assert.equal(quote.includes('\n'), false, '引用内不得换行');

  // 整段没有句末边界时，也要丢掉开头那段半截链接。
  const oneLine = `${fragment} 香港故宫文化博物馆 2025 年特展将于 3 月开幕，展期三个月，门票于二月开售，欢迎提前预约参观。`;
  const noBoundary = formatEvidence([{
    url: 'https://www.hkpm.org.hk/tc/join-and-support/membership',
    title: '会员与支持',
    site: 'hkpm.org.hk',
    pages: [{ text: oneLine, start: 0 }],
    chars: oneLine.length,
  }], { queries: [ZH_QUERY], candidates: 1, deduped: 1, read: 1, passages: 1 });
  const fragmentQuote = noBoundary.split('\n').find(line => line.startsWith('    “')).trim().slice(1, -1);
  assert.equal(fragmentQuote.includes('pm.org.hk'), false, fragmentQuote);
  assert.ok(fragmentQuote.startsWith('香港故宫文化博物馆'), fragmentQuote.slice(0, 40));

  // 读不到正文时用摘要兜底，而不是给一个空引用。
  const failed = formatEvidence([{
    url: 'https://www.si.edu/events',
    title: 'Smithsonian Event',
    site: 'si.edu',
    snippet: '史密森尼学会活动页摘要，与查询无关。',
    pages: [],
    chars: 0,
    readError: '正文读取失败：422',
  }], { queries: [ZH_QUERY], candidates: 1, deduped: 1, read: 0, passages: 0 });
  assert.match(failed, /读取失败：正文读取失败：422/);
  assert.match(failed, /“史密森尼学会活动页摘要/);
});

// ── 4. 编号：可读证据在前，读失败的排最后 ────────────────────────────
test('ordering: 读失败的高分候选排到最后，[1] 一定有引用，meta 计数不虚高', async () => {
  const rows = [
    { url: 'https://a.example/one', title: '第一条', snippet: '第一条摘要。' },
    { url: 'https://b.example/two', title: '第二条', snippet: '第二条摘要。' },
    { url: 'https://c.example/three', title: '第三条', snippet: '第三条摘要。' },
  ];
  const provider = fakeProvider({
    rows: { '一个问题': rows },
    failUrls: ['https://a.example/one'],
    extractText: '正文第一段。正文第二段。',
  });
  const service = createSearchService({ providers: [provider], now: () => Date.now() });
  const result = await service.search({ queries: ['一个问题'], options: { readCount: 3 } });

  assert.equal(provider.calls.extract.length, 3, '三条候选都要尝试读取');
  assert.equal(result.rows[0].url, 'https://a.example/one', 'rows 顺序保持稳定（UI 来源列表）');
  assert.equal(result.rows.length, 3);

  assert.equal(result.evidence.length, 3);
  assert.equal(result.evidence[0].readError, undefined, 'evidence[0] 必须是读到的页面');
  assert.equal(result.evidence[0].url, 'https://b.example/two');
  assert.equal(result.evidence[1].url, 'https://c.example/three');
  assert.equal(result.evidence[2].url, 'https://a.example/one');
  assert.match(result.evidence[2].readError, /422/);

  assert.equal(result.meta.read, 2, '只有真正读到正文的算已读');
  assert.equal(
    result.meta.passages,
    result.evidence.reduce((sum, item) => sum + item.pages.length, 0),
  );
  assert.equal(result.meta.passages, 2);

  const text = formatEvidence(result.evidence, { ...result.meta, queries: ['一个问题'] });
  const blocks = text.split('\n\n');
  assert.match(blocks[0], /^\[1\] /);
  assert.ok(blocks[0].split('\n').some(line => line.startsWith('    “')), '[1] 必须带引用');
  assert.match(blocks[2], /^\[3\] /);
  assert.match(blocks[2], /（读取失败：/);
  assert.match(blocks[2], /“第一条摘要/, '读失败时用摘要兜底成引用');
});

// ── 5. 读取用产生该行的那条查询提问 ─────────────────────────────────
test('targeted: 每页读取都用该行自己的 query 选段，而不是第一条查询', async () => {
  const longText = '香港故宫文化博物馆的展览与门票信息。'.repeat(80);
  const provider = fakeProvider({
    rows: {
      'alpha 问题': [{ url: 'https://a.example/alpha', title: '甲' }],
      'beta question': [{ url: 'https://b.example/beta', title: '乙' }],
    },
    extractText: longText,
  });
  const questions = [];
  const embed = async (texts, options = {}) => {
    if (options.kind === 'query') questions.push(texts[0]);
    return texts.map(text => [String(text).length, 1, 0]);
  };
  const service = createSearchService({ providers: [provider], embed, now: () => Date.now() });
  const result = await service.search({
    queries: ['alpha 问题', 'beta question'],
    options: { readCount: 2 },
  });

  assert.equal(provider.calls.extract.length, 2);
  assert.deepEqual(result.evidence.map(item => item.url), ['https://a.example/alpha', 'https://b.example/beta']);
  assert.deepEqual(result.evidence.map(item => item.query), ['alpha 问题', 'beta question']);
  assert.deepEqual(questions, ['alpha 问题', 'beta question'], '选段用的问句必须是该行自己的 query');
  for (const item of result.evidence) {
    assert.ok(item.pages.length >= 1);
    assert.equal(item.readError, undefined);
  }
});
