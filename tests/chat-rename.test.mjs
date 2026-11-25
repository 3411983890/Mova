import test from 'node:test';
import assert from 'node:assert/strict';
import { chatKey, migrateKeyedState, planChatRename } from '../src/features/chat/chat-rename.js';

const key = title => JSON.stringify(['ChatMova', 'Mova', title]);

test('a rename plan carries the conversation key to the new title', () => {
  const chat = { title: '帮我看一下收件箱还有什么作业' };
  const project = { name: 'Mova', chats: [chat] };
  const plan = planChatRename({ project, chat, nextTitle: '收件箱待办梳理', conversationKey: key(chat.title) });
  assert.deepEqual(plan, {
    previous: '帮我看一下收件箱还有什么作业',
    next: '收件箱待办梳理',
    from: key('帮我看一下收件箱还有什么作业'),
    to: key('收件箱待办梳理'),
  });
  assert.equal(chatKey(key('a'), 'b'), key('b'));
});

test('a rename is refused when it would collide or change nothing', () => {
  const chat = { title: 'A' };
  const other = { title: 'B' };
  const project = { name: 'Mova', chats: [chat, other] };
  assert.equal(planChatRename({ project, chat, nextTitle: 'B', conversationKey: key('A') }), null, 'duplicate title');
  assert.equal(planChatRename({ project, chat, nextTitle: 'A', conversationKey: key('A') }), null, 'same title');
  assert.equal(planChatRename({ project, chat, nextTitle: '  ', conversationKey: key('A') }), null, 'blank title');
  assert.equal(planChatRename({ project, chat, nextTitle: 'C', conversationKey: 'not json' }), null, 'bad key');
  assert.equal(planChatRename({ project: {}, chat, nextTitle: 'C', conversationKey: key('A') }), null, 'no chats');
});

test('migrating state moves every entry and leaves nothing behind', () => {
  const from = key('旧标题');
  const to = key('新标题');
  const messages = [{ at: 1 }];
  const maps = [new Map([[from, messages]]), new Map(), new Map([[from, { a: 1 }]])];
  const temporary = new Set([from]);
  migrateKeyedState({ from, to, maps, sets: [temporary] });
  assert.equal(maps[0].get(to), messages);
  assert.equal(maps[0].has(from), false);
  assert.equal(maps[2].get(to).a, 1);
  assert.equal(temporary.has(to), true);
  assert.equal(temporary.has(from), false);

  // Nothing to move: a no-op, not an error.
  migrateKeyedState({ from: 'x', to: 'y', maps: [new Map()] });
  migrateKeyedState({ from, to: from, maps: [maps[0]] });
});
