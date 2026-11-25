'use strict';
// Memory quality primitives for long-term memory.
//
// These helpers are pure: no Electron, no database, no network, no clock, no
// randomness. The same input always produces the same output so the caller can
// replay or compare runs.
//
// Assumptions (contract):
// 1. `normalizeMemoryText` exists for comparison and hashing only. Storage must
//    keep the raw user text; never persist the normalized form.
// 2. Case folding happens inside `memoryHash` only, so "MySQL" and "mysql" hash
//    the same while stored text keeps its original casing.
// 3. `classifyConflict` is a conservative heuristic, not a judge. 'conflict'
//    means "keep both and ask the user" (see 6.3 of the memory spec); it never
//    implies an automatic overwrite.
// 4. `estimateTokens` is a character-class approximation, not a tokenizer. It
//    deliberately over-estimates so budgets stay on the safe side.
// 5. `selectWithinBudget` preserves input order; it never reorders by score.
// 6. `escapeMemoryData` returns JSON text whose `<` and `>` are escaped, so an
//    untrusted memory cannot close a delimiter element such as </memory>.

const { createHash } = require('node:crypto');

const CONFLICT_KINDS = Object.freeze({
  DUPLICATE: 'duplicate',
  NEAR_DUPLICATE: 'near-duplicate',
  CONFLICT: 'conflict',
  DISTINCT: 'distinct',
});

const DEFAULT_BUDGET = Object.freeze({ maxItems: 12, maxTokens: 6000 });

// Hard ceiling for one text. Keeps a corrupted/oversized row from producing an
// absurd number that overflows downstream arithmetic.
const MAX_TOKEN_ESTIMATE = 1_000_000;

const NEAR_DUPLICATE_THRESHOLD = 0.7;
const HIGH_RISK_NEAR_DUPLICATE_THRESHOLD = 0.85;
const CONFLICT_OVERLAP_FLOOR = 0.5;
const POLARITY_OVERLAP_FLOOR = 0.34;

// CJK ideographs, kana and hangul. Used by normalization, tokenization and the
// token estimator.
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const CJK_CHARS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu;
const CJK_RUNS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/gu;

// Punctuation that is not part of the full-width ASCII block (U+FF01..U+FF5E),
// which is folded separately by code point offset.
const PUNCTUATION_MAP = Object.freeze({
  '\u3002': '.', // 。
  '\u3001': ',', // 、
  '\u300c': '"', // 「
  '\u300d': '"', // 」
  '\u300e': '"', // 『
  '\u300f': '"', // 』
  '\u2018': "'", // ‘
  '\u2019': "'", // ’
  '\u201c': '"', // “
  '\u201d': '"', // ”
  '\u2013': '-', // –
  '\u2014': '-', // —
  '\u2015': '-', // ―
  '\u2212': '-', // −
  '\u2026': '...', // …
  '\u30fb': '.', // ・
  '\u00b7': '.', // ·
  '\u00a0': ' ', // NBSP
  '\u3000': ' ', // ideographic space
  '\u2007': ' ',
  '\u202f': ' ',
  '\u200b': '', // zero-width space
  '\u200c': '',
  '\u200d': '',
  '\ufeff': '',
  '\u00ad': '', // soft hyphen
});

const LATIN_TOKENS = /[a-z0-9]+(?:[._+#-][a-z0-9]+)*/g;
const LATIN_WORDS = /[A-Za-z0-9]+(?:[._+#@'-][A-Za-z0-9]+)*/g;
const PUNCTUATION_CHARS = /[.,;:!?'"`~()[\]{}\\-_/|@#$%^&*+=<>，。！？；：、“”‘’（）【】《》〈〉「」『』…—–·]/g;
const EDGE_SPACE_BEFORE_PUNCT = /(?<=[\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[,.;:!?])/gu;
const EDGE_SPACE_AFTER_PUNCT = /(?<=[,.;:!?])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/gu;

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

// Surface normalization only: whitespace, Unicode width and punctuation
// variants, NFC composition. Case is intentionally preserved.
function normalizeMemoryText(text) {
  const raw = asText(text);
  if (!raw) return '';
  let out = '';
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
      continue;
    }
    const mapped = PUNCTUATION_MAP[char];
    out += mapped === undefined ? char : mapped;
  }
  return out
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(EDGE_SPACE_BEFORE_PUNCT, '')
    .replace(EDGE_SPACE_AFTER_PUNCT, '')
    .trim();
}

// sha256 of the case-folded normalized text. Two memories that differ only in
// casing, width or punctuation style share a hash; stored text does not.
function memoryHash(text) {
  return createHash('sha256')
    .update(normalizeMemoryText(text).toLowerCase(), 'utf8')
    .digest('hex');
}

const NEGATION_EN = /\b(?:not|never|without|except|avoid|disable[sd]?|remove[sd]?|delete[sd]?|cancel(?:led|ed)?|stop(?:ped)?|no\s+longer|must\s+not|do\s+not|don't|doesn't|shouldn't|isn't|aren't|isnt|arent)\b/i;
const NEGATION_ZH = /(?:不要|不用|不能|不会|不再|不需要|不支持|不采用|不使用|不喜欢|不可以|不允许|禁止|避免|取消|移除|删除|禁用|关闭|停止|切勿|请勿|无需|没有|尚未)/;
const NUMBER_ANY = /\d/;
const DATE_RULES = [
  /\d{4}\s*[-/.年]\s*\d{1,2}(?:\s*[-/.月]\s*\d{1,2})?/,
  /(?:今天|明天|昨天|后天|今晚|今天起|本周|下周|上周|本月|下个月|今年|明年|去年|每天|每周|每月|工作日|周末)/,
  /\b(?:today|tomorrow|yesterday|tonight|this\s+week|next\s+week|last\s+week|next\s+month|last\s+month|this\s+year|next\s+year|weekday|weekend)\b/i,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i,
  /\d{1,2}:\d{2}/,
  /(?:上午|下午|早上|晚上|中午|凌晨)/,
];
const VERSION_RULES = [
  /\bv?\d+\.\d+(?:\.\d+)*(?:[-+][0-9a-z.-]+)?\b/i,
  /\b(?:version|semver|changelog)\b/i,
  /版本|版本号|版本號/,
  /\b(?:HTTP\s*\d{3}|(?:E|ERR|WARN)[A-Z0-9_-]{2,})\b/,
];
const SECRET_TERMS = /\b(?:password|passwd|pwd|secret|token|api[\s_-]?key|private[\s_-]?key|credential|access[\s_-]?key|client[\s_-]?secret)\b|密码|密碼|口令|密钥|密鑰|私钥|私鑰|令牌|凭据|憑據|验证码|驗證碼/i;
const IDENTITY_TERMS = /\b(?:id\s*card|passport|bank\s*card|credit\s*card|social\s+security|ssn|iban|swift|phone\s*(?:number|no)|email\s+address)\b|身份证|身份證|护照|護照|银行卡|銀行卡|信用卡|卡号|卡號|社保|手机号|手機號|邮箱|郵箱|账号|帳號/i;
const LITERAL_RULES = [
  /`[^`]+`/,
  /"[^"\n]{2,60}"/,
  /'[^'\n]{2,60}'/,
  /https?:\/\//i,
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/,
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/,
];
const SCOPE_TERMS = /\b(?:must|shall|required|only|always|exactly|at\s+least|at\s+most|no\s+more\s+than|minimum|maximum)\b|必须|必須|确保|確保|只能|仅限|僅限|仅需|僅需|至少|至多|不超过|不超過|不少于|不少於/i;

const HIGH_RISK_RULES = Object.freeze([
  ['negation', NEGATION_EN],
  ['negation', NEGATION_ZH],
  ['number', NUMBER_ANY],
  ['date', DATE_RULES],
  ['version', VERSION_RULES],
  ['secret', SECRET_TERMS],
  ['identity', IDENTITY_TERMS],
  ['literal', LITERAL_RULES],
  ['scope', SCOPE_TERMS],
]);

function matchesRule(rule, text) {
  if (Array.isArray(rule)) return rule.some(item => matchesRule(item, text));
  return rule.test(text);
}

// Candidate categories that make a memory unsafe to merge on fuzzy evidence.
// Returns unique category names in rule order.
function highRiskReasons(text) {
  const value = asText(text);
  if (!value) return [];
  const reasons = [];
  for (const [category, rule] of HIGH_RISK_RULES) {
    if (matchesRule(rule, value) && !reasons.includes(category)) reasons.push(category);
  }
  return reasons;
}

function isHighRiskText(text) {
  return highRiskReasons(text).length > 0;
}

// Antonym pairs that flip a stated choice. They are collapsed to one sentinel
// before token comparison, so "主题用深色" and "主题用浅色" share a frame and are
// classified as a conflict instead of two unrelated memories.
const POLARITY_GROUPS = Object.freeze([
  ['dark', 'light', '深色', '浅色', '暗色', '亮色'],
  ['enable', 'enabled', 'disable', 'disabled', '启用', '禁用', '开启', '关闭'],
  ['increase', 'increase', 'decrease', '增加', '减少', '提高', '降低'],
  ['before', 'after', '之前', '之后'],
  ['allow', 'deny', 'forbid', '允许', '禁止'],
  ['always', 'never', '总是', '从不'],
]);
const POLARITY_SENTINEL = '\u00a7p';
const POLARITY_INDEX = new Map();
for (const group of POLARITY_GROUPS) {
  for (const member of group) {
    const key = member.toLowerCase();
    if (!POLARITY_INDEX.has(key)) POLARITY_INDEX.set(key, group[0]);
  }
}
// Longest first so "disabled" wins over "disable". ASCII members need word
// boundaries; CJK members are matched literally.
const POLARITY_PATTERN = new RegExp(
  [...POLARITY_INDEX.keys()]
    .sort((a, b) => b.length - a.length)
    .map(member => (/^[a-z0-9]+$/.test(member)
      ? `(?<![a-z0-9])${member}(?![a-z0-9])`
      : member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('|'),
  'gi',
);

function lower(value) {
  return value.toLowerCase();
}

function stripEdgeSpaces(value) {
  return value.replace(/\s+/g, '');
}

// Character/n-gram tokens: Latin words plus CJK bigrams. Single CJK characters
// stay as unigrams so one-character memories are still comparable.
function tokenize(value) {
  const text = lower(value);
  const tokens = new Set();
  for (const match of text.matchAll(LATIN_TOKENS)) tokens.add(match[0]);
  for (const run of text.match(CJK_RUNS) || []) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.add(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i += 1) tokens.add(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function diceCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function hasNegation(value) {
  return NEGATION_EN.test(value) || NEGATION_ZH.test(value);
}

// Numbers, version-looking literals and dates, normalized so "1,000" and "1000"
// compare equal.
function riskAtoms(value) {
  const atoms = new Set();
  for (const match of value.matchAll(/\d+(?:[.,]\d+)*/g)) {
    atoms.add(match[0].replace(/[.,]/g, ''));
  }
  return atoms;
}

function sameAtomSet(a, b) {
  if (a.size !== b.size) return false;
  for (const atom of a) if (!b.has(atom)) return false;
  return true;
}

// True only when the texts differ *solely* by members of one polarity group.
function samePolarityFrame(a, b) {
  let replaced = false;
  const swap = value => value.replace(POLARITY_PATTERN, () => {
    replaced = true;
    return ` ${POLARITY_SENTINEL} `;
  });
  const frameA = [...tokenize(swap(a))].sort().join(' ');
  const frameB = [...tokenize(swap(b))].sort().join(' ');
  return replaced && frameA === frameB;
}

function isIdentifierToken(token) {
  return token.length >= 2 && /^[a-z0-9][a-z0-9._+#-]*$/.test(token);
}

function classifyConflict(oldText, newText) {
  const a = normalizeMemoryText(oldText);
  const b = normalizeMemoryText(newText);
  if (!a || !b) return CONFLICT_KINDS.DISTINCT;

  const fa = lower(a);
  const fb = lower(b);
  if (fa === fb) return CONFLICT_KINDS.DUPLICATE;
  // Chinese text has no spacing convention, so "你好 世界" and "你好世界" are the
  // same memory. The squash rule is limited to CJK text on purpose: in English
  // "on line" and "online" can mean different things.
  if ((CJK_CHAR.test(a) || CJK_CHAR.test(b)) && stripEdgeSpaces(fa) === stripEdgeSpaces(fb)) {
    return CONFLICT_KINDS.DUPLICATE;
  }

  const tokensA = tokenize(fa);
  const tokensB = tokenize(fb);
  const similarity = diceCoefficient(tokensA, tokensB);
  if (!similarity) return CONFLICT_KINDS.DISTINCT;

  const negatedA = hasNegation(fa);
  const negatedB = hasNegation(fb);
  if (negatedA !== negatedB && similarity >= POLARITY_OVERLAP_FLOOR) {
    return CONFLICT_KINDS.CONFLICT;
  }
  if (samePolarityFrame(fa, fb)) return CONFLICT_KINDS.CONFLICT;

  const atomsA = riskAtoms(fa);
  const atomsB = riskAtoms(fb);
  const atomsDiffer = !sameAtomSet(atomsA, atomsB);
  if (atomsDiffer && similarity >= CONFLICT_OVERLAP_FLOOR) return CONFLICT_KINDS.CONFLICT;

  // One identifier swapped for another ("使用 MySQL" -> "使用 PostgreSQL") on an
  // otherwise shared frame: a changed choice, not a rephrasing.
  const onlyA = [...tokensA].filter(token => !tokensB.has(token));
  const onlyB = [...tokensB].filter(token => !tokensA.has(token));
  if (onlyA.length === 1 && onlyB.length === 1
    && isIdentifierToken(onlyA[0]) && isIdentifierToken(onlyB[0])
    && similarity >= CONFLICT_OVERLAP_FLOOR) {
    return CONFLICT_KINDS.CONFLICT;
  }

  const risky = isHighRiskText(a) || isHighRiskText(b);
  const threshold = risky ? HIGH_RISK_NEAR_DUPLICATE_THRESHOLD : NEAR_DUPLICATE_THRESHOLD;
  if (similarity >= threshold) return CONFLICT_KINDS.NEAR_DUPLICATE;

  const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (short.length >= 6 && long.includes(short) && short.length / long.length >= 0.6) {
    return CONFLICT_KINDS.NEAR_DUPLICATE;
  }
  return CONFLICT_KINDS.DISTINCT;
}

function clampEstimate(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_TOKEN_ESTIMATE, Math.max(1, Math.ceil(value)));
}

// Conservative approximation for mixed Chinese/Latin text:
//   CJK chars * 0.8 + Latin words * 1.3 + punctuation * 0.3 + other * 1.0
// The coefficients come from the product spec's guidance; they over-count
// Chinese (one glyph is often ~1 token, never less than 0.8) so a budget cut
// happens before the model window does. A "word" longer than 8 chars (hash,
// URL, base64 blob) is charged per extra character as well, otherwise one
// 1000-character token would be estimated as a single word.
const LONG_WORD_START = 8;
const LONG_WORD_WEIGHT = 0.3;

function estimateTokens(text) {
  const value = asText(text);
  if (!value.trim()) return 0;
  const cjkChars = (value.match(CJK_CHARS) || []).length;
  const latinWords = value.match(LATIN_WORDS) || [];
  const latinChars = latinWords.reduce((sum, word) => sum + word.length, 0);
  const longWordChars = latinWords.reduce(
    (sum, word) => sum + Math.max(0, word.length - LONG_WORD_START),
    0,
  );
  const punctuation = (value.match(PUNCTUATION_CHARS) || []).length;
  const nonSpace = Array.from(value.replace(/\s+/g, '')).length;
  const other = Math.max(0, nonSpace - cjkChars - latinChars - punctuation);
  const raw = cjkChars * 0.8
    + latinWords.length * 1.3
    + longWordChars * LONG_WORD_WEIGHT
    + punctuation * 0.3
    + other;
  return clampEstimate(raw);
}

function defaultTextOf(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  return '';
}

function limitOf(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

// Order-preserving budget selection. An item that does not fit is omitted on its
// own; later smaller items still get a chance, so one oversized memory cannot
// starve the rest. `estimatedTokens` is the sum of the selected item estimates
// (join separators are not counted; leave headroom for them).
function selectWithinBudget(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const maxItems = limitOf(options.maxItems, DEFAULT_BUDGET.maxItems);
  const maxTokens = limitOf(options.maxTokens, DEFAULT_BUDGET.maxTokens);
  const textOf = typeof options.textOf === 'function' ? options.textOf : defaultTextOf;

  const selected = [];
  const omitted = [];
  let estimatedTokens = 0;

  for (const item of list) {
    if (selected.length >= maxItems) {
      omitted.push(item);
      continue;
    }
    const tokens = estimateTokens(textOf(item));
    if (estimatedTokens + tokens > maxTokens) {
      omitted.push(item);
      continue;
    }
    selected.push(item);
    estimatedTokens += tokens;
  }

  return { selected, omitted, estimatedTokens };
}

// JSON-serializable, delimiter-safe representation. Escaping < and > stops an
// untrusted memory from emitting a closing tag such as </memory>.
function escapeMemoryData(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`escapeMemoryData: value is not JSON-serializable (${error.message})`, { cause: error });
  }
  if (json === undefined) json = 'null';
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

module.exports = {
  normalizeMemoryText,
  memoryHash,
  isHighRiskText,
  highRiskReasons,
  classifyConflict,
  estimateTokens,
  selectWithinBudget,
  escapeMemoryData,
  CONFLICT_KINDS,
  DEFAULT_BUDGET,
};
