'use strict';
// 全量验收：用 Mova 的桌面操作引擎在真实桌面上打开微信 → 给「文件传输助手」发消息 + 表情图。
// 运行（必须用 Electron 主进程跑）：
//   Remove-Item Env:\ELECTRON_RUN_AS_NODE
//   node_modules\electron\dist\electron.exe scripts\desktop-wechat-e2e.cjs [--probe|--search|--full]
// 证据：design/e2e/*.png、design/e2e/e2e.log
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, screen, desktopCapturer } = require('electron');
const koffi = require('koffi');

const execFileAsync = promisify(execFile);
const root = path.join(__dirname, '..');
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createGuard } = require(path.join(root, 'electron', 'desktop', 'guard.cjs'));
const { createOverlay } = require(path.join(root, 'electron', 'desktop', 'overlay', 'overlay.cjs'));

const user32 = koffi.load('user32.dll');
const SetWindowPos = user32.func('bool SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const WindowFromPoint = user32.func('intptr_t WindowFromPoint(int32_t pt)');
const GetAncestor = user32.func('intptr_t GetAncestor(intptr_t h, uint32_t flags)');
const ShowWindow = user32.func('bool ShowWindow(intptr_t h, int cmd)');
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;

const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'e2e.log');
const log = (...args) => {
  const line = '[e2e] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { console.log(line); } catch { /* 管道关闭 */ }
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(logFile, '[e2e] uncaught ' + (err && err.stack ? err.stack : err) + '\n'); } catch { /* ignore */ }
});

function rootOf(hwnd) { try { return GetAncestor(hwnd, 2); } catch { return 0; } }
function windowAt(x, y) { return rootOf(WindowFromPoint((Math.round(y) << 16) | (Math.round(x) & 0xffff))); }

async function capture(name) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, sources[0].thumbnail.toPNG());
  log('capture', name);
  return file;
}

async function setClipboardImage(file) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$img = [System.Drawing.Image]::FromFile('${file}')`,
    '[System.Windows.Forms.Clipboard]::SetImage($img)',
    '$img.Dispose()',
  ].join('; ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

async function makeSticker(file) {
  const sharp = require('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
    <rect x="8" y="8" width="304" height="304" rx="64" fill="#2b2b2b"/>
    <text x="160" y="150" text-anchor="middle" font-family="Microsoft YaHei" font-size="54" fill="#f2f4f2">已完成</text>
    <text x="160" y="238" text-anchor="middle" font-family="Microsoft YaHei" font-size="84" fill="#8ee7ff">✓</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  log('sticker', file);
}

const MESSAGE = process.env.MOVA_E2E_MESSAGE
  || '你已经完成了。这次做完的是：桌面操作引擎（UIA 通道 + ΔTree + 输入注入 + 浮层守护）、设置里的「电脑操作」页、视觉兜底与全部文档；这条消息和下面那张表情图，都是这套引擎在这台电脑上点出来、发出来的。';

async function main() {
  const mode = process.argv.includes('--full') ? 'full' : process.argv.includes('--search') ? 'search' : 'probe';
  await app.whenReady();
  await sleep(300);

  const guard = createGuard({ onAbort: (reason) => log('guard abort', reason) });
  const overlay = createOverlay({ app, screen });
  const engine = createDesktopEngine({ app, screen, input, policy, guard, overlay, settings: { enabled: true } });

  // 1) 找到微信主窗口（排除登录窗口；rect 可能是数组也可能是 {x,y,w,h}）
  const rectOf = (r) => (Array.isArray(r)
    ? { x: r[0], y: r[1], w: r[2], h: r[3] }
    : { x: r.x, y: r.y, w: r.w ?? r.width, h: r.h ?? r.height });
  const isMain = (w) => /微信|Weixin/i.test(w.title || '')
    && !/LoginWindow/i.test(w.className || w.class || '')
    && !/LoginWindow/i.test(String(w.title || ''));
  const pickMain = (rows) => rows
    .filter(isMain)
    .map((w) => ({ ...w, box: rectOf(w.rect) }))
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];

  let all = await engine.windows.list({ includeMinimized: true });
  all = Array.isArray(all) ? all : all.windows || [];
  log('windows', all.length, all.map((w) => `${w.hwnd}:${w.title}:${w.className || ''}:${JSON.stringify(rectOf(w.rect))}`.slice(0, 70)));
  let target = pickMain(all);

  if (!target) {
    log('没找到微信主窗口，按一次 Ctrl+Alt+W 再试');
    await engine.actions.key('ctrl+alt+w').catch(() => {});
    await sleep(1800);
    all = await engine.windows.list({ includeMinimized: true });
    all = Array.isArray(all) ? all : all.windows || [];
    target = pickMain(all);
  }
  if (!target) throw Object.assign(new Error('找不到微信主窗口'), { code: 'no-wechat' });
  log('target', { hwnd: target.hwnd, title: target.title, cls: target.className, box: target.box });

  // 2) 唤起 + 摆到固定位置 + 抢前台（置顶兜底，结束后恢复）
  ShowWindow(target.hwnd, 9);                                   // SW_RESTORE：托盘隐藏时窗口是 0x0
  SetWindowPos(target.hwnd, HWND_TOPMOST, 60, 60, 1060, 860, 0x0040 | 0x0001);
  await sleep(700);
  const activated = await engine.windows.activate(target.hwnd);
  log('activate', activated);
  await sleep(700);
  const refreshed = (await engine.windows.list({ includeMinimized: true }))
    .find((w) => w.hwnd === target.hwnd);
  if (refreshed) target.box = rectOf(refreshed.rect);
  if (!target.box || target.box.w < 200 || target.box.h < 200) target.box = { x: 60, y: 60, w: 1060, h: 860 };
  log('box after restore', target.box);
  const shot1 = await capture('01-window.png');
  fs.writeFileSync(path.join(outDir, 'window.json'), JSON.stringify({ target, shot1 }, null, 2));

  if (mode === 'probe') { log('probe done'); await finish(engine, overlay, target); return; }

  const box = target.box;
  const { x, y, w, h } = box;
  log('box', box);

  // 注意：这里绝不最小化/移动别的窗口——一旦有窗口状态变化，焦点就会离开微信输入框。
  globalThis.__restoreWindows = [];

  const typeText = async (text, label) => {
    // 注意：这里**不再**做任何“抢前台/最小化别的窗口”的动作。
    // 上一个 click 已经把焦点放进微信的输入框，任何额外的激活/Alt 都会把焦点抢走。
    const res = await engine.actions.type(text).catch((e) => ({ ok: false, code: e && e.code, message: String(e && e.message) }));
    log('type', label, res && res.ok, res && res.code ? res.code : '', JSON.stringify(String(text).slice(0, 12)));
    return res;
  };

  const pressKey = async (combo, label) => {
    // 全局组合键必须走 input.pressCombo（actions.key 是“发给某个控件”的语义，没有 ref 会返回 pattern-unsupported）
    const res = await Promise.resolve().then(() => input.pressCombo(combo)).then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, code: e && e.code, message: String(e && e.message) }));
    log('key', label, combo, res && res.ok, res && res.code ? res.code : '');
    return res;
  };

  const click = async (px, py, label) => {
    const hit = windowAt(px, py);
    if (hit && hit !== target.hwnd) throw Object.assign(new Error(`${label} 落点不在微信窗口(hit=${hit})`), { code: 'wrong-window' });
    const res = await engine.actions.click({ x: px, y: py });
    await sleep(160);
    const cur = input.cursor();
    const fgRoot = rootOf(user32.func('intptr_t GetForegroundWindow()')());
    log('click', label, px, py, res && res.ok,
      'hit', hit, 'cursor', `${cur.x},${cur.y}`, 'at', windowAt(cur.x, cur.y),
      'fg', fgRoot === target.hwnd ? 'wechat' : String(fgRoot));
    return res;
  };

  // 3) 搜索并打开「文件传输助手」
  await click(x + Math.round(w * 0.56), y + 110, 'search');
  await sleep(600);
  await capture('02-search-open.png');
  await typeText('文件传输助手', 'search');
  await sleep(800);
  await capture('03-search-typed.png');
  await pressKey('enter', 'submit-search');
  await sleep(1600);
  await capture('04-chat.png');

  if (mode === 'search') { log('search done'); await finish(engine, overlay, target); return; }

  // 4) 点输入框 → 输入完成说明 → 点「发送」
  await click(x + Math.round(w * 0.50), y + Math.round(h * 0.60), 'input');
  await sleep(500);
  await typeText(MESSAGE, 'message');
  await sleep(800);
  await capture('05-typed.png');
  await click(x + Math.round(w * 0.453), y + Math.round(h * 0.710), 'send');
  await sleep(1400);
  await capture('06-sent-text.png');

  // 5) 表情图：剪贴板图片 → 输入框 Ctrl+V → 点「发送」
  const sticker = path.join(outDir, 'sticker.png');
  await makeSticker(sticker);
  await setClipboardImage(sticker);
  await sleep(500);
  await click(x + Math.round(w * 0.50), y + Math.round(h * 0.60), 'input-again');
  await sleep(300);
  await pressKey('ctrl+v', 'paste-sticker');
  await sleep(1200);
  await capture('07-sticker-typed.png');
  await click(x + Math.round(w * 0.453), y + Math.round(h * 0.710), 'send-sticker');
  await sleep(1800);
  await capture('08-sticker-sent.png');

  log('full done');
  await finish(engine, overlay, target);
}

async function finish(engine, overlay, target) {
  try { if (target) SetWindowPos(target.hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002); } catch { /* ignore */ }
  for (const hwnd of globalThis.__restoreWindows || []) { try { ShowWindow(hwnd, 9); } catch { /* ignore */ } }
  try { await engine.dispose(); } catch { /* ignore */ }
  try { overlay.dispose(); } catch { /* ignore */ }
  app.exit(0);
}

main().catch(async (err) => {
  log('failed', err && err.stack ? err.stack : String(err));
  try { SetWindowPos(0, HWND_NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002); } catch { /* ignore */ }
  app.exit(1);
});
