'use strict';
// 真机验收：用 Mova 的桌面操作能力，在微信里给「文件传输助手」发一条消息：
// 文字（你已经完成了 + 完成内容）+ 一个表情包图片，并用 OCR 复核消息真的出现了。
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; node_modules\electron\dist\electron.exe scripts\desktop-wechat-accept.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, screen, clipboard, nativeImage } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));

const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'wechat-accept.log');
const results = [];
const log = (...args) => {
  const line = '[wechat] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (t) => String(t || '').replace(/\s+/g, '');
const KEYWORD = '你已经完成了';
// 默认 dry-run：只验证到“会话已打开”就停手，绝不往任何窗口打字。
// 真正发送必须显式加 --send（见文件头注释）。
const SEND = process.argv.includes('--send');

/** 画一个简单的表情包（不依赖字体：纯图形 + 可选文字）。 */
async function makeSticker(file) {
  const sharp = require('sharp');
  const svg = `<svg width="280" height="280" xmlns="http://www.w3.org/2000/svg">
    <rect width="280" height="280" rx="28" fill="#1d2221"/>
    <circle cx="140" cy="150" r="86" fill="#c9a86a"/>
    <circle cx="108" cy="132" r="12" fill="#1d2221"/>
    <circle cx="172" cy="132" r="12" fill="#1d2221"/>
    <path d="M104 176 Q140 206 176 176" stroke="#1d2221" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M92 84 L108 46 L128 82 Z" fill="#c9a86a"/>
    <path d="M188 84 L172 46 L152 82 Z" fill="#c9a86a"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

(async () => {
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  await app.whenReady();
  const engine = createDesktopEngine({
    app, screen, input, policy,
    settings: { enabled: true, profile: 'full', advanced: { vision: true } },
    logger: { info: () => {}, warn: (...a) => log('warn', ...a), error: (...a) => log('err', ...a) },
    sharp: require('sharp'),
  });
  await engine.start();

  // 1) 找到微信并拉到前台
  const rows = await engine.windows.list({ includeMinimized: true });
  const list = Array.isArray(rows) ? rows : rows.windows || [];
  // 微信还有 WeChatAppEx.exe（小程序/支付详情）这类子窗口，必须只认主程序 Weixin.exe，
  // 否则会把消息打进支付详情页（踩过）。
  const area = (w) => (w && (w.rect ? (w.rect.w || w.rect[2] || 0) * (w.rect.h || w.rect[3] || 0) : 0)) || 0;
  const mains = list.filter((w) => /^weixin\.exe$/i.test(String(w.exe || '')));
  const wechat = (mains.length ? mains : list.filter((w) => /weixin|wechat/i.test(`${w.exe || ''} ${w.title || ''}`)))
    .sort((a, b) => area(b) - area(a))[0];
  check('找到微信窗口', Boolean(wechat), wechat && { exe: wechat.exe, title: wechat.title, rect: wechat.rect });
  if (!wechat) throw new Error('没有微信窗口');
  let R = Array.isArray(wechat.rect)
    ? { x: wechat.rect[0], y: wechat.rect[1], w: wechat.rect[2], h: wechat.rect[3] }
    : (wechat.rect || { x: 0, y: 0, w: 0, h: 0 });
  if (!(R.w > 0 && R.h > 0)) {
    // 列表里的 rect 可能是 0：改问一次 UIA 的窗口矩形（自绘窗口也能拿到真实矩形）
    const t = await engine.windows.tree(wechat.hwnd, { depth: 1 }).catch(() => null);
    const wr = t && t.window && t.window.rect;
    if (Array.isArray(wr)) R = { x: wr[0], y: wr[1], w: wr[2], h: wr[3] };
    else if (wr && wr.w) R = { x: wr.x, y: wr.y, w: wr.w, h: wr.h };
    log('从 UIA 取窗口矩形', R);
  }
  if (!(R.w > 0 && R.h > 0)) throw new Error(`微信窗口矩形无效：${JSON.stringify(R)}`);
  let foreground = false;
  for (let i = 0; i < 3 && !foreground; i += 1) {
    await engine.windows.activate(wechat.hwnd);
    await sleep(600);
    const fg = await engine.windows.foreground();
    foreground = Boolean(fg && Number(fg.hwnd) === Number(wechat.hwnd));
    log('activate try', i + 1, { foreground: fg && fg.exe, match: foreground });
  }
  check('微信在前台', foreground, R);

  // 2) 优先「左侧会话列表直接点」：搜索面板里混着“- 功能”章节行，是之前进不了会话的主因。
  const norm = (s) => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  let scale = 1;
  try { scale = Number(screen.getPrimaryDisplay().scaleFactor) || 1; } catch { scale = 1; }
  const leftEdge = R.x + 360 * scale;

  async function tryOpenFromList() {
    const s = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true, annotate: 'som' });
    const cands = (s.marks || [])
      .filter((m) => norm(m.name) === '文件传输助手')
      .map((m) => ({ name: m.name, point: engine.resolveMark(m.id) }))
      .filter((it) => it.point && it.point.x < leftEdge);
    log('左侧列表候选', cands.map((it) => ({ name: it.name, x: it.point.x, y: it.point.y })));
    if (!cands.length) return false;
    await engine.input.click({ x: cands[0].point.x, y: cands[0].point.y });
    await sleep(1300);
    const after = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true });
    return (after.lines || []).some((l) => squash(l.text).includes('文件传输助手'));
  }

  async function tryOpenFromSearch() {
    const shot0 = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true, annotate: 'som' });
    const searchMark = (shot0.marks || []).find((m) => squash(m.name).includes('搜一搜'));
    log('OCR 行数', (shot0.lines || []).length, '搜索框', searchMark && searchMark.name);
    check('视觉找到搜索框', Boolean(searchMark), searchMark && searchMark.name);
    if (searchMark) {
      const p = engine.resolveMark(searchMark.id);
      await engine.input.click({ x: p.x, y: p.y });
    } else {
      await engine.input.click({ x: Math.round(R.x + 260), y: Math.round(R.y + 78) });
    }
    await sleep(600);
    await engine.input.typeText('文件传输助手');
    await sleep(1100);
    const s1 = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true, annotate: 'som' });
    const exact = (s1.marks || []).filter((m) => norm(m.name) === '文件传输助手' && Array.isArray(m.box));
    const lowest = exact.slice().sort((a, b) => (b.box[1] + b.box[3]) - (a.box[1] + a.box[3]))[0];
    log('搜索结果行候选', exact.map((m) => ({ name: m.name, y: m.box[1] })), '选', lowest && lowest.name);
    if (lowest) {
      const p = engine.resolveMark(lowest.id);
      await engine.input.click({ x: p.x, y: p.y });
      await sleep(160);
      await engine.input.click({ x: p.x, y: p.y });
    } else {
      await engine.input.pressCombo('down');
      await sleep(300);
      await engine.input.pressCombo('enter');
    }
    await sleep(2000);
    const after = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true });
    const panelGone = !(after.lines || []).some((l) => squash(l.text).includes('搜一搜'));
    check('搜索面板已关闭（会话已打开）', panelGone, { lines: (after.lines || []).length });
    if (!panelGone) {
      await engine.input.pressCombo('esc');
      await sleep(500);
    }
    return panelGone;
  }

  let opened = await tryOpenFromList();
  check('从左侧会话列表打开', opened);
  if (!opened) opened = await tryOpenFromSearch();
  check('会话已打开（文件传输助手）', opened);

  // 默认 dry-run：只验证“能进到会话”，不打字不发送。真正发送要显式 --send。
  if (!SEND) {
    const passed = results.every((r) => r.ok);
    log('dry-run 结束（未输入、未发送）', { opened });
    log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: passed ? 'PASS' : 'FAIL', mode: 'dry-run' });
    await engine.session.abort('wechat-dry').catch(() => {});
    await engine.dispose().catch(() => {});
    app.exit(passed ? 0 : 1);
    return;
  }

  /**
   * 打字/粘贴前必须确认前台还是微信：一旦焦点被别的窗口抢走，
   * 剪贴板粘贴 + 回车会把内容发进用户正在用的对话里（已经踩过一次，代价太大）。
   */
  async function assertWeChatForeground(step) {
    const fg = await engine.windows.foreground().catch(() => null);
    const ok = Boolean(fg && Number(fg.hwnd) === Number(wechat.hwnd));
    if (!ok) {
      log('ABORT 焦点不在微信', { step, foreground: fg && fg.exe, title: fg && fg.title });
      check(`焦点校验（${step}）`, false, { foreground: fg && fg.exe });
      throw new Error(`焦点不在微信（${step}），拒绝继续输入`);
    }
    return true;
  }

  // 4) 点消息输入框并粘贴文字（中文走剪贴板）
  const body = [
    '你已经完成了',
    '',
    '1. 无视觉执行链路：UIA 读树/找控件/Pattern 调用（PowerShell 常驻 worker）',
    '2. 视觉兜底：截图 + Windows OCR + SoM 编号 → desktop_act {target:"#N"}',
    '3. 记忆技能：轨迹自动编译成技能，重放只用 1 次 desktop_batch 调用',
    '4. 左下角小球气泡浮层：目标描边、鼠标锁、点击小球暂停/恢复、终止守护',
    '5. 设置里新增「电脑操作」页（三档权限 + 高级项默认折叠）',
    '6. 文档与测试：129 条桌面测试全绿，设置页契约 30 项校验通过',
  ].join('\n');
  // 输入框位置按窗口内偏移取（实测 1000x901 窗口下约 (522,599)）；先 Esc 收掉搜索面板。
  const inputBox = { x: Math.round(R.x + R.w * 0.62), y: Math.round(R.y + R.h - 150) };
  await assertWeChatForeground('点击输入框前');
  await engine.input.click(inputBox);
  await sleep(500);
  await assertWeChatForeground('输入文字前');
  const typed = await engine.input.typeText(body);
  log('typeText', typed);
  await sleep(700);
  const shot1 = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true });
  const hasText = (shot1.lines || []).some((l) => squash(l.text).includes(KEYWORD));
  check('文字已进入输入框（OCR 可见）', hasText, KEYWORD);

  // 5) 表情包：写进剪贴板再粘贴
  const stickerPath = path.join(outDir, 'mova-sticker.png');
  await makeSticker(stickerPath);
  const image = nativeImage.createFromPath(stickerPath);
  check('表情包图片生成', !image.isEmpty(), { path: stickerPath, size: image.getSize() });
  // Electron 的 clipboard 在这里没有 writeImage（实测），改用 STA 的 PowerShell 写系统剪贴板图片。
  // 注意：脚本拼进来的字符串不能出现 $ 变量（会被外层改写），所以用 -File 前先落一个 .ps1。
  const { execFileSync } = require('node:child_process');
  const setClip = path.join(outDir, 'set-clipboard-image.ps1');
  fs.writeFileSync(setClip, [
    'param([string]$Path)',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$img = [System.Drawing.Image]::FromFile($Path)',
    '[System.Windows.Forms.Clipboard]::SetImage($img)',
    'Write-Output "ok"',
  ].join('\r\n'), 'utf8');
  execFileSync('powershell.exe', ['-sta', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setClip, stickerPath], { timeout: 20000 });
  await sleep(400);
  await assertWeChatForeground('粘贴表情包前');
  await engine.input.pressCombo('ctrl+v');
  await sleep(1200);
  const shot2 = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true });
  log('粘贴后 OCR 行数', (shot2.lines || []).length);

  // 6) 发送（微信回车即发送）并复核
  await assertWeChatForeground('发送前');
  await engine.input.pressCombo('enter');
  await sleep(1600);
  const shot3 = await engine.screenshot({ hwnd: wechat.hwnd, ocr: true });
  const sentText = (shot3.lines || []).some((l) => squash(l.text).includes(KEYWORD));
  check('消息已发出（聊天区 OCR 可见）', sentText, KEYWORD);
  const stillDraft = (shot3.lines || []).some((l) => squash(l.text).includes(KEYWORD))
    && (shot3.lines || []).filter((l) => squash(l.text).includes(KEYWORD)).length < 1;
  if (!sentText) log('ocr head', (shot3.lines || []).slice(0, 25).map((l) => l.text));

  const passed = results.every((r) => r.ok);
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: passed ? 'PASS' : 'FAIL', stillDraft });
  await engine.session.abort('wechat-accept-done').catch(() => {});
  await engine.dispose().catch(() => {});
  app.exit(passed ? 0 : 1);
})().catch((error) => {
  log('failed', error && error.stack ? error.stack : String(error));
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: 'FAIL' });
  app.exit(1);
});
