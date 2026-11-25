import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeReplyEvent, receiveReply } from '../src/features/chat/chat-reply.ts';
import { mockMovaClient } from '../src/services/mock-mova-client.ts';

const request = { mode: 'ChatMova', model: 'demo', messages: [{ role: 'user', text: '你好' }] };

test('multiple memory searches update independently and preserve timeline order', () => {
  const timeline = [];
  for (const event of [
    { type: 'memory', id: 'one', query: '偏好', status: 'running' },
    { type: 'memory', id: 'one', query: '偏好', status: 'done', count: 2 },
    { type: 'text', id: 'text', text: '稍等' },
    { type: 'memory', id: 'two', query: '项目', status: 'running' },
    { type: 'memory', id: 'two', query: '项目', status: 'error', detail: '搜索失败' },
  ]) mergeReplyEvent(timeline, event);
  assert.deepEqual(timeline.map(event => [event.id, event.status]), [['one', 'done'], ['text', undefined], ['two', 'error']]);
  assert.equal(timeline[0].count, 2);
  assert.equal(timeline[2].detail, '搜索失败');
});

test('stopping a mock reply keeps the first chunk and stops the stream', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const received = [];
  const status = await receiveReply(mockMovaClient, request, controller.signal, text => {
    received.push(text);
    controller.abort();
  });
  assert.equal(status, 'stopped');
  assert.equal(received.length, 1);
  assert.ok(received[0]);
});

test('chunks produced after a stop request are discarded even if the client ignores cancellation', async () => {
  const controller = new AbortController();
  const client = {
    source: 'model',
    async *streamReply() {
      yield 'partial';
      yield 'late';
    },
  };
  const received = [];
  const status = await receiveReply(client, request, controller.signal, text => {
    received.push(text);
    controller.abort();
  });
  assert.equal(status, 'stopped');
  assert.deepEqual(received, ['partial']);
});

test('a stream that fails after emitting text preserves it and reports failure', async () => {
  const client = {
    source: 'model',
    async *streamReply() {
      yield 'partial';
      throw new Error('connection lost');
    },
  };
  let received = '';
  const status = await receiveReply(client, request, new AbortController().signal, text => { received += text; });
  assert.equal(status, 'error');
  assert.equal(received, 'partial');
});
