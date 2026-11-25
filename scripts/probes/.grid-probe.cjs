'use strict';
// 网格标尺：先把微信摆到固定位置并置前，再全屏画 DIP 坐标网格，用来读“输入框到底在哪个坐标”
const path = require('node:path');
const fs = require('node:fs');
const { app, screen, desktopCapturer, BrowserWindow } = require('electron');
const koffi = require('koffi');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'design', 'e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user32 = koffi.load('user32.dll');
const SetWindowPos = user32.func('bool SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const ShowWindow = user32.func('bool ShowWindow(intptr_t h, int cmd)');

const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font:10px/1 "Consolas","Microsoft YaHei",monospace;color:#7fe3ff}
  #g{position:fixed;inset:0}
  .v,.h{position:absolute;background:rgba(0,200,255,.28)}
  .v{top:0;bottom:0;width:1px}
  .h{left:0;right:0;height:1px}
  .v.major,.h.major{background:rgba(0,255,180,.55)}
  .l{position:absolute;padding:1px 3px;background:rgba(0,0,0,.55);border-radius:3px;
    color:#8ef;white-space:nowrap}
  .l.x{transform:translateX(-50%)}
</style></head><body><div id="g"></div><script>
  const W = innerWidth, H = innerHeight, g = document.getElementById('g');
  const step = 50, major = 200;
  for (let x = 0; x <= W; x += step) {
    const d = document.createElement('div');
    d.className = 'v' + (x % major === 0 ? ' major' : '');
    d.style.left = x + 'px'; g.appendChild(d);
    if (x % major === 0) {
      const t = document.createElement('div');
      t.className = 'l x'; t.style.left = x + 'px'; t.style.top = '2px'; t.textContent = x;
      g.appendChild(t);
    }
  }
  for (let y = 0; y <= H; y += step) {
    const d = document.createElement('div');
    d.className = 'h' + (y % major === 0 ? ' major' : '');
    d.style.top = y + 'px'; g.appendChild(d);
    if (y % major === 0) {
      const t = document.createElement('div');
      t.className = 'l'; t.style.left = '2px'; t.style.top = (y + 1) + 'px'; t.textContent = y;
      g.appendChild(t);
    }
  }
</script></body></html>`;

(async () => {
  await app.whenReady();

  // 1) 微信摆到固定位置并置前（否则网格下看不见它）
  const engine = createDesktopEngine({ app, screen, input, policy, settings: { enabled: true } });
  const rows = await engine.windows.list({ includeMinimized: true });
  const list = Array.isArray(rows) ? rows : rows.windows || [];
  const target = list
    .filter((w) => /微信/.test(w.title || '') && !/LoginWindow/i.test(w.className || ''))
    .map((w) => ({ ...w, box: Array.isArray(w.rect) ? { x: w.rect[0], y: w.rect[1], w: w.rect[2], h: w.rect[3] } : w.rect }))
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
  if (target) {
    ShowWindow(target.hwnd, 9);
    SetWindowPos(target.hwnd, -1, 60, 40, 1000, 800, 0x0040);
    await engine.windows.activate(target.hwnd);
    await sleep(900);
    console.log('[grid] wechat', JSON.stringify({ hwnd: target.hwnd, box: target.box }));
  } else {
    console.log('[grid] wechat not found');
  }

  const d = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.showInactive();
  await sleep(900);

  const sf = d.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
  });
  fs.writeFileSync(path.join(outDir, 'grid.png'), sources[0].thumbnail.toPNG());
  console.log('[grid] saved design/e2e/grid.png display', JSON.stringify({ size: d.size, scaleFactor: sf, bounds: d.bounds }));
  win.destroy();
  app.exit(0);
})().catch((e) => { console.error('[grid] failed', e); app.exit(1); });
