/**
 * 负责：锁住聊天行的按钮语义——临时聊天必须显示「删除」，普通聊天才是「归档 / 恢复」。
 * 不负责：DOM 渲染与点击处理（sidebar-chats.js 里没有 DOM 环境跑不了，这里只测映射）。
 * 被谁调用：npm test / npm run accept。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatRowAction } from '../src/features/sidebar/chat-row-action.mjs';

test('普通聊天：归档，已归档的给「恢复」', () => {
  assert.deepEqual(
    chatRowAction({ archived: false, temporary: false }),
    { kind: 'archive', icon: 'archive', label: '归档', verb: '归档聊天' },
  );
  assert.deepEqual(
    chatRowAction({ archived: true }),
    { kind: 'archive', icon: 'arrow-u-up-left', label: '恢复', verb: '恢复聊天' },
  );
});

test('临时聊天：同一个位置改成删除，不留归档入口', () => {
  const action = chatRowAction({ archived: false, temporary: true });
  assert.equal(action.kind, 'delete', '点击语义必须是删除，而不是「提示无法归档」');
  assert.equal(action.icon, 'trash', '图标要换成垃圾桶');
  assert.equal(action.label, '删除', 'aria-label 前缀要说「删除」');
  assert.equal(action.verb, '删除聊天');
});

test('临时 + archived 冲突时以删除为准', () => {
  // 正常流程不会出现（临时聊天进不了归档），但历史数据或将来改动可能留下这种组合；
  // 无论如何都不能给一个「恢复」按钮——那条会话从来没有存过。
  assert.equal(chatRowAction({ archived: true, temporary: true }).kind, 'delete');
});

test('缺省参数按普通未归档聊天处理', () => {
  assert.equal(chatRowAction().kind, 'archive');
  assert.equal(chatRowAction().label, '归档');
});
