/**
 * 按模型分配 VPN 线路的**进程内运行时单例**与装配逻辑。
 *
 * 负责：
 * 1. 把 store（路由表 + 加密节点）、runtime-config（生成 running.yaml）、
 *    mihomo-manager（进程守护）、router（按模型解析端口）粘在一起；
 * 2. 维护一份内存快照（`ports` / `listeners` / `unassigned`），让
 *    `model-ipc.cjs` 在**每一轮对话的热路径**上同步拿到「这个模型该走哪个端口」；
 * 3. 提供 `status()` 的脱敏快照给设置页。
 * 不负责：IPC 通道注册（`ipc.mjs`）、解析节点文本（`parser.mjs`）、渲染（`src/features/vpn/`）。
 * 被谁调用：`ipc.mjs`（装配）、`model-ipc.cjs` / `chat-agent.mjs`（经 `getVpnRuntime()`）。
 *
 * 依赖方向沿用 `subscription/runtime.mjs` 的注册表写法：谁需要谁读，
 * 主进程里没有「把 vpn 实例层层传下去」的转发链；未装配时读到的就是 null，
 * 调用方必须按「按模型 VPN 未启用」处理——**此时行为与改动前逐字一致**。
 */
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { MAX_LISTENER_SPAN, shouldAutoStartCore } from './contract.mjs';
import { buildRuntimeConfig, collectRouteTargets } from './runtime-config.mjs';
import { createDispatcherCache, envForModel as resolveEnvForModel, resolveModelRoute } from './router.mjs';
import {
  createControllerClient, createHealthLoop, createHealthState, healPool, resolveHealthCheck, runHealthCycle,
} from './health.mjs';
import { regionLabel } from './region.mjs';

let current = null;

/** 由 `installVpnIpc` 在装配成功后调用。 */
export function setVpnRuntime(runtime) {
  current = runtime ?? null;
  return current;
}

/** 读取当前运行时；未装配返回 null（调用方必须按「未启用」处理）。 */
export function getVpnRuntime() {
  return current;
}

/** 测试用：清空注册表，避免用例互相影响。 */
export function resetVpnRuntime() {
  current = null;
}

/** 尝试绑定一个 loopback 端口：绑得上就是空闲。 */
function canBind(port) {
  return new Promise(resolve => {
    const server = createServer();
    const done = free => {
      server.removeAllListeners();
      try { server.close(() => resolve(free)); } catch { resolve(free); }
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try {
      server.listen({ host: '127.0.0.1', port, exclusive: true });
    } catch {
      done(false);
    }
  });
}

/**
 * 探测 `basePort` 起需要多少个端口才够 `count` 条线路使用，返回**已被占用**的端口列表。
 *
 * 只探「够用为止」的那一段（典型是 1~3 次绑定尝试），不做全端口扫描：
 * `status` 会被设置页频繁调用，扫 100 个口会让首屏明显变慢。
 */
export async function probeOccupiedPorts({ basePort, count = 0, span = MAX_LISTENER_SPAN, maxPort = 65535 } = {}) {
  const occupied = [];
  const wanted = Math.max(0, Math.floor(Number(count) || 0));
  if (!wanted) return occupied;
  const limit = Math.min(basePort + span - 1, maxPort);
  let free = 0;
  for (let port = basePort; port <= limit && free < wanted; port += 1) {
    // 端口探测必须串行：同时绑定会互相抢占，测出来的「空闲」是假的。
    if (await canBind(port)) free += 1;
    else occupied.push(port);
  }
  return occupied;
}

/**
 * @param {object} options
 * @param {object} options.store `createVpnStore(...)` 的实例
 * @param {object} options.manager `createMihomoManager(...)` 的实例（运行目录由它自己持有）
 * @param {object} [options.logger]
 * @param {(url: string) => any} [options.createAgent] 自定义 ProxyAgent 工厂（测试注入）
 * @param {Function} [options.probePorts] 端口探测实现（默认 `probeOccupiedPorts`）
 * @param {Function} [options.baseEnv] 子进程 base 环境（默认 `process.env`）
 */
export function createVpnRuntime({
  store,
  manager,
  logger = null,
  createAgent = null,
  probePorts = probeOccupiedPorts,
  baseEnv = () => process.env,
  now = Date.now,
  onVpnEvent = null,
} = {}) {
  // Controller 密钥每次进程启动生成一次：刷新配置（reload）不能换密钥，
  // 否则正在跑的进程与配置不一致，Controller 直接 401。
  const controllerSecret = randomBytes(32).toString('hex');
  let cache = { config: null, ports: {}, unassigned: [], generatedAt: 0 };
  let refreshing = null;
  let dispatchers = null;
  let cryptoOk = true;

  async function nodeList() {
    try {
      const vault = await store.readVault();
      cryptoOk = true;
      return { nodes: Array.isArray(vault.nodes) ? vault.nodes : [], subscriptions: vault.subscriptions ?? [] };
    } catch (error) {
      // 加密存储不可用（或还没初始化）：仍要能生成「只有直连」的配置，而不是整体挂掉。
      cryptoOk = false;
      logger?.warn?.('vault-unavailable', { code: error?.code || 'unknown' });
      return { nodes: [], subscriptions: [] };
    }
  }

  /** 重新生成运行态配置（纯计算 + 一次端口探测），并更新内存快照。 */
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const routes = await store.readRoutes();
      const { nodes } = await nodeList();
      const core = routes?.core ?? {};
      const targets = collectRouteTargets({
        pools: routes?.pools ?? [],
        routes: routes?.routes ?? {},
        modelOverrides: routes?.modelOverrides ?? {},
      });
      // 探测「被别的程序占用」的端口。**必须排除自己内核正在监听的那几个**：
      // 否则内核一起来，下一次 refresh 就会把自己的 listener 当成占用，端口整体后移一位，
      // 结果路由表指向 17901、而内核实际只听 17902 —— 表现为「分配了线路但流量没走代理」。
      const ownPorts = new Set(manager.isRunning?.() ? Object.values(cache.ports ?? {}) : []);
      const probed = typeof probePorts === 'function'
        ? await probePorts({
          basePort: Number(core.baseListenerPort) || 17901,
          count: targets.length,
          span: MAX_LISTENER_SPAN,
          maxPort: 65535,
        }).catch(() => [])
        : [];
      const occupiedPorts = probed.filter(port => !ownPorts.has(port));
      const config = buildRuntimeConfig({
        core: { ...core, secret: controllerSecret },
        pools: routes?.pools ?? [],
        routes: routes?.routes ?? {},
        modelOverrides: routes?.modelOverrides ?? {},
        nodes,
        occupiedPorts,
      });
      cache = { config, ports: config.ports, unassigned: config.unassigned, generatedAt: now(), routesConfig: routes };
      return cache;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function ensureCache() {
    if (!cache.config) await refresh();
    return cache;
  }

  /** 热路径：同步解析「这个模型走哪个端口」。未分配 → `mode:'direct'` + 空 proxyUrl。 */
  function routeFor(providerId, modelId) {
    const routes = cache.routesConfig ?? {};
    return resolveModelRoute(
      { routes: routes.routes ?? {}, modelOverrides: routes.modelOverrides ?? {}, ports: cache.ports },
      providerId,
      modelId,
    );
  }

  /** 热路径：该模型要注入的 ACP 子进程环境变量；未分配返回 null。 */
  function envForModel(providerId, modelId) {
    // 复用 router.mjs 的同一份实现（含回环校验与 NO_PROXY），避免两处各写一套环境变量。
    return resolveEnvForModel(
      {
        routes: cache.routesConfig?.routes ?? {},
        modelOverrides: cache.routesConfig?.modelOverrides ?? {},
        ports: cache.ports,
      },
      providerId,
      modelId,
      baseEnv(),
    );
  }

  /** 热路径：该模型的 fetch 实现；未分配返回 null（调用方保持原样，不传 fetchModel）。 */
  function fetchForModel(providerId, modelId) {
    const route = routeFor(providerId, modelId);
    if (!route.proxyUrl) return null;
    return createModelFetch(route.proxyUrl);
  }

  /** 包一层带代理的 fetch。`undici` 只在真的要发请求时才 import。 */
  function createModelFetch(proxyUrl) {
    return async (url, init) => {
      if (!dispatchers) {
        const factory = createAgent ?? await (async () => {
          const { ProxyAgent } = await import('undici');
          return link => new ProxyAgent(link);
        })();
        dispatchers = createDispatcherCache({ createAgent: factory });
      }
      const dispatcher = dispatchers.get(proxyUrl);
      const { fetch: undiciFetch } = await import('undici');
      return undiciFetch(url, { ...init, dispatcher });
    };
  }

  // ── 线路健康检查（按需预检 + 5 分钟周期巡检） ────────────────────────────
  // 用户口径：每次用之前先测速；5 分钟一次；当前节点超时就换节点；**但默认不跨地区**（账号风控）。
  // 这里只做编排：判定「健不健康」「该换谁」全在 health.mjs，周期巡检与按需预检共用同一份实现，
  // 否则两处规则会漂移（一处允许跨地区、另一处不允许，就是灾难）。
  const healthState = createHealthState();
  let healthLoop = null;
  let healthClient = null;
  let healthClientPort = 0;
  let crossRegionSwitch = false;

  /**
   * 把运行态配置里的池转成健康检查要的形状。
   * 成员名取自 `proxyNames`（内核里真正的 proxy 名），地区码取自 `mova-meta.pools[].memberRegions`，
   * 两边都来自同一次 `buildRuntimeConfig` —— 不另算一份，否则「池里是谁」会对不上。
   */
  function poolViews() {
    const metaPools = cache.config?.meta?.pools ?? {};
    const names = cache.config?.proxyNames ?? {};
    return Object.entries(metaPools).map(([poolId, info]) => ({
      id: poolId,
      group: info.group,
      healthTargets: Array.isArray(info.healthCheck?.targets) ? [...info.healthCheck.targets] : [],
      members: Object.entries(info.memberRegions ?? {}).map(([nodeId, code]) => ({
        name: names[nodeId] ?? nodeId,
        region: { code, label: regionLabel(code) },
      })),
    }));
  }

  /** Controller 客户端按端口缓存：端口只在 refresh 时可能变化。 */
  function healthController() {
    const port = Math.max(1, Number(cache.config?.core?.controllerPort) || 17900);
    if (!healthClient || healthClientPort !== port) {
      healthClient = createControllerClient({ port, secret: controllerSecret });
      healthClientPort = port;
    }
    return healthClient;
  }

  function emitVpnEvent(payload) {
    if (typeof onVpnEvent !== 'function') return;
    try { onVpnEvent(payload); } catch { /* 事件回调失败不影响巡检结论 */ }
  }

  function regionOfPoolNode(pool, nodeName) {
    const found = (pool?.members ?? []).find(item => item.name === nodeName);
    return found?.region ?? null;
  }

  /** 一轮巡检（周期定时器与 IPC 手动触发共用）。内核没跑时直接返回空结果，不制造噪声。 */
  async function runHealthCycleNow() {
    await ensureCache().catch(() => cache);
    if (!manager.isRunning()) return { checkedAt: Math.floor(Number(now()) || 0), results: [], skipped: 'core_not_running' };
    const pools = poolViews();
    if (!pools.length) return { checkedAt: Math.floor(Number(now()) || 0), results: [], skipped: 'no_pool' };
    return runHealthCycle({
      client: healthController(),
      pools,
      state: healthState,
      allowCrossRegion: crossRegionSwitch,
      now,
      onEvent: emitVpnEvent,
    });
  }

  /**
   * 「这次用之前先测一下」。
   *
   * - 未分配线路 / 内核没跑 → 立刻返回（不制造延迟）。
   * - `maxAgeMs` 内刚测过 → 直接返回缓存结论（连续发消息不会每次都打一轮探测）。
   * - 其余情况跑一次 `healPool`：健康就只记录，不健康才按「同地区优先」切换。
   *
   * **永不抛、永不阻断请求**：`degraded: true` 只是「这次可能不通」的提示，
   * 用户网络抖一下就发不出消息是更糟的结果。
   *
   * @param {string} providerId
   * @param {string} modelId
   * @param {{ maxAgeMs?: number }} [options]
   */
  async function ensureHealthyForModel(providerId, modelId, { maxAgeMs = 60_000 } = {}) {
    const route = routeFor(providerId, modelId);
    const base = { ...route, checked: false, nodeName: '', region: null, note: '', switched: null };
    if (!route.proxyUrl) return { ...base, healthy: true, note: 'direct' };
    if (!manager.isRunning()) return { ...base, healthy: false, degraded: true, note: 'core_not_running' };
    let pool = null;
    try {
      await ensureCache();
      pool = poolViews().find(item => item.id === route.poolId) ?? null;
    } catch {
      return { ...base, healthy: false, degraded: true, note: 'config_unavailable' };
    }
    if (!pool) return { ...base, healthy: false, degraded: true, note: 'pool_missing' };

    const at = Math.max(0, Math.floor(Number(now()) || 0));
    const last = Math.max(0, Number(healthState.checkedAt.get(route.poolId)) || 0);
    const fresh = Math.max(1_000, Math.floor(Number(maxAgeMs) || 0));
    if (last && at - last < fresh) {
      const nodeName = healthState.activeNodes.get(route.poolId) ?? '';
      return { ...base, healthy: true, nodeName, region: regionOfPoolNode(pool, nodeName), note: 'cached' };
    }
    try {
      const entry = await healPool({
        client: healthController(),
        pool,
        state: healthState,
        allowCrossRegion: crossRegionSwitch,
        now,
        onEvent: emitVpnEvent,
      });
      const healthy = Boolean(entry.ok) || Boolean(entry.switched);
      return {
        ...base,
        healthy,
        checked: true,
        degraded: !healthy,
        nodeName: entry.activeNode || '',
        region: entry.region ?? regionOfPoolNode(pool, entry.activeNode),
        note: entry.note || entry.reason || '',
        switched: entry.switched ?? null,
      };
    } catch (error) {
      logger?.warn?.('preflight-failed', { code: error?.code || 'internal' });
      return { ...base, healthy: false, degraded: true, note: 'preflight_failed' };
    }
  }

  /** 起/停周期巡检。默认 300000ms（用户要求 5 分钟一次）。 */
  function startHealthLoop({ intervalMs = undefined } = {}) {
    if (healthLoop) return { intervalMs: healthLoop.intervalMs, started: false };
    healthLoop = createHealthLoop({
      ...(intervalMs ? { intervalMs } : {}),
      onTick: () => runHealthCycleNow(),
      logger,
    });
    const started = healthLoop.start();
    return { intervalMs: started.intervalMs, started: started.started };
  }

  function stopHealthLoop() {
    if (!healthLoop) return { stopped: false };
    const result = healthLoop.stop();
    healthLoop = null;
    return result;
  }

  /** 「允许跨地区切换」开关（默认关）。关着时同地区没备选就**不动**，宁可慢也不换区。 */
  function setAllowCrossRegion(value) {
    crossRegionSwitch = value === true;
    return crossRegionSwitch;
  }

  /**
   * 给「测速」按钮用：把**所有策略池里的所有节点**逐个打一遍延迟（不是只测当前生效的那个）。
   *
   * 与 `runHealthCycleNow` 的区别：巡检只关心「当前节点还行不行」，测速是用户在问
   * 「我这些节点到底谁快」，所以要对每个成员都测，并把结果写进 `healthState.lastDelayMs`——
   * 这样后续换节点时的「择优」立刻能用上这批真实数据。
   *
   * 目标只用一个（优先 google 204）：测速要的是可比性，多目标会因为某条线路对某个目标的
   * 特例（例如 gstatic 被局部封锁）而让数字失去意义。
   */
  async function testNodes() {
    await ensureCache().catch(() => cache);
    if (!manager.isRunning()) return { ok: false, code: 'core_missing', results: [], health: healthSnapshot() };
    const client = healthController();
    const pools = poolViews();
    // 同一个节点可能被多个池引用：只测一次，结果共享。
    const targets = new Map();
    for (const pool of pools) {
      for (const member of pool.members) if (!targets.has(member.name)) targets.set(member.name, pool);
    }
    if (!targets.size) return { ok: true, results: [], health: healthSnapshot() };

    const results = [];
    for (const [name, pool] of targets) {
      const spec = resolveHealthCheck({ id: pool.id, group: pool.group });
      const target = spec.targets[0];
      const probe = await client.delay(name, target, spec.perTargetMs).catch(() => ({ ok: false, code: 'probe_failed' }));
      const delayMs = Number(probe?.delayMs);
      const ok = probe?.ok === true && Number.isFinite(delayMs) && delayMs > 0;
      if (ok) {
        healthState.lastDelayMs.set(name, delayMs);
        healthState.lastGoodAt.set(name, Math.max(0, Math.floor(Number(now()) || 0)));
      }
      results.push({ name, ok, delayMs: ok ? delayMs : null, code: ok ? '' : (probe?.code || 'probe_failed') });
      emitVpnEvent({ kind: 'delay', node: name, ok, delayMs: ok ? delayMs : null });
    }
    const working = results.filter(item => item.ok).length;
    return { ok: true, results, working, total: results.length, health: healthSnapshot() };
  }

  /** 每个池最近一次的健康结论（设置页展示用）。 */
  function healthSnapshot() {    const pools = poolViews();
    const rows = {};
    for (const pool of pools) {
      const switched = healthState.switches.get(pool.id) ?? null;
      const activeNode = healthState.activeNodes.get(pool.id) ?? '';
      rows[pool.id] = {
        group: pool.group,
        activeNode: activeNode || (switched?.to ?? ''),
        region: regionOfPoolNode(pool, activeNode || (switched?.to ?? '')) ?? null,
        checkedAt: Number(healthState.checkedAt.get(pool.id)) || 0,
        lastGoodAt: Number(healthState.lastGoodAt.get(activeNode)) || 0,
        delayMs: Number(healthState.lastDelayMs.get(activeNode)) || null,
        switched,
        members: pool.members.map(item => ({
          name: item.name,
          region: item.region,
          failures: Math.max(0, Number(healthState.failures.get(item.name)) || 0),
          delayMs: Number(healthState.lastDelayMs.get(item.name)) || null,
        })),
      };
    }
    return {
      allowCrossRegion: crossRegionSwitch,
      loopRunning: Boolean(healthLoop?.running),
      intervalMs: healthLoop?.intervalMs ?? 300_000,
      pools: rows,
    };
  }

  async function readRoutesCached() {
    if (!cache.routesConfig) await refresh();
    return cache.routesConfig;
  }

  /** 启动内核；内核缺失时原样返回 `kernel_missing` 状态（不 spawn 任何进程）。 */
  async function startCore() {
    const snapshot = await ensureCache();
    await readRoutesCached();
    const started = await manager.start({ config: snapshot.config });
    // 内核真的跑起来才开始巡检：没跑时探测只会拿到 controller_unreachable。
    if (started?.ok && started.state === 'running') startHealthLoop();
    return started;
  }

  async function stopCore() {
    stopHealthLoop();
    return manager.stop();
  }

  async function restartCore() {
    await refresh();
    await readRoutesCached();
    return manager.restart({ config: cache.config });
  }

  /** 配置变了：重写 running.yaml；正在跑就顺带重启，让 listeners 换成新端口。 */
  async function syncCore() {
    await refresh();
    await readRoutesCached();
    if (!manager.isRunning()) return { ok: true, state: manager.status().state, reloaded: false };
    return manager.sync({ config: cache.config });
  }

  /** 路由表变更后的统一收口：落盘 + 重建配置 + 按需重载内核。 */
  async function setRoutes(patch) {
    await store.updateRoutes(patch);
    cache.routesConfig = null;
    await refresh();
    return syncCore();
  }

  /** 脱敏状态快照（设置页首屏就是它）。 */
  async function status() {
    const snapshot = await ensureCache().catch(() => cache);
    let state;
    try {
      state = await store.getSanitizedState({ delays: {}, cooldowns: {} });
    } catch (error) {
      state = { cryptoOk: false, subscriptions: [], nodes: [], routes: await store.readRoutes().catch(() => null) };
      logger?.warn?.('status-failed', { code: error?.code || 'unknown' });
    }
    const kernel = manager.status();
    return {
      cryptoOk: state.cryptoOk !== false && cryptoOk,
      core: {
        ...(state.routes?.core ?? {}),
        // 不把 secret 回传渲染层：它只用于本机 Controller，渲染层没有任何用途。
        state: kernel.state,
        running: kernel.state === 'running',
        pid: kernel.pid,
        startedAt: kernel.startedAt,
        lastError: kernel.lastError,
        lastErrorCode: kernel.lastErrorCode,
        kernelFound: Boolean(kernel.kernel?.found),
        kernelPath: kernel.kernel?.path ?? '',
        kernelSource: kernel.kernel?.source ?? '',
        // 已经检查过的候选路径：界面直接展示，用户不必猜「为什么说没装」。
        candidates: Array.isArray(kernel.kernel?.candidates) ? [...kernel.kernel.candidates] : [],
        installHint: kernel.installHint ?? '',
        configPath: kernel.configPath,
      },
      subscriptions: Array.isArray(state.subscriptions) ? state.subscriptions : [],
      nodes: Array.isArray(state.nodes) ? state.nodes : [],
      routes: state.routes ?? null,
      engine: {
        listeners: (snapshot.config?.listeners ?? []).map(item => ({ ...item })),
        ports: { ...snapshot.ports },
        unassigned: snapshot.unassigned.map(item => ({ ...item })),
        generatedAt: snapshot.generatedAt,
        proxyCount: snapshot.config?.proxies?.length ?? 0,
      },
      health: healthSnapshot(),
    };
  }

  /**
   * 开机自启：`core.autoStart` 为真且内核没跑时启动一次。
   *
   * 为什么必须有这一步：`autoStart` 以前只是配置里的一个字段，没有任何消费者。结果是最常见的
   * 一条链路断在这里——软件刚启动、内核没起 → `ports` 为空 → `envForModel()` 返回 null →
   * ACP 子进程（`agy`）和额度探针都直连 → 国内连不上 → 用户看到的是「模型没走 VPN，额度读不出来」。
   *
   * 永不抛：自启失败只是「这次直连」，界面上的内核状态会如实显示未启动。
   * @returns {Promise<{started: boolean, reason: string}>}
   */
  async function maybeAutoStart() {
    try {
      const routes = await store.readRoutes();
      const decision = shouldAutoStartCore({
        autoStart: routes?.core?.autoStart === true,
        running: manager.isRunning() === true,
      });
      if (!decision.start) return { started: false, reason: decision.reason };
      const result = await startCore();
      const ok = result?.ok === true && result.state === 'running';
      if (!ok) logger?.warn?.('autostart-failed', { code: result?.code || 'unknown' });
      return { started: ok, reason: ok ? 'started' : (result?.code || 'failed') };
    } catch (error) {
      logger?.warn?.('autostart-error', { code: error?.code || 'internal' });
      return { started: false, reason: 'error' };
    }
  }

  async function dispose() {
    stopHealthLoop();
    dispatchers?.dispose();
    dispatchers = null;
    await manager.dispose().catch(() => {});
  }

  return {
    refresh,
    status,
    routeFor,
    envForModel,
    fetchForModel,
    createModelFetch,
    startCore,
    stopCore,
    restartCore,
    maybeAutoStart,
    syncCore,
    setRoutes,
    dispose,
    ensureHealthyForModel,
    runHealthCycleNow,
    testNodes,
    startHealthLoop,
    stopHealthLoop,
    setAllowCrossRegion,
    healthSnapshot,
    /** 生成器产出的 YAML（预览 / 排障用；不含任何密钥以外的敏感字段）。 */
    get runningYaml() { return cache.config?.yaml ?? ''; },
    get ports() { return { ...cache.ports }; },
    get generatedAt() { return cache.generatedAt; },
    controllerSecret,
  };
}

/** 便于 ipc / main.cjs 拼路径：运行态目录 + 托管内核目录。 */
export function resolveVpnDirs(userDataDir) {
  return {
    dir: join(userDataDir, 'vpn-runtime'),
    binDir: join(userDataDir, 'bin'),
  };
}
