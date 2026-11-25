'use strict';
/**
 * Local ONNX embedding service.
 *
 * Contract: Mova服务版接口约定.md §6（权威）
 *  - 模型 Xenova/multilingual-e5-small，384 维；
 *  - 运行时 @huggingface/transformers（Node ONNX），不依赖 Python/Ollama；
 *  - e5 前缀：文档 "passage: "，查询 "query: "；
 *  - 模型缓存 MOVA_EMBEDDING_CACHE_DIR 或调用方传入的 userData/models；
 *  - 下载/加载失败必须给出明确错误并允许检索降级到关键词，绝不伪造向量。
 *
 * 该模块不触碰 Electron、数据库和磁盘布局；pipelineFactory 可注入，便于离线测试。
 */
const path = require('node:path');

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const DEFAULT_DIM = 384;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 150;
const DEFAULT_RETRY_COOLDOWN_MS = 30_000;
const MAX_TEXT_CHARS = 20_000;
const DEFAULT_DTYPE = 'q8';

/** e5 前缀；document 与 passage 等价。 */
const PREFIXES = Object.freeze({
  document: 'passage: ',
  passage: 'passage: ',
  query: 'query: ',
});

class EmbeddingError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'EmbeddingError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function integerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * 默认 pipeline 工厂：懒加载 @huggingface/transformers，只在真正需要向量时下载模型。
 * 返回 feature-extraction pipeline（callable）。
 */
function defaultPipelineFactory(modelId, config = {}) {
  let transformers;
  try {
    // 延迟 require：没有安装依赖时模块本身仍可加载，健康检查可报告 down。
    transformers = require('@huggingface/transformers');
  } catch (error) {
    throw new EmbeddingError(
      'embedding-unavailable',
      `本地 Embedding 依赖 @huggingface/transformers 不可用（模型 ${modelId}）：${error.message}`,
      { cause: error },
    );
  }
  if (!transformers || typeof transformers.pipeline !== 'function') {
    throw new EmbeddingError('embedding-unavailable', `@huggingface/transformers 未导出 pipeline()，无法加载模型 ${modelId}。`);
  }
  try {
    const env = transformers.env;
    if (env && typeof env === 'object') {
      if (config.cacheDir) env.cacheDir = config.cacheDir;
      if (config.localModelPath) env.localModelPath = config.localModelPath;
      if (config.allowRemoteModels === false) env.allowRemoteModels = false;
      const endpoint = (process.env.MOVA_HF_ENDPOINT || '').trim();
      if (endpoint) env.remoteHost = endpoint;
    }
    return transformers.pipeline('feature-extraction', modelId, {
      dtype: config.dtype || DEFAULT_DTYPE,
      ...(config.revision ? { revision: config.revision } : {}),
    });
  } catch (error) {
    throw new EmbeddingError('model-load-failed', `无法初始化 Embedding 模型 ${modelId}：${error.message}`, { cause: error });
  }
}

/** 把 pipeline 输出（Tensor / Float32Array / number[][]）规范成行数组。 */
function toMatrix(output, expectedRows, expectedDim) {
  if (!output) throw new EmbeddingError('invalid-vector', 'Embedding 模型没有返回任何输出。');
  let rows;
  if (typeof output.tolist === 'function') {
    rows = output.tolist();
  } else if (output.data && (ArrayBuffer.isView(output.data) || Array.isArray(output.data))) {
    const data = Array.from(output.data);
    const dims = Array.isArray(output.dims) && output.dims.length ? output.dims : null;
    const cols = dims ? Number(dims[dims.length - 1]) : expectedDim;
    if (!Number.isInteger(cols) || cols <= 0) throw new EmbeddingError('invalid-vector', '无法从模型输出推断向量的维度。');
    rows = [];
    for (let i = 0; i + cols <= data.length; i += cols) rows.push(data.slice(i, i + cols));
  } else if (Array.isArray(output)) {
    rows = output.map(row => (Array.isArray(row) || ArrayBuffer.isView(row) ? Array.from(row) : row));
  } else if (ArrayBuffer.isView(output)) {
    rows = [Array.from(output)];
  } else {
    throw new EmbeddingError('invalid-vector', '模型返回了无法识别的向量格式。');
  }
  if (!Array.isArray(rows) || rows.length !== expectedRows) {
    throw new EmbeddingError('invalid-vector', `模型返回的向量条数 ${Array.isArray(rows) ? rows.length : '未知'} 与输入 ${expectedRows} 不一致。`);
  }
  return rows;
}

/** L2 归一化：cosine/HNSW 要求单位向量；零向量视为模型故障，不做任何"修正"。 */
function normalizeVector(row, index) {
  if (!Array.isArray(row) || row.length !== DEFAULT_DIM) {
    throw new EmbeddingError('invalid-vector', `第 ${index + 1} 条向量维度为 ${Array.isArray(row) ? row.length : '未知'}，期望 ${DEFAULT_DIM}。`);
  }
  let sum = 0;
  for (const value of row) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EmbeddingError('invalid-vector', `第 ${index + 1} 条向量包含非有限数值，拒绝写入索引。`);
    }
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingError('invalid-vector', `第 ${index + 1} 条向量为零向量，拒绝写入索引。`);
  }
  return row.map(value => value / norm);
}

/**
 * 创建本地 Embedding 服务（惰性单例：同一实例只加载一次模型）。
 *
 * @param {object} [options]
 * @param {string} [options.model]       默认 MOVA_EMBEDDING_MODEL 或 Xenova/multilingual-e5-small
 * @param {string} [options.cacheDir]    模型缓存目录（通常是 app.getPath('userData')/models）
 * @param {Function} [options.extractor] 已加载的 pipeline，直接注入则跳过加载
 * @param {Function} [options.pipelineFactory] (model, config) => pipeline | Promise，用于测试
 * @param {string} [options.dtype]       默认 q8
 * @param {number} [options.batchSize]   默认 8
 * @param {number} [options.retries]     单批失败重试次数，默认 1
 * @param {number} [options.retryCooldownMs] 加载失败后的冷却时间，默认 30000
 */
function createEmbeddingService(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EmbeddingError('invalid-input', 'createEmbeddingService 需要一个选项对象。');
  }
  const model = String(options.model || process.env.MOVA_EMBEDDING_MODEL || DEFAULT_MODEL).trim();
  if (!model) throw new EmbeddingError('invalid-config', 'Embedding 模型名不能为空。');

  const dim = options.dim === undefined ? integerFromEnv('MOVA_EMBEDDING_DIM', DEFAULT_DIM) : options.dim;
  if (dim !== DEFAULT_DIM) {
    throw new EmbeddingError(
      'invalid-config',
      `Embedding 维度必须为 ${DEFAULT_DIM}（mova_search_chunks.embedding 为 vector(384)），收到 ${dim}。`,
    );
  }

  const envCacheDir = (process.env.MOVA_EMBEDDING_CACHE_DIR || '').trim();
  const cacheDir = envCacheDir || (options.cacheDir ? path.resolve(String(options.cacheDir)) : null);
  const batchSize = boundedInteger(options.batchSize, integerFromEnv('MOVA_EMBEDDING_BATCH_SIZE', DEFAULT_BATCH_SIZE), 1, 64);
  const retries = boundedInteger(options.retries, DEFAULT_RETRIES, 0, 5);
  const retryDelayMs = boundedInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 0, 10_000);
  const retryCooldownMs = boundedInteger(options.retryCooldownMs, DEFAULT_RETRY_COOLDOWN_MS, 0, 3_600_000);
  const dtype = options.dtype || process.env.MOVA_EMBEDDING_DTYPE || DEFAULT_DTYPE;
  const pipelineFactory = options.pipelineFactory || defaultPipelineFactory;
  if (typeof pipelineFactory !== 'function') throw new EmbeddingError('invalid-config', 'pipelineFactory 必须是函数。');

  let extractor = options.extractor || null;
  let loadPromise = null;
  let state = extractor ? 'ok' : 'unloaded';
  let lastError = null;
  let failedAt = 0;
  let lastUsedAt = null;

  function failure(error) {
    if (error instanceof EmbeddingError) return error;
    const message = error && error.message ? error.message : String(error);
    return new EmbeddingError(
      'model-load-failed',
      `无法加载本地 Embedding 模型 ${model}（缓存目录：${cacheDir || '默认'}）：${message}。语义检索将降级为关键词检索。`,
      { cause: error },
    );
  }

  function runtimeFailure(error) {
    if (error instanceof EmbeddingError) return error;
    const message = error && error.message ? error.message : String(error);
    return new EmbeddingError('embedding-failed', `Embedding 模型 ${model} 生成向量失败：${message}`, { cause: error });
  }

  function status() {
    // state: 服务内部状态；health/status: 契约 §5 的 'ok'|'loading'|'down'（未加载视为 loading）。
    const health = state === 'ok' ? 'ok' : state === 'down' ? 'down' : 'loading';
    return {
      state,
      status: health,
      health,
      ready: state === 'ok',
      model,
      dim: DEFAULT_DIM,
      cacheDir,
      loaded: Boolean(extractor),
      loading: Boolean(loadPromise),
      lastError: lastError ? { code: lastError.code, message: lastError.message } : null,
      lastUsedAt,
    };
  }

  async function load() {
    if (extractor) return extractor;
    if (state === 'down' && lastError && Date.now() - failedAt < retryCooldownMs) throw lastError;
    if (!loadPromise) {
      state = 'loading';
      lastError = null;
      loadPromise = (async () => {
        try {
          const instance = await pipelineFactory(model, {
            cacheDir,
            dtype,
            dim: DEFAULT_DIM,
            revision: options.revision,
            localModelPath: options.localModelPath,
            allowRemoteModels: options.allowRemoteModels,
          });
          if (typeof instance !== 'function') {
            throw new EmbeddingError('model-load-failed', `模型 ${model} 的 pipeline 不可调用，无法生成向量。`);
          }
          extractor = instance;
          state = 'ok';
          failedAt = 0;
          lastUsedAt = Date.now();
          return instance;
        } catch (error) {
          const wrapped = failure(error);
          extractor = null;
          state = 'down';
          lastError = wrapped;
          failedAt = Date.now();
          throw wrapped;
        } finally {
          loadPromise = null;
        }
      })();
    }
    return loadPromise;
  }

  async function runBatch(instance, texts) {
    let attempt = 0;
    for (;;) {
      try {
        const output = await instance(texts, { pooling: 'mean', normalize: true });
        return toMatrix(output, texts.length, DEFAULT_DIM);
      } catch (error) {
        // 输入/输出维度类错误重试没有意义，直接失败。
        if (error instanceof EmbeddingError && (error.code === 'invalid-vector' || error.code === 'invalid-input')) throw error;
        if (attempt >= retries) {
          if (error instanceof EmbeddingError) throw error;
          throw new EmbeddingError(
            'embedding-failed',
            `Embedding 模型 ${model} 生成向量失败：${error && error.message ? error.message : String(error)}`,
            { cause: error },
          );
        }
        attempt += 1;
        if (retryDelayMs) await sleep(retryDelayMs * attempt);
      }
    }
  }

  /**
   * 生成向量。
   * @param {string[]} texts
   * @param {{kind?: 'document'|'passage'|'query'}} [embedOptions]
   * @returns {Promise<number[][]>} 每条 384 维、已 L2 归一化
   */
  async function embed(texts, embedOptions = {}) {
    if (!Array.isArray(texts)) throw new EmbeddingError('invalid-input', 'embed(texts) 的 texts 必须是字符串数组。');
    if (texts.length === 0) return [];
    // 兼容 {kind} 与 {type}（postgres-repository 使用 type: 'query'|'passage'）。
    const requested = embedOptions && (embedOptions.kind ?? embedOptions.type);
    const kind = requested ? String(requested) : 'document';
    const prefix = PREFIXES[kind];
    if (!prefix) throw new EmbeddingError('invalid-input', `未知的 Embedding 类型：${kind}（只支持 document/passage/query）。`);

    const prepared = texts.map((text, index) => {
      if (typeof text !== 'string') throw new EmbeddingError('invalid-input', `第 ${index + 1} 条待向量化内容不是字符串。`);
      const trimmed = text.trim();
      if (!trimmed) throw new EmbeddingError('invalid-input', `第 ${index + 1} 条待向量化内容为空。`);
      if (trimmed.length > MAX_TEXT_CHARS) {
        throw new EmbeddingError('invalid-input', `第 ${index + 1} 条待向量化内容超过 ${MAX_TEXT_CHARS} 字符上限，请先分块。`);
      }
      // 调用方可能已按 e5 约定加好前缀；先归一化再补一次，避免 "query: query: "。
      const body = trimmed.replace(/^(?:query|passage):\s*/i, '');
      if (!body) throw new EmbeddingError('invalid-input', `第 ${index + 1} 条待向量化内容只有 e5 前缀，没有正文。`);
      return `${prefix}${body}`;
    });

    const instance = await load();
    const vectors = [];
    for (let offset = 0; offset < prepared.length; offset += batchSize) {
      const batch = prepared.slice(offset, offset + batchSize);
      let rows;
      try {
        rows = await runBatch(instance, batch);
      } catch (error) {
        // 模型运行期故障：标记为 down，让上层走关键词降级，而不是伪造向量。
        const wrapped = runtimeFailure(error);
        state = 'down';
        lastError = wrapped;
        failedAt = Date.now();
        throw wrapped;
      }
      for (let i = 0; i < rows.length; i += 1) vectors.push(normalizeVector(rows[i], offset + i));
    }
    if (vectors.length !== texts.length) {
      throw new EmbeddingError('invalid-vector', `向量数量 ${vectors.length} 与输入 ${texts.length} 不一致。`);
    }
    lastUsedAt = Date.now();
    return vectors;
  }

  /** 预热：加载模型并返回状态；失败不抛异常（健康检查用）。 */
  async function warmup() {
    try {
      await load();
    } catch {
      // status() 已记录失败原因
    }
    return status();
  }

  /** 释放 pipeline（下次调用会重新惰性加载）。 */
  async function close() {
    const instance = extractor;
    extractor = null;
    loadPromise = null;
    state = 'unloaded';
    lastError = null;
    failedAt = 0;
    if (instance && typeof instance.dispose === 'function') {
      try {
        await instance.dispose();
      } catch {
        // 释放失败不影响服务状态
      }
    }
    return status();
  }

  return {
    embed,
    status,
    warmup,
    close,
    model,
    dim: DEFAULT_DIM,
    cacheDir,
    get ready() {
      return state === 'ok';
    },
  };
}

module.exports = {
  createEmbeddingService,
  EmbeddingError,
  defaultPipelineFactory,
  DEFAULT_MODEL,
  DEFAULT_DIM,
  PREFIXES,
  PASSAGE_PREFIX: PREFIXES.passage,
  QUERY_PREFIX: PREFIXES.query,
};
