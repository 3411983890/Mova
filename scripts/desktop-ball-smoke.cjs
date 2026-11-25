'use strict';
// 冒烟：小球点击恢复 + 终止后浮层收起。
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; $env:MOVA_OVERLAY_NO_PROTECT='1';
//       node_modules\electron\dist\electron.exe scripts/desktop-ball-smoke.cjs
// 说明：真实鼠标点击无法自动化（我们自己的注入带 LLMHF_INJECTED，钩子按设计放行），
// 所以这里用 interlock.handleClick(物理坐标) 走同一条暂停/恢复分支。
const path = require('node:path');
const fs = require('node:fs');
const { app, screen, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));
const { createOverlay } = require(path.join(root, 'electron', 'desktop', 'overlay', 'overlay.cjs'));

const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'ball-smoke.log');
const results = [];
const log = (...args) => {
  const line = '[ball-smoke] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const check = (name, ok, detail) => {
  results.push({ name, ok });
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 浮层收起会关掉最后一个窗口；不拦住 window-all-closed 的话整个进程会直接退出，
// 后面的断言就来不及跑（真 app 里这个事件由主窗口接管）。
app.on('window-all-closed', () => {});

async function shot(name) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, name), img.toPNG());
    } catch { /* ignore */ }
  }
}

(async () => {
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  await app.whenReady();
  const overlay = createOverlay({ app, screen });
  const engine = createDesktopEngine({
    app, screen, input, policy, overlay,
    settings: { enabled: true, profile: 'full' },
    logger: { info: () => {}, warn: (...a) => log('warn', ...a), error: () => {} },
    sharp: require('sharp'),
  });
  await engine.start();
  const interlock = engine.interlock;

  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const rect = interlock.ballRect();
  const dipCenter = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
  const physical = { x: Math.round(dipCenter.x * scale), y: Math.round(dipCenter.y * scale) };
  log('小球命中区(DIP)', rect, '球心 DIP', dipCenter, '折算物理', physical, 'scaleFactor', scale);
  check('小球命中区与 CSS 对齐', rect.w === 68 && Math.abs(rect.y - (display.bounds.height - 78)) <= 1, rect);
  check('物理坐标命中判定', interlock.insideBall(physical) === true);
  check('球外不命中', interlock.insideBall({ x: Math.round(display.bounds.width * scale) - 40, y: 120 }) === false);

  // 起会话（第一次动作会自动开会话并装钩子）
  await engine.session.act({ type: 'click', x: Math.round(display.bounds.width * scale) / 2, y: 200 });
  await sleep(900);
  log('state', engine.session.status().state, 'hooked', interlock.hooked);
  check('会话已启动且钩子已装', engine.session.status().state === 'running' && interlock.hooked === true);

  // 模拟“真人点了一下” → 暂停、球变红
  interlock.handleClick({ x: Math.round(display.bounds.width * scale) / 2, y: 400 });
  await sleep(900);
  log('暂停后 state', engine.session.status().state);
  check('真人点击 → 会话暂停', engine.session.status().state === 'paused');
  await shot('ball-1-paused.png');

  // 点小球 → 恢复（这就是用户报的 bug）
  interlock.handleClick(physical);
  await sleep(1000);
  log('点球后 state', engine.session.status().state);
  check('点小球 → 恢复运行', engine.session.status().state === 'running');
  await shot('ball-2-resumed.png');

  // 终止 → 浮层收起、钩子卸掉（用户报的第二个 bug 的行为面）
  await engine.stop('user-cancel');
  await sleep(800);
  const after = engine.session.status().state;
  log('终止后 state', after, 'hooked', interlock.hooked, 'overlay exists', overlay.exists());
  check('终止后会话结束', after === 'aborted' || after === 'done');
  check('终止后钩子已卸', interlock.hooked === false);

  const passed = results.every((r) => r.ok);
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: passed ? 'PASS' : 'FAIL' });
  await engine.dispose().catch(() => {});
  try { overlay.dispose(); } catch { /* ignore */ }
  app.exit(passed ? 0 : 1);
})().catch((error) => {
  log('failed', error && error.stack ? error.stack : String(error));
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: 'FAIL' });
  app.exit(1);
});
