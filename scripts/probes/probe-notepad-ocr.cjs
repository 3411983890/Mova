'use strict';
// 一次性探针：打开记事本，抓全屏 + OCR + SoM，看看纯视觉路径能拿到什么候选框。
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; node_modules\electron\dist\electron.exe scripts/probe-notepad-ocr.cjs
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { app, screen } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));

const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const log = (...args) => console.log('[probe]', ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();
  const engine = createDesktopEngine({
    app, screen, input, policy,
    settings: { enabled: true, profile: 'full', advanced: { vision: true } },
    logger: { info: () => {}, warn: (...a) => log('warn', ...a), error: (...a) => log('err', ...a) },
    sharp: require('sharp'),
  });
  await engine.start();

  const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
  child.unref();
  await sleep(2500);

  const rows = await engine.windows.list({ includeMinimized: false });
  const list = Array.isArray(rows) ? rows : rows.windows || [];
  const notepad = list.filter((w) => /notepad|记事本/i.test(`${w.exe || ''} ${w.title || ''}`));
  log('notepad windows', notepad.map((w) => ({ hwnd: w.hwnd, title: w.title, rect: w.rect, exe: w.exe })));

  const shot = await engine.screenshot({ ocr: true, annotate: 'som' });
  log('shot', { ok: shot.ok, via: shot.via, w: shot.width, h: shot.height, origin: shot.origin, marks: (shot.marks || []).length, annotateError: shot.annotateError });
  const lines = (shot.lines || []).slice(0, 40).map((l) => ({ t: l.text, box: [l.x, l.y, l.w, l.h] }));
  log('ocr head', lines);
  if (shot.annotatedPath) log('annotated', shot.annotatedPath);
  if (shot.path) log('raw', shot.path);

  const tree = await engine.windows.tree(notepad[0] ? notepad[0].hwnd : undefined, { depth: 4 }).catch((e) => ({ error: String(e && e.message) }));
  log('uia tree', JSON.stringify(tree).slice(0, 900));

  await engine.dispose();
  app.exit(0);
})().catch((error) => {
  log('failed', error && error.stack ? error.stack : String(error));
  app.exit(1);
});
