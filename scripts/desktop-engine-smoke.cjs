'use strict';
// 引擎级冒烟（Electron 主进程）：装配真实依赖 → 列工具 → 跑一次 desktop_windows / desktop_snapshot。
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; node_modules\electron\dist\electron.exe scripts/desktop-engine-smoke.cjs
const path = require('node:path');
const { app, screen } = require('electron');

const root = path.join(__dirname, '..');
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createGuard } = require(path.join(root, 'electron', 'desktop', 'guard.cjs'));
const { createOverlay } = require(path.join(root, 'electron', 'desktop', 'overlay', 'overlay.cjs'));

const fs = require('node:fs');
const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'engine-smoke.log');
const log = (...a) => {
  const line = '[engine-smoke] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { console.log(line); } catch { /* 管道关闭 */ }
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};

(async () => {
  await app.whenReady();
  const guard = createGuard({ onAbort: (reason) => log('guard abort', reason) });
  const overlay = createOverlay({ app, screen });
  const engine = createDesktopEngine({ app, screen, input, policy, guard, overlay, settings: { enabled: true } });

  log('status', engine.status());
  const tools = engine.tools({ emit: () => {}, approve: async () => 'allow' });
  log('tools', tools.map((t) => t.name).join(','));
  log('tool count', tools.length);

  const signal = new AbortController().signal;
  const windowsTool = tools.find((t) => t.name === 'desktop_windows');
  const w = await windowsTool.execute('smoke-1', { action: 'list' }, signal);
  log('desktop_windows', String(w.content?.[0]?.text || '').slice(0, 400));

  const snapTool = tools.find((t) => t.name === 'desktop_snapshot');
  const s = await snapTool.execute('smoke-2', { mode: 'full', maxChars: 1200 }, signal);
  log('desktop_snapshot', String(s.content?.[0]?.text || '').slice(0, 600));

  const shotTool = tools.find((t) => t.name === 'desktop_screenshot');
  const shot = await shotTool.execute('smoke-3', { window: '微信', ocr: true, maxLongEdge: 960 }, signal);
  log('desktop_screenshot', String(shot.content?.[0]?.text || '').slice(0, 300));

  const handoffTool = tools.find((t) => t.name === 'desktop_handoff');
  const hand = await handoffTool.execute('smoke-4', { reason: 'login', note: '冒烟测试：请忽略', timeoutMs: 1200 }, signal);
  log('desktop_handoff', String(hand.content?.[0]?.text || '').slice(0, 300));

  await engine.dispose();
  try { overlay.dispose(); } catch { /* ignore */ }
  app.exit(0);
})().catch((err) => {
  console.error('[engine-smoke] failed', err && err.stack ? err.stack : err);
  app.exit(1);
});
