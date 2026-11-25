'use strict';
/**
 * 负责：写入前的「疑似重复」判定——把待写入正文与检索回来的候选记忆正文都切成检索词元，
 *   用 Dice 系数算相似度，返回超过阈值的候选（含 id、相似度与一句话差异）。
 * 不负责：真正的检索（electron/services/agent-memory-search.cjs）、落盘与配额
 *   （electron/memory-store.cjs / memory-runtime.cjs）、要不要给用户弹审批
 *   （electron/skills/packs/memory/handlers.mjs 的 ctx.authorize）。
 * 被谁调用：electron/skills/packs/memory/handlers.mjs 的 memory_write 内联去重提示；
 *   tests/memory-dedupe.test.mjs（纯函数直测）。
 *
 * 纯函数、零 IO、零新增依赖：词元切分直接复用 memory-retrieval.cjs 的 toQueryTokens，
 * 绝不在这里写第二份中文 bigram 实现（两份必然漂移，搜得到但判不出重复）。
 */

const { toQueryTokens } = require('./memory-retrieval.cjs');

/**
 * 判为「疑似重复」的相似度阈值（Dice 系数，0..1）。
 *
 * 依据（阈值不是拍的，是按词元集合的几何形状量出来的）：
 * - 词元 = 中文 2 字 bigram + 拉丁/数字单词（见 toQueryTokens），同一句话与原句的交集几乎等于并集。
 * - 实测形状：**同一句话补一个从句**（「提交信息用中文」→「提交信息用中文，动词开头」）= 0.80；
 *   **主题相同但事实不同**（「数据库用 Postgres」→「数据库用 SQLite」= 0.75，
 *   「部署在本地 Docker」→「部署在云上 Kubernetes」= 0.40）都落在阈值下方。
 * - 0.80 落在两簇之间，并且**偏保守**：宁可漏判（照常新增，用户随后用 memory_supersede 收拾），
 *   也不要误判——误判会直接阻断一次本该发生的写入。
 * - 边界语义是「大于等于」：0.80 命中提示，0.75 不命中（见 tests/memory-dedupe.test.mjs）。
 */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

/** 单次最多提示几个候选：提示是「一句话」，不是候选清单，多了模型反而不会读。 */
const MAX_DUPLICATE_HINTS = 3;

/** 差异描述里每侧最多列几个词元。 */
const DIFF_TOKENS = 4;

/**
 * @param {unknown} value
 * @returns {Set<string>} 归一化词元集合（非字符串 → 空集合）
 */
function tokenSetOf(value) {
  if (typeof value !== 'string' || !value.trim()) return new Set();
  return toQueryTokens(value);
}

/**
 * Dice 系数：`2|A∩B| / (|A|+|B|)`。对称、对长度不敏感，比「覆盖率」更适合判「两条是不是同一件事」。
 * 任一集合为空 → 0（空文本永远不算重复）。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} 0..1（已按 1e-6 取整，避免浮点尾差让边界测试抖动）
 */
function similarity(left, right) {
  const a = tokenSetOf(left);
  const b = tokenSetOf(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return Math.round((2 * shared / (a.size + b.size)) * 1e6) / 1e6;
}

/**
 * 一句话差异：新内容多出什么、旧条目有什么是新内容没有的。
 * 只列词元（不是长句 diff）：模型要的是「差在哪」，用户要的是一眼能读。
 *
 * @param {string} text 待写入正文
 * @param {string} candidateText 已有条目正文
 * @returns {string}
 */
function describeDifference(text, candidateText) {
  const next = tokenSetOf(text);
  const prior = tokenSetOf(candidateText);
  const added = [...next].filter(token => !prior.has(token)).slice(0, DIFF_TOKENS);
  const removed = [...prior].filter(token => !next.has(token)).slice(0, DIFF_TOKENS);
  if (!added.length && !removed.length) return '词元完全相同（只是措辞/顺序不同）';
  const parts = [];
  if (added.length) parts.push(`新内容多出「${added.join('、')}」`);
  if (removed.length) parts.push(`旧条目有「${removed.join('、')}」`);
  return parts.join('；');
}

/**
 * 从检索结果里挑出「疑似重复」的候选（按相似度降序，最多 MAX_DUPLICATE_HINTS 条）。
 *
 * 只认带 `id` 且带正文的记忆命中：会话/历史命中（kind === 'session' / 'history'）不是可替代的
 * 记忆条目，把它们当重复候选会让模型对着一个 messageId 调用 memory_update。
 *
 * @param {string} text 待写入正文
 * @param {Array<object>} hits `memory_search` 形状的命中（memory / session 混合也可以）
 * @param {{ threshold?: number, limit?: number }} [options]
 * @returns {Array<{ id: string, similarity: number, kind: string|null, source: string|null,
 *   text: string, updatedAt: string|null, difference: string }>}
 */
function findDuplicates(text, hits, options = {}) {
  const threshold = Number.isFinite(options?.threshold) ? options.threshold : DUPLICATE_SIMILARITY_THRESHOLD;
  const limit = Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : MAX_DUPLICATE_HINTS;
  const list = Array.isArray(hits) ? hits : [];
  const out = [];
  for (const hit of list) {
    if (!hit || typeof hit !== 'object') continue;
    if (hit.kind !== undefined && hit.kind !== 'memory') continue;
    const id = typeof hit.id === 'string' ? hit.id.trim() : '';
    const candidateText = typeof hit.text === 'string' ? hit.text : '';
    if (!id || !candidateText) continue;
    const score = similarity(text, candidateText);
    if (score < threshold) continue;
    out.push({
      id,
      similarity: score,
      kind: typeof hit.memoryKind === 'string' ? hit.memoryKind : (typeof hit.kind === 'string' ? hit.kind : null),
      source: typeof hit.source === 'string' ? hit.source : null,
      text: candidateText.slice(0, 300),
      updatedAt: typeof hit.updatedAt === 'string' ? hit.updatedAt : (typeof hit.createdAt === 'string' ? hit.createdAt : null),
      difference: describeDifference(text, candidateText),
    });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

module.exports = {
  DUPLICATE_SIMILARITY_THRESHOLD,
  MAX_DUPLICATE_HINTS,
  similarity,
  describeDifference,
  findDuplicates,
};
