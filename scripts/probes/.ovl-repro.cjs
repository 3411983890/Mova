'use strict';
// 复现：像 main.cjs 那样“在 app ready 之前”创建 overlay，再 ready 后 show
const path = require('node:path');
const fs = require('node:fs');
const { app, screen, BrowserWindow } = require('electron');
const { createOverlay } = require(path.join(__dirname, '..', 'electron', 'desktop', 'overlay', 'overlay.cjs'));

const log = (...a) => console.log('[ovl-repro]', ...a);

let overlay = null;
try {
  overlay = createOverlay({ app, screen, logger: { warn: (...a) => log('WARN', ...a), info: (...a) => log('INFO', ...a) } });
  log('createOverlay ok (before ready)');
} catch (error) {
  log('createOverlay threw before ready:', error && error.message);
}

app.whenReady().then(async () => {
  log('ready; overlay ?', !!overlay);
  if (!overlay) { app.exit(0); return; }
  try {
    const shown = overlay.show({ emotion: '32' });
    log('show ->', JSON.stringify(shown));
  } catch (error) {
    log('show threw:', error && error.message);
  }
  await new Promise((r) => setTimeout(r, 1200));
  log('exists', overlay.exists());
  for (const win of BrowserWindow.getAllWindows()) {
    const img = await win.webContents.capturePage().catch(() => null);
    if (img) {
      fs.writeFileSync(path.join(__dirname, '..', 'design', 'e2e', 'ovl-repro.png'), img.toPNG());
      log('captured window', win.id, img.getSize());
    }
  }
  overlay.hide();
  overlay.dispose();
  await new Promise((r) => setTimeout(r, 200));
  app.exit(0);
}).catch((e) => { log('failed', e && e.message); app.exit(1); });
