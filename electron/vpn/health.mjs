/**
 * 负责：Mihomo Controller 的**零依赖**客户端、单池健康检查（多目标/多数通过语义）、
 *   「同地区优先」的备选节点选择、一轮巡检 `runHealthCycle`、节点失败计数与冷却、
 *   以及 300s 周期巡检的可停可清定时器 `createHealthLoop`。
 * 不负责：起停内核（`mihomo-manager.mjs`）、装配运行时（`runtime.mjs` 调用本模块）、
 *   把事件推给渲染层（`ipc.mjs` 的 `emit`，本模块只通过注入的 `onEvent` 回调抛出）、
 *   判断「该不该切账号」（那是订阅额度链路，与线路正交）。
 * 被谁调用：`runtime.mjs`（周期巡检 + 预检）、`runtime-config.mjs`（`resolveHealthCheck` 写 `mova-meta`）、
 *   `tests/vpn-health.test.mjs` / `vpn-preflight.test.mjs` / `vpn-health-loop.test.mjs`。
 *
 * 纯逻辑模块：不 import electron；`fetch` 一律由调用方注入（测试里绝不发真实网络请求）。
 *
 * ── 三条来自真实实测的硬约束（不要「优化」掉）────────────────────────────
 * 1. **不能拿单一目标判死**。本机实测：两条完全健康的美国 anytls 节点
 *    `gstatic.com/generate_204` 全失败，而 `google.com/generate_204`、`chatgpt.com` 都是 200。
 *    单目标判定会把它们打成坏节点 → 触发不必要的切换 → 正是用户最怕的跨地区风控。
 *    因此 `checkPoolHealth` 用**目标列表 + 任一成功即健康**，失败的记进 `failedTargets` 供诊断。
 * 2. **连续失败 3 次才切**。一次抖动（同一出口短时间内重复请求会被限流）不该换线路。
 * 3. **同地区没有备选时默认不切**（`allowCrossRegion:false`），只记一条事件，不刷屏告警。
 *
 * 另外：3 条 hysteria2 是 IPv6-only 端点，本机到境外 TCP/QUIC 不通，必然持续失败。
 * 连续失败 5 次后进入 30 分钟长冷却（`HEALTH_LONG_COOLDOWN_MS`），避免每 5 分钟重复失败刷日志。
 */
import { normalizeCode, regionOfNode, sameRegion } from './region.mjs';

/** 巡检周期：用户要求「5min 一次」。 */
export const HEALTH_INTERVAL_MS = 300_000;
/** 单池一次探测的总预算（多个目标共享这段时间）。 */
export const HEALTH_TIMEOUT_MS = 5_000;
/** 单个目标最多等多久：3s 就够判死一个目标，避免一个目标吃掉整轮预算。 */
export const HEALTH_PER_TARGET_MS = 3_000;
/** 连续失败多少次才允许切换线路。 */
export const HEALTH_FAILURE_THRESHOLD = 3;
/** 进入坏节点名单后的冷却时长（期间不会被选中）。 */
export const HEALTH_NODE_COOLDOWN_MS = 300_000;
/** 连续失败到这个次数 → 长冷却（IPv6-only 这类必然失败的节点不再每轮去试）。 */
export const HEALTH_LONG_COOLDOWN_THRESHOLD = 5;
export const HEALTH_LONG_COOLDOWN_MS = 30 * 60_000;

/** ChatGPT 渠道的首选探测目标：顺带能读出出口 IP / loc。 */
export const CHATGPT_PROBE_TARGET = 'https://chatgpt.com/cdn-cgi/trace';
/** 通用首选目标：实测 google 204 比 gstatic 204 稳定得多（见文件头）。 */
export const GENERIC_PROBE_TARGET = 'https://www.google.com/generate_204';

/** 池 → 渠道（只影响探测目标的**顺序**，不改变判定语义）。 */
export function channelOfPool(pool = {}) {
  const text = [pool?.channel, pool?.id, pool?.name, ...(Array.isArray(pool?.tagFilter) ? pool.tagFilter : [])]
    .filter(item => typeof item === 'string' && item)
    .join(' ')
    .toLowerCase();
  if (/chatgpt|openai|gpt[_\-\s]|\bgpt\b/.test(text)) return 'chatgpt';
  if (typeof pool?.testUrl === 'string' && /chatgpt\.com/i.test(pool.testUrl)) return 'chatgpt';
  if (/gemini|google|bard/.test(text)) return 'gemini';
  return 'generic';
}

function httpUrlOrEmpty(value) {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim()) ? value.trim() : '';
}

/**
 * 池的健康检查规格（运行态配置的 `mova-meta.pools[].healthCheck` 也来自这里，不许两处实现）。
 *
 * @param {object} [pool] 已归一化的策略池
 * @returns {{ channel: string, targets: string[], url: string, intervalMs: number, timeoutMs: number,
 *   perTargetMs: number, perNodeMs: number }}
 *   `perNodeMs` 是早期契约里的同义字段（值恒等于 `perTargetMs`），保留只为不打断已发出的接线。
 */
export function resolveHealthCheck(pool = {}) {
  const channel = channelOfPool(pool);
  const primary = channel === 'chatgpt' ? CHATGPT_PROBE_TARGET : GENERIC_PROBE_TARGET;
  const secondary = channel === 'chatgpt' ? GENERIC_PROBE_TARGET : CHATGPT_PROBE_TARGET;
  const explicit = [
    httpUrlOrEmpty(pool?.healthUrl),
    ...(Array.isArray(pool?.healthTargets) ? pool.healthTargets.map(httpUrlOrEmpty) : []),
  ].filter(Boolean);
  const targets = [...new Set([...explicit, primary, secondary])];
  return {
    channel,
    targets,
    url: targets[0],
    intervalMs: HEALTH_INTERVAL_MS,
    timeoutMs: HEALTH_TIMEOUT_MS,
    perTargetMs: HEALTH_PER_TARGET_MS,
    perNodeMs: HEALTH_PER_TARGET_MS,
  };
}

function failed(code, extra = {}) {
  return { ok: false, code, ...extra };
}

/**
 * 取时间戳：`now` 既可能是函数（`Date.now`），也可能已经被调用方求值成数字。
 *
 * 为什么两种都收：这几个状态辅助函数的调用方有的传 `now`、有的传 `now()`，
 * 一旦只认函数，`now()` 就会抛 `now is not a function`（真踩过）；
 * 只认数字，又会让注入假时钟的调用方全部失效。这里统一收口，两边都不炸。
 */
function timeOf(now) {
  const value = typeof now === 'function' ? now() : now;
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * Mihomo Controller 客户端（零依赖，**永不抛**）。
 *
 * @param {{ port: number, secret?: string, fetch?: Function, timeoutMs?: number }} options
 * @returns {{
 *   ok: boolean, baseUrl: string,
 *   proxies: () => Promise<object>, groupNow: (name: string) => Promise<object>,
 *   delay: (name: string, url: string, timeoutMs?: number) => Promise<object>,
 *   select: (group: string, node: string) => Promise<object>
 * }}
 */
export function createControllerClient({
  port,
  secret = '',
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const portNumber = Math.floor(Number(port));
  const ready = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const baseUrl = ready ? `http://127.0.0.1:${portNumber}` : '';
  const headers = { accept: 'application/json' };
  if (typeof secret === 'string' && secret) headers.authorization = `Bearer ${secret}`;

  async function request(path, { method = 'GET', body = null, budgetMs = timeoutMs } = {}) {
    if (!ready) return failed('controller_unavailable');
    if (typeof fetchImpl !== 'function') return failed('controller_unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(Number(budgetMs) || timeoutMs)));
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const status = Number(response?.status) || 0;
      let payload = null;
      try {
        payload = typeof response?.json === 'function' ? await response.json() : null;
      } catch {
        payload = null;
      }
      if (!response?.ok) return failed('controller_http_error', { status, payload });
      if (payload === null) return failed('controller_bad_json', { status });
      return { ok: true, status, payload };
    } catch (error) {
      if (error?.name === 'AbortError') return failed('controller_timeout');
      return failed('controller_unreachable', { detail: String(error?.message || error).slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
  }

  const nameOf = value => (typeof value === 'string' && value.trim() ? encodeURIComponent(value.trim()) : '');

  return {
    ok: ready,
    baseUrl,
    /** `GET /proxies`：全量代理与组（诊断用）。 */
    async proxies() {
      const result = await request('/proxies');
      if (!result.ok) return result;
      return { ok: true, proxies: result.payload?.proxies ?? {} };
    },
    /** `GET /proxies/<group>`：`name` 是当前生效节点（Mihomo 的 `now` 字段）。 */
    async groupNow(groupName) {
      const encoded = nameOf(groupName);
      if (!encoded) return failed('invalid_name');
      const result = await request(`/proxies/${encoded}`);
      if (!result.ok) return result;
      return {
        ok: true,
        name: typeof result.payload?.now === 'string' ? result.payload.now : '',
        type: typeof result.payload?.type === 'string' ? result.payload.type : '',
        all: Array.isArray(result.payload?.all) ? result.payload.all : [],
      };
    },
    /** `GET /proxies/<node>/delay?url=…&timeout=…`。 */
    async delay(nodeName, url, budgetMs = HEALTH_PER_TARGET_MS) {
      const encoded = nameOf(nodeName);
      if (!encoded) return failed('invalid_name');
      const target = httpUrlOrEmpty(url);
      if (!target) return failed('invalid_target');
      const wait = Math.max(1, Math.floor(Number(budgetMs) || HEALTH_PER_TARGET_MS));
      const result = await request(
        `/proxies/${encoded}/delay?url=${encodeURIComponent(target)}&timeout=${wait}`,
        { budgetMs: wait + 500 },
      );
      if (!result.ok) return result;
      const delayMs = Number(result.payload?.delay);
      if (!Number.isFinite(delayMs) || delayMs <= 0) return failed('delay_invalid', { delayMs: null });
      return { ok: true, delayMs };
    },
    /** `PUT /proxies/<group>`：把组切到指定节点。 */
    async select(groupName, nodeName) {
      const encoded = nameOf(groupName);
      const target = typeof nodeName === 'string' ? nodeName.trim() : '';
      if (!encoded || !target) return failed('invalid_name');
      const result = await request(`/proxies/${encoded}`, { method: 'PUT', body: { name: target } });
      if (!result.ok) return result;
      return { ok: true, selected: target };
    },
  };
}

/**
 * 单池健康检查：先读当前生效节点，再对**该节点**逐个目标测延迟。
 *
 * 判定：任一目标成功（2xx 且 `delay > 0`）即健康；全部失败才不健康。
 * 这是本模块最容易被改坏的地方——见文件头第 1 条。
 *
 * @param {{ client: object, pool: object, health?: object, groupName?: string, now?: Function }} input
 * @returns {Promise<{ ok: boolean, activeNode: string, delayMs: number|null, checkedAt: number,
 *   failedTargets: { url: string, code: string }[], target: string, region: object|null, reason: string }>}
 */
export async function checkPoolHealth({ client, pool = {}, health = null, groupName = '', now = Date.now } = {}) {
  const clock = () => Math.max(0, Math.floor(Number(now()) || 0));
  const spec = health && typeof health === 'object' ? health : resolveHealthCheck(pool);
  const group = String(groupName || pool?.group || `mova-pool:${pool?.id ?? ''}`);
  const base = { activeNode: '', delayMs: null, checkedAt: clock(), failedTargets: [], target: '', region: null };
  if (!client || typeof client.groupNow !== 'function') return { ...base, ok: false, reason: 'controller_unavailable' };

  const active = await client.groupNow(group);
  if (!active?.ok) return { ...base, ok: false, reason: active?.code || 'controller_unreachable' };
  const node = String(active.name || '');
  if (!node) return { ...base, ok: false, reason: 'no_active_node' };

  const budget = Math.max(1, Math.floor(Number(spec.timeoutMs) || HEALTH_TIMEOUT_MS));
  const perTarget = Math.max(1, Math.floor(Number(spec.perTargetMs) || HEALTH_PER_TARGET_MS));
  const targets = (Array.isArray(spec.targets) ? spec.targets : []).map(httpUrlOrEmpty).filter(Boolean);
  const startedAt = clock();
  const failedTargets = [];
  let delayMs = null;
  let usedTarget = '';

  for (const target of targets) {
    const remaining = budget - Math.max(0, clock() - startedAt);
    if (remaining <= 0) {
      failedTargets.push({ url: target, code: 'budget_exhausted' });
      continue;
    }
    const probe = await client.delay(node, target, Math.min(perTarget, remaining));
    const value = Number(probe?.delayMs);
    if (probe?.ok && Number.isFinite(value) && value > 0) {
      delayMs = value;
      usedTarget = target;
      break;
    }
    failedTargets.push({ url: target, code: probe?.code || 'delay_failed' });
  }

  const ok = delayMs !== null;
  return {
    ...base,
    ok,
    activeNode: node,
    delayMs,
    checkedAt: clock(),
    failedTargets,
    target: usedTarget,
    reason: ok ? '' : (failedTargets[0]?.code || 'delay_failed'),
  };
}

/** 巡检状态（进程内，不落盘）：失败计数、坏节点冷却、最近成功/延迟、每池切换记录。 */
export function createHealthState() {
  return {
    failures: new Map(),
    badNodes: new Map(),
    lastGoodAt: new Map(),
    lastDelayMs: new Map(),
    checkedAt: new Map(),
    activeNodes: new Map(),
    switches: new Map(),
    notes: new Map(),
  };
}

/** 某节点连续失败次数。 */
export function nodeFailureCount(state, nodeName) {
  return Math.max(0, Number(state?.failures?.get(nodeName)) || 0);
}

/** 节点是否在冷却期（冷却到期会自动解除并给一次机会）。 */
export function isNodeCooling(state, nodeName, { now = Date.now } = {}) {
  const record = state?.badNodes?.get(nodeName);
  if (!record) return false;
  const at = timeOf(now);
  if (record.until && at >= record.until) {
    state.badNodes.delete(nodeName);
    // 冷却结束：计数也从零开始，否则下一次失败会立刻又进坏节点名单。
    state.failures.delete(nodeName);
    return false;
  }
  return true;
}

/**
 * 记一次失败；达到阈值进入坏节点名单（3 次 → 5 分钟，5 次 → 30 分钟）。
 * @returns {{ failures: number, cooling: boolean, until: number }}
 */
export function noteNodeFailure(state, nodeName, { now = Date.now } = {}) {
  const name = typeof nodeName === 'string' ? nodeName.trim() : '';
  if (!state || !name) return { failures: 0, cooling: false, until: 0 };
  const at = timeOf(now);
  const failures = nodeFailureCount(state, name) + 1;
  state.failures.set(name, failures);
  if (failures >= HEALTH_LONG_COOLDOWN_THRESHOLD) {
    const until = at + HEALTH_LONG_COOLDOWN_MS;
    state.badNodes.set(name, { since: at, until, failures, long: true });
    return { failures, cooling: true, until };
  }
  if (failures >= HEALTH_FAILURE_THRESHOLD) {
    const until = at + HEALTH_NODE_COOLDOWN_MS;
    state.badNodes.set(name, { since: at, until, failures, long: false });
    return { failures, cooling: true, until };
  }
  return { failures, cooling: false, until: 0 };
}

/** 记一次成功：清掉失败计数与坏节点标记。 */
export function noteNodeSuccess(state, nodeName, { delayMs = null, now = Date.now } = {}) {
  const name = typeof nodeName === 'string' ? nodeName.trim() : '';
  if (!state || !name) return;
  state.failures.delete(name);
  state.badNodes.delete(name);
  state.lastGoodAt.set(name, timeOf(now));
  const value = Number(delayMs);
  if (Number.isFinite(value) && value > 0) state.lastDelayMs.set(name, value);
}

function delayRank(member) {
  const value = Number(member?.delayMs);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function lastGoodRank(member) {
  return Math.max(0, Number(member?.lastGoodAt) || 0);
}

function pickBest(list) {
  return [...list].sort((left, right) => {
    const goodDiff = lastGoodRank(right) - lastGoodRank(left);
    if (goodDiff !== 0) return goodDiff;
    const leftDelay = delayRank(left);
    const rightDelay = delayRank(right);
    if (leftDelay !== rightDelay) return leftDelay - rightDelay;
    return 0;
  })[0] ?? null;
}

/**
 * 选备选节点（纯函数）。候选顺序：
 * ① 与当前节点**同地区**的其它可用节点（`lastGoodAt` 降序、`delayMs` 升序）；
 * ② 同地区没有（或全在冷却）时：
 *    - `allowCrossRegion === false`（默认）→ 不切，`reason: 'no_same_region_alternative'`；
 *    - `true` → 才回退到任意可用节点，并带 `crossRegion: true`。
 *
 * @param {{ members: object[], activeNode: string, regionOf?: Function, allowCrossRegion?: boolean,
 *   isBadNode?: Function, now?: Function }} input
 * @returns {{ node: object|null, reason: string, crossRegion: boolean }}
 */
export function pickFallbackNode({
  members = [],
  activeNode = '',
  regionOf = null,
  allowCrossRegion = false,
  isBadNode = null,
} = {}) {
  const resolveRegion = typeof regionOf === 'function'
    ? regionOf
    : member => regionOfNode({ name: typeof member === 'string' ? member : member?.name ?? '' });
  const list = (Array.isArray(members) ? members : []).filter(item => item && typeof item.name === 'string' && item.name);
  const activeName = typeof activeNode === 'string' ? activeNode : '';
  const activeMember = list.find(item => item.name === activeName);
  const activeRegion = activeMember ? resolveRegion(activeMember) : regionOfNode({ name: activeName });
  const isBad = typeof isBadNode === 'function' ? isBadNode : () => false;
  const candidates = list.filter(item => item.name !== activeName && !isBad(item.name, item));

  const sameRegionCandidates = candidates.filter(item => sameRegion(resolveRegion(item), activeRegion));
  if (sameRegionCandidates.length) {
    return { node: pickBest(sameRegionCandidates), reason: 'same_region', crossRegion: false };
  }
  if (!allowCrossRegion) {
    // 这一行就是「为什么不擅自跨地区」：默认永远走这里，宁可不动也不换地区。
    return { node: null, reason: 'no_same_region_alternative', crossRegion: false };
  }
  if (!candidates.length) return { node: null, reason: 'no_alternative', crossRegion: false };
  return { node: pickBest(candidates), reason: 'cross_region', crossRegion: true };
}

function emitTo(onEvent, payload) {
  if (typeof onEvent !== 'function') return;
  try { onEvent(payload); } catch { /* 事件回调失败不影响巡检结论 */ }
}

function noteOnce(state, key, { now = Date.now, windowMs = HEALTH_INTERVAL_MS } = {}) {
  if (!state?.notes) return true;
  const at = timeOf(now);
  const previous = Number(state.notes.get(key)) || 0;
  if (previous && at - previous < windowMs) return false;
  state.notes.set(key, at);
  return true;
}

function regionOfMember(members, name) {
  const found = (Array.isArray(members) ? members : []).find(item => item?.name === name);
  if (found?.region) return found.region;
  return name ? regionOfNode({ name }) : null;
}

/**
 * 单池「检查 + 按需切换」。`runHealthCycle` 与预检共用同一份实现，避免两套切线规则。
 *
 * @param {{ client: object, pool: object, health?: object|null, state?: object|null,
 *   allowCrossRegion?: boolean, now?: Function, onEvent?: Function|null }} input
 * @returns {Promise<object>} 见返回值字段：`{ poolId, ok, probeOk, activeNode, delayMs, checkedAt,
 *   region, failedTargets, switched, crossRegion, note, reason }`
 */
export async function healPool({
  client,
  pool = {},
  health = null,
  state = null,
  allowCrossRegion = false,
  now = Date.now,
  onEvent = null,
} = {}) {
  const clock = () => Math.max(0, Math.floor(Number(now()) || 0));
  const poolId = String(pool?.id ?? '');
  const group = String(pool?.group || `mova-pool:${poolId}`);
  const members = Array.isArray(pool?.members) ? pool.members : [];
  const spec = health && typeof health === 'object' ? health : resolveHealthCheck(pool);
  const check = await checkPoolHealth({ client, pool, health: spec, groupName: group, now });
  const entry = {
    poolId,
    ok: check.ok,
    probeOk: check.ok,
    activeNode: check.activeNode,
    delayMs: check.delayMs,
    checkedAt: check.checkedAt,
    region: regionOfMember(members, check.activeNode),
    failedTargets: check.failedTargets ?? [],
    switched: null,
    crossRegion: false,
    note: '',
    reason: check.reason || '',
  };
  if (state) {
    state.checkedAt.set(poolId, check.checkedAt);
    if (check.activeNode) state.activeNodes.set(poolId, check.activeNode);
  }

  if (check.ok) {
    noteNodeSuccess(state, check.activeNode, { delayMs: check.delayMs, now: clock() });
    emitTo(onEvent, { kind: 'health', poolId, ok: true, activeNode: check.activeNode, delayMs: check.delayMs });
    return entry;
  }

  const failure = noteNodeFailure(state, check.activeNode, { now: clock() });
  // 未达阈值：只记录，不动线路（一次抖动不该换节点）。
  if (!state || failure.failures < HEALTH_FAILURE_THRESHOLD) {
    entry.note = 'probe_failed';
    emitTo(onEvent, {
      kind: 'health', poolId, ok: false, activeNode: check.activeNode, delayMs: null,
      failures: failure.failures, failedTargets: entry.failedTargets.map(item => item.code),
    });
    return entry;
  }

  // 把「历史延迟 / 最近成功时间」补给成员：`pickBest` 就是按这两个字段排序的，
  // 不喂数据的话它只能退化成「按声明顺序取第一个」——那等于没有择优，慢节点也会被选中。
  const enriched = members.map(item => ({
    ...item,
    delayMs: Number.isFinite(Number(item?.delayMs))
      ? Number(item.delayMs)
      : (Number(state?.lastDelayMs?.get(item?.name)) || null),
    lastGoodAt: Number(item?.lastGoodAt)
      || (Number(state?.lastGoodAt?.get(item?.name)) || 0),
  }));
  const pick = pickFallbackNode({
    members: enriched,
    activeNode: check.activeNode,
    regionOf: member => member?.region ?? regionOfNode({ name: member?.name ?? '' }),
    allowCrossRegion,
    isBadNode: name => isNodeCooling(state, name, { now: clock }),
  });

  if (!pick.node) {
    entry.reason = pick.reason;
    entry.note = pick.reason;
    // 同地区无备选只记一条（每池 5 分钟内最多一条），绝不刷屏告警。
    if (noteOnce(state, `${poolId}:${pick.reason}`, { now: clock() })) {
      emitTo(onEvent, {
        kind: 'health-note', poolId, ok: false, activeNode: check.activeNode,
        delayMs: null, reason: pick.reason, allowCrossRegion: Boolean(allowCrossRegion),
      });
    }
    emitTo(onEvent, { kind: 'health', poolId, ok: false, activeNode: check.activeNode, delayMs: null, reason: pick.reason });
    return entry;
  }

  const selected = typeof client?.select === 'function'
    ? await client.select(group, pick.node.name)
    : failed('controller_unavailable');
  if (!selected?.ok) {
    entry.reason = selected?.code || 'select_failed';
    entry.note = entry.reason;
    emitTo(onEvent, { kind: 'health', poolId, ok: false, activeNode: check.activeNode, delayMs: null, reason: entry.reason });
    return entry;
  }

  const switched = {
    from: check.activeNode,
    to: pick.node.name,
    at: clock(),
    reason: pick.reason,
    crossRegion: pick.crossRegion,
  };
  entry.switched = switched;
  entry.crossRegion = pick.crossRegion;
  entry.activeNode = pick.node.name;
  entry.region = regionOfMember(members, pick.node.name);
  entry.note = pick.reason;
  // 切换后新节点还没被验证：清掉「最近检查时间」，让下一次预检必须重测一遍。
  if (state) {
    state.checkedAt.set(poolId, 0);
    state.activeNodes.set(poolId, pick.node.name);
    state.switches.set(poolId, switched);
  }
  emitTo(onEvent, {
    kind: 'switch', poolId, from: switched.from, to: switched.to, at: switched.at,
    reason: switched.reason, crossRegion: switched.crossRegion,
    fromRegion: check.activeNode ? regionOfMember(members, check.activeNode) : null,
    toRegion: entry.region,
  });
  emitTo(onEvent, { kind: 'health', poolId, ok: false, activeNode: pick.node.name, delayMs: null, reason: pick.reason });
  return entry;
}

/** 一轮巡检：逐个池调用 `healPool`（单池异常不影响其它池）。 */
export async function runHealthCycle({
  client,
  pools = [],
  health = null,
  allowCrossRegion = false,
  now = Date.now,
  state = null,
  onEvent = null,
} = {}) {
  const checkedAt = Math.max(0, Math.floor(Number(now()) || 0));
  const results = [];
  for (const pool of Array.isArray(pools) ? pools : []) {
    if (!pool || !pool.id) continue;
    const spec = typeof health === 'function' ? health(pool) : health;
    try {
      results.push(await healPool({ client, pool, health: spec, state, allowCrossRegion, now, onEvent }));
    } catch (error) {
      results.push({
        poolId: String(pool.id), ok: false, probeOk: false, activeNode: '', delayMs: null,
        checkedAt, region: null, failedTargets: [], switched: null, crossRegion: false,
        note: 'internal', reason: 'internal', error: String(error?.message || '').slice(0, 120),
      });
    }
  }
  return { checkedAt, results };
}

/**
 * 周期定时器：`start()` 起 `setInterval`，`stop()` 清掉；`unref()` 防止定时器挂住进程退出。
 * 用注入的 `setIntervalImpl` 做假定时器单测（`tests/vpn-health-loop.test.mjs`）。
 */
export function createHealthLoop({
  intervalMs = HEALTH_INTERVAL_MS,
  onTick = null,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = null,
} = {}) {
  const every = Math.max(100, Math.floor(Number(intervalMs) || HEALTH_INTERVAL_MS));
  let timer = null;
  let running = false;

  async function tick() {
    if (!running) return null;
    try {
      return await onTick?.();
    } catch (error) {
      logger?.warn?.('health-loop-tick-failed', { code: error?.code || 'internal' });
      return null;
    }
  }

  return {
    intervalMs: every,
    start() {
      if (running) return { intervalMs: every, started: false };
      running = true;
      timer = setIntervalImpl(() => { void tick(); }, every);
      timer?.unref?.();
      return { intervalMs: every, started: true };
    },
    stop() {
      const wasRunning = running;
      running = false;
      if (timer !== null) {
        try { clearIntervalImpl(timer); } catch { /* 已清理 */ }
        timer = null;
      }
      return { stopped: wasRunning };
    },
    get running() { return running; },
    tick,
  };
}

/** 两个地区码是否同地区（转出给 `runtime-config.mjs` 写 meta 时保持一致口径）。 */
export function regionsMatch(a, b) {
  const left = normalizeCode(a);
  const right = normalizeCode(b);
  return Boolean(left && right) && sameRegion(left, right);
}
