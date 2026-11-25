'use strict';

/**
 * TTL + LRU 缓存。Map 保持插入顺序，get 命中后刷新顺序，
 * 因此淘汰时丢掉的永远是最久未使用（= 最旧插入）的一条。`now` 仅为测试注入。
 */
function createCache({ ttlMs = 15 * 60_000, max = 200, now = Date.now } = {}) {
  const store = new Map();
  const capacity = Math.max(1, Math.floor(Number(max) || 1));
  const ttl = Math.max(0, Number(ttlMs) || 0);

  const get = key => {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (now() - hit.at >= ttl) {
      store.delete(key);
      return undefined;
    }
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  };

  const set = (key, value) => {
    store.delete(key);
    while (store.size >= capacity) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
    store.set(key, { value, at: now() });
  };

  return {
    get,
    set,
    clear: () => store.clear(),
    size: () => store.size,
  };
}

module.exports = { createCache };
