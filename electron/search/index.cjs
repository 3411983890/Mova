'use strict';

const { createCache } = require('./cache.cjs');
const { createBudget } = require('./budget.cjs');
const { fuse } = require('./fuse.cjs');
const { rerank } = require('./score.cjs');
const { sourceUrl } = require('./url.cjs');
const passage = require('./passage.cjs');

const DEFAULT_LIMITS = {
  maxQueries: 5,
  maxResults: 10,
  readCount: 3,
  perHost: 2,
  recency: 'any',
  timeoutMs: 12_000,
  maxQueryChars: 400,
  k: 60,
};

const MAX_QUERIES = 5;
const MAX_READS = 8;
// 证据块最多这么多条：再多会挤占上下文，也超出「读得到、引得着」的实际收益。
const MAX_EVIDENCE = 10;

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 去空、去重、trim、每条 ≤400 字、最多 5 条。 */
function normalizeQueries(input, { maxQueries = MAX_QUERIES, maxQueryChars = 400 } = {}) {
  const raw = Array.isArray(input) ? input : (typeof input === 'string' ? [input] : []);
  const limit = clampInt(maxQueries, 1, MAX_QUERIES, MAX_QUERIES);
  const width = clampInt(maxQueryChars, 1, 400, 400);
  const seen = new Set();
  const list = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const text = value.trim().slice(0, width);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
    if (list.length >= limit) break;
  }
  return list;
}

/** 传给 provider.search 的选项，键顺序固定，保证缓存 key 稳定。 */
function providerOptions(settings) {
  const options = { maxResults: clampInt(settings.maxResults, 1, 10, 10) };
  if (settings.zone) options.zone = String(settings.zone);
  if (settings.language) options.language = String(settings.language);
  if (settings.tag) options.tag = String(settings.tag);
  if (settings.params && typeof settings.params === 'object') options.params = settings.params;
  if (settings.markdown === false) options.markdown = false;
  return options;
}

function messageOf(error) {
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : '读取失败';
  return message.slice(0, 200);
}

function usable(providers) {
  return (Array.isArray(providers) ? providers : [])
    .filter(provider => provider && typeof provider.id === 'string' && typeof provider.search === 'function');
}

/**
 * 检索服务：并发多查询 × 多源 → RRF 融合 → 重排 → 按需读正文。
 * 依赖（providers / cache / now / embed）全部可注入，测试可完全离线。
 *
 * providers 接受数组、Promise<数组> 或 () => 数组|Promise<数组>；
 * 因为 createProviders 是 async（凭据读取是异步的），后两种写法让调用方不必先 await。
 * embed 可选：传了走向量选段（失败自动落回关键词版），不传时行为与之前完全一致。
 */
function createSearchService({ providers, cache, limits, now = Date.now, embed = null } = {}) {
  const store = cache && typeof cache.get === 'function' && typeof cache.set === 'function'
    ? cache
    : createCache();
  const providerSource = typeof providers === 'function' ? providers : () => providers;
  // 可选的向量选段（Wave E）：注入的 embed 只影响选段质量，任何失败都静默落回关键词版。
  const embedder = typeof embed === 'function' ? embed : null;

  let resolved = Array.isArray(providers) ? usable(providers) : null;
  const resolveProviders = async () => {
    if (resolved) return resolved;
    resolved = usable(await providerSource());
    return resolved;
  };
  const activeProviders = () => resolved || [];

  /** passage.select 在有 embed 时返回 Promise、没有时同步返回数组；两种都收口成数组。 */
  async function selectPages(text, question) {
    const options = embedder ? { embed: embedder } : {};
    try {
      const selected = await passage.select(text, question, options);
      if (Array.isArray(selected)) return selected;
    } catch {
      // select 内部已兜底；这里再兜一层，正文选段不允许因向量不可用而失败。
    }
    return passage.selectByKeywords(text, question);
  }

  function signalFor(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(clampInt(timeoutMs, 1, 120_000, DEFAULT_LIMITS.timeoutMs));
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  async function collectBatches(list, active, settings, signal) {
    const tasks = [];
    for (const query of list) {
      for (const provider of active) {
        const callOptions = providerOptions(settings);
        const key = `s:${provider.id}:${query}:${JSON.stringify(callOptions)}`;
        tasks.push((async () => {
          const cached = store.get(key);
          if (cached !== undefined) return cached;
          const rows = await provider.search(query, callOptions, signalFor(signal, settings.timeoutMs));
          const normalized = (Array.isArray(rows) ? rows : [])
            .filter(row => row && typeof row.url === 'string')
            .map((row, index) => ({
              ...row,
              provider: row.provider || provider.id,
              query: row.query || query,
              rank: Number.isFinite(row.rank) && row.rank > 0 ? row.rank : index + 1,
            }));
          store.set(key, normalized);
          return normalized;
        })());
      }
    }
    // 单次失败只记录，不抛：其它源的结果照常可用。失败要计数回报，
    // 否则「源全部不可达」会被上层说成「网上没有资料」。
    const settled = await Promise.allSettled(tasks);
    const batches = [];
    const failedSources = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') { batches.push(outcome.value); continue; }
      const id = outcome.reason?.provider || outcome.reason?.providerId || '';
      if (id && !failedSources.includes(id)) failedSources.push(String(id));
    }
    return { batches, failures: settled.length - batches.length, failedSources };
  }

  async function readDetail({ url, question, signal, budget: ledger } = {}) {
    const link = sourceUrl(url);
    if (!link) throw Object.assign(new Error('链接不合法或不受支持'), { code: 'invalid-url' });
    const active = await resolveProviders();
    const extractor = active.find(provider => typeof provider.extract === 'function');
    if (!extractor) throw Object.assign(new Error('当前没有可读取正文的搜索源'), { code: 'no-extractor' });

    const key = `r:${extractor.id}:${link.href}`;
    let page = store.get(key);
    if (page === undefined) {
      page = await extractor.extract(link.href, signal);
      if (page && typeof page === 'object') store.set(key, page);
    }
    const text = typeof page?.text === 'string' ? page.text : '';
    const pages = await selectPages(text, question);
    const selectedChars = pages.reduce((sum, item) => sum + item.text.length, 0);
    // 正文字数记账：额度不足时不扣减也不报错，仍返回已选段落，由调用方决定是否继续。
    ledger?.spend?.('chars', selectedChars);

    return {
      url: link.href,
      title: String(page?.title || link.hostname).slice(0, 240),
      snippet: '',
      content: '',
      published: null,
      provider: extractor.id,
      query: typeof question === 'string' ? question : '',
      rank: 0,
      site: hostOf(link.href),
      pages,
      chars: text.length,
    };
  }

  async function read({ url, question, signal, budget } = {}) {
    return readDetail({ url, question, signal, budget });
  }

  async function search({ queries, options = {}, signal, budget, emit: _emit } = {}) {
    // 事件由调用方（chat-agent）发：这里只在有增量时可选 emit search-progress，Wave A 未实现。
    const settings = { ...DEFAULT_LIMITS, ...(limits || {}), ...(options || {}) };
    const list = normalizeQueries(queries, settings);
    const ledger = budget || createBudget(limits || {});
    const meta = { candidates: 0, deduped: 0, read: 0, passages: 0, budgetExhausted: false, failed: 0, failedSources: [] };
    const empty = { rows: [], evidence: [], meta };

    if (!list.length) return empty;
    const active = await resolveProviders();
    if (!active.length) return empty;

    const collected = await collectBatches(list, active, settings, signal);
    const batches = collected.batches;
    meta.failed = collected.failures;
    meta.failedSources = collected.failedSources;
    meta.candidates = batches.reduce((sum, batch) => sum + batch.length, 0);

    const fused = fuse(batches, { k: settings.k });
    meta.deduped = fused.length;
    const rows = rerank(fused, { recency: settings.recency, now, perHost: settings.perHost });

    const readCount = clampInt(settings.readCount, 0, MAX_READS, 3);
    // 证据集是「模型看得到的候选」，不是「读成功的候选」：读 0 页的快速档也必须
    // 把候选连同摘要交出去，否则会把「有关键词命中」说成「没有任何来源」。
    const evidenceCount = clampInt(settings.maxResults, 1, MAX_EVIDENCE, 10);
    const picked = rows.slice(0, Math.max(evidenceCount, Math.min(readCount, rows.length)));
    const details = new Map();
    let readOk = 0;
    for (const row of picked.slice(0, readCount)) {
      if (ledger.exhausted()) break;
      if (!ledger.spend('reads')) break;
      // 用产生这条候选的查询去选段：拿别的查询提问会选到无关段落。
      const question = typeof row.query === 'string' && row.query.trim() ? row.query : (list[0] || '');
      try {
        const detail = await readDetail({ url: row.url, question, signal, budget: ledger });
        details.set(row.url, { title: row.title || detail.title, site: detail.site, pages: detail.pages, chars: detail.chars });
        readOk += 1;
      } catch (error) {
        // 读不到正文的候选仍然保留，只记录原因；摘要由 pack 兜底成引用。
        details.set(row.url, { site: hostOf(row.url), pages: [], chars: 0, readError: messageOf(error) });
      }
    }
    const evidence = picked.map(row => ({ ...row, ...(details.get(row.url) || { site: hostOf(row.url), pages: [], chars: 0 }) }));

    // 编号就是位置：可读的排前面，读失败的排最后，[1] 才总是指向有引用的页面。
    // 组内保持原来的 score 顺序（filter 稳定），rows 本身不动，UI 的来源列表顺序不受影响。
    const ordered = evidence.filter(item => !item.readError).concat(evidence.filter(item => item.readError));

    meta.read = readOk;
    meta.passages = ordered.reduce((sum, item) => sum + item.pages.length, 0);
    meta.budgetExhausted = ledger.exhausted();
    return { rows, evidence: ordered, meta };
  }

  async function capabilities(domains, signal) {
    const active = await resolveProviders();
    const provider = active.find(item => typeof item.capabilities === 'function');
    if (!provider) return [];
    const list = await provider.capabilities(domains, signal);
    return Array.isArray(list) ? list : [];
  }

  // Wave B 用这个判断是否下发 web_read。
  const hasExtract = () => activeProviders().some(provider => typeof provider.extract === 'function');

  return { activeProviders, search, read, capabilities, hasExtract, normalizeQueries };
}

module.exports = { createSearchService, normalizeQueries, DEFAULT_LIMITS };
