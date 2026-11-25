'use strict';

const { canonicalUrl } = require('./fuse.cjs');

const MAX_QUOTE_CHARS = 600;
// 修剪后短于这个长度就退回未修剪的原文头：短引用（如「段落一」）不值得为对齐丢掉信息。
const MIN_TRIMMED_CHARS = 40;
const INDENT = '    ';

function hostOf(url) {
  try {
    const link = new URL(String(url));
    return link.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

function collapse(text) {
  return String(text ?? '').replace(/[\s\u3000]+/g, ' ').trim();
}

/** 切点（text[cut-1] 与 text[cut] 之间）是否落在句末/行末。 */
function isSentenceCut(text, cut) {
  const prev = text[cut - 1];
  if (prev === undefined) return false;
  if (prev === '\n' || prev === '。' || prev === '！' || prev === '？') return true;
  if (prev === '.' || prev === '!' || prev === '?') {
    const next = text[cut];
    return next === undefined || /\s/.test(next) || /["'”’)\]】」』]/.test(next);
  }
  return false;
}

function firstSentenceCut(text) {
  for (let cut = 1; cut <= text.length; cut += 1) if (isSentenceCut(text, cut)) return cut;
  return -1;
}

function lastSentenceCut(text) {
  for (let cut = text.length; cut >= 1; cut -= 1) if (isSentenceCut(text, cut)) return cut;
  return -1;
}

/** 找不到句末边界时，丢掉开头那段半截链接（“pm.org.hk/tc/...” 这种以 / 或 @ 出现、无空白的碎片）。 */
function dropLeadingFragment(body) {
  const match = /^(\S+)(\s+)([\s\S]*)$/.exec(body);
  if (!match) return body;
  const token = match[1];
  // / 或 @ + 域名点号/足够长：是链接碎片；像 2025/03/15 这种日期不动。
  if (!/[/@]/.test(token) || (!token.includes('.') && token.length < 16)) return body;
  return collapse(match[3]).length >= MIN_TRIMMED_CHARS ? match[3] : body;
}

/** 单段引用：掐掉首尾半句、压缩空白；修剪后过短则退回未修剪版本。 */
function trimQuote(text) {
  if (typeof text !== 'string') return '';
  const body = text.trim();
  if (!body) return '';

  const head = firstSentenceCut(body);
  // 首句边界只在中间才有意义：没有边界、或唯一边界就是句尾时，改看开头是不是半截链接。
  const trimmed = head > 0 && head < body.length ? body.slice(head).trim() : dropLeadingFragment(body);
  const tail = lastSentenceCut(trimmed);
  const cut = tail > 0 && tail < trimmed.length ? trimmed.slice(0, tail).trim() : trimmed;

  const collapsed = collapse(cut);
  if (!collapsed || collapsed.length >= MIN_TRIMMED_CHARS) return collapsed;
  return collapse(body);
}

function quoteOf(item) {
  const pages = Array.isArray(item?.pages) ? item.pages : [];
  const parts = pages
    .map(page => trimQuote(typeof page?.text === 'string' ? page.text : ''))
    .filter(Boolean);
  // 正文没读到时退回摘要：摘要至少是能核对的原文，比空引用有用（pack 仍会标「读取失败」）。
  if (!parts.length) {
    const fallback = trimQuote(typeof item?.snippet === 'string' ? item.snippet : '');
    return fallback.slice(0, MAX_QUOTE_CHARS);
  }
  return parts.join(' … ').slice(0, MAX_QUOTE_CHARS);
}

/** 渲染层用的来源摘要：id 是去重键，site 是去 www 的主机名。 */
function toSourceSummary(row = {}) {
  const url = typeof row.url === 'string' ? row.url : '';
  return {
    id: canonicalUrl(url),
    url,
    title: typeof row.title === 'string' ? row.title : '',
    site: hostOf(url),
    published: row.published || null,
  };
}

function headlineOf(item) {
  const title = typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : '';
  const site = typeof item?.site === 'string' && item.site.trim() ? item.site.trim() : hostOf(item?.url);
  const published = typeof item?.published === 'string' && item.published.trim() ? item.published.trim() : '';
  return [title || site || '(无标题)', site, published].filter(Boolean).join(' — ');
}

function explainMeta(meta = {}) {
  const queries = Array.isArray(meta.queries)
    ? meta.queries.filter(query => typeof query === 'string' && query.trim())
    : [];
  const count = value => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0);
  let line = `检索说明：queries=[${queries.join('; ')}] 候选 ${count(meta.candidates)} 条，`
    + `去重 ${count(meta.deduped)} 条，已读 ${count(meta.read)} 页，取 ${count(meta.passages)} 段。`;
  if (meta.budgetExhausted) line += '预算已用尽，结果可能不完整。';
  // 「没有结果」与「源不可达」是两件事：说错了会让人以为网上真的没有资料。
  if (count(meta.failed) > 0) {
    const sources = Array.isArray(meta.failedSources) && meta.failedSources.length
      ? `（${meta.failedSources.slice(0, 4).join('、')}）` : '';
    line += `${count(meta.failed)} 次检索请求失败${sources}，这不代表网上没有资料；可以重试或换一个搜索源。`;
  }
  if (typeof meta.note === 'string' && meta.note.trim()) line += `（${meta.note.trim()}）`;
  return line;
}

const CITE_HINT = '用 [n] 标注引用；若某断言找不到出处，写「未找到可核验来源」。';

/**
 * 纯文本证据块：编号条目 + 尾部检索说明。items 已按给定顺序编号（n = index + 1）。
 * 任何字段缺失都不抛错：标题回退站点，未读到正文时标注读取状态。
 */
function formatEvidence(items, meta = {}) {
  const list = Array.isArray(items) ? items : [];
  const blocks = [];

  if (!list.length) {
    blocks.push(Number(meta?.failed) > 0
      ? '检索没有拿到任何来源（搜索源请求失败，不代表网上没有资料）。'
      : '没有找到可用的公开来源。');
  } else {
    list.forEach((item, index) => {
      const lines = [`[${index + 1}] ${headlineOf(item)}`];
      const url = typeof item?.url === 'string' ? item.url.trim() : '';
      if (url) lines.push(`${INDENT}${url}`);
      const quote = quoteOf(item);
      if (quote) lines.push(`${INDENT}“${quote}”`);
      if (item?.readError) lines.push(`${INDENT}（读取失败：${String(item.readError).slice(0, 200)}）`);
      else if (!quote) lines.push(`${INDENT}（未读取正文）`);
      blocks.push(lines.join('\n'));
    });
  }

  blocks.push(explainMeta(meta));
  blocks.push(CITE_HINT);
  return blocks.join('\n\n');
}

module.exports = { toSourceSummary, formatEvidence };
