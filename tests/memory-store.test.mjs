import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createTestExtractor } from './helpers/memory-extractor.mjs';
const require = createRequire(import.meta.url);
const { createMemoryRepository, DEFAULT_SETTINGS } = require('../electron/memory-store.cjs');
const { installMemoryIpc } = require('../electron/memory-ipc.cjs');
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mova-memory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configured = Object.hasOwn(options, 'extractor') ? options.extractor : createTestExtractor();
  return { directory, repo: createMemoryRepository({ directory, ...options, extractor: configured }) };
}
const code = (fn, value) => assert.rejects(fn, error => error.code === value);

test('local source lookup returns only the linked visible original', async () => {
  const files = new Map();
  const repo = createMemoryRepository({ filePath: path.resolve('source-test.json'), fs: {
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' });
      return files.get(file);
    },
    async mkdir() {},
    async open(file) {
      return { async writeFile(text) { files.set(file, text); }, async sync() {}, async close() {} };
    },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async unlink(file) { files.delete(file); },
  } });
  const conversationId = JSON.stringify(['ChatMova', 'Mova', 'Original chat']);
  await repo.saveSessions({ version: 1, projects: [], conversations: [[conversationId, [
    { id: 'turn-a', text: 'The original wording', reply: { text: 'Another answer' } },
  ]]] });
  const messageId = 'turn-a';
  const memory = await repo.saveMemory({ text: 'A shorter summary', conversationId, messageId });
  const input = { id: memory.id, conversationId, messageId, projectId: null, includeGlobal: true };
  assert.deepEqual(await repo.readMemorySource(input), { role: 'user', text: 'The original wording', projectId: null });
  assert.equal(await repo.readMemorySource({ ...input, messageId: 'turn-a-assistant' }), null);
  assert.deepEqual((await repo.query({ query: 'original', allProjects: true, includeMemories: false })).map(hit => hit.kind), ['session']);
  assert.deepEqual((await repo.readHistorySource({ conversationId, messageId, mode: 'conversation' })).messages.map(item => item.text),
    ['The original wording', 'Another answer']);
  await repo.deleteMemory(memory.id);
  assert.equal(await repo.readMemorySource(input), null);
});

test('pure module loads without Electron; defaults, atomic concurrent operations, restart and stable events', async t => {
  const { repo, directory } = await fixture(t);
  assert.deepEqual(await repo.settings(), DEFAULT_SETTINGS);
  assert.equal((await repo.read()).storage.bytes, 0);
  const saved = await Promise.all(Array.from({ length: 35 }, (_, i) => repo.saveMemory({ text: `Preference ${i}`, eventId: `event-${i}` })));
  assert.equal(new Set(saved.map(m => m.id)).size, 35);
  const second = createMemoryRepository({ directory });
  const state = await second.read();
  assert.equal(state.memories.length, 35);
  assert.equal(state.events.length, 35);
  assert.equal(state.storage.filePath, path.join(directory, 'repository.json'));
  assert.ok(state.storage.bytes > 0);
  assert.deepEqual(await fs.readdir(directory), ['repository.json']);
  assert.equal((await second.saveMemory({ text: 'Different duplicate payload', eventId: 'event-1' })).id, saved[1].id);
  assert.equal((await second.read()).events.length, 35);
});

test('failed rename does not replace committed state; operation queue recovers', async t => {
  let failRename = false;
  const io = { ...fs, rename: async (...args) => { if (failRename) throw new Error('disk failure'); return fs.rename(...args); } };
  const { repo, directory } = await fixture(t, { fs: io });
  await repo.saveMemory({ text: 'Committed memory' });
  failRename = true;
  await code(() => repo.saveMemory({ text: 'Uncommitted memory' }), 'storage-error');
  assert.equal((await repo.read()).memories.length, 1);
  assert.equal((await createMemoryRepository({ directory }).read()).memories.length, 1);
  failRename = false;
  await repo.saveMemory({ text: 'Recovered memory' });
  assert.equal((await repo.read()).memories.length, 2);
  assert.deepEqual(await fs.readdir(directory), ['repository.json']);
});

test('corrupt existing store fails closed and never overwrites original file', async t => {
  const { repo, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'repository.json'), '{bad json');
  await code(() => repo.read(), 'corrupt-store');
  await code(() => repo.saveMemory({ text: 'No overwrite' }), 'corrupt-store');
  assert.equal(await fs.readFile(path.join(directory, 'repository.json'), 'utf8'), '{bad json');
});

test('snapshot round trip preserves source, legacy turn fields, and explicit exact session scopes', async t => {
  const { repo } = await fixture(t);
  const a = JSON.stringify(['CodeMova', 'Alpha', 'Chat']);
  const b = JSON.stringify(['CodeMova', 'Beta', 'Chat']);
  const global = JSON.stringify(['ChatMova', 'Alpha', 'Chat']);
  const snapshot = { version: 1, projects: [{ name: 'Alpha', chats: [{ title: 'Chat' }] }], conversations: [
    [a, [{ id: 'a', text: '中文项目设计', reply: { text: '原始回复', timeline: [] } }, { id: 'temp', text: '临时秘密', temporary: true }]],
    [b, [{ id: 'b', text: '中文项目设计' }]], [global, [{ id: 'g', text: '中文全局设计' }]],
    ['temporary', { projectId: 'Alpha', temporary: true, messages: [{ id: 't', text: '中文临时设计' }] }],
  ] };
  const source = structuredClone(snapshot);
  await repo.saveSessions(snapshot);
  assert.deepEqual(snapshot, source);
  const sessions = await repo.loadSessions();
  assert.deepEqual(sessions.conversations[0][1][0], snapshot.conversations[0][1][0]);
  assert.equal(sessions.conversations.length, 3);
  assert.equal(sessions.conversations[0][1].length, 1);
  const hits = await repo.query({ query: '项目设计', projectId: 'Alpha', includeGlobal: false });
  assert.equal(hits.length, 1); assert.equal(hits[0].conversationId, a); assert.equal(hits[0].messageId, 'a');
  assert.deepEqual((await repo.query({ query: '中文', projectId: null, includeGlobal: true })).map(h => h.messageId), ['g']);
  assert.equal((await repo.query({ query: '中文', projectId: 'Alpha', includeGlobal: true })).length, 2);
  assert.equal((await repo.query({ query: '项目设计', allProjects: true })).length, 3);
  await code(() => repo.query({ query: '中文', projectId: '' }), 'invalid-input');
});

test('archived chats survive a restart through the file store, including un-archiving', async t => {
  const { repo, directory } = await fixture(t);
  const snapshotOf = archived => ({
    version: 1,
    projects: [{ name: 'Alpha', chats: [
      { title: '归档的聊天', mode: 'CodeMova', archived },
      { title: '普通聊天', mode: 'CodeMova', archived: false },
    ] }],
    conversations: [],
  });
  await repo.saveSessions(snapshotOf(true));
  // 重新打开同一目录 = 重启：整份快照落盘，归档状态必须原样回来。
  const restarted = createMemoryRepository({ directory, extractor: createTestExtractor() });
  const loaded = await restarted.loadSessions();
  assert.equal(loaded.projects[0].chats[0].archived, true);
  assert.equal(loaded.projects[0].chats[1].archived, false);
  // 取消归档同样要落盘：不能只写「已归档」而忽略「已恢复」。
  await restarted.saveSessions(snapshotOf(false));
  const again = await createMemoryRepository({ directory, extractor: createTestExtractor() }).loadSessions();
  assert.equal(again.projects[0].chats[0].archived, false);
});

test('automatic extraction is conservative, only user authored, secret-free and idempotent', async t => {
  const { repo } = await fixture(t);
  const input = { conversationId: 'conversation', projectId: 'Alpha', messageId: 'm1', text: '我喜欢简洁的中文回答。我们决定采用本地存储。今天下雨了。' };
  const first = await repo.ingest(input);
  assert.equal(first.extracted.length, 2);
  assert.ok(first.extracted.every(m => m.source === 'automatic' && m.conversationId === 'conversation' && m.messageId === 'm1'));
  const duplicate = await repo.ingest(input);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.extracted.map(m => m.id), first.extracted.map(m => m.id));
  for (const role of ['assistant', 'tool', 'bot', 'system']) assert.equal((await repo.ingest({ ...input, messageId: role, role })).extracted.length, 0);
  assert.equal((await repo.ingest({ ...input, messageId: 'author', author: 'tool' })).extracted.length, 0);
  assert.equal((await repo.ingest({ ...input, messageId: 'temporary', temporary: true })).extracted.length, 0);
  assert.equal((await repo.ingest({ ...input, messageId: 'question', text: 'I prefer Python?' })).extracted.length, 0);
  for (const text of ['记住我的密码是 abc123', 'I use api_key=abc123', '请记住 sk-abcdefghijklmnop', '记住 Bearer confidential']) {
    assert.equal((await repo.ingest({ ...input, messageId: text, text })).extracted.length, 0);
    await code(() => repo.saveMemory({ text }), 'sensitive-content');
  }
  const exported = JSON.stringify(await repo.exportData());
  assert.ok(!exported.includes('abc123'));
  assert.equal((await repo.read()).memories.length, 2);
});

test('LLM extraction stores global preferences, explicit facts and decisions', async t => {
  const { repo } = await fixture(t);
  const result = await repo.ingest({ conversationId: 'chat', messageId: 'global-1', text: '我喜欢简洁的界面。记住我说了1887这四个数字。我决定使用 MySQL。' });
  assert.equal(result.extracted.length, 3);
  const preference = result.extracted.find(memory => memory.kind === 'preference');
  const fact = result.extracted.find(memory => memory.kind === 'fact');
  const decision = result.extracted.find(memory => memory.kind === 'decision');
  assert.ok(preference && fact && decision);
  assert.equal(preference.projectId, null);
  assert.match(preference.text, /简洁/);
  assert.equal(fact.projectId, null);
  assert.match(fact.text, /1887/);
  assert.doesNotMatch(fact.text, /^记住/);
  assert.equal(decision.projectId, null);
  const context = await repo.context({ projectId: 'Alpha', includeGlobal: true });
  assert.equal(context.memories.length, 3);
  assert.equal(context.enabled, true);
  assert.equal((await repo.context({ projectId: 'Alpha', includeGlobal: false })).memories.length, 0);
});

test('local JSON mode fails visibly without an LLM and honors extractorMode off', async t => {
  const { repo } = await fixture(t, { extractor: null });
  const missing = await repo.ingest({ conversationId: 'c', messageId: 'm', text: '记住 1887' });
  assert.equal(missing.skipped, 'llm-unavailable');
  await repo.settings({ extractorMode: 'off', autoExtract: true });
  const disabled = await repo.ingest({ conversationId: 'c', messageId: 'm2', text: '记住 1888' });
  assert.equal(disabled.skipped, 'disabled');
  assert.equal((await repo.read()).memories.length, 0);
});

test('explicit keys supersede only within scope; edit pin disable and delete never revive older versions', async t => {
  const { repo } = await fixture(t);
  const old = await repo.saveMemory({ text: 'Use JavaScript', key: 'language', projectId: 'Alpha' });
  const other = await repo.saveMemory({ text: 'Use Rust', key: 'language', projectId: 'Beta' });
  const next = await repo.saveMemory({ text: 'Use TypeScript', key: 'language', projectId: 'Alpha' });
  assert.equal(next.version, 2); assert.deepEqual(next.supersedes, [old.id]);
  assert.equal((await repo.read()).memories.find(m => m.id === old.id).status, 'superseded');
  assert.equal((await repo.read()).memories.find(m => m.id === other.id).status, 'active');
  await code(() => repo.updateMemory(old.id, { status: 'active' }), 'invalid-status');
  const updated = await repo.updateMemory(next.id, { text: 'Use TypeScript strict mode', pinned: true, status: 'disabled' });
  assert.equal(updated.pinned, true);
  assert.equal((await repo.context({ projectId: 'Alpha' })).memories.length, 0);
  await repo.updateMemory(next.id, { status: 'active' });
  assert.equal((await repo.context({ projectId: 'Alpha' })).memories[0].id, next.id);
  await repo.deleteMemory(next.id);
  assert.equal((await repo.context({ projectId: 'Alpha' })).memories.length, 0);
  assert.equal(await repo.deleteMemory(next.id), false);
});

test('search Chinese ngrams keywords; context exact scope active filtering budgets and persistent caps', async t => {
  const { repo, directory } = await fixture(t);
  await repo.saveMemory({ text: '全局中文偏好', projectId: null });
  const a = await repo.saveMemory({ text: '项目设计使用 TypeScript', projectId: 'Alpha', pinned: true });
  await repo.saveMemory({ text: '另一个项目设计 TypeScript', projectId: 'Beta' });
  await repo.saveMemory({ text: '禁用项目设计 TypeScript', projectId: 'Alpha', status: 'disabled' });
  assert.equal((await repo.query({ query: '设计 TypeScript', projectId: 'Alpha', includeGlobal: false })).length, 1);
  // User-initiated all-project search is explicit; wildcard IDs remain rejected above.
  assert.equal((await repo.query({ query: '项目设计', allProjects: true })).length, 2);
  assert.equal((await repo.query({ query: '项目设计', allProjects: true, includeSessions: false })).length, 2);
  assert.equal((await repo.context({ projectId: null, includeGlobal: true })).memories.length, 1);
  await code(() => repo.context({ projectId: '' }), 'invalid-input');
  let context = await repo.context({ projectId: 'Alpha', includeGlobal: true, maxChars: 300, limit: 1 });
  assert.equal(context.memories.length, 1); assert.equal(context.memories[0].id, a.id); assert.ok(context.text.length <= 300);
  const provenance = JSON.parse(context.text.trim());
  assert.equal(provenance.id, a.id); assert.equal(provenance.source, 'user');
  assert.equal(provenance.conversationId, null); assert.equal(provenance.messageId, null);
  assert.equal((await repo.context({ projectId: 'Alpha', temporary: true })).text, '');
  await repo.settings({ contextMaxChars: 10, contextMaxMemories: 1, autoExtract: false });
  context = await repo.context({ projectId: 'Alpha', maxChars: 20000, limit: 100 });
  assert.ok(context.text.length <= 10); assert.ok(context.memories.length <= 1);
  assert.equal((await repo.ingest({ conversationId: 'c', messageId: 'm', text: '我喜欢中文回答' })).skipped, 'disabled');
  assert.equal((await createMemoryRepository({ directory }).settings()).autoExtract, false);
  await repo.settings({ memoryEnabled: false });
  assert.equal((await repo.context({ projectId: 'Alpha' })).text, '');
  await repo.settings({ maxMemories: 4 });
  await code(() => repo.saveMemory({ text: 'Over cap' }), 'memory-limit');
  await code(() => repo.settings({ contextMaxChars: 100000 }), 'invalid-input');
  await code(() => repo.settings({ historyRetention: '7days' }), 'invalid-settings');
});

test('explicit task/checkpoint APIs, export and clear touch only repository data', async t => {
  const { repo, directory } = await fixture(t);
  const outside = path.join(directory, 'original-source.json');
  await fs.writeFile(outside, 'original remains');
  const task = await repo.saveTask({ title: 'Review design', projectId: 'Alpha' });
  const checkpoint = await repo.saveCheckpoint({ taskId: task.id, text: 'Review started' });
  assert.equal(checkpoint.projectId, 'Alpha');
  assert.equal((await repo.listTasks({ projectId: 'Beta' })).length, 0);
  assert.equal((await repo.listCheckpoints({ projectId: 'Alpha', taskId: task.id })).length, 1);
  assert.equal((await repo.exportData()).checkpoints.length, 1);
  await repo.saveMemory({ text: 'Original preference' });
  await repo.clear({ target: 'memories' });
  assert.equal((await repo.read()).memories.length, 0); assert.equal((await repo.read()).tasks.length, 1);
  await code(() => repo.clear({ target: outside }), 'invalid-target');
  await repo.clear({ target: 'all' });
  assert.equal((await repo.read()).tasks.length, 0);
  assert.equal(await fs.readFile(outside, 'utf8'), 'original remains');
});

test('automatic explicit database revisions supersede and preserve context provenance', async t => {
  const { repo } = await fixture(t);
  const input = { conversationId: 'db-chat', projectId: 'Alpha', messageId: 'mysql', text: '本项目使用 MySQL' };
  const old = (await repo.ingest(input)).extracted[0];
  const latest = (await repo.ingest({ ...input, messageId: 'postgres', text: '本项目改用 PostgreSQL，不使用 MySQL 了' })).extracted[0];
  assert.equal(old.key, 'database'); assert.equal(latest.key, 'database');
  assert.equal(latest.version, 2); assert.deepEqual(latest.supersedes, [old.id]);
  assert.equal((await repo.read()).memories.find(m => m.id === old.id).status, 'superseded');
  const context = await repo.context({ projectId: 'Alpha' });
  assert.deepEqual(context.memories.map(m => m.id), [latest.id]);
  const line = JSON.parse(context.text.trim());
  assert.equal(line.conversationId, 'db-chat'); assert.equal(line.messageId, 'postgres'); assert.equal(line.id, latest.id);
  for (const [i, text] of ['我决定使用 SQLite', '项目数据库采用 MySQL', '本项目改为 PostgreSQL'].entries()) {
    const memory = (await repo.ingest({ ...input, messageId: `revision-${i}`, text })).extracted[0];
    assert.equal(memory.key, 'database');
  }
  assert.equal((await repo.context({ projectId: 'Alpha' })).memories.length, 1);
  assert.equal((await repo.ingest({ ...input, messageId: 'image', text: '' })).skipped, 'empty');
  assert.equal((await repo.ingest({ ...input, messageId: 'long', text: 'x'.repeat(60000) })).extracted.length, 0);
});

test('session search includes genuine assistant replies but excludes mock, demo, tools and thinking', async t => {
  const { repo } = await fixture(t);
  await repo.saveSessions({ version: 1, projects: [], conversations: [['scope', { projectId: 'Alpha', messages: [
    { id: 'real', text: '你好', reply: { source: 'desktop', text: 'PostgreSQL 实际答案', thinking: '内部思考不索引' } },
    { id: 'mock', text: '你好', reply: { source: 'mock', text: 'PostgreSQL 示例答案' } },
    { id: 'demo', text: '你好', reply: { source: 'demo', text: 'PostgreSQL 演示答案' } },
    { id: 'tool', role: 'tool', text: 'PostgreSQL 工具载荷' },
  ] }]] });
  const hits = await repo.query({ projectId: 'Alpha', query: 'PostgreSQL', includeGlobal: false });
  assert.equal(hits.length, 1); assert.equal(hits[0].messageId, 'real-assistant'); assert.equal(hits[0].role, 'assistant');
  assert.equal((await repo.query({ projectId: 'Alpha', query: '内部思考' })).length, 0);
  assert.equal((await repo.query({ projectId: 'Beta', query: 'PostgreSQL' })).length, 0);
});

test('IPC all channels authorize before repository invocation and return sanitized structured errors', async t => {
  const { repo } = await fixture(t);
  const handlers = new Map(); let allowed = false;
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback) };
  const result = installMemoryIpc(() => { if (!allowed) throw new Error('sender path secret'); }, { repository: repo, ipcMain });
  assert.equal(typeof result.context, 'function'); assert.equal(typeof result.read, 'function');
  // 28 个通道 + 新增的 memory:supersede（生命周期三件套里唯一需要新通道的那个：
  // memory_update 走既有 memory:update，memory_archive 走既有 memory:update 的 status 补丁）。
  assert.equal(handlers.size, 29);
  for (const handler of handlers.values()) assert.deepEqual(await handler({}, { text: 'must not run' }), { ok: false, error: 'unauthorized' });
  allowed = true;
  assert.equal((await handlers.get('memory:read')({})).ok, true);
  const saved = await handlers.get('memory:save')({}, { text: 'Explicit note' });
  assert.equal(saved.ok, true);
  assert.equal((await handlers.get('memory:update')({}, saved.value.id, { pinned: true })).value.pinned, true);
  const superseded = await handlers.get('memory:supersede')({}, { id: saved.value.id, text: 'Explicit note revised' });
  assert.equal(superseded.ok, true);
  assert.notEqual(superseded.value.id, saved.value.id, '替代是一条新记录');
  assert.equal(superseded.value.supersedes.includes(saved.value.id), true, '新记录要记住自己替代了谁');
  const afterSupersede = (await handlers.get('memory:read')({})).value.memories;
  assert.equal(afterSupersede.find(memory => memory.id === saved.value.id).status, 'superseded',
    '旧条目必须保留并标成 superseded（历史链），不是被删掉');
  assert.deepEqual(await handlers.get('memory:save')({}, { text: 'api_key=hidden' }), { ok: false, error: 'sensitive-content' });
  const rejectHandlers = new Map();
  installMemoryIpc(() => false, { repository: repo, ipcMain: { handle: (name, fn) => rejectHandlers.set(name, fn) } });
  assert.deepEqual(await rejectHandlers.get('memory:read')({}), { ok: false, error: 'unauthorized' });
});
