import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeSessions } = require('../electron/session-sync.cjs');

// 桌面端的保存链路是 渲染层快照 → mergeSessions() → repository.saveSessions()。
// mergeSessions() 按聊天行整行替换，所以「归档」这种新加在 chat 行上的字段也必须
// 随行一起被采纳：否则下一次 2 秒轮询就会把刚归档的聊天打回未归档。
const conversationKey = JSON.stringify(['CodeMova', 'Alpha', '归档的聊天']);
const chatRow = extra => ({ title: '归档的聊天', mode: 'CodeMova', location: 'local', archived: false, ...extra });
const snapshotOf = archived => ({
  version: 1,
  projects: [{ name: 'Alpha', chats: [chatRow({ archived })] }],
  conversations: [[conversationKey, [{ id: 'turn-1', text: '你好' }]]],
  aims: [],
  usage: [],
  permissionPresets: [],
});

test('归档改动经过会话合并后仍然是已归档，不会被旧快照覆盖回 false', () => {
  const current = snapshotOf(false); // 服务端当前状态
  const before = snapshotOf(false); // 本窗口上次看到的快照
  const after = snapshotOf(true); // 用户刚点了「归档」

  const merged = mergeSessions(current, before, after);
  assert.equal(merged.projects[0].chats[0].archived, true);
  assert.deepEqual(merged.conversations, after.conversations, '合并不能顺带丢掉消息');
});

test('取消归档的改动同样会被合并采纳', () => {
  const merged = mergeSessions(snapshotOf(true), snapshotOf(true), snapshotOf(false));
  assert.equal(merged.projects[0].chats[0].archived, false);
});

test('别的窗口更新了消息时，本地归档仍然保留（两个字段互不覆盖）', () => {
  const current = snapshotOf(false);
  const before = snapshotOf(false);
  const after = snapshotOf(true);
  // 另一个窗口在此期间追加了一条消息
  current.conversations = [[conversationKey, [{ id: 'turn-1', text: '你好' }, { id: 'turn-2', text: '另一窗口' }]]];

  const merged = mergeSessions(current, before, after);
  assert.equal(merged.projects[0].chats[0].archived, true);
  assert.equal(merged.conversations[0][1].length, 2);
});
