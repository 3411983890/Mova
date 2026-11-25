// QA utility: render the model-provider editor in headless Edge with a stubbed desktop bridge,
// then measure the palette and the expand animation.
// Usage: node qa/verify-provider.mjs [--url=http://127.0.0.1:4173/] [--out=qa]
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333 + Math.floor(Math.random() * 400);
const args = new Map();
for (const raw of process.argv.slice(2)) {
  if (raw.startsWith('--')) {
    const [key, value = 'true'] = raw.slice(2).split('=');
    args.set(key, value);
  }
}
const url = args.get('url') ?? 'http://127.0.0.1:4173/';
const out = args.get('out') ?? 'qa';
const width = Number(args.get('width') ?? 1000);
const height = Number(args.get('height') ?? 900);

const profile = await mkdtemp(join(tmpdir(), 'mova-qa-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--allow-file-access-from-files', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(target => target.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Edge is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('DevTools endpoint did not start');
}

const socket = new WebSocket(await waitForEndpoint());
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const events = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  } else if (message.method && events.has(message.method)) {
    events.get(message.method).splice(0).forEach(resolve => resolve(message.params));
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function once(method) {
  return new Promise(resolve => {
    if (!events.has(method)) events.set(method, []);
    events.get(method).push(resolve);
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const STUB = `
window.movaDesktop = {
  act: async () => {},
  isMaximized: async () => false,
  onMaximizedChange: () => () => {},
  siteIcon: async () => null,
  projects: { pickFolders: async () => ({ ok: false }) },
  providers: {
    list: async () => ({ ok: true, value: {
      providers: [{
        id: 'local-gateway', name: '本地网关', baseUrl: 'http://127.0.0.1:8788/v1',
        protocol: 'openai', hasKey: true,
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vision: false, efforts: ['low', 'medium', 'high'] },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', vision: true, efforts: ['low', 'medium', 'high', 'max'] },
        ],
      }],
      active: { providerId: 'local-gateway', modelId: 'deepseek-v4.1-flash' },
      searchConfigured: true,
    } }),
    save: async () => ({ ok: true, value: {} }),
    remove: async () => ({ ok: true, value: {} }),
    fetch: async () => ({ ok: true, value: [] }),
    defaults: async () => ({ ok: true, value: {} }),
    setActive: async () => ({ ok: true, value: {} }),
  },
};
`;

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function shot(name) {
  const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(out, name), Buffer.from(data.data, 'base64'));
  console.log('saved', join(out, name));
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
  await sleep(1200);

  console.log('open models page:', await evaluate(`(() => {
    document.querySelector('#settings-button').click();
    document.querySelector('[data-settings-item="models"]').click();
    return !document.querySelector('#settings-view').hidden;
  })()`));
  await sleep(300);

  console.log('start editing:', await evaluate(`(() => {
    const button = [...document.querySelectorAll('.provider-card .provider-actions button')]
      .find(item => item.textContent.trim() === '编辑');
    if (!button) return 'no edit button';
    button.click();
    return Boolean(document.querySelector('.provider-editor'));
  })()`));
  await sleep(400);
  await shot('provider-neutral-collapsed.png');

  const palette = await evaluate(`(() => {
    const pick = (selector, property) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node)[property] : 'missing';
    };
    return {
      card: pick('.provider-card', 'backgroundColor'),
      cardBorder: pick('.provider-card', 'borderTopColor'),
      editor: pick('.provider-editor', 'backgroundColor'),
      editorBorder: pick('.provider-editor', 'borderTopColor'),
      field: pick('.provider-field input', 'backgroundColor'),
      fieldBorder: pick('.provider-field input', 'borderTopColor'),
      row: pick('.catalog-row', 'backgroundColor'),
      rowInput: pick('.catalog-row input', 'backgroundColor'),
      caps: pick('.catalog-caps', 'backgroundColor'),
      toggle: pick('.provider-advanced-toggle', 'color'),
    };
  })()`);
  console.log('palette:', JSON.stringify(palette, null, 2));

  const animation = await evaluate(`(async () => {
    const toggle = document.querySelector('.provider-advanced-toggle');
    const panel = document.querySelector('.provider-advanced-body');
    const samples = [];
    const started = performance.now();
    toggle.click();
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    while (performance.now() - started < 420) {
      samples.push(Math.round(panel.getBoundingClientRect().height));
      await frame();
    }
    return {
      hiddenAfterOpen: panel.hidden,
      expandedHeight: Math.round(panel.getBoundingClientRect().height),
      samples: samples.filter((value, index) => index === 0 || value !== samples[index - 1]),
    };
  })()`);
  console.log('expand animation:', JSON.stringify(animation));
  await shot('provider-neutral-expanded.png');

  const collapse = await evaluate(`(async () => {
    const toggle = document.querySelector('.provider-advanced-toggle');
    const panel = document.querySelector('.provider-advanced-body');
    const samples = [];
    const started = performance.now();
    toggle.click();
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    while (performance.now() - started < 420) {
      samples.push(Math.round(panel.getBoundingClientRect().height));
      await frame();
    }
    return { hiddenAfterClose: panel.hidden, samples: samples.filter((value, index) => index === 0 || value !== samples[index - 1]) };
  })()`);
  console.log('collapse animation:', JSON.stringify(collapse));

  const caps = await evaluate(`(async () => {
    const button = document.querySelector('.catalog-detail');
    const panel = document.querySelector('.catalog-caps');
    const samples = [];
    const started = performance.now();
    button.click();
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    while (performance.now() - started < 320) {
      samples.push(Math.round(panel.getBoundingClientRect().height));
      await frame();
    }
    return {
      hidden: panel.hidden,
      expanded: Math.round(panel.getBoundingClientRect().height),
      samples: samples.filter((value, index) => index === 0 || value !== samples[index - 1]),
      rowRadius: getComputedStyle(document.querySelector('.catalog-row')).borderBottomLeftRadius,
    };
  })()`);
  console.log('caps animation:', JSON.stringify(caps));
  await shot('provider-neutral-caps.png');
} finally {
  socket.close();
  child.kill();
}
