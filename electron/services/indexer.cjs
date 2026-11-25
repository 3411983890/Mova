'use strict';
/**
 * 索引器：把记忆/消息切块、生成中文 ngram，并写入契约表 mova_search_chunks。
 *
 * 契约：Mova服务版接口约定.md §3.1（表结构）、§6（分块与索引）
 *  - 记忆整条索引；消息按约 800–1200 字符切块，保留 conversationId/messageId/eventId；
 *  - 不索引 mock/demo/tool/system/thinking/临时/敏感内容；
 *  - 写入 mova_search_chunks（fts 为生成列，绝不写入）；
 *  - Embedding 失败时仍写入关键词索引（embedding 为 null），不伪造向量。
 *
 * 该模块不感知 Electron；pool/embedding/ownerId 全部注入。
 */
const { createHash } = require('node:crypto');

const DEFAULT_OWNER_ID = '00000000-0000-4000-8000-000000000001';
const CHUNK_MIN = 800;
const CHUNK_MAX = 1200;
const CHUNK_TARGET = 1000;
const MIN_TAIL = 120;
const NGRAM_MIN = 2;
const NGRAM_MAX = 3;
const NGRAM_LIMIT = 256;
const EMBEDDING_VERSION = 1;
const EMBEDDING_MODEL_FALLBACK = 'Xenova/multilingual-e5-small';
const DEFAULT_DIM = 384;
const EXCLUDED_ROLES = new Set(['tool', 'system', 'thinking']);
const EXCLUDED_SOURCES = new Set(['mock', 'demo']);
const SOURCE_KINDS = new Set(['message', 'memory']);

class IndexerError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'IndexerError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** 与 electron/memory-store.cjs 保持同一敏感内容判定（密码/密钥/令牌/证件/银行卡）。 */
function isSensitive(text) {
  return /(?:password|passwd|secret|api[\s_-]?key|access[\s_-]?token|private[\s_-]?key|密码|密碼|口令|密钥|密鑰|身份证|身份證|信用卡|银行卡|銀行卡)\s*[:：=是为為]?|\b(?:sk-[a-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[a-z0-9]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+/i.test(String(text));
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function optionalString(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeOwner(value) {
  const owner = value === undefined || value === null ? DEFAULT_OWNER_ID : String(value).trim();
  if (!owner) throw new IndexerError('invalid-input', 'ownerId 不能为空。');
  return owner;
}

/** 项目作用域：null 表示全局；空字符串非法（与 memory-store 语义一致）。 */
function normalizeProject(value) {
  if (value === undefined || value === null) return null;
  const project = String(value).trim();
  if (!project) throw new IndexerError('invalid-input', 'projectId 不能为空字符串；全局作用域请传 null。');
  return project;
}

function normalizeSourceKind(value) {
  if (value === undefined || value === null) return null;
  const kind = String(value).trim().toLowerCase();
  if (kind === 'session') return 'message';
  if (kind === 'chunk') return null;
  return SOURCE_KINDS.has(kind) ? kind : null;
}

function isExcluded(input) {
  if (input.temporary === true) return true;
  if (input.mock === true || input.demo === true) return true;
  if (input.source !== undefined && EXCLUDED_SOURCES.has(String(input.source).toLowerCase())) return true;
  if (input.role !== undefined && EXCLUDED_ROLES.has(String(input.role).toLowerCase())) return true;
  return false;
}

/**
 * 生成中文/英文检索词：中文 2–3 字符 ngram + 英文/数字单词（含分隔符拆分）。
 * 与查询侧共用同一函数，保证 content_ngrams && queryNgrams 可比。
 *
 * @param {string} text
 * @param {{min?: number, max?: number, limit?: number}} [options]
 * @returns {string[]} 去重后的词元，最多 limit 个
 */
function toNgrams(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const min = Number.isInteger(options.min) && options.min >= 1 ? options.min : NGRAM_MIN;
  const max = Number.isInteger(options.max) && options.max >= min ? Math.min(options.max, 4) : NGRAM_MAX;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : NGRAM_LIMIT;
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const out = new Set();
  // 英文/代码/数字优先：型号、错误码、日期、函数名最需要精确命中，不能被中文 ngram 挤掉。
  for (const word of normalized.match(/[a-z0-9][a-z0-9_+#./-]*/g) || []) {
    if (word.length >= 2) out.add(word);
    for (const part of word.split(/[._+#/:-]+/)) if (part.length >= 2) out.add(part);
    if (out.size >= limit) break;
  }
  // 中日韩文字：连续字串内部取 2–3 字符切片；单字串保留单字，避免查询无匹配。
  if (out.size < limit) {
    for (const run of normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g) || []) {
      const chars = Array.from(run);
      if (chars.length === 1) out.add(chars[0]);
      for (let n = min; n <= max; n += 1) {
        for (let i = 0; i + n <= chars.length; i += 1) out.add(chars.slice(i, i + n).join(''));
        if (out.size >= limit) break;
      }
      if (out.size >= limit) break;
    }
  }
  return [...out].slice(0, limit);
}

/** 递归切分：优先段落 → 换行 → 句子 → 逗号 → 硬切（按 UTF-16 单元，且不拆断代理对）。 */
function splitUnits(text, max, depth = 0) {
  if (text.length <= max) return [text];
  if (depth < 6) {
    const patterns = [
      /(\n{2,})/,
      /(\n)/,
      /(?<=[。！？；!?;])/,
      /(?<=[.．])\s+/,
      /(?<=[，,、：:])\s*/,
    ];
    for (const pattern of patterns) {
      const parts = text.split(pattern).filter(part => part.length > 0);
      if (parts.length <= 1) continue;
      const out = [];
      let progressed = false;
      for (const part of parts) {
        if (part.length <= max) out.push(part);
        else out.push(...splitUnits(part, max, depth + 1));
        if (part.length < text.length) progressed = true;
      }
      if (progressed && out.length > 1) return out;
    }
  }
  const out = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(index + max, text.length);
    // 不要把代理对切成两半；宁可少切一个 UTF-16 单元。
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    out.push(text.slice(index, end));
    index = end;
  }
  return out;
}

/**
 * 把一段消息切成约 800–1200 字符的块。
 * @param {string} text
 * @param {{min?: number, max?: number, target?: number}} [options]
 * @returns {string[]}
 */
function chunkText(text, options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : CHUNK_MAX;
  const min = Number.isInteger(options.min) && options.min > 0 ? Math.min(options.min, max) : Math.min(CHUNK_MIN, max);
  const target = Math.min(Math.max(Number.isInteger(options.target) ? options.target : CHUNK_TARGET, min), max);
  const clean = normalizeText(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const units = splitUnits(clean, max);
  const chunks = [];
  let current = '';
  for (const unit of units) {
    if (!unit) continue;
    if (!current) {
      current = unit;
      continue;
    }
    const candidate = current + unit;
    if (candidate.length <= max && current.length < target) current = candidate;
    else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current) chunks.push(current);
  // 合并过短的尾巴，避免出现"几个字"的碎片块。
  if (chunks.length > 1) {
    const tail = chunks[chunks.length - 1];
    const previous = chunks[chunks.length - 2];
    if (tail.length < Math.max(MIN_TAIL, Math.floor(min / 4)) && previous.length + tail.length <= max) {
      chunks.splice(chunks.length - 2, 2, previous + tail);
    }
  }
  return chunks.map(chunk => chunk.trim()).filter(Boolean);
}

function uuidFromHash(value) {
  const hex = createHash('sha256').update(String(value)).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hex.slice(18, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}-${hex.slice(20, 32)}`;
}

/**
 * 纯函数：把一个记忆/消息描述切成可写入 mova_search_chunks 的块。
 *
 * 输入：{ ownerId?, projectId?, sourceKind|kind, sourceId?, conversationId?, messageId?,
 *         eventId?, role?, text, temporary?, mock?, demo?, source?, status? }
 * 输出：[{ ownerId, projectId, conversationId, messageId, eventId, role, sourceKind,
 *          sourceId, chunkIndex, content, contentNgrams }]
 */
function buildChunks(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new IndexerError('invalid-input', 'buildChunks 需要一个对象参数。');
  }
  const rawKind = input.sourceKind ?? input.kind ?? 'message';
  const sourceKind = normalizeSourceKind(rawKind);
  if (!sourceKind) throw new IndexerError('invalid-input', `不支持的索引类型：${String(rawKind)}（只支持 message/memory）。`);
  if (isExcluded(input)) return [];
  if (sourceKind === 'memory' && input.status !== undefined && input.status !== null && input.status !== 'active') return [];

  const ownerId = normalizeOwner(input.ownerId);
  const projectId = normalizeProject(input.projectId ?? input.project_id);
  const conversationId = optionalString(input.conversationId, 1000);
  const messageId = optionalString(input.messageId, 500);
  const eventId = optionalString(input.eventId, 500);
  const role = optionalString(input.role, 40);
  const text = normalizeText(input.text ?? input.content);

  if (!text) return [];
  if (sourceKind === 'message' && !conversationId) {
    throw new IndexerError('invalid-input', '消息索引需要 conversationId。');
  }

  if (sourceKind === 'memory') {
    const sourceId = optionalString(input.sourceId ?? input.memoryId ?? input.id, 200);
    if (!sourceId) throw new IndexerError('invalid-input', '记忆索引需要 sourceId（记忆 id）。');
    if (isSensitive(text) || (input.key && isSensitive(String(input.key)))) return [];
    return [{
      ownerId,
      projectId,
      conversationId,
      messageId,
      eventId,
      role,
      sourceKind,
      sourceId,
      chunkIndex: 0,
      content: text,
      contentNgrams: toNgrams(text),
    }];
  }

  if (!messageId) throw new IndexerError('invalid-input', '消息索引需要 messageId，否则无法定位来源。');
  const sourceId = optionalString(input.sourceId, 500) || `${conversationId}:${messageId}`;
  const contents = chunkText(text);
  const chunks = [];
  contents.forEach((content, chunkIndex) => {
    if (isSensitive(content)) return;
    chunks.push({
      ownerId,
      projectId,
      conversationId,
      messageId,
      eventId,
      role,
      sourceKind,
      sourceId,
      chunkIndex,
      content,
      contentNgrams: toNgrams(content),
    });
  });
  return chunks;
}

const INSERT_SQL = `insert into mova_search_chunks
  (id, owner_id, project_id, conversation_id, message_id, source_kind, source_id, content, content_ngrams, embedding, embedding_model, embedding_version)
values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::text[], $10::vector, $11, $12)
on conflict (id) do update set
  owner_id = excluded.owner_id,
  project_id = excluded.project_id,
  conversation_id = excluded.conversation_id,
  message_id = excluded.message_id,
  source_kind = excluded.source_kind,
  source_id = excluded.source_id,
  content = excluded.content,
  content_ngrams = excluded.content_ngrams,
  embedding = excluded.embedding,
  embedding_model = excluded.embedding_model,
  embedding_version = excluded.embedding_version`;

const MEMORY_BATCH_SQL = `select id, project_id, text, kind, status
from mova_memories
where owner_id = $1::uuid and status = 'active'
order by id
limit $2 offset $3`;

const EVENT_BATCH_SQL = `select e.event_id, e.conversation_id, e.type, e.role, e.content, c.project_id
from mova_session_events e
join mova_conversations c on c.id = e.conversation_id
where c.owner_id = $1::uuid and c.temporary = false and e.type = 'message'
order by e.conversation_id, e.sequence
limit $2 offset $3`;

function vectorLiteral(vector) {
  return `[${vector.map(value => (Number.isFinite(value) ? value.toFixed(7) : '0')).join(',')}]`;
}

function assertVector(vector, dim) {
  if (!Array.isArray(vector) || vector.length !== dim) return false;
  for (const value of vector) if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return true;
}

function chunkIdFor(chunk, model) {
  return uuidFromHash([chunk.ownerId, chunk.sourceKind, chunk.sourceId, chunk.chunkIndex, model].join('|'));
}

/** 从 mova_session_events.content（{user, reply, attempts} 或纯文本）提取用户可见文本。 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => textOf(part)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    for (const key of ['text', 'content', 'body', 'value']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return '';
}

function eventParts(row) {
  const content = row.content;
  const eventId = row.event_id === undefined || row.event_id === null ? null : String(row.event_id);
  const parts = [];
  const excludedValue = value => Boolean(value) && typeof value === 'object'
    && (value.mock === true || value.demo === true || EXCLUDED_SOURCES.has(String(value.source || '').toLowerCase()));
  const push = (text, role, messageId, value) => {
    if (excludedValue(value)) return;
    if (typeof text === 'string' && text.trim()) parts.push({ text, role, messageId });
  };
  if (typeof content === 'string') {
    push(content, row.role || 'user', eventId, null);
    return parts;
  }
  if (Array.isArray(content)) {
    content.forEach((item, index) => push(textOf(item), (item && item.role) || row.role || 'user', eventId ? `${eventId}-${index}` : null, item));
    return parts;
  }
  if (content && typeof content === 'object') {
    // 契约：content 保存 { user, reply, attempts } 原始结构；attempts 是重试副本，不重复索引。
    const user = content.user ?? content.text ?? content.prompt ?? content.input;
    push(textOf(user), 'user', eventId, user);
    const reply = content.reply ?? content.assistant ?? content.response ?? content.output;
    push(textOf(reply), 'assistant', eventId ? `${eventId}-assistant` : null, reply);
  }
  return parts;
}

/**
 * 创建索引器。
 *
 * @param {object} options
 * @param {{query: Function, connect?: Function}} options.pool  pg Pool
 * @param {{embed: Function, status?: Function, model?: string, dim?: number}} [options.embedding]
 * @param {string} [options.ownerId]            默认单用户固定 id
 * @param {number} [options.embeddingVersion]   默认 1
 * @param {number} [options.dim]                默认 384
 * @param {boolean} [options.allowEmbeddingFailure] 默认 true：Embedding 失败仍写关键词索引
 */
function createIndexer(options = {}) {
  const pool = options.pool;
  if (!pool || typeof pool.query !== 'function') throw new IndexerError('invalid-config', 'createIndexer 需要 pg pool（含 query 方法）。');
  const embedding = options.embedding || null;
  const defaultOwnerId = normalizeOwner(options.ownerId);
  const embeddingVersion = Number.isInteger(options.embeddingVersion) ? options.embeddingVersion : EMBEDDING_VERSION;
  const dim = Number.isInteger(options.dim) && options.dim > 0 ? options.dim : DEFAULT_DIM;
  const allowEmbeddingFailure = options.allowEmbeddingFailure !== false;
  const embeddingModel = (() => {
    if (options.embeddingModel) return String(options.embeddingModel);
    if (embedding && typeof embedding.model === 'string' && embedding.model) return embedding.model;
    if (embedding && typeof embedding.status === 'function') {
      try {
        const status = embedding.status();
        if (status && typeof status.model === 'string' && status.model) return status.model;
      } catch {
        // 状态读取失败时使用契约默认模型名
      }
    }
    return EMBEDDING_MODEL_FALLBACK;
  })();

  async function withTransaction(work) {
    if (typeof pool.connect !== 'function') return work(pool);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // 回滚失败时保留原始错误
      }
      throw error;
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  /** 生成向量；失败返回 { vectors: null, error }，由调用方决定是否降级为纯关键词索引。 */
  async function embedContents(contents) {
    if (!embedding || typeof embedding.embed !== 'function') {
      return { vectors: null, error: { code: 'embedding-unavailable', message: '未配置 Embedding 服务，仅写入关键词索引。' } };
    }
    if (typeof embedding.status === 'function') {
      try {
        const status = embedding.status();
        if (status && status.state === 'down') {
          const reason = status.lastError && status.lastError.message ? status.lastError.message : 'Embedding 服务不可用';
          return { vectors: null, error: { code: 'embedding-down', message: `${reason} 仅写入关键词索引。` } };
        }
      } catch {
        // 状态读取失败时继续尝试
      }
    }
    try {
      const vectors = await embedding.embed(contents, { kind: 'document' });
      if (!Array.isArray(vectors) || vectors.length !== contents.length) {
        throw new IndexerError('invalid-vector', `Embedding 返回 ${Array.isArray(vectors) ? vectors.length : '未知'} 条向量，期望 ${contents.length} 条。`);
      }
      vectors.forEach((vector, index) => {
        if (!assertVector(vector, dim)) throw new IndexerError('invalid-vector', `第 ${index + 1} 条向量维度或数值非法，拒绝写入索引。`);
      });
      return { vectors, error: null };
    } catch (error) {
      if (!allowEmbeddingFailure) throw error;
      return {
        vectors: null,
        error: { code: error && error.code ? error.code : 'embedding-failed', message: error && error.message ? error.message : String(error) },
      };
    }
  }

  async function insertChunks(executor, chunks, vectors) {
    const ids = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const vector = vectors ? vectors[index] : null;
      const id = chunkIdFor(chunk, embeddingModel);
      await executor.query(INSERT_SQL, [
        id,
        chunk.ownerId,
        chunk.projectId,
        chunk.conversationId,
        chunk.messageId,
        chunk.sourceKind,
        chunk.sourceId,
        chunk.content,
        chunk.contentNgrams,
        vector ? vectorLiteral(vector) : null,
        vector ? embeddingModel : null,
        vector ? embeddingVersion : null,
      ]);
      ids.push(id);
    }
    return ids;
  }

  async function deleteBySourceWith(executor, filter = {}) {
    if (!filter || typeof filter !== 'object') throw new IndexerError('invalid-input', 'deleteBySource 需要一个过滤对象。');
    const ownerId = normalizeOwner(filter.ownerId === undefined ? defaultOwnerId : filter.ownerId);
    const where = ['owner_id = $1::uuid'];
    const params = [ownerId];
    let discriminator = false;
    const sourceKind = normalizeSourceKind(filter.sourceKind);
    if (filter.sourceKind !== undefined && !sourceKind) throw new IndexerError('invalid-input', 'deleteBySource 的 sourceKind 必须是 message/memory。');
    if (sourceKind) {
      params.push(sourceKind);
      where.push(`source_kind = $${params.length}`);
    }
    if (filter.sourceId !== undefined && filter.sourceId !== null) {
      params.push(String(filter.sourceId));
      where.push(`source_id = $${params.length}`);
      discriminator = true;
    }
    if (Array.isArray(filter.sourceIds) && filter.sourceIds.length) {
      params.push(filter.sourceIds.map(String));
      where.push(`source_id = any($${params.length}::text[])`);
      discriminator = true;
    }
    if (filter.conversationId !== undefined && filter.conversationId !== null) {
      params.push(String(filter.conversationId));
      where.push(`conversation_id = $${params.length}`);
      discriminator = true;
    }
    if (filter.messageId !== undefined && filter.messageId !== null) {
      params.push(String(filter.messageId));
      where.push(`message_id = $${params.length}`);
      discriminator = true;
    }
    if (!discriminator) {
      throw new IndexerError('invalid-input', 'deleteBySource 至少需要一个定位条件（sourceId/sourceIds/conversationId/messageId）；清空索引请用 reindexAll。');
    }
    const result = await executor.query(`delete from mova_search_chunks where ${where.join(' and ')}`, params);
    return result && typeof result.rowCount === 'number' ? result.rowCount : 0;
  }

  async function deleteBySource(filter = {}) {
    return deleteBySourceWith(pool, filter);
  }

  /**
   * 索引一条记忆（整条一个块）。
   * @returns {Promise<{indexed:number, embedded:number, skipped?:string, chunkIds:string[], embeddingError:object|null}>}
   */
  async function indexMemory(memory = {}, indexOptions = {}) {
    if (!memory || typeof memory !== 'object') throw new IndexerError('invalid-input', 'indexMemory 需要一个记忆对象。');
    const ownerId = normalizeOwner(memory.ownerId === undefined ? (indexOptions.ownerId === undefined ? defaultOwnerId : indexOptions.ownerId) : memory.ownerId);
    const sourceId = optionalString(memory.sourceId ?? memory.id ?? memory.memoryId, 200);
    const chunks = buildChunks({
      ownerId,
      projectId: memory.projectId ?? memory.project_id,
      sourceKind: 'memory',
      sourceId,
      conversationId: memory.conversationId ?? memory.conversation_id,
      messageId: memory.messageId ?? memory.message_id,
      eventId: memory.eventId ?? memory.event_id,
      text: memory.text,
      kind: memory.kind,
      key: memory.key,
      status: memory.status,
      temporary: memory.temporary,
    });
    if (!chunks.length) {
      const skipped = isSensitive(normalizeText(memory.text)) ? 'sensitive-content' : 'ineligible';
      const deleted = sourceId ? await deleteBySource({ ownerId, sourceKind: 'memory', sourceId }) : 0;
      return { indexed: 0, embedded: 0, skipped, chunkIds: [], deleted, embeddingError: null };
    }
    const { vectors, error } = await embedContents(chunks.map(chunk => chunk.content));
    let deleted = 0;
    const chunkIds = await withTransaction(async executor => {
      deleted = await deleteBySourceWith(executor, { ownerId, sourceKind: 'memory', sourceId: chunks[0].sourceId });
      return insertChunks(executor, chunks, vectors);
    });
    return { indexed: chunks.length, embedded: vectors ? vectors.length : 0, chunkIds, deleted, embeddingError: error };
  }

  /**
   * 索引一条消息（按 800–1200 字符切块）。
   * @returns {Promise<{indexed:number, embedded:number, skipped?:string, chunkIds:string[], embeddingError:object|null}>}
   */
  async function indexMessage(message = {}, indexOptions = {}) {
    if (!message || typeof message !== 'object') throw new IndexerError('invalid-input', 'indexMessage 需要一个消息对象。');
    const ownerId = normalizeOwner(message.ownerId === undefined ? (indexOptions.ownerId === undefined ? defaultOwnerId : indexOptions.ownerId) : message.ownerId);
    const chunks = buildChunks({
      ownerId,
      projectId: message.projectId ?? message.project_id,
      sourceKind: 'message',
      conversationId: message.conversationId ?? message.conversation_id,
      messageId: message.messageId ?? message.message_id,
      eventId: message.eventId ?? message.event_id,
      role: message.role,
      text: message.text,
      temporary: message.temporary,
      mock: message.mock,
      demo: message.demo,
      source: message.source,
    });
    if (!chunks.length) {
      const reason = message.temporary === true ? 'temporary'
        : isExcluded(message) ? 'ineligible'
          : isSensitive(normalizeText(message.text)) ? 'sensitive-content' : 'empty';
      return { indexed: 0, embedded: 0, skipped: reason, chunkIds: [], embeddingError: null };
    }
    const { vectors, error } = await embedContents(chunks.map(chunk => chunk.content));
    let deleted = 0;
    const chunkIds = await withTransaction(async executor => {
      deleted = await deleteBySourceWith(executor, { ownerId, sourceKind: 'message', conversationId: chunks[0].conversationId, messageId: chunks[0].messageId });
      return insertChunks(executor, chunks, vectors);
    });
    return { indexed: chunks.length, embedded: vectors ? vectors.length : 0, chunkIds, deleted, embeddingError: error };
  }

  /**
   * 清空并重建该 owner 的全部索引（后台执行；返回统计，不抛单项失败）。
   * @param {{ownerId?: string, batchSize?: number, limit?: number, onProgress?: Function, includeMemories?: boolean, includeMessages?: boolean}} [indexOptions]
   */
  async function reindexAll(indexOptions = {}) {
    const ownerId = normalizeOwner(indexOptions.ownerId === undefined ? defaultOwnerId : indexOptions.ownerId);
    const batchSize = Number.isInteger(indexOptions.batchSize) && indexOptions.batchSize > 0 ? Math.min(indexOptions.batchSize, 500) : 50;
    const limit = Number.isInteger(indexOptions.limit) && indexOptions.limit > 0 ? indexOptions.limit : Infinity;
    const started = Date.now();
    const summary = {
      ownerId,
      deleted: 0,
      memories: 0,
      messages: 0,
      chunks: 0,
      embedded: 0,
      skipped: 0,
      failed: 0,
      embeddingError: null,
      errors: [],
      tookMs: 0,
    };
    const deleted = await pool.query('delete from mova_search_chunks where owner_id = $1::uuid', [ownerId]);
    summary.deleted = deleted && typeof deleted.rowCount === 'number' ? deleted.rowCount : 0;

    const record = result => {
      summary.chunks += result.indexed || 0;
      summary.embedded += result.embedded || 0;
      if (result.embeddingError && !summary.embeddingError) summary.embeddingError = result.embeddingError;
      if (result.skipped) summary.skipped += 1;
    };
    const fail = (error, context) => {
      summary.failed += 1;
      if (summary.errors.length < 20) summary.errors.push({ ...context, code: error && error.code ? error.code : 'index-failed', message: error && error.message ? error.message : String(error) });
    };

    if (indexOptions.includeMemories !== false) {
      for (let offset = 0; offset < limit; offset += batchSize) {
        const { rows } = await pool.query(MEMORY_BATCH_SQL, [ownerId, Math.min(batchSize, limit - offset), offset]);
        if (!rows || !rows.length) break;
        for (const row of rows) {
          try {
            const result = await indexMemory({
              id: row.id,
              ownerId,
              projectId: row.project_id,
              text: row.text,
              kind: row.kind,
              status: row.status,
            });
            record(result);
            if (result.indexed) summary.memories += 1;
          } catch (error) {
            fail(error, { sourceKind: 'memory', sourceId: row.id });
          }
          if (summary.memories + summary.failed >= limit) break;
        }
        if (rows.length < batchSize || summary.memories + summary.failed >= limit) break;
        if (typeof indexOptions.onProgress === 'function') indexOptions.onProgress({ phase: 'memories', ...summary });
      }
    }

    if (indexOptions.includeMessages !== false) {
      for (let offset = 0; offset < limit; offset += batchSize) {
        const { rows } = await pool.query(EVENT_BATCH_SQL, [ownerId, Math.min(batchSize, limit - offset), offset]);
        if (!rows || !rows.length) break;
        for (const row of rows) {
          const content = row.content;
          const flags = content && typeof content === 'object' ? content : {};
          for (const part of eventParts(row)) {
            try {
              const result = await indexMessage({
                ownerId,
                projectId: row.project_id,
                conversationId: row.conversation_id,
                messageId: part.messageId,
                eventId: row.event_id,
                role: part.role,
                text: part.text,
                temporary: flags.temporary === true,
                mock: flags.mock === true,
                demo: flags.demo === true,
                source: flags.source,
              });
              record(result);
              if (result.indexed) summary.messages += 1;
            } catch (error) {
              fail(error, { sourceKind: 'message', conversationId: row.conversation_id, messageId: part.messageId });
            }
          }
          if (summary.messages + summary.failed >= limit) break;
        }
        if (rows.length < batchSize || summary.messages + summary.failed >= limit) break;
        if (typeof indexOptions.onProgress === 'function') indexOptions.onProgress({ phase: 'messages', ...summary });
      }
    }

    summary.tookMs = Date.now() - started;
    return summary;
  }

  /** postgres-repository 的 searchEngine 钩子：rebuild({ ownerId }) → { queued }。 */
  async function rebuild(indexOptions = {}) {
    const summary = await reindexAll(indexOptions);
    return { ...summary, queued: summary.chunks };
  }

  return {
    pool,
    embedding,
    ownerId: defaultOwnerId,
    embeddingModel,
    embeddingVersion,
    dim,
    buildChunks,
    toNgrams,
    indexMemory,
    indexMessage,
    deleteBySource,
    reindexAll,
    rebuild,
  };
}

module.exports = {
  createIndexer,
  buildChunks,
  chunkText,
  toNgrams,
  isSensitive,
  uuidFromHash,
  eventParts,
  IndexerError,
  DEFAULT_OWNER_ID,
  CHUNK_MIN,
  CHUNK_MAX,
  CHUNK_TARGET,
  EMBEDDING_VERSION,
};
