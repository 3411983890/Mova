'use strict';
// A site card is the cheap half of "memory": the handful of landmarks that help
// an agent orient on a familiar page, without storing a full procedure.

const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;
const MAX_CARDS = 500;

function clean(value, limit = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : '';
  } catch {
    return '';
  }
}

function patternOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.pathname.split('/').map(segment => (/^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment) ? ':id' : segment)).join('/') || '/';
  } catch {
    return '/';
  }
}

function landmarkOf(entries, predicate, fallback) {
  const row = (Array.isArray(entries) ? entries : []).find(entry => predicate(entry) && entry.name);
  return row ? { role: row.role, name: row.name, ref: row.ref || '' } : fallback || null;
}

function createSiteCardStore({ directory } = {}) {
  if (typeof directory !== 'string' || !directory) throw new Error('directory is required');
  const file = join(directory, 'sites.json');
  let queue = Promise.resolve();
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      cache = value && value.version === VERSION && Array.isArray(value.sites) ? value : { version: VERSION, sites: [] };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('无法读取站点卡片', { cause: error });
      cache = { version: VERSION, sites: [] };
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

  async function update({ url, title, entries } = {}) {
    const origin = originOf(url);
    if (!origin) return null;
    const pathPattern = patternOf(url);
    const landmarks = {
      search: landmarkOf(entries, entry => ['searchbox', 'textbox'].includes(entry.role) && /搜索|查询|search|query|filter/i.test(entry.name)),
      list: landmarkOf(entries, entry => ['table', 'grid', 'list'].includes(entry.role)),
      primaryAction: landmarkOf(entries, entry => ['button', 'link'].includes(entry.role)),
    };
    return mutate(data => {
      const index = data.sites.findIndex(site => site.origin === origin && site.pathPattern === pathPattern);
      const previous = index >= 0 ? data.sites[index] : null;
      const record = {
        origin,
        pathPattern,
        title: clean(title || previous?.title || ''),
        landmarks: Object.fromEntries(Object.entries(landmarks).filter(([, value]) => value)),
        notes: clean(previous?.notes || '', 240),
        visits: (previous?.visits || 0) + 1,
        lastSeenAt: new Date().toISOString(),
      };
      if (index >= 0) data.sites[index] = record;
      else data.sites.unshift(record);
      if (data.sites.length > MAX_CARDS) data.sites.length = MAX_CARDS;
      return record;
    });
  }

  async function get(url) {
    const data = await load();
    const origin = originOf(url);
    const pathPattern = patternOf(url);
    const exact = data.sites.find(site => site.origin === origin && site.pathPattern === pathPattern);
    if (exact) return exact;
    return data.sites.find(site => site.origin === origin && pathPattern.startsWith(site.pathPattern)) || null;
  }

  async function list() {
    const data = await load();
    return data.sites.map(site => ({ ...site }));
  }

  /**
   * 清空站点卡片：给 origin 就只清该站点，不带就清全部。
   * 只删除学到的地标与备注，不动技能（那些在 procedures.json）。
   */
  async function clear(input = {}) {
    const origin = typeof input?.origin === 'string' ? input.origin : '';
    let removed = 0;
    await mutate(data => {
      const before = data.sites.length;
      data.sites = origin ? data.sites.filter(site => site.origin !== origin) : [];
      removed = before - data.sites.length;
    });
    return { cleared: removed };
  }

  return { update, get, list, clear, file };
}

module.exports = { createSiteCardStore, originOf, patternOf, MAX_CARDS };
