'use strict';
// Real public-site interaction smoke: one link click and one multi-field form.
// No login, no writes beyond the public form's own GET submit.
// Run: npx electron scripts/browser-real-interactions.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserController } = require('../electron/browser/controller.cjs');
const { createCredentialBroker } = require('../electron/browser/credentials.cjs');

const OUT = path.join(__dirname, '..', 'design', 'real-interactions.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mova-real-interactions-'));
  const win = new BrowserWindow({
    width: 1180, height: 820, show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
  });
  const vaultEntries = new Map();
  const fakeVault = {
    async status() { return { configured: true, unlocked: true, count: vaultEntries.size }; },
    async put(input) { vaultEntries.set(input.name, input.value); return { updatedAt: new Date().toISOString() }; },
    async get(name) {
      if (!vaultEntries.has(name)) { const error = new Error('not-found'); error.code = 'not-found'; throw error; }
      return vaultEntries.get(name);
    },
    async list() { return [...vaultEntries.keys()].map(name => ({ name, kind: 'password', preview: '****', updatedAt: new Date().toISOString() })); },
  };
  const credentials = createCredentialBroker({ getVault: () => fakeVault });
  const controller = createBrowserController({ app, getWindow: () => win, credentials });
  win.webContents.on('did-attach-webview', (_event, guest) => { void controller.registerGuest(guest); });
  await win.loadFile(path.join(__dirname, 'browser-spike-embedder.html'));
  await delay(400);

  const results = [];
  async function task(name, fn) {
    const started = Date.now();
    try {
      const detail = await Promise.race([fn(), delay(60000).then(() => { throw new Error('task timeout'); })]);
      results.push({ name, ok: true, ms: Date.now() - started, detail });
      console.log(`PASS ${name} ${Date.now() - started}ms`);
    } catch (error) {
      results.push({ name, ok: false, ms: Date.now() - started, error: error?.code ? `${error.code}: ${error.message}` : (error?.message || 'failed') });
      console.log(`FAIL ${name} ${Date.now() - started}ms — ${error?.message || error}`);
    }
  }

  await task('selenium-link-click', async () => {
    await controller.navigate('https://www.selenium.dev/selenium/web/web-form.html');
    const snap = await controller.snapshot({ mode: 'full' });
    const match = snap.text.match(/link "Return to index" \[ref=([^\]]+)\]/);
    await controller.act({ action: 'click', target: match ? `@${match[1]}` : 'css=a[href="./index.html"]', snapshot: false });
    await controller.wait({ for: 'url', url: 'index.html', timeout: 20000 });
    await controller.wait({ for: 'load', timeout: 10000 }).catch(() => {});
    await delay(300);
    const after = await controller.snapshot({ mode: 'full', maxChars: 4000 });
    // This page fills its body from a GitHub API call, so assert navigation and
    // title, not body text that may still be loading.
    if (!String(after.title).toLowerCase().includes('index of available pages')) {
      throw new Error(`target title missing: ${after.url} ${after.title}`);
    }
    return { ref: match ? match[1] : 'css', url: after.url, title: after.title };
  });

  await task('selenium-form', async () => {
    await controller.navigate('https://www.selenium.dev/selenium/web/web-form.html');
    const batch = await controller.batch([
      { op: 'fill', target: 'css=#my-text-id', value: 'Mova' },
      { op: 'fill', target: 'css=textarea[name=my-textarea]', value: 'real-site smoke' },
      { op: 'select', target: 'css=select[name=my-select]', value: '2' },
      { op: 'click', target: 'css=button[type=submit]', expect: { url: 'submitted-form' } },
    ], { snapshot: 'end' });
    if (!batch.ok) throw new Error(`form batch failed: ${JSON.stringify(batch.steps)}`);
    await controller.wait({ for: 'url', url: 'submitted-form', timeout: 20000 }).catch(() => {});
    await controller.wait({ for: 'load', timeout: 10000 }).catch(() => {});
    await delay(300);
    const read = await controller.read({ maxChars: 3000 });
    if (!read.text.toLowerCase().includes('form submitted')) {
      throw new Error(`submit page missing: ${read.url} ${read.text.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
    return { steps: batch.steps.length, url: read.url };
  });

  await task('selenium-login', async () => {
    await credentials.save({ origin: 'https://www.selenium.dev', username: 'username', password: 'password' });
    await controller.navigate('https://www.selenium.dev/selenium/web/login.html');
    const login = await controller.login({ submit: true });
    if (!String(login.dialog?.message || '').includes('successfully logged in')) {
      throw new Error(`login dialog: ${JSON.stringify(login.dialog || null)}`);
    }
    return { dialog: login.dialog.message };
  });

  const passed = results.filter(row => row.ok).length;
  const report = {
    generatedAt: new Date().toISOString(),
    environment: { electron: process.versions.electron, chrome: process.versions.chrome },
    summary: { tasks: results.length, passed, successRate: Math.round((passed / results.length) * 100) },
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));

  await controller.close();
  win.destroy();
}

const hard = setTimeout(() => { console.error('REAL INTERACTIONS TIMEOUT'); app.exit(3); }, 180000);
hard.unref?.();
app.whenReady().then(async () => {
  try { await main(); app.exit(0); }
  catch (error) { console.error('REAL INTERACTIONS ERROR', error?.stack || error); app.exit(1); }
});
