'use strict';

// 选段有两套实现：
//   关键词版（Wave A）：按命中词频排序取 topK，不依赖任何模型，永远可用。
//   向量版（Wave D）：`embed` 由调用方注入（e5 等），chunk → cosine → MMR。
// 入口统一是 `select(text, question, { topK, maxChars, embed })`：
//   没传 embed 时同步返回数组（既有调用方、含 search/index.cjs 都不需要改）；
//   传了 embed 时返回 Promise<数组>，任何一步失败都会落回关键词版。
// 本模块不 require @huggingface/transformers：向量依赖一律注入。

const DEFAULT_SIZE = 1200;
const DEFAULT_OVERLAP = 200;
const MAX_PAGES = 200;
// MMR 的权衡系数：1 = 只看相似度，0 = 只看去重。
const MMR_LAMBDA = 0.7;
// 与已选段落 jaccard ≥ 该值即视为近重复，直接丢弃。
const DUPLICATE_JACCARD = 0.6;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'what', 'which', 'who', 'how', 'why', 'when', 'where', 'does', 'do', 'did', 'be', 'this', 'that',
  '的', '了', '是', '在', '和', '与', '或', '有', '吗', '呢', '吧', '什么', '怎么', '如何', '哪些', '哪个',
]);

function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 按句/行边界对齐字符窗口切块（保留 start 偏移，便于回指原文）；overlap 最多半个窗口。
// 切点最多向边界回退多少字：句末标点/换行优先，空白兜底，最后才是 URL 守卫。
const SNAP_WINDOW = 120;
// URL 整词：切点落在这段中间就会切出半截链接（“pm.org.hk/tc/...” 那种）。
const URL_PATTERN = /https?:\/\/[^\s<>"'）)】\]，。；、]+/g;

function isSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u3000';
}

/** 切点（body[cut-1] 与 body[cut] 之间）是否落在句末/行末。 */
function isSentenceCut(body, cut) {
  const prev = body[cut - 1];
  if (prev === undefined) return false;
  if (prev === '\n' || prev === '。' || prev === '！' || prev === '？') return true;
  if (prev === '.' || prev === '!' || prev === '?') {
    const next = body[cut];
    return next === undefined || isSpaceChar(next) || /["'”’)\]】」』]/.test(next);
  }
  return false;
}

/** 切点是否落在 URL 中间；是则返回该 URL 的 [start, end)，否则 null。 */
function urlSpanAt(body, cut) {
  URL_PATTERN.lastIndex = 0;
  let match = URL_PATTERN.exec(body);
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < cut && cut < end) return { start, end };
    if (start >= cut) break;
    match = URL_PATTERN.exec(body);
  }
  return null;
}

/** 起点向回对齐到最近的句末/空白边界（不会超过 window，避免把上一块整个吞进来）。 */
function snapChunkStart(body, cursor, window) {
  if (cursor <= 0) return 0;
  const floor = Math.max(0, cursor - Math.max(1, window));
  for (let cut = cursor; cut > floor; cut -= 1) {
    if (isSentenceCut(body, cut)) return cut;
  }
  for (let cut = cursor; cut > floor; cut -= 1) {
    if (isSpaceChar(body[cut - 1])) return cut;
  }
  return cursor;
}

/** 终点向回对齐：句末/换行 → 空白 → 原样（URL 守卫在 chunk 里单独做）。 */
function snapChunkEnd(body, start, end, window) {
  const floor = Math.max(start + 1, end - Math.max(1, window));
  for (let cut = end; cut > floor; cut -= 1) {
    if (isSentenceCut(body, cut)) return cut;
  }
  for (let cut = end; cut > floor; cut -= 1) {
    if (isSpaceChar(body[cut - 1])) return cut;
  }
  return end;
}

function chunk(text, { size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
  const body = normalizeText(text);
  if (!body) return [];
  const width = Math.max(1, Math.floor(Number(size)) || DEFAULT_SIZE);
  const rawOverlap = Math.floor(Number(overlap));
  const gap = Number.isFinite(rawOverlap) ? Math.min(Math.max(0, rawOverlap), Math.floor(width / 2)) : 0;
  const step = Math.max(1, width - gap);
  const window = Math.min(SNAP_WINDOW, width);
  const pages = [];

  for (let base = 0; base < body.length && pages.length < MAX_PAGES; base += step) {
    // 起点只在有 overlap 时才向回对齐：overlap=0 时起点就是上一块的终点，已经对齐过。
    const startWindow = gap > 0 ? Math.min(window, gap) : 0;
    let start = startWindow ? snapChunkStart(body, base, startWindow) : base;
    if (start < 0) start = 0;
    if (start > base) start = base;
    const previous = pages[pages.length - 1];
    if (previous && start <= previous.start) start = previous.start + 1;
    if (start >= body.length) break;

    // 起点落在链接中间：上一块已经含到链接末尾就跳到链接之后，否则退回链接开头，两种都不丢字。
    const opening = urlSpanAt(body, start);
    if (opening) {
      const previousEnd = previous ? previous.start + previous.text.length : 0;
      if (previousEnd >= opening.end) start = opening.end;
      else if (opening.start > (previous ? previous.start : -1)) start = opening.start;
      if (start >= body.length) break;
    }

    let end = Math.min(body.length, start + width);
    if (end < body.length) {
      let snapped = snapChunkEnd(body, start, end, window);
      // URL 守卫：切在链接中间时，宁可整条包含进来（短链接）或整条留给下一块（长链接）。
      const span = urlSpanAt(body, snapped);
      if (span) {
        if (span.end - start <= width + SNAP_WINDOW) snapped = span.end;
        else if (span.start > start) snapped = span.start;
      }
      // 底线：下一块的起点不能超过本块终点，否则中间的字符会既不属于前一块也不属于后一块。
      const floor = Math.min(base + step, body.length);
      end = snapped > end ? snapped : Math.max(snapped, floor);
      if (end <= start) end = Math.min(body.length, start + width);
    }

    pages.push({ text: body.slice(start, end), start });
  }
  return pages;
}

function tokenize(text) {
  const value = typeof text === 'string' ? text.toLowerCase() : '';
  const tokens = [];
  for (const match of value.match(/[a-z0-9][a-z0-9_+#.-]*/g) || []) tokens.push(match);
  for (const run of value.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) tokens.push(run);
    // 中文按二元组切分，避免整段当成一个词。
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

function questionTerms(question) {
  const terms = new Set();
  for (const token of tokenize(question)) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    terms.add(token);
  }
  return terms;
}

/** 词频加权：长词权重更高，短查询仍能命中。 */
function keywordScore(text, terms) {
  if (!terms.size) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let count = 0;
    let at = haystack.indexOf(term);
    while (at !== -1) {
      count += 1;
      at = haystack.indexOf(term, at + term.length);
    }
    if (count) score += count * (1 + Math.min(term.length, 8) / 8);
  }
  return score;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = Number(a[index]) || 0;
    const y = Number(b[index]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function jaccard(a, b) {
  const left = a instanceof Set ? a : new Set(Array.isArray(a) ? a : []);
  const right = b instanceof Set ? b : new Set(Array.isArray(b) ? b : []);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 关键词选段：按命中词频排序取 topK，再按原文顺序累积到 maxChars。
 * 返回 [{ text, start }]，与 Evidence.pages 同形状。
 */
function selectByKeywords(text, question, { topK = 4, maxChars = 6000, size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
  const pages = chunk(text, { size, overlap });
  if (!pages.length) return [];
  const limit = Number.isFinite(Number(topK)) && Number(topK) > 0 ? Math.floor(Number(topK)) : 4;
  const budget = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 6000;
  const terms = questionTerms(question);

  const ranked = pages
    .map((page, index) => ({
      page,
      index,
      score: keywordScore(page.text, terms) + jaccard(tokenize(page.text), terms),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // 全都没命中时按原文顺序取前 topK 段。
  const pool = ranked.some(entry => entry.score > 0)
    ? ranked.filter(entry => entry.score > 0)
    : ranked;
  const chosen = pool.slice(0, limit).sort((a, b) => a.page.start - b.page.start);

  const selected = [];
  let used = 0;
  for (const entry of chosen) {
    if (used >= budget) break;
    const room = budget - used;
    const piece = entry.page.text.length > room ? entry.page.text.slice(0, room) : entry.page.text;
    if (!piece) continue;
    selected.push({ text: piece, start: entry.page.start });
    used += piece.length;
  }
  return selected;
}

function asVector(row) {
  if (Array.isArray(row)) return row;
  if (row && ArrayBuffer.isView(row)) return Array.from(row);
  return null;
}

/** 注入的 embed 只能返回「等长同维、有限数值」的矩阵，否则视为坏形状。 */
function normalizeMatrix(rows, expected) {
  if (!Array.isArray(rows) || rows.length !== expected) throw new Error('embedding-count-mismatch');
  const matrix = rows.map(asVector);
  const width = matrix[0]?.length ?? 0;
  if (!width) throw new Error('embedding-empty');
  for (const row of matrix) {
    if (!row || row.length !== width) throw new Error('embedding-dim-mismatch');
    for (const value of row) if (!Number.isFinite(Number(value))) throw new Error('embedding-not-numeric');
  }
  return matrix;
}

/**
 * 向量选段（Wave D）：cosine(question, chunk) 排序，MMR + 近重复剔除后取 topK，
 * 再按原文顺序累积到 maxChars。任何异常（embed 缺失/抛错/坏形状/单段文档）都落回关键词版，
 * 检索功能不因向量不可用而中断。
 *
 * embed 可以是 `(texts) => number[][]`，也可以像本地 embedding 服务那样多接一个
 * `{ kind: 'query' | 'passage' }`；能写 e5 前缀的实现可据此区分查询与段落。
 */
async function selectByVectors(text, question, { topK = 4, maxChars = 6000, size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP, embed } = {}) {
  const keywordOptions = { topK, maxChars, size, overlap };
  if (typeof embed !== 'function') return selectByKeywords(text, question, keywordOptions);

  const pages = chunk(text, { size, overlap });
  // 单段文档没有选择空间：直接用关键词版，省一次模型调用。
  if (pages.length <= 1) return selectByKeywords(text, question, keywordOptions);

  let questionVec;
  let pageRows;
  try {
    const [questionRows, pagesRows] = await Promise.all([
      embed([String(question ?? '')], { kind: 'query' }),
      embed(pages.map(page => page.text), { kind: 'passage' }),
    ]);
    questionVec = normalizeMatrix(questionRows, 1)[0];
    pageRows = normalizeMatrix(pagesRows, pages.length);
  } catch {
    return selectByKeywords(text, question, keywordOptions);
  }
  if (questionVec.length !== pageRows[0].length) return selectByKeywords(text, question, keywordOptions);

  const limit = Number.isFinite(Number(topK)) && Number(topK) > 0 ? Math.floor(Number(topK)) : 4;
  const budget = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 6000;

  const remaining = pages
    .map((page, index) => ({
      page,
      index,
      score: cosine(questionVec, pageRows[index]),
      tokens: new Set(tokenize(page.text)),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // MMR：每轮在剩下的候选里挑「相似度高、和已选段落又不重复」的那一段。
  const chosen = [];
  while (chosen.length < limit && remaining.length) {
    let bestAt = -1;
    let bestValue = -Infinity;
    for (let at = 0; at < remaining.length; at += 1) {
      const candidate = remaining[at];
      let redundancy = 0;
      let duplicate = false;
      for (const picked of chosen) {
        const overlapRatio = jaccard(candidate.tokens, picked.tokens);
        if (overlapRatio >= DUPLICATE_JACCARD) { duplicate = true; break; }
        if (overlapRatio > redundancy) redundancy = overlapRatio;
      }
      if (duplicate) continue;
      const value = MMR_LAMBDA * candidate.score - (1 - MMR_LAMBDA) * redundancy;
      if (value > bestValue) { bestValue = value; bestAt = at; }
    }
    if (bestAt < 0) break;
    chosen.push(remaining.splice(bestAt, 1)[0]);
  }
  if (!chosen.length) return selectByKeywords(text, question, keywordOptions);

  const selected = [];
  let used = 0;
  for (const entry of chosen.sort((a, b) => a.page.start - b.page.start)) {
    if (used >= budget) break;
    const room = budget - used;
    const piece = entry.page.text.length > room ? entry.page.text.slice(0, room) : entry.page.text;
    if (!piece) continue;
    selected.push({ text: piece, start: entry.page.start });
    used += piece.length;
  }
  return selected.length ? selected : selectByKeywords(text, question, keywordOptions);
}

/**
 * 稳定入口：传入 embed 时返 Promise<[{ text, start }]>（走向量版），否则同步返回数组（关键词版）。
 */
function select(text, question, options = {}) {
  if (typeof options?.embed === 'function') return selectByVectors(text, question, options);
  return selectByKeywords(text, question, options);
}

module.exports = { chunk, selectByKeywords, selectByVectors, select, cosine, jaccard };
