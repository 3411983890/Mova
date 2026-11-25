/**
 * 负责：「删除聊天 / 归档 / 取消归档 / 移除项目」四条链路 + `mergeSessions()` 删除语义的回归测试。
 * 不负责：渲染层 DOM（app.js 需要浏览器环境），这里用 `createRenderer()` 复刻它的同步协议。
 *
 * 为什么要有这个文件：以前每次「删了又回来」都只补一处，测试只覆盖「归档能不能读回」，
 * 从来没人从渲染层快照一路走到仓库读回。这个文件按**真实链路**跑：
 *
 *   app.js 的 projects/conversations 内存态
 *     → workspaceSnapshot()（`{version:1, projects, conversations}`）
 *     → memory:save-sessions → sessionSync.save() → mergeSessions() → repository.saveSessions()
 *     → Postgres 表 mova_conversations / mova_session_events / mova_settings
 *     → 「重启」= 新建一个 repository 实例再 loadSessions()
 *
 * 假 store 的形状照 `tests/postgres-repository.test.mjs` 的 `createFakeStore()`，但**多做一件事**：
 * 把写进去的 json 按 Postgres jsonb 的规则重排键顺序（先按键长度、再按字节序）。这不是为了
 * 让测试变严，而是为了和真库一致：`mova_session_events.content` 是 `jsonb` 列，
 * 实测 `{"id":..,"at":..,"text":..,"reply":{..}}` 读回来会变成
 * `{"at":..,"id":..,"text":..,"reply":{..}}`（2026-11-14 用本机 mova-db 的
 * `select $1::jsonb::text` 验证过）。`session-sync.cjs` 的 `same()` 用的是
 * `JSON.stringify` 全等比较，键顺序一变就判「不一样」，删除语义因此失效——
 * 这正是「删除没有真正落盘」的现场。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPostgresRepository } = require('../electron/db/postgres-repository.cjs');
const { createSessionSync, mergeSessions, mergeRows, same } = require('../electron/session-sync.cjs');

// ---------------------------------------------------------------------------
// Postgres jsonb 的键顺序：先按 UTF-8 字节长度升序，同长度按键的字节序升序。
// ---------------------------------------------------------------------------
function jsonbOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value && typeof value === 'object') {
    const ordered = {};
    for (const key of Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))) {
      ordered[key] = jsonbOrder(value[key]);
    }
    return ordered;
  }
  return value;
}
const asJsonb = value => jsonbOrder(JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------------------
// store 契约的最小实现（对齐 electron/db/postgres-store.cjs 被这四条链路用到的部分）
// ---------------------------------------------------------------------------
function createFakeStore() {
  const state = {
    projects: new Map(), // name -> { id, name, memoryMode }      （mova_projects）
    byId: new Map(), // id -> name
    conversations: new Map(), // id(会话键) -> conversation row  （mova_conversations）
    memories: [],
    settings: {}, // 整行 jsonb：mova_settings.data
  };
  let sequence = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const store = {
    state,
    async seed() {},
    async transaction(operation) { return operation(store); },
    async settingsData() { return clone(state.settings); },
    // mova_settings.data 是 jsonb
    async saveSettingsData(data) { state.settings = asJsonb(data); },
    async projects() { return [...state.projects.values()].map(project => ({ ...project })); },
    async ensureProject(name, memoryMode = 'scoped') {
      if (state.projects.has(name)) return state.projects.get(name).id;
      sequence += 1;
      const id = `00000000-0000-4000-9000-${String(sequence).padStart(12, '0')}`;
      state.projects.set(name, { id, name, memoryMode });
      state.byId.set(id, name);
      return id;
    },
    async deleteUnusedProjects(names) {
      for (const [name, project] of [...state.projects]) {
        if (names.includes(name)) continue;
        if (state.memories.some(memory => memory.projectId === project.id)) continue;
        state.projects.delete(name);
        state.byId.delete(project.id);
      }
    },
    async conversations() {
      return [...state.conversations.values()].map(row => ({ ...clone(row), events: clone(row.events || []) }));
    },
    // 对齐 SQL：created_at = least(existing, excluded)，updated_at 每次覆盖。
    async upsertConversation(conversation) {
      const previous = state.conversations.get(conversation.id);
      state.conversations.set(conversation.id, {
        ...conversation,
        projectName: conversation.projectId ? state.byId.get(conversation.projectId) ?? null : null,
        createdAt: previous && previous.createdAt < conversation.createdAt ? previous.createdAt : conversation.createdAt,
        updatedAt: conversation.updatedAt,
        events: previous?.events || [],
      });
    },
    // content 列是 jsonb：写进去之后键顺序会被重排，读回来就不是原样了。
    async replaceMessageEvents(conversationId, events) {
      const row = state.conversations.get(conversationId);
      if (!row) return;
      row.events = events.map((event, index) => ({ ...clone(event), content: asJsonb(event.content), sequence: index + 1 }));
    },
    async deleteConversationsExcept(ids) {
      for (const id of [...state.conversations.keys()]) if (!ids.includes(id)) state.conversations.delete(id);
    },
    async memories() { return []; },
  };
  return store;
}

// 每次 saveSessions 都会把 updated_at 推到「现在」，所以时钟必须单调（真实时间是毫秒级前进）。
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 10, 0, 0, 0, tick++)).toISOString();

function boot(store) {
  return {
    repository: createPostgresRepository({ store, now: clock, connectionString: 'postgres://fake:fake@127.0.0.1:55432/mova' }),
    sync: createSessionSync(),
  };
}

// ---------------------------------------------------------------------------
// 渲染层等价物：只保留 app.js 里和「会话 / 项目 / 归档」有关的那部分协议。
//   initializeMemory() / syncWorkspace() 都是把 projects 整份换掉（app.js:3726、3777），
//   saveWorkspace() → persistSessions() → memoryBridge.saveSessions(snapshot, revision)。
// ---------------------------------------------------------------------------
function createRenderer({ repository, sync }) {
  const projects = [];
  const conversations = new Map();
  let revision;

  const apply = sessions => {
    projects.splice(0, projects.length, ...sessions.projects);
    conversations.clear();
    for (const [key, turns] of sessions.conversations) conversations.set(key, turns);
  };
  const snapshot = () => ({
    version: 1,
    projects: structuredClone(projects),
    conversations: [...conversations].map(([key, turns]) => [key, structuredClone(turns)]),
    aims: [],
    usage: [],
    permissionPresets: [],
  });

  return {
    projects,
    conversations,
    get revision() { return revision; },
    /** 启动：memoryBridge.read() + memoryBridge.syncSessions()（app.js:3709-3723）。 */
    async load() {
      const preview = await sync.read('renderer', repository, undefined);
      revision = preview.revision;
      apply(preview.sessions);
    },
    /** 2 秒轮询：memoryBridge.syncSessions(revision)（app.js:3765-3791）。 */
    async poll() {
      const response = await sync.read('renderer', repository, revision);
      if (!response.sessions) return response;
      apply(response.sessions);
      revision = response.revision;
      return response;
    },
    /** saveWorkspace()（app.js:322-321）：带 revision 发快照，refresh 时把 revision 丢掉。 */
    async save() {
      const result = await sync.save('renderer', repository, snapshot(), revision);
      revision = result.refresh ? undefined : result.revision;
      return result;
    },
    snapshot,
  };
}

/** 用户真的发了一条消息：app.js:2936-2940 建 chat 行 + 写入 conversations。 */
function seedChat(renderer, { project: projectName, title, mode = 'CodeMova' }) {
  let project = renderer.projects.find(entry => entry.name === projectName);
  if (!project) {
    project = { name: projectName, chats: [] };
    renderer.projects.push(project);
  }
  const at = Date.now();
  project.chats.unshift({ title, mode, location: 'local', archived: false, createdAt: at, updatedAt: at });
  const key = JSON.stringify([mode, projectName, title]);
  renderer.conversations.set(key, [{ id: `msg-${title}`, at, text: '你好', reply: { status: 'done', text: '收到' } }]);
  return key;
}

/** app.js:2403-2411 的「永久删除」：摘掉 chat 行 + 删掉跨 mode 的会话键。 */
function deleteChat(renderer, projectName, title) {
  const project = renderer.projects.find(entry => entry.name === projectName);
  project.chats = project.chats.filter(chat => chat.title !== title);
  for (const key of [...renderer.conversations.keys()]) {
    const parts = JSON.parse(key);
    if (parts[1] === projectName && parts[2] === title) renderer.conversations.delete(key);
  }
}

/** app.js:546-570 的「移除项目」：删掉该项目所有会话键 + 摘掉项目行。 */
function removeProject(renderer, projectName) {
  for (const key of [...renderer.conversations.keys()]) {
    const parts = JSON.parse(key);
    if (parts[1] === projectName) renderer.conversations.delete(key);
  }
  renderer.projects.splice(renderer.projects.findIndex(entry => entry.name === projectName), 1);
}

const chatOf = (sessions, projectName, title) =>
  (sessions.projects.find(row => row.name === projectName)?.chats ?? []).find(chat => chat.title === title);
const describe = sessions => sessions.projects
  .map(project => `${project.name}: [${project.chats.map(chat => `${chat.title}${chat.archived ? '(已归档)' : ''}`).join(', ')}]`)
  .join(' ; ') || '(空)';

// ---------------------------------------------------------------------------
// 1) 归档 → 重启读回仍然已归档
// ---------------------------------------------------------------------------
test('归档一条聊天 → 重启读回仍是已归档（真实会话键 JSON.stringify([mode, project, title])）', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  const key = seedChat(renderer, { project: 'Alpha', title: '归档的聊天' });
  await renderer.save();
  await renderer.poll();

  const chat = chatOf({ projects: renderer.projects }, 'Alpha', '归档的聊天');
  chat.archived = true; // toggleArchive()（app.js:636-648）
  await renderer.save();

  // 「重启」：新的 repository 实例，只从库里读。
  const restarted = boot(store);
  const sessions = await restarted.repository.loadSessions();
  assert.equal(chatOf(sessions, 'Alpha', '归档的聊天')?.archived, true,
    `重启后归档状态丢了。库里的 @chatArchived = ${JSON.stringify(store.state.settings['@chatArchived'])}，读回 = ${describe(sessions)}`);
  assert.deepEqual(store.state.settings['@chatArchived'], [[key, true]],
    '@chatArchived 必须是渲染层同一个会话键（逐字符一致），否则 buildProjects() 回填不到 chat.archived');
});

// ---------------------------------------------------------------------------
// 2) 取消归档 → 重启读回不再归档
// ---------------------------------------------------------------------------
test('取消归档 → 重启读回不再归档', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  seedChat(renderer, { project: 'Alpha', title: '归档的聊天' });
  await renderer.save();
  await renderer.poll();
  chatOf({ projects: renderer.projects }, 'Alpha', '归档的聊天').archived = true;
  await renderer.save();

  // 设置页「取消归档」（app.js:2423-2429）
  const archived = await boot(store).repository.loadSessions();
  assert.equal(chatOf(archived, 'Alpha', '归档的聊天')?.archived, true, '前置条件：先要真的归档成功');

  chatOf({ projects: renderer.projects }, 'Alpha', '归档的聊天').archived = false;
  await renderer.save();

  const restarted = boot(store);
  const sessions = await restarted.repository.loadSessions();
  assert.equal(chatOf(sessions, 'Alpha', '归档的聊天')?.archived, false,
    `取消归档没有落盘。库里的 @chatArchived = ${JSON.stringify(store.state.settings['@chatArchived'])}`);
  assert.deepEqual(store.state.settings['@chatArchived'], [], '取消归档必须把 @chatArchived 里的那一行删掉');
});

// ---------------------------------------------------------------------------
// 3) 永久删除聊天 → 重启读回不存在
// ---------------------------------------------------------------------------
test('永久删除聊天 → 重启读回不存在（渲染层 → sessionSync.save → Postgres）', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  const doomed = seedChat(renderer, { project: 'Alpha', title: '要删的聊天' });
  seedChat(renderer, { project: 'Alpha', title: '要留的聊天' });
  await renderer.save();
  await renderer.poll(); // 2 秒轮询跑过一次：这是最普通的时序
  assert.notEqual(chatOf(await boot(store).repository.loadSessions(), 'Alpha', '要删的聊天'), undefined,
    '前置条件：删除之前它必须在库里');

  deleteChat(renderer, 'Alpha', '要删的聊天');
  await renderer.save();

  const restarted = boot(store);
  const sessions = await restarted.repository.loadSessions();
  assert.equal(chatOf(sessions, 'Alpha', '要删的聊天'), undefined,
    `删掉的聊天又回来了。库里的会话行 = ${JSON.stringify(sessions.conversations.map(([key]) => key))}。`
    + ' 原因见 session-sync.cjs mergeRows()：删除分支要求 same(磁盘行, 上次快照行)，'
    + '而磁盘行来自 jsonb（键顺序被重排、时间戳是 ISO 字符串），永远不可能相等，于是删除被丢弃。');
  assert.equal(sessions.conversations.some(([key]) => key === doomed), false,
    '删掉的会话行必须真的从 mova_conversations 里删掉，否则 buildProjects() 会用它把聊天重建出来');
  assert.equal(chatOf(sessions, 'Alpha', '要留的聊天')?.title, '要留的聊天', '删除不能误伤同项目的其它聊天');
});

// ---------------------------------------------------------------------------
// 4) 移除项目 → 重启读回项目与它的会话都不存在
// ---------------------------------------------------------------------------
test('移除项目 → 重启读回项目行与该项目的全部会话都不存在', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  seedChat(renderer, { project: 'Alpha', title: '聊天一' });
  seedChat(renderer, { project: 'Alpha', title: '聊天二', mode: 'ChatMova' });
  seedChat(renderer, { project: 'Beta', title: '别的项目' });
  await renderer.save();
  await renderer.poll();

  removeProject(renderer, 'Alpha');
  await renderer.save();

  const restarted = boot(store);
  const sessions = await restarted.repository.loadSessions();
  assert.equal(sessions.projects.some(project => project.name === 'Alpha'), false,
    `移除的项目又回来了：${describe(sessions)}。`
    + ` mova_projects 行 = ${JSON.stringify([...store.state.projects.keys()])}，`
    + ' 项目行没被删是因为 mergeSessions() 的项目删除分支同样要求整行 JSON 全等，'
    + '而 buildProjects() 给的行带 sourceFolders/memory/device 和 ISO 时间戳，渲染层给的是自己的行。');
  assert.equal(sessions.conversations.filter(([key]) => JSON.parse(key)[1] === 'Alpha').length, 0,
    `项目删了但它的会话行还在，buildProjects() 会拿会话行把项目重建出来：${describe(sessions)}`);
  assert.equal(chatOf(sessions, 'Beta', '别的项目')?.title, '别的项目', '移除项目不能误伤别的项目');
});

// ---------------------------------------------------------------------------
// 5) 回归锁：mergeSessions(current, before, after) 在「本地已删、服务端仍有」时不得合并回来
// ---------------------------------------------------------------------------
test('回归锁：mergeSessions() 不得把本地已删除的聊天/会话合并回来', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  const doomed = seedChat(renderer, { project: 'Alpha', title: '要删的聊天' });
  seedChat(renderer, { project: 'Alpha', title: '要留的聊天' });
  await renderer.save();

  // 三段入参全部取真实形状：
  //   current = 磁盘读回（jsonb 键序、ISO 时间戳）
  //   before  = 本窗口上一次保存的快照
  //   after   = 用户删掉聊天之后要保存的快照
  const current = await boot(store).repository.loadSessions();
  const before = renderer.snapshot();
  const after = {
    ...before,
    projects: before.projects.map(project => ({ ...project, chats: project.chats.filter(chat => chat.title !== '要删的聊天') })),
    conversations: before.conversations.filter(([key]) => key !== doomed),
  };

  const merged = mergeSessions(current, before, after);
  assert.equal(merged.conversations.some(([key]) => key === doomed), false,
    `mergeSessions() 把已删除的会话合并了回来：${JSON.stringify(merged.conversations.map(([key]) => key))}。`
    + ' mergeRows() 的删除分支用的是 same(currentRow, beforeRow)，'
    + ' 而 currentRow 来自 Postgres jsonb（键顺序被重排）+ ISO 时间戳，和渲染层快照的行不可能是同一串 JSON。');
  assert.equal(merged.projects.flatMap(project => project.chats).some(chat => chat.title === '要删的聊天'), false,
    `mergeSessions() 把已删除的聊天行合并了回来：${describe(merged)}`);
  assert.equal(merged.projects.flatMap(project => project.chats).some(chat => chat.title === '要留的聊天'), true,
    '保留的聊天不能被误删');
});

// ---------------------------------------------------------------------------
// 6) 归档一条「库里没有会话行」的聊天：postgres 模式的 chat 行完全由会话行反推，
//    没有会话行就没有 chat 行，`@chatArchived` 里的键也会被过滤掉。
//    （本地 JSON 仓储相反：memory-store.cjs:126 直接返回快照，聊天和归档状态都在，
//     tests/memory-store.test.mjs:114 锁的就是那个行为——两种仓储对同一份快照不同结果。）
// ---------------------------------------------------------------------------
test('归档一条库里没有会话行的聊天 → 读回仍然存在且已归档（不能被整条丢掉）', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  seedChat(renderer, { project: 'Alpha', title: '有消息的聊天' });
  await renderer.save();
  await renderer.poll();

  // 有 chat 行、但 conversations 里没有对应会话（临时聊天被 workspaceSnapshot() 过滤、
  // 首次发送在写 conversations 之前抛错、或会话行被一次残缺快照删掉，都会落到这个形状）。
  const at = Date.now();
  renderer.projects[0].chats.unshift({ title: '没有会话行的聊天', mode: 'CodeMova', location: 'local', archived: true, createdAt: at, updatedAt: at });
  await renderer.save();

  const restarted = boot(store);
  const sessions = await restarted.repository.loadSessions();
  assert.notEqual(chatOf(sessions, 'Alpha', '没有会话行的聊天'), undefined,
    `归档的聊天整条消失了：${describe(sessions)}。`
    + ' saveSessions() 会把「没有会话行的归档键」过滤掉（postgres-repository.cjs:718），'
    + ' buildProjects() 又只按会话行重建 chat 行，于是设置页的归档列表里什么都没有。');
});

// ---------------------------------------------------------------------------
// 7) 稳定序列化：jsonb 把键序重排之后，两行仍然是「同一行」
// ---------------------------------------------------------------------------
test('mergeRows() 用稳定序列化比较：键序（甚至时间戳形状）不同但语义相同的行视为同一行', () => {
  const rowKey = row => row.id;
  const before = [{ id: 'a', at: 1, text: '第一行', reply: { text: '好的', status: 'done' } }];
  const current = [asJsonb(before[0])]; // 磁盘读回：mova_session_events.content 是 jsonb
  assert.notEqual(JSON.stringify(current[0]), JSON.stringify(before[0]),
    '前置条件：裸 JSON.stringify 认为它们不同（这就是删除被丢弃的根因）');
  assert.equal(same(current[0], before[0]), true, '稳定序列化后必须判成同一行');
  // 时间戳形状不同（服务端 ISO 字符串 / 渲染层数字）也是同一行。
  assert.equal(same({ id: 'a', updatedAt: 1_760_000_000_000 }, { id: 'a', updatedAt: '2025-10-09T08:53:20.000Z' }), true);
  // 删除意图：before 有、after 没有，磁盘行没有更新的时间戳 → 删。
  assert.deepEqual(mergeRows(current, before, [], rowKey), []);
});

// ---------------------------------------------------------------------------
// 8) 并发编辑保护：别人刚改过的行不能被这次删除带走
// ---------------------------------------------------------------------------
test('mergeRows() 并发保护：磁盘行 updatedAt 晚于 before 时保留，且只在内容真的变了时保留', () => {
  const rowKey = row => row.id;
  const before = [{ id: 'chat', updatedAt: 1_000, text: '旧内容' }];
  const edited = [{ id: 'chat', updatedAt: 2_000, text: '别的窗口刚追加的消息' }];
  const kept = [];
  const merged = mergeRows(edited, before, [], rowKey, undefined, { onKeep: info => kept.push(info) });
  assert.deepEqual(merged, edited, '磁盘上的行更新更晚 → 保留，不能误删别人的新改动');
  assert.equal(kept.length, 1, '保留时必须留一条可比对的告警');

  // 时间戳没变 / 更旧 → 删除意图照常生效。
  assert.deepEqual(mergeRows([{ id: 'chat', updatedAt: 1_000, text: '旧内容' }], before, [], rowKey), []);
  assert.deepEqual(mergeRows([{ id: 'chat', updatedAt: 500, text: '旧内容' }], before, [], rowKey), []);
  // 时间戳更晚但内容完全一样（只是重复保存刷新了时间）→ 不算并发编辑，删除必须生效。
  assert.deepEqual(mergeRows([{ id: 'chat', updatedAt: 2_000, text: '旧内容' }], before, [], rowKey), []);
});

// ---------------------------------------------------------------------------
// 9) 项目行删除：overlay 属性/时间戳漂移不能把项目留下来
// ---------------------------------------------------------------------------
test('mergeSessions() 项目删除在 overlay 属性与 updatedAt 漂移下仍然生效', () => {
  const before = { version: 1, projects: [{ name: 'Alpha', chats: [] }], conversations: [] };
  const after = { version: 1, projects: [], conversations: [] };
  const current = {
    version: 1,
    // buildProjects() 给的行带 sourceFolders/memory/device、时间戳也是服务端的；
    // 这些漂移以前会让「整行 JSON 全等」的判定失败，项目于是复活。
    projects: [{
      name: 'Alpha', chats: [], sourceFolders: [{ name: 'src' }], memory: 'default', device: 'local', updatedAt: 9_000_000_000_000,
    }],
    conversations: [],
  };
  const merged = mergeSessions(current, before, after);
  assert.deepEqual(merged.projects, [], '移除项目必须真的删掉项目行，不能因为 overlay 字段不同就保留');

  // 项目里还有别的客户端新建的聊天行时，项目行本身仍然要按删除意图消失。
  const withChats = {
    ...current,
    projects: [{
      ...current.projects[0],
      chats: [{ title: '别人新建的聊天', mode: 'CodeMova', location: 'local', archived: false, createdAt: 1, updatedAt: 9_000_000_000_000 }],
    }],
  };
  const mergedWithChats = mergeSessions(withChats, before, after);
  assert.deepEqual(mergedWithChats.projects, []);
});

// ---------------------------------------------------------------------------
// 10) buildProjects() 的形状：时间戳是数字毫秒，归档页排序不再 NaN
// ---------------------------------------------------------------------------
test('buildProjects() 的时间戳是数字毫秒，archiveEntries() 的排序不再是 NaN', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  seedChat(renderer, { project: 'Alpha', title: '旧的归档聊天' });
  seedChat(renderer, { project: 'Alpha', title: '新的归档聊天' });
  await renderer.save();
  await renderer.poll();
  // 两条都归档，并把时间戳拉开：排序必须按数值降序，而不是 NaN 的随机顺序。
  const chats = renderer.projects[0].chats;
  chats[0].archived = true; chats[0].updatedAt = 2_000;
  chats[1].archived = true; chats[1].updatedAt = 1_000;
  await renderer.save();

  const sessions = await boot(store).repository.loadSessions();
  for (const project of sessions.projects) {
    for (const chat of project.chats) {
      assert.equal(typeof chat.createdAt, 'number', `chat.createdAt 必须是数字毫秒，实际 ${JSON.stringify(chat.createdAt)}`);
      assert.equal(typeof chat.updatedAt, 'number', `chat.updatedAt 必须是数字毫秒，实际 ${JSON.stringify(chat.updatedAt)}`);
      assert.ok(Number.isFinite(chat.updatedAt) && Number.isFinite(chat.createdAt), '时间戳必须是有限数字');
      assert.ok(['local', 'cloud'].includes(chat.location), 'location 必须保留（不写死也要有值）');
    }
  }

  // archiveEntries() 的排序就是这一段（app.js:2310-2323），纯函数复刻，不用起 React。
  const entries = sessions.projects.flatMap(project => project.chats
    .filter(chat => chat.archived)
    .map(chat => ({ project, chat })))
    .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt);
  assert.equal(entries.length, 2, `归档列表应有两条，实际 ${describe(sessions)}`);
  assert.equal(entries.some(({ chat }) => Number.isNaN(chat.updatedAt)), false, '排序键不能是 NaN');
  assert.equal(entries[0].chat.updatedAt >= entries[1].chat.updatedAt, true, '必须真的按数值降序');
});

// ---------------------------------------------------------------------------
// 11) 「没有会话行的归档」要能跨多次保存活下来（第二次保存不能被当成孤儿键删掉）
// ---------------------------------------------------------------------------
test('没有会话行的归档聊天连续保存两次后仍然在归档列表里', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  seedChat(renderer, { project: 'Alpha', title: '有消息的聊天' });
  await renderer.save();
  await renderer.poll();

  const at = Date.now();
  renderer.projects[0].chats.unshift({ title: '没有会话行的聊天', mode: 'CodeMova', location: 'local', archived: true, createdAt: at, updatedAt: at });
  await renderer.save();
  // 第二次保存：库里仍然没有它的会话行，但归档标记已经在 @chatArchived 里了。
  await renderer.poll();
  await renderer.save();

  const sessions = await boot(store).repository.loadSessions();
  const chat = chatOf(sessions, 'Alpha', '没有会话行的聊天');
  assert.notEqual(chat, undefined, `第二次保存把它当成孤儿键删掉了：${describe(sessions)}`);
  assert.equal(chat.archived, true);
  assert.equal(typeof chat.updatedAt, 'number', '没有会话行的归档聊天也要有数字时间戳（@chatActivity）');
});

// ---------------------------------------------------------------------------
// 12) 「云端」筛选：会话行里有位置信息时必须用它，而不是无条件写死 'local'
// ---------------------------------------------------------------------------
test('buildProjects() 使用会话行的 location/device，归档页的「云端」筛选才有真实值', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  const key = seedChat(renderer, { project: 'Alpha', title: '云端聊天' });
  await renderer.save();
  await renderer.poll();
  // 模拟同步下来的「云端」会话行（会话行带位置信息）。
  store.state.conversations.get(key).location = 'cloud';

  const sessions = await boot(store).repository.loadSessions();
  assert.equal(chatOf(sessions, 'Alpha', '云端聊天')?.location, 'cloud',
    'archiveState.type === "cloud" 必须能筛到它，否则归档页的「云端」永远是空的');
});

// ---------------------------------------------------------------------------
// 13) 移除项目：项目里还有记忆时 mova_projects 行会被**故意**保留（删项目会级联删记忆），
//     但用户点「移除项目」之后它不能再回到侧栏。
// ---------------------------------------------------------------------------
test('项目里还有记忆时项目行保留在库里，但侧栏不再出现（记忆页照旧）', async () => {
  const store = createFakeStore();
  const desktop = boot(store);
  const renderer = createRenderer(desktop);
  await renderer.load();
  seedChat(renderer, { project: 'Alpha', title: '聊天一' });
  seedChat(renderer, { project: 'Beta', title: '别的项目' });
  await renderer.save();
  await renderer.poll();
  const alphaId = store.state.projects.get('Alpha').id;
  // 这个项目下有一条记忆：deleteUnusedProjects() 会故意保留项目行（契约 §13）。
  store.state.memories.push({ id: 'mem-1', projectId: alphaId, text: '项目里的记忆' });

  removeProject(renderer, 'Alpha');
  await renderer.save();

  const sessions = await boot(store).repository.loadSessions();
  assert.equal(store.state.projects.has('Alpha'), true, '前置条件：带记忆的项目行是故意保留的');
  assert.equal(sessions.projects.some(project => project.name === 'Alpha'), false,
    `项目已经从侧栏移除了，却因为它还挂着记忆又冒出空项目行：${describe(sessions)}`);
  assert.equal(chatOf(sessions, 'Beta', '别的项目')?.title, '别的项目', '别的项目不受影响');
});
