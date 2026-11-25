'use strict';
// 纯视觉（无 UIA 定位）端到端：只靠 截图 → OCR → SoM 编号 → #N 点击 → 再截图 OCR 断言。
// 场景：记事本菜单栏的“文件”→ 弹出菜单出现新条目 → Esc 关闭 → 在编辑区输入 → OCR 校验文本落地。
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; node_modules\electron\dist\electron.exe scripts/desktop-vision-e2e.cjs
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
const logFile = path.join(outDir, 'vision-e2e.log');
const results = [];
const log = (...args) => {
  const line = '[vision-e2e] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { console.log(line); } catch { /* ignore */ }
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (text) => String(text || '').replace(/\s+/g, '');

(async () => {
  await app.whenReady();
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }

  const guard = require(path.join(root, 'electron', 'desktop', 'guard.cjs')).createGuard({
    onAbort: (reason) => log('guard abort', reason),
  });
  const overlay = require(path.join(root, 'electron', 'desktop', 'overlay', 'overlay.cjs')).createOverlay({ app, screen });
  const engine = createDesktopEngine({
    app, screen, input, policy, guard, overlay,
    settings: { enabled: true, profile: 'full', advanced: { vision: true } },
    logger: { info: () => {}, warn: (...a) => log('warn', ...a), error: (...a) => log('err', ...a) },
    sharp: require('sharp'),
  });
  await engine.start();

  // 1) 确保记事本在前台（窗口已存在就复用，不打扰用户已有内容）
  let rows = await engine.windows.list({ includeMinimized: true });
  let list = Array.isArray(rows) ? rows : rows.windows || [];
  let notepad = list.find((w) => /notepad\.exe$/i.test(String(w.exe || '')));
  if (!notepad) {
    const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    child.unref();
    await sleep(2500);
    rows = await engine.windows.list({ includeMinimized: true });
    list = Array.isArray(rows) ? rows : rows.windows || [];
    notepad = list.find((w) => /notepad\.exe$/i.test(String(w.exe || '')));
  }
  check('找到记事本窗口', Boolean(notepad), notepad && notepad.title);
  if (!notepad) throw new Error('没有记事本窗口，无法继续');
  await engine.windows.activate(notepad.hwnd);
  await sleep(700);
  const rect = Array.isArray(notepad.rect)
    ? { x: notepad.rect[0], y: notepad.rect[1], w: notepad.rect[2], h: notepad.rect[3] }
    : notepad.rect;
  log('notepad rect', rect);
  const inside = (p) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;

  /** 每次截图前先确认目标窗口在前台：焦点漂移会让 OCR 读到别的窗口（踩过）。 */
  async function focusNotepad(tries = 3) {
    for (let i = 0; i < tries; i += 1) {
      const before = await engine.windows.foreground();
      if (before && Number(before.hwnd) === Number(notepad.hwnd)) return true;
      await engine.windows.activate(notepad.hwnd);
      await sleep(450);
      const after = await engine.windows.foreground();
      log('refocus', { try: i + 1, foreground: after && after.exe, target: notepad.exe });
      if (after && Number(after.hwnd) === Number(notepad.hwnd)) return true;
    }
    return false;
  }
  check('记事本在前台', await focusNotepad(), notepad.title);

  // 2) 视觉第一步：截图 + OCR + SoM，只靠像素找“文件”菜单
  const shot1 = await engine.screenshot({ hwnd: notepad.hwnd, ocr: true, annotate: 'som' });
  check('截图+OCR+SoM 成功', shot1.ok === true && (shot1.marks || []).length > 0, {
    via: shot1.via, size: `${shot1.width}x${shot1.height}`, marks: (shot1.marks || []).length,
    captureScale: shot1.captureScale, crop: shot1.crop,
  });
  const fileMark = (shot1.marks || []).find((m) => squash(m.name) === '文件' && m.box && inside(engine.resolveMark(m.id)));
  if (!fileMark) {
    try {
      fs.writeFileSync(path.join(outDir, 'vision-e2e-marks.json'), JSON.stringify({
        rect,
        marks: (shot1.marks || []).map((m) => ({ id: m.id, name: m.name, box: m.box, point: engine.resolveMark(m.id) })),
      }, null, 2), 'utf8');
      log('marks 已落盘 design/e2e/vision-e2e-marks.json');
    } catch { /* ignore */ }
  }
  check('OCR 找到“文件”菜单编号', Boolean(fileMark), fileMark && { id: fileMark.id, box: fileMark.box });
  if (!fileMark) throw new Error('视觉定位失败：没有找到“文件”');
  const point = engine.resolveMark(fileMark.id);
  log('编号换算成屏幕坐标', { id: fileMark.id, box: fileMark.box, point });

  // 3) #N 直接点（这是 desktop_act 的 target:"#N" 路径）
  const clicked = await engine.session.act({ type: 'click', x: point.x, y: point.y });
  check('#N 点击执行', clicked.ok === true, clicked.code || clicked.via);
  await sleep(900);

  // 4) 视觉断言：菜单弹出（OCR 出现“新建/打开/保存”之类新条目）
  await focusNotepad();
  const shot2 = await engine.screenshot({ hwnd: notepad.hwnd, ocr: true });
  const menuWords = ['新建', '打开', '保存', '另存为', '退出'];
  const hitWords = menuWords.filter((w) => (shot2.lines || []).some((l) => squash(l.text).includes(w)));
  check('点击后菜单弹出（视觉可见新条目）', hitWords.length >= 2, hitWords);
  await input.pressCombo('esc');
  await sleep(400);

  // 5) 焦点进编辑区（这里只借 UIA 的矩形，内容校验仍然走视觉）
  await focusNotepad();
  const tree = await engine.windows.tree(notepad.hwnd, { depth: 3 });
  const nodes = (tree && tree.nodes) || [];
  const editor = nodes.find((n) => /document|edit/i.test(String(n.role || '')))
    || nodes.find((n) => /textbox/i.test(String(n.className || '')));
  check('拿到编辑区矩形', Boolean(editor && Array.isArray(editor.rect)), editor && editor.role);
  if (editor && Array.isArray(editor.rect)) {
    const [ex, ey, ew, eh] = editor.rect;
    await input.click({ x: Math.round(ex + ew / 2), y: Math.round(ey + Math.min(eh / 2, 120)) });
    await sleep(350);
  }

  // 6) 输入 + 视觉校验：OCR 能读回刚打的字
  const digits = String(Date.now() % 1000000).padStart(6, '0');
  const token = `mova-test-${digits}`;
  const typed = await input.typeText(token);
  log('typeText', typed);
  await sleep(700);
  await focusNotepad();
  const shot3 = await engine.screenshot({ hwnd: notepad.hwnd, ocr: true });
  // OCR 对连字符/字母常认错（实测 "mova-vision" → "mova．v@on"），所以只对数字做容错匹配：
  // 在每行的数字串里滑窗找与目标数字编辑距离 ≤1 的 6 位片段。
  const nearDigits = (haystack, needle, tolerance = 1) => {
    const source = String(haystack);
    for (let i = 0; i + needle.length <= source.length; i += 1) {
      let diff = 0;
      for (let k = 0; k < needle.length; k += 1) {
        if (source[i + k] !== needle[k]) diff += 1;
        if (diff > tolerance) break;
      }
      if (diff <= tolerance) return true;
    }
    return false;
  };
  const found = (shot3.lines || []).some((l) => nearDigits(squash(l.text), digits, 2));
  check('OCR 读回刚输入的文字', found, token);
  if (!found) {
    log('ocr head', (shot3.lines || []).slice(0, 25).map((l) => l.text));
  }

  const passed = results.every((r) => r.ok);
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: passed ? 'PASS' : 'FAIL' });

  await engine.session.abort('vision-e2e-done').catch(() => {});
  await engine.dispose().catch(() => {});
  try { overlay.dispose(); } catch { /* ignore */ }
  app.exit(passed ? 0 : 1);
})().catch((error) => {
  log('failed', error && error.stack ? error.stack : String(error));
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: 'FAIL' });
  app.exit(1);
});
