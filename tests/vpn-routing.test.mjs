/**
 * 按模型路由解析 + 内核缺失兜底的纯内存单测。
 *
 * 覆盖三件事：
 * 1. `modelOverrides` > `routes[providerId]` > 直连 的优先级；
 * 2. 「未分配 = 什么都不注入」与「分配 = 环境变量逐字正确」；
 * 3. 没有内核时返回 `kernel_missing`，并且**一个子进程都不起、一个文件都不写**。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { LOOPBACK_NO_PROXY } from '../electron/vpn/contract.mjs';
import {
  buildProxyEnv,
  createDispatcherCache,
  envForModel,
  isLoopbackProxyUrl,
  resolveModelRoute,
  resolveRouteTarget,
} from '../electron/vpn/router.mjs';
import { createMihomoManager } from '../electron/vpn/mihomo-manager.mjs';

const CONFIG = {
  routes: { 'subscription:chatgpt': { mode: 'pool', poolId: 'gpt_auto' } },
  modelOverrides: { 'subscription:gemini/model-a': { mode: 'pool', poolId: 'gemini_auto' } },
  ports: { 'pool:gpt_auto': 17901, 'pool:gemini_auto': 17902 },
};

test('未分配线路的模型解析成直连，且不注入任何代理', () => {
  const route = resolveModelRoute(CONFIG, 'provider:local', 'deepseek-v4');
  assert.equal(route.mode, 'direct');
  assert.equal(route.proxyUrl, '');
  assert.equal(route.port, 0);
  assert.equal(route.degraded, false);
  assert.equal(envForModel(CONFIG, 'provider:local', 'deepseek-v4'), null);
});

test('Provider 默认路由生效：解析到独立端口并注入完整代理环境变量', () => {
  const route = resolveModelRoute(CONFIG, 'subscription:chatgpt', 'gpt-6-sol');
  assert.equal(route.mode, 'pool');
  assert.equal(route.source, 'provider');
  assert.equal(route.port, 17901);
  assert.equal(route.proxyUrl, 'http://127.0.0.1:17901');

  const env = envForModel(CONFIG, 'subscription:chatgpt', 'gpt-6-sol', { PATH: '/usr/bin' });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:17901');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:17901');
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:17901');
  assert.equal(env.http_proxy, 'http://127.0.0.1:17901');
  assert.equal(env.https_proxy, 'http://127.0.0.1:17901');
  assert.equal(env.all_proxy, 'http://127.0.0.1:17901');
  assert.equal(env.NO_PROXY, LOOPBACK_NO_PROXY, '必须放行回环，否则 agy 回调本地 MCP 会超时');
  assert.equal(env.no_proxy, LOOPBACK_NO_PROXY);
  assert.equal(env.PATH, '/usr/bin', '原有环境变量必须保留');
});

test('单模型覆盖优先于 Provider 默认路由', () => {
  assert.equal(resolveRouteTarget(CONFIG, 'subscription:gemini', 'model-a').source, 'override');
  const route = resolveModelRoute(CONFIG, 'subscription:gemini', 'model-a');
  assert.equal(route.port, 17902);
  // 同 provider 的其它模型没有覆盖 → 回落到 provider 默认（这里是直连）。
  assert.equal(resolveModelRoute(CONFIG, 'subscription:gemini', 'model-b').mode, 'direct');
});

test('同一条线路被多个模型共用时指向同一个端口（一个入站）', () => {
  const config = {
    ...CONFIG,
    modelOverrides: { 'subscription:chatgpt/gpt-6-astra': { mode: 'pool', poolId: 'gpt_auto' } },
  };
  const a = resolveModelRoute(config, 'subscription:chatgpt', 'gpt-6-sol');
  const b = resolveModelRoute(config, 'subscription:chatgpt', 'gpt-6-astra');
  assert.equal(a.proxyUrl, b.proxyUrl);
});

test('分配了线路但内核没起（没有端口表）时降级为直连并说明原因', () => {
  const route = resolveModelRoute({ routes: CONFIG.routes, modelOverrides: {}, ports: {} }, 'subscription:chatgpt', 'x');
  assert.equal(route.proxyUrl, '', '拿不到端口就不注入代理，绝不悄悄直连后谎报走代理');
  assert.equal(route.degraded, true);
  assert.equal(route.reason, 'port_unassigned');
  assert.equal(envForModel({ routes: CONFIG.routes, modelOverrides: {}, ports: {} }, 'subscription:chatgpt', 'x'), null);
});

test('代理 URL 只接受本机回环，其它 host 一律拒绝', () => {
  assert.equal(isLoopbackProxyUrl('http://127.0.0.1:17901'), true);
  assert.equal(isLoopbackProxyUrl('http://10.0.0.5:8080'), false);
  assert.equal(isLoopbackProxyUrl('socks5://127.0.0.1:7890'), false);
  assert.equal(buildProxyEnv('http://10.0.0.5:8080'), null, '不能把模型流量导去第三方机器');
});

test('ProxyAgent 按端口缓存复用，不重复建连接池', () => {
  const created = [];
  const cache = createDispatcherCache({ createAgent: url => { created.push(url); return { close() {} }; } });
  const first = cache.get('http://127.0.0.1:17901');
  const again = cache.get('http://127.0.0.1:17901');
  assert.equal(first, again);
  assert.equal(created.length, 1);
  cache.get('http://127.0.0.1:17902');
  assert.equal(created.length, 2);
  assert.equal(cache.get('http://10.0.0.5:1'), null);
  cache.dispose();
  assert.equal(cache.size(), 0);
});

/** 最小的假子进程：只实现 manager 真正用到的成员。 */
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
  child.stdin = { destroy() {} };
  child.kill = () => true;
  return child;
}

test('内核缺失时返回 kernel_missing：不起任何子进程、不写 running.yaml', async () => {
  const spawned = [];
  const written = [];
  const manager = createMihomoManager({
    dir: 'C:\\fake\\vpn-runtime',
    binDir: 'C:\\fake\\bin',
    platform: 'win32',
    // 所有候选路径都不存在
    access: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    stat: async () => ({ isFile: () => true }),
    spawn: (...args) => { spawned.push(args); return fakeChild(); },
    mkdir: async () => {},
    writeFile: async (path) => { written.push(path); },
  });

  const result = await manager.start({ config: { yaml: 'mixed-port: 0\n', listeners: [], core: { controllerPort: 17900 } } });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'kernel_missing');
  assert.match(result.message, /内核/);
  assert.match(result.installHint, /mihomo\.exe/, '必须给出可执行的安装指引，而不是空白');
  assert.equal(spawned.length, 0, '没有内核就不许 spawn');
  assert.deepEqual(written, [], '没有内核就不许写运行态配置');
  assert.equal(manager.status().state, 'kernel_missing');
  assert.equal(manager.status().kernel.found, false);
  assert.equal(manager.isRunning(), false);
});

test('内核启动失败时完整回收子进程并留下可读原因', async () => {
  const killed = [];
  const child = fakeChild(999);
  const manager = createMihomoManager({
    dir: 'C:\\fake\\vpn-runtime',
    binDir: 'C:\\fake\\bin',
    platform: 'win32',
    access: async () => {},
    stat: async () => ({ isFile: () => true }),
    spawn: () => child,
    killTree: pid => { killed.push(pid); return { ok: true }; },
    mkdir: async () => {},
    writeFile: async () => {},
    // 永远不就绪：走到超时分支
    waitReady: async () => ({ ready: false, reason: 'timeout' }),
    graceMs: 1,
    reapTimeoutMs: 1,
  });

  const result = await manager.start({ config: { yaml: 'mixed-port: 0\n', listeners: [], core: { controllerPort: 17900 } } });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'core_start_failed');
  assert.deepEqual(killed, [999], '必须 taskkill 整棵进程树，不能留下占端口的孤儿');
  assert.equal(manager.status().state, 'start_failed');
  assert.equal(manager.status().pid, 0);
  assert.equal(manager.isRunning(), false);
});

test('内核就绪后状态回报 running，stop 后回到 stopped', async () => {
  const child = fakeChild(777);
  const manager = createMihomoManager({
    dir: 'C:\\fake\\vpn-runtime',
    binDir: 'C:\\fake\\bin',
    platform: 'win32',
    access: async () => {},
    stat: async () => ({ isFile: () => true }),
    spawn: () => child,
    killTree: () => ({ ok: true }),
    mkdir: async () => {},
    writeFile: async () => {},
    waitReady: async () => ({ ready: true, reason: '' }),
    graceMs: 1,
    reapTimeoutMs: 1,
  });

  const result = await manager.start({
    config: {
      yaml: 'mixed-port: 0\n',
      listeners: [{ name: 'mova-in-1', type: 'mixed', listen: '127.0.0.1', port: 17901, proxy: 'mova-pool:gpt_auto' }],
      core: { controllerPort: 17900 },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(manager.status().state, 'running');
  assert.equal(manager.status().pid, 777);
  assert.equal(manager.status().listeners.length, 1);

  await manager.stop();
  assert.equal(manager.status().state, 'stopped');
  assert.equal(manager.status().pid, 0);
});
