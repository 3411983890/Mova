'use strict';
// Does a <webview> with no src attach after Mova's will-attach-webview guard
// rejects the initial empty-src attachment? This decides whether
// browser_navigate can create the first tab from an untouched panel.
// Run with: npx electron scripts/browser-spike-attach.cjs

const { app, BrowserWindow } = require('electron');
const http = require('node:http');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Attach Fixture</title><h1>Attach Fixture</h1>');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

app.whenReady().then(async () => {
  const { server, port } = await startServer();
  const events = [];
  const win = new BrowserWindow({
    width: 900, height: 700, show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
  });
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    events.push({ type: 'will-attach', src: params.src || '' });
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    if (params.preload || params.allowpopups || !/^https?:\/\//i.test(params.src || '')) {
      events.push({ type: 'blocked', src: params.src || '' });
      event.preventDefault();
    }
  });
  win.webContents.on('did-attach-webview', (_event, guest, params) => {
    events.push({ type: 'attached', src: params?.src || '', url: guest.getURL() });
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    '<!doctype html><body><webview id="w" style="display:none"></webview></body>',
  ));
  await delay(400);
  events.push({ type: 'after-load', webviews: win.webContents.executeJavaScript('document.querySelectorAll("webview").length') });
  await win.webContents.executeJavaScript(`document.getElementById('w').src='http://127.0.0.1:${port}/'; true;`);
  await delay(1200);
  const report = {
    events,
    guestCount: require('electron').webContents.getAllWebContents().filter(wc => wc.getType() === 'webview').length,
  };
  console.log(JSON.stringify(report, null, 2));
  server.close();
  win.destroy();
  app.exit(report.guestCount > 0 ? 0 : 1);
}).catch(error => { console.error(error); app.exit(2); });
