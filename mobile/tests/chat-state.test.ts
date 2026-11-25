/**
 * 负责：验证演示发送边界、去重和跨会话隔离。
 * 不负责：原生界面截图或真实网络测试。
 * 被谁调用：npm test 和仓库全量 Node 测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, createInitialState, deleteConversation, MAX_MESSAGE_LENGTH, sendDemoMessage } from '../src/features/chat/chat-state.ts';

test('发送演示消息只更新目标会话并明确标记本地回复', () => {
  const initial = createConversation(createInitialState(), 'new', 1);
  const updated = sendDemoMessage(initial, 'new', '  你好  ', 'msg-1', 2, true);
  assert.equal(initial.conversations[0].messages.length, 0);
  assert.equal(updated.conversations[0].title, '你好');
  assert.deepEqual(updated.conversations[0].messages.map(item => item.role), ['user', 'assistant']);
  assert.match(updated.conversations[0].messages[1].text, /本地演示回复/);
  assert.deepEqual(updated.conversations[1], initial.conversations[1]);
});

test('关闭演示、空消息、超长消息和未知会话均不写入消息', () => {
  const state = createInitialState();
  for (const [id, text, enabled] of [
    ['welcome', '你好', false], ['welcome', '  ', true],
    ['welcome', 'a'.repeat(MAX_MESSAGE_LENGTH + 1), true], ['missing', '你好', true],
  ] as const) assert.equal(sendDemoMessage(state, id, text, 'msg', 1, enabled), state);
  assert.equal(sendDemoMessage(state, 'welcome', '你好', '', 1, true), state);
});

test('重复消息和会话 ID 不产生额外记录', () => {
  const initial = createInitialState();
  assert.equal(createConversation(initial, 'welcome', 1), initial);
  const sent = sendDemoMessage(initial, 'welcome', '你好', 'msg', 1, true);
  assert.equal(sendDemoMessage(sent, 'welcome', '你好', 'msg', 2, true), sent);
});

test('删除会话不改写其他会话，删除后发送被拒绝', () => {
  const state = createConversation(createInitialState(), 'new', 1);
  const removed = deleteConversation(state, 'welcome');
  assert.deepEqual(removed.conversations, [state.conversations[0]]);
  assert.equal(sendDemoMessage(removed, 'welcome', '你好', 'msg', 2, true), removed);
});
