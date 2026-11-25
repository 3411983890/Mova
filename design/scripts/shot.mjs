// Dev utility: drive headless Edge over CDP to script interactions and capture screenshots.
// Usage: node scripts/shot.mjs <url> <out.png> [--script=file.js] [--wait=800] [--width=1200] [--height=760] [--dpr=2]
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const [url, out = 'shot.png'] = positional;
const width = Number(args.get('width') ?? 1200);
const height = Number(args.get('height') ?? 760);
const dpr = Number(args.get('dpr') ?? 2);
const waitMs = Number(args.get('wait') ?? 800);

const profile = await mkdtemp(join(tmpdir(), 'mova-shot-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--allow-file-access-from-files', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
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
const pageErrors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === 'Network.loadingFailed') pageErrors.push(message.params.errorText);
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

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: false,
  });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
  await new Promise(resolve => setTimeout(resolve, waitMs));

  if (args.has('script')) {
    const body = await readFile(args.get('script'), 'utf8');
    const expression = `(async () => {\n${body}\n})()`;
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(detail);
    }
    if (result.result?.value !== undefined) console.log('script:', JSON.stringify(result.result.value));
    // Optional: a script may return hoverAt:[x,y] so :hover states can be captured.
    const hoverAt = result.result?.value?.hoverAt;
    if (Array.isArray(hoverAt)) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverAt[0], y: hoverAt[1], buttons: 0 });
      await new Promise(resolve => setTimeout(resolve, 420));
    }
    await new Promise(resolve => setTimeout(resolve, Number(args.get('after') ?? 600)));
  }

  // Optional second pass, e.g. to measure styles after the hover move.
  if (args.has('script2')) {
    const body = await readFile(args.get('script2'), 'utf8');
    const result = await send('Runtime.evaluate', {
      expression: `(async () => {\n${body}\n})()`, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    if (result.result?.value !== undefined) console.log('script2:', JSON.stringify(result.result.value));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  if (pageErrors.length) throw new Error('Browser errors: ' + JSON.stringify(pageErrors));
  console.log('No uncaught browser exceptions or failed network requests.');
} finally {
  socket.close();
  child.kill();
}
