import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// 附件规则现在是独立纯模块（所有文件类型都能带），切片里的 sendMessage 直接调用它。
// 用真实实现而不是桩：桩会让「规则改坏了但测试还绿」。
import * as attachmentRules from '../src/features/chat/attachment-rules.mjs';

test('send rejection keeps input and failed image sends retry their original payload', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const pendingTurnImages = new WeakMap();');
  const end = source.indexOf('// Approvals for a single write/command', start);
  const requests = [];
  const projects = [{ name: 'P', chats: [{ title: 'C' }] }];
  const conversations = new Map([['key', []]]);
  const c = {
    WeakMap, Map, AbortController, crypto: { randomUUID: () => 'id' },
    ...attachmentRules,
    memoryReady: true, memorySaveError: '', providersLoading: false, activeArea: 'home',
    activeReplies: new Map(), conversations, draftKey: () => 'key', selectedChat: 'C', selectedProject: 'P', projects,
    // Module-level flags from app.js that the sliced send path reads.
    isEdge: false,
    desktopMovaClient: { source: 'model' }, mockMovaClient: { source: 'mock' },
    activeSelection: () => ({ model: { id: 'model', vision: c.vision } }), vision: false,
    chatFeedback: msg => { c.feedback = msg; }, $: selector => selector === '#mode-label' ? { textContent: 'ChatMova' } : { checked: false, value: '' },
    temporaryConversations: new Set(), temporaryNextChat: false, memorySettings: {}, memoryBridge: null,
    activeThinkingLevel: () => 'medium', providersState: {}, saveWorkspace: () => {}, renderConversation: () => {},
    buildContextHistory: () => ({}), scheduleWorkspaceSave: () => {}, mergeReplyEvent: () => {},
    // Imported from quote-source.js in app.js; the slice below only evals the
    // send path, so the merge helper is stubbed to the no-quote identity.
    mergeUserText: (_quotes, text) => text,
    USER_TEXT_BUDGET: 60000,
    designWorkspace: { rekey() {} },
    currentPermissionPreset: () => 'default',
    pendingImageMarker: 'pending-image-upload',
    searchDepthValue: () => 'standard',
    searchZoneValue: () => '',
    searchLanguageValue: () => '',
    // app.js resolves project roots through the permissions module; the send slice
    // only needs the request shape, so a stub keeps the test to the send path.
    permissionRoots: [], rootIdsForRequest: () => [],
    renderProjects: () => {},
    // The sidebar marks a chat as running and re-sorts it; that lives outside the send slice.
    chatRows: { touch: () => {}, syncRunning: () => {} },
    syncRunningChats: () => {}, chatConversationKey: () => 'key',
    settleSearchRows: () => {}, settleToolRows: () => {}, ModelConnectionError: class extends Error {},
    // Conversation-level state the send path touches: goal/plan records and real usage.
    chatAims: new Map(), chatUsage: new Map(),
    // The goal auto-continue helpers live outside the sliced send path.
    resetGoalBudget: () => {}, goalSnapshot: () => null, maybeContinueGoal: () => {},
    receiveReply: async (_client, request) => { requests.push(request); return 'error'; },
  };
  vm.createContext(c);
  vm.runInContext(source.slice(start, end), c);
  const attachment = { kind: 'image', status: 'ready', size: 3, name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' };
  assert.equal(c.sendMessage({ text: 'caption', attachments: [attachment] }), false);
  assert.equal(conversations.get('key').length, 0);
  c.vision = true;
  assert.equal(c.sendMessage({ text: 'caption', attachments: [attachment] }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(conversations.get('key')[0].reply.status, 'error');
  // A partial acknowledgement from the first attempt must not survive a re-upload.
  conversations.get('key')[0].imageIds.push('old-image-id');
  c.retryReply(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].attachments[0].dataUrl, attachment.dataUrl);
  assert.equal(requests[1].messages.at(-1).text, 'caption');
  assert.equal(requests[1].messages.at(-1).images.length, 1);
  assert.equal(requests[1].messages.at(-1).images[0], 'pending-image-upload');
  assert.equal(conversations.get('key').length, 1);
  // Simulate a restart before the backend acknowledged the image.
  c.turn = conversations.get('key')[0];
  vm.runInContext('pendingTurnImages.delete(turn)', c);
  c.retryReply(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[2].requireCurrentImages, true);
  assert.equal(requests[2].attachments.length, 0);
  assert.equal(requests[2].messages.at(-1).images[0], 'pending-image-upload');
});
