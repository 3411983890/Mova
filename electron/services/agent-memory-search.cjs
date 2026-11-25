'use strict';
/**
 * 负责：agent 侧的记忆检索适配——把技能包/ACP 支路的 `({query, scope, limit, source, ...filters})`
 *   翻成 repository.search 的入参，做范围/预算/二次开关复查，并给出 `readSource`、
 *   以及纯函数 `filterHits(hits, filters)`（kind / 时间范围 / origin / projectId / includeArchived）。
 * 不负责：SQL 与排序（electron/db/**）、上下文自动注入的排序与预算（memory-retrieval.cjs /
 *   repository.context）、去重提示（memory-dedupe.cjs）、是否开记忆（repository.settings 说了算）。
 * 被谁调用：electron/model-ipc.cjs（每轮建一个闭包交给 chat-agent）、
 *   electron/skills/packs/memory/handlers.mjs（memory_search 的 memorySearch 依赖）、
 *   tests/agent-memory-search.test.mjs、tests/memory-tool-schema.test.mjs。
 *
 * 过滤语义（改之前先读）：
 * - 五个过滤维度全部**可选**，都不传时输入输出与改造前逐字一致（repository.search 的入参不多一个键）。
 * - 过滤是**记忆条目专属**的：带了任一过滤参数就只返回 kind === 'memory' 的命中，不再回退聊天历史
 *   （聊天历史没有 kind / origin / 时间字段，混进来只会让「按 kind 过滤」这件事自相矛盾）。
 * - `includeArchived:true` 才允许归档条目进入结果集；默认（不传）永远看不到它们。
 */

const { redactSensitive } = require('./memory-redaction.cjs');

/** 记忆分类枚举。与 packs/memory/manifest.mjs 的 schema、memory-store/postgres 的 kind 校验同源。 */
const MEMORY_KINDS = Object.freeze(['fact', 'preference', 'decision', 'note']);
/** 来源枚举：`manual` 是「用户/模型主动写入的确定性记忆」，`automatic` 是系统自动抽取的。 */
const MEMORY_ORIGINS = Object.freeze(['manual', 'automatic']);
/** 带过滤时先多取几倍再裁：过滤发生在拿回命中之后，按原 limit 取会「过滤完只剩两条」。 */
const FILTER_OVERFETCH_FACTOR = 3;
/** 多取的上限：repository.search 的 limit 上限是 100，这里再收一道，别为了过滤把库扫穿。 */
const MAX_FETCH_LIMIT = 36;

function formatMemoryHit(hit) {
  if (hit.kind === 'session') {
    return {
      id: hit.id, kind: 'history', overview: hit.text, title: hit.title, role: hit.role,
      projectId: hit.projectId ?? null, original: { conversationId: hit.conversationId, messageId: hit.messageId },
    };
  }
  return {
    id: hit.id, text: hit.text, projectId: hit.projectId ?? null, source: hit.source ?? null,
    ...(hit.conversationId && hit.messageId ? {
      original: { conversationId: hit.conversationId, messageId: hit.messageId },
    } : {}),
  };
}

function historyOverview(text, query) {
  const clean = redactSensitive(String(text || '')).text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  const terms = [query, ...query.split(/[\s，。！？、]+/)].filter(term => term.length >= 2);
  const index = terms.map(term => lower.indexOf(term.toLowerCase())).find(at => at >= 0) ?? 0;
  const start = Math.max(0, index - 60);
  return (start ? '…' : '') + clean.slice(start, start + 220) + (start + 220 < clean.length ? '…' : '');
}

function titleFromConversation(conversationId) {
  try {
    const parts = JSON.parse(conversationId);
    if (Array.isArray(parts) && typeof parts[2] === 'string') return redactSensitive(parts[2]).text.slice(0, 140);
  } catch { /* Older stored conversations can use opaque ids. */ }
  return undefined;
}

function paginateHistory(rows, offset, limit) {
  let position = 0;
  let remaining = limit;
  const messages = [];
  for (const row of rows) {
    const redaction = redactSensitive(row.text);
    const characters = Array.from(redaction.text);
    const next = position + characters.length;
    if (next > offset) {
      if (!remaining || messages.length === 20) return { messages, nextOffset: position };
      const start = Math.max(0, offset - position);
      const end = Math.min(characters.length, start + remaining);
      messages.push({ messageId: row.messageId, role: row.role, text: characters.slice(start, end).join(''),
        redacted: redaction.redacted, offset: start, truncated: end < characters.length });
      if (end < characters.length) return { messages, nextOffset: position + end };
      remaining -= end - start;
    }
    position = next;
  }
  return { messages, nextOffset: null };
}

// ------------------------------------------------------------------ filters
/**
 * 时间参数归一：毫秒时间戳（数字或纯数字字符串）与 ISO 字符串都接受，其余一律 null。
 * 返回 null 表示「这个值不合法」——调用方（handlers）据此回 invalid_arguments，
 * 绝不把 NaN 塞进比较式（那样会静默过滤掉一切，看起来像「记忆没了」）。
 *
 * @param {unknown} value
 * @returns {number|null} 毫秒时间戳
 */
function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  // 纯数字按毫秒时间戳解释（Date.parse('1761926400000') 会当成年份，必须先分流）。
  if (/^\d{10,16}$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? number : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 把外部过滤参数归一成一个明确的形状：未传的键保持 `undefined`（不是 null/false），
 * 这样 `hasMemoryFilters()` 才能区分「没传」与「传了 false」。
 *
 * @param {{ kind?: unknown, after?: unknown, before?: unknown, origin?: unknown,
 *   projectId?: unknown, includeArchived?: unknown }} [filters]
 * @returns {{ kind?: string, afterMs?: number, beforeMs?: number, origin?: string,
 *   projectId?: string, includeArchived?: boolean, invalid?: 'kind'|'after'|'before'|'origin'|'projectId' }}
 *   `invalid` 非空表示某个值不合法（含时间无法解析），此时其余字段仍按尽可能归一的结果保留。
 */
function normalizeMemoryFilters(filters = {}) {
  const input = filters && typeof filters === 'object' && !Array.isArray(filters) ? filters : {};
  const out = {};
  let invalid;
  if (input.kind !== undefined && input.kind !== null && input.kind !== '') {
    const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
    if (!MEMORY_KINDS.includes(kind)) invalid = 'kind';
    else out.kind = kind;
  }
  if (input.origin !== undefined && input.origin !== null && input.origin !== '') {
    const origin = typeof input.origin === 'string' ? input.origin.trim() : '';
    if (!MEMORY_ORIGINS.includes(origin)) invalid = 'origin';
    else out.origin = origin;
  }
  for (const [key, target] of [['after', 'afterMs'], ['before', 'beforeMs']]) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const ms = toEpochMs(raw);
    if (ms === null) { invalid = key; continue; }
    out[target] = ms;
  }
  // 已经归一过的形状（afterMs/beforeMs）直接透传，避免 filterHits 二次归一后把时间条件丢掉。
  for (const key of ['afterMs', 'beforeMs']) {
    const raw = input[key];
    if (out[key] !== undefined || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    out[key] = raw;
  }
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== '') {
    if (typeof input.projectId !== 'string' || !input.projectId.trim() || input.projectId.length > 500) invalid = 'projectId';
    else out.projectId = input.projectId.trim();
  }
  if (typeof input.includeArchived === 'boolean') out.includeArchived = input.includeArchived;
  if (invalid) out.invalid = invalid;
  return out;
}

/** @param {object} filters `normalizeMemoryFilters` 的产物 @returns {boolean} 是否带了任一过滤维度 */
function hasMemoryFilters(filters) {
  return Boolean(filters) && (filters.kind !== undefined || filters.afterMs !== undefined
    || filters.beforeMs !== undefined || filters.origin !== undefined
    || filters.projectId !== undefined || filters.includeArchived !== undefined);
}

/** 记忆条目的「最后变化时间」：updatedAt 优先，其次 createdAt。 */
function memoryTimeOf(hit) {
  return toEpochMs(hit?.updatedAt) ?? toEpochMs(hit?.createdAt) ?? null;
}

/** 归档判定：repository 打的 `archived` 标记优先，退化用 status === 'disabled'（归档=软删除的落盘形态）。 */
function isArchivedHit(hit) {
  return hit?.archived === true || hit?.status === 'disabled';
}

/**
 * 纯函数：按过滤参数筛命中。**不传任何过滤参数时原样返回**（同一个数组引用），
 * 保证「不传参数 = 今天的行为逐字一致」。
 *
 * 维度：
 * - `kind`：记忆分类（fact / preference / decision / note）。
 * - `after` / `before`：时间区间（毫秒，闭区间），取 updatedAt 或 createdAt。
 * - `origin`：`manual`（source === 'user'）或 `automatic`。
 * - `projectId`：精确项目；`null`（全局记忆）不匹配任何显式 projectId。
 * - `includeArchived`：默认 false，归档条目一律不进结果；true 时才放行（并保留 `archived` 标记）。
 *
 * 非记忆命中（kind === 'session' / 'history'）在**带过滤时**一律不返回：它们没有 kind/origin/时间
 * 字段，留着会让「按 kind 过滤」变成假的。不带过滤时它们照旧返回。
 *
 * @param {Array<object>} hits repository.search / memorySearch 形状的命中
 * @param {object} [filters] 原始过滤参数（函数内部自己归一）
 * @returns {Array<object>}
 */
function filterHits(hits, filters = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const active = normalizeMemoryFilters(filters);
  // 归一失败（非法时间等）时**返回空**而不是原样放过：过滤条件不成立时宁可少给，
  // 也不给出与声明不符的结果（静默返回全部等于骗模型「没有过滤」）。
  if (active.invalid !== undefined) return [];
  if (!hasMemoryFilters(active)) return list;
  return list.filter(hit => {
    if (!hit || typeof hit !== 'object') return false;
    if (hit.kind !== 'memory') return false;
    if (active.includeArchived !== true && isArchivedHit(hit)) return false;
    if (active.kind !== undefined && hit.memoryKind !== active.kind && hit.kind !== active.kind) return false;
    if (active.origin !== undefined) {
      const origin = hit.source === 'automatic' ? 'automatic' : 'manual';
      if (origin !== active.origin) return false;
    }
    if (active.projectId !== undefined && (hit.projectId ?? null) !== active.projectId) return false;
    if (active.afterMs !== undefined || active.beforeMs !== undefined) {
      const time = memoryTimeOf(hit);
      if (time === null) return false;
      if (active.afterMs !== undefined && time < active.afterMs) return false;
      if (active.beforeMs !== undefined && time > active.beforeMs) return false;
    }
    return true;
  });
}

// Agent access is distinct from the settings UI's manual memory search.
// Re-check the switch for every tool call: it may change during a long run.
function createAgentMemorySearch(repository, request, contextEnabled) {
  if (!repository || !request?.memoryScope || request.temporary || contextEnabled !== true) return null;
  const found = new Map();
  const projectId = request.memoryScope.projectId ?? null;
  const allowedGlobal = value => projectId === null ||
    (request.memoryScope.includeGlobal === true && value?.includeGlobal !== false);
  // 过滤参数走单独的解构名（`projectId: projectFilter`），避免与闭包自己的作用域 projectId 撞名——
  // 撞名会让「按项目过滤」静默变成「按当前项目检索」，两种语义差得很远。
  const search = async ({
    query, scope = 'current', limit = 8, source = 'auto',
    kind, after, before, origin, projectId: projectFilter, includeArchived,
  } = {}, signal) => {
    signal?.throwIfAborted();
    const settings = await repository.settings();
    signal?.throwIfAborted();
    if (settings?.memoryEnabled !== true) return [];
    const global = scope === 'global';
    // Global chat searches itself even when projects exclude global memories.
    if (source !== 'history' && global && !allowedGlobal(settings)) return [];
    const maxCount = value => Number.isInteger(value) && value >= 1 ? Math.min(value, 100) : 12;
    const requestedCount = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 8;
    const count = Math.min(12, maxCount(settings.contextMaxMemories), requestedCount);
    // 过滤发生在「拿回命中之后」，所以带过滤时要多取几倍，否则 limit 会被过滤成 1–2 条。
    const filters = normalizeMemoryFilters({ kind, after, before, origin, projectId: projectFilter, includeArchived });
    if (filters.invalid !== undefined) return [];
    const filtered = hasMemoryFilters(filters);
    const fetchLimit = filtered ? Math.min(MAX_FETCH_LIMIT, count * FILTER_OVERFETCH_FACTOR) : count;
    const hits = source === 'history' ? [] : await repository.search({
      query: String(query || ''),
      projectId: global ? null : projectId,
      includeGlobal: allowedGlobal(settings),
      allProjects: false,
      includeSessions: false,
      limit: fetchLimit,
      // 只有显式要归档条目时才把仓库的 includeArchived 打开（默认查询里归档一律不出现）。
      ...(filters.includeArchived === true ? { includeArchived: true } : {}),
    });
    signal?.throwIfAborted();
    // Re-read settings so switch and budget changes during retrieval take effect.
    const latest = await repository.settings();
    signal?.throwIfAborted();
    if (latest?.memoryEnabled !== true) return [];
    const budgetFor = settings => Number.isInteger(settings.contextMaxChars) && settings.contextMaxChars >= 1
      ? Math.min(settings.contextMaxChars, 20000) : 6000;
    const budget = budgetFor(latest);
    const selected = [];
    // 先按过滤维度裁一遍（纯函数），再进范围/预算循环：过滤只认记忆条目，归档与退役条目
    // 在这里就被挡住，绝不会因为「刚好装得下」而漏进模型上下文。
    for (const hit of filterHits(Array.isArray(hits) ? hits : [], filters)) {
      const hitProject = hit.projectId ?? null;
      const inScope = global || projectId === null
        ? hitProject === null
        : hitProject === projectId || (hitProject === null && allowedGlobal(settings) && allowedGlobal(latest));
      if (hit.kind !== 'memory' || !inScope || (global && !allowedGlobal(latest)) ||
          selected.length >= Math.min(count, maxCount(latest.contextMaxMemories))) continue;
      // Count precisely the serialized fields sent to the model; never cut JSON.
      const projected = [...selected, hit].map(formatMemoryHit);
      if (JSON.stringify(projected).length <= budget) selected.push(hit);
    }
    const phrase = String(query || '').trim();
    // source:'memory' 的语义是「只搜记忆、不回退」，否则新枚举一上线就是错的。
    // 带过滤参数时同样不回退历史：聊天历史没有 kind / origin / 时间字段，回退结果无法满足过滤条件。
    if (!filtered && source !== 'memory' && !selected.length && phrase && typeof repository.readHistorySource === 'function') {
      const history = await repository.search({
        query: phrase, allProjects: true, includeGlobal: true, includeMemories: false,
        includeSessions: true, limit: count,
      });
      signal?.throwIfAborted();
      const current = await repository.settings();
      signal?.throwIfAborted();
      if (current?.memoryEnabled !== true) return [];
      const seen = new Set();
      for (const hit of Array.isArray(history) ? history : []) {
        if (hit.kind !== 'session' || typeof hit.conversationId !== 'string' || !hit.conversationId ||
            typeof hit.messageId !== 'string' || !hit.messageId || !['user', 'assistant'].includes(hit.role)) continue;
        const id = `history:${JSON.stringify([hit.conversationId, hit.messageId])}`;
        if (seen.has(id) || selected.length >= Math.min(count, maxCount(current.contextMaxMemories))) continue;
        seen.add(id);
        const candidate = { ...hit, id, title: titleFromConversation(hit.conversationId), text: historyOverview(hit.text, phrase) };
        if (candidate.text && JSON.stringify([...selected, candidate].map(formatMemoryHit)).length <= budgetFor(current)) {
          selected.push(candidate);
        }
      }
    }
    for (const hit of selected) {
      found.delete(hit.id);
      if (hit.conversationId && hit.messageId) {
        found.set(hit.id, { conversationId: hit.conversationId, messageId: hit.messageId,
          projectId: hit.projectId ?? null, history: hit.kind === 'session' });
      }
    }
    while (found.size > 128) found.delete(found.keys().next().value);
    return selected;
  };
  if (typeof repository.readMemorySource === 'function' || typeof repository.readHistorySource === 'function') {
    search.readSource = async ({ id, offset = 0, limit = 4000, mode = 'message' } = {}, signal) => {
      const source = found.get(id);
      if (!source) return { ok: false, code: 'source-unavailable' };
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 ||
          !['message', 'around', 'conversation'].includes(mode)) {
        return { ok: false, code: 'invalid-range' };
      }
      signal?.throwIfAborted();
      const settings = await repository.settings();
      if (source.history) {
        if (settings?.memoryEnabled !== true) return { ok: false, code: 'source-unavailable' };
        const result = await repository.readHistorySource({ conversationId: source.conversationId, messageId: source.messageId, mode });
        signal?.throwIfAborted();
        const latest = await repository.settings();
        signal?.throwIfAborted();
        if (latest?.memoryEnabled !== true || !result?.messages?.length) return { ok: false, code: 'source-unavailable' };
        const budget = Number.isSafeInteger(latest.contextMaxChars) && latest.contextMaxChars > 0 ? latest.contextMaxChars : 6000;
        const page = paginateHistory(result.messages, offset, Math.min(limit, budget, 6000));
        if (!page.messages.length) return { ok: false, code: 'invalid-range' };
        return { ok: true, id, mode, conversationId: source.conversationId, messageId: source.messageId,
          title: titleFromConversation(source.conversationId), offset, ...page,
          ...(mode === 'message' ? { text: page.messages[0].text, role: page.messages[0].role } : {}) };
      }
      if (settings?.memoryEnabled !== true || (source.projectId === null && !allowedGlobal(settings))) {
        return { ok: false, code: 'source-unavailable' };
      }
      if (typeof repository.readMemorySource !== 'function') return { ok: false, code: 'source-unavailable' };
      const original = await repository.readMemorySource({
        id, conversationId: source.conversationId, messageId: source.messageId,
        projectId, includeGlobal: allowedGlobal(settings),
      });
      signal?.throwIfAborted();
      const latest = await repository.settings();
      signal?.throwIfAborted();
      const inScope = original?.projectId === projectId || (original?.projectId === null && allowedGlobal(latest));
      if (latest?.memoryEnabled !== true || !inScope || (source.projectId === null && !allowedGlobal(latest)) ||
          typeof original?.text !== 'string' || !original.text.trim()) return { ok: false, code: 'source-unavailable' };
      const redaction = redactSensitive(original.text);
      const characters = Array.from(redaction.text);
      const budget = Number.isSafeInteger(latest.contextMaxChars) && latest.contextMaxChars > 0 ? latest.contextMaxChars : 6000;
      const end = Math.min(characters.length, offset + Math.min(limit, budget, 6000));
      if (offset >= characters.length) return { ok: false, code: 'invalid-range' };
      return {
        ok: true, id, conversationId: source.conversationId, messageId: source.messageId, role: original.role,
        text: characters.slice(offset, end).join(''), redacted: redaction.redacted,
        offset, nextOffset: end < characters.length ? end : null,
      };
    };
  }
  return search;
}

module.exports = {
  createAgentMemorySearch,
  formatMemoryHit,
  filterHits,
  normalizeMemoryFilters,
  hasMemoryFilters,
  toEpochMs,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  FILTER_OVERFETCH_FACTOR,
};
