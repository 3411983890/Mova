import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createEmbeddingService,
  EmbeddingError,
  DEFAULT_MODEL,
  DEFAULT_DIM,
} = require('../electron/services/embedding.cjs');
const {
  createIndexer,
  buildChunks,
  chunkText,
  toNgrams,
  uuidFromHash,
  DEFAULT_OWNER_ID,
  CHUNK_MAX,
} = require('../electron/services/indexer.cjs');

const OWNER = DEFAULT_OWNER_ID;

function deterministicRow(seed, size = DEFAULT_DIM) {
  const row = new Array(size);
  let state = (seed >>> 0) || 1;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    row[index] = (state / 0xffffffff) * 2 - 1;
  }
  return row;
}

function seedOf(text) {
  let seed = 7;
  for (const character of text) seed = (seed * 31 + character.codePointAt(0)) >>> 0;
  return seed;
}

/** 可注入的假 pipeline：不联网、不下载，输出确定性 384 维向量。 */
function createFakePipeline(options = {}) {
  const calls = [];
  const extractor = async (texts, runOptions) => {
    calls.push({ texts: [...texts], options: runOptions });
    if (options.failures && calls.length <= options.failures) throw new Error(options.failureMessage || 'onnx runtime failure');
    let rows = texts.map(text => deterministicRow(seedOf(text)));
    if (options.badDim) rows = rows.map(row => row.slice(0, 128));
    if (options.nan) rows = rows.map(row => row.map((value, index) => (index === 0 ? Number.NaN : value)));
    if (options.rowCount !== undefined) rows = rows.slice(0, options.rowCount);
    if (options.mode === 'tolist') return { tolist: () => rows };
    if (options.mode === 'array') return rows;
    return { dims: [rows.length, rows[0]?.length ?? DEFAULT_DIM], data: Float32Array.from(rows.flat()) };
  };
  extractor.calls = calls;
  return extractor;
}

function unitNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function createFakePool(handler) {
  const calls = [];
  const pool = {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params, calls);
    },
  };
  return pool;
}

function defaultIndexerHandler() {
  return (text) => {
    if (/^\s*insert into mova_search_chunks/i.test(text)) return { rowCount: 1, rows: [] };
    if (/^\s*delete from mova_search_chunks/i.test(text)) return { rowCount: 2, rows: [] };
    if (/from mova_memories/i.test(text)) return { rowCount: 0, rows: [] };
    if (/from mova_session_events/i.test(text)) return { rowCount: 0, rows: [] };
    throw new Error(`unexpected SQL: ${text.slice(0, 60)}`);
  };
}

function createFakeEmbedding(options = {}) {
  const state = { calls: [], statusState: options.state || 'ok', error: options.error || null };
  const embedding = {
    model: options.model || DEFAULT_MODEL,
    calls: state.calls,
    async embed(texts, embedOptions) {
      state.calls.push({ texts: [...texts], options: embedOptions });
      if (options.error) throw options.error;
      return texts.map(text => deterministicRow(seedOf(text)));
    },
    status() {
      return {
        state: state.statusState,
        model: options.model || DEFAULT_MODEL,
        dim: DEFAULT_DIM,
        lastError: state.error ? { code: state.error.code || 'embedding-failed', message: state.error.message } : null,
      };
    },
  };
  return embedding;
}

// ---------------------------------------------------------------- embedding

test('embedding: e5 prefixes, 384 dims, unit vectors and lazy single load', async () => {
  const extractor = createFakePipeline();
  let factoryCalls = 0;
  const service = createEmbeddingService({
    cacheDir: 'C:\\tmp\\mova-models',
    pipelineFactory: (model, config) => {
      factoryCalls += 1;
      assert.equal(model, DEFAULT_MODEL);
      assert.ok(config.cacheDir.endsWith('mova-models'));
      assert.equal(config.dim, DEFAULT_DIM);
      return extractor;
    },
  });

  assert.equal(service.status().state, 'unloaded');
  assert.equal(service.status().health, 'loading');
  assert.equal(factoryCalls, 0, '模型必须惰性加载');

  const documents = await service.embed(['第一段文档', 'second document'], { kind: 'document' });
  assert.equal(documents.length, 2);
  assert.equal(documents[0].length, DEFAULT_DIM);
  assert.ok(Math.abs(unitNorm(documents[0]) - 1) < 1e-9, '向量必须 L2 归一化');
  assert.equal(extractor.calls[0].texts[0], 'passage: 第一段文档');
  assert.equal(extractor.calls[0].texts[1], 'passage: second document');
  assert.equal(extractor.calls[0].options.pooling, 'mean');
  assert.equal(extractor.calls[0].options.normalize, true);
  const queries = await service.embed(['查询词'], { kind: 'query' });
  assert.equal(queries.length, 1);
  assert.equal(extractor.calls[1].texts[0], 'query: 查询词');
  assert.equal(factoryCalls, 1, '同一服务实例只加载一次 pipeline');
  assert.equal(service.status().state, 'ok');
  assert.equal(service.status().health, 'ok');
  assert.equal(service.status().loaded, true);
});

test('embedding: pipeline load failure is reported clearly and never fabricates vectors', async () => {
  let factoryCalls = 0;
  const service = createEmbeddingService({
    pipelineFactory: () => {
      factoryCalls += 1;
      throw new Error('offline: cannot reach huggingface.co');
    },
  });
  await assert.rejects(
    () => service.embed(['任意文本'], { kind: 'document' }),
    error => error instanceof EmbeddingError
      && error.code === 'model-load-failed'
      && error.message.includes(DEFAULT_MODEL)
      && error.message.includes('offline'),
  );
  const status = service.status();
  assert.equal(status.state, 'down');
  assert.equal(status.health, 'down');
  assert.equal(status.loaded, false);
  assert.equal(status.lastError.code, 'model-load-failed');
  // 冷却期内不重复尝试下载，也不返回任何向量。
  await assert.rejects(() => service.embed(['再次尝试']), error => error.code === 'model-load-failed');
  assert.equal(factoryCalls, 1);
});

test('embedding: batched calls, transient retry and persistent runtime failure', async () => {
  const extractor = createFakePipeline({ failures: 1, failureMessage: 'transient onnx error' });
  const service = createEmbeddingService({ pipelineFactory: () => extractor, retries: 1, retryDelayMs: 0, batchSize: 2 });
  const vectors = await service.embed(['a', 'b', 'c', 'd', 'e']);
  assert.equal(vectors.length, 5);
  // 第一次尝试失败并重试，成功后再按 batchSize=2 分批：2,2,2,1。
  assert.deepEqual(extractor.calls.map(call => call.texts.length), [2, 2, 2, 1]);
  assert.equal(extractor.calls.length, 4, '首次失败后重试，再按 batchSize=2 分批');

  const failing = createFakePipeline({ failures: 99, failureMessage: 'session crashed' });
  const broken = createEmbeddingService({ pipelineFactory: () => failing, retries: 0 });
  await assert.rejects(
    () => broken.embed(['x']),
    error => error.code === 'embedding-failed' && error.message.includes('session crashed'),
  );
  assert.equal(broken.status().state, 'down');
});

test('embedding: invalid input and invalid model output are rejected', async () => {
  const service = createEmbeddingService({ pipelineFactory: () => createFakePipeline() });
  await assert.rejects(() => service.embed('not-an-array'), error => error.code === 'invalid-input');
  await assert.rejects(() => service.embed(['ok'], { kind: 'bogus' }), error => error.code === 'invalid-input');
  await assert.rejects(() => service.embed(['   ']), error => error.code === 'invalid-input');
  assert.deepEqual(await service.embed([]), []);

  const wrongDim = createEmbeddingService({ pipelineFactory: () => createFakePipeline({ badDim: true }) });
  await assert.rejects(() => wrongDim.embed(['x']), error => error.code === 'invalid-vector');

  const wrongCount = createEmbeddingService({ pipelineFactory: () => createFakePipeline({ rowCount: 1 }) });
  await assert.rejects(() => wrongCount.embed(['x', 'y']), error => error.code === 'invalid-vector');

  const nan = createEmbeddingService({ pipelineFactory: () => createFakePipeline({ nan: true }) });
  await assert.rejects(() => nan.embed(['x']), error => error.code === 'invalid-vector');
});

test('embedding: cache dir comes from MOVA_EMBEDDING_CACHE_DIR or the injected userData path', async t => {
  const previous = process.env.MOVA_EMBEDDING_CACHE_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.MOVA_EMBEDDING_CACHE_DIR;
    else process.env.MOVA_EMBEDDING_CACHE_DIR = previous;
  });

  delete process.env.MOVA_EMBEDDING_CACHE_DIR;
  const fromOption = createEmbeddingService({ cacheDir: 'C:\\Users\\tester\\AppData\\Mova\\models', pipelineFactory: () => createFakePipeline() });
  assert.ok(fromOption.status().cacheDir.endsWith('models'));

  process.env.MOVA_EMBEDDING_CACHE_DIR = 'D:\\mova-cache';
  const fromEnv = createEmbeddingService({ cacheDir: 'C:\\Users\\tester\\AppData\\Mova\\models', pipelineFactory: () => createFakePipeline() });
  assert.equal(fromEnv.status().cacheDir, 'D:\\mova-cache', '显式环境变量优先');

  process.env.MOVA_EMBEDDING_DIM = '1024';
  t.after(() => { delete process.env.MOVA_EMBEDDING_DIM; });
  assert.throws(() => createEmbeddingService({ pipelineFactory: () => createFakePipeline() }), error => error.code === 'invalid-config');
});

test('embedding: close disposes the pipeline and allows a lazy reload', async () => {
  let disposed = 0;
  const extractor = createFakePipeline();
  extractor.dispose = async () => { disposed += 1; };
  let factoryCalls = 0;
  const service = createEmbeddingService({ pipelineFactory: () => { factoryCalls += 1; return extractor; } });
  await service.embed(['a']);
  const status = await service.close();
  assert.equal(disposed, 1);
  assert.equal(status.state, 'unloaded');
  assert.equal(service.status().loaded, false);
  await service.embed(['b']);
  assert.equal(factoryCalls, 2);
  assert.equal(extractor.calls.length, 2);
});

test('embedding: {type} alias and pre-prefixed input never double the e5 prefix', async () => {
  const extractor = createFakePipeline();
  const service = createEmbeddingService({ pipelineFactory: () => extractor });
  await service.embed(['数据库用的什么'], { type: 'query' });
  assert.equal(extractor.calls[0].texts[0], 'query: 数据库用的什么', 'repository 传 {type:"query"} 时必须使用 query 前缀');
  await service.embed(['passage: 已带前缀的文档'], { kind: 'document' });
  assert.equal(extractor.calls[1].texts[0], 'passage: 已带前缀的文档', '已带前缀不得重复');
  await service.embed(['query: 前缀与类型不一致'], { kind: 'document' });
  assert.equal(extractor.calls[2].texts[0], 'passage: 前缀与类型不一致', '以前缀参数为准归一化');
  await assert.rejects(() => service.embed(['query: '], { kind: 'query' }), error => error.code === 'invalid-input');
});

test('embedding: status exposes contract health vocabulary and ready flag', async () => {
  const extractor = createFakePipeline();
  const service = createEmbeddingService({ pipelineFactory: () => extractor });
  assert.equal(service.ready, false);
  assert.equal(service.status().status, 'loading');
  assert.equal(service.status().health, 'loading');
  await service.embed(['a']);
  assert.equal(service.ready, true);
  assert.equal(service.status().status, 'ok');
  assert.equal(service.status().ready, true);
});

test('embedding: real model smoke test is opt-in only', { skip: process.env.MOVA_TEST_REAL_EMBEDDING !== '1' }, async () => {
  const service = createEmbeddingService();
  const [document] = await service.embed(['Mova 使用 PostgreSQL 存储长期记忆。'], { kind: 'document' });
  const [query] = await service.embed(['数据库是什么'], { kind: 'query' });
  assert.equal(document.length, DEFAULT_DIM);
  assert.equal(query.length, DEFAULT_DIM);
  assert.notDeepEqual(document, query);
  await service.close();
});

// ------------------------------------------------------------------ indexer

test('indexer: memory chunks are whole records with source references preserved', () => {
  const text = '项目数据库使用 PostgreSQL。'.repeat(120);
  const chunks = buildChunks({
    sourceKind: 'memory',
    ownerId: OWNER,
    projectId: 'P1',
    id: '11111111-1111-5111-8111-111111111111',
    text,
    conversationId: '["CodeMova","P1","Chat"]',
    messageId: 'msg-1',
    eventId: 'event-1',
    kind: 'decision',
    status: 'active',
  });
  assert.equal(chunks.length, 1, '记忆整条索引，不切块');
  assert.equal(chunks[0].content, text);
  assert.equal(chunks[0].sourceKind, 'memory');
  assert.equal(chunks[0].sourceId, '11111111-1111-5111-8111-111111111111');
  assert.equal(chunks[0].projectId, 'P1');
  assert.equal(chunks[0].conversationId, '["CodeMova","P1","Chat"]');
  assert.equal(chunks[0].messageId, 'msg-1');
  assert.equal(chunks[0].eventId, 'event-1');
  assert.ok(chunks[0].contentNgrams.includes('数据'));

  assert.deepEqual(buildChunks({ sourceKind: 'memory', id: 'm', text, status: 'superseded' }), []);
});

test('indexer: messages split into ~800-1200 character chunks without losing content', () => {
  const sentence = '这是一段用于验证分块边界的中文测试内容，包含标点与数字 2026。';
  const text = Array.from({ length: 260 }, () => sentence).join('\n');
  assert.ok(text.length > 7000);
  const chunks = buildChunks({
    kind: 'message',
    ownerId: OWNER,
    projectId: 'P1',
    conversationId: 'conv-1',
    messageId: 'msg-9',
    eventId: 'event-9',
    role: 'user',
    text,
  });
  assert.ok(chunks.length >= 6, `应切成多块，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= CHUNK_MAX, `块长度 ${chunk.content.length} 超过 ${CHUNK_MAX}`);
    assert.equal(chunk.conversationId, 'conv-1');
    assert.equal(chunk.messageId, 'msg-9');
    assert.equal(chunk.eventId, 'event-9');
    assert.equal(chunk.sourceKind, 'message');
    assert.equal(chunk.sourceId, 'conv-1:msg-9');
    assert.ok(chunk.contentNgrams.length > 0);
  }
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.content.length >= 800, `非末尾块应接近 800 字符，实际 ${chunk.content.length}`);
  }
  assert.ok(chunks[chunks.length - 1].content.length > 0);
  assert.equal(chunks.map(chunk => chunk.content).join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  assert.deepEqual(chunks.map(chunk => chunk.chunkIndex), chunks.map((_, index) => index));
});

test('indexer: chunking never splits surrogate pairs and drops blank content', () => {
  const text = '😀🚀🧠'.repeat(900);
  const chunks = chunkText(text, { max: 1000 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk), '不能出现孤立高代理项');
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk), '不能出现孤立低代理项');
    assert.ok(chunk.length <= 1000);
  }
  assert.equal(chunks.join(''), text);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('indexer: mock/demo/tool/system/thinking/temporary/sensitive content is never indexed', () => {
  const base = { kind: 'message', conversationId: 'c1', messageId: 'm1', text: '普通内容' };
  assert.deepEqual(buildChunks({ ...base, temporary: true }), []);
  assert.deepEqual(buildChunks({ ...base, mock: true }), []);
  assert.deepEqual(buildChunks({ ...base, demo: true }), []);
  assert.deepEqual(buildChunks({ ...base, source: 'mock' }), []);
  assert.deepEqual(buildChunks({ ...base, role: 'tool' }), []);
  assert.deepEqual(buildChunks({ ...base, role: 'system' }), []);
  assert.deepEqual(buildChunks({ ...base, role: 'thinking' }), []);
  assert.deepEqual(buildChunks({ ...base, text: '我的密码是 hunter2，请记住' }), []);
  assert.deepEqual(buildChunks({ ...base, text: 'API key: sk-abcdefghijklmnop' }), []);
  assert.deepEqual(buildChunks({ ...base, text: '-----BEGIN RSA PRIVATE KEY----- abc' }), []);
  assert.deepEqual(buildChunks({ kind: 'memory', id: 'm', text: 'password: 123456' }), []);
  assert.throws(() => buildChunks({ ...base, projectId: '' }), error => error.code === 'invalid-input', '空 projectId 非法，不能当作全局');
});

test('indexer: toNgrams covers Chinese bigrams/trigrams, latin words and numbers', () => {
  const grams = toNgrams('本项目使用 PostgreSQL 16 数据库，2026-11-10 发布');
  assert.ok(grams.includes('本项'));
  assert.ok(grams.includes('项目'));
  assert.ok(grams.includes('本项目'), '三元组应包含 本项目');
  assert.ok(grams.includes('postgresql'));
  assert.ok(grams.includes('16'));
  assert.ok(grams.includes('2026'));
  assert.ok(grams.includes('11'));
  assert.ok(grams.includes('发布'));
  assert.equal(new Set(grams).size, grams.length, 'ngram 必须去重');
  assert.ok(toNgrams('中文'.repeat(400), { limit: 20 }).length <= 20);
  assert.deepEqual(toNgrams(''), []);
  assert.deepEqual(toNgrams(null), []);
  assert.deepEqual(toNgrams(42), []);
});

test('indexer: indexMemory upserts contract columns, is idempotent and keeps vectors out on failure', async () => {
  const pool = createFakePool(defaultIndexerHandler());
  const embedding = createFakeEmbedding();
  const indexer = createIndexer({ pool, embedding, ownerId: OWNER });
  const memory = {
    id: '22222222-2222-5222-8222-222222222222',
    projectId: 'P1',
    text: '本项目数据库使用 PostgreSQL 16。',
    conversationId: 'conv-1',
    messageId: 'msg-1',
  };
  const first = await indexer.indexMemory(memory);
  assert.equal(first.indexed, 1);
  assert.equal(first.embedded, 1);
  assert.equal(first.embeddingError, null);
  assert.equal(pool.calls[0].text.startsWith('delete from mova_search_chunks'), true);
  assert.deepEqual(pool.calls[0].params, [OWNER, 'memory', memory.id]);
  const insert = pool.calls[1];
  assert.match(insert.text, /^insert into mova_search_chunks/);
  assert.match(insert.text, /on conflict \(id\) do update/);
  assert.ok(!/\bfts\b/.test(insert.text), 'fts 是生成列，绝不能写入');
  assert.match(insert.text, /\$10::vector/);
  assert.match(insert.text, /\$9::text\[\]/);
  assert.match(insert.params[0], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(insert.params[1], OWNER);
  assert.equal(insert.params[2], 'P1');
  assert.equal(insert.params[3], 'conv-1');
  assert.equal(insert.params[4], 'msg-1');
  assert.equal(insert.params[5], 'memory');
  assert.equal(insert.params[6], memory.id);
  assert.equal(insert.params[7], memory.text);
  assert.ok(Array.isArray(insert.params[8]) && insert.params[8].includes('数据'));
  assert.match(insert.params[9], /^\[-?[\d.]+(,-?[\d.]+)*\]$/);
  assert.equal(insert.params[10], DEFAULT_MODEL);
  assert.equal(insert.params[11], 1);
  assert.equal(embedding.calls[0].options.kind, 'document');

  const _second = await indexer.indexMemory(memory);
  assert.equal(pool.calls[3].params[0], insert.params[0], '同一来源的分块 id 必须稳定');

  const broken = createIndexer({ pool, embedding: createFakeEmbedding({ error: new Error('model down') }), ownerId: OWNER });
  const degraded = await broken.indexMemory({ ...memory, text: '另一条记忆' });
  assert.equal(degraded.indexed, 1);
  assert.equal(degraded.embedded, 0);
  assert.equal(degraded.embeddingError.code, 'embedding-failed');
  const degradedInsert = pool.calls[pool.calls.length - 1];
  assert.equal(degradedInsert.params[9], null, '不得写入伪造向量');
  assert.equal(degradedInsert.params[10], null);

  const sensitive = await indexer.indexMemory({ id: '33333333-3333-5333-8333-333333333333', text: 'password: hunter2' });
  assert.equal(sensitive.indexed, 0);
  assert.equal(sensitive.skipped, 'sensitive-content');
});

test('indexer: indexMessage deletes the previous message chunks then inserts every chunk', async () => {
  const pool = createFakePool(defaultIndexerHandler());
  const indexer = createIndexer({ pool, embedding: createFakeEmbedding(), ownerId: OWNER });
  const text = '长消息内容。'.repeat(500);
  const result = await indexer.indexMessage({ conversationId: 'conv-7', messageId: 'msg-7', projectId: null, text });
  assert.ok(result.indexed > 1);
  assert.equal(result.embedded, result.indexed);
  assert.match(pool.calls[0].text, /^delete from mova_search_chunks/);
  assert.deepEqual(pool.calls[0].params, [OWNER, 'message', 'conv-7', 'msg-7']);
  const inserts = pool.calls.filter(call => call.text.startsWith('insert into'));
  assert.equal(inserts.length, result.indexed);
  for (const call of inserts) {
    assert.equal(call.params[3], 'conv-7');
    assert.equal(call.params[4], 'msg-7');
    assert.equal(call.params[2], null, '全局作用域写入 null');
  }

  const skipped = await indexer.indexMessage({ conversationId: 'conv-7', messageId: 'msg-8', text: '普通内容', temporary: true });
  assert.equal(skipped.indexed, 0);
  assert.equal(skipped.skipped, 'temporary');
});

test('indexer: deleteBySource refuses unsafe deletes and scopes by owner', async () => {
  const pool = createFakePool(() => ({ rowCount: 4, rows: [] }));
  const indexer = createIndexer({ pool, ownerId: OWNER });
  await assert.rejects(() => indexer.deleteBySource({ sourceKind: 'memory' }), error => error.code === 'invalid-input');
  await assert.rejects(() => indexer.deleteBySource({}), error => error.code === 'invalid-input');
  const removed = await indexer.deleteBySource({ sourceKind: 'memory', sourceId: 'm-1' });
  assert.equal(removed, 4);
  assert.match(pool.calls[0].text, /where owner_id = \$1::uuid/);
  assert.deepEqual(pool.calls[0].params, [OWNER, 'memory', 'm-1']);
  await indexer.deleteBySource({ sourceKind: 'message', conversationId: 'conv-1' });
  assert.match(pool.calls[1].text, /conversation_id = \$3/);
});

test('indexer: reindexAll clears owner index, rebuilds memories and session events, skips temporary conversations', async () => {
  const memoryBatches = [
    [
      { id: 'm-1', project_id: 'P1', text: '记忆一', kind: 'fact', status: 'active' },
      { id: 'm-2', project_id: null, text: '全局记忆二', kind: 'preference', status: 'active' },
    ],
    [],
  ];
  const eventBatches = [
    [{
      event_id: 'e-1',
      conversation_id: 'conv-1',
      type: 'message',
      role: 'user',
      project_id: 'P1',
      content: { user: '用户问题', reply: { text: '助手回答' }, attempts: [{ text: '忽略重试副本' }] },
    }],
    [],
  ];
  let memoryIndex = 0;
  let eventIndex = 0;
  const pool = createFakePool(text => {
    if (/^\s*delete from mova_search_chunks/i.test(text)) return { rowCount: 7, rows: [] };
    if (/from mova_memories/i.test(text)) return { rowCount: 0, rows: memoryBatches[memoryIndex++] ?? [] };
    if (/from mova_session_events/i.test(text)) return { rowCount: 0, rows: eventBatches[eventIndex++] ?? [] };
    if (/^\s*insert into mova_search_chunks/i.test(text)) return { rowCount: 1, rows: [] };
    throw new Error(`unexpected SQL: ${text.slice(0, 40)}`);
  });
  const indexer = createIndexer({ pool, embedding: createFakeEmbedding(), ownerId: OWNER });
  const summary = await indexer.reindexAll({ batchSize: 2 });
  assert.equal(summary.deleted, 7);
  assert.equal(summary.memories, 2);
  assert.equal(summary.messages, 2, '用户消息 + 助手回复各一条');
  assert.equal(summary.chunks, 4);
  assert.equal(summary.embedded, 4);
  assert.equal(summary.failed, 0);
  const selectSql = pool.calls.map(call => call.text);
  const memorySql = selectSql.find(text => /from mova_memories/i.test(text));
  const eventSql = selectSql.find(text => /from mova_session_events/i.test(text));
  assert.match(memorySql, /owner_id = \$1::uuid/);
  assert.match(memorySql, /status = 'active'/);
  assert.match(eventSql, /c\.temporary = false/);
  assert.match(eventSql, /e\.type = 'message'/);
  assert.ok(summary.tookMs >= 0);
});

test('indexer: a failed insert rolls the transaction back', async () => {
  const clientCalls = [];
  let released = false;
  const client = {
    async query(text, params) {
      clientCalls.push({ text, params });
      if (/^insert into/.test(text.trim())) throw new Error('insert failed');
      return { rowCount: 0, rows: [] };
    },
    release() { released = true; },
  };
  const pool = {
    async query() { throw new Error('pool.query must not be used when connect() exists'); },
    async connect() { return client; },
  };
  const indexer = createIndexer({ pool, embedding: createFakeEmbedding(), ownerId: OWNER });
  await assert.rejects(() => indexer.indexMemory({ id: 'm-9', text: '事务测试' }), /insert failed/);
  const statements = clientCalls.map(call => call.text.trim());
  assert.equal(statements[0], 'begin');
  assert.ok(statements.some(text => text.startsWith('delete from mova_search_chunks')));
  assert.ok(statements.includes('rollback'));
  assert.ok(!statements.includes('commit'));
  assert.equal(released, true);
});

test('indexer: uuidFromHash is deterministic and version-5 shaped', () => {
  const first = uuidFromHash('owner|memory|m-1|0|model');
  const second = uuidFromHash('owner|memory|m-1|0|model');
  assert.equal(first, second);
  assert.notEqual(first, uuidFromHash('owner|memory|m-1|1|model'));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
