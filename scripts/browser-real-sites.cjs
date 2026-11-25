'use strict';
// Read-only real-site smoke/benchmark. It uses the same controller as the chat,
// but only navigates, snapshots and reads; no writes, no clicks.
// Run: npx electron scripts/browser-real-sites.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserController } = require('../electron/browser/controller.cjs');

const SITES = [
  { name: 'example.com', url: 'https://example.com/', expect: 'Example Domain' },
  { name: 'iana-example-domains', url: 'https://www.iana.org/help/example-domains', expect: 'Example Domains' },
  { name: 'mdn-fetch', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', expect: 'Fetch API' },
];

const OUT = path.join(__dirname, '..', 'design', 'real-sites.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mova-real-sites-'));
  const win = new BrowserWindow({
    width: 1180, height: 820, show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
  });
  const controller = createBrowserController({ app, getWindow: () => win });
  win.webContents.on('did-attach-webview', (_event, guest) => { void controller.registerGuest(guest); });
  await win.loadFile(path.join(__dirname, 'browser-spike-embedder.html'));
  await delay(400);

  const results = [];
  for (const site of SITES) {
    const started = Date.now();
    const row = { name: site.name, url: site.url, ok: false, ms: 0 };
    try {
      const nav = await Promise.race([
        controller.navigate(site.url).then(value => value),
        delay(45000).then(() => { throw new Error('navigation timeout'); }),
      ]);
      await delay(700);
      const snap = await controller.snapshot({ mode: 'full', maxChars: 24000 });
      const read = await controller.read({ maxChars: 20000 });
      row.ok = true;
      row.title = nav.title || snap.title || '';
      row.snapshotChars = snap.text.length;
      row.snapshotMode = snap.mode;
      row.readChars = read.text.length;
      row.expectFound = `${read.text} ${row.title}`.toLowerCase().includes(String(site.expect).toLowerCase());
      row.head = read.text.slice(0, 120).replace(/\s+/g, ' ');
      if (!row.expectFound) { row.ok = false; row.error = `missing "${site.expect}"`; }
    } catch (error) {
      row.error = error?.code ? `${error.code}: ${error.message}` : (error?.message || 'failed');
    }
    row.ms = Date.now() - started;
    results.push(row);
    console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name} ${row.ms}ms ${row.snapshotChars || 0} snapshot / ${row.readChars || 0} read${row.error ? ` — ${row.error}` : ''}`);
  }

  const passed = results.filter(row => row.ok).length;
  const report = {
    generatedAt: new Date().toISOString(),
    environment: { electron: process.versions.electron, chrome: process.versions.chrome },
    summary: { sites: results.length, passed, successRate: Math.round((passed / results.length) * 100) },
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));

  await controller.close();
  win.destroy();
}

const hard = setTimeout(() => { console.error('REAL SITES TIMEOUT'); app.exit(3); }, 180000);
hard.unref?.();
app.whenReady().then(async () => {
  try { await main(); app.exit(0); }
  catch (error) { console.error('REAL SITES ERROR', error?.stack || error); app.exit(1); }
});
