'use strict';
// Tab protocol smoke: renderer-created webviews -> tabReady/tabActive ->
// controller tabs, new/select/close. Run with:
//   npx electron scripts/browser-spike-tabs.cjs

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { createBrowserController } = require('../../electron/browser/controller.cjs');

const OUT = path.join(__dirname, '..', 'design', 'browser-spike');
fs.mkdirSync(OUT, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((req, res) => {
    const name = req.url.includes('two') ? 'Two' : 'One';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${name}</title><h1>${name}</h1><button>${name} Button</button>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function call(tools, name, args) {
  const tool = tools.find(item => item.name === name);
  const result = await tool.execute(`${name}-${Date.now()}`, args);
  let value = null;
  try { value = JSON.parse(result.content?.[0]?.text || ''); } catch { value = result.content?.[0]?.text; }
  return { isError: result.isError === true, value };
}

async function main() {
  const { server, port } = await startServer();
  const win = new BrowserWindow({
    width: 1000, height: 760, show: true,
    webPreferences: {
      preload: path.join(__dirname, 'browser-spike-tabs-preload.cjs'),
      webviewTag: true, contextIsolation: true, sandbox: false,
    },
  });
  const controller = createBrowserController({ app, getWindow: () => win });
  ipcMain.on('browser:tab:ready', (_event, payload) => controller.tabReady(payload?.tabId, payload?.guestId, payload?.spaceId));
  ipcMain.on('browser:tab:active', (_event, payload) => controller.tabActive(payload?.tabId, payload?.spaceId));
  ipcMain.on('browser:tab:closed', (_event, payload) => controller.tabClosed(payload?.tabId));
  win.webContents.on('did-attach-webview', (_event, guest) => { void controller.registerGuest(guest); });
  win.webContents.on('console-message', (_event, level, message) => console.log('PAGE:', level, message));
  const rawSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel.startsWith('browser:tab:')) console.log('SEND', channel, JSON.stringify(payload));
    return rawSend(channel, payload);
  };
  await win.loadFile(path.join(__dirname, 'browser-spike-tabs.html'));
  console.log('tabs api:', await win.webContents.executeJavaScript('typeof window.tabs'));
  const tools = controller.tools({ approve: async () => 'once' });

  const nav = await call(tools, 'browser_navigate', { url: `http://127.0.0.1:${port}/one` });
  await delay(400);
  const second = await call(tools, 'browser_tabs', { action: 'new', url: `http://127.0.0.1:${port}/two` });
  await delay(400);
  const third = await call(tools, 'browser_tabs', { action: 'new', url: `http://127.0.0.1:${port}/three`, space: 'space-2' });
  await delay(400);
  const list2 = await call(tools, 'browser_tabs', { action: 'list' });
  const tabs2 = list2.value?.tabs || [];
  const firstId = tabs2.find(tab => tab.spaceId === 'default' && tab.tabId !== second.value?.tabId)?.tabId;
  const selected = await call(tools, 'browser_tabs', { action: 'select', tabId: firstId });
  await delay(200);
  const closed = await call(tools, 'browser_tabs', { action: 'close', tabId: second.value?.tabId });
  await delay(300);
  const list1 = await call(tools, 'browser_tabs', { action: 'list' });

  const report = {
    nav: nav.value,
    second: second.value,
    third: third.value,
    list2: tabs2,
    selected: selected.value,
    closed: closed.value,
    list1: list1.value?.tabs,
  };
  fs.writeFileSync(path.join(OUT, 'tabs-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await controller.close();
  win.destroy();
  server.close();
}

const hard = setTimeout(() => { console.error('TABS SPIKE TIMEOUT'); app.exit(3); }, 60000);
hard.unref?.();

app.whenReady().then(async () => {
  try { await main(); app.exit(0); }
  catch (error) { console.error('TABS SPIKE ERROR', error?.stack || error); app.exit(1); }
});
