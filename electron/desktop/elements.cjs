'use strict';
// L1 元素记忆：appKey + stableKey → 定位信息 + 命中统计。
// 用途只有一个：省 token。命中记忆时执行器可以直接 FindFirst，不必让模型先看全量树。
//
// 结构照 browser/procedures.cjs 的 mutate 队列 + 原子写（临时文件 + rename），
// 因为这里同样会被多个会话并发写；上限 LRU 2000。

const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { redactName } = require('./trace.cjs');

const VERSION = 1;
const MAX_ELEMENTS = 2000;
const STALE_AFTER_MISSES = 2;

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function rectOf(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const rect = value.slice(0, 4).map(item => Math.round(Number(item) || 0));
  return rect.every(Number.isFinite) ? rect : null;
}

function sizeOf(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const size = value.slice(0, 2).map(item => Math.round(Number(item) || 0));
  return size.every(Number.isFinite) && size[0] > 0 ? size : null;
}

function exeOf(appKey) {
  return String(appKey || '').split('|')[0].split(/[\\/]/).pop().toLowerCase();
}

/**
 * @param {{directory:string, max?:number, now?:()=>number}} options
 */
function createElementStore({ directory, max = MAX_ELEMENTS, now = () => new Date().toISOString() } = {}) {
  if (typeof directory !== 'string' || !directory) throw coded('invalid-input', 'directory is required');
  const file = join(directory, 'elements.json');
  let queue = Promise.resolve();
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      cache = isPlainObject(value) && value.version === VERSION && Array.isArray(value.elements)
        ? value
        : { version: VERSION, elements: [] };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw coded('storage-error', '无法读取元素记忆');
      cache = { version: VERSION, elements: [] };
    }
    return cache;
  }

  function mutate(fn) {
    const work = queue.then(async () => {
      const data = await load();
      const result = fn(data);
      await mkdir(directory, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temp, file);
      return result;
    });
    queue = work.catch(() => {});
    return work;
  }

  function indexOf(data, appKey, stableKey) {
    return data.elements.findIndex(item => item.appKey === appKey && item.stableKey === stableKey);
  }

  /** 供 find 使用：同一 appKey 内的候选，按“像不像”打分。 */
  function score(item, query) {
    let total = 0;
    if (query.stableKey && item.stableKey === query.stableKey) total += 100;
    if (query.role && item.role?.toLowerCase() === String(query.role).toLowerCase()) total += 12;
    if (query.name) {
      const name = item.name?.toLowerCase() || '';
      const wanted = String(query.name).toLowerCase();
      if (name && name === wanted) total += 40;
      else if (name && (name.includes(wanted) || wanted.includes(name))) total += 18;
    }
    if (query.path && item.path) total += 0;
    total += Math.min(10, (item.hits || 0) * 0.5);
    total -= Math.min(10, (item.miss || 0) * 2);
    return total;
  }

  /**
   * 记住一个元素。同 appKey+stableKey 视为同一条，命中计数保留。
   */
  async function save(input = {}) {
    const appKey = String(input.appKey || '').slice(0, 120);
    const stableKey = String(input.stableKey || '').slice(0, 120);
    if (!appKey || !stableKey) throw coded('invalid-input', 'appKey and stableKey are required');
    return mutate(data => {
      const at = now();
      const index = indexOf(data, appKey, stableKey);
      const previous = index >= 0 ? data.elements[index] : null;
      const record = {
        appKey,
        stableKey,
        role: String(input.role || previous?.role || '').slice(0, 40),
        name: redactName(input.name || previous?.name || ''),
        path: Array.isArray(input.path) ? input.path.slice(0, 12).map(item => String(item).slice(0, 60)) : (previous?.path || []),
        lastRect: rectOf(input.lastRect || input.rect) || previous?.lastRect || null,
        windowSize: sizeOf(input.windowSize) || previous?.windowSize || null,
        scaleFactor: Number(input.scaleFactor) > 0 ? Number(input.scaleFactor) : (previous?.scaleFactor || 1),
        fallbackPoint: Array.isArray(input.fallbackPoint) ? input.fallbackPoint.slice(0, 2).map(Number) : (previous?.fallbackPoint || null),
        hits: previous?.hits || 0,
        miss: 0,
        stale: false,
        lastSeen: at,
        createdAt: previous?.createdAt || at,
      };
      if (index >= 0) data.elements.splice(index, 1);
      data.elements.push(record);
      if (data.elements.length > max) data.elements.splice(0, data.elements.length - max);
      return { ...record };
    });
  }

  /**
   * 找最像的一条。默认要求 appKey 完全一致（exe|版本，版本变了自然失效）。
   * @returns {Promise<object|null>}
   */
  async function find({ appKey, stableKey, name, role, path, loose = false } = {}) {
    const data = await load();
    const wanted = String(appKey || '');
    const exe = exeOf(wanted);
    const candidates = data.elements.filter(item => {
      if (item.stale) return false;
      if (!wanted) return true;
      if (item.appKey === wanted) return true;
      return loose && exe && exeOf(item.appKey) === exe;
    });
    if (!candidates.length) return null;
    const ranked = candidates
      .map(item => ({ item, score: score(item, { stableKey, name, role, path }) }))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score);
    return ranked.length ? { ...ranked[0].item, score: ranked[0].score } : null;
  }

  /**
   * 记一次命中/失手。连续 2 次 miss 标记 stale（下次 find 不再返回它）。
   * @returns {Promise<object|null>}
   */
  async function report({ appKey, stableKey, hit = true, rect, windowSize } = {}) {
    const key = String(appKey || '');
    const stable = String(stableKey || '');
    if (!key || !stable) return null;
    return mutate(data => {
      const index = indexOf(data, key, stable);
      if (index < 0) return null;
      const item = data.elements[index];
      const at = now();
      if (hit) {
        item.hits = (item.hits || 0) + 1;
        item.miss = 0;
        item.stale = false;
        const nextRect = rectOf(rect);
        if (nextRect) item.lastRect = nextRect;
        const nextSize = sizeOf(windowSize);
        if (nextSize) item.windowSize = nextSize;
        item.lastSeen = at;
        data.elements.splice(index, 1);
        data.elements.push(item);
      } else {
        item.miss = (item.miss || 0) + 1;
        if (item.miss >= STALE_AFTER_MISSES) item.stale = true;
        item.lastSeen = at;
      }
      return { ...item };
    });
  }

  async function list({ appKey, limit = 100 } = {}) {
    const data = await load();
    return data.elements
      .filter(item => !appKey || item.appKey === appKey)
      .slice(-Math.max(1, Math.min(max, Number(limit) || 100)))
      .map(item => ({
        appKey: item.appKey, stableKey: item.stableKey, role: item.role, name: item.name,
        hits: item.hits || 0, miss: item.miss || 0, stale: item.stale === true, lastSeen: item.lastSeen,
      }));
  }

  async function stats() {
    const data = await load();
    return {
      total: data.elements.length,
      stale: data.elements.filter(item => item.stale).length,
      apps: [...new Set(data.elements.map(item => item.appKey))].length,
      max,
    };
  }

  /** 清掉 stale 与超出上限的老条目；返回删掉了多少。 */
  async function prune() {
    return mutate(data => {
      const before = data.elements.length;
      data.elements = data.elements.filter(item => !item.stale);
      if (data.elements.length > max) data.elements.splice(0, data.elements.length - max);
      return before - data.elements.length;
    });
  }

  async function clear() {
    return mutate(data => {
      const removed = data.elements.length;
      data.elements = [];
      return removed;
    });
  }

  return { save, find, report, list, stats, prune, clear, file, max };
}

module.exports = { createElementStore, MAX_ELEMENTS, STALE_AFTER_MISSES };
