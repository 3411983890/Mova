'use strict';
// M0 spike: prove the browser-agent assumptions against the Electron runtime
// that Mova actually ships. Run with: npx electron scripts/browser-spike.cjs
// It starts a throwaway HTTP fixture, embeds three <webview> guests, and
// exercises debugger attach, AXTree, real clicks, screenshots, dialogs, frames.

const { app, BrowserWindow, nativeImage, webContents } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'design', 'browser-spike');
fs.mkdirSync(OUT, { recursive: true });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Spike Page</title>',
  '<style>body{font:14px system-ui;margin:16px} #tall{height:2200px;background:linear-gradient(#fff,#ddd)}',
  'label{display:block;margin:8px 0 4px} input{padding:4px}</style></head><body>',
  '<h1>Spike Page</h1>',
  '<label for="name">Name</label><input id="name" aria-label="Name">',
  '<button id="go">Go</button> <button id="alert">Alert</button>',
  '<div id="result">idle</div>',
  '<div id="late"></div>',
  '<div id="shadow"></div>',
  '<div id="tall">tall content</div>',
  '<iframe src="/frame" width="320" height="120"></iframe>',
  '<script>',
  'document.getElementById("go").addEventListener("click", () => { document.getElementById("result").textContent = "clicked"; });',
  'setTimeout(() => { document.getElementById("late").innerHTML = "<button id=late-btn>Late</button>"; }, 800);',
  'const root = document.getElementById("shadow").attachShadow({ mode: "open" });',
  'root.innerHTML = "<button id=shadow-btn>Shadow</button>";',
  '</script></body></html>',
].join('');

const FRAME = '<!doctype html><html><body><button id="frame-btn">Frame Button</button></body></html>';

function embedderHtml(port) {
  const template = fs.readFileSync(path.join(__dirname, 'browser-spike.html'), 'utf8');
  const base = `http://127.0.0.1:${port}`;
  return template
    .replace('__MAIN__', `${base}/`)
    .replace('__OFF__', `${base}/offscreen`)
    .replace('__NONE__', `${base}/hidden`);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const html = url.pathname === '/frame' ? FRAME
      : url.pathname === '/hidden' ? '<!doctype html><title>Hidden</title><h1>Hidden Tab</h1><button>Hidden Button</button>'
      : url.pathname === '/embedder' ? embedderHtml(server.address().port)
      : PAGE;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function guestByPath(pathname) {
  return webContents.getAllWebContents().find(wc => {
    if (wc.getType() !== 'webview') return false;
    try { return new URL(wc.getURL()).pathname === pathname; } catch { return false; }
  });
}

async function waitGuest(pathname, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const guest = guestByPath(pathname);
    if (guest) {
      const state = await guest.executeJavaScript('document.readyState').catch(() => null);
      if (state === 'complete') return guest;
    }
    await delay(120);
  }
  const listed = webContents.getAllWebContents().map(wc => `${wc.getType()}:${wc.getURL()}`).join(' | ');
  throw new Error(`guest not ready: ${pathname}; contents=${listed}`);
}

function attach(guest) {
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3');
}

function send(guest, method, params = {}, ms = 12000) {
  return withTimeout(guest.debugger.sendCommand(method, params), ms, method);
}

function bytesOf(guest, data) {
  const buffer = Buffer.from(data, 'base64');
  fs.writeFileSync(path.join(OUT, `${guest}.png`), buffer);
  const image = nativeImage.createFromBuffer(buffer);
  return { bytes: buffer.length, size: image.getSize(), empty: image.isEmpty() };
}

async function attemptShot(guest, label) {
  const attempts = [];
  const tryOne = async (name, fn) => {
    try {
      const buffer = await withTimeout(Promise.resolve().then(fn), 6000, name);
      const file = `${label}-${name.replace(/[^a-z0-9]+/gi, '-')}`;
      fs.writeFileSync(path.join(OUT, `${file}.png`), buffer);
      const image = nativeImage.createFromBuffer(buffer);
      attempts.push({ name, ok: buffer.length > 1000, bytes: buffer.length, size: image.getSize(), empty: image.isEmpty() });
      return buffer.length > 1000;
    } catch (error) {
      attempts.push({ name, ok: false, error: error.message });
      return false;
    }
  };
  if (await tryOne('capturePage', async () => {
    guest.invalidate();
    await delay(150);
    const image = await guest.capturePage();
    return image.toPNG();
  })) return attempts;
  if (await tryOne('bringToFront', async () => {
    await send(guest, 'Page.bringToFront', {}, 5000);
    await delay(250);
    const shot = await send(guest, 'Page.captureScreenshot', { format: 'png' }, 6000);
    return Buffer.from(shot.data, 'base64');
  })) return attempts;
  if (await tryOne('fromSurfaceFalse', async () => {
    const shot = await send(guest, 'Page.captureScreenshot', { format: 'png', fromSurface: false }, 6000);
    return Buffer.from(shot.data, 'base64');
  })) return attempts;
  await tryOne('invalidateCdp', async () => {
    guest.invalidate();
    await delay(250);
    const shot = await send(guest, 'Page.captureScreenshot', { format: 'png' }, 6000);
    return Buffer.from(shot.data, 'base64');
  });
  return attempts;
}

function textShot(nodes) {
  const lines = [];
  for (const node of nodes) {
    if (!node.role || node.ignored) continue;
    const role = node.role.value;
    const name = node.name?.value ? ` "${String(node.name.value).slice(0, 80)}"` : '';
    lines.push(`- ${role}${name}`);
  }
  return lines.join('\n');
}

async function main() {
  const tests = [];
  const report = { startedAt: new Date().toISOString(), versions: { electron: process.versions.electron, chrome: process.versions.chrome }, tests, summary: {} };

  async function run(name, fn) {
    const started = Date.now();
    try {
      const detail = await withTimeout(Promise.resolve().then(fn), 30000, name);
      tests.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? null });
      return detail;
    } catch (error) {
      tests.push({ name, ok: false, ms: Date.now() - started, error: error?.message || String(error) });
      return null;
    }
  }

  const { server, port } = await startServer();
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.on('did-attach-webview', (_event, guest, params) => {
    console.log('ATTACHED', guest.id, params?.src, guest.getURL());
    guest.on('did-fail-load', (_e, code, desc, url) => console.log('GUEST FAIL', code, desc, url));
  });

  await win.loadURL(`http://127.0.0.1:${port}/embedder`);

  const mainGuest = await run('guest-main-attached', () => waitGuest('/'));
  const offGuest = await run('guest-offscreen-attached', () => waitGuest('/offscreen'));
  const noneGuest = await run('guest-displaynone-attached', () => waitGuest('/hidden'));

  if (!mainGuest) throw new Error('main guest missing');

  const attached = await run('cdp-attach', async () => {
    attach(mainGuest);
    return { attached: mainGuest.debugger.isAttached() };
  });

  await run('cdp-enable-domains', async () => {
    await send(mainGuest, 'Page.enable');
    await send(mainGuest, 'DOM.enable');
    await send(mainGuest, 'Runtime.enable');
    await send(mainGuest, 'Accessibility.enable');
    return true;
  });

  const ax = await run('ax-get-full-tree', async () => {
    const result = await send(mainGuest, 'Accessibility.getFullAXTree', {});
    const nodes = result.nodes || [];
    const json = JSON.stringify(nodes);
    const text = textShot(nodes);
    const buttons = nodes.filter(n => n.role?.value === 'button').map(n => ({
      name: n.name?.value || '', backendNodeId: n.backendDOMNodeId || null,
    }));
    const go = buttons.find(b => b.name === 'Go');
    return {
      nodes: nodes.length,
      withBackendNodeId: nodes.filter(n => n.backendDOMNodeId).length,
      jsonBytes: Buffer.byteLength(json),
      textBytes: Buffer.byteLength(text),
      textLines: text.split('\n').length,
      buttons,
      goBackendNodeId: go?.backendNodeId || null,
      hasShadowButton: buttons.some(b => b.name === 'Shadow'),
      hasLateButton: buttons.some(b => b.name === 'Late'),
    };
  });

  const clicked = await run('real-click-via-cdp', async () => {
    if (!ax?.goBackendNodeId) throw new Error('no Go backendNodeId');
    const { object } = await send(mainGuest, 'DOM.resolveNode', { backendNodeId: ax.goBackendNodeId });
    if (!object?.objectId) throw new Error('resolveNode returned no objectId');
    const rect = await send(mainGuest, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: "function(){ this.scrollIntoView({block:'center'}); const r=this.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }",
      returnByValue: true,
    });
    const box = rect.result?.value;
    if (!box) throw new Error('no rect');
    const x = Math.round(box.x + box.w / 2);
    const y = Math.round(box.y + box.h / 2);
    await send(mainGuest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send(mainGuest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await delay(250);
    const result = await send(mainGuest, 'Runtime.evaluate', { expression: 'document.querySelector("#result").textContent', returnByValue: true });
    return { x, y, result: result.result?.value };
  });

  const visibleShot = await run('screenshot-visible', async () => {
    const shot = await send(mainGuest, 'Page.captureScreenshot', { format: 'png' });
    return bytesOf('visible', shot.data);
  });

  const fullShot = await run('screenshot-full-page', async () => {
    const metrics = await send(mainGuest, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size) throw new Error('no content size');
    const shot = await send(mainGuest, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
    }, 20000);
    return { ...bytesOf('full-page', shot.data), content: size };
  });

  const lateAx = await run('ax-after-mutation', async () => {
    await delay(1000);
    const result = await send(mainGuest, 'Accessibility.getFullAXTree', {});
    const nodes = result.nodes || [];
    return {
      nodes: nodes.length,
      lateButton: nodes.some(n => n.role?.value === 'button' && n.name?.value === 'Late'),
    };
  });

  const offShot = await run('screenshot-offscreen-tab', async () => {
    if (!offGuest) throw new Error('no offscreen guest');
    attach(offGuest);
    await send(offGuest, 'Page.enable');
    return attemptShot(offGuest, 'offscreen');
  });

  const noneShot = await run('screenshot-displaynone-tab', async () => {
    if (!noneGuest) throw new Error('no display:none guest');
    attach(noneGuest);
    await send(noneGuest, 'Page.enable');
    const direct = await attemptShot(noneGuest, 'displaynone');
    if (direct.some(item => item.ok)) return { direct };
    await win.webContents.executeJavaScript("document.getElementById('none').style.display='block'");
    await delay(600);
    const activated = await attemptShot(noneGuest, 'displaynone-activated');
    await win.webContents.executeJavaScript("document.getElementById('none').style.display='none'");
    return { direct, activated };
  });

  const hiddenWindowShot = await run('screenshot-window-hidden', async () => {
    win.hide();
    await delay(700);
    const hidden = await attemptShot(mainGuest, 'window-hidden');
    win.show();
    await delay(600);
    const visibleAgain = await attemptShot(mainGuest, 'window-visible-again');
    return { hidden, visibleAgain };
  });

  const dialog = await run('handle-js-dialog', async () => {
    const opening = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no dialog event')), 8000);
      const onMessage = (_event, method, params) => {
        if (method !== 'Page.javascriptDialogOpening') return;
        clearTimeout(timer);
        mainGuest.debugger.removeListener('message', onMessage);
        resolve(params);
      };
      mainGuest.debugger.on('message', onMessage);
    });
    const evaluation = send(mainGuest, 'Runtime.evaluate', { expression: 'alert("hi")', userGesture: true }, 12000).catch(error => ({ error: error.message }));
    const params = await opening;
    await send(mainGuest, 'Page.handleJavaScriptDialog', { accept: true });
    const settled = await withTimeout(evaluation, 8000, 'alert-eval-settled');
    const after = await send(mainGuest, 'Runtime.evaluate', { expression: '1+1', returnByValue: true });
    return { type: params.type, message: params.message, settled: Boolean(settled), after: after.result?.value };
  });

  const frame = await run('ax-frame-tree', async () => {
    const { frameTree } = await send(mainGuest, 'Page.getFrameTree');
    const child = frameTree?.childFrames?.[0]?.frame;
    if (!child) return { childFrames: 0 };
    const result = await send(mainGuest, 'Accessibility.getFullAXTree', { frameId: child.id });
    const nodes = result.nodes || [];
    return {
      frameId: child.id, url: child.url, nodes: nodes.length,
      frameButton: nodes.some(n => n.role?.value === 'button' && n.name?.value === 'Frame Button'),
    };
  });

  const shotOk = value => Array.isArray(value) ? value.some(item => item.ok) : (value?.bytes || 0) > 1000;
  report.summary = {
    attach: attached?.attached === true,
    axBackendIds: (ax?.withBackendNodeId || 0) > 0,
    goButtonFound: Boolean(ax?.goBackendNodeId),
    clickChangedDom: clicked?.result === 'clicked',
    visibleScreenshot: shotOk(visibleShot),
    fullPageScreenshot: shotOk(fullShot),
    offscreenScreenshot: shotOk(offShot),
    displayNoneScreenshot: shotOk(noneShot?.activated) || shotOk(noneShot?.direct),
    displayNoneScreenshotAfterActivate: shotOk(noneShot?.activated),
    windowHiddenScreenshot: shotOk(hiddenWindowShot?.hidden),
    windowVisibleAgain: shotOk(hiddenWindowShot?.visibleAgain),
    dialogHandled: dialog?.after === 2,
    frameAx: frame?.frameButton === true,
    shadowButtonInAx: ax?.hasShadowButton === true,
    lateButtonInAx: lateAx?.lateButton === true,
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  server.close();
  win.destroy();
  return report;
}

const hardTimeout = setTimeout(() => {
  console.error('SPIKE HARD TIMEOUT');
  app.exit(3);
}, 150000);
hardTimeout.unref?.();

app.whenReady().then(async () => {
  try {
    const report = await main();
    const failed = Object.entries(report.summary).filter(([, value]) => value !== true).map(([key]) => key);
    console.log(failed.length ? `FAILED CHECKS: ${failed.join(', ')}` : 'ALL CHECKS PASSED');
    app.exit(failed.length ? 1 : 0);
  } catch (error) {
    console.error('SPIKE ERROR', error);
    try {
      const partial = path.join(OUT, 'error.txt');
      fs.writeFileSync(partial, String(error?.stack || error));
    } catch { /* best effort */ }
    app.exit(2);
  }
});
