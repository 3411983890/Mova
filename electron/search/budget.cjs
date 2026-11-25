'use strict';

const KINDS = ['queries', 'reads', 'chars'];

/**
 * 一次检索的配额账本。纯对象工厂：永不抛错，额度不足只返回 false。
 * `now` 只为测试可注入，默认 Date.now。
 */
function createBudget({ queries = 12, reads = 8, chars = 120000, ms = 60000, now = Date.now } = {}) {
  const deadline = now() + Math.max(0, Number(ms) || 0);
  const left = {
    queries: Math.max(0, Number(queries) || 0),
    reads: Math.max(0, Number(reads) || 0),
    chars: Math.max(0, Number(chars) || 0),
  };

  // 额度不足时不扣减，调用方据此停止后续外呼。
  const spend = (kind, amount = 1) => {
    if (!KINDS.includes(kind)) return false;
    const cost = Number(amount);
    if (!Number.isFinite(cost) || cost < 0) return false;
    if (left[kind] < cost) return false;
    left[kind] -= cost;
    return true;
  };

  const remaining = kind => (KINDS.includes(kind) ? Math.max(0, left[kind]) : 0);

  const exhausted = () => KINDS.some(kind => left[kind] <= 0) || now() > deadline;

  // 注意：ms 返回「剩余毫秒」，不是配置值；deadline 是绝对时间戳。
  const state = () => ({
    queries: remaining('queries'),
    reads: remaining('reads'),
    chars: remaining('chars'),
    ms: Math.max(0, deadline - now()),
    deadline,
    exhausted: exhausted(),
  });

  return { spend, exhausted, remaining, state };
}

module.exports = { createBudget };
