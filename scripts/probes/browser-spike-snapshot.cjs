'use strict';
// M1 smoke: drive PageTarget against the real CDP pipe and inspect the compact
// snapshot + diff it produces. Run with:
//   npx electron scripts/browser-spike-snapshot.cjs

const { app, BrowserWindow, webContents } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PageTarget } = require('../../electron/browser/target.cjs');

const OUT = path.join(__dirname, '..', 'design', 'browser-spike');
fs.mkdirSync(OUT, { recursive: true });

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Orders</title>',
  '<style>body{font:14px system-ui;margin:16px} input{padding:4px}</style></head><body>',
  '<h1>Orders</h1>',
  '<label for="q">Search</label><input id="q" aria-label="Search" value="A-10">',
  '<button id="go">Go</button>',
  '<div id="result">idle</div>',
  '<table aria-label="Orders"><thead><tr><th>ID</th><th>Status</th></tr></thead>',
  '<tbody><tr><td>A-1024</td><td>Shipped</td></tr></tbody></table>',
  '<script>document.getElementById("go").addEventListener("click", () => {',
  'document.getElementById("result").textContent = "clicked";',
  'const dialog = document.createElement("div"); dialog.setAttribute("role","dialog");',
  'dialog.setAttribute("aria-label","Export"); dialog.innerHTML = "<p>Export 1 order?</p><button>Confirm</button>";',
  'document.body.append(dialog); });</script></body></html>',
].join('');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitGuest(timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview');
    if (guest && !guest.isLoading()) return guest;
    await delay(100);
  }
  throw new Error('guest not ready');
}

async function main() {
  const { server, port } = await startServer();
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
  });
  await win.loadFile(path.join(__dirname, 'browser-spike-embedder.html'));
  const guest = await waitGuest();
  const target = await PageTarget.create({ guest, tabId: 't1', spaceId: 's1', visible: true });
  const nav = await target.navigate(`http://127.0.0.1:${port}/`);

  const first = await target.snapshot({ mode: 'full' });
  fs.writeFileSync(path.join(OUT, 'snapshot-full.txt'), first.text);

  const read = await target.read({ maxChars: 2000 });
  const waited = await target.wait({ for: 'selector', selector: '#result', state: 'visible', timeout: 2000 });

  await target.cdp.send('Runtime.evaluate', { expression: 'document.getElementById("go").click()' });
  await target.wait({ for: 'text', text: 'clicked', timeout: 3000 });
  const second = await target.snapshot({ mode: 'auto' });
  fs.writeFileSync(path.join(OUT, 'snapshot-diff.txt'), second.text);

  win.show();
  win.focus();
  await delay(400);
  const shot = await target.screenshot();
  fs.writeFileSync(path.join(OUT, 'snapshot-visible.png'), shot.buffer);

  const report = {
    nav,
    first: { mode: first.mode, chars: first.text.length, lines: first.entries.length },
    read: { chars: read.text.length, title: read.title, head: read.text.slice(0, 120) },
    waited: waited.ms,
    second: { mode: second.mode, chars: second.text.length, lines: second.entries.length, text: second.text },
    screenshot: { bytes: shot.buffer.length, width: shot.width, height: shot.height },
    head: first.text.split('\n').slice(0, 14),
  };
  fs.writeFileSync(path.join(OUT, 'snapshot-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await target.close();
  win.destroy();
  server.close();
}

const hard = setTimeout(() => { console.error('SNAPSHOT SPIKE TIMEOUT'); app.exit(3); }, 60000);
hard.unref?.();

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (error) {
    console.error('SNAPSHOT SPIKE ERROR', error?.stack || error);
    app.exit(1);
  }
});
