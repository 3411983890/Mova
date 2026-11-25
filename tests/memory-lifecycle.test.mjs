/**
 * 记忆生命周期三件套（memory_update / memory_supersede / memory_archive）的行为测试。
 *
 * 全部纯内存：JSON 仓储用 Map 假 fs（没有真实磁盘写入、没有 Electron、没有网络），
 * 技能 handler 通过 `createHandlers({ memorySearch, memoryRuntime })` 直接调用。
 * 检索侧用真实的 `createAgentMemorySearch` 闭包（它就是 memory_search 的生产实现），
 * 所以「归档/替代之后真的检索不到」是端到端断言的，不是断言某个内部字段。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createHandlers } from '../electron/skills/packs/memory/handlers.mjs';
import { manifest as memoryManifest } from '../electron/skills/packs/memory/manifest.mjs';

const require = createRequire(import.meta.url);
const { createMemoryRepository } = require('../electron/memory-store.cjs');
const { createAgentMemorySearch } = require('../electron/services/agent-memory-search.cjs');
const { createPostgresRepository } = require('../electron/db/postgres-repository.cjs');

/* ── 假 fs：只活在内存里，接口形状与 node:fs/promises 对齐 ─────────────── */

function createFakeIo() {
  const files = new Map();
  return {
    files,
    io: {
      async readFile(file) {
        if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files.get(file);
      },
      async mkdir() {},
      async stat(file) {
        if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { size: Buffer.byteLength(files.get(file), 'utf8') };
      },
      async open(file) {
        return {
          async writeFile(text) { files.set(file, text); },
          async sync() {},
          async close() {},
        };
      },
      async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
      async unlink(file) { files.delete(file); },
    },
  };
}

/** 仓储 + 计数壳 + 真实检索闭包 + 技能 handler：与生产接线同形（少一层 IPC）。 */
function createLifecycleHarness(options = {}) {
  const { io, files } = createFakeIo();
  const repo = createMemoryRepository({ filePath: path.resolve('memory-lifecycle.json'), fs: io });
  const calls = { save: 0, update: 0, supersede: 0 };
  const runtime = {
    async saveMemory(input) { calls.save += 1; return repo.saveMemory(input); },
    async updateMemory(id, patch) { calls.update += 1; return repo.updateMemory(id, patch); },
    async supersedeMemory(input) { calls.supersede += 1; return repo.supersedeMemory(input); },
  };
  // memory-ipc 的代理把 `search` 映射到 repository.query；测试里显式补同一个映射。
  const agentSearch = createAgentMemorySearch(
    { ...repo, search: input => repo.query(input) },
    { memoryScope: { projectId: options.projectId ?? null, includeGlobal: true } },
    true,
  );
  const handlers = createHandlers({ memorySearch: agentSearch, memoryRuntime: runtime });
  return { repo, handlers, calls, files };
}

function allowAuthorize() {
  const calls = [];
  return { calls, authorize: async (def, args) => { calls.push(args); return { allowed: true }; } };
}

function denyAuthorize(code = 'approval_denied') {
  const calls = [];
  return { calls, authorize: async (def, args) => { calls.push(args); return { allowed: false, code, reason: '用户拒绝了这次操作' }; } };
}

function collector() {
  const events = [];
  return { events, emit: event => events.push(event) };
}

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

const idsOf = hits => (Array.isArray(hits) ? hits.map(hit => hit.id) : []);

/* ── memory_update ─────────────────────────────────────────────────── */

test('memory_update：按 id 原地改正文——同一条记录、同一条 id、不新增条目', async () => {
  const { handlers, repo } = createLifecycleHarness();
  const allow = allowAuthorize();
  const saved = payloadOf(await handlers.memory_write({ text: '记忆生命周期正在开发中', kind: 'note' }, { authorize: allow.authorize }));
  const before = (await repo.read()).memories;
  assert.equal(before.length, 1);

  // 隔开一点真实时间：updatedAt 的粒度是毫秒，同毫秒内更新会让「必须前进」这条断言变成掷骰子。
  await new Promise(resolve => setTimeout(resolve, 5));
  const result = await handlers.memory_update({ id: saved.id, text: '记忆生命周期已完成' }, { authorize: allow.authorize });
  assert.equal(result.isError, undefined);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.id, saved.id, '更新必须原地，id 不许变');
  assert.equal(payload.text, '记忆生命周期已完成');

  const after = (await repo.read()).memories;
  assert.equal(after.length, 1, '更新不许新增条目');
  assert.equal(after[0].id, saved.id);
  assert.equal(after[0].text, '记忆生命周期已完成');
  assert.equal(after[0].status, 'active');
  assert.notEqual(after[0].updatedAt, before[0].updatedAt, 'updatedAt 必须前进（时效性靠它）');

  const [hit] = await repo.query({ projectId: null, includeGlobal: true, query: '记忆生命周期' });
  assert.equal(hit.text, '记忆生命周期已完成', '检索必须只剩新正文');
});

test('memory_update：拒绝时零副作用（updateMemory 一次都没调，正文一个字都没变）', async () => {
  const { handlers, repo, calls } = createLifecycleHarness();
  const allow = allowAuthorize();
  const deny = denyAuthorize();
  const box = collector();
  const saved = payloadOf(await handlers.memory_write({ text: '旧正文' }, { authorize: allow.authorize }));

  const denied = await handlers.memory_update(
    { id: saved.id, text: '新正文' },
    { callId: 'mcp-30', emit: box.emit, authorize: deny.authorize },
  );
  assert.equal(denied.isError, true);
  assert.equal(payloadOf(denied).error, 'approval_denied');
  assert.equal(calls.update, 0, '拒绝后 updateMemory 一次都不该被调用');
  assert.equal(calls.save, 1, '只有前面那次写入');
  assert.equal((await repo.read()).memories[0].text, '旧正文');
  assert.ok(box.events.some(event => event.type === 'notice'), '拒绝要上屏一条旁白');

  const noChannel = await handlers.memory_update({ id: saved.id, text: '新正文' }, {});
  assert.equal(payloadOf(noChannel).error, 'permission_unavailable');
  assert.equal((await repo.read()).memories[0].text, '旧正文');
});

test('memory_update：对已退役的条目返回 invalid-status，不静默成功', async () => {
  const { handlers, repo } = createLifecycleHarness();
  const allow = allowAuthorize();
  const saved = payloadOf(await handlers.memory_write({ text: '数据库用 SQLite', kind: 'decision' }, { authorize: allow.authorize }));
  const replaced = payloadOf(await handlers.memory_supersede(
    { id: saved.id, text: '数据库改为 PostgreSQL', kind: 'decision' },
    { authorize: allow.authorize },
  ));
  assert.equal(replaced.ok, true);

  const result = await handlers.memory_update({ id: saved.id, text: '再改一次' }, { authorize: allow.authorize });
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).error, 'invalid-status');
  const old = (await repo.read()).memories.find(memory => memory.id === saved.id);
  assert.equal(old.text, '数据库用 SQLite', '退役条目的正文必须原样保留（历史链）');
});

/* ── memory_supersede ─────────────────────────────────────────────── */

test('memory_supersede：新条留活跃集，旧条退役并记住 supersededBy，默认检索只看得到新条', async () => {
  const { handlers, repo } = createLifecycleHarness();
  const allow = allowAuthorize();
  const saved = payloadOf(await handlers.memory_write({ text: '数据库用 SQLite', kind: 'decision' }, { authorize: allow.authorize }));

  const result = await handlers.memory_supersede(
    { id: saved.id, text: '数据库改为 PostgreSQL 16 + pgvector', kind: 'decision' },
    { authorize: allow.authorize },
  );
  assert.equal(result.isError, undefined);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.supersededId, saved.id);
  assert.notEqual(payload.id, saved.id, '替代必须是一条新记录');
  assert.deepEqual(payload.supersedes, [saved.id], '新条要记住自己替代了谁');

  const memories = (await repo.read()).memories;
  assert.equal(memories.length, 2, '旧条必须保留（历史链不能丢）');
  const old = memories.find(memory => memory.id === saved.id);
  const next = memories.find(memory => memory.id === payload.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, payload.id, '旧条要指回替代者');
  assert.equal(old.text, '数据库用 SQLite', '旧条正文原样保留');
  assert.equal(next.status, 'active');
  assert.equal(next.kind, 'decision');

  const hits = await repo.query({ projectId: null, includeGlobal: true, query: '数据库' });
  assert.deepEqual(idsOf(hits), [payload.id], '默认检索只返回新条（旧条退役）');
  const injected = await repo.context({ projectId: null, includeGlobal: true });
  assert.deepEqual(injected.memories.map(memory => memory.id), [payload.id], '上下文自动注入同样只剩新条');
});

test('memory_supersede：正文没变化时拒绝，并提示改用 memory_update（记录一条都没动）', async () => {
  const { handlers, repo, calls } = createLifecycleHarness();
  const allow = allowAuthorize();
  const saved = payloadOf(await handlers.memory_write({ text: '提交信息用中文', kind: 'preference' }, { authorize: allow.authorize }));

  const result = await handlers.memory_supersede({ id: saved.id, text: '提交信息用中文' }, { authorize: allow.authorize });
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).error, 'invalid-input');
  assert.match(textOf(result), /memory_update/, '要告诉模型这种情况用 memory_update');
  assert.equal((await repo.read()).memories.length, 1, '不许留下一条同义的替代条目');
  assert.equal(calls.supersede, 1, '仓储被调用过（由它判定非法），但没有落盘');
});

test('memory_supersede：拒绝时零副作用', async () => {
  const { handlers, repo, calls } = createLifecycleHarness();
  const allow = allowAuthorize();
  const deny = denyAuthorize();
  const saved = payloadOf(await handlers.memory_write({ text: '部署方式是本地 Docker', kind: 'fact' }, { authorize: allow.authorize }));

  const denied = await handlers.memory_supersede(
    { id: saved.id, text: '部署方式改为云托管' },
    { authorize: deny.authorize },
  );
  assert.equal(denied.isError, true);
  assert.equal(payloadOf(denied).error, 'approval_denied');
  assert.equal(calls.supersede, 0);
  const memories = (await repo.read()).memories;
  assert.equal(memories.length, 1);
  assert.equal(memories[0].status, 'active');
  assert.equal(memories[0].supersededBy ?? null, null);
});

/* ── memory_archive ───────────────────────────────────────────────── */

test('memory_archive：归档后默认检索与上下文注入都看不到，includeArchived:true 能查到', async () => {
  const { handlers, repo } = createLifecycleHarness();
  const allow = allowAuthorize();
  const keep = payloadOf(await handlers.memory_write({ text: '项目用 Node 24', kind: 'fact' }, { authorize: allow.authorize }));
  const stale = payloadOf(await handlers.memory_write({ text: '项目用 Node 18', kind: 'fact' }, { authorize: allow.authorize }));

  const archived = await handlers.memory_archive({ id: stale.id, reason: '已升级到 Node 24' }, { callId: 'mcp-31', authorize: allow.authorize });
  assert.equal(archived.isError, undefined);
  const payload = payloadOf(archived);
  assert.equal(payload.ok, true);
  assert.equal(payload.archived, true);
  assert.equal(payload.status, 'archived');
  assert.equal(payload.text, '项目用 Node 18', '归档是软删除，正文必须留着');

  // 1) memory_search（默认）：归档条目不出现。
  const fallback = await handlers.memory_search({ query: 'Node', scope: 'global' }, { callId: 'mcp-32' });
  const visible = idsOf(payloadOf(fallback));
  assert.deepEqual(visible, [keep.id], '默认检索不许返回归档条目');

  // 2) memory_search（includeArchived:true）：能查到，且带 archived 标记。
  const withArchived = await handlers.memory_search(
    { query: 'Node', scope: 'global', includeArchived: true },
    { callId: 'mcp-33' },
  );
  const all = payloadOf(withArchived);
  assert.equal(all.length, 2, 'includeArchived 必须能查到归档条目');
  const found = all.find(hit => hit.id === stale.id);
  assert.ok(found, '归档条目要能按 id 找回来');
  assert.equal(found.archived, true, '归档命中要带 archived 标记（否则模型分不清活跃/归档）');

  // 3) 上下文自动注入：归档条目不出现（这是「反复出现错误记忆」的主诉路径）。
  const injected = await repo.context({ projectId: null, includeGlobal: true });
  assert.deepEqual(injected.memories.map(memory => memory.id), [keep.id], '自动注入必须过滤归档条目');
  assert.equal(injected.text.includes('Node 18'), false);

  // 4) 检索层直查：默认 query 也不返回。
  assert.deepEqual(idsOf(await repo.query({ projectId: null, includeGlobal: true, query: 'Node' })), [keep.id]);
});

test('memory_archive：拒绝时零副作用（记忆仍是 active）', async () => {
  const { handlers, repo, calls } = createLifecycleHarness();
  const allow = allowAuthorize();
  const deny = denyAuthorize();
  const saved = payloadOf(await handlers.memory_write({ text: 'CI 用 GitHub Actions', kind: 'fact' }, { authorize: allow.authorize }));

  const denied = await handlers.memory_archive({ id: saved.id }, { authorize: deny.authorize });
  assert.equal(denied.isError, true);
  assert.equal(payloadOf(denied).error, 'approval_denied');
  assert.equal(calls.update, 0, '拒绝后 updateMemory 一次都不该被调用');
  const memory = (await repo.read()).memories[0];
  assert.equal(memory.status, 'active');
});

test('memory_archive：不存在的 id 返回 not-found；缺 id 是 invalid_arguments', async () => {
  const { handlers } = createLifecycleHarness();
  const allow = allowAuthorize();
  const missing = await handlers.memory_archive({ id: 'no-such-memory' }, { authorize: allow.authorize });
  assert.equal(missing.isError, true);
  assert.equal(payloadOf(missing).error, 'not-found');

  const noId = await handlers.memory_archive({}, { authorize: allow.authorize });
  assert.equal(payloadOf(noId).error, 'invalid_arguments');
});

/* ── manifest 口径：写记忆一律过审批闸门（policy + allowSession，不是 always） ── */

test('manifest：四个写工具都是 risk:"write" + approval.mode:"policy"（能力位 write、同会话同类只问一次）', () => {
  const writeTools = memoryManifest.tools.filter(tool => tool.risk === 'write');
  assert.deepEqual(writeTools.map(tool => tool.name).sort(),
    ['memory_archive', 'memory_supersede', 'memory_update', 'memory_write'],
    '增删改都必须过审批闸门');
  for (const tool of writeTools) {
    assert.equal(tool.approval.mode, 'policy', `${tool.name} 走预设（不是 always：记忆改动由 AI 判断即可）`);
    assert.equal(tool.approval.capability, 'write', `${tool.name} 的能力位必须是 write（审计与复查都用它）`);
    assert.equal(tool.approval.allowSession, true, `${tool.name} 同会话内同类只问一次`);
  }
  // 读工具保持免审批：每轮检索都要弹卡会把记忆检索变成不可用。
  for (const tool of memoryManifest.tools.filter(tool => tool.risk === 'read')) {
    assert.equal(tool.approval.mode, 'none', `${tool.name} 是只读，不该弹卡`);
  }
});

/* ── 依赖缺省：少方法就少工具（注册表会剔掉对应工具） ─────────────────── */

test('memory：只有 saveMemory 时仍然只有 3 个工具；补上 update / supersede 后才多出生命周期工具', () => {
  const search = async () => [];
  const withSave = createHandlers({ memorySearch: search, memoryRuntime: { saveMemory: async () => ({}) } });
  assert.deepEqual(Object.keys(withSave).sort(), ['memory_search', 'memory_write']);

  const full = createHandlers({
    memorySearch: search,
    memoryRuntime: {
      saveMemory: async () => ({}),
      updateMemory: async () => ({}),
      supersedeMemory: async () => ({}),
    },
  });
  assert.deepEqual(Object.keys(full).sort(),
    ['memory_archive', 'memory_search', 'memory_supersede', 'memory_update', 'memory_write']);
});

/* ── PostgreSQL 仓储（生产默认模式）的同一套语义 ─────────────────────
 * JSON 仓储只是 MOVA_MODE=local 的退路；生产跑的是 postgres-repository.cjs。
 * 这里用一个只实现记忆方法的假 store（接口形状与 postgres-store.cjs 一致），
 * 把「替代/归档之后检索侧真的过滤了」钉在真正上线的那份代码上。
 */

function createPgFakeStore() {
  const state = { memories: [], settings: {}, projects: new Map(), seq: 0 };
  const clone = value => JSON.parse(JSON.stringify(value));
  // 假 store 把 projectId 直接当项目名用：仓储只负责传下去，不校验它是不是 uuid。
  const rowOf = memory => ({ ...clone(memory), projectName: memory.projectId ?? null });
  const inScope = (scope, name) => (scope.allProjects === true ? true
    : (scope.projectName ?? null) === null ? name === null
      : name === scope.projectName || (scope.includeGlobal === true && name === null));
  const store = {
    state,
    async seed() {},
    async transaction(fn) { return fn(store); },
    async settingsData() { return clone(state.settings); },
    async saveSettingsData(data) { state.settings = clone(data); },
    async memories() { return state.memories.map(rowOf); },
    async ensureProject(name) {
      if (!state.projects.has(name)) state.projects.set(name, name);
      return state.projects.get(name);
    },
    async insertMemory(row) { state.memories.push(clone(row)); },
    async updateMemory(id, patch) {
      const row = state.memories.find(memory => memory.id === id);
      if (!row) return false;
      if (patch.text !== undefined) row.text = patch.text;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.pinned !== undefined) row.pinned = patch.pinned;
      if (patch.normalizedHash !== undefined) row.normalizedHash = patch.normalizedHash;
      if (patch.updatedAt !== undefined) row.updatedAt = patch.updatedAt;
      return true;
    },
    async supersedeMemories(ids, byId, updatedAt) {
      for (const row of state.memories) {
        if (!ids.includes(row.id)) continue;
        row.status = 'superseded';
        row.supersededBy = byId;
        row.updatedAt = updatedAt;
      }
    },
    async deleteMemoryChunks() {},
    async searchMemories(scope) {
      return state.memories.map(rowOf)
        .filter(row => row.status === 'active' && inScope(scope, row.projectName))
        .slice(0, Number.isInteger(scope.limit) && scope.limit > 0 ? scope.limit : 300);
    },
    async searchMessages() { return []; },
  };
  return store;
}

test('postgres 仓储：替代后默认 query/context 只见新条；归档条目只在 includeArchived 时才返回', async () => {
  const store = createPgFakeStore();
  const repo = createPostgresRepository({ store });
  const first = await repo.saveMemory({ text: '依赖 Node 18', kind: 'fact' });
  const second = await repo.saveMemory({ text: 'CI 用 GitHub Actions', kind: 'fact' });

  const replacement = await repo.supersedeMemory({ id: first.id, text: '依赖 Node 24', kind: 'fact' });
  assert.notEqual(replacement.id, first.id, '替代是一条新记录');
  assert.equal(replacement.supersedes.includes(first.id), true, '新记录要记住自己替代了谁');
  const oldRow = store.state.memories.find(memory => memory.id === first.id);
  assert.equal(oldRow.status, 'superseded', '旧条目必须落成 superseded（历史链）');
  assert.equal(oldRow.supersededBy, replacement.id, '旧条目要指回替代者');
  assert.equal(oldRow.text, '依赖 Node 18', '旧条目正文原样保留');

  // 默认检索：superseded 不出现（searchMemories 的 SQL 只取 active）。
  const hits = await repo.query({ allProjects: true, query: '依赖' });
  assert.deepEqual(hits.map(hit => hit.id), [replacement.id]);
  const injected = await repo.context({ projectId: null });
  assert.equal(injected.memories.some(memory => memory.id === first.id), false, '自动注入必须过滤退役条目');
  assert.equal(injected.memories.some(memory => memory.id === replacement.id), true);
  assert.equal(injected.text.includes('Node 18'), false, '注入文本里不许残留旧正文');

  // 归档：status 'disabled'（既有 status 位，无迁移），默认检索与注入都看不到。
  await repo.updateMemory(second.id, { status: 'disabled' });
  assert.deepEqual((await repo.query({ allProjects: true, query: 'GitHub' })), [], '归档后默认检索看不到');
  const afterArchive = await repo.context({ projectId: null });
  assert.equal(afterArchive.memories.some(memory => memory.id === second.id), false, '归档后自动注入看不到');

  // includeArchived:true 才查得到，并带 archived 标记。
  const withArchived = await repo.query({ allProjects: true, query: 'GitHub', includeArchived: true });
  assert.deepEqual(withArchived.map(hit => hit.id), [second.id]);
  assert.equal(withArchived[0].archived, true);
  assert.equal(withArchived[0].text, 'CI 用 GitHub Actions', '归档是软删除，正文保留');

  // includeArchived 也不会把 superseded 带回来。
  const both = await repo.query({ allProjects: true, query: '依赖', includeArchived: true });
  assert.deepEqual(both.map(hit => hit.id), [replacement.id]);
});
