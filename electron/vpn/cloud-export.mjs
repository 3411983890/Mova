/**
 * 负责：从桌面 VPN 配置仅导出订阅模型正在引用的节点和策略池。
 * 不负责：发出网络请求、同步其他桌面代理或公开节点凭据。
 * 被谁调用：electron/main.cjs 的认证云端同步操作。
 */

import { buildRuntimeConfig } from './runtime-config.mjs';

const providers = ['subscription:chatgpt', 'subscription:gemini'];

export async function exportCloudVpn(store) {
  if (!store) throw new Error('桌面的网络与线路尚未就绪');
  const [settings, vault] = await Promise.all([store.readRoutes(), store.readVault()]);
  const routes = Object.fromEntries(Object.entries(settings.routes).filter(([key]) => providers.includes(key)));
  const modelOverrides = Object.fromEntries(Object.entries(settings.modelOverrides).filter(([key]) => providers.some(provider => key.startsWith(`${provider}/`))));
  const poolsNeeded = new Set([...Object.values(routes), ...Object.values(modelOverrides)].map(item => item.poolId).filter(Boolean));
  const pools = settings.pools.filter(pool => poolsNeeded.has(pool.id));
  const config = buildRuntimeConfig({ core: { basePort: 18400 }, pools, nodes: vault.nodes, routes, modelOverrides });
  if (!config.listeners.length) throw new Error('请在「网络与线路」为订阅模型分配可用代理');
  return { routes, modelOverrides, ports: config.ports, config: { proxies: config.proxies, 'proxy-groups': config.groups, listeners: config.listeners } };
}
