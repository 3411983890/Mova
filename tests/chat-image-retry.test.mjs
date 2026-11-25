import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { runChatAgent } from '../electron/chat-agent.mjs';

const require = createRequire(import.meta.url);
const { configureDefaultChatImages } = require('../electron/chat-images.cjs');

// Exercise the actual composer submission closure without requiring a browser DOM.
test('composer preserves the whole draft on rejection and clears it on acceptance', async () => {
  const source = await readFile(new URL('../vendor/leibox/DeepAgentComposerEngine.js', import.meta.url), 'utf8');
  const body = source.match(/const submitWithAttachments = \(\) => \{([\s\S]*?)\n {6}\};/)[1];
  function run(accept, status = 'ready') {
    const cleared = [];
    const context = { attachments: [{ status }], selectedSkills: ['skill'], selectedMentions: ['mention'], draftValue: 'text',
      onSubmit: () => accept, composerRef: { current: null }, textareaRef: {}, mirrorRef: {},
      setAttachments: () => cleared.push('attachments'), setSelectedSkills: () => cleared.push('skills'),
      setSelectedMentions: () => cleared.push('mentions'), setDraftValue: () => cleared.push('text'),
      setCursorPos: () => {}, setSelectionRange: () => {}, pendingDraftValueRef: {} };
    vm.runInNewContext(`(() => {${body}\n})()`, context);
    return cleared;
  }
  assert.deepEqual(run(false), []);
  assert.deepEqual(run(true, 'processing'), []);
  assert.deepEqual(run(true), ['attachments', 'skills', 'mentions', 'text']);
  assert.match(source, /if \(options\.onSubmit\?\.\(message\) === false\) return false/);
  assert.match(source, /if \(bridge\.submit\(displayText \?\? text, attachments, skills, mentions\) === false\) return false/);
});

test('image retries send stored bytes and reject missing images or non-vision models', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mova-retry-images-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  configureDefaultChatImages({ directory, objectStorage: null });
  const provider = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
  const entry = { id: 'test', name: 'test', vision: true, efforts: [] };
  const events = [];
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  let payload;
  const common = { key: 'test', provider, entry, signal: new AbortController().signal,
    emit: e => events.push(e), fetchModel: async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response('data: '+JSON.stringify({ id:'x', object:'chat.completion.chunk', created:1, model:'test', choices:[{index:0,delta:{content:'ok'},finish_reason:null}] })+'\n\ndata: '+JSON.stringify({id:'x',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n', { headers: {'Content-Type':'text/event-stream'} });
    } };
  await runChatAgent({ ...common, request: { messages: [{ role: 'user', text: '' }], attachments: [{ name: 'a.png', dataUrl: png }] } });
  const id = events.find(e => e.type === 'image')?.id;
  assert.ok(id);
  await runChatAgent({ ...common, request: { messages: [{ role: 'user', text: '', images: [id] }], requireCurrentImages: true } });
  assert.ok(payload.messages.at(-1).content.some(part => part.type === 'image_url' && part.image_url.url === png));
  await assert.rejects(runChatAgent({ ...common, entry: { ...entry, vision: false }, request: { messages: [{ role: 'user', text: 'caption', images: [id] }], requireCurrentImages: true } }), e => e.code === 'image_unsupported');
  await rm(join(directory, id));
  await assert.rejects(runChatAgent({ ...common, request: { messages: [{ role: 'user', text: 'caption', images: [id] }], requireCurrentImages: true } }), e => e.code === 'image_missing');
});
