import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// 附件规则与「即时标题」都是独立纯模块（切片里的 sendMessage 直接用它们），
// 与 app.js 的 import 保持一致地注入到 vm 上下文里。
import * as attachmentRules from '../src/features/chat/attachment-rules.mjs';
import { instantChatTitle } from '../src/features/chat/chat-title-text.mjs';

/**
 * 临时聊天只给「下一条新聊天」用：点一次隐私图标 → 首条消息把会话登记为临时，
 * 标记随即消费掉；同一会话后续消息、以及下一条新聊天都不再是临时会话。
 * 这里直接跑 app.js 里真实的发送路径，不复制一份逻辑。
 */
test('临时聊天只作用于下一条新聊天，并在发送后消费标记', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const pendingTurnImages = new WeakMap();');
  const end = source.indexOf('// Approvals for a single write/command', start);
  const requests = [];
  const projects = [{ name: 'P', chats: [] }];
  const conversations = new Map();
  const c = {
    WeakMap, Map, AbortController, crypto: { randomUUID: () => 'id' },
    ...attachmentRules,
    instantChatTitle,
    memoryReady: true, memorySaveError: '', providersLoading: false, activeArea: 'home',
    activeReplies: new Map(), conversations, draftKey: () => c.selectedChat ? JSON.stringify(['ChatMova', c.selectedProject, c.selectedChat]) : JSON.stringify(['ChatMova', c.selectedProject, '']),
    selectedChat: '', selectedProject: 'P', projects,
    isEdge: false,
    desktopMovaClient: { source: 'model' }, mockMovaClient: { source: 'mock' },
    activeSelection: () => ({ model: { id: 'model', vision: false } }),
    chatFeedback: msg => { c.feedback = msg; }, $: selector => selector === '#mode-label' ? { textContent: 'ChatMova' } : { checked: true, value: '' },
    temporaryConversations: new Set(), temporaryNextChat: true, memorySettings: {}, memoryBridge: null,
    activeThinkingLevel: () => 'medium', providersState: {}, saveWorkspace: () => {}, renderConversation: () => {},
    buildContextHistory: () => ({}), scheduleWorkspaceSave: () => {}, mergeReplyEvent: () => {},
    mergeUserText: (_quotes, text) => text,
    USER_TEXT_BUDGET: 60000,
    designWorkspace: { rekey() {} },
    // 发送路径会把设计草稿的 scope 换到新 key 上（app.js 里 `sideBrowser?.rekeyScope(...)`）。
    // 可选链救不了「变量根本没声明」——vm 上下文里必须先有这个名字，否则整段切片 ReferenceError。
    sideBrowser: { rekeyScope() {} },
    currentPermissionPreset: () => 'default',
    pendingImageMarker: 'pending-image-upload',
    searchDepthValue: () => 'standard',
    searchZoneValue: () => '',
    searchLanguageValue: () => '',
    renderProjects: () => {},
    // The sidebar marks a chat as running and re-sorts it; that lives outside the send slice.
    chatRows: { touch: () => {}, syncRunning: () => {} },
    syncRunningChats: () => {}, chatConversationKey: () => '',
    settleSearchRows: () => {}, settleToolRows: () => {},
    ModelConnectionError: class extends Error {},
    chatAims: new Map(), chatUsage: new Map(), chatPermissionPresets: new Map(), draftPermissionPreset: 'default',
    // 会话级模型选择（app.js: `const chatModelSelections = new Map(...)`）：发送时会读/写它。
    chatModelSelections: new Map(),
    // 目标自动推进的辅助函数不在被切出来的发送路径里。
    resetGoalBudget: () => {}, goalSnapshot: () => null, maybeContinueGoal: () => {},
    rootIdsForRequest: () => [], permissionRoots: [],
    receiveReply: async (_client, request) => { requests.push(request); return 'done'; },
  };
  vm.createContext(c);
  vm.runInContext(source.slice(start, end), c);

  assert.equal(c.sendMessage({ text: '第一条' }), true);
  await new Promise(resolve => setImmediate(resolve));
  const firstKey = JSON.stringify(['ChatMova', 'P', '第一条']);
  assert.equal(c.temporaryConversations.has(firstKey), true, '新聊天应记为临时会话');
  assert.equal(c.temporaryNextChat, false, '标记用完即消费，下一条新聊天默认保存');
  assert.equal(requests[0].temporary, true, '请求要带上 temporary');

  // 同一会话的第二条消息仍然属于这条临时会话。
  assert.equal(c.sendMessage({ text: '第二条' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].temporary, true, '同一临时会话的后续消息继续带 temporary');

  // 再开一条新聊天：默认不是临时会话。
  c.selectedChat = '';
  assert.equal(c.sendMessage({ text: '第三条' }), true);
  await new Promise(resolve => setImmediate(resolve));
  const secondKey = JSON.stringify(['ChatMova', 'P', '第三条']);
  assert.equal(c.temporaryConversations.has(secondKey), false);
  assert.equal(requests[2].temporary, false);
});
