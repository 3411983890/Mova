/**
 * 负责：应用桌面同步的 Mihomo 线路、验证候选配置，并为 Linux 模型选择专用代理。
 * 不负责：登录账号、传输 Windows 凭据或代理浏览器流量。
 * 被谁调用：cloud-api.mjs 与 cloud-subscriptions.mjs。
 */

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildProxyEnv, isLoopbackProxyUrl, resolveModelRoute } from '../vpn/router.mjs';
import { fail } from './cloud-store.mjs';

const exec = promisify(execFile);
const subscriptions = { codex: 'subscription:chatgpt', gemini: 'subscription:gemini' };
const modelProviders = Object.values(subscriptions);

export function normalizeVpnBundle(input) {
  const source = input?.config;
  if (!Array.isArray(source?.proxies) || !source.proxies.length || !Array.isArray(source.listeners) || !source.listeners.length) {
    throw fail('vpn_config', '需要至少一条已分配的订阅模型代理');
  }
  const groups = source['proxy-groups'] ?? [];
  if (!Array.isArray(groups) || source.proxies.length > 500 || groups.length > 100 || source.listeners.length > 100) throw fail('vpn_config', '线路配置过大或格式不正确');
  const names = new Set([...source.proxies, ...groups].map(row => row?.name));
  if (names.has(undefined) || names.has('DIRECT') || names.has('REJECT')) throw fail('vpn_config', '节点名称无效');
  if (names.size !== source.proxies.length + groups.length || source.proxies.some(row => !row.type || /^(direct|pass|reject|reject-drop|compatible)$/i.test(row.type))) {
    throw fail('vpn_config', '订阅线路必须使用有效的代理节点');
  }
  for (const group of groups) {
    if (!Array.isArray(group.proxies) || !group.proxies.length || group.proxies.some(name => !names.has(name)) || group.use) {
      throw fail('vpn_config', '策略池须使用已同步节点');
    }
  }
  const ports = new Set();
  const listeners = source.listeners.map(row => {
    if (!row || !Number.isInteger(row.port) || row.port < 1024 || row.port > 65535 || ports.has(row.port) || !names.has(row.proxy)) {
      throw fail('vpn_config', '代理端口或节点无效');
    }
    ports.add(row.port);
    return { name: `mova-cloud-${row.port}`, type: 'mixed', listen: '127.0.0.1', port: row.port, proxy: row.proxy };
  });
  const portMap = Object.fromEntries(Object.entries(input.ports || {}).filter(([key, port]) => /^(node|pool):.{1,180}$/.test(key) && ports.has(port)));
  const routes = Object.fromEntries(Object.entries(input.routes || {}).filter(([key]) => modelProviders.includes(key)));
  const modelOverrides = Object.fromEntries(Object.entries(input.modelOverrides || {}).filter(([key]) => modelProviders.some(provider => key.startsWith(`${provider}/`))));
  return {
    config: { mode: 'rule', 'mixed-port': 0, 'log-level': 'warning', 'allow-lan': false, ipv6: false,
      proxies: source.proxies, 'proxy-groups': groups, listeners, rules: ['MATCH,REJECT'] },
    ports: portMap, routes, modelOverrides,
  };
}

export function proxyReachable(url) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(800, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}

export function createCloudVpn(home, env) {
  const dir = join(home, 'vpn');
  const saved = join(dir, 'routes.json');
  const runtime = join(dir, 'mihomo.json');
  const command = env.MOVA_MIHOMO_BIN || 'mihomo';
  let active;
  let child;
  let lastError;
  let pending = Promise.resolve();

  async function stopProcess() {
    const prior = child;
    child = null;
    if (!prior?.pid || prior.exitCode !== null || prior.signalCode !== null) return;
    const closed = once(prior, 'close').catch(() => {});
    prior.kill('SIGTERM');
    const limit = setTimeout(() => prior.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(limit); }
  }

  async function launch(bundle) {
    const urls = bundle.config.listeners.map(row => `http://127.0.0.1:${row.port}`);
    if ((await Promise.all(urls.map(proxyReachable))).some(Boolean)) throw fail('vpn_port', 'Mihomo 端口已被占用', 503);
    await writeFile(runtime, JSON.stringify(bundle.config), { mode: 0o600 });
    const process = spawn(command, ['-d', dir, '-f', runtime], { stdio: 'ignore' });
    child = process;
    process.once('error', () => { if (child === process) lastError = 'Mihomo 无法启动'; });
    await once(process, 'spawn');
    for (let attempt = 0; attempt < 12 && process.exitCode === null && process.signalCode === null; attempt += 1) {
      await delay(160);
      if ((await Promise.all(urls.map(proxyReachable))).every(Boolean) && process.exitCode === null && process.signalCode === null) return;
    }
    throw fail('vpn_start', '同步的 Mihomo 未能启动，请检查端口是否被占用', 503);
  }

  async function apply(input) {
    const bundle = normalizeVpnBundle(input);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const candidate = join(dir, 'candidate.json');
    try {
      await writeFile(candidate, JSON.stringify(bundle.config), { mode: 0o600 });
      await exec(command, ['-t', '-d', dir, '-f', candidate], { timeout: 12_000 });
    } catch { throw fail('vpn_check', 'Mihomo 未能通过线路配置检查', 503); }
    finally { await rm(candidate, { force: true }); }
    const prior = active;
    await stopProcess();
    try {
      await launch(bundle);
      await writeFile(`${saved}.new`, JSON.stringify(bundle), { mode: 0o600 });
      await rename(`${saved}.new`, saved);
      active = bundle;
      lastError = undefined;
      return status();
    } catch (error) {
      await stopProcess();
      if (prior) await launch(prior).catch(() => { lastError = '恢复上一版线路失败'; });
      throw error;
    }
  }

  function status() {
    return { running: Boolean(child?.pid && child.exitCode === null && child.signalCode === null),
      configured: Boolean(active), routes: Object.keys(active?.routes ?? {}),
      revision: active ? createHash('sha256').update(JSON.stringify(active)).digest('hex').slice(0, 12) : null,
      ...(lastError ? { error: lastError } : {}) };
  }

  return {
    status,
    async start() {
      let source;
      try { source = await readFile(saved, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') lastError = '无法读取 VPN 配置'; return; }
      try { active = normalizeVpnBundle(JSON.parse(source)); await launch(active); lastError = undefined; }
      catch { await stopProcess(); lastError = '已保存的 Mihomo 配置未启动'; }
    },
    configure(input) { const result = pending.then(() => apply(input)); pending = result.catch(() => {}); return result; },
    async resolve(provider, model) {
      const key = subscriptions[provider];
      const fallback = provider === 'codex' ? env.MOVA_CODEX_PROXY : env.MOVA_GEMINI_PROXY;
      const proxy = active ? resolveModelRoute(active, key, model).proxyUrl : fallback;
      if (!isLoopbackProxyUrl(proxy) || (active && !status().running) || !await proxyReachable(proxy)) {
        throw fail('vpn_required', '指定 VPN 线路不可用，订阅请求已暂停', 503);
      }
      return { url: proxy, proxyEnv: buildProxyEnv(proxy, {}) };
    },
    async close() { await pending; await stopProcess(); },
  };
}
