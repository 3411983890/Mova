'use strict';
// Pure local adapter. No Electron, network, model calls, or external-file deletion.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { shouldAutoExtract } = require('./services/memory-policy.cjs');
const { memoryHash } = require('./services/memory-quality.cjs');
const { redactSensitive } = require('./services/memory-redaction.cjs');
const { selectHistorySource } = require('./services/history-source.cjs');
const { parseMemoryCommand, findCommandTargets } = require('./services/memory-commands.cjs');
const DEFAULT_SETTINGS = Object.freeze({
  autoExtract: true, memoryEnabled: true, includeGlobal: true, historyRetention: 'forever',
  maxMemories: 2000, contextMaxMemories: 12, contextMaxChars: 6000,
  autoStartServices: true, backupSchedule: 'daily 03:00', backupRetentionDays: 30,
  semanticSearch: true, hybridWeight: 0.5, extractorMode: 'llm', quotaBytes: 0,
});
class MemoryError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new MemoryError(code); };
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function string(value, max = 16000) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid-input'); return value.trim(); }
function scope(value) { if (value === null || value === undefined) return null; return string(value, 500); }
function bounded(value, fallback, max) { return value === undefined ? fallback : Number.isInteger(value) && value >= 1 && value <= max ? value : fail('invalid-input'); }
function sensitive(text) {
  return /(?:password|passwd|secret|api[\s_-]?key|access[\s_-]?token|private[\s_-]?key|密码|密碼|口令|密钥|密鑰|身份证|身份證|信用卡|银行卡|銀行卡)\s*[:：=是为為]?|\b(?:sk-[a-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[a-z0-9]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+/i.test(text);
}
function tokens(text) {
  const normalized = text.toLocaleLowerCase();
  const out = normalized.match(/[a-z0-9_-]+/g) || [];
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return [...new Set(out)];
}
function score(text, query) {
  const hay = text.toLocaleLowerCase();
  return tokens(query).reduce((n, token) => n + (hay.includes(token) ? 1 : 0), hay.includes(query.toLocaleLowerCase()) ? 3 : 0);
}
function initial() { return { version: 1, sessions: { version: 1, projects: [], conversations: [] }, memories: [], events: [], ingestions: [], tasks: [], checkpoints: [], settings: { ...DEFAULT_SETTINGS } }; }
function sessionMeta(id, data) {
  let parts; try { parts = JSON.parse(id); } catch {}
  // Legacy UI IDs are [mode, project, title]; ChatMova and bot sessions are global.
  const projectId = object(data) && Object.hasOwn(data, 'projectId') ? scope(data.projectId) : Array.isArray(parts) && parts[0] === 'CodeMova' ? scope(parts[1]) : null;
  return { projectId, temporary: Boolean(data?.temporary || (Array.isArray(parts) && /temporary|临时/i.test(String(parts[0])))) };
}
function createMemoryRepository(options = {}) {
  const filePath = options.filePath || (options.directory && path.join(options.directory, 'repository.json'));
  if (!filePath || !path.isAbsolute(filePath)) fail('invalid-path');
  const now = options.now || (() => new Date().toISOString());
  const id = options.id || randomUUID;
  const io = options.fs || fs;
  const extractor = options.extractor || null;
  let tail = Promise.resolve();
  let state;
  async function load() {
    if (state) return state;
    try {
      const value = JSON.parse(await io.readFile(filePath, 'utf8'));
      if (value?.version !== 1 || !Array.isArray(value.memories) || !Array.isArray(value.events) || !Array.isArray(value.sessions?.conversations) || !Array.isArray(value.ingestions) || !Array.isArray(value.tasks) || !Array.isArray(value.checkpoints)) fail('corrupt-store');
      state = { ...value, settings: { ...DEFAULT_SETTINGS, ...value.settings } };
      if (state.settings.extractorMode === 'rules') state.settings.extractorMode = 'llm';
    } catch (error) { if (error.code === 'ENOENT') state = initial(); else throw error instanceof MemoryError ? error : new MemoryError('corrupt-store'); }
    return state;
  }
  async function persist(next) {
    await io.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await io.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next), 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await io.rename(temp, filePath);
      // Directory fsync is supported on Unix; Windows does not allow directory handles.
      if (process.platform !== 'win32') { const dir = await io.open(path.dirname(filePath), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    } catch { if (handle) await handle.close().catch(() => {}); await io.unlink(temp).catch(() => {}); throw new MemoryError('storage-error'); }
  }
  function run(operation, write = false) {
    const result = tail.then(async () => {
      const current = await load(); const next = write ? clone(current) : current;
      const value = await operation(next);
      if (write) { await persist(next); state = next; }
      return clone(value);
    });
    tail = result.catch(() => {}); return result;
  }
  function event(s, type, entityId, eventId) {
    const stable = eventId || id();
    if (!s.events.some(e => e.id === stable)) s.events.push({ id: stable, type, entityId, at: now() });
    return stable;
  }
  /**
   * 可检索判定。`includeArchived` 只影响「归档（软删除）」条目：
   * 归档在落盘形态上就是 `status: 'disabled'`（与 memory-maintenance 的 plan.archive 一致，
   * 数据库侧 status 的 CHECK 也只允许 active/disabled/superseded，不需要新字段或迁移）。
   * `superseded` 条目**任何情况下**都不参与检索：它是历史链的一环，只能通过原 id 回查。
   */
  function eligible(m, projectId, includeGlobal, includeArchived) {
    const live = m.status === 'active' || (includeArchived === true && m.status === 'disabled');
    return live && (m.projectId === projectId || (includeGlobal && m.projectId === null));
  }
  function addMemory(s, input) {
    if (!object(input)) fail('invalid-input');
    const text = string(input.text, 4000); if (sensitive(text)) fail('sensitive-content');
    const projectId = scope(input.projectId);
    const key = input.key === undefined || input.key === null || input.key === '' ? null : string(input.key, 200);
    if (key && sensitive(key)) fail('sensitive-content');
    const status = input.status ?? 'active'; if (!['active', 'disabled'].includes(status)) fail('invalid-input');
    const kind = input.kind ?? 'fact'; if (!['fact', 'preference', 'decision', 'note'].includes(kind)) fail('invalid-input');
    const eventId = input.eventId === undefined ? null : string(input.eventId, 300);
    if (eventId && s.events.some(e => e.id === eventId)) return s.memories.find(m => m.id === s.events.find(e => e.id === eventId).entityId) || null;
    const normalizedHash = memoryHash(text);
    const existing = s.memories.find(m => m.projectId === projectId && m.status === 'active'
      && (m.text === text || (normalizedHash && m.normalizedHash === normalizedHash)) && m.key === key);
    if (existing) { if (eventId) event(s, 'memory.saved', existing.id, eventId); return existing; }
    if (s.memories.length >= s.settings.maxMemories) fail('memory-limit');
    const previous = key && status === 'active' ? s.memories.filter(m => m.projectId === projectId && m.key === key && m.status === 'active') : [];
    const memory = { id: id(), text, key, kind, projectId, status, pinned: input.pinned === true, source: input.source === 'automatic' ? 'automatic' : 'user', conversationId: input.conversationId ? string(input.conversationId, 1000) : null, messageId: input.messageId ? string(input.messageId, 500) : null, normalizedHash, importance: input.pinned === true ? 1 : (Number.isFinite(input.confidence) ? Math.max(0.3, Math.min(1, input.confidence)) : (input.source === 'user' ? 0.9 : 0.5)), useCount: 0, lastUsedAt: null, observedAt: now(), createdAt: now(), updatedAt: now(), version: previous.length ? Math.max(...previous.map(m => m.version)) + 1 : 1, supersedes: previous.map(m => m.id) };
    for (const old of previous) { old.status = 'superseded'; old.supersededBy = memory.id; old.updatedAt = now(); }
    s.memories.push(memory); event(s, 'memory.saved', memory.id, eventId); return memory;
  }
  const repository = {
    read: () => run(async s => ({ ...s, storage: { filePath, bytes: await io.stat(filePath).then(stat => stat.size).catch(error => { if (error.code === 'ENOENT') return 0; throw new MemoryError('storage-error'); }) } })), 
    loadSessions: () => run(s => s.sessions),
    readHistorySource: ({ conversationId, messageId, mode = 'message' }) => run(s => {
      if (!s.settings.memoryEnabled) return null;
      const data = s.sessions.conversations.find(row => row[0] === conversationId)?.[1];
      if (!data || sessionMeta(conversationId, data).temporary) return null;
      const messages = Array.isArray(data) ? data : data.messages;
      if (!Array.isArray(messages)) return null;
      const turns = messages.map(message => {
        if (!message?.id || message.temporary || message.mock || message.demo || ['mock', 'demo'].includes(message.source)) return [];
        const parts = [];
        const role = message.role || 'user';
        const text = message.text ?? message.user;
        if (['user', 'assistant'].includes(role) && typeof text === 'string' && text.trim()) {
          parts.push({ messageId: message.id, role, text });
        }
        const reply = message.reply;
        const replyText = typeof reply === 'string' ? reply : reply?.text;
        if (typeof replyText === 'string' && replyText.trim() && !reply.mock && !reply.demo && !['mock', 'demo'].includes(reply.source)) {
          parts.push({ messageId: `${message.id}-assistant`, role: 'assistant', text: replyText });
        }
        return parts;
      });
      const selected = selectHistorySource(turns, messageId, mode);
      return selected ? { messages: selected } : null;
    }),
    readMemorySource: ({ id, conversationId, messageId, projectId, includeGlobal }) => run(s => {
      const memory = s.memories.find(item => item.id === id && item.conversationId === conversationId && item.messageId === messageId);
      if (!s.settings.memoryEnabled || !memory || !eligible(memory, projectId, includeGlobal && s.settings.includeGlobal !== false)) return null;
      const source = s.sessions.conversations.find(row => row[0] === conversationId);
      if (!source) return null;
      const data = source[1];
      const meta = sessionMeta(conversationId, data);
      if (meta.temporary || (meta.projectId !== projectId &&
          !(meta.projectId === null && includeGlobal && s.settings.includeGlobal !== false))) return null;
      const messages = Array.isArray(data) ? data : data?.messages;
      if (!Array.isArray(messages)) return null;
      const direct = messages.find(message => message?.id === messageId);
      const message = direct || (messageId.endsWith('-assistant') && messages.find(item => item?.id === messageId.slice(0, -10)));
      if (!message || message.temporary || message.mock || message.demo || ['mock', 'demo'].includes(message.source)) return null;
      const reply = message.reply;
      if (!direct && (!reply || reply.mock || reply.demo || ['mock', 'demo'].includes(reply.source))) return null;
      const role = direct ? message.role || 'user' : 'assistant';
      const text = direct ? message.text ?? message.user : typeof reply === 'string' ? reply : reply.text;
      return ['user', 'assistant'].includes(role) && typeof text === 'string' ? { role, text, projectId: meta.projectId } : null;
    }),
    saveSessions: snapshot => run(s => {
      if (!object(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.conversations)) fail('invalid-snapshot');
      if (JSON.stringify(snapshot).length > 30_000_000) fail('snapshot-limit');
      const safe = clone(snapshot);
      safe.conversations = safe.conversations.filter(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !(Array.isArray(entry[1]) || object(entry[1]))) fail('invalid-snapshot');
        const data = entry[1];
        if (Array.isArray(data)) entry[1] = data.filter(message => !message?.temporary);
        else if (Array.isArray(data.messages)) data.messages = data.messages.filter(message => !message?.temporary);
        return !sessionMeta(entry[0], data).temporary;
      });
      s.sessions = safe; event(s, 'sessions.saved', null, `sessions:${hash(safe)}`); return s.sessions;
    }, true),
    ingest: input => run(async s => {
      if (!object(input)) fail('invalid-input');
      if (input.temporary === true || (input.role !== undefined && input.role !== 'user') || (input.author !== undefined && input.author !== 'user')) return { extracted: [], skipped: 'ineligible', extractor: 'llm' };
      if (typeof input.text !== 'string' || !input.text.trim()) return { extracted: [], skipped: 'empty', extractor: 'llm' };
      const conversationId = string(input.conversationId, 1000), messageId = string(input.messageId, 500), projectId = scope(input.projectId), text = string(input.text, 60000);
      const command = parseMemoryCommand(text);
      if (command) {
        const targets = findCommandTargets(s.memories.filter(m => m.status === 'active' && (m.projectId === projectId || m.projectId === null)), command);
        if (!targets.length) return { action: 'none', extracted: [], skipped: 'no-target', extractor: 'local-command' };
        if (targets.length > 1) return { action: 'confirm', extracted: [], skipped: 'needs-confirmation', extractor: 'local-command', candidates: targets };
        const target = targets[0];
        if (command.action === 'forget') {
          s.memories = s.memories.filter(m => m.id !== target.id);
          event(s, 'memory.deleted', target.id);
          return { action: 'forget', deleted: true, memoryId: target.id, text: target.text, extractor: 'local-command' };
        }
        const replacement = String(command.replacement || '').trim();
        if (!replacement || replacement.length > 4000) return { action: 'none', extracted: [], skipped: 'invalid-replacement', extractor: 'local-command' };
        const memory = s.memories.find(m => m.id === target.id);
        const nextText = memory.text.includes(command.query) ? memory.text.replace(command.query, replacement) : replacement;
        memory.text = nextText;
        memory.normalizedHash = memoryHash(nextText);
        memory.updatedAt = now();
        event(s, 'memory.updated', memory.id);
        return { action: 'correct', updated: true, memoryId: memory.id, text: nextText, extractor: 'local-command' };
      }
      if (!shouldAutoExtract(s.settings) || s.settings.extractorMode !== 'llm') return { extracted: [], skipped: 'disabled', extractor: 'llm' };
      const redaction = redactSensitive(text);
      const safeText = redaction.text;
      if (s.memories.length >= s.settings.maxMemories) return { extracted: [], skipped: 'memory-limit', extractor: 'llm' };
      const eventId = `ingest:${hash([projectId, conversationId, messageId])}`;
      const prior = s.ingestions.find(i => i.id === eventId);
      if (prior) return { extracted: s.memories.filter(m => prior.memoryIds.includes(m.id)), duplicate: true, skipped: 'duplicate', extractor: 'llm' };
      if (!extractor || typeof extractor.extract !== 'function') return { extracted: [], skipped: 'llm-unavailable', extractor: 'llm' };
      let result;
      try {
        result = await extractor.extract(safeText, { projectId, conversationId, messageId });
      } catch (error) {
        return { extracted: [], skipped: 'llm-failed', extractor: 'llm', error: typeof error?.code === 'string' ? error.code : 'llm-failed' };
      }
      const meta = { extractor: 'llm', providerId: result?.providerId ?? null, modelId: result?.modelId ?? null, usage: result?.usage ?? null };
      const list = Array.isArray(result) ? result : Array.isArray(result?.memories) ? result.memories : [];
      const candidates = list.flatMap(item => {
        if (typeof item === 'string') return item.trim() ? [{ text: item.trim(), kind: 'fact', key: null, confidence: 0.7 }] : [];
        if (!object(item) || typeof item.text !== 'string' || !item.text.trim()) return [];
        return [{
          text: item.text.trim().slice(0, 1000),
          kind: ['fact', 'preference', 'decision', 'note'].includes(item.kind) ? item.kind : 'fact',
          key: typeof item.key === 'string' && item.key.trim() ? item.key.trim().slice(0, 200) : null,
          confidence: Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : 0.7,
        }];
      }).slice(0, 5);
      if (!candidates.length) {
        s.ingestions.push({ id: eventId, memoryIds: [] });
        return {
          extracted: [],
          skipped: redaction.redacted ? 'sensitive-content' : 'no-memory',
          ...(redaction.redacted ? { redacted: redaction.kinds } : {}),
          ...meta,
        };
      }
      const extracted = [];
      let skipped = null;
      for (const [index, candidate] of candidates.entries()) {
        if (candidate.text.includes('[REDACTED]')) { skipped = 'sensitive-content'; continue; }
        try {
          extracted.push(addMemory(s, {
            text: candidate.text, key: candidate.key, projectId, conversationId, messageId,
            source: 'automatic', kind: candidate.kind, confidence: candidate.confidence,
            eventId: `${eventId}:${index}`,
          }));
        } catch (error) {
          if (error?.code === 'sensitive-content' || error?.code === 'memory-limit') { skipped = error.code; continue; }
          throw error;
        }
      }
      // Store only IDs, never raw ingest text (especially secrets).
      s.ingestions.push({ id: eventId, memoryIds: extracted.map(m => m.id) });
      event(s, 'message.ingested', eventId, eventId);
      return { extracted, skipped, ...(redaction.redacted ? { redacted: redaction.kinds } : {}), ...meta };
    }, true),
    query: (input = {}) => run(s => {
      const projectId = scope(input.projectId), includeGlobal = input.includeGlobal ?? s.settings.includeGlobal, limit = bounded(input.limit, 30, 100), query = typeof input.query === 'string' ? input.query.trim().slice(0, 1000) : '';
      // Explicit user-initiated search across the user's own scopes. Never a wildcard projectId.
      const allProjects = input.allProjects === true;
      // 归档条目默认不出现；只有显式 includeArchived === true 才进结果集（命中带 archived 标记）。
      const includeArchived = input.includeArchived === true;
      const hits = [];
      if (input.includeMemories !== false) {
        for (const m of s.memories) {
          const inScope = allProjects ? (m.status === 'active' || (includeArchived && m.status === 'disabled'))
            : eligible(m, projectId, includeGlobal === true, includeArchived);
          if (!inScope) continue;
          const rank = query ? score(m.text, query) : 1;
          if (rank) hits.push({ ...m, kind: 'memory', memoryKind: m.kind, score: rank, ...(m.status === 'disabled' ? { archived: true } : {}) });
        }
      }
      if (input.includeSessions !== false) for (const [conversationId, data] of s.sessions.conversations) {
        const meta = sessionMeta(conversationId, data);
        if (meta.temporary || !(allProjects || meta.projectId === projectId || (includeGlobal === true && meta.projectId === null))) continue;
        const messages = Array.isArray(data) ? data : data.messages;
        for (const message of Array.isArray(messages) ? messages : []) {
          if (!message || message.temporary || message.mock || message.demo || ['mock', 'demo'].includes(message.source)) continue;
          const parts = [{ text: message.text, messageId: message.id ?? null, role: message.role || 'user' }];
          if (message.reply && !message.reply.mock && !message.reply.demo && !['mock', 'demo'].includes(message.reply.source)) {
            parts.push({ text: message.reply.text, messageId: message.id ? `${message.id}-assistant` : null, role: 'assistant' });
          }
          // Never index thinking, tool payloads, or demo output. Original snapshots remain intact.
          for (const part of parts) {
            if (typeof part.text !== 'string' || !part.text.trim() || sensitive(part.text) || ['tool', 'system', 'thinking'].includes(part.role)) continue;
            const rank = query ? score(part.text, query) : 1;
            if (rank) hits.push({ kind: 'session', id: `${conversationId}:${part.messageId}`, text: part.text, conversationId, messageId: part.messageId, role: part.role, projectId: meta.projectId, score: rank });
          }
        }
      }
      return hits.sort((a, b) => b.score - a.score || Number(b.pinned || false) - Number(a.pinned || false)).slice(0, limit);
    }),
    context: (input = {}) => run(async s => {
      const projectId = scope(input.projectId), includeGlobal = input.includeGlobal ?? s.settings.includeGlobal;
      const limit = Math.min(bounded(input.limit, s.settings.contextMaxMemories, 100), s.settings.contextMaxMemories);
      const budget = Math.min(bounded(input.maxChars, s.settings.contextMaxChars, 20000), s.settings.contextMaxChars);
      if (!s.settings.memoryEnabled || input.temporary === true) return { memories: [], text: '', enabled: false, usedIds: [] };
      const query = typeof input.query === 'string' ? input.query.trim().slice(0, 1000) : '';
      const candidates = s.memories.filter(m => eligible(m, projectId, includeGlobal === true)).map(m => ({ m, rank: query ? score(m.text, query) : 0 })).sort((a, b) => Number(b.m.pinned) - Number(a.m.pinned) || b.rank - a.rank || b.m.updatedAt.localeCompare(a.m.updatedAt));
      let reranked = false;
      let rerankError = null;
      if (query && extractor && typeof extractor.rerank === 'function' && candidates.length > limit) {
        try {
          const result = await extractor.rerank(query, candidates.slice(0, 60).map(({ m }) => ({ id: m.id, text: m.text })), limit);
          const order = new Map((result?.ids || []).map((id, index) => [String(id), index]));
          if (order.size) {
            candidates.sort((a, b) => (order.has(a.m.id) ? order.get(a.m.id) : Number.MAX_SAFE_INTEGER)
              - (order.has(b.m.id) ? order.get(b.m.id) : Number.MAX_SAFE_INTEGER));
            reranked = true;
          }
        } catch (error) {
          rerankError = typeof error?.code === 'string' ? error.code : 'llm-rerank-failed';
        }
      }
      const memories = []; let text = '';
      for (const { m } of candidates) {
        if (m.expiresAt && Date.parse(m.expiresAt) <= Date.now()) continue;
        const line = JSON.stringify({
          id: m.id, text: m.text, source: m.source, conversationId: m.conversationId,
          messageId: m.messageId, observedAt: m.observedAt ?? null,
          validTo: m.validTo ?? null, expiresAt: m.expiresAt ?? null,
        }) + '\n';
        if (memories.length < limit && text.length + line.length <= budget) { memories.push(m); text += line; }
      }
      return { memories, text, enabled: true, reranked, usedIds: memories.map(m => m.id), ...(rerankError ? { rerankError } : {}) };
    }),
    saveMemory: input => run(s => addMemory(s, input), true),
    /**
     * 用一条新记忆替代旧记忆：旧条目标 `superseded` + `supersededBy`，新条目留在活跃集，
     * 历史链（旧 → 新）因此可追溯，默认检索只剩新条目。
     *
     * 只在内存里改既有结构，没有第二套存储：新条目走同一个 addMemory（配额/敏感词/去重规则一致），
     * 旧条目用状态位退役（与 maintenance 的 merge 分支同一口径）。
     *
     * @param {{ id: string, text: string, kind?: string, source?: string }} input
     * @returns {Promise<object>} 替代后的**新**记忆（`supersedes` 里带旧 id）
     */
    supersedeMemory: (input = {}) => run(s => {
      if (!object(input)) fail('invalid-input');
      const target = typeof input.id === 'string' ? input.id.trim() : '';
      const previous = s.memories.find(m => m.id === target);
      if (!previous) fail('not-found');
      if (previous.status === 'superseded') fail('invalid-status');
      const text = string(input.text, 4000);
      if (sensitive(text)) fail('sensitive-content');
      // 内容没变化就没有「替代」可言：直接更新正文用 updateMemory，别在这里造一条同义条目。
      if (memoryHash(text) === previous.normalizedHash) fail('invalid-input');
      const kind = input.kind === undefined ? previous.kind : input.kind;
      if (!['fact', 'preference', 'decision', 'note'].includes(kind)) fail('invalid-input');
      const replacement = addMemory(s, {
        text,
        kind,
        projectId: previous.projectId,
        key: previous.key,
        source: input.source === 'automatic' ? 'automatic' : 'user',
      });
      if (replacement.id === previous.id) fail('invalid-input');
      // addMemory 只在 key 命中时自动退役同 key 的活跃条目；没有 key 的情况在这里补上（幂等）。
      if (previous.status !== 'superseded') {
        previous.status = 'superseded';
        previous.supersededBy = replacement.id;
        previous.updatedAt = now();
      }
      if (!Array.isArray(replacement.supersedes)) replacement.supersedes = [];
      if (!replacement.supersedes.includes(previous.id)) replacement.supersedes.push(previous.id);
      event(s, 'memory.superseded', previous.id);
      return replacement;
    }, true),
    updateMemory: (memoryId, patch) => run(s => {
      const m = s.memories.find(m => m.id === memoryId); if (!m) fail('not-found'); if (!object(patch)) fail('invalid-input');
      if (Object.keys(patch).some(key => !['text', 'status', 'pinned'].includes(key))) fail('invalid-input');
      // 已退役（superseded）的条目只保留历史，不允许再改正文：改完也检索不到，静默成功只会骗模型。
      if (patch.text !== undefined && m.status === 'superseded') fail('invalid-status');
      if (patch.text !== undefined) { const text = string(patch.text, 4000); if (sensitive(text)) fail('sensitive-content'); m.text = text; m.normalizedHash = memoryHash(text); }
      if (patch.status !== undefined) { if (!['active', 'disabled'].includes(patch.status) || m.status === 'superseded') fail('invalid-status'); if (patch.status === 'active' && m.key && s.memories.some(other => other.id !== m.id && other.projectId === m.projectId && other.key === m.key && other.status === 'active')) fail('key-conflict'); m.status = patch.status; }
      if (patch.pinned !== undefined) { if (typeof patch.pinned !== 'boolean') fail('invalid-input'); m.pinned = patch.pinned; }
      m.updatedAt = now(); event(s, 'memory.updated', m.id); return m;
    }, true),
    deleteMemory: memoryId => run(s => { const m = s.memories.find(m => m.id === memoryId); if (!m) return false; s.memories = s.memories.filter(m => m.id !== memoryId); event(s, 'memory.deleted', memoryId); return true; }, true),
    settings: patch => run(s => {
      if (patch === undefined) return s.settings;
      if (!object(patch) || Object.keys(patch).some(k => !Object.hasOwn(DEFAULT_SETTINGS, k))) fail('invalid-settings');
      for (const [key, value] of Object.entries(patch)) {
        if (['autoExtract', 'memoryEnabled', 'includeGlobal', 'autoStartServices', 'semanticSearch'].includes(key) && typeof value !== 'boolean') fail('invalid-settings');
        if (key === 'historyRetention' && value !== 'forever') fail('invalid-settings');
        if (key === 'maxMemories') bounded(value, 2000, 10000);
        if (key === 'contextMaxMemories') bounded(value, 12, 100);
        if (key === 'contextMaxChars') bounded(value, 6000, 20000);
        if (key === 'backupSchedule' && (typeof value !== 'string' || !value.trim() || value.length > 50)) fail('invalid-settings');
        if (key === 'backupRetentionDays') bounded(value, 30, 365);
        if (key === 'hybridWeight' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) fail('invalid-settings');
        if (key === 'extractorMode' && !['llm', 'off'].includes(value)) fail('invalid-settings');
        if (key === 'quotaBytes' && (!Number.isInteger(value) || value < 0 || value > 1099511627776)) fail('invalid-settings');
        s.settings[key] = value;
      }
      event(s, 'settings.updated', null); return s.settings;
    }, patch !== undefined),
    exportData: () => run(s => s),
    clear: input => run(s => {
      const target = input?.target; if (!['memories', 'sessions', 'tasks', 'all'].includes(target)) fail('invalid-target');
      if (target === 'all') { Object.assign(s, initial()); }
      if (target === 'memories') { s.memories = []; s.ingestions = []; s.events = s.events.filter(e => !e.type.startsWith('memory.') && e.type !== 'message.ingested'); }
      if (target === 'sessions') s.sessions = initial().sessions;
      if (target === 'tasks') { s.tasks = []; s.checkpoints = []; }
      event(s, `cleared.${target}`, null); return { cleared: target };
    }, true),
    saveTask: input => run(s => {
      if (!object(input)) fail('invalid-input'); const title = string(input.title, 500); if (sensitive(title)) fail('sensitive-content');
      const taskId = input.id ? string(input.id, 200) : id(), existing = s.tasks.find(t => t.id === taskId);
      const status = input.status ?? 'pending'; if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) fail('invalid-status');
      const task = { id: taskId, title, projectId: scope(input.projectId), status, createdAt: existing?.createdAt || now(), updatedAt: now() };
      s.tasks = s.tasks.filter(t => t.id !== taskId); s.tasks.push(task); event(s, 'task.saved', taskId); return task;
    }, true),
    listTasks: (input = {}) => run(s => s.tasks.filter(t => t.projectId === scope(input.projectId))),
    saveCheckpoint: input => run(s => {
      if (!object(input)) fail('invalid-input'); const task = s.tasks.find(t => t.id === input.taskId); if (!task) fail('not-found');
      const text = string(input.text, 4000); if (sensitive(text)) fail('sensitive-content');
      const checkpoint = { id: id(), taskId: task.id, projectId: task.projectId, text, createdAt: now() }; s.checkpoints.push(checkpoint); event(s, 'checkpoint.saved', checkpoint.id); return checkpoint;
    }, true),
    listCheckpoints: (input = {}) => run(s => s.checkpoints.filter(c => c.projectId === scope(input.projectId) && (!input.taskId || c.taskId === input.taskId))),
  };
  return repository;
}
module.exports = { createMemoryRepository, MemoryError, DEFAULT_SETTINGS };
