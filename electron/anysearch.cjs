// sourceUrl 搬到了 electron/search/url.cjs（Wave A），这里只做再导出：
// main.cjs / model-ipc.cjs / tests/pi-chat.test.mjs 的旧导入路径与行为保持不变。
const { sourceUrl } = require('./search/url.cjs');

const ENDPOINT = 'https://api.anysearch.com/v1/search';

class SearchError extends Error {}

async function searchWeb(key, query, signal, fetchSearch = fetch) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new SearchError('请输入 1–500 字的搜索词');
  const response = await fetchSearch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query.trim(), max_results: 5 }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) {
    // 只保留状态码：402 的响应体可能包含账号/密钥，cancel() 丢弃流但绝不解析内容。
    void response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status)) throw new SearchError('AnySearch 密钥无效或无权限');
    if (response.status === 402) throw new SearchError('AnySearch 配额不足');
    if (response.status === 429) throw new SearchError('AnySearch 请求过于频繁');
    throw new SearchError(`AnySearch 搜索失败（HTTP ${response.status}）`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.data?.results) || payload.code !== 0) throw new SearchError('AnySearch 返回了无效结果');
  const seen = new Set();
  return payload.data.results.flatMap(result => {
    const link = sourceUrl(result?.url);
    if (!link || seen.has(link.href)) return [];
    seen.add(link.href);
    return [{
      url: link.href,
      title: String(result.title || link.hostname).slice(0, 240),
      snippet: String(result.snippet || result.content || '').slice(0, 1400),
    }];
  }).slice(0, 5);
}

module.exports = { sourceUrl, searchWeb, SearchError };
