'use strict';
// Passive takeover smoke: a real user input event (sendInputEvent) pauses the
// agent and the banner's resume action releases it.
// Run: npx electron scripts/passive-takeover-check.cjs

const { app, BrowserWindow, webContents } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserController } = require('../../electron/browser/controller.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mova-passive-'));
  const win = new BrowserWindow({
    width: 1000, height: 760, show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
  });
  const controller = createBrowserController({ app, getWindow: () => win, downloadsDir: directory });
  let takeover = null;
  let closed = null;
  const rawSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'browser:takeover') takeover = payload;
    if (channel === 'browser:takeover:close') closed = payload;
    return rawSend(channel, payload);
  };
  win.webContents.on('did-attach-webview', (_event, guest) => { void controller.registerGuest(guest); });
  await win.loadFile(path.join(__dirname, 'browser-spike-embedder.html'));
  await delay(600);

  const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview');
  if (!guest) throw new Error('guest missing');
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
  for (let i = 0; i < 30 && !takeover; i += 1) await delay(100);
  if (!takeover) throw new Error('no passive takeover event');
  if (takeover.reason !== 'user-input') throw new Error(`wrong reason ${takeover.reason}`);

  let blocked = null;
  try { await controller.snapshot({ mode: 'full' }); } catch (error) { blocked = error.code; }
  if (blocked !== 'human-in-control') throw new Error(`not blocked: ${blocked}`);
  controller.respondHandoff(takeover.id, 'resume');
  await delay(200);
  const after = await controller.snapshot({ mode: 'full' });

  console.log(JSON.stringify({ takeover, blocked, closed, resumed: after.mode }, null, 2));
  await controller.close();
  win.destroy();
}

const hard = setTimeout(() => { console.error('PASSIVE CHECK TIMEOUT'); app.exit(3); }, 30000);
hard.unref?.();
app.whenReady().then(async () => {
  try { await main(); app.exit(0); }
  catch (error) { console.error('PASSIVE CHECK ERROR', error?.stack || error); app.exit(1); }
});
