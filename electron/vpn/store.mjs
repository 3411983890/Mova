/**
 * VPN 线路凭据与路由配置持久化存储。
 *
 * 负责：
 * 1. `vpn-profiles.enc`：使用 Electron safeStorage 加密保存订阅链接与节点完整凭据；
 *    加密不可用时拒绝写入，绝不退化成明文。
 * 2. `model-vpn-routes.json`：明文保存内核配置、自动策略池、Provider 与单模型线路分配。
 * 不负责：解析、测速或启停 Mihomo 子进程。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CORE_MODES,
  DEFAULT_TEST_URL,
  POOL_STRATEGIES,
  VpnError,
  createDefaultRoutesConfig,
  normalizeRouteTarget,
  sanitizeNodeView,
  sanitizeSubscriptionView,
} from './contract.mjs';

const PROFILES_FILE = 'vpn-profiles.enc';
const ROUTES_FILE = 'model-vpn-routes.json';

function emptyVault() {
  return { version: 1, subscriptions: [], nodes: [] };
}

function coerceVault(raw) {
  if (!raw || typeof raw !== 'object') return emptyVault();
  const subscriptions = Array.isArray(raw.subscriptions)
    ? raw.subscriptions.filter(item => item && typeof item === 'object' && typeof item.id === 'string')
    : [];
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.raw)
    : [];
  return { version: 1, subscriptions, nodes };
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function normalizePool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : `pool_${randomUUID().slice(0, 8)}`;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : '自动线路池';
  const strategy = POOL_STRATEGIES.includes(raw.strategy) ? raw.strategy : 'url-test';
  const tagFilter = Array.isArray(raw.tagFilter)
    ? [...new Set(raw.tagFilter.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  const nodeIds = Array.isArray(raw.nodeIds)
    ? [...new Set(raw.nodeIds.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 500)
    : [];
  return {
    id,
    name,
    strategy,
    tagFilter,
    nodeIds,
    selectedNodeId: typeof raw.selectedNodeId === 'string' ? raw.selectedNodeId.trim() : '',
    testUrl: typeof raw.testUrl === 'string' && /^https?:\/\//i.test(raw.testUrl.trim())
      ? raw.testUrl.trim() : DEFAULT_TEST_URL,
    intervalSec: clampInt(raw.intervalSec, 300, 30, 3600),
    toleranceMs: clampInt(raw.toleranceMs, 150, 10, 2000),
  };
}

export function coerceRoutesConfig(raw) {
  const base = createDefaultRoutesConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const coreIn = raw.core && typeof raw.core === 'object' ? raw.core : {};
  const core = {
    mode: CORE_MODES.includes(coreIn.mode) ? coreIn.mode : base.core.mode,
    binaryPath: typeof coreIn.binaryPath === 'string' ? coreIn.binaryPath.trim().slice(0, 4096) : '',
    fallbackProxyUrl: typeof coreIn.fallbackProxyUrl === 'string' && /^https?:\/\//i.test(coreIn.fallbackProxyUrl.trim())
      ? coreIn.fallbackProxyUrl.trim().slice(0, 256)
      : base.core.fallbackProxyUrl,
    controllerPort: clampInt(coreIn.controllerPort, base.core.controllerPort, 1024, 65000),
    baseListenerPort: clampInt(coreIn.baseListenerPort, base.core.baseListenerPort, 1024, 65000),
    testUrl: typeof coreIn.testUrl === 'string' && /^https?:\/\//i.test(coreIn.testUrl.trim())
      ? coreIn.testUrl.trim().slice(0, 512)
      : base.core.testUrl,
    autoStart: coreIn.autoStart !== false,
  };

  const pools = [];
  const seenPools = new Set();
  for (const item of Array.isArray(raw.pools) ? raw.pools : []) {
    const normalized = normalizePool(item);
    if (!normalized || seenPools.has(normalized.id)) continue;
    seenPools.add(normalized.id);
    pools.push(normalized);
  }

  const routes = {};
  if (raw.routes && typeof raw.routes === 'object' && !Array.isArray(raw.routes)) {
    for (const [providerId, target] of Object.entries(raw.routes)) {
      if (typeof providerId !== 'string' || !providerId.trim()) continue;
      routes[providerId.trim().slice(0, 120)] = normalizeRouteTarget(target);
    }
  }

  const modelOverrides = {};
  if (raw.modelOverrides && typeof raw.modelOverrides === 'object' && !Array.isArray(raw.modelOverrides)) {
    for (const [key, target] of Object.entries(raw.modelOverrides)) {
      if (typeof key !== 'string' || !key.includes('/')) continue;
      modelOverrides[key.trim().slice(0, 200)] = normalizeRouteTarget(target);
    }
  }

  return { version: 1, core, pools, routes, modelOverrides };
}

/** 创建 VPN 配置与加密节点存储实例。 */
export function createVpnStore({
  dir,
  isEncryptionAvailable,
  encrypt,
  decrypt,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  mkdirImpl = mkdir,
  rmImpl = rm,
} = {}) {
  const vaultPath = join(dir, PROFILES_FILE);
  const routesPath = join(dir, ROUTES_FILE);
  let vaultCache = null;
  let routesCache = null;
  let writeChain = Promise.resolve();

  function enqueue(work) {
    const run = writeChain.then(work, work);
    writeChain = run.catch(() => {});
    return run;
  }

  async function writeAtomic(targetPath, payload) {
    const temp = `${targetPath}.${randomUUID()}.tmp`;
    await mkdirImpl(dirname(targetPath), { recursive: true });
    try {
      await writeFileImpl(temp, payload, { flag: 'wx', mode: 0o600 });
      await renameImpl(temp, targetPath);
    } catch (error) {
      await rmImpl(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function ensureWritableCrypto() {
    let available = false;
    try {
      const pending = isEncryptionAvailable?.();
      available = (pending && typeof pending.then === 'function' ? await pending : pending) === true;
    } catch {
      available = false;
    }
    if (!available || typeof encrypt !== 'function' || typeof decrypt !== 'function') {
      throw new VpnError('credential');
    }
  }

  async function readVault() {
    if (vaultCache) return vaultCache;
    let encrypted;
    try {
      encrypted = await readFileImpl(vaultPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        vaultCache = emptyVault();
        return vaultCache;
      }
      throw new VpnError('credential', { detail: error?.message || 'read' });
    }
    try {
      const decrypted = await decrypt(encrypted);
      const text = typeof decrypted === 'string'
        ? decrypted
        : (typeof decrypted?.result === 'string' ? decrypted.result : '');
      const parsed = JSON.parse(text);
      vaultCache = coerceVault(parsed);
      return vaultCache;
    } catch (error) {
      throw new VpnError('credential', { detail: error?.message || 'decrypt' });
    }
  }

  async function writeVault(nextVault) {
    await ensureWritableCrypto();
    const coerced = coerceVault(nextVault);
    const json = JSON.stringify(coerced);
    const encrypted = await encrypt(json);
    await writeAtomic(vaultPath, encrypted);
    vaultCache = coerced;
    return coerced;
  }

  async function modifyVault(mutator) {
    return enqueue(async () => {
      const current = await readVault();
      const draft = {
        version: 1,
        subscriptions: current.subscriptions.map(item => ({ ...item })),
        nodes: current.nodes.map(item => ({ ...item, raw: { ...item.raw } })),
      };
      const updated = await mutator(draft);
      return writeVault(updated || draft);
    });
  }

  /** 新增或更新一个订阅源及其名下节点（不重复保留同一 sourceId 的旧节点）。 */
  async function upsertSource({ subscription, nodes }) {
    return modifyVault(draft => {
      const nextSub = { ...subscription, nodeCount: Array.isArray(nodes) ? nodes.length : 0 };
      draft.subscriptions = draft.subscriptions.filter(s => s.id !== nextSub.id);
      draft.subscriptions.unshift(nextSub);
      draft.nodes = draft.nodes.filter(n => n.sourceId !== nextSub.id);
      // 给全局跨源节点做一次名称防重，避免 Mihomo 把两个源里的同名节点判冲突
      const existingNames = new Set(draft.nodes.map(n => n.name));
      for (const node of Array.isArray(nodes) ? nodes : []) {
        let finalName = node.name;
        let idx = 2;
        while (existingNames.has(finalName)) finalName = `${node.name} (${idx++})`;
        existingNames.add(finalName);
        draft.nodes.push({
          ...node,
          name: finalName,
          sourceId: nextSub.id,
          sourceLabel: nextSub.name,
          raw: { ...node.raw, name: finalName },
        });
      }
      return draft;
    });
  }

  async function removeSource(sourceId) {
    return modifyVault(draft => {
      const before = draft.subscriptions.length;
      draft.subscriptions = draft.subscriptions.filter(s => s.id !== sourceId);
      draft.nodes = draft.nodes.filter(n => n.sourceId !== sourceId);
      if (draft.subscriptions.length === before) throw new VpnError('not_found');
      return draft;
    });
  }

  async function readRoutes() {
    if (routesCache) return routesCache;
    try {
      const text = await readFileImpl(routesPath, 'utf8');
      routesCache = coerceRoutesConfig(JSON.parse(text));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        routesCache = createDefaultRoutesConfig();
      } else {
        routesCache = createDefaultRoutesConfig();
      }
    }
    return routesCache;
  }

  async function updateRoutes(mutatorOrPatch) {
    return enqueue(async () => {
      const current = await readRoutes();
      const draft = typeof mutatorOrPatch === 'function'
        ? await mutatorOrPatch(structuredClone(current))
        : { ...current, ...mutatorOrPatch };
      const coerced = coerceRoutesConfig(draft);
      await writeAtomic(routesPath, `${JSON.stringify(coerced, null, 2)}\n`);
      routesCache = coerced;
      return coerced;
    });
  }

  async function getSanitizedState(runtime = {}) {
    let vault = emptyVault();
    let cryptoOk = true;
    try {
      vault = await readVault();
    } catch {
      cryptoOk = false;
    }
    const routes = await readRoutes();
    return {
      cryptoOk,
      subscriptions: vault.subscriptions.map(sanitizeSubscriptionView),
      nodes: vault.nodes.map(node => sanitizeNodeView(node, runtime)),
      routes,
    };
  }

  return {
    readVault,
    modifyVault,
    upsertSource,
    removeSource,
    readRoutes,
    updateRoutes,
    getSanitizedState,
  };
}
