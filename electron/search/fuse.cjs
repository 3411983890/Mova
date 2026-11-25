'use strict';

const { sourceUrl } = require('./url.cjs');

// 去掉会制造重复的追踪参数：utm_*、spm、from、share_*、ref_*。
const TRACKING = [/^utm_/i, /^share_/i, /^ref_/i];
const TRACKING_EXACT = new Set(['spm', 'from']);

function isTracking(name) {
  return TRACKING_EXACT.has(name.toLowerCase()) || TRACKING.some(pattern => pattern.test(name));
}

/**
 * 去重键：host 小写、去尾部点、去 'www.'、去 hash、去追踪参数、
 * pathname 去结尾 '/'（根路径保留）、其余查询参数按 key 排序。
 * 非法 URL（以及 sourceUrl 拒绝的内网/非 http(s) 地址）返回 ''。
 */
function canonicalUrl(url) {
  // 复用 sourceUrl：sourceUrl 之外的地址本来就不允许离开本机，不做键。
  const link = sourceUrl(url);
  if (!link) return '';
  const host = link.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  let path = link.pathname.replace(/\/+$/, '');
  if (!path) path = '/';

  const pairs = [];
  for (const [name, value] of link.searchParams) {
    if (isTracking(name)) continue;
    pairs.push([name, value]);
  }
  // sort 是稳定的：同名参数保持原相对顺序。
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const search = new URLSearchParams();
  for (const [name, value] of pairs) search.append(name, value);
  const query = search.toString();

  const authority = link.port ? `${host}:${link.port}` : host;
  return `${link.protocol}//${authority}${path}${query ? `?${query}` : ''}`;
}

function firstFilled(current, next) {
  return current || next;
}

/**
 * Reciprocal Rank Fusion。batches 内每条 Row 的 rank 从 1 开始（内部已按 rank 升序）。
 * 同一 canonicalUrl 合并成一条：score 累加 1/(k+rank)，providers/queries 用 Set 去重，
 * published/snippet/content 取第一个非空值。
 */
function fuse(batches, { k = 60 } = {}) {
  const groups = new Map();
  const radius = Number.isFinite(Number(k)) ? Number(k) : 60;

  for (const batch of Array.isArray(batches) ? batches : []) {
    if (!Array.isArray(batch)) continue;
    batch.forEach((row, index) => {
      if (!row || typeof row.url !== 'string') return;
      const key = canonicalUrl(row.url);
      if (!key) return;
      const rank = Number.isFinite(row.rank) && row.rank > 0 ? row.rank : index + 1;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          row: { ...row, url: row.url },
          key,
          score: 1 / (radius + rank),
          providers: new Set(row.provider ? [row.provider] : []),
          queries: new Set(row.query ? [row.query] : []),
        });
        return;
      }
      existing.score += 1 / (radius + rank);
      if (row.provider) existing.providers.add(row.provider);
      if (row.query) existing.queries.add(row.query);
      const merged = existing.row;
      merged.title = firstFilled(merged.title, row.title);
      merged.snippet = firstFilled(merged.snippet, row.snippet);
      merged.content = firstFilled(merged.content, row.content);
      merged.published = firstFilled(merged.published, row.published);
    });
  }

  return [...groups.values()]
    .map(group => ({
      ...group.row,
      key: group.key,
      score: group.score,
      providers: group.providers,
      queries: group.queries,
    }))
    .sort((a, b) => b.score - a.score);
}

module.exports = { canonicalUrl, fuse };
