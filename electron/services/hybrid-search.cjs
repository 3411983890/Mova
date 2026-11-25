'use strict';
/**
 * 混合检索：关键词（tsvector + 中文 ngram/trigram）与向量（pgvector cosine）用 RRF 融合。
 *
 * 契约：Mova服务版接口约定.md §7（权威）、§4 query/context 返回结构
 *  - 关键词：mova_search_chunks.fts（generated tsvector, 'simple'）+ content_ngrams（GIN）+ ilike 兜底；
 *  - 向量：embedding <=> $queryVector，cosine；
 *  - RRF：score = Σ weight_i / (k + rank_i)，默认 k=60，权重关键词 0.5 / 向量 0.5；
 *  - owner_id / project_id 过滤必须在 SQL 层完成；
 *  - allProjects 只在显式传入 true 时生效，且仍受 owner_id 约束；
 *  - 语义关闭或 Embedding 不可用/失败时自动回退关键词，并在返回值中标记 degraded。
 *
 * 该模块不感知 Electron；pool / embedding / settings 全部注入。
 */
const { toNgrams, DEFAULT_OWNER_ID } = require('./indexer.cjs');

const DEFAULT_RRF_K = 60;
const DEFAULT_KEYWORD_WEIGHT = 0.5;
const DEFAULT_VECTOR_WEIGHT = 0.5;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 1000;
const DEFAULT_DIM = 384;

class SearchError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'SearchError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function normalizeOwner(value) {
  const owner = value === undefined || value === null ? DEFAULT_OWNER_ID : String(value).trim();
  if (!owner) throw new SearchError('invalid-input', 'ownerId 不能为空。');
  return owner;
}

/** null = 全局；空字符串非法（契约 §4：projectId 空字符串非法）。 */
function normalizeProject(value) {
  if (value === undefined || value === null) return null;
  const project = String(value).trim();
  if (!project) throw new SearchError('invalid-input', 'projectId 不能为空字符串；全局作用域请传 null。');
  return project;
}

function resolveLimit(inputLimit, settingsLimit) {
  if (inputLimit !== undefined && inputLimit !== null) {
    const number = Number(inputLimit);
    if (!Number.isInteger(number) || number < 1 || number > MAX_LIMIT) {
      throw new SearchError('invalid-input', `limit 必须是 1–${MAX_LIMIT} 的整数。`);
    }
    return number;
  }
  const configured = Number(settingsLimit);
  if (Number.isInteger(configured) && configured >= 1) return Math.min(configured, MAX_LIMIT);
  return DEFAULT_LIMIT;
}

function finiteWeight(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 10) {
    throw new SearchError('invalid-settings', `${name} 必须是 0–10 之间的数值，收到 ${String(value)}。`);
  }
  return number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 项目过滤谓词。契约表用 mova_projects.id（uuid），但 renderer 传的是项目名，
 * repository 会把名字映射成 uuid。两种形态都支持，且始终限定在 owner 内：
 *  - uuid：直接比较 project_id，走索引；
 *  - 名字：用 (owner_id, name) 唯一约束反查 id，不跨用户。
 */
function projectPredicate(projectId, index) {
  if (UUID_PATTERN.test(projectId)) return `c.project_id = $${index}::uuid`;
  return `c.project_id in (select p.id from mova_projects p where p.owner_id = $1::uuid and p.name = $${index})`;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function vectorLiteral(vector) {
  return `[${vector.map(value => (Number.isFinite(value) ? value.toFixed(7) : '0')).join(',')}]`;
}

function isUsableVector(vector) {
  if (!Array.isArray(vector) || vector.length !== DEFAULT_DIM) return false;
  for (const value of vector) if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return true;
}

function defaultKeyOf(document) {
  if (!document || typeof document !== 'object') return String(document);
  return document.key ?? document.id ?? document.chunkId ?? JSON.stringify(document);
}

function normalizeKindFilter(kinds) {
  if (kinds === undefined || kinds === null) return null;
  const list = Array.isArray(kinds) ? kinds : [kinds];
  const mapped = new Set();
  for (const kind of list) {
    const value = String(kind).trim().toLowerCase();
    if (value === 'memory') mapped.add('memory');
    else if (value === 'session' || value === 'message') mapped.add('message');
    else if (value) throw new SearchError('invalid-input', `不支持的检索类型：${String(kind)}（只支持 memory/session）。`);
  }
  return mapped.size ? [...mapped] : null;
}

/**
 * 纯函数 RRF 融合。rank 从 1 开始；同一 key 在两条通道都出现时累加。
 *
 * @param {object} input
 * @param {Array<object>} [input.keyword] 关键词通道结果（已按相关度降序）
 * @param {Array<object>} [input.vector]  向量通道结果（已按相似度降序）
 * @param {number} [input.keywordWeight=0.5]
 * @param {number} [input.vectorWeight=0.5]
 * @param {number} [input.k=60]
 * @param {Function} [input.keyOf]
 * @returns {Array<object>} 融合结果，含 score/keywordRank/vectorRank/keywordScore/vectorScore
 */
function rrfFuse(input = {}) {
  if (!input || typeof input !== 'object') throw new SearchError('invalid-input', 'rrfFuse 需要一个对象参数。');
  const keyword = input.keyword === undefined || input.keyword === null ? [] : input.keyword;
  const vector = input.vector === undefined || input.vector === null ? [] : input.vector;
  if (!Array.isArray(keyword) || !Array.isArray(vector)) throw new SearchError('invalid-input', 'rrfFuse 的 keyword/vector 必须是数组。');
  const keywordWeight = finiteWeight(input.keywordWeight, DEFAULT_KEYWORD_WEIGHT, 'keywordWeight');
  const vectorWeight = finiteWeight(input.vectorWeight, DEFAULT_VECTOR_WEIGHT, 'vectorWeight');
  if (keywordWeight <= 0 && vectorWeight <= 0) {
    throw new SearchError('invalid-settings', '关键词权重与向量权重不能同时为 0。');
  }
  const k = Number.isFinite(Number(input.k)) && Number(input.k) >= 0 ? Number(input.k) : DEFAULT_RRF_K;
  const keyOf = typeof input.keyOf === 'function' ? input.keyOf : defaultKeyOf;

  const merged = new Map();
  const absorb = (document, channel, rank, weight) => {
    if (!document || typeof document !== 'object') return;
    const key = String(keyOf(document));
    let entry = merged.get(key);
    if (!entry) {
      entry = { ...document, key, score: 0, keywordRank: null, vectorRank: null, keywordScore: null, vectorScore: null };
      merged.set(key, entry);
    }
    const contribution = weight / (k + rank);
    entry.score += contribution;
    if (channel === 'keyword') {
      entry.keywordRank = rank;
      entry.keywordScore = Number(document.keywordScore ?? document.score ?? 0) || 0;
    } else {
      entry.vectorRank = rank;
      entry.vectorScore = Number(document.vectorScore ?? document.score ?? 0) || 0;
    }
    // 保留更完整的内容字段（两条通道同一来源时内容相同）。
    if (!entry.hit && document.hit) entry.hit = document.hit;
    if (!entry.row && document.row) entry.row = document.row;
    entry.channels = entry.channels || [];
    if (!entry.channels.includes(channel)) entry.channels.push(channel);
  };

  keyword.forEach((document, index) => absorb(document, 'keyword', index + 1, keywordWeight));
  vector.forEach((document, index) => absorb(document, 'vector', index + 1, vectorWeight));

  return [...merged.values()].sort((left, right) => right.score - left.score
    || (right.keywordRank ?? Number.MAX_SAFE_INTEGER) - (left.keywordRank ?? Number.MAX_SAFE_INTEGER)
    || String(left.key).localeCompare(String(right.key)));
}

function createHybridSearch(options = {}) {
  const pool = options.pool;
  if (!pool || typeof pool.query !== 'function') throw new SearchError('invalid-config', 'createHybridSearch 需要 pg pool（含 query 方法）。');
  const embedding = options.embedding || null;
  const settingsSource = options.settings;
  const defaultOwnerId = normalizeOwner(options.ownerId);
  const embeddingModelOption = options.embeddingModel || null;
  const matchEmbeddingModel = options.matchEmbeddingModel !== false;

  async function currentSettings() {
    let value = settingsSource;
    if (typeof value === 'function') value = await value();
    return value && typeof value === 'object' ? value : {};
  }

  function embeddingState() {
    if (!embedding || typeof embedding.embed !== 'function') {
      return { available: false, state: 'unavailable', error: '未配置 Embedding 服务。' };
    }
    if (typeof embedding.status === 'function') {
      try {
        const status = embedding.status();
        if (status && status.state === 'down') {
          return {
            available: false,
            state: 'down',
            error: status.lastError && status.lastError.message ? status.lastError.message : 'Embedding 服务不可用。',
          };
        }
        return { available: true, state: status && status.state ? status.state : 'unknown', error: null };
      } catch {
        return { available: true, state: 'unknown', error: null };
      }
    }
    return { available: true, state: 'unknown', error: null };
  }

  function embeddingModelName() {
    if (embeddingModelOption) return embeddingModelOption;
    if (embedding && typeof embedding.model === 'string' && embedding.model) return embedding.model;
    return null;
  }

  function buildScope(scope, params) {
    const where = ['c.owner_id = $1::uuid'];
    if (!scope.allProjects) {
      if (scope.projectId) {
        params.push(scope.projectId);
        const predicate = projectPredicate(scope.projectId, params.length);
        where.push(scope.includeGlobal ? `(${predicate} or c.project_id is null)` : predicate);
      } else {
        // 全局作用域：只看全局内容，绝不放宽成"所有项目"。
        where.push('c.project_id is null');
      }
    }
    // 临时会话永不参与检索（索引器已跳过，这里再兜底一次）。
    where.push('not exists (select 1 from mova_conversations cv where cv.id = c.conversation_id and cv.temporary)');
    if (scope.kinds) {
      params.push(scope.kinds);
      where.push(`c.source_kind = any($${params.length}::text[])`);
    }
    return where;
  }

  async function keywordChannel(scope, query, topK) {
    const params = [scope.ownerId];
    const where = buildScope(scope, params);
    params.push(query);
    const queryIndex = params.length;
    params.push(toNgrams(query));
    const ngramIndex = params.length;
    params.push(`%${escapeLike(query)}%`);
    const likeIndex = params.length;
    params.push(topK);
    const limitIndex = params.length;
    const sql = `select c.id, c.owner_id, c.project_id, c.conversation_id, c.message_id,
       c.source_kind, c.source_id, c.content, c.created_at,
       ts_rank_cd(c.fts, plainto_tsquery('simple', $${queryIndex})) as fts_rank,
       (select count(*)::int from unnest($${ngramIndex}::text[]) as token where token = any(c.content_ngrams)) as ngram_hits
  from mova_search_chunks c
 where ${where.join(' and ')}
   and (c.fts @@ plainto_tsquery('simple', $${queryIndex})
        or c.content_ngrams && $${ngramIndex}::text[]
        or c.content ilike $${likeIndex})
 order by fts_rank desc, ngram_hits desc, c.created_at desc
 limit $${limitIndex}`;
    const result = await pool.query(sql, params);
    return Array.isArray(result?.rows) ? result.rows : [];
  }

  async function vectorChannel(scope, vector, topK) {
    const params = [scope.ownerId];
    const where = buildScope(scope, params);
    params.push(vectorLiteral(vector));
    const vectorIndex = params.length;
    const model = embeddingModelName();
    if (matchEmbeddingModel && model) {
      params.push(model);
      where.push(`c.embedding_model = $${params.length}`);
    }
    where.push('c.embedding is not null');
    params.push(topK);
    const limitIndex = params.length;
    const sql = `select c.id, c.owner_id, c.project_id, c.conversation_id, c.message_id,
       c.source_kind, c.source_id, c.content, c.created_at,
       1 - (c.embedding <=> $${vectorIndex}::vector) as similarity
  from mova_search_chunks c
 where ${where.join(' and ')}
 order by c.embedding <=> $${vectorIndex}::vector
 limit $${limitIndex}`;
    const result = await pool.query(sql, params);
    return Array.isArray(result?.rows) ? result.rows : [];
  }

  function toDocument(row) {
    const sourceKind = row.source_kind === 'memory' ? 'memory' : 'message';
    const sourceId = row.source_id === undefined || row.source_id === null ? null : String(row.source_id);
    const conversationId = row.conversation_id === undefined || row.conversation_id === null ? null : String(row.conversation_id);
    const messageId = row.message_id === undefined || row.message_id === null ? null : String(row.message_id);
    const key = sourceKind === 'memory'
      ? `memory:${sourceId ?? row.id}`
      : `message:${conversationId ?? ''}:${messageId ?? sourceId ?? row.id}`;
    const keywordScore = Number(row.fts_rank ?? 0) + Math.min(Number(row.ngram_hits ?? 0), 50) * 0.02;
    const vectorScore = row.similarity === undefined || row.similarity === null ? null : Number(row.similarity);
    return {
      key,
      chunkId: row.id,
      sourceKind,
      row,
      keywordScore,
      vectorScore,
      hit: sourceKind === 'memory'
        ? {
          kind: 'memory',
          id: sourceId,
          text: row.content,
          projectId: row.project_id ?? null,
          conversationId,
          messageId,
          createdAt: row.created_at ?? null,
        }
        : {
          kind: 'session',
          id: sourceId || `${conversationId ?? ''}:${messageId ?? ''}`,
          text: row.content,
          conversationId,
          messageId,
          projectId: row.project_id ?? null,
          createdAt: row.created_at ?? null,
        },
    };
  }

  function finalizeHits(fused) {
    return fused.filter(entry => entry.score > 0).map(entry => ({
      ...entry.hit,
      score: Number(entry.score.toFixed(6)),
      keywordRank: entry.keywordRank,
      vectorRank: entry.vectorRank,
      keywordScore: entry.keywordScore,
      vectorScore: entry.vectorScore,
      chunkId: entry.chunkId ?? null,
      channels: entry.channels ? [...entry.channels] : [],
    }));
  }

  async function run(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SearchError('invalid-input', 'search 需要一个对象参数。');
    const settings = await currentSettings();
    const ownerId = normalizeOwner(input.ownerId === undefined ? (settings.ownerId === undefined ? defaultOwnerId : settings.ownerId) : input.ownerId);
    const projectId = normalizeProject(input.projectId);
    const allProjects = input.allProjects === true;
    const includeGlobal = input.includeGlobal === undefined
      ? settings.includeGlobal !== false
      : input.includeGlobal === true;
    const limit = resolveLimit(input.limit, settings.searchLimit);
    let kinds = normalizeKindFilter(input.kinds);
    if (input.includeSessions === false) kinds = (kinds || ['memory', 'message']).filter(kind => kind === 'memory');
    if (input.includeMemories === false) kinds = (kinds || ['memory', 'message']).filter(kind => kind === 'message');
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, MAX_QUERY_CHARS) : '';
    const hybridSettings = settings.hybrid && typeof settings.hybrid === 'object' ? settings.hybrid : {};
    const pickWeight = (inputValue, name) => {
      const fallback = name === 'vectorWeight' ? DEFAULT_VECTOR_WEIGHT : DEFAULT_KEYWORD_WEIGHT;
      if (inputValue !== undefined && inputValue !== null) return finiteWeight(inputValue, fallback, name);
      if (hybridSettings[name] !== undefined && hybridSettings[name] !== null) return finiteWeight(hybridSettings[name], fallback, name);
      if (settings[name] !== undefined && settings[name] !== null) return finiteWeight(settings[name], fallback, name);
      return fallback;
    };
    const keywordWeight = pickWeight(input.keywordWeight, 'keywordWeight');
    const vectorWeight = pickWeight(input.vectorWeight, 'vectorWeight');
    const rawK = input.k ?? hybridSettings.k ?? settings.rrfK;
    const k = Number.isFinite(Number(rawK)) && Number(rawK) >= 0 ? Number(rawK) : DEFAULT_RRF_K;
    const semanticRequested = input.semantic === undefined
      ? settings.semanticSearch !== false && settings.semantic !== false
      : input.semantic === true;

    const scope = { ownerId, projectId, allProjects, includeGlobal, kinds };
    const weights = { keywordWeight, vectorWeight, k };
    const base = {
      hits: [],
      query,
      ownerId,
      projectId,
      allProjects,
      includeGlobal,
      limit,
      weights,
      mode: 'keyword',
      semantic: false,
      degraded: false,
      error: null,
      counts: { keyword: 0, vector: 0, merged: 0 },
      tookMs: 0,
    };
    if (input.temporary === true) {
      // 临时聊天不检索、不注入（契约 §4）。
      return { ...base, mode: 'temporary', tookMs: 0 };
    }
    if (!query) {
      return { ...base, mode: 'empty', tookMs: 0 };
    }

    const started = Date.now();
    const topK = Math.min(Math.max(limit * 4, 50), 200);
    let keywordRows;
    try {
      keywordRows = await keywordChannel(scope, query, topK);
    } catch (error) {
      if (error instanceof SearchError) throw error;
      throw new SearchError('search-failed', `关键词检索失败：${error && error.message ? error.message : String(error)}`, { cause: error });
    }
    const keywordDocuments = keywordRows.map(toDocument);

    let vectorRows = [];
    let mode = 'keyword';
    let degraded = false;
    let errorMessage = null;
    const state = embeddingState();
    if (semanticRequested && state.available) {
      let vector = null;
      try {
        const vectors = await embedding.embed([query], { kind: 'query' });
        vector = Array.isArray(vectors) && vectors.length ? vectors[0] : null;
        if (!isUsableVector(vector)) throw new SearchError('invalid-vector', '查询向量维度或数值非法，已回退关键词检索。');
      } catch (error) {
        // 语义通道失败绝不伪造向量：降级为关键词检索，并把原因交给健康状态/诊断。
        vector = null;
        degraded = true;
        errorMessage = error && error.message ? error.message : String(error);
      }
      if (vector) {
        try {
          vectorRows = await vectorChannel(scope, vector, topK);
          mode = 'hybrid';
        } catch (error) {
          if (error instanceof SearchError) throw error;
          throw new SearchError('search-failed', `向量检索失败：${error && error.message ? error.message : String(error)}`, { cause: error });
        }
      }
    } else if (semanticRequested && !state.available) {
      degraded = true;
      errorMessage = state.error || 'Embedding 服务不可用，已回退关键词检索。';
    }

    const fused = rrfFuse({
      keyword: keywordDocuments,
      vector: vectorRows.map(toDocument),
      keywordWeight,
      vectorWeight,
      k,
    });
    const hits = finalizeHits(fused).slice(0, limit);
    return {
      ...base,
      hits,
      mode,
      semantic: mode === 'hybrid',
      degraded,
      error: errorMessage,
      embeddingState: state.state,
      weights,
      counts: { keyword: keywordRows.length, vector: vectorRows.length, merged: hits.length },
      tookMs: Date.now() - started,
    };
  }

  /** 兼容 repository.query 的返回：仅命中数组。 */
  async function search(input = {}) {
    const result = await run(input);
    return result.hits;
  }

  /** 带诊断信息的版本（健康状态、设置页测试查询用）。 */
  async function searchWithMeta(input = {}) {
    return run(input);
  }

  return { search, searchWithMeta, rrfFuse };
}

module.exports = {
  createHybridSearch,
  rrfFuse,
  SearchError,
  DEFAULT_RRF_K,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_VECTOR_WEIGHT,
};
