'use strict';

const LABELS = { anysearch: 'AnySearch', tavily: 'Tavily', searxng: 'SearXNG' };

/**
 * 所有 provider 适配器只抛这一种错误，Wave B 据此给用户中文可读原因。
 * status 是 HTTP 状态码；status === 0 表示「HTTP 成功但业务失败 / 网络或超时」。
 * 绝不要把响应体拼进 message：AnySearch 的 402 响应体可能包含账号与密钥。
 */
class SearchProviderError extends Error {
  constructor(provider, status, message) {
    super(message || describeStatus(provider, status));
    this.name = 'SearchProviderError';
    this.provider = String(provider || '');
    this.status = Number(status) || 0;
  }
}

function describeStatus(provider, status) {
  const label = LABELS[provider] || (provider ? String(provider) : '搜索服务');
  if (status === 401 || status === 403) return `${label} 密钥无效或无权限`;
  if (status === 402) return `${label} 配额不足`;
  if (status === 422) return `${label} 无法处理该请求`;
  if (status === 429) return `${label} 请求过于频繁`;
  if (status >= 500) return `${label} 服务暂时不可用`;
  if (!status) return `${label} 返回了无效结果`;
  return `${label} 搜索失败（HTTP ${status}）`;
}

/** AbortSignal.any([signal, timeout])：与现有 anysearch.cjs 的超时写法一致。 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(ms) || 1));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortError(error) {
  const name = error?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function publishedDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const at = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isFinite(at) ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

module.exports = { SearchProviderError, describeStatus, withTimeout, abortError, publishedDate };
