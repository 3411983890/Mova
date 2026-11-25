/**
 * 写入去重提示的行为测试（electron/services/memory-dedupe.cjs + memory_write handler）。
 *
 * 两层都测：
 * 1) 纯函数层：相似度、阈值边界、「一句话差异」、候选筛选（只要记忆条目、按相似度降序）；
 * 2) handler 层：命中高相似条目时**不新增**、返回候选 id 与提示；低相似时正常新增。
 * 全部纯内存 fake：没有真实检索服务、没有磁盘、没有 Electron。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

import { createHandlers } from '../electron/skills/packs/memory/handlers.mjs';

const require = createRequire(import.meta.url);
const {
  DUPLICATE_SIMILARITY_THRESHOLD,
  similarity,
  describeDifference,
  findDuplicates,
} = require('../electron/services/memory-dedupe.cjs');

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

function allowAuthorize() {
  return { authorize: async () => ({ allowed: true }) };
}

/* ── 纯函数层 ─────────────────────────────────────────────────────── */

test('similarity：同一句话 = 1，空文本 = 0，且对称', () => {
  assert.equal(similarity('提交信息用中文', '提交信息用中文'), 1);
  assert.equal(similarity('', '提交信息用中文'), 0);
  assert.equal(similarity('提交信息用中文', ''), 0);
  assert.equal(similarity('数据库用 SQLite', '数据库用 Postgres'),
    similarity('数据库用 Postgres', '数据库用 SQLite'), 'Dice 系数必须对称');
});

test('阈值边界：0.80 命中（大于等于），0.75 不命中', () => {
  assert.equal(DUPLICATE_SIMILARITY_THRESHOLD, 0.8, '阈值是具名常量 0.8');
  const atThreshold = ['alpha beta gamma delta epsilon', 'alpha beta gamma delta zeta'];
  assert.equal(similarity(...atThreshold), 0.8);
  const below = ['alpha beta gamma delta', 'alpha beta gamma epsilon'];
  assert.equal(similarity(...below), 0.75);

  const hitsOf = text => [{ kind: 'memory', id: 'm-1', text }];
  assert.equal(findDuplicates(atThreshold[0], hitsOf(atThreshold[1])).length, 1, '0.80 必须命中');
  assert.equal(findDuplicates(below[0], hitsOf(below[1])).length, 0, '0.75 不许命中（保守，不阻断正常写入）');
});

test('findDuplicates：只认记忆条目、按相似度降序、最多 3 条，并给出一句话差异', () => {
  const text = '提交信息用中文，动词开头';
  const hits = [
    { kind: 'memory', id: 'far', text: '部署在云上 Kubernetes' },
    { kind: 'memory', id: 'near', text: '提交信息用中文，动词开头，不要英文' },
    { kind: 'session', id: 'chat:1', text: '提交信息用中文，动词开头' },
    { kind: 'history', id: 'history:1', text: '提交信息用中文，动词开头' },
    { kind: 'memory', id: 'exact', text: '提交信息用中文，动词开头' },
    { kind: 'memory', id: 'no-text' },
  ];
  const found = findDuplicates(text, hits);
  assert.deepEqual(found.map(item => item.id), ['exact', 'near'], '会话/历史命中与无正文的命中都不是候选');
  assert.equal(found[0].similarity, 1);
  assert.equal(found[0].difference, '词元完全相同（只是措辞/顺序不同）');
  assert.match(found[1].difference, /新内容多出|旧条目有/, '差异必须是一句可读的话');

  const many = Array.from({ length: 6 }, (_, index) => ({ kind: 'memory', id: `m-${index}`, text }));
  assert.equal(findDuplicates(text, many).length, 3, '最多提示 3 条（提示不是候选清单）');
});

test('describeDifference：新内容多出的词元与旧条目独有的词元都写得出来', () => {
  const diff = describeDifference('数据库改为 PostgreSQL', '数据库用 SQLite');
  assert.match(diff, /新内容多出/);
  assert.match(diff, /旧条目有/);
});

/* ── handler 层 ───────────────────────────────────────────────────── */

/** memorySearch 假实现：第一次检索（去重）返回固定命中，之后不再参与。 */
function fakeSearch(hits) {
  const calls = [];
  const fn = async (input, signal) => {
    calls.push({ input, signal });
    return hits;
  };
  return { fn, calls };
}

test('memory_write：命中高相似条目时**不新增**，返回候选 id 与「用 update/supersede」的提示', async () => {
  const saved = [];
  const events = [];
  const { fn, calls } = fakeSearch([
    { kind: 'memory', id: 'm-42', text: '提交信息用中文，动词开头', memoryKind: 'preference', source: 'user', updatedAt: '2026-11-01T00:00:00.000Z' },
  ]);
  const handlers = createHandlers({
    memorySearch: fn,
    memoryRuntime: { saveMemory: async input => { saved.push(input); return { id: 'new' }; } },
  });
  const allow = allowAuthorize();
  const result = await handlers.memory_write(
    { text: '提交信息用中文，动词开头', kind: 'preference' },
    { callId: 'mcp-40', emit: event => events.push(event), authorize: allow.authorize },
  );

  assert.equal(result.isError, undefined, '重复提示不是工具失败，模型要能读到候选');
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.saved, false);
  assert.equal(payload.code, 'duplicate-suspected');
  assert.equal(payload.duplicate, true);
  assert.equal(payload.candidates[0].id, 'm-42', '必须给出候选 id（模型要用它调 update/supersede）');
  assert.equal(payload.candidates[0].similarity, 1);
  assert.equal(payload.candidates[0].kind, 'preference');
  assert.equal(payload.candidates[0].updatedAt, '2026-11-01T00:00:00.000Z');
  assert.match(payload.hint, /memory_update/);
  assert.match(payload.hint, /memory_supersede/);
  assert.match(payload.detail, /memory_update/);
  assert.match(payload.detail, /memory_supersede/);

  assert.deepEqual(saved, [], '命中重复时一个字都不许落盘');
  const tool = events.find(event => event.type === 'tool');
  assert.ok(tool, '要发一条 tool 事件让时间线看见「没写入，是重复」');
  assert.match(tool.detail, /疑似重复/);
  assert.match(tool.detail, /memory_update/);
  assert.equal(calls[0].input.source, 'memory', '去重要用只搜记忆的检索（不许回退聊天历史）');
});

test('memory_write：低相似时正常新增（阈值以下不阻断）', async () => {
  const saved = [];
  const { fn } = fakeSearch([{ kind: 'memory', id: 'm-42', text: '部署在云上 Kubernetes' }]);
  const handlers = createHandlers({
    memorySearch: fn,
    memoryRuntime: { saveMemory: async input => { saved.push(input); return { id: 'm-new' }; } },
  });
  const allow = allowAuthorize();
  const result = await handlers.memory_write({ text: '提交信息用中文', kind: 'preference' }, { authorize: allow.authorize });

  assert.equal(result.isError, undefined);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.id, 'm-new');
  assert.equal(saved.length, 1, '低相似必须照常写入');
  assert.equal(saved[0].text, '提交信息用中文');
});

test('memory_write：去重检索失败也不阻断写入（降级成「没有重复」）', async () => {
  const saved = [];
  const failing = async () => { throw Object.assign(new Error('memory offline'), { code: 'service-unavailable' }); };
  const handlers = createHandlers({
    memorySearch: failing,
    memoryRuntime: { saveMemory: async input => { saved.push(input); return { id: 'm-ok' }; } },
  });
  const result = await handlers.memory_write({ text: '记忆检索挂了也要能写' }, { authorize: allowAuthorize().authorize });
  assert.equal(payloadOf(result).ok, true);
  assert.equal(saved.length, 1);
});

test('memory_write：去重提示发生在审批之前（命中重复就不该再弹一次写入审批）', async () => {
  const saved = [];
  let approvals = 0;
  const { fn } = fakeSearch([{ kind: 'memory', id: 'm-42', text: '提交信息用中文' }]);
  const handlers = createHandlers({
    memorySearch: fn,
    memoryRuntime: { saveMemory: async input => { saved.push(input); return { id: 'new' }; } },
  });
  await handlers.memory_write({ text: '提交信息用中文' }, {
    authorize: async () => { approvals += 1; return { allowed: true }; },
  });
  assert.equal(approvals, 0, '重复命中时不该走审批闸门');
  assert.deepEqual(saved, []);
});
