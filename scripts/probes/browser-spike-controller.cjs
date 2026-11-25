'use strict';
// End-to-end controller/tool smoke: real webview -> PageTarget -> tools.
// Run with: npx electron scripts/browser-spike-controller.cjs

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserController } = require('../../electron/browser/controller.cjs');
const { createProcedureStore } = require('../../electron/browser/procedures.cjs');

const OUT = path.join(__dirname, '..', 'design', 'browser-spike');
fs.mkdirSync(OUT, { recursive: true });

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Controller Fixture</title></head><body>',
  '<main><h1>Controller Fixture</h1>',
  '<p>This page exists to prove that the tool layer can navigate, snapshot, read and screenshot.</p>',
  '<label for="q">Query</label><input id="q" aria-label="Query" value="hello">',
  '<button id="go">Run</button><button id="alert">Alert</button><div id="out">idle</div>',
  '<ul><li>Alpha</li><li>Beta</li></ul></main>',
  '<script>document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "done"; };',
  'document.getElementById("alert").onclick = () => alert("hello");</script>',
  '</body></html>',
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

async function call(tools, name, args) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error(`tool missing: ${name}`);
  const result = await tool.execute(`${name}-1`, args);
  const text = result.content?.[0]?.text || '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { isError: result.isError === true, value: parsed };
}

async function main() {
  const { server, port } = await startServer();
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
  });
  const procedures = createProcedureStore({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'mova-browser-skills-')) });
  const controller = createBrowserController({ app, getWindow: () => win, procedures });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    void controller.registerGuest(guest).catch(error => console.error('register failed', error));
  });
  await win.loadFile(path.join(__dirname, 'browser-spike-embedder.html'));
  await delay(500);

  const events = [];
  let takeoverEvent = null;
  const rawSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'browser:takeover') takeoverEvent = payload;
    return rawSend(channel, payload);
  };
  const tools = controller.tools({
    emit: event => events.push({ name: event.name, status: event.status }),
    approve: async () => 'once',
  });

  const nav = await call(tools, 'browser_navigate', { url: `http://127.0.0.1:${port}/` });
  await delay(300);
  const snap = await call(tools, 'browser_snapshot', { mode: 'full' });
  const read = await call(tools, 'browser_read', { maxChars: 4000 });
  const wait = await call(tools, 'browser_wait', { for: 'selector', selector: '#out', state: 'visible', timeout: 2000 });
  const fill = await call(tools, 'browser_act', { action: 'fill', target: 'css=#q', value: 'world' });
  const clicked = await call(tools, 'browser_act', { action: 'click', target: 'css=#go', expect: { text: 'done' } });
  const dialogAct = await call(tools, 'browser_act', { action: 'click', target: 'css=#alert' });
  const batch = await call(tools, 'browser_batch', {
    steps: [
      { op: 'fill', target: 'css=#q', value: 'batch' },
      { op: 'click', target: 'css=#go' },
    ],
  });
  const skillList = await call(tools, 'browser_skill', { action: 'list' });
  const learnedId = batch.value?.learned?.id;
  const replay = learnedId ? await call(tools, 'browser_batch', { recipe: learnedId }) : null;
  const diff = await call(tools, 'browser_snapshot', { mode: 'auto' });
  const handoffPromise = call(tools, 'browser_handoff', { reason: 'login', note: 'spike handoff' });
  for (let i = 0; i < 50 && !takeoverEvent; i += 1) await delay(100);
  const responded = takeoverEvent ? controller.respondHandoff(takeoverEvent.id, 'resume') : false;
  const handoff = await handoffPromise;

  const shot = await call(tools, 'browser_screenshot', {});
  const tabs = await call(tools, 'browser_tabs', { action: 'list' });

  const report = {
    nav,
    snapshot: { isError: snap.isError, mode: snap.value?.mode, chars: snap.value?.text?.length, head: snap.value?.text?.split('\n').slice(0, 8) },
    read: { isError: read.isError, chars: read.value?.text?.length, head: read.value?.text?.slice(0, 100) },
    wait,
    fill: { isError: fill.isError, value: fill.value?.value, diff: fill.value?.diff },
    clicked: { isError: clicked.isError, element: clicked.value?.element, diff: clicked.value?.diff },
    dialog: { isError: dialogAct.isError, dialog: dialogAct.value?.dialog },
    batch: { isError: batch.isError, ok: batch.value?.ok, steps: batch.value?.steps, snapshot: batch.value?.snapshot, learned: batch.value?.learned },
    skills: { isError: skillList.isError, skills: skillList.value?.skills },
    replay: { isError: replay?.isError, ok: replay?.value?.ok, recipe: replay?.value?.recipe, steps: replay?.value?.steps },
    handoff: { event: takeoverEvent, responded, result: handoff.value },
    diff: { isError: diff.isError, mode: diff.value?.mode, text: diff.value?.text },
    screenshot: { isError: shot.isError, bytes: shot.value?.bytes, path: shot.value?.path },
    tabs,
    events,
  };
  fs.writeFileSync(path.join(OUT, 'controller-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await controller.close();
  win.destroy();
  server.close();
}

const hard = setTimeout(() => { console.error('CONTROLLER SPIKE TIMEOUT'); app.exit(3); }, 60000);
hard.unref?.();

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (error) {
    console.error('CONTROLLER SPIKE ERROR', error?.stack || error);
    app.exit(1);
  }
});
