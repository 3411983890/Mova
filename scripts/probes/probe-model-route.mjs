/**
 * 负责：用真实的路由配置算一遍「订阅 Gemini / ChatGPT 到底被分配到哪个本地端口」，
 *   并把该模型应注入的代理环境变量打印出来。纯模块计算，不启动内核、不改任何配置。
 * 不负责：健康检查与节点切换（electron/vpn/health.mjs）、内核进程。
 * 被谁调用：排查「模型没走 VPN / 国内直连超时」时手工跑。
 *
 * 背景：`envForModel()` 是**同步**读缓存的热路径。缓存没热起来（refresh 没跑完或抛错）时
 * `ports` 为空 → 返回 null → chat-agent 不注入代理 → 子进程直连。表现就是
 * 「模型没走 VPN、国内访问不了」，而且日志里什么都不说。
 *
 * 用法：node scripts/probes/probe-model-route.mjs [providerId] [modelId]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRuntimeConfig, collectRouteTargets } from '../../electron/vpn/runtime-config.mjs';
import { resolveModelRoute, envForModel } from '../../electron/vpn/router.mjs';

const routesPath = join(process.env.APPDATA || '', 'Mova', 'model-vpn-routes.json');
const raw = JSON.parse(await readFile(routesPath, 'utf8'));
const core = raw.core ?? {};
const pools = raw.pools ?? [];
const routes = raw.routes ?? {};
const modelOverrides = raw.modelOverrides ?? {};

const targets = collectRouteTargets({ pools, routes, modelOverrides });
console.log(`# 配置：${routesPath}`);
console.log(`# 路由目标 ${targets.length} 个：${targets.map(t => t.key || JSON.stringify(t)).join(', ')}`);

// occupiedPorts 传空：只验证「按顺序分配」这一层。真实运行时被占用会整体后移。
const config = buildRuntimeConfig({ core, pools, routes, modelOverrides, nodes: [], occupiedPorts: [] });
console.log(`# 分配到的端口：${JSON.stringify(config.ports)}`);
if (config.unassigned?.length) console.log(`# 未分配：${JSON.stringify(config.unassigned)}`);

const probe = (providerId, modelId) => {
  const route = resolveModelRoute({ routes, modelOverrides, ports: config.ports }, providerId, modelId);
  const env = envForModel({ routes, modelOverrides, ports: config.ports }, providerId, modelId, {});
  console.log(`\n# ${providerId} / ${modelId || '(空)'}`);
  console.log(`  mode=${route.mode} targetKey=${route.targetKey || '-'} port=${route.port || '-'} degraded=${route.degraded}${route.reason ? ` reason=${route.reason}` : ''}`);
  console.log(`  proxyUrl=${route.proxyUrl || '（不注入，直连）'}`);
  console.log(`  env=${env ? `HTTPS_PROXY=${env.HTTPS_PROXY} NO_PROXY=${env.NO_PROXY}` : 'null'}`);
  return route;
};

const given = process.argv.slice(2);
if (given.length) probe(given[0], given[1] ?? '');
else {
  probe('subscription:gemini', 'gemini-4-hydrogen');
  probe('subscription:gemini', 'gemini-4-hydrogen-low');
  probe('subscription:chatgpt', 'gpt-6.1-sol');
}

// 模拟「缓存没热」：ports 为空时会发生什么
const cold = resolveModelRoute({ routes, modelOverrides, ports: {} }, 'subscription:gemini', 'gemini-4-hydrogen');
console.log(`\n# 缓存冷启动（ports 为空）：mode=${cold.mode} proxyUrl=${cold.proxyUrl || '（直连）'} degraded=${cold.degraded} reason=${cold.reason || '-'}`);
process.exit(0);
