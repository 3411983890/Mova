import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mergeCandidates,
  rankCandidates,
  selectWithinBudget,
  shouldInject,
  estimateTokens,
  toQueryTokens,
  lexicalOverlap,
  DEFAULT_WEIGHTS,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_SCORE,
} = require('../electron/services/memory-retrieval.cjs');

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days, base = NOW) =>
  new Date(base - days * DAY).toISOString();

const ids = ranked => ranked.map(item => item.id);

// ------------------------------------------------------------------ 合并

test('merge: keyword + semantic + recent + pinned 按 id 去重，保留通道与最佳分', () => {
  const input = {
    pinned: [{ id: 'm-b', text: '前端用 Tailwind', pinned: true }],
    recent: [{ id: 'm-c', text: '部署脚本放在 scripts 目录' }],
    semantic: [
      { id: 'm-a', text: '项目数据库使用 PostgreSQL 16', score: 0.82, semanticScore: 0.82 },
      { id: 'm-c', text: '部署脚本放在 scripts 目录', score: 0.71 },
    ],
    keyword: [
      { id: 'm-a', text: '项目数据库使用 PostgreSQL 16', score: 3 },
      { id: 'm-b', text: '前端用 Tailwind', score: 1 },
    ],
  };
  const snapshot = structuredClone(input);
  const merged = mergeCandidates(input);

  assert.equal(merged.length, 3, '同一 id 只保留一条');
  assert.deepEqual(ids(merged), ['m-b', 'm-c', 'm-a'], '按通道顺序稳定插入');
  assert.equal(new Set(ids(merged)).size, merged.length, '不得出现重复 id');

  const a = merged.find(item => item.id === 'm-a');
  assert.deepEqual(a.channels, ['semantic', 'keyword']);
  assert.deepEqual(a.scores, { pinned: null, recent: null, semantic: 0.82, keyword: 3 });
  assert.equal(a.score, 3, 'score 取通道最佳分');
  assert.equal(a.text, '项目数据库使用 PostgreSQL 16');

  const b = merged.find(item => item.id === 'm-b');
  assert.deepEqual(b.channels, ['pinned', 'keyword']);
  assert.equal(b.pinned, true, '后续通道不会覆盖 pinned 标记');
  assert.deepEqual(b.scores, { pinned: null, recent: null, semantic: null, keyword: 1 });

  const c = merged.find(item => item.id === 'm-c');
  assert.deepEqual(c.channels, ['recent', 'semantic']);
  assert.equal(c.scores.semantic, 0.71);

  assert.deepEqual(input, snapshot, 'mergeCandidates 不得修改入参');
});

test('merge: 同通道重复保留最高分，非法条目跳过，缺 id 时按 text 去重', () => {
  const merged = mergeCandidates({
    keyword: [
      { id: 'dup', text: '同一条', score: 1 },
      { id: 'dup', text: '同一条', score: 0.4 },
      null,
      '',
      {},
      42,
      { text: '只有正文' },
      { text: '只有正文', score: 0.2 },
    ],
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].scores.keyword, 1, '保留同通道最高分');
  assert.equal(merged[0].channels.length, 1, '同通道只记一次');
  assert.equal(merged[1].id, 'text:只有正文');
  assert.equal(merged[1].score, 0.2);
  assert.deepEqual(merged[1].scores, { pinned: null, recent: null, semantic: null, keyword: 0.2 });
});

// ------------------------------------------------------------------ 排序

test('rank: pinned 永远排在最前，其余按 score 降序', () => {
  const pinned = {
    id: 'm-pinned',
    text: '偏好使用中文回复',
    pinned: true,
    importance: 0.3,
    updatedAt: isoDaysAgo(31),
  };
  const strong = {
    id: 'm-strong',
    text: '项目数据库使用 PostgreSQL 16。',
    importance: 0.9,
    updatedAt: isoDaysAgo(1),
  };
  const weak = { id: 'm-weak', text: '今天天气不错', importance: 0.2, updatedAt: isoDaysAgo(1) };

  const ranked = rankCandidates([weak, strong, pinned], { query: '数据库 PostgreSQL', now: NOW });
  assert.deepEqual(ids(ranked), ['m-pinned', 'm-strong', 'm-weak']);
  assert.equal(ranked[0].pinned, true);
  assert.equal(ranked[0].signals.pinnedBonus, DEFAULT_WEIGHTS.pinned);
  assert.ok(ranked[1].signals.lexical > 0.9, '完全命中的非 pinned 记忆相关性最高');
  assert.ok(ranked[1].score >= ranked[2].score, '非 pinned 组内按 score 降序');
  assert.equal(ranked[2].signals.lexical, 0, '不相关文本没有词法命中');
});

test('rank: 久远但重要的记忆压过更新但无关的记忆（180 天半衰期）', () => {
  const now = Date.parse('2026-11-01T00:00:00.000Z');
  const oldImportant = {
    id: 'old-important',
    text: '项目数据库使用 PostgreSQL 16，迁移已完成',
    importance: 0.95,
    updatedAt: isoDaysAgo(730, now),
  };
  const freshIrrelevant = {
    id: 'fresh-irrelevant',
    text: '今天天气不错，我们去散步',
    importance: 0.1,
    updatedAt: new Date(now - DAY).toISOString(),
  };

  const ranked = rankCandidates([freshIrrelevant, oldImportant], { query: '数据库 PostgreSQL', now });
  assert.deepEqual(ids(ranked), ['old-important', 'fresh-irrelevant']);
  assert.ok(ranked[0].signals.recency < 0.2, '两年前的记忆已经很旧');
  assert.ok(ranked[1].signals.recency > 0.9, '一天前的记忆几乎不衰减');
  assert.ok(ranked[0].score > ranked[1].score);

  const [halfLife] = rankCandidates(
    [{ id: 'h', text: 'x', updatedAt: new Date(NOW - DEFAULT_HALF_LIFE_DAYS * DAY).toISOString() }],
    { now: NOW },
  );
  assert.equal(DEFAULT_HALF_LIFE_DAYS, 180);
  assert.ok(Math.abs(halfLife.signals.recency - 0.5) < 1e-9, '恰好 180 天衰减到 0.5');

  const [unknown] = rankCandidates([{ id: 'u', text: 'x' }], { now: NOW });
  assert.equal(unknown.signals.recency, 0, '缺失 updatedAt 没有时间信号');
  assert.equal(unknown.signals.importance, 0.5, '缺失 importance 取中性默认值');
});

test('rank: 语义分参与打分、权重可覆盖、结果确定且不修改入参', () => {
  const candidates = [
    { id: 'sem', text: '完全不同的一段文字', semanticScore: 0.9, updatedAt: isoDaysAgo(1) },
    { id: 'lex', text: '数据库 PostgreSQL', updatedAt: isoDaysAgo(1) },
  ];
  const snapshot = structuredClone(candidates);
  const query = '数据库 迁移 回滚';
  const ranked = rankCandidates(candidates, { query, now: NOW });

  assert.deepEqual(ids(ranked), ['sem', 'lex'], '0.9 语义分（0.27）高于 2/4 词法覆盖（0.225）');
  assert.deepEqual(ranked[0].channels, ['semantic']);
  assert.ok(Math.abs(ranked[0].signals.semantic - 0.9) < 1e-9);
  assert.ok(Math.abs(ranked[1].signals.lexical - 0.5) < 1e-9);

  const keywordOnly = rankCandidates(candidates, {
    query,
    now: NOW,
    weights: { semantic: 0, lexical: 1, recency: 0, importance: 0, pinned: 0 },
  });
  assert.equal(keywordOnly[0].id, 'lex');
  assert.ok(Math.abs(keywordOnly[0].score - 0.5) < 1e-9);

  assert.deepEqual(candidates, snapshot, 'rankCandidates 不得修改入参');
  assert.deepEqual(ids(rankCandidates(candidates, { query, now: NOW })), ids(ranked), '同样输入必须同样输出');
});

test('rank: 中文 bigram 与拉丁词混合查询能命中', () => {
  const memories = [
    { id: 'zh-db', text: '项目数据库使用 PostgreSQL 16，迁移已完成', importance: 0.8, updatedAt: isoDaysAgo(30) },
    { id: 'zh-ui', text: '界面使用 Tailwind 和 React 19', importance: 0.8, updatedAt: isoDaysAgo(10) },
    { id: 'zh-cn', text: '用户偏好中文回复，界面文案用简体中文', importance: 0.9, updatedAt: isoDaysAgo(5) },
  ];
  const chinese = rankCandidates(memories, { query: '数据库用的什么', now: NOW });
  assert.equal(chinese[0].id, 'zh-db', '中文 bigram 命中应排第一');
  assert.ok(chinese[0].signals.lexical > 0.3);
  assert.equal(chinese.find(item => item.id === 'zh-ui').signals.lexical, 0);

  const mixed = rankCandidates(memories, { query: '数据库 PostgreSQL', now: NOW });
  assert.equal(mixed[0].id, 'zh-db');
  assert.ok(mixed[0].signals.lexical > 0.9, '中文 bigram + 拉丁单词全部命中');

  const latin = rankCandidates(memories, { query: 'postgresql', now: NOW });
  assert.equal(latin[0].id, 'zh-db', '拉丁词大小写不敏感');
  assert.equal(lexicalOverlap('数据库', '项目数据库使用 PostgreSQL'), 1);
  assert.equal(lexicalOverlap('', '项目数据库'), 0);
});

// ------------------------------------------------------------------ 预算

test('budget: 遵守 maxItems 与 maxTokens，保持 rank 顺序', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    id: `m-${String(index).padStart(2, '0')}`,
    text: '记忆内容'.repeat(50),
  }));
  const perItem = estimateTokens(candidates[0].text);
  assert.equal(perItem, 200, '200 个 CJK 字符 ≈ 200 token');

  const byItems = selectWithinBudget(candidates, { maxItems: 3, maxTokens: 6000 });
  assert.equal(byItems.selected.length, 3);
  assert.deepEqual(ids(byItems.selected), ['m-00', 'm-01', 'm-02']);
  assert.equal(byItems.selected.length + byItems.omitted.length, candidates.length);
  assert.equal(byItems.estimatedTokens, 3 * perItem);

  const byTokens = selectWithinBudget(candidates, { maxItems: 12, maxTokens: 450 });
  assert.equal(byTokens.selected.length, 2, '450 token 只能装下 2 条 200 token 的记忆');
  assert.equal(byTokens.estimatedTokens, 400);
  assert.ok(byTokens.estimatedTokens <= 450);

  const exact = selectWithinBudget(candidates, { maxItems: 5, maxTokens: 1000 });
  assert.equal(exact.selected.length, 5);
  assert.equal(exact.estimatedTokens, 1000, '预算必须能被正好用满');

  const none = selectWithinBudget(candidates, { maxItems: 0, maxTokens: 6000 });
  assert.deepEqual(none.selected, []);
  assert.equal(none.omitted.length, candidates.length);
  assert.equal(none.estimatedTokens, 0);

  assert.deepEqual(
    selectWithinBudget([]),
    { selected: [], omitted: [], estimatedTokens: 0 },
  );
});

test('budget: 超预算条目被跳过而不是截断，支持自定义 textOf', () => {
  const huge = { id: 'huge', text: 'x'.repeat(4000) };
  const small = { id: 'small', text: 'ok' };
  const result = selectWithinBudget([huge, small], { maxItems: 12, maxTokens: 100 });
  assert.deepEqual(ids(result.selected), ['small'], '超大条目不得挤掉后续小条目');
  assert.deepEqual(ids(result.omitted), ['huge']);
  assert.equal(result.estimatedTokens, 1);

  const withSummary = [
    { id: 'a', summary: '短摘要' },
    { id: 'b', summary: '另一段摘要' },
  ];
  const custom = selectWithinBudget(withSummary, { maxTokens: 100, textOf: item => item.summary });
  assert.deepEqual(ids(custom.selected), ['a', 'b']);
  assert.equal(custom.estimatedTokens, estimateTokens('短摘要') + estimateTokens('另一段摘要'));
  assert.equal(DEFAULT_MAX_ITEMS, 12);
  assert.equal(DEFAULT_MAX_TOKENS, 6000);
});

// ------------------------------------------------------------------ 注入判定

test('inject: pinned 与高重要度直接通过，无关候选被挡在阈值外', () => {
  const ranked = rankCandidates(
    [
      { id: 'pinned', text: '偏好中文回复', pinned: true, importance: 0.1, updatedAt: isoDaysAgo(400) },
      { id: 'important', text: '合同编号必须记录', importance: 0.95, updatedAt: isoDaysAgo(400) },
      { id: 'relevant', text: '项目数据库使用 PostgreSQL', importance: 0.4, updatedAt: isoDaysAgo(5) },
      { id: 'irrelevant', text: 'zzz qqq', importance: 0.2, updatedAt: isoDaysAgo(800) },
      { id: 'blank', text: 'nothing to see here' },
    ],
    { query: '数据库', now: NOW },
  );
  const byId = new Map(ranked.map(item => [item.id, item]));

  assert.equal(shouldInject(byId.get('pinned')), true);
  assert.equal(shouldInject(byId.get('important')), true);
  assert.equal(shouldInject(byId.get('relevant')), true);
  assert.equal(shouldInject(byId.get('irrelevant')), false);
  assert.equal(shouldInject(byId.get('blank')), false);
  assert.ok(byId.get('irrelevant').score < DEFAULT_MIN_SCORE);
  assert.ok(byId.get('blank').score < DEFAULT_MIN_SCORE, '无任何信号时不注入');
  assert.equal(DEFAULT_MIN_SCORE, 0.08);

  assert.equal(shouldInject({ id: 'x', pinned: true, score: 0 }), true);
  assert.equal(shouldInject({ id: 'x', importance: 0.9, score: 0 }), true);
  assert.equal(shouldInject({ id: 'x', score: 0.05 }), false);
  assert.equal(shouldInject({ id: 'x', score: 0.2 }, { minScore: 0.5 }), false);
  assert.equal(shouldInject({ id: 'x', score: 0.2 }, { minScore: 0.1 }), true);
});

// ------------------------------------------------------------------ 空输入

test('empty: 空输入安全返回空结构，不抛异常', () => {
  assert.deepEqual(mergeCandidates(), []);
  assert.deepEqual(mergeCandidates({}), []);
  assert.deepEqual(mergeCandidates({ pinned: [], recent: [], semantic: [], keyword: [] }), []);
  assert.deepEqual(rankCandidates(), []);
  assert.deepEqual(rankCandidates([], { query: '数据库', now: NOW }), []);
  assert.deepEqual(selectWithinBudget(), { selected: [], omitted: [], estimatedTokens: 0 });
  assert.deepEqual(selectWithinBudget([], { maxItems: 3, maxTokens: 10 }), {
    selected: [],
    omitted: [],
    estimatedTokens: 0,
  });
  assert.equal(shouldInject(null), false);
  assert.equal(shouldInject(undefined), false);
  assert.equal(shouldInject({}), false);
  assert.equal(shouldInject('记忆'), false);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.deepEqual([...toQueryTokens('')], []);

  assert.throws(() => mergeCandidates({ keyword: 'nope' }), error => error.code === 'invalid-input');
  assert.throws(() => rankCandidates('nope'), error => error.code === 'invalid-input');
  assert.throws(() => selectWithinBudget('nope'), error => error.code === 'invalid-input');
});
