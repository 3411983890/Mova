'use strict';
// 诊断：微信输入框到底吃哪种输入方式（unicode SendInput vs 剪贴板粘贴）
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, screen, desktopCapturer } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));
const { createGuard } = require(path.join(root, 'electron', 'desktop', 'guard.cjs'));
const { createOverlay } = require(path.join(root, 'electron', 'desktop', 'overlay', 'overlay.cjs'));

const outDir = path.join(root, 'design', 'e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const l = '[type-probe] ' + a.join(' '); console.log(l); try { fs.appendFileSync(path.join(outDir, 'type-probe.log'), l + '\n'); } catch {} };

async function shot(name) {
  const d = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width * (d.scaleFactor || 1), height: d.size.height * (d.scaleFactor || 1) } });
  fs.writeFileSync(path.join(outDir, name), sources[0].thumbnail.toPNG());
}

(async () => {
  await app.whenReady();
  const guard = createGuard({ onAbort: () => {} });
  const overlay = createOverlay({ app, screen });
  const engine = createDesktopEngine({ app, screen, input, policy, guard, overlay, settings: { enabled: true } });

  const rows = await engine.windows.list({ includeMinimized: true });
  const list = Array.isArray(rows) ? rows : rows.windows || [];
  const target = list.filter((w) => /微信/.test(w.title || '') && !/LoginWindow/i.test(w.className || ''))
    .map((w) => ({ ...w, box: Array.isArray(w.rect) ? { x: w.rect[0], y: w.rect[1], w: w.rect[2], h: w.rect[3] } : w.rect }))
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
  if (!target) { log('no wechat'); app.exit(2); return; }

  await engine.windows.activate(target.hwnd);
  await sleep(500);
  const { x, y, w, h } = target.box;
  log('window', JSON.stringify({ x, y, w, h }));

  const inputX = x + Math.round(w * 0.5);
  const inputY = y + Math.round(h * 0.62);
  await engine.actions.click({ x: inputX, y: inputY });
  await sleep(400);
  await shot('probe-1-clicked.png');
  log('clicked input', inputX, inputY, 'cursor', JSON.stringify(input.cursor()));

  // A: unicode SendInput
  const a = await engine.actions.type('HELLO123').catch((e) => ({ ok: false, code: e.code, message: e.message }));
  await sleep(500);
  await shot('probe-2-unicode.png');
  log('typeText', JSON.stringify(a));

  // 清空
  input.pressCombo('ctrl+a');
  await sleep(150);
  input.pressCombo('delete');
  await sleep(300);

  // B: 剪贴板 + Ctrl+V
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "Set-Clipboard -Value 'CLIPBOARD-测试OK'"]);
  await sleep(300);
  input.pressCombo('ctrl+v');
  await sleep(600);
  await shot('probe-3-clipboard.png');
  log('clipboard paste done');

  await engine.dispose();
  overlay.dispose();
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
