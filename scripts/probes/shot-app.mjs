// Dev utility: screenshot the running Electron app through its CDP endpoint.
// Usage: node qa/shot-app.mjs <port> <out.png> [--script=file.js] [--wait=600] [--width=1280] [--height=860]
import { readFile, writeFile } from 'node:fs/promises';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  if (raw.startsWith('--')) {
    const [key, value = 'true'] = raw.slice(2).split('=');
    args.set(key, value);
  }
}
const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const port = Number(positional[0] ?? 9331);
const out = positional[1] ?? 'qa/shot.png';
const waitMs = Number(args.get('wait') ?? 600);

async function endpoint() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(target => target.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // The app is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('DevTools endpoint did not start');
}

const socket = new WebSocket(await endpoint());
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront').catch(() => {});
  const width = Number(args.get('width') ?? 1280);
  const height = Number(args.get('height') ?? 860);
  const dpr = Number(args.get('dpr') ?? 1);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  if (args.has('click')) {
    const [x, y] = args.get('click').split(',').map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, Number(args.get('afterClick') ?? 900)));
  }
  if (args.has('move')) {
    const [x, y] = args.get('move').split(',').map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await new Promise(resolve => setTimeout(resolve, Number(args.get('afterMove') ?? 700)));
  }
  if (args.has('script')) {
    const body = await readFile(args.get('script'), 'utf8');
    const result = await send('Runtime.evaluate', {
      expression: `(async () => {\n${body}\n})()`, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(detail);
    }
    if (result.result?.value !== undefined) console.log('script:', JSON.stringify(result.result.value));
  }
  if (args.has('moveAfter')) {
    const [x, y] = args.get('moveAfter').split(',').map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await new Promise(resolve => setTimeout(resolve, Number(args.get('afterMove') ?? 700)));
  }
  await new Promise(resolve => setTimeout(resolve, waitMs));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
} finally {
  socket.close();
}
