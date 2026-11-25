'use strict';

// 权威站点：文档、代码托管、论文、百科、通讯社、央媒。
const AUTHORITY = [
  'developer.mozilla.org',
  'github.com',
  'arxiv.org',
  'wikipedia.org',
  'nature.com',
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'xinhuanet.com',
  'people.com.cn',
];

// 低质量：内容农场 / 纯聚合 / 面向 SEO 的教程站（人工挑选，宁少勿滥）。
const LOW_QUALITY = [
  'pinterest.com',
  'quora.com',
  'answers.com',
  'ehow.com',
  'wikihow.com',
  'geeksforgeeks.org',
  'tutorialspoint.com',
  'baijiahao.baidu.com',
];

const DAY = 24 * 60 * 60 * 1000;

// 查询词：CJK 用二元组，拉丁字母/数字词取长度 ≥3 的整词（与 passage.tokenize 的口径一致）。
const LATIN_WORD = /[a-z0-9][a-z0-9_+#.-]*/g;
const CJK_RUN = /[\u4e00-\u9fff]+/g;
// 词面重合度的放大系数：weighted = score * weight * (1 + 0.5 * overlap)。
const OVERLAP_BOOST = 0.5;

function hostOf(url) {
  try {
    const link = new URL(String(url));
    return link.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isInstitutional(host) {
  return /(^|\.)(gov|edu|mil)$/.test(host) || /\.ac\.[a-z]{2,}$/.test(host);
}

function ageInDays(published, now) {
  if (typeof published !== 'string' || !published.trim()) return null;
  const at = Date.parse(published);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (now - at) / DAY);
}

function weightOf(row, recency, now, host) {
  let weight = 1;
  if (isInstitutional(host)) weight += 0.35;
  if (AUTHORITY.some(domain => matches(host, domain))) weight += 0.25;
  if (LOW_QUALITY.some(domain => matches(host, domain))) weight -= 0.15;

  const age = ageInDays(row?.published, now);
  if (age !== null) {
    if (recency === 'month') weight += age <= 31 ? 0.3 : -0.4;
    else if (recency === 'year') weight += age <= 365 ? 0.2 : -0.3;
    if (age <= 3) weight += 0.1;
  }
  return weight;
}

/**
 * 查询词表：CJK 二元组 + 拉丁词（≥3 字），小写、去重、保持出现顺序。
 * 与查询长度无关（只用于算「命中比例」），空查询返回空数组。
 */
function queryTerms(query) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const value = query.toLowerCase();
  const terms = new Set();
  for (const word of value.match(LATIN_WORD) || []) {
    if (word.length >= 3) terms.add(word);
  }
  for (const run of value.match(CJK_RUN) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  return [...terms];
}

/**
 * 词面重合度（0..1）：查询词里有多少比例出现在 `title + ' ' + snippet` 中（小写、按子串判定）。
 * 没有 query 或没有词时恒为 0，所以此时排序与旧行为完全一致。
 */
function lexicalOverlap(row) {
  const terms = queryTerms(row?.query);
  if (!terms.length) return 0;
  const title = typeof row?.title === 'string' ? row.title : '';
  const snippet = typeof row?.snippet === 'string' ? row.snippet : '';
  const haystack = `${title} ${snippet}`.toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits / terms.length;
}

/**
 * 权威度 + 时效 + 词面重合 + 同域限流。row.weight 默认 1；没有 score 的 row 按 rank 反推
 * score = 1/(60+rank)。排序键是 score * weight * (1 + 0.5 * overlap)：
 * RRF 分数彼此只差千分之几时，标题/摘要命中查询词的那条才排得上来。overlap 为 0 时乘数为 1，
 * 与旧行为逐位一致。返回新数组，同一 host 最多 perHost 条。
 */
function rerank(rows, { recency = 'any', now = Date.now(), perHost = 2 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const at = typeof now === 'function' ? now() : Number(now) || Date.now();
  const cap = Number.isFinite(Number(perHost)) && Number(perHost) > 0 ? Math.floor(Number(perHost)) : 2;

  const scored = list.map((row, index) => {
    const host = hostOf(row?.url);
    const score = Number.isFinite(row?.score)
      ? row.score
      : 1 / (60 + (Number.isFinite(row?.rank) && row.rank > 0 ? row.rank : index + 1));
    const weight = weightOf(row, recency, at, host);
    const overlap = lexicalOverlap(row);
    return {
      row,
      host,
      score,
      weight,
      overlap,
      value: score * weight * (1 + OVERLAP_BOOST * overlap),
      index,
    };
  });

  scored.sort((a, b) => (b.value - a.value) || a.index - b.index);

  const seen = new Map();
  const output = [];
  for (const entry of scored) {
    const host = entry.host || '';
    const used = seen.get(host) || 0;
    if (host && used >= cap) continue;
    seen.set(host, used + 1);
    output.push({ ...entry.row, weight: entry.weight });
  }
  return output;
}

module.exports = { rerank, queryTerms, lexicalOverlap, AUTHORITY, LOW_QUALITY };
