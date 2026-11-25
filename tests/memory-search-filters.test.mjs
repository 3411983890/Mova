/**
 * memory_search 的 P1 过滤维度（kind / after / before / origin / projectId / includeArchived）。
 *
 * 三层都测：
 * 1) 纯函数 `filterHits(hits, filters)`（单独可测，零 IO）；
 * 2) 检索闭包（createAgentMemorySearch）：过滤真的生效、`includeArchived` 只在下游要它时才传到仓储、
 *    **不传参数时仓储入参与改造前逐字一致**；
 * 3) handler：合法值归一后下传，非法值一律 `invalid_arguments`（including 非法时间）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

import { createHandlers } from '../electron/skills/packs/memory/handlers.mjs';

const require = createRequire(import.meta.url);
const { createAgentMemorySearch, filterHits } = require('../electron/services/agent-memory-search.cjs');

function textOf(result) {
  const part = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text') : null;
  return typeof part?.text === 'string' ? part.text : '';
}

function payloadOf(result) {
  try {
    return JSON.parse(textOf(result));
  } catch {
    return null;
  }
}

const HITS = Object.freeze([
  Object.freeze({ kind: 'memory', id: 'f1', memoryKind: 'fact', text: '项目用 Node 24', projectId: 'Alpha', source: 'user', updatedAt: '2026-01-10T00:00:00.000Z' }),
  Object.freeze({ kind: 'memory', id: 'p1', memoryKind: 'preference', text: '提交信息用中文', projectId: 'Alpha', source: 'user', updatedAt: '2026-03-20T00:00:00.000Z' }),
  Object.freeze({ kind: 'memory', id: 'd1', memoryKind: 'decision', text: '数据库用 PostgreSQL', projectId: 'Beta', source: 'automatic', updatedAt: '2026-06-01T00:00:00.000Z' }),
  Object.freeze({ kind: 'memory', id: 'a1', memoryKind: 'note', text: '旧方案：用 SQLite', projectId: 'Alpha', source: 'automatic', updatedAt: '2025-12-01T00:00:00.000Z', archived: true, status: 'disabled' }),
  Object.freeze({ kind: 'session', id: 'chat:1', text: '聊过数据库选型', projectId: 'Alpha' }),
]);

const idsOf = hits => (Array.isArray(hits) ? hits.map(hit => hit.id) : []);

/* ── 1) 纯函数 filterHits ─────────────────────────────────────────── */

test('filterHits：不传任何过滤时原样返回（同一个数组引用），会话命中也不动', () => {
  assert.equal(filterHits(HITS), HITS, '不传过滤必须原样返回');
  assert.equal(filterHits(HITS, {}), HITS);
  assert.equal(filterHits(HITS, undefined), HITS);
  assert.deepEqual(idsOf(filterHits(HITS, {})), ['f1', 'p1', 'd1', 'a1', 'chat:1']);
});

test('filterHits：kind 过滤（只返回记忆条目，会话命中不再混进来）', () => {
  assert.deepEqual(idsOf(filterHits(HITS, { kind: 'preference' })), ['p1']);
  assert.deepEqual(idsOf(filterHits(HITS, { kind: 'fact' })), ['f1']);
  assert.deepEqual(idsOf(filterHits(HITS, { kind: 'note' })), [], 'note 只有归档那条，默认不返回');
});

test('filterHits：时间范围（毫秒与 ISO 都接受，闭区间）', () => {
  // 只留 2026 年内的（2025-12-01 那条归档旧条目被排在区间外）
  assert.deepEqual(idsOf(filterHits(HITS, { after: '2026-01-01' })), ['f1', 'p1', 'd1']);
  assert.deepEqual(idsOf(filterHits(HITS, { before: '2026-02-01T00:00:00.000Z' })), ['f1']);
  assert.deepEqual(idsOf(filterHits(HITS, { after: Date.parse('2026-02-01'), before: Date.parse('2026-04-01') })), ['p1']);
  // 闭区间：边界值本身要留下
  assert.deepEqual(idsOf(filterHits(HITS, { after: Date.parse('2026-03-20T00:00:00.000Z') })), ['p1', 'd1']);
});

test('filterHits：origin（manual ↔ source user，automatic ↔ source automatic）', () => {
  assert.deepEqual(idsOf(filterHits(HITS, { origin: 'manual' })), ['f1', 'p1']);
  assert.deepEqual(idsOf(filterHits(HITS, { origin: 'automatic' })), ['d1']);
});

test('filterHits：projectId 精确匹配（不许跨项目）', () => {
  assert.deepEqual(idsOf(filterHits(HITS, { projectId: 'Alpha' })), ['f1', 'p1']);
  assert.deepEqual(idsOf(filterHits(HITS, { projectId: 'Gamma' })), []);
});

test('filterHits：includeArchived 默认隐藏归档，true 时才放行', () => {
  assert.deepEqual(idsOf(filterHits(HITS, { kind: 'note' })), [], '默认看不到归档条目');
  assert.deepEqual(idsOf(filterHits(HITS, { kind: 'note', includeArchived: true })), ['a1']);
  assert.deepEqual(idsOf(filterHits(HITS, { includeArchived: true })), ['f1', 'p1', 'd1', 'a1'],
    'includeArchived:true 只是放行归档，不会放行会话命中');
});

test('filterHits：组合过滤 + 非法时间值 → 空结果（绝不静默放过）', () => {
  assert.deepEqual(idsOf(filterHits(HITS, { kind: 'fact', projectId: 'Alpha', origin: 'manual', after: '2026-01-01' })), ['f1']);
  assert.deepEqual(filterHits(HITS, { after: 'not-a-date' }), []);
  assert.deepEqual(filterHits(HITS, { before: -1 }), []);
});

/* ── 2) 检索闭包：过滤生效 + 入参不漂移 ───────────────────────────── */

function fakeRepository({ hits = [], settings = { memoryEnabled: true }, history = [] } = {}) {
  const calls = [];
  return {
    calls,
    repository: {
      settings: async () => settings,
      async search(input) {
        calls.push(input);
        return input.includeSessions === true ? history : hits;
      },
      async readHistorySource() { return { messages: [] }; },
    },
  };
}

test('检索闭包：不过滤时仓储入参与改造前逐字一致，且仍然回退聊天历史', async () => {
  const { repository, calls } = fakeRepository({ hits: [], history: [
    { kind: 'session', conversationId: 'c1', messageId: 'turn-1', projectId: 'Alpha', role: 'user', text: '保留参数 30 Mbps' },
  ] });
  const search = createAgentMemorySearch(repository, { memoryScope: { projectId: 'Alpha', includeGlobal: true } }, true);
  const hits = await search({ query: '30 Mbps' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'session');
  assert.deepEqual(calls[0], {
    query: '30 Mbps', projectId: 'Alpha', includeGlobal: true, allProjects: false, includeSessions: false, limit: 8,
  }, '不传过滤时入参不许出现新键');
  assert.equal(calls[1].includeSessions, true, '零命中时照旧回退历史');
});

test('检索闭包：带过滤时先多取再裁，且不再回退聊天历史', async () => {
  // 闭包自身按请求的 memoryScope 收范围：这里的命中全部属于 Alpha（Beta 的条目根本不该出现）。
  const scopedHits = [
    { kind: 'memory', id: 'f1', memoryKind: 'fact', text: '项目用 Node 24', projectId: 'Alpha', source: 'user', updatedAt: '2026-01-10T00:00:00.000Z' },
    { kind: 'memory', id: 'd2', memoryKind: 'decision', text: '数据库用 PostgreSQL', projectId: 'Alpha', source: 'user', updatedAt: '2026-05-01T00:00:00.000Z' },
  ];
  const { repository, calls } = fakeRepository({ hits: scopedHits });
  const search = createAgentMemorySearch(repository, { memoryScope: { projectId: 'Alpha', includeGlobal: true } }, true);
  const hits = await search({ query: '数据库', limit: 4, kind: 'decision', projectId: 'Alpha' });
  assert.deepEqual(idsOf(hits), ['d2']);
  assert.equal(calls.length, 1, '带过滤时不回退历史（历史命中没有 kind/时间字段，回退结果无法满足过滤）');
  assert.equal(calls[0].limit, 12, '过滤是后置的，先多取 3 倍（4 × 3）');
  assert.equal('includeArchived' in calls[0], false, '没要归档就别把 includeArchived 塞给仓储');
});

test('检索闭包：includeArchived:true 才把开关传给仓储，归档条目带 archived 标记返回', async () => {
  const { repository, calls } = fakeRepository({ hits: HITS.filter(hit => hit.kind === 'memory') });
  const search = createAgentMemorySearch(repository, { memoryScope: { projectId: 'Alpha', includeGlobal: true } }, true);
  const hits = await search({ query: '旧方案', includeArchived: true, kind: 'note' });
  assert.equal(calls[0].includeArchived, true);
  assert.deepEqual(idsOf(hits), ['a1']);
  assert.equal(hits[0].archived, true);
});

/* ── 3) handler：合法值下传、非法值 invalid_arguments ─────────────── */

function fakeMemorySearch(hits = []) {
  const calls = [];
  const fn = async input => { calls.push(input); return hits; };
  return { fn, calls };
}

test('handler：合法的 kind / 时间 / origin / projectId / includeArchived 原样（时间归一成毫秒）下传', async () => {
  const { fn, calls } = fakeMemorySearch([{
    kind: 'memory', id: 'p1', memoryKind: 'preference', text: '提交信息用中文',
    projectId: 'Alpha', source: 'user', updatedAt: '2026-03-20T00:00:00.000Z',
  }]);
  const handlers = createHandlers({ memorySearch: fn });
  const result = await handlers.memory_search({
    query: '提交信息', kind: 'preference', origin: 'manual', projectId: 'Alpha',
    after: '2026-01-01', before: 1893456000000, includeArchived: true,
  }, { callId: 'mcp-50' });

  assert.equal(result.isError, undefined);
  const payload = payloadOf(result);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, 'p1');
  assert.equal(payload[0].kind, 'preference', '命中要带 kind（模型据此决定 update 还是 supersede）');
  assert.equal(payload[0].updatedAt, '2026-03-20T00:00:00.000Z', '命中要带 updatedAt（时效性判断）');

  const input = calls[0];
  assert.deepEqual(input, {
    query: '提交信息', scope: 'current', limit: 8, source: 'auto',
    kind: 'preference', after: Date.parse('2026-01-01'), before: 1893456000000,
    origin: 'manual', projectId: 'Alpha', includeArchived: true,
  });
});

test('handler：不传过滤参数时底层入参与改造前逐字一致', async () => {
  const { fn, calls } = fakeMemorySearch([]);
  const handlers = createHandlers({ memorySearch: fn });
  await handlers.memory_search({ query: '参数', limit: 5 }, {});
  assert.deepEqual(calls[0], { query: '参数', scope: 'current', limit: 5, source: 'auto' });
});

test('handler：非法过滤值一律 invalid_arguments，且不发起检索', async () => {
  const { fn, calls } = fakeMemorySearch([]);
  const handlers = createMemoryHandlersFor(fn);
  const cases = [
    [{ query: 'q', kind: 'secret' }, /kind/],
    [{ query: 'q', origin: 'robot' }, /origin/],
    [{ query: 'q', after: 'not-a-date' }, /after/],
    [{ query: 'q', before: '' }, null], // 空字符串等同不传，合法
    [{ query: 'q', after: 'yesterday-ish' }, /after/],
    [{ query: 'q', after: '2026-06-01', before: '2026-01-01' }, /after 不能晚于 before/],
    [{ query: 'q', projectId: 42 }, /projectId/],
    [{ query: 'q', includeArchived: 'yes' }, /includeArchived/],
  ];
  for (const [args, pattern] of cases) {
    const result = await handlers.memory_search(args, {});
    if (!pattern) {
      assert.equal(payloadOf(result)?.error, undefined, `合法参数不该被拒：${JSON.stringify(args)}`);
      continue;
    }
    const payload = payloadOf(result);
    assert.equal(payload?.error, 'invalid_arguments', `非法参数必须 invalid_arguments：${JSON.stringify(args)}`);
    assert.match(payload.message, pattern);
  }
  // 空字符串 before 是合法的 → 唯一一次真正的检索（不带 before）
  assert.equal(calls.length, 1);
  assert.equal('before' in calls[0], false);
});

function createMemoryHandlersFor(fn) {
  return createHandlers({ memorySearch: fn });
}
