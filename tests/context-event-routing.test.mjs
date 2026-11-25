/**
 * `context` 事件的路由回归。
 *
 * 存在的理由：上下文台账上线后新增了 `context` 事件，它属于「会话级状态」。
 * 如果它落进 transcript 通道，会被当成一条未知的 timeline 行；
 * 更糟的是渲染端 `applyAimEvent` 曾把「非 goal」一律当 plan，会把用户的计划清空。
 * 这里锁死两条边界：context 走 onState、不进 onEvent。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { receiveReply } from '../src/features/chat/chat-reply.ts';

const request = { mode: 'ChatMova', model: 'demo', messages: [{ role: 'user', text: '你好' }] };

const contextEvent = {
  type: 'context',
  report: {
    mode: 'report',
    estimated: true,
    messages: { sent: 12, total: 14 },
    tokens: { before: 4800, after: 4800 },
    layers: [{ id: 'L1', name: '系统约束', tokens: 20 }],
    compaction: null,
  },
};

/** 只产出一条 context 事件的假客户端。 */
function clientOf(events) {
  return {
    source: 'demo',
    async *streamReply() {
      for (const event of events) yield event;
      yield { type: 'text', id: 'a', text: '好的' };
    },
  };
}

test('context 事件走 onState，不进 transcript（onEvent）', async () => {
  const state = [];
  const rows = [];
  await receiveReply(
    clientOf([contextEvent]),
    request,
    new AbortController().signal,
    () => {},
    () => {},
    event => rows.push(event),
    event => state.push(event),
  );
  assert.equal(state.length, 1, 'context 必须走 onState');
  assert.equal(state[0].type, 'context');
  assert.equal(rows.some(event => event.type === 'context'), false, 'context 不能落进 transcript');
  assert.ok(rows.some(event => event.type === 'text'), '普通文本仍然走 onEvent');
});

test('usage 与 context 可以同时出现且互不干扰', async () => {
  const state = [];
  const rows = [];
  await receiveReply(
    clientOf([
      { type: 'usage', model: 'm', provider: 'p', call: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 }, run: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 } },
      contextEvent,
    ]),
    request,
    new AbortController().signal,
    () => {},
    () => {},
    event => rows.push(event),
    event => state.push(event),
  );
  assert.deepEqual(state.map(event => event.type), ['usage', 'context']);
  assert.equal(rows.length, 1, '只有正文会进 transcript');
});
