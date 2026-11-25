'use strict';

const { createAnySearchProvider } = require('./providers/anysearch.cjs');
const { createTavilyProvider } = require('./providers/tavily.cjs');
const { createSearxngProvider } = require('./providers/searxng.cjs');

// 固定优先级；config.order 只能重排已知 id，未知 id 一律忽略。
const ORDER = ['anysearch', 'tavily', 'searxng'];

async function readKey(credentials, providerId) {
  try {
    const key = await credentials?.key?.(providerId);
    return typeof key === 'string' && key.trim() ? key.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 按配置与凭据实例化 provider。
 * 注意：credentials.key 是异步的，所以本函数是 async，返回 Promise<Provider[]>；
 * createSearchService 同时接受数组、Promise 与工厂函数，两种接法都可以。
 */
async function createProviders({ credentials, config, fetch: fetchImpl = fetch } = {}) {
  // anysearch 默认启用（有 key 即可用），tavily / searxng 必须显式 enabled。
  const settings = (id, defaultEnabled) => ({
    enabled: defaultEnabled,
    ...(config?.providers?.[id] || {}),
  });
  const built = {};

  // anysearch：默认启用，有 key 才实例化。
  if (settings('anysearch', true).enabled !== false) {
    const key = await readKey(credentials, 'anysearch');
    if (key) built.anysearch = createAnySearchProvider({ key, fetch: fetchImpl });
  }

  // tavily：显式 enabled 且有 key。
  if (settings('tavily', false).enabled === true) {
    const key = await readKey(credentials, 'tavily');
    if (key) built.tavily = createTavilyProvider({ key, fetch: fetchImpl });
  }

  // searxng：显式 enabled 且有 baseUrl；地址非法则跳过而不是让整个搜索失败。
  if (settings('searxng', false).enabled === true) {
    const baseUrl = String(settings('searxng', false).baseUrl || '').trim();
    if (baseUrl) {
      try {
        built.searxng = createSearxngProvider({ baseUrl, fetch: fetchImpl, allowLoopback: config?.allowLoopbackSearxng === true });
      } catch {
        // 非法地址：静默跳过，配置校验由 Wave B 的 IPC 负责提示。
      }
    }
  }

  const requested = Array.isArray(config?.order) ? config.order.filter(id => ORDER.includes(id)) : [];
  const order = [...new Set([...requested, ...ORDER])];
  return order.map(id => built[id]).filter(Boolean);
}

module.exports = { createProviders, ORDER };
