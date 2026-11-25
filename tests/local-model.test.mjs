import assert from 'node:assert/strict';
import { test } from 'node:test';
import client from '../electron/local-model.cjs';

const { ENDPOINT, MODEL, streamCompletion } = client;
const history = [{ role: 'user', text: '你好' }];
const signal = () => new AbortController().signal;
const collect = async stream => {
  const chunks = [];
  for await (const text of stream) chunks.push(text);
  return chunks;
};

test('sends OpenAI-compatible history and decodes fragmented UTF-8 stream events', async () => {
  const wire = new TextEncoder().encode(
    ': keepalive\r\n\r\n'
    + 'data: {"choices":[{"delta":{"reasoning_content":"not the answer"}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n'
    + 'data: [DONE]\n\n',
  );
  const fetch = async (url, options) => {
    assert.equal(url, ENDPOINT);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      model: MODEL, messages: [{ role: 'user', content: '你好' }], stream: true,
    });
    const body = new ReadableStream({
      start(controller) {
        for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  assert.deepEqual(await collect(streamCompletion('test-key', history, signal(), fetch)), ['你', '好']);
});

test('reports interrupted streams after retaining their answer prefix', async () => {
  const fetch = async () => new Response('data: {"choices":[{"delta":{"content":"prefix"}}]}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  const stream = streamCompletion('test-key', history, signal(), fetch);
  assert.equal((await stream.next()).value, 'prefix');
  await assert.rejects(() => stream.next(), { code: 'interrupted' });
});

test('does not expose authentication error bodies', async () => {
  const fetch = async () => new Response('private server error details', { status: 401 });
  await assert.rejects(
    () => collect(streamCompletion('test-key', history, signal(), fetch)),
    { code: 'auth', message: 'auth' },
  );
});
