'use strict';
// 探针：为什么 activate 抢不到前台？对比 UIA activate / 点击标题栏 两种方式。
const path = require('node:path');
const fs = require('node:fs');
const { app, screen } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));

const out = path.join(root, 'design', 'e2e', 'probe-activate.log');
const log = (...a) => {
  const line = [JSON.stringify(a.length === 1 ? a[0] : a)].join(' ');
  try { fs.appendFileSync(out, line + '\n', 'utf8'); } catch { /* ignore */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try { fs.writeFileSync(out, ''); } catch { /* ignore */ }
  await app.whenReady();
  const engine = createDesktopEngine({
    app, screen, input,
    settings: { enabled: true, profile: 'full' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sharp: require('sharp'),
  });
  await engine.start();
  const rows = await engine.windows.list({ includeMinimized: true });
  const list = Array.isArray(rows) ? rows : rows.windows || [];
  const notepad = list.find((w) => /notepad\.exe$/i.test(String(w.exe || '')));
  log({ step: 'list', notepad: notepad && { hwnd: notepad.hwnd, rect: notepad.rect }, fg: await engine.windows.foreground() });

  const activated = await engine.windows.activate(notepad.hwnd);
  await sleep(600);
  log({ step: 'activate', activated, fg: await engine.windows.foreground() });

  // 退化方案：点标题栏（安全，不改文档内容）
  const rect = Array.isArray(notepad.rect)
    ? { x: notepad.rect[0], y: notepad.rect[1], w: notepad.rect[2], h: notepad.rect[3] }
    : notepad.rect;
  const titlePoint = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + 18) };
  await input.click(titlePoint);
  await sleep(600);
  log({ step: 'click-title', point: titlePoint, fg: await engine.windows.foreground() });

  await engine.dispose().catch(() => {});
  app.exit(0);
})().catch((error) => {
  log({ step: 'failed', error: String(error && error.stack ? error.stack : error) });
  app.exit(1);
});
