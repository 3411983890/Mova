import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChatAgent } from '../electron/chat-agent.mjs';

const entry = { id: 'edge-prompt-model', name: 'Edge prompt', vision: false, efforts: [] };
const provider = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
const browser = {
  tools: () => [{
    name: 'browser_snapshot',
    label: 'Read page',
    description: 'Read the current page.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  }],
};

async function systemPrompt(options = {}) {
  let payload;
  await runChatAgent({
    key: 'test', provider, entry, signal: new AbortController().signal,
    request: { messages: [{ role: 'user', text: '查看当前页面' }] },
    emit: () => {}, ...options,
    fetchModel: async (_url, request) => {
      payload = JSON.parse(request.body);
      const chunk = 'data: ' + JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
        choices: [{ index: 0, delta: { content: '收到。' }, finish_reason: 'stop' }],
      }) + '\n\ndata: [DONE]\n\n';
      return new Response(chunk, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  return JSON.stringify(payload.messages);
}

test('Edge browser sessions get action-first instructions matching the Edge tools', async () => {
  const prompt = await systemPrompt({ browser, browserOnly: true });
  assert.match(prompt, /prefer using the available browser tools to complete it/);
  assert.match(prompt, /Do not substitute a link or instructions/);
  assert.match(prompt, /browser_open_tab/);
  assert.match(prompt, /browser_group_tabs/);
  assert.match(prompt, /browser_batch/);
  assert.match(prompt, /Never bypass a denial or authorization requirement/);
  assert.match(prompt, /never blindly repeat it/);
  assert.doesNotMatch(prompt, /browser_navigate returns matching site skills/);
  assert.doesNotMatch(prompt, /Use browser_login/);
});

test('the Edge-specific instructions do not change other chat sessions', async () => {
  const desktopPrompt = await systemPrompt({ browser, browserOnly: false });
  assert.doesNotMatch(desktopPrompt, /Mova's Edge browser assistant/);
  assert.match(desktopPrompt, /browser_navigate returns matching site skills/);
  const noBrowserPrompt = await systemPrompt({ browserOnly: true });
  assert.doesNotMatch(noBrowserPrompt, /Mova's Edge browser assistant/);
});
