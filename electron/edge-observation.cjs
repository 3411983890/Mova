'use strict';
// Edge 侧观察结果去重。
//
// 问题：扩展里每一步动作都是「执行前全量快照 + 执行后 diff + 表单摘要」，
// 一次 6 步的批处理就是 18 次跨进程采集，每次都把整棵页面控件树序列化一遍。
// 其中真正必要的只有一次：动作确实改变了页面之后的那次观察。
//
// 解法：page.js 在每次动作后给页面版本号 +1，桥接层用 (documentId, url, version)
// 作为观察结果的键：
// - 同一个版本重复观察 → 命中缓存，不再跨进程采集；
// - 版本变了 → 旧观察自然失效；
// - 太旧（超过 ttl）→ 视为未命中，避免把过期状态当现状。
// 命中/未命中都计数，用来验证「重复观察确实减少了」，而不是凭感觉。

const DEFAULT_TTL_MS = 2500;
const MAX_ENTRIES = 8;

function createObservationCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : MAX_ENTRIES;
  const rows = [];
  const counts = { stores: 0, hits: 0, misses: 0, expired: 0, invalidated: 0, reuseMs: 0 };

  function keyOf({ documentId, url, version } = {}) {
    if (version === undefined || version === null) return `u:${url || ''}`;
    return `${documentId || ''}|${url || ''}|v${version}`;
  }

  function find(key) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].key === key) return rows[index];
    }
    return null;
  }

  /** 记一份观察结果；同键覆盖，保持「最新一份」在前。 */
  function remember(input = {}) {
    const key = keyOf(input);
    const entry = {
      key,
      documentId: input.documentId || '',
      url: input.url || '',
      version: input.version ?? null,
      snapshot: input.snapshot || null,
      summary: input.summary || null,
      phase: input.phase || 'after',
      at: now(),
    };
    const existing = rows.findIndex(row => row.key === key);
    if (existing >= 0) rows.splice(existing, 1);
    rows.push(entry);
    while (rows.length > maxEntries) rows.shift();
    counts.stores += 1;
    return entry;
  }

  /** 命中返回 entry，否则 null。过期的条目会被移除。 */
  function lookup(query = {}) {
    const key = keyOf(query);
    const entry = find(key);
    if (!entry) {
      counts.misses += 1;
      return null;
    }
    if (now() - entry.at > ttlMs) {
      rows.splice(rows.indexOf(entry), 1);
      counts.expired += 1;
      counts.misses += 1;
      return null;
    }
    counts.hits += 1;
    counts.reuseMs += Math.max(0, now() - entry.at);
    return entry;
  }

  function invalidate(reason = 'manual') {
    if (rows.length) counts.invalidated += 1;
    rows.length = 0;
    return reason;
  }

  function summary() {
    const total = counts.hits + counts.misses;
    return {
      ttlMs,
      entries: rows.length,
      stores: counts.stores,
      hits: counts.hits,
      misses: counts.misses,
      expired: counts.expired,
      invalidated: counts.invalidated,
      hitRate: total ? Math.round((counts.hits / total) * 100) : 0,
      reusedMs: counts.reuseMs,
    };
  }

  return { keyOf, remember, lookup, invalidate, summary, entries: () => rows.slice() };
}

/** 从 page.js 的快照结果里抽出去重键需要的三元组。 */
function observationKeyOf(snapshot, fallback = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { documentId: fallback.documentId || '', url: fallback.url || '', version: fallback.version ?? null };
  }
  return {
    documentId: snapshot.documentId || fallback.documentId || '',
    url: snapshot.url || fallback.url || '',
    version: snapshot.version ?? fallback.version ?? null,
  };
}

module.exports = { createObservationCache, observationKeyOf, DEFAULT_TTL_MS };
