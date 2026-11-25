/**
 * 待生效压缩队列（纯内存、零 IO、无全局状态）。
 *
 * 负责：暂存「已经算好、但还没发出去」的一次压缩结果，让下一次请求的接线层按 key 取走，
 *       并让 context_read 在压缩生效前就能回查归档原文。
 * 不负责：算摘要（summarize/digest）、决定压哪一段（ledger）、拼 payload（wiring）、落盘（archive）。
 * 被谁调用：electron/context/tools.mjs（compact 写入、read 读取），以及 chat-agent 的接线层（take 一次即消费）。
 * 为什么需要它：工具被调用的那一刻改不了「正在发的这一轮」messages，压缩只能排到下一次请求；
 *   没有这层中转，模型会以为压缩已经生效，从而在本轮继续按旧上下文推理。
 * @see Mova上下文压缩与Agent上下文工程方案.md §4.6
 */

const DEFAULT_MAX_ENTRIES = 24;
const DEFAULT_TTL_MS = 30 * 60_000;

/** key 只接受能稳定当 Map key 的标量：数字型 conversationId 与字符串 sessionKey 都要能用。 */
function keyOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 归一化成固定字段集合（与 wiring 逐字对齐）。
 * 为什么连字段都只留白名单：消费者（wiring / context_read）会直接读 `coveredIds`、`archive`，
 * 多出来的字段只会让人以为「某个调用方塞了新东西」，反而让形状漂移。
 */
function normalizePayload(payload, fallbackCreatedAt) {
  const source = isRecord(payload) ? payload : {};
  const coveredIds = Array.isArray(source.coveredIds)
    ? source.coveredIds.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  const archive = Array.isArray(source.archive)
    ? source.archive
      .filter((entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0)
      .map((entry) => ({ id: entry.id, text: toText(entry.text) }))
    : [];
  const coveredCount = Number.isInteger(source.coveredCount) && source.coveredCount >= 0
    ? source.coveredCount
    : coveredIds.length;
  return {
    summaryBlock: toText(source.summaryBlock),
    coveredIds,
    coveredCount,
    // 只认两个合法来源：写错就按程序摘要处理——低估可信度比高估安全。
    source: source.source === 'llm' ? 'llm' : 'deterministic',
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : fallbackCreatedAt,
    archive,
  };
}

/**
 * 建一个待生效队列。
 * `maxEntries` 按会话数计：真同时有几十个会话在压缩才会顶到上限；
 * `ttlMs` <= 0 表示不按时间过期（只有明确的调用方才会这么传）。
 *
 * @param {{maxEntries?: number, ttlMs?: number, now?: () => number}} [options]
 */
export function createPendingCompactions({ maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : Infinity;
  const clock = typeof now === 'function' ? now : Date.now;

  /** Map 保插入顺序：第一个 key 就是最旧的一条，「超限丢最旧」只要删它。 */
  const entries = new Map();

  function currentTime() {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  /** 严格大于才算过期：ttl 边界上的那条仍然可用，避免「刚好 30 分钟」时行为不可预测。 */
  function isExpired(payload, at) {
    return Number.isFinite(ttl) && at - payload.createdAt > ttl;
  }

  /** 顺手清掉所有过期项：size() 报的必须是「真的还能取到」的条数。 */
  function sweep(at = currentTime()) {
    for (const [key, payload] of entries) {
      if (isExpired(payload, at)) entries.delete(key);
    }
  }

  function set(key, payload) {
    const id = keyOf(key);
    if (!id) return false;
    const normalized = normalizePayload(payload, currentTime());
    // 先删再插：重复 set 同一个 key 时刷新它的「新旧位次」，否则丢最旧会丢到刚写进来的这条。
    entries.delete(id);
    entries.set(id, normalized);
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
    return true;
  }

  function take(key) {
    const id = keyOf(key);
    if (!id) return null;
    const payload = entries.get(id);
    if (!payload) return null;
    entries.delete(id);
    if (isExpired(payload, currentTime())) return null;
    return payload;
  }

  function peek(key) {
    const id = keyOf(key);
    if (!id) return null;
    const payload = entries.get(id);
    if (!payload) return null;
    if (isExpired(payload, currentTime())) {
      entries.delete(id);
      return null;
    }
    return payload;
  }

  /** 幂等：没有这条 key 也返回 false，不抛。 */
  function clear(key) {
    const id = keyOf(key);
    if (!id) return false;
    return entries.delete(id);
  }

  function size() {
    sweep();
    return entries.size;
  }

  return { set, take, peek, clear, size };
}
