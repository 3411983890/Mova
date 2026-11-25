import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createHybridSearch,
  rrfFuse,
  DEFAULT_RRF_K,
} = require('../electron/services/hybrid-search.cjs');
const { DEFAULT_OWNER_ID } = require('../electron/services/indexer.cjs');

const OWNER = DEFAULT_OWNER_ID;
const MODEL = 'Xenova/multilingual-e5-small';
const DIM = 384;

function deterministicVector(seed = 1) {
  const vector = new Array(DIM);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < DIM; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    vector[index] = (state / 0xffffffff) * 2 - 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map(value => value / norm);
}

function memoryRow(overrides = {}) {
  return {
    id: 'chunk-mem-1',
    owner_id: OWNER,
    project_id: 'P1',
    conversation_id: 'conv-1',
    message_id: 'msg-1',
    source_kind: 'memory',
    source_id: '9f9f9f9f-9f9f-5f9f-8f9f-9f9f9f9f9f9f',
    content: '项目数据库使用 PostgreSQL 16。',
    created_at: '2026-01-01T00:00:00.000Z',
    fts_rank: 0.2,
    ngram_hits: 4,
    ...overrides,
  };
}

function messageRow(overrides = {}) {
  return {
    id: 'chunk-msg-1',
    owner_id: OWNER,
    project_id: 'P1',
    conversation_id: 'conv-1',
    message_id: 'msg-1',
    source_kind: 'message',
    source_id: 'conv-1:msg-1',
    content: '我们在项目里把数据库换成了 PostgreSQL。',
    created_at: '2026-01-02T00:00:00.000Z',
    fts_rank: 0.1,
    ngram_hits: 2,
    ...overrides,
  };
}

function createFakePool(options = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('<=>')) return { rows: options.vector || [] };
      if (text.includes('from mova_search_chunks')) return { rows: options.keyword || [] };
      throw new Error(`unexpected SQL: ${text.slice(0, 60)}`);
    },
  };
  return pool;
}

function createFakeEmbedding(options = {}) {
  const calls = [];
  const state = options.state || 'ok';
  const embedding = {
    model: MODEL,
    calls,
    async embed(texts, embedOptions) {
      calls.push({ texts: [...texts], options: embedOptions });
      if (options.error) throw options.error;
      return texts.map((text, index) => deterministicVector(index + 11));
    },
    status() {
      return {
        state,
        model: MODEL,
        dim: DIM,
        lastError: options.statusError ? { code: 'model-load-failed', message: options.statusError } : null,
      };
    },
  };
  return embedding;
}

function build(options = {}) {
  const pool = options.pool || createFakePool();
  const embedding = options.embedding === undefined ? createFakeEmbedding() : options.embedding;
  return { pool, embedding, search: createHybridSearch({ pool, embedding, settings: options.settings, ownerId: OWNER }) };
}

// --------------------------------------------------------------- rrfFuse

test('rrf: default k=60 and 0.5/0.5 weights fuse both channels by rank', () => {
  const fused = rrfFuse({ keyword: [{ key: 'a' }, { key: 'b' }], vector: [{ key: 'b' }, { key: 'c' }] });
  assert.deepEqual(fused.map(entry => entry.key), ['b', 'a', 'c']);
  assert.ok(Math.abs(fused[0].score - (0.5 / 62 + 0.5 / 61)) < 1e-12);
  assert.ok(Math.abs(fused[1].score - 0.5 / 61) < 1e-12);
  assert.ok(Math.abs(fused[2].score - 0.5 / 62) < 1e-12);
  assert.equal(fused[0].keywordRank, 2);
  assert.equal(fused[0].vectorRank, 1);
  assert.deepEqual(fused[0].channels, ['keyword', 'vector']);
  assert.equal(DEFAULT_RRF_K, 60);
});

test('rrf: weights and k are configurable, zero-weight channel contributes nothing', () => {
  const keywordOnly = rrfFuse({ keyword: [{ key: 'a' }], vector: [{ key: 'b' }], keywordWeight: 1, vectorWeight: 0 });
  assert.equal(keywordOnly[0].key, 'a');
  assert.equal(keywordOnly[0].score, 1 / 61);
  assert.ok(Math.abs(keywordOnly[1].score) < 1e-12);

  const custom = rrfFuse({ keyword: [{ key: 'a' }], keywordWeight: 2, vectorWeight: 0, k: 0 });
  assert.equal(custom[0].score, 2);

  assert.throws(() => rrfFuse({ keyword: [{ key: 'a' }], keywordWeight: 0, vectorWeight: 0 }), error => error.code === 'invalid-settings');
  assert.throws(() => rrfFuse({ keyword: [{ key: 'a' }], keywordWeight: -1 }), error => error.code === 'invalid-settings');
  assert.throws(() => rrfFuse({ keyword: 'nope' }), error => error.code === 'invalid-input');
});

test('rrf: duplicate keys across channels merge into one entry with combined score', () => {
  const fused = rrfFuse({
    keyword: [{ key: 'same', content: 'k' }],
    vector: [{ key: 'same', content: 'v' }],
  });
  assert.equal(fused.length, 1);
  assert.ok(Math.abs(fused[0].score - (0.5 / 61 + 0.5 / 61)) < 1e-12);
  assert.equal(fused[0].content, 'k');
  assert.deepEqual(fused[0].channels, ['keyword', 'vector']);
});

// ------------------------------------------------------------ hybrid search

test('hybrid: fuses keyword and vector rows into renderer-compatible memory and session hits', async () => {
  const keyword = [
    memoryRow(),
    messageRow({ id: 'chunk-msg-1', conversation_id: 'conv-1', message_id: 'msg-1', source_id: 'conv-1:msg-1' }),
  ];
  const vector = [
    messageRow({ id: 'chunk-msg-2', conversation_id: 'conv-1', message_id: 'msg-2', source_id: 'conv-1:msg-2', content: '语义命中的另一条消息', similarity: 0.91 }),
    memoryRow({ id: 'chunk-mem-1', similarity: 0.82 }),
  ];
  const { search, pool: _pool, embedding } = build({ pool: createFakePool({ keyword, vector }) });
  const meta = await search.searchWithMeta({ query: '数据库用的什么', projectId: 'P1' });

  assert.equal(meta.mode, 'hybrid');
  assert.equal(meta.degraded, false);
  assert.equal(meta.semantic, true);
  assert.equal(meta.counts.keyword, 2);
  assert.equal(meta.counts.vector, 2);
  assert.equal(meta.hits.length, 3, '同一条记忆/消息只返回一次');
  assert.deepEqual(meta.hits.map(hit => hit.kind).sort(), ['memory', 'session', 'session']);

  const memory = meta.hits.find(hit => hit.kind === 'memory');
  assert.equal(memory.id, '9f9f9f9f-9f9f-5f9f-8f9f-9f9f9f9f9f9f', '记忆命中 id 必须是记忆 id');
  assert.equal(memory.projectId, 'P1');
  assert.equal(memory.text, '项目数据库使用 PostgreSQL 16。');
  assert.equal(memory.chunkId, 'chunk-mem-1');

  const session = meta.hits.find(hit => hit.messageId === 'msg-2');
  assert.equal(session.kind, 'session');
  assert.equal(session.id, 'conv-1:msg-2');
  assert.equal(session.conversationId, 'conv-1');
  assert.equal(session.messageId, 'msg-2');
  assert.equal(session.projectId, 'P1');
  assert.equal(session.text, '语义命中的另一条消息');
  assert.equal(session.chunkId, 'chunk-msg-2');

  for (const hit of meta.hits) {
    assert.equal(typeof hit.score, 'number');
    assert.ok(hit.score > 0);
    assert.ok(Array.isArray(hit.channels) && hit.channels.length >= 1);
  }
  for (let index = 1; index < meta.hits.length; index += 1) {
    assert.ok(meta.hits[index - 1].score >= meta.hits[index].score, '命中必须按融合分降序');
  }
  assert.deepEqual(embedding.calls[0].options, { kind: 'query' }, '查询必须使用 e5 query 前缀类型');
  assert.equal(embedding.calls[0].texts[0], '数据库用的什么');
});

test('hybrid: owner/project filters live in SQL; allProjects is explicit and never widens scope silently', async () => {
  const projectUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const cases = [
    { name: 'project uuid only', input: { projectId: projectUuid, includeGlobal: false }, expectProjectParam: projectUuid, expectGlobalClause: false, expectUuidCast: true },
    { name: 'project uuid + global', input: { projectId: projectUuid, includeGlobal: true }, expectProjectParam: projectUuid, expectGlobalClause: true, expectUuidCast: true },
    { name: 'project name (renderer form)', input: { projectId: 'QA预览', includeGlobal: false }, expectProjectParam: 'QA预览', expectGlobalClause: false, expectNameLookup: true },
    { name: 'global only', input: { projectId: null, includeGlobal: true }, expectProjectParam: null, expectGlobalClause: false },
    { name: 'all projects', input: { allProjects: true }, expectProjectParam: null, expectGlobalClause: false, expectOwnerOnly: true },
  ];
  for (const scenario of cases) {
    const { search, pool } = build();
    await search.searchWithMeta({ query: '数据库', ...scenario.input });
    const keywordCall = pool.calls.find(call => !call.text.includes('<=>'));
    assert.ok(keywordCall, `${scenario.name}: 必须执行关键词 SQL`);
    assert.match(keywordCall.text, /c\.owner_id = \$1::uuid/, `${scenario.name}: owner 过滤必须在 SQL 层`);
    assert.equal(keywordCall.params[0], OWNER);
    if (scenario.expectOwnerOnly) {
      assert.ok(!keywordCall.text.includes('c.project_id ='), 'allProjects 不能添加项目过滤');
      assert.ok(!keywordCall.text.includes('p.name ='), 'allProjects 不能按项目名过滤');
      assert.ok(!keywordCall.params.includes('P1'), 'allProjects 不能携带项目参数');
    } else if (scenario.expectProjectParam) {
      assert.ok(keywordCall.params.includes(scenario.expectProjectParam), '项目过滤必须是 SQL 参数');
    }
    if (scenario.expectUuidCast) {
      assert.match(keywordCall.text, /c\.project_id = \$2::uuid/, 'uuid 项目直接按 project_id 过滤');
    }
    if (scenario.expectNameLookup) {
      assert.match(keywordCall.text, /c\.project_id in \(select p\.id from mova_projects p/, '项目名通过 (owner_id,name) 反查');
      assert.match(keywordCall.text, /p\.owner_id = \$1::uuid/);
      assert.match(keywordCall.text, /p\.name = \$2/);
    }
    const globalClause = keywordCall.text.includes('or c.project_id is null');
    assert.equal(globalClause, scenario.expectGlobalClause, `${scenario.name}: includeGlobal 子句`);
    if (!scenario.expectGlobalClause && !scenario.expectProjectParam && !scenario.expectOwnerOnly) {
      assert.ok(keywordCall.text.includes('c.project_id is null'));
    }
    // 临时会话守卫始终存在（双重保险）
    assert.match(keywordCall.text, /cv\.temporary/, `${scenario.name}: 临时会话不得检索`);
    const vectorCall = pool.calls.find(call => call.text.includes('<=>'));
    assert.match(vectorCall.text, /c\.owner_id = \$1::uuid/, `${scenario.name}: 向量通道同样按 owner 过滤`);
    assert.match(vectorCall.text, /c\.embedding_model = \$/, `${scenario.name}: 向量通道限定 embedding_model`);
  }
});

test('hybrid: semantic off runs keyword SQL only and never calls the embedding', async () => {
  const { search, pool, embedding } = build({
    pool: createFakePool({ keyword: [memoryRow()] }),
    settings: { semanticSearch: false, keywordWeight: 0.5, vectorWeight: 0.5 },
  });
  const meta = await search.searchWithMeta({ query: '数据库', projectId: 'P1' });
  assert.equal(meta.mode, 'keyword');
  assert.equal(meta.degraded, false);
  assert.equal(meta.error, null);
  assert.equal(meta.semantic, false);
  assert.equal(pool.calls.length, 1, '语义关闭时只跑关键词通道');
  assert.equal(embedding.calls.length, 0);
  assert.equal(meta.hits.length, 1);
  assert.equal(meta.hits[0].kind, 'memory');
});

test('hybrid: embedding failure falls back to keyword hits and reports degraded', async () => {
  const { search, pool } = build({
    pool: createFakePool({ keyword: [memoryRow(), messageRow()] }),
    embedding: createFakeEmbedding({ error: new Error('model file not downloaded') }),
  });
  const meta = await search.searchWithMeta({ query: '数据库', projectId: 'P1' });
  assert.equal(meta.mode, 'keyword');
  assert.equal(meta.degraded, true);
  assert.match(meta.error, /model file not downloaded/);
  assert.equal(meta.hits.length, 2, '降级后仍返回关键词命中');
  assert.equal(pool.calls.length, 1, '不执行向量 SQL');
  assert.ok(pool.calls[0].text.includes('content_ngrams &&'));
});

test('hybrid: embedding down is detected without attempting a model call', async () => {
  const embedding = createFakeEmbedding({ state: 'down', statusError: '模型尚未下载（首次下载失败）' });
  const { search } = build({ pool: createFakePool({ keyword: [messageRow()] }), embedding });
  const meta = await search.searchWithMeta({ query: '数据库', projectId: 'P1' });
  assert.equal(meta.mode, 'keyword');
  assert.equal(meta.degraded, true);
  assert.equal(meta.embeddingState, 'down');
  assert.match(meta.error, /模型尚未下载/);
  assert.equal(embedding.calls.length, 0, '状态为 down 时不应再次触发下载');
  assert.equal(meta.hits.length, 1);
});

test('hybrid: keyword and vector weights come from settings and can be overridden per query', async () => {
  const { search } = build({
    pool: createFakePool({ keyword: [memoryRow()], vector: [messageRow({ id: 'chunk-msg-9', message_id: 'msg-9' })] }),
    settings: { hybrid: { keywordWeight: 1, vectorWeight: 0, k: 5 } },
  });
  const fromSettings = await search.searchWithMeta({ query: '数据库', projectId: 'P1' });
  assert.deepEqual(fromSettings.weights, { keywordWeight: 1, vectorWeight: 0, k: 5 });
  assert.equal(fromSettings.hits.length, 1, '权重为 0 的通道不贡献命中');
  assert.equal(fromSettings.hits[0].kind, 'memory');

  const overridden = await search.searchWithMeta({ query: '数据库', projectId: 'P1', keywordWeight: 0.2, vectorWeight: 0.8, k: 60 });
  assert.deepEqual(overridden.weights, { keywordWeight: 0.2, vectorWeight: 0.8, k: 60 });
  assert.equal(overridden.hits.length, 2);
  assert.equal(overridden.hits[0].messageId, 'msg-9', '向量权重更高时应由向量通道命中排前');
});

test('hybrid: empty query returns no hits and executes no SQL', async () => {
  const { search, pool } = build();
  const meta = await search.searchWithMeta({ query: '   ', projectId: 'P1' });
  assert.deepEqual(meta.hits, []);
  assert.equal(meta.mode, 'empty');
  assert.equal(pool.calls.length, 0);
  assert.deepEqual(await search.search({}), []);
});

test('hybrid: keyword SQL uses tsvector + ngrams + trigram fallback, scoped and bounded', async () => {
  const { search, pool } = build({ pool: createFakePool({ keyword: [memoryRow()] }) });
  await search.searchWithMeta({ query: '项目数据库 PostgreSQL', projectId: 'P1', limit: 30 });
  const keyword = pool.calls[0];
  const ftsCall = keyword.text.match(/ts_rank_cd\(c\.fts, plainto_tsquery\('simple', \$(\d+)\)\)/);
  const ngramClause = keyword.text.match(/c\.content_ngrams && \$(\d+)::text\[\]/);
  const likeClause = keyword.text.match(/c\.content ilike \$(\d+)/);
  assert.ok(ftsCall && ngramClause && likeClause, '关键词 SQL 必须包含 tsvector、ngram 与 ilike 兜底');
  const queryIndex = Number(ftsCall[1]);
  const ngramIndex = Number(ngramClause[1]);
  const likeIndex = Number(likeClause[1]);
  assert.ok(keyword.text.includes(`c.fts @@ plainto_tsquery('simple', $${queryIndex})`));
  assert.equal(keyword.params[queryIndex - 1], '项目数据库 PostgreSQL');
  const tokens = keyword.params[ngramIndex - 1];
  assert.ok(Array.isArray(tokens));
  assert.ok(tokens.includes('数据'));
  assert.ok(tokens.includes('postgresql'));
  assert.equal(keyword.params[likeIndex - 1], '%项目数据库 PostgreSQL%');
  assert.equal(keyword.params[keyword.params.length - 1], 120, 'topK = limit * 4');
  assert.equal(keyword.params[0], OWNER);

  await search.searchWithMeta({ query: 'x', projectId: 'P1', limit: 3 });
  const limited = pool.calls[pool.calls.length - 2];
  assert.equal(limited.params[limited.params.length - 1], 50, '最小候选集为 50');
});

test('hybrid: invalid scope and weights are rejected before any SQL runs', async () => {
  const { search, pool } = build();
  await assert.rejects(() => search.search({ query: 'x', projectId: '' }), error => error.code === 'invalid-input');
  await assert.rejects(() => search.search({ query: 'x', projectId: 'P1', limit: 0 }), error => error.code === 'invalid-input');
  await assert.rejects(() => search.search({ query: 'x', projectId: 'P1', limit: 101 }), error => error.code === 'invalid-input');
  await assert.rejects(() => search.search({ query: 'x', projectId: 'P1', keywordWeight: -2 }), error => error.code === 'invalid-settings');
  await assert.rejects(() => search.search({ query: 'x', projectId: 'P1', kinds: ['wat'] }), error => error.code === 'invalid-input');
  assert.equal(pool.calls.length, 0);
});

test('hybrid: temporary chats never search; includeSessions narrows kinds in SQL', async () => {
  const temporary = build();
  const meta = await temporary.search.searchWithMeta({ query: '数据库', projectId: 'P1', temporary: true });
  assert.deepEqual(meta.hits, []);
  assert.equal(meta.mode, 'temporary');
  assert.equal(temporary.pool.calls.length, 0, '临时聊天不得触发任何检索');

  const { search, pool } = build({ pool: createFakePool({ keyword: [memoryRow()] }), settings: { semanticSearch: false } });
  await search.searchWithMeta({ query: '数据库', projectId: 'P1', includeSessions: false });
  const kindClause = pool.calls[0].text.match(/c\.source_kind = any\(\$(\d+)::text\[\]\)/);
  assert.ok(kindClause, 'kinds 过滤必须下推到 SQL');
  assert.deepEqual(pool.calls[0].params[Number(kindClause[1]) - 1], ['memory']);
});

test('hybrid: search() returns a plain hit array; settings may be an async provider', async () => {
  const { search } = build({
    pool: createFakePool({ keyword: [memoryRow()] }),
    settings: async () => ({ semanticSearch: false, searchLimit: 5 }),
  });
  const hits = await search.search({ query: '数据库', projectId: 'P1' });
  assert.ok(Array.isArray(hits));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'memory');
  assert.equal(hits[0].projectId, 'P1');
});
