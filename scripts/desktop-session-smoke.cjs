'use strict';
// 冒烟：验证“第一次动作自动开会话 → 出现浮层 + 装鼠标钩子 → 暂停变红”
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; $env:MOVA_OVERLAY_NO_PROTECT='1';
//       node_modules\electron\dist\electron.exe scripts/desktop-session-smoke.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, screen, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));
const { createGuard } = require(path.join(root, 'electron', 'desktop', 'guard.cjs'));
const { createOverlay } = require(path.join(root, 'electron', 'desktop', 'overlay', 'overlay.cjs'));

const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'session-smoke.log');
const log = (...args) => {
  const line = '[session-smoke] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { console.log(line); } catch { /* ignore */ }
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shotOverlay(name) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, name), img.toPNG());
      log('overlay shot', name);
    } catch (error) {
      log('overlay shot failed', error && error.message);
    }
  }
}

(async () => {
  await app.whenReady();
  const guard = createGuard({ onAbort: (reason) => log('guard abort', reason) });
  const overlay = createOverlay({ app, screen });
  const engine = createDesktopEngine({ app, screen, input, policy, guard, overlay, settings: { enabled: true }, logger: { info: (...a) => log(...a), warn: (...a) => log(...a), error: (...a) => log(...a) } });
  await engine.start();

  log('status before', engine.status().session.state, 'interlock hooked', engine.interlock && engine.interlock.hooked);

  // 第一次写动作：不显式 start()，验证会自动开会话
  const acted = await engine.session.act({ type: 'click', x: 1180, y: 300 });
  log('act result', JSON.stringify(acted));
  await sleep(1200);
  log('session state', engine.session.status().state);
  log('overlay exists', overlay.exists(), 'hook', engine.interlock && engine.interlock.hooked);
  await shotOverlay('session-1-running.png');

  // 暂停（模拟真人点击）：小球应变红 + 气泡提示
  const paused = engine.session.pause('user-click');
  log('pause', paused && paused.ok);
  await sleep(900);
  await shotOverlay('session-2-paused.png');
  log('hook stats', engine.interlock && engine.interlock.stats());

  // 恢复
  engine.session.resume();
  await sleep(600);
  log('resumed', engine.session.status().state);
  await engine.session.abort('smoke-done');
  await sleep(400);
  log('hook after abort', engine.interlock && engine.interlock.hooked);

  await engine.dispose();
  try { overlay.dispose(); } catch { /* ignore */ }
  app.exit(0);
})().catch((error) => {
  log('failed', error && error.stack ? error.stack : String(error));
  app.exit(1);
});
