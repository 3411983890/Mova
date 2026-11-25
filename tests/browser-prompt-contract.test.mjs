import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChatAgent } from '../electron/chat-agent.mjs';
import { capabilitySentence, edgeUnavailableNote } from '../electron/browser/prompt.cjs';

// 这一组守「提示承诺的等待条件 ⊆ 本轮 browser_wait 的真实枚举」。
// Edge 与内置浏览器是两套能力，提示必须各自按枚举生成，不能共享一段写死文案。
const EDGE_CONDITIONS = ['selector', 'text', 'text-change', 'url', 'load', 'settle', 'idle', 'animation', 'frame'];
const APP_CONDITIONS = [...EDGE_CONDITIONS, 'download', 'time'];

const entry = { id: 'browser-prompt-model', name: 'Browser prompt', vision: false, efforts: [] };
const provider = { id: 'test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };

function browserWith(conditions) {
  return {
    tools: () => [{
      name: 'browser_wait',
      label: '等待页面条件',
      description: 'Wait for a real page condition instead of sleeping.',
      parameters: {
        type: 'object',
        properties: { for: { type: 'string', enum: [...conditions] } },
        required: ['for'], additionalProperties: false,
      },
      execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    }],
  };
}

function textReply() {
  const chunk = text => 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  }) + '\n\n';
  return new Response(chunk('收到。') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

async function capture({ browser = null, browserOnly = false } = {}) {
  let payload;
  await runChatAgent({
    key: 'test', provider, entry, signal: new AbortController().signal,
    request: { messages: [{ role: 'user', text: '打开这个页面看看' }] },
    emit: () => {}, browser, browserOnly,
    fetchModel: async (_url, options) => { payload = JSON.parse(options.body); return textReply(); },
  });
  return payload;
}

function systemPrompt(payload) {
  return (payload.messages || [])
    .filter(message => message.role === 'system')
    .map(message => (typeof message.content === 'string'
      ? message.content
      : (message.content || []).map(part => part.text || '').join('')))
    .join('\n\n');
}

const waitEnumOf = payload => {
  const tools = (payload.tools || []).map(tool => tool.function ?? tool);
  return tools.find(tool => tool.name === 'browser_wait')?.parameters?.properties?.for?.enum ?? [];
};

const waitForValues = text => [...text.matchAll(/for=([a-z][a-z-]*)/g)].map(match => match[1]);

test('every wait condition mentioned in the Edge prompt is in the Edge browser_wait enum', async () => {
  const payload = await capture({ browser: browserWith(EDGE_CONDITIONS), browserOnly: true });
  const prompt = systemPrompt(payload);
  const declared = waitEnumOf(payload);
  assert.deepEqual(declared, EDGE_CONDITIONS, 'Edge 轮次的 browser_wait 枚举应来自 Edge 工具集');
  assert.match(prompt, /Mova's Edge browser assistant/, 'Edge 组合必须走 Edge 提示');
  assert.match(prompt, new RegExp(capabilitySentence(browserWith(EDGE_CONDITIONS).tools()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '能力句必须由本轮枚举生成并原样出现在提示里');
  for (const value of waitForValues(prompt)) {
    assert.ok(declared.includes(value), `提示里的 for=${value} 不在本轮 browser_wait 枚举里`);
  }
  assert.doesNotMatch(prompt, /for=download/, 'Edge 提示不得把 download 当作可用的等待条件');
  assert.doesNotMatch(prompt, /for=time/, 'Edge 提示不得把 time 当作可用的等待条件');
  assert.match(prompt, /wait conditions available here: [^.]+\./, 'Edge 提示应带上枚举生成的能力句');
});

test('the Edge prompt says downloads are unavailable and points at browser_read or a manual download', async () => {
  const payload = await capture({ browser: browserWith(EDGE_CONDITIONS), browserOnly: true });
  const prompt = systemPrompt(payload);
  assert.match(prompt, /cannot wait for downloads/, 'Edge 提示必须明说不能等下载完成');
  assert.match(prompt, /browser_read/, 'Edge 提示要给出读取下载页的替代路径');
  assert.match(prompt, /ask the user to download the file manually/, 'Edge 提示要让用户手动下载');
  assert.ok(!waitForValues(prompt).includes('download'), 'download 绝不能出现在 Edge 的 for= 用法里');
});

test('the in-app browser prompt lists the conditions that only the in-app browser supports', async () => {
  const payload = await capture({ browser: browserWith(APP_CONDITIONS), browserOnly: false });
  const prompt = systemPrompt(payload);
  const declared = waitEnumOf(payload);
  assert.ok(declared.includes('download') && declared.includes('time'), '内置浏览器枚举包含 download / time');
  assert.match(prompt, /wait conditions available here: .*download.*time\./,
    '内置浏览器的能力句必须跟着枚举把 download / time 写进去');
  assert.doesNotMatch(prompt, /Mova's Edge browser assistant/, '内置组合不能串用 Edge 提示');
  for (const value of waitForValues(prompt)) {
    assert.ok(declared.includes(value), `提示里的 for=${value} 不在本轮 browser_wait 枚举里`);
  }
});

test('swapping the generated sentence keeps the fixed halves of both browser prompts intact', async () => {
  const edge = systemPrompt(await capture({ browser: browserWith(EDGE_CONDITIONS), browserOnly: true }));
  assert.match(edge, /Use browser_snapshot for page structure and browser_read for content/, 'Edge 固定前半段不能丢');
  assert.match(edge, /Edge batch operates on the current page/, 'Edge 的批处理约束不能丢');
  assert.match(edge, /Never bypass a denial or authorization requirement/, 'Edge 的授权约束不能丢');
  const app = systemPrompt(await capture({ browser: browserWith(APP_CONDITIONS), browserOnly: false }));
  assert.match(app, /\(1\) batch — once you know the next two or more steps/, '内置浏览器的批处理规则不能丢');
  assert.match(app, /\(5\) read the outcome field/, '内置浏览器最后一条速度规则不能丢');
  assert.match(app, /Prefer browser_snapshot for semantic controls/, '内置浏览器的固定前半段不能丢');
});

test('a session without a browser gets no wait conditions and no browser prompt', async () => {
  const payload = await capture({ browser: null, browserOnly: false });
  const prompt = systemPrompt(payload);
  assert.doesNotMatch(prompt, /wait conditions available here/, '没有 browser_wait 时不能凭空生成能力句');
  assert.doesNotMatch(prompt, /browser_wait/, '没有浏览器工具时提示不应提到 browser_wait');
  assert.equal(waitEnumOf(payload).length, 0);
});

test('capabilitySentence is empty without a browser_wait enum and dedupes the real one', () => {
  assert.equal(capabilitySentence([]), '', '空工具集的 capabilitySentence 必须返回空串');
  assert.equal(capabilitySentence(), '', '缺参数时同样返回空串');
  assert.equal(capabilitySentence([{ name: 'browser_snapshot' }]), '', '没有 browser_wait 时返回空串');
  assert.equal(capabilitySentence([{ name: 'browser_wait', parameters: { properties: {} } }]), '', '枚举缺失时返回空串');
  assert.equal(capabilitySentence(browserWith(['settle', 'selector', 'settle']).tools()),
    'wait conditions available here: settle, selector.', '能力句按枚举顺序生成并去重');
  assert.match(edgeUnavailableNote(), /downloads/, 'Edge 的不可用说明必须点名 download');
});
