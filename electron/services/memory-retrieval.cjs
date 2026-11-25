'use strict';
/**
 * 记忆检索纯函数层（无依赖、无 IO、无 Electron）：合并候选 → 排序 → 预算裁剪 → 注入判定。
 *
 * 数据形状（memory-like）：
 *   { id, text, updatedAt, pinned, importance, semanticScore?, score? }
 *  - id          去重键；缺失时依次回退到 key / text。
 *  - text        记忆正文（selectWithinBudget 默认用它估算 token）。
 *  - updatedAt   ISO 字符串 / 毫秒数 / Date；无法解析视为“无时间信号”。
 *  - pinned      true 时享有硬优先级 + 固定加分（见 DEFAULT_WEIGHTS.pinned）。
 *  - importance  0..1，超出范围会被夹紧；缺失按 DEFAULT_IMPORTANCE 计。
 *  - semanticScore（或 scores.semantic）向量相似度，0..1。
 *  - score       候选在来源通道里的原始分，mergeCandidates 会保留通道最佳分。
 *
 * 排序规则：pinned 优先（硬规则，与 memory-store.cjs 一致），同组按 score 降序，
 * 再按 updatedAt 降序，最后按 id 升序。因此该数组可以直接交给 selectWithinBudget
 * 逐条消费，预算裁剪不会打乱优先级。
 *
 * 全部函数都是纯函数：不修改入参，不使用随机数/时钟以外的环境状态。
 */

const CHANNELS = Object.freeze(['pinned', 'recent', 'semantic', 'keyword']);
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_HALF_LIFE_DAYS = 180;
const DEFAULT_MAX_ITEMS = 12;
const DEFAULT_MAX_TOKENS = 6000;
const DEFAULT_MIN_SCORE = 0.08;
const HIGH_IMPORTANCE = 0.8;
const DEFAULT_IMPORTANCE = 0.5;
const PHRASE_BONUS = 0.2;

/** 各信号权重；score 上限 = 1.45（lexical 0.45 + semantic 0.30 + recency 0.10 + importance 0.15 + pinned 0.25）。 */
const DEFAULT_WEIGHTS = Object.freeze({
  lexical: 0.45,
  semantic: 0.3,
  recency: 0.1,
  importance: 0.15,
  pinned: 0.25,
});

class MemoryRetrievalError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'MemoryRetrievalError';
    this.code = code;
  }
}

// ------------------------------------------------------------------ helpers

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalize(text) {
  return typeof text === 'string' ? text.normalize('NFKC').toLowerCase() : '';
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** undefined/null/NaN/Infinity → null，其余转数字。 */
function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 依次返回第一个可用数字，允许 0（0 是合法分数）。 */
function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

/** ISO 字符串 / 毫秒数 / Date → 毫秒时间戳；无法解析返回 null。 */
function toEpochMs(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function textOfValue(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (!isObject(candidate)) return '';
  const text = candidate.text ?? candidate.content;
  return typeof text === 'string' ? text : '';
}

function candidateKey(candidate) {
  if (candidate.id !== undefined && candidate.id !== null && String(candidate.id) !== '') return String(candidate.id);
  if (candidate.key !== undefined && candidate.key !== null && String(candidate.key) !== '') return `key:${String(candidate.key)}`;
  return `text:${textOfValue(candidate)}`;
}

function coerceCandidate(item) {
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { text } : null;
  }
  if (!isObject(item)) return null;
  const text = textOfValue(item).trim();
  const hasId = item.id !== undefined && item.id !== null && String(item.id) !== '';
  if (!text && !hasId) return null;
  return { ...item, text };
}

/**
 * 检索词元：中文 2 字 bigram + 拉丁/数字单词（含分隔符拆分子词）。
 * 与 indexer.toNgrams 同构（去掉 3-gram），但在此本地实现以保持零依赖。
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function toQueryTokens(text) {
  const tokens = new Set();
  const normalized = normalize(text);
  if (!normalized.trim()) return tokens;
  for (const word of normalized.match(/[a-z0-9][a-z0-9_+#./-]*/g) || []) {
    if (word.length >= 2) tokens.add(word);
    for (const part of word.split(/[._+#/:-]+/)) if (part.length >= 2) tokens.add(part);
  }
  for (const run of normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g) || []) {
    const chars = Array.from(run);
    if (chars.length === 1) tokens.add(chars[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.add(chars[index] + chars[index + 1]);
  }
  return tokens;
}

/** 查询词元在文本中的覆盖率 0..1；命中整串查询时追加 PHRASE_BONUS。 */
function scoreLexical(queryTokens, normalizedQuery, text) {
  if (!queryTokens || queryTokens.size === 0) return 0;
  const normalized = normalize(text);
  if (!normalized.trim()) return 0;
  const textTokens = toQueryTokens(normalized);
  let matched = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token) || normalized.includes(token)) matched += 1;
  }
  let coverage = matched / queryTokens.size;
  if (normalizedQuery.length >= 2 && normalized.includes(normalizedQuery)) {
    coverage = Math.min(1, coverage + PHRASE_BONUS);
  }
  return clamp01(coverage);
}

function lexicalOverlap(query, text) {
  return scoreLexical(toQueryTokens(query), normalize(query), text);
}

/** 180 天半衰期衰减；未来时间视为 1，缺失/非法时间视为 0（无时间信号）。 */
function recencyScore(updatedAt, now) {
  const time = toEpochMs(updatedAt);
  if (time === null) return 0;
  const reference = toEpochMs(now) ?? Date.now();
  const ageDays = (reference - time) / DAY_MS;
  if (ageDays <= 0) return 1;
  return Math.pow(2, -ageDays / DEFAULT_HALF_LIFE_DAYS);
}

function normalizeWeights(input) {
  const weights = { ...DEFAULT_WEIGHTS };
  if (!isObject(input)) return weights;
  for (const key of Object.keys(weights)) {
    const value = numberOrNull(input[key]);
    if (value !== null && value >= 0) weights[key] = value;
  }
  return weights;
}

function channelsOf(candidate) {
  if (Array.isArray(candidate.channels)) {
    const list = [];
    for (const channel of candidate.channels) {
      const value = String(channel);
      if (CHANNELS.includes(value) && !list.includes(value)) list.push(value);
    }
    return list;
  }
  const derived = [];
  if (candidate.pinned === true) derived.push('pinned');
  if (firstNumber(candidate.semanticScore, candidate.scores?.semantic) !== null) derived.push('semantic');
  if (firstNumber(candidate.keywordScore, candidate.scores?.keyword) !== null) derived.push('keyword');
  return derived;
}

// -------------------------------------------------------------- mergeCandidates

/**
 * 合并多路召回候选：按 id 去重，保留来源通道与通道最佳分。
 * 重复条目不会互相覆盖已有内容，只补齐缺失字段。
 *
 * @param {{pinned?: object[], recent?: object[], semantic?: object[], keyword?: object[]}} [input]
 * @returns {Array<object>} 每个条目含 channels: string[]、scores: {pinned,recent,semantic,keyword}、score（通道最佳分）
 */
function mergeCandidates(input = {}) {
  const source = isObject(input) ? input : {};
  const merged = new Map();

  for (const channel of CHANNELS) {
    const list = source[channel];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      throw new MemoryRetrievalError('invalid-input', `mergeCandidates: ${channel} 必须是数组。`);
    }
    for (const item of list) {
      const candidate = coerceCandidate(item);
      if (!candidate) continue;
      const key = candidateKey(candidate);
      const channelScore = numberOrNull(candidate.score);
      let entry = merged.get(key);
      if (!entry) {
        entry = {
          ...candidate,
          id: candidate.id === undefined || candidate.id === null ? key : candidate.id,
          channels: [],
          scores: { pinned: null, recent: null, semantic: null, keyword: null },
          score: 0,
        };
        merged.set(key, entry);
      } else {
        for (const [field, value] of Object.entries(candidate)) {
          if (value === undefined || value === null || value === '') continue;
          if (field === 'score') continue;
          const current = entry[field];
          if (current === undefined || current === null || current === '') entry[field] = value;
        }
      }
      if (!entry.channels.includes(channel)) entry.channels.push(channel);
      if (channelScore !== null) {
        const best = entry.scores[channel];
        entry.scores[channel] = best === null ? channelScore : Math.max(best, channelScore);
      }
    }
  }

  const result = [];
  for (const entry of merged.values()) {
    const scores = { ...entry.scores };
    const values = Object.values(scores).filter(value => value !== null);
    result.push({
      ...entry,
      scores,
      score: round6(values.length ? Math.max(...values) : 0),
    });
  }
  return result;
}

// -------------------------------------------------------------- rankCandidates

function scoreCandidate(candidate, context) {
  const { queryTokens, normalizedQuery, now, weights } = context;
  const semantic = clamp01(firstNumber(candidate.semanticScore, candidate.scores?.semantic) ?? 0);
  const importance = clamp01(firstNumber(candidate.importance) ?? DEFAULT_IMPORTANCE);
  const recency = recencyScore(candidate.updatedAt, now);
  const lexical = scoreLexical(queryTokens, normalizedQuery, textOfValue(candidate));
  const pinned = candidate.pinned === true;
  const pinnedBonus = pinned ? weights.pinned : 0;
  const score = lexical * weights.lexical
    + semantic * weights.semantic
    + recency * weights.recency
    + importance * weights.importance
    + pinnedBonus;
  return {
    ...candidate,
    score: round6(score),
    channels: channelsOf(candidate),
    signals: {
      lexical: round6(lexical),
      semantic: round6(semantic),
      recency: round6(recency),
      importance: round6(importance),
      pinnedBonus: round6(pinnedBonus),
    },
  };
}

function compareRanked(left, right) {
  const pinned = Number(right.pinned === true) - Number(left.pinned === true);
  if (pinned !== 0) return pinned;
  if (right.score !== left.score) return right.score - left.score;
  const rightTime = toEpochMs(right.updatedAt);
  const leftTime = toEpochMs(left.updatedAt);
  if (rightTime !== leftTime) return (rightTime ?? 0) - (leftTime ?? 0);
  return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

/**
 * 打并排序（返回副本，不修改入参）。
 *
 * 分数 = lexical*w.lexical + semantic*w.semantic + recency*w.recency
 *      + importance*w.importance + (pinned ? w.pinned : 0)
 *
 * @param {object[]} candidates
 * @param {{query?: string, now?: number|Date|string, weights?: object}} [options]
 * @returns {Array<object>} 条目额外含 score / channels / signals
 */
function rankCandidates(candidates, options = {}) {
  const list = candidates === undefined || candidates === null ? [] : candidates;
  if (!Array.isArray(list)) {
    throw new MemoryRetrievalError('invalid-input', 'rankCandidates: candidates 必须是数组。');
  }
  const settings = isObject(options) ? options : {};
  const query = typeof settings.query === 'string' ? settings.query.trim() : '';
  const normalizedQuery = normalize(query);
  const now = toEpochMs(settings.now) ?? Date.now();
  const weights = normalizeWeights(settings.weights);
  const queryTokens = toQueryTokens(query);

  const context = { queryTokens, normalizedQuery, now, weights };
  return list
    .map(item => coerceCandidate(item))
    .filter(Boolean)
    .map(candidate => scoreCandidate(candidate, context))
    .sort(compareRanked);
}

// ----------------------------------------------------------- selectWithinBudget

/**
 * 近似 token 数：CJK 字符按 1 token，其余非空白字符按 4 字符 ≈ 1 token。
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || [];
  const rest = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const other = (rest.match(/\S/g) || []).length;
  return cjk.length + Math.ceil(other / 4);
}

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return fallback;
  return number;
}

/**
 * 按排序结果逐条装入预算：保持 rank 顺序，绝不越过 maxItems / maxTokens。
 * 装不下的条目不截断正文，直接计入 omitted（后续更小的条目仍可入选）。
 *
 * @param {object[]} candidates 已排序候选（rankCandidates 的输出）
 * @param {{maxItems?: number, maxTokens?: number, textOf?: (candidate: object) => string}} [options]
 * @returns {{selected: object[], omitted: object[], estimatedTokens: number}}
 */
function selectWithinBudget(candidates, options = {}) {
  const list = candidates === undefined || candidates === null ? [] : candidates;
  if (!Array.isArray(list)) {
    throw new MemoryRetrievalError('invalid-input', 'selectWithinBudget: candidates 必须是数组。');
  }
  const settings = isObject(options) ? options : {};
  const maxItems = nonNegativeInteger(settings.maxItems, DEFAULT_MAX_ITEMS);
  const maxTokens = nonNegativeInteger(settings.maxTokens, DEFAULT_MAX_TOKENS);
  const pickText = typeof settings.textOf === 'function'
    ? settings.textOf
    : candidate => textOfValue(candidate);

  const selected = [];
  const omitted = [];
  let estimatedTokens = 0;

  for (const candidate of list) {
    if (selected.length >= maxItems) {
      omitted.push(candidate);
      continue;
    }
    let text = '';
    try {
      const value = pickText(candidate);
      text = typeof value === 'string' ? value : '';
    } catch {
      text = '';
    }
    const cost = estimateTokens(text);
    if (estimatedTokens + cost > maxTokens) {
      omitted.push(candidate);
      continue;
    }
    selected.push(candidate);
    estimatedTokens += cost;
  }

  return { selected, omitted, estimatedTokens };
}

// ------------------------------------------------------------------ shouldInject

/**
 * 是否值得注入上下文。
 * pinned 与高重要度（>= HIGH_IMPORTANCE）直接通过；其余看 score 是否达到 minScore。
 * 完全没有信号的候选（无查询命中、无时间、重要度取默认值）分数约 0.075 < 默认 0.08，不注入。
 *
 * @param {object} candidate 已排序候选（含 score），或任意 memory-like 对象
 * @param {{minScore?: number, query?: string, now?: number|Date|string}} [options]
 * @returns {boolean}
 */
function shouldInject(candidate, options = {}) {
  if (!isObject(candidate)) return false;
  const settings = isObject(options) ? options : {};
  const threshold = numberOrNull(settings.minScore);
  const minScore = threshold !== null && threshold >= 0 ? threshold : DEFAULT_MIN_SCORE;

  if (candidate.pinned === true) return true;
  if (clamp01(firstNumber(candidate.importance) ?? 0) >= HIGH_IMPORTANCE) return true;

  const score = numberOrNull(candidate.score);
  if (score !== null) return score >= minScore;

  const [ranked] = rankCandidates([candidate], { query: settings.query ?? '', now: settings.now });
  return Boolean(ranked) && ranked.score >= minScore;
}

module.exports = {
  mergeCandidates,
  rankCandidates,
  selectWithinBudget,
  shouldInject,
  estimateTokens,
  toQueryTokens,
  lexicalOverlap,
  MemoryRetrievalError,
  CHANNELS,
  DEFAULT_WEIGHTS,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_SCORE,
  DEFAULT_IMPORTANCE,
  HIGH_IMPORTANCE,
};
