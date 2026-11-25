'use strict';
// PostgreSQL implementation of the Mova MemoryRepository contract
// (Mova服务版接口约定.md §4) with the exact behavioural semantics of the
// current local adapter (electron/memory-store.cjs).
//
// Layering:
//   - this file: validation, scope rules, extraction, ranking, response shape
//   - ./postgres-store.cjs: every SQL statement, parameterized, owner-scoped
// The store can be injected (`options.store`) so the semantics are testable
// without PostgreSQL; production always builds the SQL store from `pool` or
// `connectionString`/MOVA_DB_URL.
//
// Optional services (injected by main.cjs / worker):
//   embeddingService: { model?, dim?, status?(), embed(texts, { type }) }
//                     `type` is 'query' (prefix "query: ") or 'passage'
//                     (prefix "passage: "), e5 convention from contract §6.
//   searchEngine:     { rebuild({ ownerId }): Promise<{ queued? }> } — optional
//                     index coordinator used when no queue is configured.
//   queue:            BullMQ-like { add(name, data, opts), getWaitingCount?(),
//                     getFailedCount?(), client?.ping?(), health?() }.
//   backupManager:    { create({ kind }), restore(record), health?() }.
//   extractor:        optional low-cost LLM extractor { extract(text) }.
const { createHash, randomUUID } = require('node:crypto');
const { createPgStore, DEFAULT_OWNER_ID } = require('./postgres-store.cjs');
const { shouldAutoExtract } = require('../services/memory-policy.cjs');
const { createMemoryJobs } = require('../services/memory-jobs.cjs');
const { mergeCandidates, rankCandidates, estimateTokens } = require('../services/memory-retrieval.cjs');
const { selectRelevantCandidates, selectRerankedCandidates } = require('../services/memory-context-selection.cjs');
const { memoryHash } = require('../services/memory-quality.cjs');
const { redactSensitive } = require('../services/memory-redaction.cjs');
const { selectHistorySource } = require('../services/history-source.cjs');
const { planMaintenance } = require('../services/memory-maintenance.cjs');
const { parseMemoryCommand, findCommandTargets } = require('../services/memory-commands.cjs');
const { parseCloudOrigin } = require('../../src/services/cloud-connection.mjs');

// Reuse the local store's MemoryError class when available so memory-ipc.cjs
// keeps mapping `error instanceof MemoryError` to stable IPC error codes.
let SharedMemoryError = null;
try {
  ({ MemoryError: SharedMemoryError } = require('../memory-store.cjs'));
} catch {
  SharedMemoryError = null;
}
class LocalMemoryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const MemoryError = typeof SharedMemoryError === 'function' ? SharedMemoryError : LocalMemoryError;

const SINGLE_USER_ID = DEFAULT_OWNER_ID;
const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
const EMBEDDING_DIM = 384;
const PROJECT_OVERLAY_KEY = '@projects'; // project UI attributes kept in mova_settings.data
const PERMISSION_PRESETS_KEY = '@chatPermissionPresets';
const MODEL_SELECTIONS_KEY = '@chatModelSelections';
// 会话级状态（目标 / 计划、提供商返回的真实 token 用量）。它们不是消息行，但必须
// 和会话一起读写：漏掉它们时每次读回会话都会把用量清零，界面上就是「对话一停就清空」。
const CHAT_AIMS_KEY = '@chatAims';
const CHAT_USAGE_KEY = '@chatUsage';
// 「已归档」的对话键集合，行形状与 @chatAims / @chatUsage 一致（`[对话键, true]`）。
// 归档不是消息行，但它同样是会话级 UI 状态：不存这里的话，重启后每条聊天都会被
// buildProjects() 重建回未归档，界面上的「已归档」全部复原。
const CHAT_ARCHIVED_KEY = '@chatArchived';
// 「归档标记还在、但库里没有会话行」的聊天（临时聊天、首次发送中断、会话行被一次
// 残缺快照删掉）的时间戳。这类聊天只能从 `@chatArchived` 反解出 `{mode, project, title}`，
// 没有任何会话行可以取时间；不留一份时间戳的话，归档页只能显示 1970 年，排序也会
// 把它们全部堆到最早。行形状与 @chatAims 一致：`[对话键, { createdAt, updatedAt }]`，
// 数值毫秒。
const CHAT_ACTIVITY_KEY = '@chatActivity';
const RRF_K = 60;

// Contract §12 plus the pre-existing local settings (§9.1-§9.4). The settings
// page reads this exact object; unknown keys are rejected.
const DEFAULT_SETTINGS = Object.freeze({
  autoExtract: true,
  memoryEnabled: true,
  includeGlobal: true,
  historyRetention: 'forever',
  maxMemories: 2000,
  contextMaxMemories: 12,
  contextMaxChars: 6000,
  semanticSearch: true,
  hybridWeight: 0.5,
  extractorMode: 'llm',
  autoStartServices: true,
  backupSchedule: 'daily 03:00',
  backupRetentionDays: 30,
  quotaBytes: 0,
});

const ERROR_CODES = new Set([
  'invalid-input',
  'invalid-snapshot',
  'snapshot-limit',
  'invalid-settings',
  'invalid-target',
  'invalid-status',
  'invalid-state',
  'sensitive-content',
  'memory-limit',
  'not-found',
  'key-conflict',
  'backup-unavailable',
  'restore-unavailable',
  'service-unavailable',
  'embedding-unavailable',
  'embedding-dimension-mismatch',
  'database-unavailable',
  'pg-unavailable',
  'invalid-config',
  'storage-error',
]);

const fail = code => {
  throw new MemoryError(code);
};
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function string(value, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid-input');
  return value.trim();
}
function scope(value) {
  if (value === null || value === undefined) return null;
  return string(value, 500);
}
function bounded(value, fallback, max) {
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && value >= 1 && value <= max) return value;
  fail('invalid-input');
}
function isoTimestamp(value, fallback) {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}
function uuidFromHash(seed) {
  const hex = hash(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- rules copied verbatim from electron/memory-store.cjs -------------------
// (memory-store.cjs is owned by another agent; these are the same rules and
// must stay in sync. Keeping them here avoids importing private helpers.)
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
// --- session snapshot mapping (contract §3.2) -------------------------------
function keyParts(idValue) {
  try {
    const parts = JSON.parse(idValue);
    return Array.isArray(parts) ? parts : null;
  } catch {
    return null;
  }
}
function sessionMeta(idValue, data) {
  const parts = keyParts(idValue);
  // Legacy UI IDs are [mode, project, title]; ChatMova and bot sessions are global.
  const projectId = object(data) && Object.hasOwn(data, 'projectId')
    ? scope(data.projectId)
    : Array.isArray(parts) && parts[0] === 'CodeMova'
      ? scope(parts[1])
      : null;
  const temporary = Boolean(data?.temporary || (Array.isArray(parts) && /temporary|临时/i.test(String(parts[0]))));
  return { projectId, temporary };
}
function sidebarProject(idValue) {
  const parts = keyParts(idValue);
  return parts && typeof parts[1] === 'string' && parts[1].trim() ? parts[1].trim() : null;
}
function conversationMode(idValue) {
  const parts = keyParts(idValue);
  return parts && typeof parts[0] === 'string' && parts[0].trim() ? parts[0].trim() : 'CodeMova';
}
function conversationTitle(idValue, data) {
  const parts = keyParts(idValue);
  const title = parts && typeof parts[2] === 'string' && parts[2].trim()
    ? parts[2]
    : typeof data?.title === 'string' && data.title.trim()
      ? data.title
      : idValue;
  return String(title).slice(0, 500);
}
/**
 * 渲染层 `chatConversationKey()`（app.js）的同一套拼法：`JSON.stringify([mode || 'CodeMova', project, title])`。
 * `conversations` 行主键就是这个字符串，所以它必须逐字符一致（不要在这里改成 join / trim / 对象，
 * 否则重启后归档状态对不上）。
 */
function conversationKeyOf(projectName, chat) {
  const mode = typeof chat?.mode === 'string' && chat.mode ? chat.mode : 'CodeMova';
  return JSON.stringify([mode, projectName, chat?.title]);
}
/**
 * 从快照的 `projects[].chats` 里收集 `archived === true` 的对话键。渲染层只把归档状态
 * 放在 chat 行上，主进程要按对话键转成 settings 行才存得下来。
 */
function archivedConversationKeys(projects) {
  const keys = new Set();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!object(project) || typeof project.name !== 'string' || !project.name.trim()) continue;
    for (const chat of Array.isArray(project.chats) ? project.chats : []) {
      if (!object(chat) || chat.archived !== true || typeof chat.title !== 'string' || !chat.title) continue;
      keys.add(conversationKeyOf(project.name, chat));
    }
  }
  return keys;
}
/**
 * 解析 `@chatArchived` 行 `[对话键, true]`。值不是对象，所以不能复用 sessionRows()
 * （它要求 `row[1]` 是对象）；脏行同样只丢自己，不让一次读取整体失败。
 */
function archivedKeySet(value, keys) {
  const set = new Set();
  for (const row of Array.isArray(value) ? value : []) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0] || row[1] !== true) continue;
    if (keys && !keys.has(row[0])) continue;
    set.add(row[0]);
  }
  return set;
}
/**
 * 时间戳统一成**数字毫秒**。渲染层的 `archiveEntries()` 用数值减法排序
 * （`b.chat.updatedAt - a.chat.updatedAt`），给 ISO 字符串只会得到 `NaN`；
 * 侧栏的 `chatStamp()` 也只认数字。取不到就是 0，绝不返回字符串。
 */
function numberStamp(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}
/** 会话内容自己的时间：最后一条事件的时间。没有事件返回 null（不要拿会话行的保存时间冒充）。 */
function lastEventMillis(conversation) {
  let max = null;
  for (const event of Array.isArray(conversation?.events) ? conversation.events : []) {
    if (!event) continue;
    const value = event.createdAt ?? event.created_at ?? null;
    if (typeof value === 'number' && Number.isFinite(value)) max = max === null ? value : Math.max(max, value);
    else if (typeof value === 'string' && value) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) max = max === null ? parsed : Math.max(max, parsed);
    }
  }
  return max;
}
/**
 * 一行聊天存在哪里。会话行里有位置信息就用它；没有才回落（项目 overlay 的
 * `device` 是渲染层自己的项目级提示），最后才是 `'local'`。写死 `'local'` 会让
 * 归档页的「云端」筛选永远查不到东西。
 */
function locationOf(conversation, extra) {
  for (const value of [conversation?.location, conversation?.device]) {
    if (value === 'cloud' || value === 'local') return value;
  }
  return extra?.device === 'cloud' ? 'cloud' : 'local';
}
function persistedCloudRoute(value) {
  if (!value?.cloudOrigin) return {};
  let cloudOrigin;
  try { cloudOrigin = parseCloudOrigin(value.cloudOrigin); } catch { return {}; }
  const cloudConversationId = typeof value.cloudConversationId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.cloudConversationId) ? value.cloudConversationId : null;
  return { cloudOrigin, ...(cloudConversationId ? { cloudConversationId } : {}) };
}
/** `@chatActivity` → Map<对话键, { createdAt, updatedAt }>。脏行只丢自己。 */
function activityMap(value) {
  const out = new Map();
  for (const row of Array.isArray(value) ? value : []) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0] || !object(row[1])) continue;
    out.set(row[0], {
      createdAt: numberStamp(row[1].createdAt, 0),
      updatedAt: numberStamp(row[1].updatedAt, 0),
    });
  }
  return out;
}
function stableEventId(conversationId, message, index) {
  const raw = message?.id;
  if (typeof raw === 'string' && raw.trim() && raw.trim().length <= 300) return raw.trim();
  // No renderer id: derive a deterministic id so re-saving the same snapshot
  // never inserts a second event.
  return `evt_${hash(`${conversationId}\u0000${index}\u0000${JSON.stringify(message)}`).slice(0, 32)}`;
}
function eventContent(turn) {
  const userText = typeof turn.text === 'string' ? turn.text : typeof turn.user === 'string' ? turn.user : '';
  const reply = turn.reply === undefined ? null : turn.reply;
  const replyText = typeof reply === 'string' ? reply : typeof reply?.text === 'string' ? reply.text : '';
  return {
    user: typeof turn.text === 'string' ? turn.text : userText,
    reply,
    attempts: turn.attempts === undefined ? null : turn.attempts,
    turn,
    // Keyword channel only; never includes hidden thinking or tool payloads.
    search: `${userText}\n${replyText}`.toLocaleLowerCase().slice(0, 24000),
  };
}
function rebuildTurns(events) {
  const sorted = [...events].filter(event => event.type === 'message').sort((a, b) => a.sequence - b.sequence);
  const turns = [];
  for (const event of sorted) {
    const content = object(event.content) ? event.content : {};
    const turn = object(content.turn) ? content.turn : null;
    if (turn) {
      if (turn.temporary !== true) turns.push(turn);
      continue;
    }
    const fallback = { id: event.eventId, text: typeof content.user === 'string' ? content.user : '' };
    if (content.reply !== undefined && content.reply !== null) fallback.reply = content.reply;
    if (content.attempts !== undefined && content.attempts !== null) fallback.attempts = content.attempts;
    turns.push(fallback);
  }
  return turns;
}
function messageParts(row, { forSourceRead = false } = {}) {
  const content = object(row.content) ? row.content : {};
  const turn = object(content.turn) ? content.turn : null;
  const parts = [];
  if (turn) {
    if (turn.temporary === true || turn.mock === true || turn.demo === true || ['mock', 'demo'].includes(turn.source)) return [];
    const text = typeof turn.text === 'string' ? turn.text : typeof turn.user === 'string' ? turn.user : '';
    parts.push({ text, messageId: turn.id ?? null, role: typeof turn.role === 'string' ? turn.role : 'user' });
    const reply = turn.reply === undefined ? content.reply : turn.reply;
    const replyText = typeof reply === 'string' ? reply : typeof reply?.text === 'string' ? reply.text : '';
    // Never index thinking, tool payloads, mock or demo output.
    const rejected = typeof reply === 'object' && reply !== null
      && (reply.mock === true || reply.demo === true || ['mock', 'demo'].includes(reply.source));
    if (replyText && !rejected) parts.push({ text: replyText, messageId: turn.id ? `${turn.id}-assistant` : null, role: 'assistant' });
  } else {
    parts.push({ text: typeof content.user === 'string' ? content.user : '', messageId: null, role: 'user' });
    const replyText = typeof content.reply === 'string' ? content.reply : content.reply?.text;
    if (typeof replyText === 'string' && (forSourceRead || typeof content.reply === 'object')) {
      parts.push({ text: replyText, messageId: null, role: 'assistant' });
    }
  }
  return parts.filter(part => typeof part.text === 'string' && part.text.trim()
    && !['tool', 'system', 'thinking'].includes(part.role)
    && (forSourceRead || !sensitive(part.text)));
}

function messageIdsOf(conversation) {
  const ids = new Set();
  for (const event of conversation?.events || []) {
    if (event.type !== 'message') continue;
    const turn = object(event.content?.turn) ? event.content.turn : null;
    const id = typeof turn?.id === 'string' && turn.id ? turn.id : event.eventId;
    if (typeof id === 'string') {
      ids.add(id);
      ids.add(`${id}-assistant`);
    }
    if (typeof event.eventId === 'string') ids.add(event.eventId);
  }
  return ids;
}

function redactConnectionString(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:/@\s]+):([^@\s/]*)@/g, '://$1:***@');
  }
}
function sanitizeMessage(error) {
  const message = String(error?.message || error || 'backup-failed');
  return message.replace(/:\/\/([^:/@\s]+):([^@\s/]*)@/g, '://$1:***@').slice(0, 300);
}
function normalizeError(error) {
  if (error instanceof MemoryError) return error;
  const code = typeof error?.code === 'string' && ERROR_CODES.has(error.code) ? error.code : 'storage-error';
  const wrapped = new MemoryError(code);
  Object.defineProperty(wrapped, 'cause', { value: error, enumerable: false });
  return wrapped;
}
function mergeSettings(data) {
  const settings = { ...DEFAULT_SETTINGS };
  if (object(data)) for (const key of Object.keys(DEFAULT_SETTINGS)) if (data[key] !== undefined) settings[key] = data[key];
  // Legacy rule extraction is intentionally retired. Existing rows migrate to
  // LLM extraction on read instead of silently continuing to use regexes.
  if (settings.extractorMode === 'rules') settings.extractorMode = 'llm';
  return settings;
}
function validateSettingsPatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (['autoExtract', 'memoryEnabled', 'includeGlobal', 'semanticSearch', 'autoStartServices'].includes(key)) {
      if (typeof value !== 'boolean') fail('invalid-settings');
      out[key] = value;
      continue;
    }
    if (key === 'historyRetention') {
      if (value !== 'forever') fail('invalid-settings');
      out[key] = value;
      continue;
    }
    if (key === 'extractorMode') {
      if (!['llm', 'off'].includes(value)) fail('invalid-settings');
      out[key] = value;
      continue;
    }
    if (key === 'backupSchedule') {
      if (value !== 'off' && !/^(?:daily|weekly) (?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value))) fail('invalid-settings');
      out[key] = value;
      continue;
    }
    if (key === 'quotaBytes') {
      if (!Number.isInteger(value) || value < 0 || value > 1099511627776) fail('invalid-settings');
      out[key] = value;
      continue;
    }
    if (key === 'maxMemories') { out[key] = bounded(value, DEFAULT_SETTINGS.maxMemories, 10000); continue; }
    if (key === 'contextMaxMemories') { out[key] = bounded(value, DEFAULT_SETTINGS.contextMaxMemories, 100); continue; }
    if (key === 'contextMaxChars') { out[key] = bounded(value, DEFAULT_SETTINGS.contextMaxChars, 20000); continue; }
    if (key === 'backupRetentionDays') { out[key] = bounded(value, DEFAULT_SETTINGS.backupRetentionDays, 3650); continue; }
    if (key === 'hybridWeight') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('invalid-input');
      out[key] = value;
      continue;
    }
    fail('invalid-settings');
  }
  return out;
}
function memoryFromRow(row) {
  return {
    id: row.id,
    text: row.text,
    key: row.key ?? null,
    kind: row.kind,
    projectId: row.projectName ?? null,
    status: row.status,
    pinned: row.pinned === true,
    source: row.source,
    version: row.version,
    supersedes: Array.isArray(row.supersedes) ? row.supersedes.map(String) : [],
    supersededBy: row.supersededBy ?? null,
    conversationId: row.conversationId ?? null,
    messageId: row.messageId ?? null,
    normalizedHash: row.normalizedHash ?? null,
    importance: row.importance === null || row.importance === undefined ? 0.5 : Number(row.importance),
    useCount: Number(row.useCount ?? 0),
    lastUsedAt: row.lastUsedAt ?? null,
    observedAt: row.observedAt ?? null,
    validFrom: row.validFrom ?? null,
    validTo: row.validTo ?? null,
    expiresAt: row.expiresAt ?? null,
    lastConfirmedAt: row.lastConfirmedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function ngrams(text) {
  const out = new Set();
  const normalized = String(text || '').toLocaleLowerCase();
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    if (out.size > 2000) break;
  }
  for (const word of normalized.match(/[a-z0-9_./-]{2,40}/g) || []) out.add(word);
  return [...out].slice(0, 2000);
}
function splitChunks(text, max = 1000) {
  const source = String(text || '').trim();
  if (!source) return [];
  if (source.length <= max) return [source];
  const out = [];
  let current = '';
  for (const piece of source.split(/(?<=[。！？!?；;\n])/)) {
    if (!piece) continue;
    if (current && current.length + piece.length > max) {
      out.push(current);
      current = '';
    }
    if (piece.length > max) {
      for (let index = 0; index < piece.length; index += max) {
        const slice = piece.slice(index, index + max);
        if (slice.length === max) out.push(slice);
        else current = slice;
      }
      continue;
    }
    current += piece;
  }
  if (current) out.push(current);
  return out.filter(chunk => chunk.trim()).slice(0, 20);
}

function toVectorArray(value, dim) {
  if (!value) return null;
  if (value.embedding) return toVectorArray(value.embedding, dim);
  if (ArrayBuffer.isView(value)) return toVectorArray(Array.from(value), dim);
  if (Array.isArray(value)) {
    if (Array.isArray(value[0])) return toVectorArray(value[0], dim);
    if (value.length !== dim) return null;
    const numbers = value.map(Number);
    return numbers.every(Number.isFinite) ? numbers : null;
  }
  if (value.data) {
    const data = ArrayBuffer.isView(value.data) ? Array.from(value.data) : Array.isArray(value.data) ? value.data : null;
    if (!data) return null;
    return toVectorArray(data.slice(0, dim), dim);
  }
  return null;
}
function compareHits(a, b) {
  return b.score - a.score || Number(b.pinned || false) - Number(a.pinned || false);
}
function hitKey(hit) {
  return `${hit.kind}:${hit.id}`;
}
// Authoritative scope check used on hits returned by an injected search engine:
// no cross-project leak is possible even if the engine is buggy.
function scopeAllows(scopeInfo, projectName) {
  const project = projectName ?? null;
  if (scopeInfo.allProjects === true) return true;
  if ((scopeInfo.projectId ?? null) === null) return project === null;
  return project === scopeInfo.projectId || (scopeInfo.includeGlobal === true && project === null);
}
function fuseHits(keywordHits, semanticHits, hybridWeight) {
  const weight = typeof hybridWeight === 'number' && Number.isFinite(hybridWeight) ? Math.min(1, Math.max(0, hybridWeight)) : 0.5;
  const merged = new Map();
  keywordHits.forEach((hit, index) => {
    merged.set(hitKey(hit), { hit, score: weight / (RRF_K + index + 1) });
  });
  semanticHits.forEach((hit, index) => {
    const key = hitKey(hit);
    const contribution = (1 - weight) / (RRF_K + index + 1);
    const existing = merged.get(key);
    if (existing) existing.score += contribution;
    else merged.set(key, { hit, score: contribution });
  });
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || Number(b.hit.pinned || false) - Number(a.hit.pinned || false))
    .map(entry => ({ ...entry.hit, score: Number(entry.score.toFixed(6)) }));
}

function createPostgresRepository(options = {}) {
  const connectionString = typeof options.connectionString === 'string' && options.connectionString.trim()
    ? options.connectionString.trim()
    : typeof process.env.MOVA_DB_URL === 'string' && process.env.MOVA_DB_URL.trim()
      ? process.env.MOVA_DB_URL.trim()
      : null;
  const ownerId = typeof options.ownerId === 'string' && options.ownerId.trim() ? options.ownerId.trim() : SINGLE_USER_ID;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const id = typeof options.id === 'function' ? options.id : randomUUID;
  const embeddingService = options.embeddingService || options.embedding || null;
  const searchEngine = options.searchEngine || options.indexer || null;
  const queue = options.queue || null;
  const backupManager = options.backupManager || options.backup || null;
  const extractor = options.extractor || null;
  const embeddingDim = Number.isInteger(options.embeddingDim)
    ? options.embeddingDim
    : Number.isInteger(embeddingService?.dim) ? embeddingService.dim : EMBEDDING_DIM;
  const embeddingModel = typeof options.embeddingModel === 'string' && options.embeddingModel
    ? options.embeddingModel
    : typeof embeddingService?.model === 'string' && embeddingService.model ? embeddingService.model : EMBEDDING_MODEL;
  const inlineIndex = options.inlineIndex !== false;

  let store = options.store || null;
  if (!store) {
    if (!options.pool && !connectionString) fail('invalid-config');
    store = createPgStore({
      connectionString,
      pool: options.pool || null,
      ownerId,
      max: options.max,
      poolOptions: options.poolOptions,
    });
  }
  // Never leak credentials: the renderer only sees a redacted target.
  const filePath = redactConnectionString(connectionString) || 'postgres://(injected-store)/mova';
  // Tests inject a fake store without query(); production gets a durable job
  // layer from the same pool. Jobs are optional so the pure fake-store tests
  // remain independent of PostgreSQL.
  const memoryJobs = options.memoryJobs || (typeof store.query === 'function'
    ? createMemoryJobs({ query: (sql, params) => store.query(sql, params), ownerId })
    : null);

  let readyPromise = null;
  // 「这个对话键在库里从来没有会话行」的缓存：归档键要不要保留，取决于它是不是
  // **刚刚被删掉**的会话（库里有行 → 删除；库里从来没有 → 只是还没落盘）。这个判断
  // 一旦成立就不会再变（我们自己的保存不会给它建行），所以记下来就能避免每次保存
  // 都为它扫一遍会话表。
  const absentConversationKeys = new Set();
  function ensureReady() {
    if (!readyPromise) {
      readyPromise = Promise.resolve().then(() => store.seed()).catch(error => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  // --- settings -------------------------------------------------------------
  async function currentSettings() {
    return mergeSettings(await store.settingsData());
  }

  async function settings(patch) {
    await ensureReady();
    if (patch === undefined) return currentSettings();
    if (!object(patch)) fail('invalid-settings');
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const key of Object.keys(patch)) if (!allowed.has(key)) fail('invalid-settings');
    const normalized = validateSettingsPatch(patch);
    return store.transaction(async tx => {
      const data = await tx.settingsData();
      const next = { ...data, ...normalized };
      await tx.saveSettingsData(next);
      return mergeSettings(next);
    });
  }

  // --- sessions -------------------------------------------------------------
  /**
   * 由「项目行 + overlay + 会话行 + 归档键」重建渲染层的 `projects`。
   *
   * 输出形状必须和渲染层**一致**：
   *   - `createdAt` / `updatedAt` 是**数字毫秒**（`archiveEntries()` 与 `chatStamp()`
   *     都做数值减法，ISO 字符串只会得到 `NaN`）；
   *   - `location` 保留，但不写死 `'local'`（见 `locationOf()`），否则归档页的
   *     「云端」筛选永远查不到东西。
   *
   * 另外两条重建规则来自审计：
   *   - `@chatArchived` 里有、会话行里没有的键 → 补一条 chat 行（`archived: true`），
   *     否则「归档了一条还没落盘的聊天」在归档页里整条消失；
   *   - overlay 里 `hidden: true` 的项目 → 不进侧栏（「移除项目」对还挂着记忆、
   *     mova_projects 行必须保留的项目生效），但它的会话行仍然算数据。
   */
  function buildProjects(projectRows, overlay, conversations, archivedKeys, activity) {
    const attributes = new Map();
    const cloudChats = new Map();
    for (const item of Array.isArray(overlay) ? overlay : []) {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) continue;
      attributes.set(item.name, item);
      for (const chat of Array.isArray(item.cloudChats) ? item.cloudChats : []) {
        if (typeof chat?.title !== 'string') continue;
        const route = persistedCloudRoute(chat);
        cloudChats.set(conversationKeyOf(item.name, chat), { ...route, location: route.cloudOrigin ? 'cloud' : 'local' });
      }
    }
    const archived = archivedKeys instanceof Set ? archivedKeys : new Set();
    const stamps = activity instanceof Map ? activity : new Map();
    const projects = [];
    const byName = new Map();
    const ensure = name => {
      if (byName.has(name)) return byName.get(name);
      const extra = attributes.get(name) || {};
      const project = {
        name,
        chats: [],
        sourceFolders: Array.isArray(extra.sourceFolders) ? extra.sourceFolders : [],
        memory: extra.memory === 'project' ? 'project' : 'default',
        device: extra.device === 'cloud' ? 'cloud' : 'local',
        ...(typeof extra.instructions === 'string' ? { instructions: extra.instructions } : {}),
        ...persistedCloudRoute(extra),
        ...(typeof extra.cloudLabel === 'string' ? { cloudLabel: extra.cloudLabel } : {}),
      };
      projects.push(project);
      byName.set(name, project);
      return project;
    };
    for (const row of projectRows) {
      // 从侧栏移除、但因为还挂着记忆而保留了 mova_projects 行：记忆页照旧，侧栏不再出现。
      if (attributes.get(row.name)?.hidden === true) continue;
      ensure(row.name);
    }
    const seen = new Set();
    for (const conversation of conversations) {
      // Sidebar grouping uses the renderer key (["CodeMova", project, title]),
      // which is independent of the *memory* scope stored in project_id.
      const name = sidebarProject(conversation.id) ?? conversation.projectName ?? null;
      if (!name) continue;
      const title = conversationTitle(conversation.id, conversation);
      const mode = conversationMode(conversation.id);
      const key = conversationKeyOf(name, { mode, title });
      seen.add(conversation.id);
      seen.add(key);
      const createdAt = numberStamp(conversation.createdAt, 0);
      const activityAt = lastEventMillis(conversation);
      ensure(name).chats.push({
        title,
        mode,
        location: locationOf(conversation, attributes.get(name)),
        ...cloudChats.get(key),
        // 会话主键优先（保存时写的就是它），再退化到按 [mode, project, title] 重建。
        archived: archived.has(conversation.id) || archived.has(key),
        createdAt,
        // 会话行上的 updated_at 是「保存时间」（每次快照都会刷新），只有内容时间才代表
        // 「最后一次活动」；没有事件才退回会话行自己的时间。
        updatedAt: activityAt ?? numberStamp(conversation.updatedAt, createdAt),
      });
    }
    // 归档标记还在、会话行却没有的聊天：只有对话键可用，`[mode, project, title]` 能
    // 反解出侧栏需要的三段，时间戳来自 `@chatActivity`。没有这一步，设置页的归档列表
    // 里这条聊天会整条消失（用户以为「归档后它没了」）。
    for (const key of archived) {
      if (seen.has(key)) continue;
      const parts = keyParts(key);
      if (!parts || parts.length < 3) continue;
      const name = typeof parts[1] === 'string' && parts[1].trim() ? parts[1].trim() : null;
      const title = typeof parts[2] === 'string' ? parts[2] : '';
      const mode = conversationMode(key);
      if (!name || !title) continue;
      const project = ensure(name);
      if (project.chats.some(chat => chat.title === title && chat.mode === mode)) continue;
      const stamp = stamps.get(key) || null;
      const createdAt = numberStamp(stamp?.createdAt, 0);
      project.chats.push({
        title,
        mode,
        location: locationOf(null, attributes.get(name)),
        ...cloudChats.get(key),
        archived: true,
        createdAt,
        updatedAt: numberStamp(stamp?.updatedAt, createdAt),
      });
      seen.add(key);
    }
    return projects;
  }

  /**
   * 会话级状态行：`[对话键, 对象]`，例如 `["['ChatMova','Mova','标题']", {...}]`。
   * 脏数据只丢这一行，不让一次读取整体失败。
   */
  function sessionRows(value, keys) {
    return (Array.isArray(value) ? value : []).filter(row =>
      Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && row[0] && object(row[1]) &&
      (!keys || keys.has(row[0])));
  }

  async function read() {
    await ensureReady();
    const [data, projectRows, conversationRows, memoryRows, bytes] = await Promise.all([
      store.settingsData(),
      store.projects(),
      store.conversations(),
      store.memories(),
      store.databaseBytes().catch(() => 0),
    ]);
    const conversations = conversationRows.filter(conversation => conversation.temporary !== true);
    return {
      version: 1,
      sessions: {
        version: 1,
        projects: buildProjects(projectRows, data?.[PROJECT_OVERLAY_KEY], conversations,
          archivedKeySet(data?.[CHAT_ARCHIVED_KEY]), activityMap(data?.[CHAT_ACTIVITY_KEY])),
        conversations: conversations.map(conversation => [conversation.id, rebuildTurns(conversation.events)]),
        // 会话级 UI 状态：缺了它们，重新载入后目标 / 计划与用量都会消失。
        aims: sessionRows(data?.[CHAT_AIMS_KEY]),
        usage: sessionRows(data?.[CHAT_USAGE_KEY]),
      },
      memories: memoryRows.map(memoryFromRow),
      settings: mergeSettings(data),
      events: [],
      tasks: [],
      checkpoints: [],
      storage: { filePath, bytes },
    };
  }

  async function loadSessions() {
    await ensureReady();
    const [data, projectRows, conversationRows] = await Promise.all([
      store.settingsData(),
      store.projects(),
      store.conversations(),
    ]);
    const conversations = conversationRows.filter(conversation => conversation.temporary !== true);
    return {
      version: 1,
      projects: buildProjects(projectRows, data?.[PROJECT_OVERLAY_KEY], conversations,
        archivedKeySet(data?.[CHAT_ARCHIVED_KEY]), activityMap(data?.[CHAT_ACTIVITY_KEY])),
      conversations: conversations.map(conversation => [conversation.id, rebuildTurns(conversation.events)]),
      aims: sessionRows(data?.[CHAT_AIMS_KEY]),
      usage: sessionRows(data?.[CHAT_USAGE_KEY]),
      permissionPresets: Array.isArray(data?.[PERMISSION_PRESETS_KEY]) ? data[PERMISSION_PRESETS_KEY] : [],
      modelSelections: sessionRows(data?.[MODEL_SELECTIONS_KEY]),
    };
  }

  async function saveSessions(snapshot) {
    if (!object(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.conversations)) fail('invalid-snapshot');
    if (JSON.stringify(snapshot).length > 30_000_000) fail('snapshot-limit');
    const safe = clone(snapshot);
    const projectNames = [];
    const overlay = [];
    for (const project of safe.projects) {
      if (!object(project) || typeof project.name !== 'string' || !project.name.trim()) fail('invalid-snapshot');
      const name = project.name.trim().slice(0, 200);
      projectNames.push(name);
      const attributes = { name };
      if (Array.isArray(project.sourceFolders)) attributes.sourceFolders = project.sourceFolders;
      if (typeof project.memory === 'string') attributes.memory = project.memory;
      if (typeof project.device === 'string') attributes.device = project.device;
      if (typeof project.instructions === 'string' && project.instructions) attributes.instructions = project.instructions.slice(0, 4000);
      const route = persistedCloudRoute(project);
      Object.assign(attributes, route);
      if (route.cloudOrigin && typeof project.cloudLabel === 'string') attributes.cloudLabel = project.cloudLabel.slice(0, 60);
      const cloudChats = (Array.isArray(project.chats) ? project.chats : []).filter(chat => chat?.title && (route.cloudOrigin || chat.cloudOrigin))
        .map(chat => ({ title: chat.title, mode: chat.mode, ...persistedCloudRoute(chat) }));
      if (cloudChats.length) attributes.cloudChats = cloudChats;
      overlay.push(attributes);
    }
    const permissionPresets = (Array.isArray(safe.permissionPresets) ? safe.permissionPresets : []).filter(row =>
      Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && ['default', 'auto', 'full'].includes(row[1]));
    const conversations = [];
    const accepted = [];
    for (const entry of safe.conversations) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0]) fail('invalid-snapshot');
      const [key, raw] = entry;
      if (!Array.isArray(raw) && !object(raw)) fail('invalid-snapshot');
      const filtered = Array.isArray(raw)
        ? raw.filter(message => message?.temporary !== true)
        : object(raw) && Array.isArray(raw.messages)
          ? { ...raw, messages: raw.messages.filter(message => message?.temporary !== true) }
          : raw;
      const meta = sessionMeta(key, filtered);
      if (meta.temporary) continue;
      const messages = Array.isArray(filtered) ? filtered : filtered.messages;
      if (!Array.isArray(messages)) fail('invalid-snapshot');
      for (const message of messages) if (!object(message)) fail('invalid-snapshot');
      conversations.push({ key, data: filtered, messages, meta });
      accepted.push([key, Array.isArray(filtered) ? messages : filtered]);
    }
    // 目标 / 计划与用量只保留仍然存在的会话，避免删掉会话后留下孤儿行。
    const sessionKeys = new Set(conversations.map(conversation => conversation.key));
    const aims = sessionRows(safe.aims, sessionKeys);
    const usage = sessionRows(safe.usage, sessionKeys);
    // 归档状态：**不能**按「有没有会话行」过滤。渲染层只把归档状态挂在 chat 行上，
    // 而 postgres 模式的 chat 行又是从会话行反推的——一条还没落盘的聊天（临时聊天、
    // 首次发送中断、会话行被一次残缺快照删掉）如果也一起过滤掉，用户看到的就是
    // 「归档后它整条没了」。真正的孤儿键只在**这条会话刚刚被删掉**时清理：
    // 库里原来有它的会话行、这次快照里没有 → 这就是删除，键必须一起删。
    const archivedKeys = [...archivedConversationKeys(safe.projects)];
    await ensureReady();
    const syncJobs = [];
    await store.transaction(async tx => {
      const projectIds = new Map();
      const resolve = async name => {
        if (projectIds.has(name)) return projectIds.get(name);
        const projectId = await tx.ensureProject(name, 'scoped');
        projectIds.set(name, projectId);
        return projectId;
      };
      for (const name of projectNames) await resolve(name);
      // 还没落盘的归档键：只有候选存在时才查一次库，并把「确认从来没有会话行」记下来，
      // 之后每次保存都不用再扫一遍会话表。
      for (const key of [...absentConversationKeys]) if (sessionKeys.has(key)) absentConversationKeys.delete(key);
      const candidates = archivedKeys.filter(key => !sessionKeys.has(key) && !absentConversationKeys.has(key));
      if (candidates.length) {
        const wanted = new Set(candidates);
        const existing = new Set();
        for (const row of await tx.conversations()) if (row && typeof row.id === 'string' && wanted.has(row.id)) existing.add(row.id);
        for (const key of candidates) if (!existing.has(key)) absentConversationKeys.add(key);
      }
      const archived = archivedKeys.filter(key => sessionKeys.has(key) || absentConversationKeys.has(key));
      const keep = [];
      for (const conversation of conversations) {
        const projectUuid = conversation.meta.projectId === null ? null : await resolve(conversation.meta.projectId);
        const createdAt = isoTimestamp(conversation.data?.createdAt, now());
        const updatedAt = isoTimestamp(conversation.data?.updatedAt, createdAt);
        await tx.upsertConversation({
          id: conversation.key,
          projectId: projectUuid,
          title: conversationTitle(conversation.key, conversation.data),
          temporary: false,
          createdAt,
          updatedAt,
        });
        const events = [];
        let parent = null;
        conversation.messages.forEach((message, index) => {
          const eventId = stableEventId(conversation.key, message, index);
          events.push({
            eventId,
            parentEventId: parent,
            type: 'message',
            role: typeof message.role === 'string' ? message.role : 'user',
            content: eventContent(message),
            modelId: typeof message.reply?.modelId === 'string' ? message.reply.modelId.slice(0, 200) : null,
            providerId: typeof message.reply?.providerId === 'string' ? message.reply.providerId.slice(0, 200) : null,
            createdAt: isoTimestamp(message.createdAt ?? message.at, createdAt),
          });
          parent = eventId;
        });
        await tx.replaceMessageEvents(conversation.key, events);
        keep.push(conversation.key);
        syncJobs.push({ conversationId: conversation.key, eventIds: events.map(event => event.eventId) });
      }
      await tx.deleteConversationsExcept(keep);
      await tx.deleteUnusedProjects(projectNames);
      const data = await tx.settingsData();
      const known = new Set(keep);
      const previousOverlay = Array.isArray(data?.[PROJECT_OVERLAY_KEY]) ? data[PROJECT_OVERLAY_KEY] : [];
      const previousByName = new Map();
      for (const item of previousOverlay) if (item && typeof item.name === 'string') previousByName.set(item.name, item);
      // 「移除项目」必须真的从侧栏消失。mova_projects 里还挂着记忆的项目行是**故意**
      // 保留的（删项目会级联删掉记忆），所以这里给存活下来、但已经不在快照里的项目
      // 打一个 overlay 标记：`buildProjects()` 不再把它放回侧栏，记忆页照旧。
      const surviving = typeof tx.projects === 'function' ? await tx.projects() : [];
      const strayOverlay = [];
      for (const row of surviving) {
        if (!row || typeof row.name !== 'string' || projectNames.includes(row.name)) continue;
        strayOverlay.push({ ...(previousByName.get(row.name) || {}), name: row.name, hidden: true });
      }
      // 归档但没有会话行的聊天需要一份时间戳：否则归档页只能显示 1970 年。
      const previousActivity = activityMap(data?.[CHAT_ACTIVITY_KEY]);
      const stamp = numberStamp(now(), Date.now());
      await tx.saveSettingsData({
        ...data,
        [PROJECT_OVERLAY_KEY]: [...overlay, ...strayOverlay],
        [PERMISSION_PRESETS_KEY]: permissionPresets.filter(([key]) => known.has(key)),
        [MODEL_SELECTIONS_KEY]: sessionRows(safe.modelSelections).filter(([key, value]) => known.has(key) && object(value) &&
          ((typeof value.providerId === 'string' && typeof value.modelId === 'string') || typeof value.key === 'string')),
        [CHAT_AIMS_KEY]: aims.filter(([key]) => known.has(key)),
        [CHAT_USAGE_KEY]: usage.filter(([key]) => known.has(key)),
        [CHAT_ARCHIVED_KEY]: archived.map(key => [key, true]),
        // 只给「归档标记还在、会话行没有」的聊天留时间戳；会话行出现后自动清掉。
        [CHAT_ACTIVITY_KEY]: archived.filter(key => !known.has(key)).map(key => {
          const prior = previousActivity.get(key) || null;
          return [key, {
            createdAt: numberStamp(prior?.createdAt, stamp),
            updatedAt: numberStamp(prior?.updatedAt, stamp),
          }];
        }),
      });
    });
    // Session sync / chunk indexing is delegated to the worker when a queue is
    // configured; jobId is derived from the stable event ids (contract §8).
    if (queue && typeof queue.add === 'function') {
      for (const job of syncJobs) {
        await enqueue(queue, 'mova-session-sync', { ...job, ownerId }, `sync:${job.conversationId}:${hash(job.eventIds)}`).catch(() => {});
      }
    }
    return { version: 1, projects: safe.projects, conversations: accepted };
  }

  // --- memories -------------------------------------------------------------
  async function addMemory(tx, input) {
    if (!object(input)) fail('invalid-input');
    const text = string(input.text, 4000);
    if (sensitive(text)) fail('sensitive-content');
    const projectId = scope(input.projectId);
    const key = input.key === undefined || input.key === null || input.key === ''
      ? null
      : string(input.key, 200);
    if (key && sensitive(key)) fail('sensitive-content');
    const status = input.status === undefined ? 'active' : input.status;
    if (!['active', 'disabled'].includes(status)) fail('invalid-input');
    const kind = input.kind === undefined ? 'fact' : input.kind;
    if (!['fact', 'preference', 'decision', 'note'].includes(kind)) fail('invalid-input');
    if (input.eventId !== undefined) string(input.eventId, 300);
    const conversationId = input.conversationId ? string(input.conversationId, 1000) : null;
    const messageId = input.messageId ? string(input.messageId, 500) : null;

    const settingsValue = await currentSettings();
    const existingRows = await tx.memories();
    const sameScope = row => (row.projectName ?? null) === projectId;
    const normalizedHash = memoryHash(text);
    const duplicate = existingRows.find(row => row.status === 'active'
      && (row.text === text || (normalizedHash && row.normalizedHash === normalizedHash))
      && (row.key ?? null) === key && sameScope(row));
    if (duplicate) return memoryFromRow(duplicate);
    if (existingRows.length >= settingsValue.maxMemories) fail('memory-limit');
    const previous = key && status === 'active'
      ? existingRows.filter(row => sameScope(row) && row.status === 'active' && row.key === key)
      : [];
    const projectUuid = projectId === null ? null : await tx.ensureProject(projectId, 'scoped');
    const memoryId = id();
    const createdAt = now();
    const version = previous.length ? Math.max(...previous.map(row => row.version)) + 1 : 1;
    const row = {
      id: memoryId,
      projectId: projectUuid,
      kind,
      text,
      key,
      status,
      pinned: input.pinned === true,
      source: input.source === 'automatic' ? 'automatic' : 'user',
      version,
      supersedes: previous.map(entry => entry.id),
      supersededBy: null,
      embeddingModel: null,
      embeddingVersion: null,
      normalizedHash,
      importance: input.pinned === true ? 1 : (Number.isFinite(input.confidence)
        ? Math.max(0.3, Math.min(1, input.confidence))
        : (input.source === 'user' ? 0.9 : 0.5)),
      useCount: 0,
      lastUsedAt: null,
      observedAt: createdAt,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      expiresAt: input.expiresAt ?? null,
      lastConfirmedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    };
    if (previous.length) await tx.supersedeMemories(previous.map(entry => entry.id), memoryId, createdAt);
    await tx.insertMemory(row, conversationId && messageId
      ? { conversationId, messageId, confidence: typeof input.confidence === 'number' ? input.confidence : null }
      : null);
    return memoryFromRow({ ...row, projectName: projectId, conversationId, messageId });
  }

  async function saveMemory(input) {
    await ensureReady();
    const memory = await store.transaction(tx => addMemory(tx, input));
    await bestEffortIndex(memory);
    return memory;
  }

  async function updateMemory(memoryId, patch) {
    await ensureReady();
    if (!object(patch)) fail('invalid-input');
    if (Object.keys(patch).some(key => !['text', 'status', 'pinned'].includes(key))) fail('invalid-input');
    const target = typeof memoryId === 'string' ? memoryId.trim() : '';
    if (!UUID_PATTERN.test(target)) fail('not-found');
    const updated = await store.transaction(async tx => {
      const rows = await tx.memories();
      const current = rows.find(row => row.id === target);
      if (!current) fail('not-found');
      const next = { ...current };
      if (patch.text !== undefined) {
        // 已退役（superseded）的条目只保留历史，不允许再改正文：改完也检索不到，静默成功只会骗模型。
        if (current.status === 'superseded') fail('invalid-status');
        const text = string(patch.text, 4000);
        if (sensitive(text)) fail('sensitive-content');
        next.text = text;
        next.normalizedHash = memoryHash(text);
      }
      if (patch.status !== undefined) {
        if (!['active', 'disabled'].includes(patch.status) || current.status === 'superseded') fail('invalid-status');
        if (patch.status === 'active' && current.key && rows.some(other => other.id !== current.id
          && (other.projectName ?? null) === (current.projectName ?? null)
          && other.key === current.key && other.status === 'active')) fail('key-conflict');
        next.status = patch.status;
      }
      if (patch.pinned !== undefined) {
        if (typeof patch.pinned !== 'boolean') fail('invalid-input');
        next.pinned = patch.pinned;
      }
      next.updatedAt = now();
      await tx.updateMemory(current.id, {
        text: next.text, status: next.status, pinned: next.pinned,
        normalizedHash: next.normalizedHash, updatedAt: next.updatedAt,
      });
      return memoryFromRow(next);
    });
    if (patch.text !== undefined) {
      await store.deleteMemoryChunks(updated.id).catch(() => {});
      await bestEffortIndex(updated);
    }
    return updated;
  }

  async function deleteMemory(memoryId) {
    await ensureReady();
    const target = typeof memoryId === 'string' ? memoryId.trim() : '';
    if (!UUID_PATTERN.test(target)) return false;
    // The SQL store also removes matching mova_search_chunks rows (delete propagation).
    return store.transaction(tx => tx.deleteMemory(target));
  }

  /**
   * 用一条新记忆替代旧记忆：旧条目标 `superseded` + `superseded_by`，新条目留在活跃集。
   *
   * 落盘全部走既有 SQL：新条目 = `addMemory`（配额/敏感词/去重/事件规则一致），
   * 旧条目 = `store.supersedeMemories`（memory_status 的 CHECK 本来就允许 superseded，
   * 因此**不需要任何迁移**）。`status: 'disabled'`（归档）同样复用既有 status 位。
   *
   * @param {{ id: string, text: string, kind?: string, source?: string }} input
   * @returns {Promise<object>} 替代后的**新**记忆（`supersedes` 里带旧 id）
   */
  async function supersedeMemory(input = {}) {
    await ensureReady();
    if (!object(input)) fail('invalid-input');
    const target = typeof input.id === 'string' ? input.id.trim() : '';
    if (!UUID_PATTERN.test(target)) fail('not-found');
    const text = string(input.text, 4000);
    if (sensitive(text)) fail('sensitive-content');
    const kind = input.kind === undefined ? null : input.kind;
    if (kind !== null && !['fact', 'preference', 'decision', 'note'].includes(kind)) fail('invalid-input');
    const replacement = await store.transaction(async tx => {
      const rows = await tx.memories();
      const current = rows.find(row => row.id === target);
      if (!current) fail('not-found');
      if (current.status === 'superseded') fail('invalid-status');
      // 内容没变化就没有「替代」可言：直接改正文用 updateMemory，别造一条同义条目。
      if (current.normalizedHash && current.normalizedHash === memoryHash(text)) fail('invalid-input');
      const created = await addMemory(tx, {
        text,
        kind: kind ?? current.kind,
        projectId: current.projectName ?? null,
        key: current.key ?? null,
        source: input.source === 'automatic' ? 'automatic' : 'user',
      });
      if (created.id === target) fail('invalid-input');
      // addMemory 只在 key 命中时自动退役同 key 的活跃条目；没有 key 的情况在这里补上（幂等）。
      if (created.supersedes.length === 0 || !created.supersedes.includes(target)) {
        await tx.supersedeMemories([target], created.id, now());
      }
      return { ...created, supersedes: [...new Set([...created.supersedes, target])] };
    });
    await bestEffortIndex(replacement);
    return replacement;
  }

  // --- retrieval ------------------------------------------------------------
  async function embed(kind, text) {
    if (!embeddingService) fail('embedding-unavailable');
    const input = `${kind === 'query' ? 'query' : 'passage'}: ${text}`;
    let raw;
    if (typeof embeddingService.embed === 'function') {
      try {
        raw = await embeddingService.embed([input], { type: kind });
      } catch (error) {
        if (/type|option|argument/i.test(String(error?.message || ''))) raw = await embeddingService.embed([input]);
        else throw error;
      }
    } else if (kind === 'query' && typeof embeddingService.embedQuery === 'function') {
      raw = await embeddingService.embedQuery(input);
    } else if (kind === 'passage' && typeof embeddingService.embedPassage === 'function') {
      raw = await embeddingService.embedPassage(input);
    } else if (typeof embeddingService.encode === 'function') {
      raw = await embeddingService.encode(input);
    } else {
      fail('embedding-unavailable');
    }
    const vector = toVectorArray(raw, embeddingDim);
    if (!vector) fail('embedding-dimension-mismatch');
    return vector;
  }

  // Best-effort chunk indexing. With a queue the chunk is handed to the worker
  // (idempotent jobId = chunkId + embeddingVersion, contract §8); without one it
  // is embedded inline. A failed embedding never writes a fake vector and never
  // fails the memory/session write.
  async function indexRows(rows) {
    if (!rows.length) return { indexed: 0, queued: 0 };
    if (!embeddingService) fail('embedding-unavailable');
    if (queue && typeof queue.add === 'function') {
      for (const row of rows) {
        await enqueue(queue, 'mova-memory-index', {
          chunkId: row.id,
          sourceKind: row.sourceKind,
          sourceId: row.sourceId,
          conversationId: row.conversationId ?? null,
          embeddingVersion: 1,
          ownerId,
        }, `${row.id}:1`).catch(() => {});
      }
      return { indexed: 0, queued: rows.length };
    }
    let indexed = 0;
    for (const row of rows) {
      try {
        const embedding = await embed('passage', row.content);
        await store.insertChunks([{ ...row, embedding }]);
        indexed += 1;
      } catch {
        // Embedding or index write failed; the caller can retry via indexPending().
      }
    }
    return { indexed, queued: 0 };
  }

  // Automatic post-write indexing respects `options.inlineIndex` (set false by
  // the integration tests and by deployments that only index in the worker).
  async function bestEffortIndex(memory) {
    if (!embeddingService) return;
    if (inlineIndex === false && !queue) return;
    await indexMemoryChunks(memory).catch(() => {});
  }

  async function indexMemoryChunks(memory) {
    if (!embeddingService) return { indexed: 0, queued: 0 };
    const projectUuid = memory.projectId === null || memory.projectId === undefined
      ? null
      : await store.ensureProject(memory.projectId, 'scoped');
    const rows = splitChunks(memory.text).map((content, index) => ({
      id: uuidFromHash(`memory:${memory.id}:${index}:1`),
      projectId: projectUuid,
      conversationId: memory.conversationId,
      messageId: memory.messageId,
      sourceKind: 'memory',
      sourceId: memory.id,
      content,
      contentNgrams: ngrams(content),
      embeddingModel,
      embeddingVersion: 1,
      createdAt: now(),
    }));
    return indexRows(rows);
  }

  // Message chunks: 800-1200 characters, keep conversation/message references,
  // never index thinking, tool payloads, mock/demo or sensitive content
  // (contract §6).
  async function conversationChunkRows(conversation) {
    if (!conversation || conversation.temporary === true) return [];
    const projectUuid = conversation.projectName
      ? await store.ensureProject(conversation.projectName, 'scoped')
      : null;
    const rows = [];
    for (const event of conversation.events || []) {
      if (event.type !== 'message') continue;
      for (const part of messageParts(event)) {
        const sourceId = `${conversation.id}:${part.messageId}`;
        splitChunks(part.text).forEach((content, index) => {
          rows.push({
            id: uuidFromHash(`message:${sourceId}:${index}:1`),
            projectId: projectUuid,
            conversationId: conversation.id,
            messageId: part.messageId,
            sourceKind: 'message',
            sourceId,
            content,
            contentNgrams: ngrams(content),
            embeddingModel,
            embeddingVersion: 1,
            createdAt: now(),
          });
        });
      }
    }
    return rows;
  }

  async function semanticHits({ text, projectId, includeGlobal, allProjects, settingsValue, limit, includeSessions, includeMemories }) {
    if (!text || settingsValue.semanticSearch !== true || !embeddingService) return [];
    let embedding;
    try {
      embedding = await embed('query', text);
    } catch {
      // Embedding down: degrade to keyword search (§7). Never fake a vector.
      return [];
    }
    let rows;
    try {
      rows = await store.vectorSearch({
        projectName: projectId,
        includeGlobal,
        allProjects,
        sourceKind: includeSessions === false ? 'memory' : includeMemories === false ? 'message' : undefined,
        embedding,
        limit: Math.max(limit * 2, 50),
      });
    } catch {
      return [];
    }
    if (!rows.length) return [];
    let memoryIndex = null;
    const hits = [];
    for (const row of rows) {
      if (row.sourceKind === 'memory') {
        if (includeMemories === false) continue;
        if (!memoryIndex) {
          memoryIndex = new Map();
          for (const memory of await store.memories()) memoryIndex.set(memory.id, memoryFromRow(memory));
        }
        const memory = memoryIndex.get(row.sourceId);
        if (!memory || memory.status !== 'active') continue;
        hits.push({ ...memory, kind: 'memory', memoryKind: memory.kind, score: Number(row.score) || 0 });
      } else {
        if (includeSessions === false) continue;
        if (typeof row.content !== 'string' || !row.content.trim() || sensitive(row.content)) continue;
        const role = typeof row.messageId === 'string' && row.messageId.endsWith('-assistant') ? 'assistant' : 'user';
        hits.push({
          kind: 'session',
          id: `${row.conversationId}:${row.messageId}`,
          text: row.content,
          conversationId: row.conversationId,
          messageId: row.messageId,
          role,
          projectId: row.projectName ?? null,
          score: Number(row.score) || 0,
        });
      }
    }
    return hits;
  }

  // Normalizes hybrid-engine hits into the renderer hit shapes used by query().
  // The engine only supplies ranking; scope, status, temporary and sensitive
  // filtering are re-checked against PostgreSQL.
  async function normalizeEngineHits(rows, scopeInfo) {
    if (!rows.length) return [];
    const memories = new Map();
    let conversations = null;
    const hits = [];
    for (const row of rows) {
      if (!object(row)) continue;
      const kind = row.kind === 'memory'
        ? 'memory'
        : row.kind === 'session' || row.sourceKind === 'message' || typeof row.conversationId === 'string'
          ? 'session'
          : null;
      const rawScore = Number(row.score ?? row.rrf ?? row.rank);
      const score = Number.isFinite(rawScore) ? rawScore : 0;
      if (kind === 'memory') {
        if (scopeInfo.includeMemories === false) continue;
        const memoryId = typeof row.id === 'string' ? row.id
          : typeof row.sourceId === 'string' ? row.sourceId
            : typeof row.memoryId === 'string' ? row.memoryId : '';
        if (!memoryId) continue;
        if (!memories.size) for (const memory of await store.memories()) memories.set(memory.id, memoryFromRow(memory));
        const memory = memories.get(memoryId);
        if (!memory || memory.status !== 'active') continue;
        if (!scopeAllows(scopeInfo, memory.projectId)) continue;
        hits.push({ ...memory, kind: 'memory', memoryKind: memory.kind, score });
        continue;
      }
      if (kind === 'session') {
        if (scopeInfo.includeSessions === false) continue;
        const conversationId = typeof row.conversationId === 'string' ? row.conversationId : '';
        const messageId = typeof row.messageId === 'string' ? row.messageId : '';
        if (!conversationId || !messageId) continue;
        if (!conversations) {
          conversations = new Map();
          for (const conversation of await store.conversations()) {
            if (conversation.temporary === true) continue;
            conversations.set(conversation.id, conversation);
          }
        }
        const conversation = conversations.get(conversationId);
        if (!conversation) continue;
        // Scope comes from the database row, never from the engine payload.
        if (!scopeAllows({ ...scopeInfo, includeSessions: true }, conversation.projectName)) continue;
        // Provenance must exist in the stored events; a hallucinated message id
        // is dropped so a hit always points at a real turn.
        if (!messageIdsOf(conversation).has(messageId)) continue;
        const text = typeof row.text === 'string' ? row.text
          : typeof row.content === 'string' ? row.content
            : typeof row.snippet === 'string' ? row.snippet : '';
        if (!text.trim() || sensitive(text)) continue;
        const role = row.role === 'assistant' || messageId.endsWith('-assistant') ? 'assistant' : 'user';
        hits.push({
          kind: 'session',
          id: `${conversationId}:${messageId}`,
          text,
          conversationId,
          messageId,
          role,
          projectId: conversation.projectName ?? null,
          score,
        });
      }
    }
    return hits;
  }

  // Calls the injected hybrid engine (keyword + pgvector RRF). Returns null when
  // the engine is absent, semantic search is off, or the engine fails, so the
  // caller always has a keyword-only fallback.
  async function engineHits({ text, projectId, includeGlobal, allProjects, limit, includeSessions, includeMemories }) {
    if (!searchEngine || typeof searchEngine.searchWithMeta !== 'function') return null;
    try {
      const result = await searchEngine.searchWithMeta({
        query: text,
        projectId,
        includeGlobal,
        allProjects,
        limit,
        includeSessions,
        includeMemories,
        ownerId,
        embeddingModel,
        embeddingDim,
      });
      const rows = Array.isArray(result) ? result : Array.isArray(result?.hits) ? result.hits : [];
      return await normalizeEngineHits(rows, { projectId, includeGlobal, allProjects, includeSessions, includeMemories });
    } catch {
      return null;
    }
  }

  // Relevance-only map for context(): reorders memories that already passed the
  // exact scope/status filters in SQL, and never adds memories of its own.
  async function contextRelevance(text, projectId, includeGlobal) {
    if (!text || !searchEngine || typeof searchEngine.searchWithMeta !== 'function') return null;
    try {
      const result = await searchEngine.searchWithMeta({
        query: text,
        projectId,
        includeGlobal,
        allProjects: false,
        limit: 100,
        includeSessions: false,
        ownerId,
        embeddingModel,
        embeddingDim,
      });
      const rows = Array.isArray(result) ? result : Array.isArray(result?.hits) ? result.hits : [];
      const rank = new Map();
      rows.forEach((row, index) => {
        const id = typeof row?.id === 'string' ? row.id
          : typeof row?.sourceId === 'string' ? row.sourceId
            : typeof row?.memoryId === 'string' ? row.memoryId : '';
        if (id) rank.set(id, rows.length - index);
      });
      return rank;
    } catch {
      return null;
    }
  }

  // Public indexing hooks (not part of MemoryRepository §4, but the parent needs
  // them for the worker / after session sync):
  //   indexMemory(id | memory)          -> { indexed, queued }
  //   indexSession(conversationId)      -> { indexed, queued } (replaces chunks)
  //   indexPending({ limit, sessions }) -> { indexed, queued } (fills gaps)
  async function indexMemory(target) {
    await ensureReady();
    if (typeof target === 'string') {
      const rows = await store.memories();
      const row = rows.find(memory => memory.id === target.trim());
      if (!row) fail('not-found');
      return indexMemoryChunks(memoryFromRow(row));
    }
    if (!object(target)) fail('invalid-input');
    const text = string(target.text, 4000);
    if (!UUID_PATTERN.test(String(target.id ?? ''))) fail('invalid-input');
    return indexMemoryChunks({ ...target, text });
  }

  async function indexSession(conversationId) {
    await ensureReady();
    const target = string(conversationId, 500);
    const conversations = await store.conversations();
    const conversation = conversations.find(item => item.id === target);
    if (!conversation) fail('not-found');
    if (!embeddingService) fail('embedding-unavailable');
    const rows = await conversationChunkRows(conversation);
    await store.deleteMessageChunks(conversation.id);
    return indexRows(rows);
  }

  async function indexPending(input = {}) {
    await ensureReady();
    if (!embeddingService) fail('embedding-unavailable');
    const limit = bounded(input.limit, 200, 5000);
    const existing = new Set((await store.chunkSources()).map(row => `${row.sourceKind}:${row.sourceId}`));
    let indexed = 0;
    let queued = 0;
    let scanned = 0;
    for (const row of await store.memories()) {
      if (scanned >= limit) break;
      if (existing.has(`memory:${row.id}`)) continue;
      scanned += 1;
      const result = await indexMemoryChunks(memoryFromRow(row));
      indexed += result.indexed;
      queued += result.queued;
    }
    if (input.sessions !== false) {
      for (const conversation of await store.conversations()) {
        if (scanned >= limit) break;
        const rows = await conversationChunkRows(conversation);
        const pending = rows.filter(row => !existing.has(`message:${row.sourceId}`));
        if (!pending.length) continue;
        scanned += pending.length;
        const result = await indexRows(pending);
        indexed += result.indexed;
        queued += result.queued;
      }
    }
    return { indexed, queued };
  }

  async function query(input = {}) {
    if (input !== null && input !== undefined && !object(input)) fail('invalid-input');
    const values = input || {};
    await ensureReady();
    const settingsValue = await currentSettings();
    const projectId = scope(values.projectId);
    const includeGlobal = values.includeGlobal === undefined ? settingsValue.includeGlobal : values.includeGlobal;
    const limit = bounded(values.limit, 30, 100);
    const text = typeof values.query === 'string' ? values.query.trim().slice(0, 1000) : '';
    const allProjects = values.allProjects === true;
    const tokenList = text ? tokens(text) : [];
    const includeSessions = values.includeSessions !== false;
    const includeMemories = values.includeMemories !== false;
    const scopeInput = {
      projectName: projectId,
      includeGlobal: includeGlobal === true,
      allProjects,
      tokens: tokenList,
      limit: Math.max(limit * 8, 240),
    };
    const [memoryRowsLive, messageRows] = await Promise.all([
      includeMemories ? store.searchMemories(scopeInput) : Promise.resolve([]),
      includeSessions ? store.searchMessages(scopeInput) : Promise.resolve([]),
    ]);
    const hits = [];
    // 归档条目（status 'disabled'，见 archive 的落盘口径）默认不可见：searchMemories 的 SQL 只取 active。
    // 只有显式 `includeArchived === true` 时才把它们补进候选，并带 `archived: true` 标记，
    // 让上层（filterHits / 模型）能区分「这是归档的历史」而不是一条活跃记忆。
    const includeArchived = values.includeArchived === true;
    const memoryRows = includeArchived
      ? [...memoryRowsLive, ...(await store.memories())
        .filter(row => row.status === 'disabled'
          && scopeAllows({ projectId, includeGlobal: includeGlobal === true, allProjects }, row.projectName))]
      : memoryRowsLive;
    for (const row of memoryRows) {
      const memory = memoryFromRow(row);
      const rank = text ? score(memory.text, text) : 1;
      if (rank) {
        hits.push({
          ...memory, kind: 'memory', memoryKind: memory.kind, score: rank,
          ...(memory.status === 'disabled' ? { archived: true } : {}),
        });
      }
    }
    if (includeSessions) {
      for (const row of messageRows) {
        for (const part of messageParts(row)) {
          const messageId = part.messageId ?? (part.role === 'assistant' ? `${row.eventId}-assistant` : row.eventId);
          const rank = text ? score(part.text, text) : 1;
          if (!rank) continue;
          hits.push({
            kind: 'session',
            id: `${row.conversationId}:${messageId}`,
            text: part.text,
            conversationId: row.conversationId,
            messageId,
            role: part.role,
            projectId: row.projectName ?? null,
            score: rank,
          });
        }
      }
    }
    let ranked = hits.sort(compareHits);
    if (settingsValue.semanticSearch === true) {
      // Preference order: injected hybrid engine (keyword + pgvector, §7) →
      // repository-local vector channel → keyword only. Any failure degrades to
      // keyword results and is reflected by health().embedding, never faked.
      const engine = await engineHits({
        text,
        projectId,
        includeGlobal: includeGlobal === true,
        allProjects,
        limit,
        includeSessions,
        includeMemories,
      });
      const semantic = engine !== null ? engine : await semanticHits({
        text,
        projectId,
        includeGlobal: includeGlobal === true,
        allProjects,
        settingsValue,
        limit,
        includeSessions,
        includeMemories,
      });
      if (semantic.length) ranked = fuseHits(ranked, semantic, settingsValue.hybridWeight);
    }
    return ranked.slice(0, limit);
  }

  async function context(input = {}) {
    const values = object(input) ? input : {};
    await ensureReady();
    const settingsValue = await currentSettings();
    const projectId = scope(values.projectId);
    const includeGlobal = values.includeGlobal === undefined ? settingsValue.includeGlobal : values.includeGlobal;
    const limit = Math.min(bounded(values.limit, settingsValue.contextMaxMemories, 100), settingsValue.contextMaxMemories);
    const budget = Math.min(bounded(values.maxChars, settingsValue.contextMaxChars, 20000), settingsValue.contextMaxChars);
    if (!settingsValue.memoryEnabled || values.temporary === true) {
      return { memories: [], text: '', enabled: false, usedIds: [] };
    }
    // `enabled` lets the model distinguish "memory exists but has no matching
    // saved facts" from "memory is unavailable", without inventing memories.
    const enabled = true;
    const queryText = typeof values.query === 'string' ? values.query : '';
    // allProjects is never used here: agent context is exact scope + optional global.
    // Do not pre-filter by query tokens: "what did I ask you to remember?" often
    // shares no words with the saved fact. Ranking below still prefers relevant
    // and pinned memories, while the scope filter keeps other projects out.
    const rows = (await store.searchMemories({
      projectName: projectId,
      includeGlobal: includeGlobal === true,
      allProjects: false,
      tokens: [],
      // Do not cap the candidate pool at the newest 500: older pinned/important
      // memories must still be reachable. maxMemories is the authoritative cap.
      limit: Math.max(500, Math.min(settingsValue.maxMemories, 5000)),
    }))
      // 自动注入只认 active：归档（disabled）与已退役（superseded）**双重**挡在门外，
      // 不依赖 searchMemories 的 SQL 过滤（上下文是最容易「漏进一条过时记忆」的路径）。
      .filter(row => row.status === 'active');
    // Optional semantic relevance from the hybrid engine. It is a signal for
    // ranking, not a hard filter, so a generic "what did I ask you to remember?"
    // can still reach an older fact.
    const relevance = settingsValue.semanticSearch === true
      ? await contextRelevance(queryText, projectId, includeGlobal === true)
      : null;
    const semanticMax = relevance ? Math.max(1, ...relevance.values()) : 1;
    let candidates = rankCandidates(mergeCandidates({
      recent: rows.map(row => {
        const memory = memoryFromRow(row);
        return {
          ...memory,
          semanticScore: relevance ? (relevance.get(memory.id) ?? 0) / semanticMax : 0,
        };
      }),
    }), { query: queryText });

    // A recent or important memory is not necessarily relevant to a specific
    // question. Broad recall requests deliberately retain the wider pool.
    candidates = selectRelevantCandidates(candidates, queryText);

    // A failed reranker retains the locally relevant candidates and is reported
    // as degraded. A successful selection is never padded with unselected items.
    let reranked = false;
    let rerankError = null;
    if (queryText && extractor && typeof extractor.rerank === 'function' && candidates.length > limit) {
      try {
        const result = await extractor.rerank(
          queryText,
          candidates.slice(0, 60).map(memory => ({ id: memory.id, text: memory.text })),
          limit,
        );
        const selected = selectRerankedCandidates(candidates.slice(0, 60), result?.ids);
        if (selected.length) {
          candidates = selected;
          reranked = true;
        } else {
          rerankError = 'llm-invalid-output';
        }
      } catch (error) {
        rerankError = typeof error?.code === 'string' ? error.code : 'llm-rerank-failed';
      }
    }

    const memories = [];
    let text = '';
    for (const memory of candidates) {
      if (memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now()) continue;
      const line = `${JSON.stringify({
        id: memory.id, text: memory.text, source: memory.source,
        conversationId: memory.conversationId, messageId: memory.messageId,
        observedAt: memory.observedAt ?? null, validTo: memory.validTo ?? null,
        expiresAt: memory.expiresAt ?? null,
      })}\n`;
      if (memories.length < limit && text.length + line.length <= budget) {
        memories.push(memory);
        text += line;
      }
    }
    const usedIds = memories.map(memory => memory.id);
    if (usedIds.length && typeof store.query === 'function') {
      // Best-effort usage signal for importance/decay ranking. A read must not
      // fail because this telemetry write failed.
      await store.query(
        `update mova_memories
            set use_count = use_count + 1, last_used_at = now()
          where owner_id = $1 and id = any($2::uuid[])`,
        [ownerId, usedIds],
      ).catch(() => {});
    }
    return {
      memories, text, enabled, reranked,
      usedIds,
      estimatedTokens: estimateTokens(memories.map(memory => memory.text).join('\n')),
      ...(rerankError ? { rerankError } : {}),
    };
  }

  async function readMemorySource({ id, conversationId, messageId, projectId, includeGlobal }) {
    await ensureReady();
    const settings = await currentSettings();
    if (!settings.memoryEnabled) return null;
    const scopeInfo = { projectId: projectId ?? null, includeGlobal: includeGlobal === true && settings.includeGlobal !== false };
    const rows = await store.memoryBySource(conversationId, messageId);
    if (!rows.some(row => row.id === id && row.status === 'active' && scopeAllows(scopeInfo, row.projectName))) return null;
    for (const event of await store.sourceMessageEvents(conversationId, messageId)) {
      if (!scopeAllows(scopeInfo, event.projectName)) continue;
      const source = messageParts(event, { forSourceRead: true }).find(part =>
        (part.messageId ?? (part.role === 'assistant' ? `${event.eventId}-assistant` : event.eventId)) === messageId &&
        ['user', 'assistant'].includes(part.role));
      if (source) return { text: source.text, role: source.role, projectId: event.projectName };
    }
    return null;
  }

  async function readHistorySource({ conversationId, messageId, mode = 'message' }) {
    await ensureReady();
    if (!(await currentSettings()).memoryEnabled) return null;
    const events = await store.sourceMessageEvents(conversationId, mode === 'message' ? messageId : null);
    const turns = events.map(event => messageParts(event, { forSourceRead: true })
      .filter(part => ['user', 'assistant'].includes(part.role))
      .map(part => ({
        ...part, messageId: part.messageId ?? (part.role === 'assistant' ? `${event.eventId}-assistant` : event.eventId),
      })));
    const messages = selectHistorySource(turns, messageId, mode);
    return messages ? { title: events[0]?.title, messages } : null;
  }

  // --- ingestion ------------------------------------------------------------
  function extractorCandidate(item) {
    if (typeof item === 'string') return { text: item.trim(), kind: 'fact', key: null, confidence: 0.7 };
    if (!object(item)) return null;
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 1000) : '';
    if (!text) return null;
    return {
      text,
      kind: ['fact', 'preference', 'decision', 'note'].includes(item.kind) ? item.kind : 'fact',
      key: typeof item.key === 'string' && item.key.trim() ? item.key.trim().slice(0, 200) : null,
      confidence: Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : 0.7,
    };
  }

  function keepJobAlive(job) {
    if (typeof memoryJobs?.heartbeat !== 'function') return () => {};
    const timer = setInterval(() => {
      memoryJobs.heartbeat(job.id, job.attempts).catch(() => {});
    }, 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function ingest(input, claimedJob = null) {
    if (!object(input)) fail('invalid-input');
    if (input.temporary === true
      || (input.role !== undefined && input.role !== 'user')
      || (input.author !== undefined && input.author !== 'user')) {
      return { extracted: [], skipped: 'ineligible', extractor: 'llm' };
    }
    if (typeof input.text !== 'string' || !input.text.trim()) {
      return { extracted: [], skipped: 'empty', extractor: 'llm' };
    }
    const conversationId = string(input.conversationId, 1000);
    const messageId = string(input.messageId, 500);
    const projectId = scope(input.projectId);
    const text = string(input.text, 60000);
    await ensureReady();

    // Explicit forget/correct commands are handled locally and never sent to
    // the extractor. Ambiguous targets require a user confirmation instead of
    // deleting or rewriting several memories silently.
    const command = parseMemoryCommand(text);
    if (command) {
      const rows = await store.searchMemories({
        projectName: projectId,
        includeGlobal: true,
        allProjects: false,
        tokens: [],
        limit: 5000,
      });
      const targets = findCommandTargets(rows.map(memoryFromRow), command);
      if (!targets.length) {
        return { action: 'none', extracted: [], skipped: 'no-target', extractor: 'local-command' };
      }
      if (targets.length > 1) {
        return {
          action: 'confirm', extracted: [], skipped: 'needs-confirmation',
          extractor: 'local-command', candidates: targets,
        };
      }
      const target = targets[0];
      if (command.action === 'forget') {
        const deleted = await store.transaction(tx => tx.deleteMemory(target.id));
        return { action: 'forget', deleted, memoryId: target.id, text: target.text, extractor: 'local-command' };
      }
      const replacement = String(command.replacement || '').trim();
      if (!replacement || replacement.length > 4000) {
        return { action: 'none', extracted: [], skipped: 'invalid-replacement', extractor: 'local-command' };
      }
      const nextText = target.text.includes(command.query)
        ? target.text.replace(command.query, replacement)
        : replacement;
      const updated = await store.transaction(tx => tx.updateMemory(target.id, {
        text: nextText,
        normalizedHash: memoryHash(nextText),
        updatedAt: now(),
      }));
      if (updated) {
        await store.deleteMemoryChunks(target.id).catch(() => {});
        await bestEffortIndex({ id: target.id, text: nextText, projectId, conversationId, messageId });
      }
      return { action: 'correct', updated, memoryId: target.id, text: nextText, extractor: 'local-command' };
    }

    const settingsValue = await currentSettings();
    if (!shouldAutoExtract(settingsValue) || settingsValue.extractorMode !== 'llm') {
      return { extracted: [], skipped: 'disabled', extractor: 'llm' };
    }
    // Redact secrets before the message is stored in a job or sent to the model.
    // A secret does not poison the whole message: the remaining legitimate
    // sentences can still produce a memory.
    const redaction = redactSensitive(text);
    const safeText = redaction.text;
    const existingRows = await store.memories();
    if (existingRows.length >= settingsValue.maxMemories) {
      return { extracted: [], skipped: 'memory-limit', extractor: 'llm' };
    }
    // Idempotency without an extra table: provenance rows identify the message.
    const prior = await store.memoryBySource(conversationId, messageId);
    if (prior.length) {
      return { extracted: prior.map(memoryFromRow), duplicate: true, extractor: 'llm', skipped: 'duplicate' };
    }
    let job = null;
    if (memoryJobs && !claimedJob) {
      try {
        const queued = await memoryJobs.enqueue({ conversationId, messageId, projectId, text: safeText });
        [job] = await memoryJobs.claim({ id: queued.id, limit: 1 });
        if (!job) return { extracted: [], skipped: 'job-unavailable', extractor: 'llm', jobId: queued.id, jobStatus: queued.status };
      } catch {
        return { extracted: [], skipped: 'job-unavailable', extractor: 'llm' };
      }
    }
    const stopHeartbeat = job ? keepJobAlive(job) : () => {};
    const settle = async (result, outcome = 'complete') => {
      if (!job) return result;
      try {
        if (outcome === 'fail') await memoryJobs.fail(job.id, result.error || 'llm-failed', job.attempts);
        else if (outcome === 'skip') await memoryJobs.skip(job.id, result.skipped || 'skipped', job.attempts);
        else await memoryJobs.complete(job.id, job.attempts);
      } catch {
        return { ...result, jobId: job.id, jobStatus: 'processing' };
      }
      return { ...result, jobId: job.id, jobStatus: outcome === 'fail' ? 'failed' : outcome === 'skip' ? 'skipped' : 'done' };
    };
    try {
    if (!extractor || typeof extractor.extract !== 'function') {
      return await settle({ extracted: [], skipped: 'llm-unavailable', extractor: 'llm' }, 'skip');
    }

    let result;
    try {
      result = await extractor.extract(safeText, { projectId, conversationId, messageId });
    } catch (error) {
      return await settle({
        extracted: [],
        skipped: 'llm-failed',
        extractor: 'llm',
        error: typeof error?.code === 'string' ? error.code : 'llm-failed',
      }, 'fail');
    }
    const ownedJob = claimedJob || job;
    if (ownedJob && typeof memoryJobs.heartbeat === 'function') {
      // Do not persist model output if a stalled worker has lost its lease.
      const owned = await memoryJobs.heartbeat(ownedJob.id, ownedJob.attempts);
      if (!owned) throw Object.assign(new Error('job-lease-lost'), { code: 'job-lease-lost' });
    }
    const meta = {
      extractor: 'llm',
      providerId: result?.providerId ?? null,
      modelId: result?.modelId ?? null,
      usage: result?.usage ?? null,
    };
    const list = Array.isArray(result)
      ? result
      : Array.isArray(result?.memories) ? result.memories : [];
    const candidates = list.map(extractorCandidate).filter(Boolean).slice(0, 5);
    if (!candidates.length) {
      return await settle({
        extracted: [],
        skipped: redaction.redacted ? 'sensitive-content' : 'no-memory',
        redacted: redaction.kinds,
        ...meta,
      }, redaction.redacted ? 'skip' : 'complete');
    }

    const extracted = [];
    let skipped = null;
    for (const candidate of candidates) {
      if (candidate.text.includes('[REDACTED]')) { skipped = 'sensitive-content'; continue; }
      try {
        const memory = await store.transaction(tx => addMemory(tx, {
          text: candidate.text,
          key: candidate.key,
          projectId,
          conversationId,
          messageId,
          source: 'automatic',
          kind: candidate.kind,
          confidence: candidate.confidence,
        }));
        extracted.push(memory);
      } catch (error) {
        if (error?.code === 'sensitive-content' || error?.code === 'memory-limit') {
          skipped = error.code;
          continue;
        }
        throw error;
      }
    }
    for (const memory of extracted) await bestEffortIndex(memory);
    return await settle({
      extracted, skipped,
      ...(redaction.redacted ? { redacted: redaction.kinds } : {}),
      ...meta,
    }, skipped ? 'skip' : 'complete');
    } catch (error) {
      if (job) await memoryJobs.fail(job.id, error?.code || 'ingest-failed', job.attempts).catch(() => {});
      throw error;
    } finally {
      stopHeartbeat();
    }
  }

  async function maintenance(input = {}) {
    await ensureReady();
    const rows = await store.memories();
    const memories = rows.map(row => ({
      ...memoryFromRow(row),
      expiredAt: row.expiresAt ?? row.expiredAt ?? null,
    }));
    const plan = planMaintenance(memories, {
      now: Date.now(),
      staleDays: Number.isInteger(input.staleDays) ? input.staleDays : 365,
      minImportance: typeof input.minImportance === 'number' ? input.minImportance : 0.25,
    });
    if (input.apply !== true) return { ...plan, applied: false };
    const stamp = now();
    for (const entry of plan.archive) {
      await store.updateMemory(entry.id, { status: 'disabled', updatedAt: stamp }).catch(() => {});
    }
    for (const group of plan.merge) {
      if (!group.duplicateIds.length) continue;
      await store.supersedeMemories(group.duplicateIds, group.canonicalId, stamp).catch(() => {});
      for (const id of group.duplicateIds) await store.deleteMemoryChunks(id).catch(() => {});
    }
    return { ...plan, applied: true };
  }

  async function listJobs(input = {}) {
    await ensureReady();
    return memoryJobs ? memoryJobs.list(input) : [];
  }

  async function processPendingJobs(input = {}) {
    await ensureReady();
    if (!memoryJobs) return { processed: 0, completed: 0, failed: 0 };
    const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 10;
    if (typeof memoryJobs.recoverStale === 'function') await memoryJobs.recoverStale();
    let processed = 0;
    let completed = 0;
    let failed = 0;
    // Claim only when ready to execute, so a batch waiting behind a slow model
    // call cannot have its lease expire before its heartbeat starts.
    while (processed < limit) {
      const [job] = await memoryJobs.claim({ limit: 1 });
      if (!job) break;
      processed += 1;
      const stopHeartbeat = keepJobAlive(job);
      try {
        const result = await ingest({
          conversationId: job.conversationId,
          messageId: job.messageId,
          projectId: job.projectId,
          text: job.text,
        }, job);
        if (result.skipped === 'llm-failed') {
          await memoryJobs.fail(job.id, result.error || 'llm-failed', job.attempts);
          failed += 1;
        } else {
          if (result.skipped && result.skipped !== 'duplicate') await memoryJobs.skip(job.id, result.skipped, job.attempts);
          else await memoryJobs.complete(job.id, job.attempts);
          completed += 1;
        }
      } catch (error) {
        failed += 1;
        await memoryJobs.fail(job.id, error?.code || 'llm-failed', job.attempts).catch(() => {});
      } finally {
        stopHeartbeat();
      }
      // Do not burn all attempts in one poll when a provider is unavailable.
      if (failed) break;
    }
    return { processed, completed, failed };
  }

  // --- export / clear -------------------------------------------------------
  async function exportData() {
    const state = await read();
    return {
      version: 1,
      exportedAt: now(),
      ownerId,
      sessions: state.sessions,
      memories: state.memories,
      settings: state.settings,
      events: [],
      tasks: [],
      checkpoints: [],
      storage: state.storage,
    };
  }

  async function clear(input) {
    const target = input?.target;
    if (!['memories', 'sessions', 'tasks', 'all'].includes(target)) fail('invalid-target');
    await ensureReady();
    await store.transaction(async tx => {
      if (target === 'memories') await tx.clearMemories();
      if (target === 'sessions') await tx.clearSessions();
      if (target === 'all') await tx.clearAll();
    });
    return { cleared: target };
  }

  // --- health / stats -------------------------------------------------------
  async function probeQueue(candidate) {
    if (!candidate) return null;
    if (typeof candidate.health === 'function') {
      const value = await candidate.health();
      return value === true || value === 'ok' || value?.status === 'ok';
    }
    if (typeof candidate.ping === 'function') {
      const value = await candidate.ping();
      return value === true || value === 'PONG' || value === 'ok';
    }
    const client = candidate.client || candidate.connection;
    if (client && typeof client.ping === 'function') return (await client.ping()) === 'PONG';
    return null;
  }
  async function queueCount(candidate, methods, keys) {
    if (!candidate) return 0;
    for (const method of methods) {
      if (typeof candidate[method] === 'function') {
        const value = await candidate[method]();
        return Number.isFinite(Number(value)) ? Number(value) : 0;
      }
    }
    if (typeof candidate.counts === 'function') {
      const counts = await candidate.counts();
      for (const key of keys) if (Number.isFinite(Number(counts?.[key]))) return Number(counts[key]);
    }
    return 0;
  }
  async function probeEmbedding(service) {
    if (!service) return 'down';
    const value = typeof service.status === 'function' ? await service.status() : service.status;
    const state = typeof value === 'string' ? value : value?.status ?? value?.state;
    if (['ok', 'loading', 'down'].includes(state)) return state;
    return service.ready === true ? 'ok' : 'down';
  }

  async function health() {
    const status = {
      mode: 'postgres',
      database: 'down',
      redis: 'disabled',
      objectStorage: 'disabled',
      embedding: 'down',
      embeddingModel,
      embeddingDim,
      queueLag: 0,
    };
    const messages = [];
    try {
      if (await store.ping()) {
        const ready = await store.schemaReady();
        status.database = ready ? 'ok' : 'migrating';
        if (!ready) messages.push('database schema is not migrated');
      }
    } catch {
      messages.push('database unavailable');
    }
    if (queue) {
      try {
        const probe = await probeQueue(queue);
        status.redis = probe === true ? 'ok' : 'down';
        if (probe !== true) messages.push('queue is not reachable');
        status.queueLag = await queueCount(queue, ['getWaitingCount'], ['waiting']).catch(() => 0);
      } catch {
        status.redis = 'down';
        messages.push('queue is not reachable');
      }
    }
    if (backupManager) {
      try {
        const probe = typeof backupManager.health === 'function' ? await backupManager.health() : null;
        status.objectStorage = probe === true || probe === 'ok' || probe?.status === 'ok' ? 'ok' : 'down';
        if (status.objectStorage !== 'ok') messages.push('object storage is not reachable');
      } catch {
        status.objectStorage = 'down';
        messages.push('object storage is not reachable');
      }
    }
    try {
      status.embedding = await probeEmbedding(embeddingService);
    } catch {
      status.embedding = 'down';
    }
    if (!embeddingService) messages.push('embedding service is not configured; search falls back to keywords');
    else if (status.embedding !== 'ok') messages.push(status.embedding === 'loading' ? 'embedding model is loading' : 'embedding model unavailable');
    if (messages.length) status.message = messages.join('; ');
    return status;
  }

  async function stats() {
    const result = {
      databaseBytes: 0,
      attachmentBytes: 0,
      queueWaiting: 0,
      queueFailed: 0,
      memories: 0,
      conversations: 0,
      events: 0,
      quotaBytes: null,
      indexPath: null,
    };
    try { result.databaseBytes = await store.databaseBytes(); } catch { /* database down */ }
    try {
      const counts = await store.counts();
      result.memories = counts.memories;
      result.conversations = counts.conversations;
      result.events = counts.events;
    } catch { /* database down */ }
    if (queue) {
      result.queueWaiting = await queueCount(queue, ['getWaitingCount'], ['waiting']).catch(() => 0);
      result.queueFailed = await queueCount(queue, ['getFailedCount'], ['failed']).catch(() => 0);
    }
    return result;
  }

  // --- backups --------------------------------------------------------------
  async function backup(input) {
    if (!backupManager || typeof backupManager.create !== 'function') fail('backup-unavailable');
    await ensureReady();
    const kind = input?.kind === 'scheduled' ? 'scheduled' : 'manual';
    const record = {
      id: id(),
      kind,
      path: '',
      bytes: null,
      status: 'running',
      error: null,
      createdAt: now(),
      completedAt: null,
    };
    await store.insertBackup(record);
    try {
      const result = await backupManager.create({ kind, ownerId, id: record.id });
      const patch = {
        status: 'completed',
        completedAt: now(),
        path: typeof result === 'string' ? result : typeof result?.path === 'string' ? result.path : '',
        bytes: typeof result?.bytes === 'number' && Number.isFinite(result.bytes) ? result.bytes : null,
      };
      await store.updateBackup(record.id, patch);
      return { ...record, ...patch };
    } catch (error) {
      // A failed backup must never delete older backups or current data.
      const patch = { status: 'failed', error: sanitizeMessage(error), completedAt: now() };
      await store.updateBackup(record.id, patch).catch(() => {});
      return { ...record, ...patch };
    }
  }

  async function listBackups() {
    await ensureReady();
    return store.backups(100);
  }

  async function restore(backupId) {
    if (!backupManager || typeof backupManager.restore !== 'function') fail('restore-unavailable');
    // Accept both restore('uuid') and restore({ id }) — the IPC channel passes an object.
    const target = typeof backupId === 'string'
      ? backupId.trim()
      : typeof backupId?.id === 'string' ? backupId.id.trim() : '';
    if (!UUID_PATTERN.test(target)) fail('not-found');
    await ensureReady();
    const record = await store.backup(target);
    if (!record) fail('not-found');
    if (record.status !== 'completed') fail('invalid-state');
    await backupManager.restore(record);
    return { restored: true };
  }

  async function reindex() {
    await ensureReady();
    if (queue && typeof queue.add === 'function') {
      const counts = await store.counts();
      await store.transaction(tx => tx.clearChunks());
      await enqueue(queue, 'mova-memory-index', { kind: 'reindex', ownerId, embeddingModel, embeddingVersion: 1 }, `reindex:${Date.now()}`);
      return { queued: counts.memories + counts.events };
    }
    if (searchEngine && typeof searchEngine.rebuild === 'function') {
      await store.transaction(tx => tx.clearChunks());
      const result = await searchEngine.rebuild({ ownerId, embeddingModel, embeddingDim });
      return { queued: Number.isInteger(result?.queued) ? result.queued : 0 };
    }
    fail('service-unavailable');
  }

  async function close() {
    readyPromise = null;
    if (typeof store.close === 'function') await store.close();
  }

  const api = {
    read,
    loadSessions,
    saveSessions,
    ingest: input => ingest(input),
    query,
    readMemorySource,
    readHistorySource,
    context,
    saveMemory,
    updateMemory,
    supersedeMemory,
    deleteMemory,
    settings,
    exportData,
    clear,
    health,
    stats,
    backup,
    listBackups,
    restore,
    reindex,
    // Extra hooks for main.cjs / the worker (not part of the §4 interface):
    indexMemory,
    indexSession,
    indexPending,
    listJobs,
    processPendingJobs,
    maintenance,
    close,
  };
  const repository = {};
  for (const [name, fn] of Object.entries(api)) {
    // health() must never throw (contract §5); everything else maps unknown
    // failures to stable MemoryError codes and never leaks driver details.
    repository[name] = name === 'health' ? fn : async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        throw normalizeError(error);
      }
    };
  }
  Object.defineProperty(repository, 'ownerId', { value: ownerId, enumerable: true });
  Object.defineProperty(repository, 'filePath', { value: filePath, enumerable: false });
  return repository;
}

async function enqueue(target, name, data, jobId) {
  if (!target || typeof target.add !== 'function') return false;
  await target.add(name, data, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  return true;
}

module.exports = {
  createPostgresRepository,
  DEFAULT_SETTINGS,
  SINGLE_USER_ID,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  PROJECT_OVERLAY_KEY,
  redactConnectionString,
  memoryFromRow,
};
