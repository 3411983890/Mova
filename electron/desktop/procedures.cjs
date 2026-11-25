'use strict';
// L2 流程技能（权威）。结构与 browser/procedures.cjs 同构，但主键是 appKey
// （exe|版本号）：应用升级后版本变化，旧技能自然失效，不会拿过期坐标去点。
//
// 上限 300（LRU：lastUsedAt → updatedAt → createdAt）。指纹去重：同一个
// appKey 下 steps 指纹相同的记录只保留一条，重复保存视为“再成功一次”。

const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;
const MAX_PROCEDURES = 300;
const MAX_STEPS = 30;
const MAX_TEXT = 120;

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function clean(value, limit = MAX_TEXT) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function exeOf(appKey) {
  return String(appKey || '').split('|')[0].split(/[\\/]/).pop().toLowerCase();
}

/** 归一化一步，未知 op 直接丢弃（宁可不重放，也不要瞎点）。 */
function normalizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const op = String(step.op || step.action || '').toLowerCase();
  if (!op) return null;
  const target = step.target && typeof step.target === 'object' ? step.target : null;
  const out = { op };
  if (target) {
    if (target.stableKey) out.target = { stableKey: String(target.stableKey).slice(0, 120) };
    else if (target.path) out.target = { path: String(target.path).slice(0, 200) };
    else if (Array.isArray(target.point)) {
      out.target = {
        point: target.point.slice(0, 2).map(Number),
        ...(Array.isArray(target.windowSize) ? { windowSize: target.windowSize.slice(0, 2).map(Number) } : {}),
      };
    } else if (typeof step.target === 'string') out.target = { stableKey: step.target.slice(0, 120) };
  } else if (typeof step.target === 'string' && step.target) {
    out.target = { stableKey: step.target.slice(0, 120) };
  }
  if (typeof step.value === 'string') out.value = step.value.slice(0, 400);
  if (typeof step.keys === 'string') out.keys = step.keys.slice(0, 80);
  if (step.expect && typeof step.expect === 'object') out.expect = step.expect;
  if (step.optional === true) out.optional = true;
  if (step.note) out.note = clean(step.note, 80);
  return out;
}

function fingerprintOf(steps) {
  return JSON.stringify((Array.isArray(steps) ? steps : []).map(step => [
    step.op || '', step.keys || '', step.value || '',
    step.target?.stableKey || step.target?.path || (Array.isArray(step.target?.point) ? step.target.point.join(',') : ''),
  ]));
}

function normalizeParams(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const name = clean(item.name, 40);
    if (!name) return [];
    return [{
      name,
      ...(item.default !== undefined ? { default: clean(item.default, 120) } : {}),
      ...(item.example !== undefined ? { example: clean(item.example, 120) } : {}),
      ...(item.description !== undefined ? { description: clean(item.description, 120) } : {}),
    }];
  });
}

function normalizePreconditions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const kind = clean(item.kind, 20);
    if (!kind) return [];
    return [{ kind, ...(item.title ? { title: clean(item.title, 120) } : {}), ...(item.stableKey ? { stableKey: clean(item.stableKey, 120) } : {}) }];
  });
}

function recencyOf(item) {
  return Date.parse(item.stats?.lastUsedAt || item.updatedAt || item.createdAt || 0) || 0;
}

/**
 * @param {{directory:string, max?:number, now?:()=>string}} options
 */
function createProcedureStore({ directory, max = MAX_PROCEDURES, now = () => new Date().toISOString() } = {}) {
  if (typeof directory !== 'string' || !directory) throw coded('invalid-input', 'directory is required');
  const file = join(directory, 'procedures.json');
  let queue = Promise.resolve();
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      cache = value && value.version === VERSION && Array.isArray(value.procedures)
        ? value
        : { version: VERSION, procedures: [] };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw coded('storage-error', '无法读取桌面技能');
      cache = { version: VERSION, procedures: [] };
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

  function summary(item) {
    return {
      id: item.id,
      appKey: item.appKey,
      title: item.title,
      intent: item.intent || [],
      stepCount: (item.steps || []).length,
      version: item.version || 1,
      status: item.status || 'active',
      stats: item.stats || { ok: 0, fail: 0, avgMs: 0, lastUsedAt: null },
    };
  }

  async function list({ appKey, includeRetired = false, limit = 50 } = {}) {
    const data = await load();
    return data.procedures
      .filter(item => (includeRetired || (item.status || 'active') === 'active'))
      .filter(item => !appKey || item.appKey === appKey || exeOf(item.appKey) === exeOf(appKey))
      .sort((a, b) => recencyOf(b) - recencyOf(a))
      .slice(0, Math.max(1, Math.min(max, Number(limit) || 50)))
      .map(summary);
  }

  async function get(id) {
    const data = await load();
    const found = data.procedures.find(item => item.id === id);
    if (!found) throw coded('procedure-not-found', '桌面技能不存在');
    return JSON.parse(JSON.stringify(found));
  }

  function score(item, intent) {
    const words = String(intent || '').toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    if (!words.length) return 0;
    const haystack = `${item.title} ${(item.intent || []).join(' ')}`.toLowerCase();
    return words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
  }

  /**
   * 召回：appKey 是硬门槛（不跨应用猜），intent 打分，成功率与新鲜度做次序。
   */
  async function find({ appKey, intent, limit = 3, includeRetired = false } = {}) {
    const data = await load();
    const wanted = String(appKey || '');
    return data.procedures
      .filter(item => includeRetired || (item.status || 'active') === 'active')
      .filter(item => !wanted || item.appKey === wanted || (exeOf(item.appKey) === exeOf(wanted) && Boolean(exeOf(wanted))))
      .map(item => ({ item, intentScore: score(item, intent) }))
      .filter(row => !intent || row.intentScore > 0)
      .sort((a, b) => {
        const statsA = a.item.stats || {};
        const statsB = b.item.stats || {};
        const rateA = (statsA.ok || 0) / Math.max(1, (statsA.ok || 0) + (statsA.fail || 0));
        const rateB = (statsB.ok || 0) / Math.max(1, (statsB.ok || 0) + (statsB.fail || 0));
        return (b.intentScore + rateB * 2) - (a.intentScore + rateA * 2)
          || recencyOf(b.item) - recencyOf(a.item);
      })
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 3)))
      .map(row => summary(row.item));
  }

  /**
   * 保存（或按指纹合并）。同一个 appKey 下 steps 指纹相同 → 更新已有记录。
   */
  async function save(input = {}) {
    const appKey = String(input.appKey || '').trim().slice(0, 120);
    if (!appKey) throw coded('invalid-app', 'appKey is required');
    const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, MAX_STEPS).map(normalizeStep).filter(Boolean);
    if (!steps.length) throw coded('invalid-input', '技能至少需要一步');
    const fingerprint = fingerprintOf(steps);
    return mutate(data => {
      const at = now();
      const sameFingerprint = data.procedures.find(item => item.appKey === appKey && item.fingerprint === fingerprint);
      const id = input.id || sameFingerprint?.id || `dp_${randomUUID().slice(0, 8)}`;
      const previous = data.procedures.find(item => item.id === id);
      const record = {
        id,
        appKey,
        title: clean(input.title || previous?.title || sameFingerprint?.title || '未命名桌面流程', 80),
        intent: Array.isArray(input.intent)
          ? input.intent.map(item => clean(item, 40)).filter(Boolean).slice(0, 12)
          : (previous?.intent || []),
        params: input.params !== undefined ? normalizeParams(input.params) : (previous?.params || []),
        preconditions: input.preconditions !== undefined
          ? normalizePreconditions(input.preconditions)
          : (previous?.preconditions || []),
        steps,
        verify: input.verify && typeof input.verify === 'object' ? input.verify : (previous?.verify || null),
        fingerprint,
        version: previous ? (previous.version || 1) + 1 : 1,
        status: input.status === 'retired' ? 'retired' : 'active',
        source: input.source && typeof input.source === 'object' ? input.source : (previous?.source || null),
        stats: previous?.stats || sameFingerprint?.stats || { ok: 0, fail: 0, avgMs: 0, lastUsedAt: null },
        createdAt: previous?.createdAt || sameFingerprint?.createdAt || at,
        updatedAt: at,
      };
      const index = data.procedures.findIndex(item => item.id === id);
      if (index >= 0) data.procedures[index] = record;
      else data.procedures.unshift(record);
      if (data.procedures.length > max) {
        data.procedures.sort((a, b) => recencyOf(b) - recencyOf(a));
        data.procedures.length = max;
      }
      return { ...record, reused: Boolean(sameFingerprint) };
    });
  }

  /** 记录一次重放结果。 */
  async function report(id, { ok, ms } = {}) {
    return mutate(data => {
      const item = data.procedures.find(row => row.id === id);
      if (!item) return null;
      const at = now();
      item.stats = item.stats || { ok: 0, fail: 0, avgMs: 0, lastUsedAt: null };
      if (ok) item.stats.ok = (item.stats.ok || 0) + 1;
      else item.stats.fail = (item.stats.fail || 0) + 1;
      if (Number.isFinite(ms)) item.stats.avgMs = Math.round(((item.stats.avgMs || 0) * 0.7) + ms * 0.3);
      item.stats.lastUsedAt = at;
      item.updatedAt = at;
      return item.stats;
    });
  }

  /** 软删除：保留历史统计，不再出现在召回里（设置页的“删除”。 */
  async function retire(id) {
    return mutate(data => {
      const item = data.procedures.find(row => row.id === id);
      if (!item) return false;
      item.status = 'retired';
      item.updatedAt = now();
      return true;
    });
  }

  async function remove(id) {
    return mutate(data => {
      const index = data.procedures.findIndex(item => item.id === id);
      if (index < 0) return false;
      data.procedures.splice(index, 1);
      return true;
    });
  }

  async function stats() {
    const data = await load();
    return {
      total: data.procedures.length,
      active: data.procedures.filter(item => (item.status || 'active') === 'active').length,
      apps: [...new Set(data.procedures.map(item => item.appKey))].length,
      max,
    };
  }

  return { list, get, find, save, report, retire, remove, stats, file, max };
}

module.exports = {
  createProcedureStore,
  fingerprintOf,
  exeOf,
  normalizeStep,
  MAX_STEPS,
  MAX_PROCEDURES,
};
