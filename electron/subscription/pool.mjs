/**
 * 多账号调度池（§9.1–9.4）。
 *
 * 负责：候选过滤、排序选号、写选择事件、标记 limited/expired/清理/使用时间。
 * 不负责：凭据落盘的加解密（store）、额度探针（usage）、错误文案（contract）。
 * 被谁调用：subscription 服务层（发送前选号、失败后标记、设置页快照）。
 *
 * 关键决策：
 * - 运行期的 state/limitedUntil/lastUsedAt 有内存覆写层（overlay），同时尽力写回 store，
 *   这样「到点恢复」不依赖磁盘，重启后冷却也不会丢。
 * - `markLimited` 只写 `limitedUntil`，不动磁盘里的 `state`；`ready` 是算出来的
 *   （`isAvailable` + `displayState`），少一个需要手动清除的状态。
 * - `pick()` 返回**含令牌**的完整记录（上游请求要用 access），`snapshot()` 只返回脱敏视图。
 */
import { SubscriptionError, effectiveState, isAvailable, selectionEvent } from './contract.mjs';
import { maskAccount } from './store.mjs';
import { describeReset } from './usage.mjs';

/** 与 contract 的 30s 容错保持一致：时钟漂移下不要过早放行或过晚封禁。 */
const CLOCK_SKEW_MS = 30_000;
/** 标记失败后多久内的选号算「切号」，用于 selectionEvent.reason。 */
const FAILOVER_WINDOW_MS = 60_000;
/** 没有额度快照的账号按「未使用过」乐观处理，否则新登录的账号会永远排最后。 */
const UNKNOWN_HEADROOM = 100;

function keyOf(provider, accountId) {
  return `${provider}:${accountId}`;
}

/** 错误里的原因字段只留短文本，令牌形态的串一律抹掉（§6 日志要求）。 */
function sanitizeReason(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/[A-Za-z0-9_\-.]{32,}/g, '***')
    .slice(0, 120);
}

/**
 * @param {{
 *   store: { list: Function, read: Function, modify?: Function },
 *   now?: () => number,
 *   settings?: { preferredAccountId?: string, autoSwitch?: boolean },
 * }} options
 */
export function createPool({ store, now, settings } = {}) {
  if (!store || typeof store.list !== 'function') throw new SubscriptionError('request', { detail: 'store' });
  const clock = typeof now === 'function' ? now : Date.now;
  // settings 是活对象：设置页改优先账号后，下一次 pick 立即生效。
  const config = settings ?? {};
  const runtime = new Map();
  const wasLimited = new Set();
  const recovered = new Set();
  let lastFailure = null;

  function overlay(provider, accountId) {
    const key = keyOf(provider, accountId);
    let entry = runtime.get(key);
    if (!entry) {
      entry = {};
      runtime.set(key, entry);
    }
    return entry;
  }

  function merged(record) {
    const entry = runtime.get(keyOf(record.provider, record.accountId));
    return entry ? { ...record, ...entry } : { ...record };
  }

  /** 展示状态：limited 由 limitedUntil 推导，磁盘上的 state 保持 ready。 */
  function displayState(record, at) {
    const state = effectiveState(record, at);
    if (state === 'ready' && Number(record.limitedUntil) > at + CLOCK_SKEW_MS) return 'limited';
    return state;
  }

  /** 剩余额度 = 100 - 所有窗口里最高的 usedPercent（窗口最小值才是瓶颈）。 */
  function headroom(record) {
    const windows = Array.isArray(record.usage?.windows) ? record.usage.windows : [];
    let max = null;
    for (const window of windows) {
      const used = Number(window?.usedPercent);
      if (Number.isFinite(used) && (max === null || used > max)) max = used;
    }
    return max === null ? UNKNOWN_HEADROOM : Math.max(0, 100 - max);
  }

  function compare(a, b) {
    const preferredId = config.preferredAccountId;
    const aPreferred = preferredId && a.accountId === preferredId ? 1 : 0;
    const bPreferred = preferredId && b.accountId === preferredId ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    const diff = headroom(b) - headroom(a);
    if (diff !== 0) return diff;
    const aUsed = Number.isFinite(a.lastUsedAt) ? a.lastUsedAt : 0;
    const bUsed = Number.isFinite(b.lastUsedAt) ? b.lastUsedAt : 0;
    if (aUsed !== bUsed) return aUsed - bUsed;
    return String(a.accountId).localeCompare(String(b.accountId));
  }

  async function load(provider) {
    const views = await store.list(provider);
    const records = [];
    for (const view of Array.isArray(views) ? views : []) {
      // list() 是脱敏视图、不含 usage；排序要用 usage，只能回读完整记录（store 内有缓存）。
      const full = typeof store.read === 'function' ? await store.read(provider, view.accountId) : null;
      records.push(full ?? view);
    }
    return records;
  }

  function skipReason(record, at) {
    if (record.state === 'expired') return 'expired';
    if (record.state === 'error') return 'error';
    if (Number(record.limitedUntil) > at + CLOCK_SKEW_MS) return 'limited';
    return 'unavailable';
  }

  function nearestReset(records, at) {
    let best = null;
    for (const record of records) {
      const windows = Array.isArray(record.usage?.windows) ? record.usage.windows : [];
      for (const window of windows) {
        const resetsAt = Number(window?.resetsAt);
        if (!Number.isFinite(resetsAt) || resetsAt <= at) continue;
        if (!best || resetsAt < best.resetsAt) best = { resetsAt, label: window?.label ?? window?.id ?? '' };
      }
    }
    return best;
  }

  function noAccountError(provider, records, at) {
    if (records.length === 0) {
      return new SubscriptionError('no_account_available', { detail: '还没有登录任何账号' });
    }
    const reset = nearestReset(records, at);
    const detail = reset
      ? `最近重置：${reset.label ? `${reset.label} ` : ''}${describeReset(reset.resetsAt, at)}`
      : '所有账号额度已用完或标记为失效';
    return new SubscriptionError('no_account_available', { detail });
  }

  /** 写回失败不阻塞请求路径：内存里已经生效，重启后会重新探测。 */
  async function persist(provider, accountId, patch) {
    if (typeof store.modify !== 'function') return;
    try {
      await store.modify(provider, accountId, current => (current ? { ...current, ...patch } : null));
    } catch {
      // 凭据文件暂时不可写时，冷却仍然在内存里生效。
    }
  }

  async function pick(provider) {
    const at = clock();
    const records = await load(provider);
    const skipped = [];
    const candidates = [];
    for (const record of records) {
      const account = merged(record);
      const key = keyOf(provider, record.accountId);
      if (!isAvailable(account, at)) {
        skipped.push({ id: record.accountId, why: skipReason(account, at) });
        continue;
      }
      // 上一次失败被标记 limited、现在到点的账号：这次选中它就是「恢复」。
      if (wasLimited.has(key)) {
        wasLimited.delete(key);
        recovered.add(key);
      }
      candidates.push(account);
    }
    if (candidates.length === 0) throw noAccountError(provider, records, at);
    candidates.sort(compare);
    const account = candidates[0];
    const key = keyOf(provider, account.accountId);
    let reason = 'least_used';
    if (config.preferredAccountId && account.accountId === config.preferredAccountId) reason = 'preferred';
    else if (recovered.has(key)) reason = 'recovered';
    else if (lastFailure && lastFailure.provider === provider
      && lastFailure.accountId !== account.accountId
      && at - lastFailure.at <= FAILOVER_WINDOW_MS) reason = 'failover';
    recovered.delete(key);
    return {
      account,
      event: selectionEvent({ provider, picked: account.accountId, reason, skipped }),
    };
  }

  async function snapshot(provider) {
    const at = clock();
    const records = await load(provider);
    const ordered = records.map(merged).sort(compare);
    const active = ordered.find(record => isAvailable(record, at)) ?? null;
    return {
      provider,
      at,
      activeAccountId: active?.accountId ?? null,
      accounts: ordered.map(record => ({
        ...maskAccount(record),
        state: displayState(record, at),
        available: isAvailable(record, at),
        active: active?.accountId === record.accountId,
        usage: record.usage ?? null,
      })),
    };
  }

  async function markLimited(provider, accountId, until) {
    const value = Number(until);
    if (!Number.isFinite(value)) throw new SubscriptionError('request', { detail: 'until' });
    const key = keyOf(provider, accountId);
    overlay(provider, accountId).limitedUntil = value;
    wasLimited.add(key);
    recovered.delete(key);
    lastFailure = { provider, accountId, at: clock() };
    await persist(provider, accountId, { limitedUntil: value });
  }

  async function markExpired(provider, accountId, reason) {
    const entry = overlay(provider, accountId);
    entry.state = 'expired';
    entry.lastError = sanitizeReason(reason);
    const key = keyOf(provider, accountId);
    wasLimited.delete(key);
    recovered.delete(key);
    lastFailure = { provider, accountId, at: clock() };
    await persist(provider, accountId, { state: 'expired', lastError: entry.lastError });
  }

  async function clear(provider, accountId) {
    const key = keyOf(provider, accountId);
    runtime.delete(key);
    wasLimited.delete(key);
    recovered.delete(key);
    if (lastFailure && lastFailure.provider === provider && lastFailure.accountId === accountId) lastFailure = null;
    await persist(provider, accountId, { state: 'ready', limitedUntil: 0, lastError: '' });
  }

  async function noteUsed(provider, accountId) {
    const at = clock();
    overlay(provider, accountId).lastUsedAt = at;
    await persist(provider, accountId, { lastUsedAt: at });
  }

  return { pick, snapshot, markLimited, markExpired, clear, noteUsed };
}
