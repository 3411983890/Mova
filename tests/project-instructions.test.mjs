import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChatAgent } from '../electron/chat-agent.mjs';
import { createProjectRecord, normalizeInstructions, readProjectDraft } from '../src/features/projects/project-data.js';

const entry = { id: 'test-gateway-model', name: 'Test Gateway', vision: false, efforts: ['low', 'high', 'max'] };
const provider = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };

function completion(deltas, finish) {
  const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n';
  return new Response(deltas.map(delta => chunk(delta)).join('') + chunk({}, finish) + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('normalizeInstructions trims, caps at 4000 and rejects non-strings', () => {
  assert.equal(normalizeInstructions('  用 pnpm  '), '用 pnpm');
  assert.equal(normalizeInstructions('x'.repeat(5000)).length, 4000);
  assert.equal(normalizeInstructions(null), '');
  assert.equal(normalizeInstructions(42), '');
  assert.equal(normalizeInstructions(undefined), '');
});

test('createProjectRecord stores trimmed instructions and defaults to an empty string', () => {
  assert.equal(createProjectRecord('Demo', { instructions: '  用 pnpm  ' }).instructions, '用 pnpm');
  assert.equal(createProjectRecord('Demo').instructions, '');
  assert.throws(() => createProjectRecord(''), /请输入项目名称/);
});

test('readProjectDraft reads #project-instructions from the form', () => {
  const form = {
    dataset: {},
    querySelector: selector => (selector === '#project-instructions' ? { value: '  use pnpm ' } : null),
  };
  const draft = readProjectDraft(form);
  assert.equal(draft.instructions, 'use pnpm');
  assert.equal(draft.memory, 'default');
});

test('project instructions are injected into the system prompt', async () => {
  const payloads = [];
  await runChatAgent({
    key: 'test-key', provider, entry, signal: new AbortController().signal,
    request: { thinking: 'low', messages: [{ role: 'user', text: '开始处理这个项目' }] },
    projectInstructions: '只用 pnpm，不要用 npm 安装依赖',
    emit: () => {},
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return completion([{ content: '收到。' }], 'stop');
    },
  });
  const serialized = JSON.stringify(payloads[0].messages);
  assert.match(serialized, /只用 pnpm/);
  assert.match(serialized, /<project-instructions>/);
});

test('no project instructions leaves the system prompt untouched', async () => {
  const payloads = [];
  await runChatAgent({
    key: 'test-key', provider, entry, signal: new AbortController().signal,
    request: { thinking: 'low', messages: [{ role: 'user', text: '开始处理这个项目' }] },
    emit: () => {},
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return completion([{ content: '收到。' }], 'stop');
    },
  });
  assert.doesNotMatch(JSON.stringify(payloads[0].messages), /<project-instructions>/);
});
