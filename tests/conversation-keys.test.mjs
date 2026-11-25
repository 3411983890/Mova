/**
 * 负责：`src/features/chat/conversation-keys.mjs` 的匹配规则。
 * 不负责：真正的删除流程（app.js）、持久化。
 * 被谁调用：`node --test`。
 *
 * 为什么必须钉死：这里的错会造成**数据复活**——删掉的项目/聊天一会儿又回来，重启后还在。
 * 真实成因有两条：①同一个聊天可能以不同 `mode` 存过，只按当前 mode 拼键会漏删；
 * ②删除项目时没有删它的会话，而主进程是用会话行反推项目的，于是项目连同聊天一起被重建。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keysForChat, keysForProject, parseConversationKey } from '../src/features/chat/conversation-keys.mjs';

const key = (mode, project, title) => JSON.stringify([mode, project, title]);

test('parseConversationKey：合法键解析出三段，脏键返回 null 不抛', () => {
  assert.deepEqual(parseConversationKey(key('CodeMova', 'Mova', '开发界面')), {
    mode: 'CodeMova', project: 'Mova', title: '开发界面',
  });
  assert.equal(parseConversationKey(''), null);
  assert.equal(parseConversationKey('not json'), null);
  assert.equal(parseConversationKey('[1,2]'), null, '长度不对的键不算会话键');
  assert.equal(parseConversationKey(JSON.stringify(['CodeMova', '', 't'])), null, '没有项目名的不算');
  assert.equal(parseConversationKey(null), null);
  assert.equal(parseConversationKey(123), null);
});

test('keysForChat 跨 mode 命中同一个聊天的所有键', () => {
  const keys = [
    key('CodeMova', 'Mova', '开发界面'),
    key('ChatMova', 'Mova', '开发界面'),   // 用户切换过模式 → 同一个聊天另存过一份
    key('CodeMova', 'Mova', '另一个聊天'),
    key('CodeMova', 'Other', '开发界面'),  // 同名但不同项目
  ];
  const matched = keysForChat(keys, { project: 'Mova', title: '开发界面' });
  assert.deepEqual(matched.sort(), [
    key('ChatMova', 'Mova', '开发界面'),
    key('CodeMova', 'Mova', '开发界面'),
  ].sort(), '必须把两种 mode 的键都删掉，不能只删当前 mode');
});

test('keysForChat：缺项目名或标题时返回空（宁可不删，也不要误删别的聊天）', () => {
  const keys = [key('CodeMova', 'Mova', 'a')];
  assert.deepEqual(keysForChat(keys, { project: '', title: 'a' }), []);
  assert.deepEqual(keysForChat(keys, { project: 'Mova', title: '' }), []);
  assert.deepEqual(keysForChat([], { project: 'Mova', title: 'a' }), []);
  assert.deepEqual(keysForChat(undefined, { project: 'Mova', title: 'a' }), []);
});

test('keysForProject 命中该项目下全部会话（删除项目时连会话一起删）', () => {
  const keys = [
    key('CodeMova', 'Mova', 'a'),
    key('ChatMova', 'Mova', 'b'),
    key('CodeMova', 'Other', 'c'),
  ];
  assert.deepEqual(keysForProject(keys, 'Mova').sort(), [
    key('ChatMova', 'Mova', 'b'),
    key('CodeMova', 'Mova', 'a'),
  ].sort());
  assert.deepEqual(keysForProject(keys, 'Missing'), []);
  assert.deepEqual(keysForProject(keys, ''), []);
});

test('脏键混在真实键里不会让整批匹配失败', () => {
  const keys = ['not json', '[1,2]', key('CodeMova', 'Mova', 'a'), null, undefined];
  assert.deepEqual(keysForChat(keys, { project: 'Mova', title: 'a' }), [key('CodeMova', 'Mova', 'a')]);
  assert.deepEqual(keysForProject(keys, 'Mova'), [key('CodeMova', 'Mova', 'a')]);
});
