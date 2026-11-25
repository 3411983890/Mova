/**
 * 按模型（Provider / 单模型）解析出站线路，并把结果翻译成三种引擎能用的形状。
 *
 * 负责：
 * 1. 优先级解析：`modelOverrides["providerId/modelId"]` > `routes[providerId]` > 直连；
 * 2. 把解析结果映射到该线路的 loopback 端口，给出 `http://127.0.0.1:<port>`；
 * 3. 生成 ACP 子进程的环境变量（`HTTP_PROXY` 等 + 回环 `NO_PROXY`）；
 * 4. 按 proxyUrl 缓存 `undici.ProxyAgent`（同一端口复用同一个 Agent）。
 * 不负责：起内核、分配端口（`runtime-config.mjs`）、发起请求（`runtime.mjs` / `chat-agent`）。
 * 被谁调用：`runtime.mjs`、`model-ipc.cjs`（经 runtime）、`tests/vpn-routing.test.mjs`。
 *
 * 本文件**必须**保持纯：不 import electron、不 import undici（Agent 由调用方注入工厂），
 * 否则 `node --test` 里会连带拖进主进程依赖。
 */
import {
  DIRECT_ROUTE,
  LOOPBACK_NO_PROXY,
  modelOverrideKey,
  normalizeRouteTarget,
  routeTargetKey,
} from './contract.mjs';

/**
 * 只接受回环地址的 http 代理。
 * 这是安全边界而不是格式校验：路由表是渲染层可写的，若允许任意 host，
 * 一次「分配到 node」的操作就能把模型流量导去第三方机器。
 */
const LOOPBACK_PROXY_RE = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/;

/** 判断一个代理 URL 是否是本机 loopback（IPC 参数与 store 里的旧值都要过这一关）。 */
export function isLoopbackProxyUrl(value) {
  return typeof value === 'string' && LOOPBACK_PROXY_RE.test(value);
}

/** `127.0.0.1:<port>` → 代理 URL；端口不合法返回空串（宁可直连也不猜）。 */
export function proxyUrlForPort(port) {
  const n = Math.floor(Number(port));
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return '';
  return `http://127.0.0.1:${n}`;
}

/**
 * 优先级解析（不改输入，返回新对象）。
 *
 * @param {{ routes?: object, modelOverrides?: object }} config
 * @param {string} providerId
 * @param {string} [modelId]
 * @returns {{ target: { mode: string, failover: boolean, poolId?: string, nodeId?: string }, source: 'override'|'provider'|'direct' }}
 */
export function resolveRouteTarget(config, providerId, modelId) {
  const provider = typeof providerId === 'string' ? providerId.trim() : '';
  const overrides = config?.modelOverrides && typeof config.modelOverrides === 'object' ? config.modelOverrides : {};
  const routes = config?.routes && typeof config.routes === 'object' ? config.routes : {};
  const overrideKey = modelOverrideKey(providerId, modelId);
  if (overrideKey && Object.prototype.hasOwnProperty.call(overrides, overrideKey)) {
    return { target: normalizeRouteTarget(overrides[overrideKey]), source: 'override' };
  }
  if (provider && Object.prototype.hasOwnProperty.call(routes, provider)) {
    return { target: normalizeRouteTarget(routes[provider]), source: 'provider' };
  }
  return { target: { ...DIRECT_ROUTE }, source: 'direct' };
}

/**
 * 把解析结果落到端口上。
 *
 * @param {{ routes?: object, modelOverrides?: object, ports?: Record<string, number> }} config
 *   `ports` 来自 `buildRuntimeConfig(...).ports`（`pool:<id>` / `node:<id>` → 端口）。
 * @returns {{
 *   providerId: string, modelId: string, mode: string, source: string,
 *   targetKey: string, poolId: string, nodeId: string, port: number,
 *   proxyUrl: string, degraded: boolean, reason: string
 * }}
 *   `proxyUrl` 为空 = 直连；`degraded` 为真 = 用户分配了线路但当前拿不到端口
 *   （内核没起 / 端口耗尽），这时**不注入代理**并把原因回报给 UI。
 */
export function resolveModelRoute(config, providerId, modelId) {
  const { target, source } = resolveRouteTarget(config, providerId, modelId);
  const provider = typeof providerId === 'string' ? providerId.trim() : '';
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  const base = {
    providerId: provider,
    modelId: model,
    mode: target.mode,
    source,
    targetKey: '',
    poolId: target.poolId ?? '',
    nodeId: target.nodeId ?? '',
    port: 0,
    proxyUrl: '',
    degraded: false,
    reason: '',
  };
  if (target.mode === 'direct') return base;
  const key = routeTargetKey(target);
  if (!key) return { ...base, mode: 'direct', degraded: true, reason: 'route_incomplete' };
  const port = Math.floor(Number(config?.ports?.[key]));
  if (!Number.isInteger(port) || port <= 0) {
    return { ...base, targetKey: key, degraded: true, reason: 'port_unassigned' };
  }
  return { ...base, targetKey: key, port, proxyUrl: proxyUrlForPort(port) };
}

/**
 * ACP / CLI 子进程的代理环境变量。
 *
 * 大写与小写都写：`agy` 这类 Node 客户端读 `HTTPS_PROXY`，而 curl/minimal 客户端
 * 只认小写；少写一套就会出现「有的模型走代理、有的模型直连」。
 *
 * @param {string} proxyUrl 必须是回环代理（见 `LOOPBACK_PROXY_RE`）
 * @param {Record<string, string|undefined>} [baseEnv] 子进程原本的环境（默认 `process.env`）
 * @returns {Record<string, string|undefined>|null} 不合法的 url 返回 null = 不注入
 */
export function buildProxyEnv(proxyUrl, baseEnv = process.env) {
  if (!isLoopbackProxyUrl(proxyUrl)) return null;
  const env = { ...baseEnv };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) env[key] = proxyUrl;
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy']) env[key] = proxyUrl;
  for (const key of ['NO_PROXY', 'no_proxy']) env[key] = LOOPBACK_NO_PROXY;
  return env;
}

/**
 * 一步到位：模型 → 子进程环境变量。
 * 未分配线路（或分配了但内核没起）返回 `null`，调用方据此**什么都不加**。
 */
export function envForModel(config, providerId, modelId, baseEnv = process.env) {
  const route = resolveModelRoute(config, providerId, modelId);
  if (!route.proxyUrl) return null;
  return buildProxyEnv(route.proxyUrl, baseEnv);
}

/**
 * `undici.ProxyAgent` 的按 URL 缓存。
 *
 * 为什么必须缓存：每轮对话新建 Agent 会遗留一堆 keep-alive socket，
 * 长时间聊天后表现为句柄泄漏 + 代理端连接数打满。
 *
 * @param {{ createAgent: (url: string) => any, max?: number }} options
 * @returns {{ get: (url: string) => any, size: () => number, dispose: () => void }}
 */
export function createDispatcherCache({ createAgent, max = 8 } = {}) {
  const cache = new Map();
  return {
    get(url) {
      if (typeof url !== 'string' || !isLoopbackProxyUrl(url)) return null;
      if (cache.has(url)) return cache.get(url);
      if (cache.size >= max) {
        // 最简单的容量控制：先进先出。真实场景里同时活跃的线路是个位数。
        const [oldestKey, oldest] = cache.entries().next().value ?? [];
        if (oldestKey) cache.delete(oldestKey);
        oldest?.close?.();
      }
      const agent = createAgent(url);
      cache.set(url, agent);
      return agent;
    },
    size: () => cache.size,
    dispose() {
      for (const agent of cache.values()) {
        try { agent?.close?.(); } catch { /* 关闭失败不影响退出 */ }
      }
      cache.clear();
    },
  };
}
