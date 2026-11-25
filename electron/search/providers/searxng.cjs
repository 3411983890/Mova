'use strict';

const { sourceUrl } = require('../url.cjs');
const { SearchProviderError, withTimeout, abortError, publishedDate } = require('./errors.cjs');

function clampResults(value) {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count)) return 10;
  return Math.min(20, Math.max(1, count));
}

/**
 * SearXNG 免 key 兜底（P1，默认关闭）。baseUrl 由配置提供，未配置时
 * createProviders 不实例化；这里仍校验一次，避免把内网地址当搜索源。
 */
function createSearxngProvider({ baseUrl, fetch: fetchImpl = fetch, timeoutMs = 15_000, allowLoopback } = {}) {
  const address = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  let base = sourceUrl(address);
  if (!base && allowLoopback && /^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(address)) base = new URL(address);
  if (!base) throw new Error('SearXNG 地址不合法');
  const root = base.href.replace(/\/+$/, '');

  async function search(query, opts = {}, signal) {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) throw new SearchProviderError('searxng', 422, 'SearXNG 查询不能为空');

    const endpoint = new URL(`${root}/search`);
    endpoint.searchParams.set('q', text);
    endpoint.searchParams.set('format', 'json');
    if (opts?.language) endpoint.searchParams.set('language', String(opts.language));

    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: withTimeout(signal, timeoutMs),
      });
    } catch (error) {
      if (abortError(error)) throw new SearchProviderError('searxng', 0, 'SearXNG 请求超时');
      throw new SearchProviderError('searxng', 0, 'SearXNG 请求失败');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new SearchProviderError('searxng', response.status);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SearchProviderError('searxng', 0, 'SearXNG 返回了无效结果');
    }
    const raw = Array.isArray(payload?.results) ? payload.results : [];
    const maxResults = clampResults(opts?.maxResults);
    const seen = new Set();
    const rows = [];
    for (const result of raw) {
      const link = sourceUrl(result?.url);
      if (!link || seen.has(link.href)) continue;
      seen.add(link.href);
      const content = typeof result?.content === 'string' ? result.content : '';
      rows.push({
        url: link.href,
        title: String(result?.title || link.hostname).slice(0, 240),
        snippet: content.slice(0, 1400),
        content,
        published: publishedDate(result?.publishedDate ?? result?.published_date),
        provider: 'searxng',
        query: text,
        rank: rows.length + 1,
      });
      if (rows.length >= maxResults) break;
    }
    return rows;
  }

  return {
    id: 'searxng',
    label: 'SearXNG',
    hasExtract: false,
    search,
  };
}

module.exports = { createSearxngProvider };
