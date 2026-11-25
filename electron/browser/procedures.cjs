'use strict';
// Site skills: reusable declarative browser steps, scoped to an origin/path.
// Stored as one small JSON file for now; the interface is deliberately close to
// what a PostgreSQL/pgvector table would expose later.

const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;
const MAX_PROCEDURES = 200;
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

function patternOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.pathname
      .split('/')
      .map(segment => (/^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment) ? ':id' : segment))
      .join('/') || '/';
  } catch {
    return '/';
  }
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : '';
  } catch {
    return '';
  }
}

function stepsFromTrace(trace) {
  const steps = [];
  for (const action of Array.isArray(trace) ? trace : []) {
    if (!action || typeof action !== 'object') continue;
    if (action.op === 'navigate' && action.url) {
      if (!steps.length) steps.push({ op: 'navigate', url: action.url });
      continue;
    }
    if (!['click', 'fill', 'type', 'press', 'select', 'check', 'hover'].includes(action.op)) continue;
    const step = { op: action.op };
    if (action.selector) step.target = action.selector;
    if (action.op === 'press' && action.key) step.value = action.key;
    if ((action.op === 'fill' || action.op === 'type' || action.op === 'select') && action.saveValue === true && typeof action.value === 'string') {
      step.value = action.value;
    }
    if (steps.length >= MAX_STEPS) break;
    steps.push(step);
  }
  return steps;
}

function fingerprintOf(steps) {
  return JSON.stringify(steps.map(step => [step.op, step.target || '', step.value || '']));
}

/** 成功率只按真实跑过的次数算；没跑过时返回 null，避免「100% 成功」的假象。 */
function successRateOf(stats) {
  const ok = Number(stats?.ok) || 0;
  const fail = Number(stats?.fail) || 0;
  const total = ok + fail;
  return total > 0 ? Math.round((ok / total) * 100) : null;
}

function createProcedureStore({ directory } = {}) {
  if (typeof directory !== 'string' || !directory) throw coded('invalid-input', 'directory is required');
  const file = join(directory, 'procedures.json');
  let queue = Promise.resolve();
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const text = await readFile(file, 'utf8');
      const value = JSON.parse(text);
      cache = value && value.version === VERSION && Array.isArray(value.procedures) ? value : { version: VERSION, procedures: [] };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw coded('storage-error', '无法读取站点技能');
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

  async function list() {
    const data = await load();
    return data.procedures.map(item => ({ ...item, steps: undefined, stepCount: item.steps.length }));
  }

  async function get(id) {
    const data = await load();
    const found = data.procedures.find(item => item.id === id);
    if (!found) throw coded('procedure-not-found', '站点技能不存在');
    return JSON.parse(JSON.stringify(found));
  }

  function score(procedure, intent) {
    const words = String(intent || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    const haystack = `${procedure.title} ${(procedure.intent || []).join(' ')}`.toLowerCase();
    return words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
  }

  async function find({ url, origin, intent, limit = 3 } = {}) {
    const data = await load();
    const targetOrigin = origin ? originOf(origin) || origin : originOf(url);
    const path = patternOf(url);
    return data.procedures
      .filter(item => !targetOrigin || item.origin === targetOrigin)
      .map(item => ({
        item,
        pathScore: item.pathPattern === path ? 3 : (path.startsWith(item.pathPattern) ? 1 : 0),
        intentScore: score(item, intent),
      }))
      .filter(row => row.pathScore > 0 || row.intentScore > 0)
      .sort((a, b) => (b.pathScore + b.intentScore + (b.item.stats?.ok || 0) * 0.01)
        - (a.pathScore + a.intentScore + (a.item.stats?.ok || 0) * 0.01))
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 3)))
      .map(row => ({
        id: row.item.id,
        title: row.item.title,
        origin: row.item.origin,
        pathPattern: row.item.pathPattern,
        steps: row.item.steps.length,
        stats: row.item.stats || { ok: 0, fail: 0 },
        // 已验证流程要能被模型一眼判断「值不值得重放」：成功率 + 平均耗时。
        successRate: successRateOf(row.item.stats),
        avgMs: Math.round(Number(row.item.stats?.avgMs) || 0),
      }));
  }

  async function save(input = {}) {
    const origin = originOf(input.origin || input.url);
    if (!origin) throw coded('invalid-origin', '只有 http(s) 站点可以保存技能');
    const steps = Array.isArray(input.steps) ? input.steps.slice(0, MAX_STEPS) : [];
    if (!steps.length) throw coded('invalid-input', '技能至少需要一步');
    const record = {
      id: input.id || `sk_${randomUUID().slice(0, 8)}`,
      origin,
      pathPattern: input.pathPattern || patternOf(input.url),
      title: clean(input.title || input.pageTitle || '未命名流程', 80),
      intent: Array.isArray(input.intent) ? input.intent.map(item => clean(item, 40)).filter(Boolean).slice(0, 12) : [],
      steps,
      verify: input.verify && typeof input.verify === 'object' ? input.verify : null,
      version: 1,
      fingerprint: fingerprintOf(steps),
      stats: input.stats || { ok: 0, fail: 0, avgMs: 0, lastUsedAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return mutate(data => {
      const index = data.procedures.findIndex(item => item.id === record.id);
      if (index >= 0) { record.createdAt = data.procedures[index].createdAt; data.procedures[index] = record; }
      else data.procedures.unshift(record);
      if (data.procedures.length > MAX_PROCEDURES) data.procedures.length = MAX_PROCEDURES;
      return record;
    });
  }

  /** Silent draft from a successful multi-step run; dedupes on step fingerprint. */
  async function saveFromTrace({ trace, url, title, intent, minSteps = 2 } = {}) {
    const steps = stepsFromTrace(trace);
    if (steps.length < Math.max(2, minSteps)) return null;
    const origin = originOf(url);
    if (!origin) return null;
    const fingerprint = fingerprintOf(steps);
    const data = await load();
    const existing = data.procedures.find(item => item.origin === origin && item.fingerprint === fingerprint);
    if (existing) {
      return mutate(rows => {
        const item = rows.procedures.find(row => row.id === existing.id);
        if (item) { item.updatedAt = new Date().toISOString(); item.stats = { ...item.stats, ok: (item.stats?.ok || 0) + 1 }; }
        return item ? { id: item.id, title: item.title, reused: true } : null;
      });
    }
    const record = await save({
      url,
      title: title || '自动记录流程',
      intent: intent ? [intent] : [],
      steps,
    });
    return { id: record.id, title: record.title, reused: false };
  }

  async function report(id, { ok, ms } = {}) {
    return mutate(data => {
      const item = data.procedures.find(row => row.id === id);
      if (!item) return null;
      item.stats = item.stats || { ok: 0, fail: 0, avgMs: 0, lastUsedAt: null };
      if (ok) item.stats.ok = (item.stats.ok || 0) + 1;
      else item.stats.fail = (item.stats.fail || 0) + 1;
      if (Number.isFinite(ms)) item.stats.avgMs = Math.round(((item.stats.avgMs || 0) * 0.7) + ms * 0.3);
      item.stats.lastUsedAt = new Date().toISOString();
      item.updatedAt = item.stats.lastUsedAt;
      return item.stats;
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

  return { list, get, find, save, saveFromTrace, report, remove, file, patternOf };
}

module.exports = { createProcedureStore, stepsFromTrace, patternOf, originOf, fingerprintOf, successRateOf, MAX_STEPS };
