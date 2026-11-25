/**
 * 负责：锁住「临时聊天一键删除」这条路径——行、会话正文、会话级状态一起清，选中态收干净，
 * 而且普通聊天不会被它误删。
 * 不负责：按钮长什么样（tests/chat-row-action.test.mjs）、DOM 渲染（sidebar-chats.js）。
 * 被谁调用：npm test / npm run accept。
 *
 * 做法与 tests/temporary-chat.test.mjs 一致：直接把 app.js 里真实的这段切片跑在 vm 里，
 * 不复制一份逻辑，避免「测试里有、产品里没有」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadSlice() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const start = source.indexOf('/** 临时聊天在 workspaceSnapshot() 里整条被过滤');
  const end = source.indexOf('async function toggleArchive(project, chat) {', start);
  assert.ok(start > 0 && end > start, 'app.js 里应能找到这段删除逻辑（切片标记变了就更新这个测试）');
  return source.slice(start, end);
}

function context() {
  const project = { name: 'P', chats: [] };
  const keyOf = (mode, title) => JSON.stringify([mode, 'P', title]);
  const c = {
    Map, JSON,
    projects: [project],
    project,
    keyOf,
    conversations: new Map(),
    chatAims: new Map(),
    chatUsage: new Map(),
    chatContexts: new Map(),
    chatPermissionPresets: new Map(),
    temporaryConversations: new Set(),
    activeReplies: new Map(),
    selectedChat: '临时的一条',
    selectedProject: 'P',
    chatConversationKey: (proj, chat) => JSON.stringify([chat.mode || 'CodeMova', proj.name, chat.title]),
    // 归档页删除用的跨 mode 键匹配函数：这里用最直白的实现，键形状与产品一致。
    keysForChat: (keys, { project: name, title }) => [...keys].filter(key => {
      try {
        const parts = JSON.parse(key);
        return parts[1] === name && parts[2] === title;
      } catch { return false; }
    }),
    renderConversation: () => { c.rendered += 1; },
    rendered: 0,
    announcements: [],
    renderProjects: () => {},
    $: () => ({ textContent: '', set textContent(value) { c.announcements.push(value); } }),
  };
  return c;
}

function seed(c) {
  const chat = { title: '临时的一条', mode: 'ChatMova' };
  c.project.chats.push(chat, { title: '正常的一条', mode: 'ChatMova' });
  // 同一个聊天在两个 mode 下都存过：删除必须两边都命中，否则会「删了又回来」。
  for (const key of [c.keyOf('ChatMova', '临时的一条'), c.keyOf('CodeMova', '临时的一条')]) {
    c.conversations.set(key, [{ id: 'm1', text: 'hi', at: 1 }]);
    c.chatAims.set(key, { goal: { title: 'g' } });
    c.chatUsage.set(key, { input: 1 });
    c.chatContexts.set(key, { doc: 'x' });
    c.chatPermissionPresets.set(key, 'full');
    c.temporaryConversations.add(key);
  }
  return chat;
}

async function run(c) {
  vm.createContext(c);
  vm.runInContext(await loadSlice(), c);
  return c;
}

test('删除临时聊天：行、会话正文、目标/用量/引用/权限/临时标记一起清', async () => {
  const c = context();
  const chat = seed(c);
  await run(c);

  assert.equal(c.deleteTemporaryChat(c.project, chat), true, '临时聊天应当直接删掉');

  assert.equal(c.project.chats.includes(chat), false, '侧栏那一行要没了');
  for (const key of [c.keyOf('ChatMova', '临时的一条'), c.keyOf('CodeMova', '临时的一条')]) {
    assert.equal(c.conversations.has(key), false, `会话正文要清掉：${key}`);
    assert.equal(c.chatAims.has(key), false, '目标/计划要清掉');
    assert.equal(c.chatUsage.has(key), false, '用量要清掉');
    assert.equal(c.chatContexts.has(key), false, '引用上下文要清掉');
    assert.equal(c.chatPermissionPresets.has(key), false, '权限预设要清掉');
    assert.equal(c.temporaryConversations.has(key), false, '临时标记要清掉');
  }
  assert.equal(c.selectedChat, '', '删掉的正是当前会话时要取消选中，否则下一次发送会顺着旧 key 重建');
  assert.equal(c.rendered, 1, '要重绘一次会话区');
  assert.deepEqual(c.announcements, ['已删除临时聊天：临时的一条'], '要有播报，别让用户以为点了没反应');
});

test('删除临时聊天不影响同项目的其它聊天', async () => {
  const c = context();
  const chat = seed(c);
  c.selectedChat = '正常的一条';
  await run(c);
  c.deleteTemporaryChat(c.project, chat);

  assert.deepEqual(c.project.chats.map(item => item.title), ['正常的一条'], '别的聊天要留着');
  assert.equal(c.selectedChat, '正常的一条', '删的不是当前会话，就不该动选中态');
  assert.equal(c.rendered, 0, '不该无谓重绘');
});

test('普通聊天不会被这条路径顺手删掉（必须走确认弹窗那条）', async () => {
  const c = context();
  seed(c);
  await run(c);
  const normal = c.project.chats.find(item => item.title === '正常的一条');

  assert.equal(c.deleteTemporaryChat(c.project, normal), false, '非临时聊天必须拒绝');
  assert.equal(c.project.chats.includes(normal), true, '拒绝时不许动数据');
  assert.equal(c.conversations.has(c.keyOf('ChatMova', '正常的一条')), false, '本来就没有它的会话行');
  assert.deepEqual(c.announcements, ['这不是临时聊天，已取消删除：正常的一条']);
});

test('归档页删除与临时删除共用 dropChat：键一定要跨 mode 命中', async () => {
  const c = context();
  const chat = seed(c);
  await run(c);
  // dropChat 本身不带「是不是临时」的判断，归档页删的就是普通聊天。
  c.temporaryConversations.clear();
  const keys = c.dropChat(c.project, chat);
  assert.equal(keys.length, 2, '两个 mode 的键都要列出来');
  assert.equal(c.conversations.size, 0, '两条会话正文都清掉了');
  assert.equal(c.project.chats.some(item => item.title === '临时的一条'), false);
});
