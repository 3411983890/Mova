/**
 * `vpn:*` IPC 装配器（主进程）。
 *
 * 负责：把 `contract.mjs` 的通道清单逐个注册成 `ipcMain.handle`，做边界校验、
 * 统一 `{ ok, value } / { ok:false, error, message }` 返回形状、错误码→中文文案映射，
 * 以及凭据走 safeStorage 加密落盘（`store.mjs`）。
 * 不负责：UI、解析（`parser.mjs`）、进程管理（`mihomo-manager.mjs`）、路由解析（`router.mjs`）。
 * 被谁调用：`electron/main.cjs`（`installVpnIpc`），渲染层经 `preload.cjs` 的 `vpn` 命名空间。
 *
 * 红线（方案 §6.1）：返回渲染层的一律是脱敏视图——订阅 URL 只留域名摘要、
 * 节点只留 `serverHint`；日志只记通道名、错误码与 id，绝不打印 uuid / 密码 / 完整 URL。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  CHANNELS,
  DEFAULT_TEST_URL,
  VpnError,
  fail,
  ok,
  sanitizeSubscriptionView,
} from './contract.mjs';
import { parseImportPayload, parseSubscriptionUserinfo } from './parser.mjs';
import { scanFxyProfiles, loadFxyImport } from './fxy-import.mjs';
import { createVpnStore } from './store.mjs';
import { createMihomoManager } from './mihomo-manager.mjs';
import {
  createVpnRuntime,
  probeOccupiedPorts,
  resolveVpnDirs,
  setVpnRuntime,
} from './runtime.mjs';

/** 订阅拉取的短超时：设置页是同步等待的，卡住比失败更糟。 */
const SUBSCRIPTION_TIMEOUT_MS = 20_000;
/** 订阅正文上限：正常机场订阅几百 KB，10 MB 已经足够且能挡住「误把大文件当订阅」。 */
const SUBSCRIPTION_MAX_BYTES = 10 * 1024 * 1024;
/** 机场订阅常见的 UA；不带它有些服务端会返回 HTML 而不是节点列表。 */
const SUBSCRIPTION_UA = 'clash.meta/mihomo (Mova)';

function asText(value, max = 4096) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asHttpUrl(value) {
  const text = asText(value, 4096);
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(text)) throw new VpnError('request', { message: '订阅链接必须是 http(s) 地址' });
  return text;
}

function sourceIdForUrl(url) {
  return `sub_${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
}

/**
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain
 * @param {import('electron').App} options.app
 * @param {object} options.safeStorage Electron `safeStorage`（异步加密 API）
 * @param {object} [options.clipboard] Electron `clipboard`
 * @param {object} [options.dialog] Electron `dialog`
 * @param {Function} [options.fetch] 注入的 fetch（测试与 `net.fetch` 都行）
 * @param {(event: any) => any} [options.authorize] 发送方校验（main.cjs 的 `senderWindow`）
 * @param {() => any} [options.getWin] 事件推送目标窗口
 * @param {object} [options.logger] `getLogger('vpn')`
 */
export function installVpnIpc({
  ipcMain,
  app,
  safeStorage,
  clipboard = null,
  dialog = null,
  fetch: fetchImpl = globalThis.fetch,
  authorize = null,
  getWin = () => null,
  logger = null,
  killTree = null,
  spawn = null,
  userDataDir = '',
} = {}) {
  const root = asText(userDataDir, 4096) || app.getPath('userData');
  const { dir, binDir } = resolveVpnDirs(root);
  const store = createVpnStore({
    dir: root,
    // Electron 45 的异步加密 API：`decryptStringAsync` 返回 `{ result }`，store 两种都兼容。
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: text => safeStorage.encryptStringAsync(text),
    decrypt: buffer => safeStorage.decryptStringAsync(buffer),
  });
  /** 用户手选的内核路径：路由表是唯一事实源，这里只做一次同步读取的缓存。 */
  let configuredBinaryPath = '';
  const manager = createMihomoManager({
    dir,
    binDir,
    killTree,
    // `spawn` 只在主进程里注入真实实现；测试不经过这层。
    ...(typeof spawn === 'function' ? { spawn } : {}),
    logger,
    // 内核路径是用户可改的运行时配置：用函数取值，改完不必重建 manager。
    binaryPath: () => configuredBinaryPath,
  });
  const runtime = createVpnRuntime({ store, manager, logger, probePorts: probeOccupiedPorts });
  setVpnRuntime(runtime);

  async function syncConfiguredBinaryPath() {
    try {
      const routes = await store.readRoutes();
      configuredBinaryPath = typeof routes?.core?.binaryPath === 'string' ? routes.core.binaryPath : '';
    } catch {
      configuredBinaryPath = '';
    }
  }

  const channels = new Set();

  /** 统一包装：参数校验、错误码映射、发送方校验都在这里收口。 */
  function handle(channel, run) {
    if (typeof ipcMain?.handle !== 'function') return;
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (typeof authorize === 'function') authorize(event);
        const value = await run(input ?? {}, event);
        return ok(value === undefined ? null : value);
      } catch (error) {
        const code = error?.code && typeof error.code === 'string' ? error.code : 'internal';
        // 只记通道 + 错误码 + 短 detail：detail 由抛出方保证不含凭据（见各 VpnError 调用点）。
        logger?.warn?.('ipc-failed', { channel, code, detail: String(error?.detail ?? '').slice(0, 120) });
        return fail(error);
      }
    });
    channels.add(channel);
  }

  function emit(payload) {
    try {
      getWin()?.webContents?.send?.(CHANNELS.event, payload);
    } catch {
      // 窗口已关：事件丢了没关系，下一次 status 会拿到最新状态。
    }
  }

  /** 任何「线路/节点/路由」变更后：重建运行态配置，运行中则重载内核。 */
  async function afterChange() {
    await syncConfiguredBinaryPath();
    await runtime.syncCore().catch(error => {
      logger?.warn?.('core-sync-failed', { code: error?.code || 'unknown' });
    });
    emit({ kind: 'status', core: manager.status() });
  }

  async function fetchSubscriptionText(url) {
    if (typeof fetchImpl !== 'function') throw new VpnError('subscription_fetch', { message: '当前环境没有可用的网络实现' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBSCRIPTION_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': SUBSCRIPTION_UA, accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response?.ok) {
        throw new VpnError('subscription_fetch', {
          message: `订阅链接拉取失败（HTTP ${Number(response?.status) || 0}）`,
        });
      }
      const userinfo = parseSubscriptionUserinfo(
        typeof response.headers?.get === 'function' ? response.headers.get('subscription-userinfo') : '',
      );
      const text = await response.text();
      if (typeof text !== 'string' || !text.trim()) throw new VpnError('empty_input');
      if (text.length > SUBSCRIPTION_MAX_BYTES) {
        throw new VpnError('subscription_fetch', { message: '订阅内容超过 10 MB，已拒绝导入' });
      }
      return { text, usage: userinfo };
    } catch (error) {
      if (error instanceof VpnError) throw error;
      const aborted = error?.name === 'AbortError';
      throw new VpnError('subscription_fetch', {
        message: aborted ? `订阅链接拉取超时（${SUBSCRIPTION_TIMEOUT_MS / 1000}s）` : '订阅链接拉取失败，请检查网络或链接是否有效',
        detail: error?.message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 导入诊断透传：`parseImportPayload` 会把「不支持的协议 / 非法端口范围」放在
   * `warnings` 与 `skipped` 里。以前这里只回 `nodeCount`，于是界面上永远看不到
   * 「共 9 条、导入 7 条、跳过 2 条」——用户会以为订阅只有 7 条节点。必须原样透传。
   * @param {{ total?: number, nodes?: unknown[], warnings?: unknown[], skipped?: unknown[] }} [parsed]
   */
  function importDiagnostics(parsed) {
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0;
    return {
      total: Number.isFinite(Number(parsed?.total)) ? Number(parsed.total) : nodes,
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings : [],
      skipped: Array.isArray(parsed?.skipped) ? parsed.skipped : [],
    };
  }

  async function importSubscription({ url, name, autoUpdateHours } = {}) {
    const target = asHttpUrl(url);
    const { text, usage } = await fetchSubscriptionText(target);
    const id = sourceIdForUrl(target);
    const label = asText(name, 80) || `订阅 · ${(() => {
      try { return new URL(target).host; } catch { return '远程'; }
    })()}`;
    const parsed = parseImportPayload(text, { sourceId: id, sourceLabel: label });
    if (parsed.kind !== 'nodes' || !parsed.nodes.length) {
      throw new VpnError('parse_failed', { message: '订阅内容里没有可导入的节点' });
    }
    const subscription = {
      id,
      kind: 'subscription',
      name: label,
      url: target,
      updatedAt: Date.now(),
      nodeCount: parsed.nodes.length,
      usage: usage ?? null,
      lastError: '',
      ...(Number.isFinite(Number(autoUpdateHours)) ? { autoUpdateHours: Math.max(0, Math.floor(Number(autoUpdateHours))) } : {}),
    };
    await store.upsertSource({ subscription, nodes: parsed.nodes });
    await afterChange();
    return {
      subscription: sanitizeSubscriptionView(subscription),
      nodeCount: parsed.nodes.length,
      ...importDiagnostics(parsed),
    };
  }

  async function refreshSubscription({ id } = {}) {    const sourceId = asText(id, 80);
    if (!sourceId) throw new VpnError('request');
    const vault = await store.readVault();
    const existing = vault.subscriptions.find(item => item.id === sourceId);
    if (!existing) throw new VpnError('not_found');
    if (!existing.url) throw new VpnError('subscription_fetch', { message: '该线路来源没有订阅链接，无法刷新' });
    const { text, usage } = await fetchSubscriptionText(existing.url);
    const parsed = parseImportPayload(text, { sourceId, sourceLabel: existing.name });
    if (parsed.kind !== 'nodes' || !parsed.nodes.length) throw new VpnError('parse_failed');
    const subscription = {
      ...existing,
      updatedAt: Date.now(),
      nodeCount: parsed.nodes.length,
      usage: usage ?? existing.usage ?? null,
      lastError: '',
    };
    await store.upsertSource({ subscription, nodes: parsed.nodes });
    await afterChange();
    return { subscription: sanitizeSubscriptionView(subscription), nodeCount: parsed.nodes.length, ...importDiagnostics(parsed) };
  }

  async function removeSubscription({ id } = {}) {
    const sourceId = asText(id, 80);
    if (!sourceId) throw new VpnError('request');
    await store.removeSource(sourceId);
    await afterChange();
    return { removed: sourceId };
  }

  async function importClipboard({ text } = {}) {
    const raw = typeof text === 'string' && text.trim()
      ? text
      : String(clipboard?.readText?.() ?? '');
    if (!raw.trim()) throw new VpnError('empty_input');
    const parsed = parseImportPayload(raw, { sourceId: 'clipboard', sourceLabel: '剪贴板线路' });
    if (parsed.kind === 'subscription-url') {
      const result = await importSubscription({ url: parsed.url });
      return { kind: 'subscription', ...result };
    }
    const subscription = {
      id: 'clipboard',
      kind: 'clipboard',
      name: '剪贴板线路',
      url: '',
      updatedAt: Date.now(),
      nodeCount: parsed.nodes.length,
      usage: null,
      lastError: '',
    };
    await store.upsertSource({ subscription, nodes: parsed.nodes });
    await afterChange();
    return {
      kind: 'nodes',
      subscription: sanitizeSubscriptionView(subscription),
      nodesAdded: parsed.nodes.length,
      ...importDiagnostics(parsed),
    };
  }

  async function savePool(input = {}) {
    const routes = await store.readRoutes();
    const pools = routes.pools.map(pool => ({ ...pool }));
    const id = asText(input?.id, 80) || `pool_${randomUUID().slice(0, 8)}`;
    const nodeIds = Array.isArray(input?.nodeIds)
      ? [...new Set(input.nodeIds.map(item => asText(item, 80)).filter(Boolean))].slice(0, 500)
      : [];
    if (!nodeIds.length) throw new VpnError('node_unavailable', { message: '策略池至少要选择一个节点' });
    const pool = {
      id,
      name: asText(input?.name, 80) || '自动线路池',
      strategy: ['url-test', 'fallback', 'select'].includes(input?.strategy) ? input.strategy : 'url-test',
      tagFilter: Array.isArray(input?.tagFilter)
        ? [...new Set(input.tagFilter.map(item => asText(item, 24).toLowerCase()).filter(Boolean))].slice(0, 12)
        : [],
      nodeIds,
      selectedNodeId: asText(input?.selectedNodeId, 80),
      testUrl: /^https?:\/\//i.test(asText(input?.testUrl, 512)) ? asText(input.testUrl, 512) : DEFAULT_TEST_URL,
      intervalSec: input?.intervalSec,
      toleranceMs: input?.toleranceMs,
    };
    const index = pools.findIndex(item => item.id === id);
    if (index >= 0) pools[index] = { ...pools[index], ...pool };
    else pools.push(pool);
    await store.updateRoutes({ pools });
    await afterChange();
    return {
      pool: { ...pool, port: runtime.ports[`pool:${id}`] ?? 0 },
      pools: (await store.readRoutes()).pools,
    };
  }

  /** 删除策略池：指向它的路由/覆盖一律回落直连，避免留下悬空引用。 */
  async function deletePool({ id } = {}) {
    const poolId = asText(id, 80);
    if (!poolId) throw new VpnError('request');
    const routes = await store.readRoutes();
    if (!routes.pools.some(pool => pool.id === poolId)) throw new VpnError('not_found');
    const pointsToPool = target => target?.mode === 'pool' && target.poolId === poolId;
    const nextRoutes = {};
    for (const [providerId, target] of Object.entries(routes.routes)) {
      nextRoutes[providerId] = pointsToPool(target) ? { mode: 'direct', failover: target.failover !== false } : target;
    }
    const nextOverrides = {};
    for (const [key, target] of Object.entries(routes.modelOverrides)) {
      nextOverrides[key] = pointsToPool(target) ? { mode: 'direct', failover: target.failover !== false } : target;
    }
    await store.updateRoutes({
      pools: routes.pools.filter(pool => pool.id !== poolId),
      routes: nextRoutes,
      modelOverrides: nextOverrides,
    });
    await afterChange();
    return { removed: poolId, ...(await readRoutes()) };
  }

  async function selectPoolNode({ poolId, nodeId } = {}) {
    const id = asText(poolId, 80);
    const node = asText(nodeId, 80);
    if (!id) throw new VpnError('request');
    const routes = await store.readRoutes();
    const pool = routes.pools.find(item => item.id === id);
    if (!pool) throw new VpnError('not_found');
    if (node && !pool.nodeIds.includes(node)) throw new VpnError('node_unavailable');
    // 池内首选节点改为排在最前，下次 reload 后 Mihomo 的 fallback/url-test 就从它开始。
    await store.updateRoutes({
      pools: routes.pools.map(item => (item.id === id ? { ...item, selectedNodeId: node } : item)),
    });
    await afterChange();
    return { poolId: id, nodeId: node, port: runtime.ports[`pool:${id}`] ?? 0 };
  }

  async function readRoutes() {
    const routes = await store.readRoutes();
    return { routes: routes.routes, modelOverrides: routes.modelOverrides, core: routes.core, pools: routes.pools };
  }

  /**
   * 合并一份路由映射：`null` 明确表示「删掉这条」。
   * 为什么需要删除语义：单模型覆盖的「继承 Provider」不是一个指向，而是**没有这个键**。
   */
  function mergeRouteMap(current, patch) {
    const out = { ...(current && typeof current === 'object' ? current : {}) };
    for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
      if (value === null) delete out[key];
      else out[key] = value;
    }
    return out;
  }

  async function setRoutes(patch = {}) {
    // 合并语义（不是整表替换）：渲染层每次只改一行，整表替换会让并发打开的
    // 两个设置页互相清掉对方的分配；清掉一条分配用显式的 `{ mode: 'direct' }`，
    // 清掉一条单模型覆盖用 `null`（= 继承 Provider）。
    const current = await store.readRoutes();
    const next = {};
    if (patch?.routes && typeof patch.routes === 'object') next.routes = mergeRouteMap(current.routes, patch.routes);
    if (patch?.modelOverrides && typeof patch.modelOverrides === 'object') {
      next.modelOverrides = mergeRouteMap(current.modelOverrides, patch.modelOverrides);
    }
    if (patch?.core && typeof patch.core === 'object') next.core = { ...current.core, ...patch.core };
    if (!Object.keys(next).length) throw new VpnError('request');
    await store.updateRoutes(next);
    await afterChange();
    return readRoutes();
  }

  async function probeModel({ providerId, modelId } = {}) {
    const provider = asText(providerId, 120);
    if (!provider) throw new VpnError('request');
    await runtime.refresh().catch(() => {});
    const route = runtime.routeFor(provider, asText(modelId, 120));
    // 只报「这条线路是谁」：策略池报池名，固定节点报节点名。真实出口地区/RTT 未实现。
    const pools = (await store.readRoutes()).pools;
    const nodeName = route.targetKey.startsWith('pool:')
      ? (pools.find(pool => `pool:${pool.id}` === route.targetKey)?.name ?? route.targetKey)
      : (route.targetKey.startsWith('node:') ? route.targetKey.slice(5) : '');
    return {
      viaProxy: Boolean(route.proxyUrl),
      mode: route.mode,
      source: route.source,
      targetKey: route.targetKey,
      port: route.port,
      nodeName,
      degraded: route.degraded,
      reason: route.reason,
      latencyMs: null,
      // 真实出口探测需要真实网络与内核 Controller，本版本不做（见报告「未实现」）。
      implemented: false,
      detail: route.proxyUrl
        ? '已解析到本地线路端口；真实出口地区与 RTT 检测本版本未实现'
        : '该模型当前直连（未分配线路或线路暂不可用）',
    };
  }

  async function testDelays() {
    const kernel = manager.status();
    if (kernel.state !== 'running') throw new VpnError('core_missing', { message: '内核未运行，无法测速' });
    // 真测速：走 Mihomo Controller 的 `/proxies/<name>/delay`，逐节点打一次并回填延迟，
    // 让后续「换节点择优」直接受益（不再按声明顺序瞎选）。
    const result = await runtime.testNodes();
    emit({ kind: 'delays', total: result.total ?? 0, working: result.working ?? 0 });
    return result;
  }

  async function coreAction({ action } = {}) {
    const name = asText(action, 16);
    if (!['start', 'stop', 'restart', 'sync'].includes(name)) throw new VpnError('request');
    let result;
    if (name === 'start') result = await runtime.startCore();
    else if (name === 'stop') result = await runtime.stopCore();
    else if (name === 'restart') result = await runtime.restartCore();
    else result = await runtime.syncCore();
    const core = manager.status();
    emit({ kind: 'status', core, action: name });
    // 内核没装/起不来必须走错误通道：否则渲染层会把 `ok:true` 当成功、弹一句「已启动」。
    if (result && result.ok === false) {
      throw new VpnError(result.error || 'core_start_failed', {
        message: result.message,
        detail: result.detail,
      });
    }
    return { action: name, result, core };
  }

  async function pickCorePath() {
    if (!dialog?.showOpenDialog) throw new VpnError('request', { message: '当前环境没有文件选择框' });
    const outcome = await dialog.showOpenDialog(getWin() ?? undefined, {
      title: '选择 mihomo 内核可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '可执行文件', extensions: ['exe'] }] : [],
    });
    if (outcome?.canceled || !outcome?.filePaths?.length) return null;
    const picked = asText(outcome.filePaths[0], 4096);
    const routes = await store.readRoutes();
    await store.updateRoutes({ core: { ...routes.core, binaryPath: picked } });
    await syncConfiguredBinaryPath();
    const kernel = await manager.probeKernel();
    emit({ kind: 'status', core: manager.status() });
    return { binaryPath: picked, kernel };
  }

  handle(CHANNELS.status, async () => {
    await manager.probeKernel().catch(() => null);
    return runtime.status();
  });

  // 线路健康检查：手动跑一轮（设置页「立即检查」）。内核没跑时返回 `skipped`，不制造假结果。
  handle(CHANNELS.healthCheck, async () => {
    const result = await runtime.runHealthCycleNow();
    emit({ kind: 'health', cycle: result });
    return { ...result, health: runtime.healthSnapshot() };
  });

  // 「允许跨地区切换」开关：默认关。关着时同地区没有备选就**不切换**（账号风控优先）。
  handle(CHANNELS.healthSettings, async input => {
    if (input && typeof input === 'object' && Object.hasOwn(input, 'allowCrossRegion')) {
      const allow = runtime.setAllowCrossRegion(input.allowCrossRegion === true);
      await store.updateRoutes({ core: { allowCrossRegion: allow } }).catch(() => {});
    }
    return { allowCrossRegion: runtime.healthSnapshot().allowCrossRegion, health: runtime.healthSnapshot() };
  });

  handle(CHANNELS.importClipboard, input => importClipboard(input));
  handle(CHANNELS.importSubscription, input => importSubscription(input));
  handle(CHANNELS.refreshSubscription, input => refreshSubscription(input));
  handle(CHANNELS.removeSubscription, input => removeSubscription(input));
  handle(CHANNELS.scanFxy, async () => scanFxyProfiles({ appDataDir: process.env.APPDATA }));
  handle(CHANNELS.importFxy, async ({ profileId } = {}) => {
    const loaded = await loadFxyImport({ profileId: asText(profileId, 200), appDataDir: process.env.APPDATA });
    let nodesAdded = 0;
    for (const item of loaded) {
      await store.upsertSource(item);
      nodesAdded += item.nodes.length;
    }
    await afterChange();
    return {
      sources: loaded.map(item => sanitizeSubscriptionView(item.subscription)),
      nodesAdded,
    };
  });
  handle(CHANNELS.testDelays, () => testDelays());
  handle(CHANNELS.poolSave, input => savePool(input));
  handle(CHANNELS.poolDelete, input => deletePool(input));
  handle(CHANNELS.poolSelectNode, input => selectPoolNode(input));
  handle(CHANNELS.routesGet, () => readRoutes());
  handle(CHANNELS.routesSet, input => setRoutes(input));
  handle(CHANNELS.probeModel, input => probeModel(input));
  handle(CHANNELS.coreAction, input => coreAction(input));
  handle(CHANNELS.pickCorePath, () => pickCorePath());
  handle(CHANNELS.downloadCore, () => {
    // 明确的「不做」：构建与测试环境无网络，自动下载只会变成静默卡住。
    throw new VpnError('core_download_failed', {
      message: '本版本不包含内核自动下载（离线构建）。请手动放置 mihomo.exe，或用「选择内核」指向本机已有的可执行文件',
    });
  });

  // 启动时预热一次：设置页首屏读 status 时端口表已经算好，热路径也才有数据。
  void syncConfiguredBinaryPath()
    .then(() => runtime.refresh())
    .then(() => manager.probeKernel())
    .catch(error => {
      logger?.warn?.('vpn-warmup-failed', { code: error?.code || 'unknown' });
    });

  return {
    runtime,
    store,
    manager,
    channels: [...channels],
    /** 退出时务必调用：内核是子进程，不回收会留下占着端口的孤儿。 */
    async dispose() {
      for (const channel of channels) {
        try { ipcMain?.removeHandler?.(channel); } catch { /* 已移除 */ }
      }
      channels.clear();
      await runtime.dispose();
      setVpnRuntime(null);
    },
  };
}
