'use strict';

const { sourceUrl } = require('../url.cjs');
const { SearchProviderError, withTimeout, abortError, publishedDate } = require('./errors.cjs');

const ENDPOINT = 'https://api.anysearch.com/v1/search';
const EXTRACT_ENDPOINT = 'https://api.anysearch.com/v1/extract';
const CAPABILITIES_ENDPOINT = 'https://api.anysearch.com/v1/sub-domains';

const MAX_RESULTS = 10;
const EXTRACT_TIMEOUT_MS = 35_000;

function clampResults(value) {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count)) return MAX_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, count));
}

async function fail(response, provider, signal) {
  // 402 的响应体可能包含账号/密钥：只保留状态码，绝不读取、绝不记录 body。
  // cancel() 只是丢弃流，不解析内容；错误消息一律来自 describeStatus(status)。
  void response.body?.cancel().catch(() => {});
  throw new SearchProviderError(provider, response.status);
}

function requestSignal(signal, ms) {
  return withTimeout(signal, ms);
}

/**
 * AnySearch 适配器：search / extract / capabilities。
 * 所有出站 URL 都先过 sourceUrl()，响应体一律当不可信数据处理。
 */
function createAnySearchProvider({ key, fetch: fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const authorization = `Bearer ${key}`;
  const headers = { Authorization: authorization, 'Content-Type': 'application/json' };

  async function search(query, opts = {}, signal) {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) throw new SearchProviderError('anysearch', 422, 'AnySearch 查询不能为空');
    const {
      maxResults = MAX_RESULTS,
      zone,
      language,
      tag,
      params,
      markdown = true,
    } = opts || {};

    const body = { query: text, max_results: clampResults(maxResults) };
    if (zone) body.zone = String(zone);
    if (language) body.language = String(language);
    if (tag) body.tag = String(tag);
    if (params && typeof params === 'object' && !Array.isArray(params)) body.params = params;
    if (markdown) body.format = 'markdown';

    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: requestSignal(signal, timeoutMs),
      });
    } catch (error) {
      if (abortError(error)) throw new SearchProviderError('anysearch', 0, 'AnySearch 请求超时');
      throw new SearchProviderError('anysearch', 0, 'AnySearch 请求失败');
    }
    if (!response.ok) return fail(response, 'anysearch');

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SearchProviderError('anysearch', 0, 'AnySearch 返回了无效结果');
    }
    if (payload?.code !== 0) {
      // status 0：HTTP 成功但业务码失败，错误消息里不带响应体。
      throw new SearchProviderError('anysearch', 0, `AnySearch 返回了错误（code=${String(payload?.code)}）`);
    }

    const raw = Array.isArray(payload?.data?.results) ? payload.data.results : [];
    const seen = new Set();
    const rows = [];
    for (const result of raw) {
      const link = sourceUrl(result?.url);
      if (!link || seen.has(link.href)) continue;
      seen.add(link.href);
      rows.push({
        url: link.href,
        title: String(result?.title || link.hostname).slice(0, 240),
        snippet: String(result?.snippet || '').slice(0, 1400),
        content: typeof result?.content === 'string' ? result.content : '',
        published: publishedDate(result?.published ?? result?.published_date),
        provider: 'anysearch',
        query: text,
        rank: rows.length + 1,
      });
      if (rows.length >= clampResults(maxResults)) break;
    }
    return rows;
  }

  async function extract(url, signal) {
    const link = sourceUrl(url);
    if (!link) throw new SearchProviderError('anysearch', 400, '链接不合法，已跳过');

    let response;
    try {
      response = await fetchImpl(EXTRACT_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: link.href }),
        redirect: 'error',
        signal: requestSignal(signal, EXTRACT_TIMEOUT_MS),
      });
    } catch (error) {
      if (abortError(error)) throw new SearchProviderError('anysearch', 0, 'AnySearch 正文读取超时');
      throw new SearchProviderError('anysearch', 0, 'AnySearch 正文读取失败');
    }
    if (!response.ok) return fail(response, 'anysearch');

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SearchProviderError('anysearch', 422, 'AnySearch 无法提取该页面正文');
    }
    const data = payload?.data ?? {};
    const content = typeof data.content === 'string'
      ? data.content
      : (typeof data.markdown === 'string' ? data.markdown : null);
    if (payload?.code !== 0 || content === null) {
      throw new SearchProviderError('anysearch', 422, 'AnySearch 无法提取该页面正文');
    }
    return {
      url: link.href,
      title: String(data.title || link.hostname).slice(0, 240),
      text: content,
    };
  }

  async function capabilities(domains, signal) {
    const list = (Array.isArray(domains) ? domains : [domains])
      .filter(domain => typeof domain === 'string' && domain.trim())
      .slice(0, 20);
    if (!list.length) return [];

    const endpoint = new URL(CAPABILITIES_ENDPOINT);
    for (const domain of list) endpoint.searchParams.append('domain', domain.trim());

    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'GET',
        headers: { Authorization: authorization },
        redirect: 'error',
        signal: requestSignal(signal, timeoutMs),
      });
    } catch (error) {
      if (abortError(error)) throw new SearchProviderError('anysearch', 0, 'AnySearch 能力查询超时');
      throw new SearchProviderError('anysearch', 0, 'AnySearch 能力查询失败');
    }
    if (!response.ok) return fail(response, 'anysearch');

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SearchProviderError('anysearch', 0, 'AnySearch 返回了无效结果');
    }
    if (payload?.code !== 0 && payload?.code !== undefined) {
      throw new SearchProviderError('anysearch', 0, `AnySearch 返回了错误（code=${String(payload.code)}）`);
    }
    const data = payload?.data;
    const raw = Array.isArray(data) ? data : (Array.isArray(data?.domains) ? data.domains : []);
    return raw
      .map(entry => (typeof entry === 'string' ? entry : entry?.domain))
      .filter(entry => typeof entry === 'string' && entry.trim());
  }

  return {
    id: 'anysearch',
    label: 'AnySearch',
    hasExtract: true,
    search,
    extract,
    capabilities,
  };
}

module.exports = { createAnySearchProvider, ENDPOINT, EXTRACT_ENDPOINT, CAPABILITIES_ENDPOINT, clampResults };
