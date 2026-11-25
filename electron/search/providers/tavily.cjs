'use strict';

const { sourceUrl } = require('../url.cjs');
const { SearchProviderError, withTimeout, abortError, publishedDate } = require('./errors.cjs');

const ENDPOINT = 'https://api.tavily.com/search';
const MAX_RESULTS = 20;

function clampResults(value) {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count)) return 10;
  return Math.min(MAX_RESULTS, Math.max(1, count));
}

/**
 * Tavily 第二源（P1，默认关闭）。只有 enabled 且有 key 时 createProviders 才实例化。
 * 无 extract 能力。
 */
function createTavilyProvider({ key, fetch: fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  async function search(query, opts = {}, signal) {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) throw new SearchProviderError('tavily', 422, 'Tavily 查询不能为空');
    const maxResults = clampResults(opts?.maxResults);

    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, max_results: maxResults, search_depth: 'advanced' }),
        redirect: 'error',
        signal: withTimeout(signal, timeoutMs),
      });
    } catch (error) {
      if (abortError(error)) throw new SearchProviderError('tavily', 0, 'Tavily 请求超时');
      throw new SearchProviderError('tavily', 0, 'Tavily 请求失败');
    }
    if (!response.ok) {
      // 错误响应体一律不读：里面可能回显 key。
      void response.body?.cancel().catch(() => {});
      throw new SearchProviderError('tavily', response.status);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SearchProviderError('tavily', 0, 'Tavily 返回了无效结果');
    }
    const raw = Array.isArray(payload?.results) ? payload.results : [];
    const seen = new Set();
    const rows = [];
    for (const result of raw) {
      const link = sourceUrl(result?.url);
      if (!link || seen.has(link.href)) continue;
      seen.add(link.href);
      rows.push({
        url: link.href,
        title: String(result?.title || link.hostname).slice(0, 240),
        snippet: String(result?.content || '').slice(0, 1400),
        content: typeof result?.content === 'string' ? result.content : '',
        published: publishedDate(result?.published_date ?? result?.published),
        provider: 'tavily',
        query: text,
        rank: rows.length + 1,
      });
      if (rows.length >= maxResults) break;
    }
    return rows;
  }

  return {
    id: 'tavily',
    label: 'Tavily',
    hasExtract: false,
    search,
  };
}

module.exports = { createTavilyProvider, ENDPOINT };
