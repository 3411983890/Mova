/**
 * Mihomo 运行态配置生成器（**纯函数**，可被 `node --test` 直接跑）。
 *
 * 负责：把「每个模型 → 线路」映射 + 已导入节点 + 端口分配计划，生成 `running.yaml`
 * 的文本与端口表：每条线路一个独立 loopback 口，同一线路被多个模型共用时只起一个入站。
 * 不负责：探测端口是否真的空闲（由 manager 注入 `occupiedPorts`）、写盘、起进程
 * （`mihomo-manager.mjs`）、路由优先级解析（`router.mjs`）。
 * 被谁调用：`mihomo-manager.mjs`（写 running.yaml 前）、`runtime.mjs`（刷新快照）、
 * `tests/vpn-runtime-config.test.mjs`。
 */
import YAML from 'yaml';
import {
  MAX_LISTENER_SPAN,
  normalizeRouteTarget,
  routeTargetKey,
} from './contract.mjs';
import { commonRegionCode, regionLabel, regionOfNode } from './region.mjs';
import { resolveHealthCheck } from './health.mjs';

/** 本地监听端口的下限：1024 以下是特权端口，普通用户进程绑不上。 */
const MIN_PORT = 1024;
/** 上限留出 500 个口，避免把系统临时端口段（Windows 默认 49152 起）整段吃掉。 */
const MAX_PORT = 65000;

/** 入站 listener 的名称前缀，Mihomo 里只用于日志与 Controller 索引。 */
const LISTENER_PREFIX = 'mova-in-';
/** 策略池组的名称前缀：`mova-pool:<poolId>`（方案 §2.2）。 */
const GROUP_PREFIX = 'mova-pool:';
/**
 * 自定义顶层键：Mihomo 解析配置用的是「结构体 + 忽略未知字段」，未知顶层键不会导致启动失败。
 * 我们把运行态元信息（每个池的地区/策略/健康检查目标）写在这里，好处是**配置与元信息同一份**
 * 不会出现两份状态互相漂移；`mihomo -t` 已验证可通过（见报告）。真出问题的兜底是改写成旁挂
 * `runtime.json`，届时只需改这一处常量与 `buildRuntimeConfig` 的 doc 装配。
 */
const META_KEY = 'mova-meta';
/** 组内探活间隔：用户要求「5min 一次」，作为默认值；`pool.intervalSec` 仍可覆盖。 */
const DEFAULT_GROUP_INTERVAL_SEC = 300;

function intInRange(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function nonEmptyName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一化生成器用到的内核字段。
 * `secret` 必须由调用方（manager）用 `randomBytes` 生成后再传进来——本模块是纯函数，
 * 不能自己取随机数，否则同样的输入会生成不同的配置，单测无法断言。
 */
export function normalizeRuntimeCore(core = {}) {
  const baseListenerPort = intInRange(core?.baseListenerPort, 17901, MIN_PORT, MAX_PORT);
  return {
    controllerPort: intInRange(core?.controllerPort, 17900, MIN_PORT, MAX_PORT),
    baseListenerPort,
    maxListenerPort: Math.min(baseListenerPort + MAX_LISTENER_SPAN - 1, MAX_PORT),
    secret: typeof core?.secret === 'string' ? core.secret.slice(0, 128) : '',
    logLevel: ['silent', 'error', 'warning', 'info', 'debug'].includes(core?.logLevel) ? core.logLevel : 'warning',
    mode: ['rule', 'global', 'direct'].includes(core?.mode) ? core.mode : 'rule',
    ipv6: core?.ipv6 !== false,
    unifiedDelay: core?.unifiedDelay !== false,
  };
}

/**
 * 从未占用的端口里顺延分配 `count` 个。
 *
 * @param {{ basePort: number, count: number, occupied?: number[], maxPort?: number }} input
 *   `occupied` = 已被别的东西占用的端口（含 Controller 自己的端口）。
 * @returns {{ ports: number[], exhausted: boolean }} `exhausted` 为真表示没分够。
 */
export function allocateListenerPorts({ basePort, count, occupied = [], maxPort = MAX_PORT } = {}) {
  const start = intInRange(basePort, 17901, MIN_PORT, MAX_PORT);
  const limit = intInRange(maxPort, Math.min(start + MAX_LISTENER_SPAN - 1, MAX_PORT), start, MAX_PORT);
  const wanted = Math.max(0, Math.floor(Number(count) || 0));
  const used = new Set((Array.isArray(occupied) ? occupied : []).filter(port => Number.isInteger(port)));
  const ports = [];
  for (let port = start; port <= limit && ports.length < wanted; port += 1) {
    if (used.has(port)) continue;
    used.add(port);
    ports.push(port);
  }
  return { ports, exhausted: ports.length < wanted };
}

/**
 * 收集需要独立入站的线路目标（策略池 / 固定节点），按稳定顺序去重。
 *
 * 顺序 = 配置里的策略池顺序，再补上「只被固定节点路由引用」的节点（按 key 排序）。
 * 稳定性很重要：端口按这个顺序分配，顺序抖动会让每次重载都把端口挪一遍。
 */
export function collectRouteTargets({ pools = [], routes = {}, modelOverrides = {} } = {}) {
  const usedBy = new Map();
  const note = (target, who) => {
    const key = routeTargetKey(target);
    if (!key) return;
    if (!usedBy.has(key)) usedBy.set(key, { key, users: [] });
    const record = usedBy.get(key);
    if (who && !record.users.includes(who)) record.users.push(who);
  };
  for (const [providerId, raw] of Object.entries(routes && typeof routes === 'object' ? routes : {})) {
    note(normalizeRouteTarget(raw), providerId);
  }
  for (const [key, raw] of Object.entries(modelOverrides && typeof modelOverrides === 'object' ? modelOverrides : {})) {
    note(normalizeRouteTarget(raw), key);
  }

  const out = [];
  const seen = new Set();
  for (const pool of Array.isArray(pools) ? pools : []) {
    const id = nonEmptyName(pool?.id);
    if (!id) continue;
    const key = `pool:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: 'pool', id, usedBy: usedBy.get(key)?.users ?? [] });
  }
  const nodeKeys = [...usedBy.keys()].filter(key => key.startsWith('node:')).sort();
  for (const key of nodeKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: 'node', id: key.slice('node:'.length), usedBy: usedBy.get(key).users });
  }
  return out;
}

function uniqueProxyName(used, name) {
  let final = name;
  let index = 2;
  while (used.has(final)) final = `${name} (${index++})`;
  used.add(final);
  return final;
}

/**
 * 生成运行态配置。
 *
 * @param {object} input
 * @param {object} [input.core] `{ controllerPort, baseListenerPort, maxListenerPort, secret, logLevel }`
 * @param {object[]} [input.pools] 策略池（store 已归一化）
 * @param {Record<string, object>} [input.routes] Provider 默认路由
 * @param {Record<string, object>} [input.modelOverrides] 单模型覆盖
 * @param {object[]} [input.nodes] 已导入节点，必须带 `{ id, name, raw }`
 * @param {number[]} [input.occupiedPorts] 已被占用、不可分配的端口
 * @returns {{
 *   yaml: string, doc: object, listeners: object[], groups: object[], proxies: object[],
 *   targets: object[], ports: Record<string, number>, unassigned: object[],
 *   core: object, proxyNames: Record<string, string>,
 *   meta: object, healthCheck: object,
 *   proxyFieldIssues: { name: string, field: string }[]
 * }}
 *   `meta` = 写进 YAML 顶层 `mova-meta` 的同一份对象（每池 `strategy` / `region` / `memberRegions`
 *   / `healthCheck`）；`healthCheck` = 与渠道无关的默认值（每池目标在 `meta.pools[].healthCheck`）。
 */
export function buildRuntimeConfig(input = {}) {
  const core = normalizeRuntimeCore(input?.core);
  const poolList = Array.isArray(input?.pools) ? input.pools : [];
  const nodeList = (Array.isArray(input?.nodes) ? input.nodes : []).filter(item => item && item.id && item.raw);
  const nodeById = new Map();
  for (const node of nodeList) {
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  }

  const targets = collectRouteTargets({
    pools: poolList,
    routes: input?.routes,
    modelOverrides: input?.modelOverrides,
  });

  const poolById = new Map();
  for (const pool of poolList) {
    if (typeof pool?.id === 'string' && pool.id) poolById.set(pool.id, pool);
  }

  // 先把「有内容可起」的目标挑出来：策略池要至少有一个已导入节点，固定节点要真的在库里。
  const usable = [];
  const unassigned = [];
  for (const target of targets) {
    if (target.kind === 'pool') {
      const pool = poolById.get(target.id);
      const ids = Array.isArray(pool?.nodeIds) ? pool.nodeIds : [];
      const names = ids.filter(id => nodeById.has(id));
      if (!names.length) {
        unassigned.push({ ...target, code: 'node_unavailable', detail: '策略池里没有已导入且可用的节点' });
        continue;
      }
      usable.push({ ...target, pool, nodeIds: names });
      continue;
    }
    if (!nodeById.has(target.id)) {
      unassigned.push({ ...target, code: 'node_unavailable', detail: '固定节点已被删除或未导入' });
      continue;
    }
    usable.push(target);
  }

  const allocation = allocateListenerPorts({
    basePort: core.baseListenerPort,
    count: usable.length,
    // Controller 自己也监听一个本地端口：分配 listener 时必须先把它排除。
    occupied: [core.controllerPort, ...(Array.isArray(input?.occupiedPorts) ? input.occupiedPorts : [])],
    maxPort: core.maxListenerPort,
  });

  const accepted = usable.slice(0, allocation.ports.length);
  for (const target of usable.slice(allocation.ports.length)) {
    unassigned.push({ ...target, code: 'port_exhausted', detail: '本地空闲端口不足' });
  }

  const usedProxyNames = new Set();
  const proxyNames = new Map();
  const proxies = [];
  /**
   * proxy 字段**不做白名单过滤**：Mihomo 的字段名必须原样进 YAML。
   * 这里只做两件保护性处理：
   * 1. `ports`（hysteria2 端口跳跃）必须是字符串——数字/数组形态写进配置会被内核
   *    当成非法字段；宁可丢掉它回落 `port` 单端口，也不产生一份起不来的配置。
   * 2. 每条 proxy 的 `name` 必须唯一（Mihomo 重名会直接拒绝整份配置）。
   * anytls 需要的 `password` / `client-fingerprint`、vless 需要的 `reality-opts`
   * 都在 `...node.raw` 里原样透传，新增协议不需要再改这里。
   */
  const proxyForRuntime = raw => {
    const proxy = { ...raw };
    if (proxy.ports !== undefined && typeof proxy.ports !== 'string') delete proxy.ports;
    return proxy;
  };
  const addProxy = nodeId => {
    if (proxyNames.has(nodeId)) return proxyNames.get(nodeId);
    const node = nodeById.get(nodeId);
    const name = uniqueProxyName(usedProxyNames, nonEmptyName(node?.name) || nodeId);
    proxyNames.set(nodeId, name);
    proxies.push({ ...proxyForRuntime(node.raw), name });
    return name;
  };

  const groups = [];
  const listeners = [];
  const ports = {};
  /** `mova-meta.pools[poolId]`：每个池的策略/地区/成员地区分布/健康检查目标。 */
  const metaPools = {};
  /** `mova-meta.nodeRegions[nodeId]`：节点 id → 两位地区码（UI 与预检共用一份口径）。 */
  const nodeRegions = {};

  accepted.forEach((target, index) => {
    const port = allocation.ports[index];
    ports[target.key] = port;
    let pinned;
    if (target.kind === 'pool') {
      const { pool } = target;
      const ordered = [...target.nodeIds];
      // 手动指定的首选节点排最前：Mihomo 的 fallback/select 都按列表顺序取第一个可用项。
      if (pool.selectedNodeId && ordered.includes(pool.selectedNodeId)) {
        ordered.splice(ordered.indexOf(pool.selectedNodeId), 1);
        ordered.unshift(pool.selectedNodeId);
      }
      const groupName = `${GROUP_PREFIX}${pool.id}`;
      const group = {
        name: groupName,
        type: ['url-test', 'fallback', 'select'].includes(pool.strategy) ? pool.strategy : 'url-test',
        proxies: ordered.map(addProxy),
      };
      if (group.type !== 'select') {
        group.url = typeof pool.testUrl === 'string' && pool.testUrl ? pool.testUrl : 'https://www.gstatic.com/generate_204';
        group.interval = intInRange(pool.intervalSec, DEFAULT_GROUP_INTERVAL_SEC, 30, 3600);
        group.tolerance = intInRange(pool.toleranceMs, 150, 10, 2000);
      }
      groups.push(group);
      const memberRegions = {};
      for (const nodeId of ordered) {
        const node = nodeById.get(nodeId);
        const region = regionOfNode({ name: node?.name ?? '', server: node?.server ?? '' });
        nodeRegions[nodeId] = region.code;
        memberRegions[nodeId] = region.code;
      }
      const poolRegionCode = commonRegionCode(Object.values(memberRegions).map(code => ({ code })));
      const poolHealth = resolveHealthCheck(pool);
      metaPools[pool.id] = {
        strategy: group.type,
        // 池内节点地区一致 → 写该两位码；不一致（或全是未知）→ `mixed`。
        region: poolRegionCode,
        regionLabel: poolRegionCode === 'mixed' ? '混合地区' : regionLabel(poolRegionCode),
        memberRegions,
        group: groupName,
        port,
        url: typeof pool.testUrl === 'string' && pool.testUrl ? pool.testUrl : '',
        healthCheck: {
          url: poolHealth.url,
          targets: [...poolHealth.targets],
          intervalMs: poolHealth.intervalMs,
          timeoutMs: poolHealth.timeoutMs,
          perTargetMs: poolHealth.perTargetMs,
        },
      };
      pinned = groupName;
    } else {
      const node = nodeById.get(target.id);
      nodeRegions[target.id] = regionOfNode({ name: node?.name ?? '', server: node?.server ?? '' }).code;
      pinned = addProxy(target.id);
    }
    listeners.push({
      name: `${LISTENER_PREFIX}${index + 1}`,
      type: 'mixed',
      listen: '127.0.0.1',
      port,
      proxy: pinned,
    });
  });

  const defaultHealth = resolveHealthCheck({});
  const meta = {
    version: 1,
    // 默认值（与渠道无关的那一份）：真正的每池目标在 `pools[].healthCheck`。
    healthCheck: {
      url: defaultHealth.url,
      targets: [...defaultHealth.targets],
      intervalMs: defaultHealth.intervalMs,
      timeoutMs: defaultHealth.timeoutMs,
      perTargetMs: defaultHealth.perTargetMs,
    },
    pools: metaPools,
    nodeRegions,
  };
  const healthCheck = {
    url: defaultHealth.url,
    targets: [...defaultHealth.targets],
    intervalMs: defaultHealth.intervalMs,
    timeoutMs: defaultHealth.timeoutMs,
    perTargetMs: defaultHealth.perTargetMs,
    perNodeMs: defaultHealth.perTargetMs,
  };

  const doc = {
    'mixed-port': 0,
    'allow-lan': false,
    mode: core.mode,
    'log-level': core.logLevel,
    ipv6: core.ipv6,
    'unified-delay': core.unifiedDelay,
    'external-controller': `127.0.0.1:${core.controllerPort}`,
    secret: core.secret,
    tun: { enable: false },
    proxies,
    'proxy-groups': groups,
    listeners,
    [META_KEY]: meta,
    // 入站都钉死了 proxy，规则只负责兜底：既不想让流量被动走默认出口，也不能漏掉直连语义。
    rules: ['MATCH,DIRECT'],
  };

  const yaml = YAML.stringify(doc);
  return {
    yaml,
    doc,
    core,
    proxies,
    groups,
    listeners,
    targets: accepted,
    ports,
    unassigned,
    meta,
    healthCheck,
    proxyNames: Object.fromEntries(proxyNames),
    // 自检结果：为空表示 `ports` / `type` / `password` 这些关键字段都原样落进了 YAML。
    // 一旦有人给 proxy 透传加白名单把字段吞掉，这里会立刻非空（测试直接断言为空）。
    proxyFieldIssues: findUnserializedProxyFields(yaml, proxies),
  };
}

/**
 * 检查 proxy 的关键字符串字段是否真的出现在生成的 YAML 里。
 *
 * 为什么要这个：`ports`（hysteria2 端口跳跃）与 `password`（anytls 的密码就写在这里）
 * 一旦被某个「字段白名单」过滤掉，内核配置看起来合法但一定连不上，而且没有任何报错。
 *
 * @param {string} yamlText
 * @param {object[]} proxies
 * @returns {{ name: string, field: string }[]}
 */
export function findUnserializedProxyFields(yamlText, proxies = []) {
  const text = typeof yamlText === 'string' ? yamlText : '';
  const issues = [];
  for (const proxy of Array.isArray(proxies) ? proxies : []) {
    for (const field of ['type', 'password', 'ports']) {
      const value = proxy?.[field];
      if (typeof value !== 'string' || !value) continue;
      if (!text.includes(value)) issues.push({ name: String(proxy?.name || ''), field });
    }
  }
  return issues;
}
