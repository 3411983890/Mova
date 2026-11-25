'use strict';

// 引用校验（Wave D）：把答案里的 [n] 编号对回证据，并粗查「这句话是否真被证据支撑」。
// 纯函数、无 I/O、无模型调用：同样的输入永远得到同样的结果，便于离线测试与回退。

// [1] / [1,3] / [1-3]（也容忍全角逗号与短横线）。
const MARKER = /\[\s*(\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,，、]\s*\d+(?:\s*[-–—]\s*\d+)?)*)\s*\]/g;
// 展开 [1-3] 时最多展开这么多项，避免 [1-999999] 把内存吃光。
const RANGE_MAX = 64;
const CLAIM_MAX_CHARS = 200;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'you', 'your',
  'this', 'that', 'these', 'those', 'from', 'they', 'them', 'their', 'there', 'here', 'into', 'than',
  'then', 'when', 'where', 'which', 'while', 'what', 'who', 'whom', 'whose', 'why', 'how', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'about', 'also', 'such',
  'been', 'being', 'because', 'before', 'after', 'between', 'both', 'each', 'more', 'most', 'other',
  'some', 'only', 'over', 'very', 'much', 'many', 'said', 'says', 'according', 'source', 'sources',
  '的', '了', '是', '在', '和', '与', '或', '有', '吗', '呢', '吧', '被', '把', '对', '也', '都', '还',
  '而', '及', '其', '中', '上', '下', '为', '以', '于', '这', '那', '一个', '我们', '他们', '可以',
  '什么', '怎么', '如何', '哪些', '哪个', '以及', '并且', '但是', '因为', '所以', '如果', '没有',
]);

/** 证据正文：pages[].text 优先，其次 snippet，最后 content。 */
function evidenceText(item) {
  if (!item || typeof item !== 'object') return '';
  const pages = Array.isArray(item.pages) ? item.pages : [];
  const parts = pages
    .map(page => (typeof page?.text === 'string' ? page.text : ''))
    .filter(text => text.trim());
  if (parts.length) return parts.join('\n');
  if (typeof item.snippet === 'string' && item.snippet.trim()) return item.snippet;
  if (typeof item.content === 'string' && item.content.trim()) return item.content;
  return '';
}

function expandGroup(group) {
  const numbers = [];
  for (const part of String(group).split(/[,，、]/)) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end >= start && end - start <= RANGE_MAX) {
        for (let value = start; value <= end; value += 1) numbers.push(value);
      } else {
        numbers.push(start, end);
      }
      continue;
    }
    const single = piece.match(/\d+/);
    if (single) numbers.push(Number(single[0]));
  }
  return numbers;
}

/** 答案里出现的全部引用编号（按出现顺序，含重复），[1,3] 记 2 处。 */
function citationNumbers(text) {
  const numbers = [];
  for (const match of String(text ?? '').matchAll(MARKER)) numbers.push(...expandGroup(match[1]));
  return numbers;
}

/** 代码围栏整段挖掉：里面的 [n] 是代码，不是引用，也不构成断言。 */
function stripFences(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, '\n\n');
}

/** 去代码围栏后按 。！？!? 与换行断句；拉丁句点只在后接空白/结尾时才断句。 */
function splitSentences(answer) {
  const body = stripFences(answer);
  const sentences = [];
  let buffer = '';
  const flush = () => {
    const value = buffer.trim();
    buffer = '';
    if (value) sentences.push(value);
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    buffer += char;
    if ('。！？!?\n'.includes(char)) {
      flush();
      continue;
    }
    if (char === '.' && (index + 1 >= body.length || /\s/.test(body[index + 1]))) flush();
  }
  flush();
  return sentences;
}

/** 内容词：拉丁词 ≥3 字符（小写）、CJK 二元组；去停用词，纯数字不进来。 */
function contentTokens(text) {
  const value = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const word of value.match(/[a-z][a-z0-9_+#.'-]*/g) || []) {
    const clean = word.replace(/[.'-]+$/, '');
    if (clean.length < 3 || STOPWORDS.has(clean)) continue;
    tokens.add(clean);
  }
  for (const run of value.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (STOPWORDS.has(bigram)) continue;
      tokens.add(bigram);
    }
  }
  return tokens;
}

/** 数字/日期：必须逐字出现在证据里才算数。 */
function digitTokens(text) {
  const tokens = new Set();
  for (const match of String(text ?? '').match(/\d[\d.,:/-]*\d|\d/g) || []) {
    if (match.length <= 40) tokens.add(match);
  }
  return tokens;
}

function coverageOf(claimTokens, sourceTokens) {
  if (!claimTokens.size) return 0;
  let shared = 0;
  for (const token of claimTokens) if (sourceTokens.has(token)) shared += 1;
  return shared / claimTokens.size;
}

/** 一条证据是否支撑这句断言：覆盖率达标，且断言里的数字都能在证据里找到。 */
function supportsClaim(claimTokens, claimDigits, source, threshold) {
  if (!claimTokens.size) return false;
  for (const digit of claimDigits) if (!source.includes(digit)) return false;
  const sourceTokens = contentTokens(source);
  if (!sourceTokens.size) return false;
  return coverageOf(claimTokens, sourceTokens) >= threshold;
}

/**
 * 证据的两种形态：Evidence[]（整轮共用一个编号空间）或 Evidence[][]（每次工具调用一个批次，
 * 各自从 1 编号）。空数组按单数组处理，两者对空证据的结论一致。
 */
function asBatches(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return null;
  return evidence.every(Array.isArray) ? evidence : null;
}

/**
 * 校验答案里的引用。
 * @param {string} answer 模型答案（可含 [n]）
 * @param {Array|Array[]} evidence 单数组时编号 = 下标 + 1；批次数组时 n 解析为「各批次第 n 条」的并集
 * @param {{threshold?: number}} [options] 断言被证据支撑所需的最小词覆盖率
 */
function validateCitations(answer, evidence, { threshold = 0.5 } = {}) {
  const batches = asBatches(evidence);
  const list = Array.isArray(evidence) && !batches ? evidence : [];
  const text = typeof answer === 'string' ? answer : '';
  const body = stripFences(text);
  const limit = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.5;
  const markers = citationNumbers(body);

  // 编号 n 在该证据形态下能对上的全部正文（批次模式下可能来自多个批次）。
  const cache = new Map();
  const sourcesFor = n => {
    if (cache.has(n)) return cache.get(n);
    let sources;
    if (!Number.isInteger(n) || n < 1) {
      sources = [];
    } else if (batches) {
      sources = [];
      for (const batch of batches) {
        const item = Array.isArray(batch) ? batch[n - 1] : undefined;
        if (item) sources.push(evidenceText(item));
      }
    } else {
      // 单数组保持既有语义：n ≤ 长度即存在（即使该位置是空值，也只是正文为空）。
      sources = n <= list.length ? [evidenceText(list[n - 1])] : [];
    }
    cache.set(n, sources);
    return sources;
  };

  const used = [...new Set(markers)].sort((a, b) => a - b);
  const missing = used.filter(n => sourcesFor(n).length === 0);

  const unsupported = [];
  for (const sentence of splitSentences(text)) {
    const cited = citationNumbers(sentence);
    if (!cited.length) continue; // 没有 [n] 的句子不是断言
    const claimBody = sentence.replace(MARKER, ' ').replace(/\s+/g, ' ').trim();
    const claimTokens = contentTokens(claimBody);
    const claimDigits = digitTokens(claimBody);
    const candidates = [...new Set(cited)].filter(n => sourcesFor(n).length > 0);
    if (!candidates.length) continue; // 编号不存在已在 missing 里报过
    // 批次模式下同一个 n 可能指向多篇文档：任一篇能支撑这句断言即可。
    const supported = candidates.some(n => sourcesFor(n)
      .some(source => supportsClaim(claimTokens, claimDigits, source, limit)));
    if (!supported) unsupported.push({ n: candidates[0], claim: claimBody.slice(0, CLAIM_MAX_CHARS) });
  }

  return {
    total: markers.length,
    used,
    missing,
    unsupported,
    ok: missing.length === 0 && unsupported.length === 0,
  };
}

/** 中文短说明：ok 时返回空串。 */
function describeIssues(result) {
  if (!result || result.ok === true) return '';
  const missing = Array.isArray(result.missing) ? result.missing : [];
  const unsupported = Array.isArray(result.unsupported) ? result.unsupported : [];
  const parts = [];
  if (missing.length) parts.push(`引用了证据里不存在的编号 [${missing.join('、')}]`);
  if (unsupported.length) {
    const first = unsupported[0];
    const snippet = String(first?.claim || '').slice(0, 40);
    parts.push(`有 ${unsupported.length} 句引用的证据不足以支撑其说法（例如「${snippet}」引用的 [${first?.n}]）`);
  }
  if (!parts.length) return '';
  return `引用校验未通过：${parts.join('；')}。请删掉或改写没有出处的断言，必要时重新检索取证。`;
}

module.exports = { validateCitations, describeIssues, evidenceText };
