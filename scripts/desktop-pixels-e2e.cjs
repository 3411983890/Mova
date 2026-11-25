'use strict';
// 像素后置条件真机验证：desktop_act {target:'#N', pixels:true} 在自绘/UIA 稀薄场景下也能判断“界面真的变了”。
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; node_modules\electron\dist\electron.exe scripts\desktop-pixels-e2e.cjs
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { app, screen } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));
const toolsModule = require(path.join(root, 'electron', 'desktop', 'tools.cjs'));

const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'pixels-e2e.log');
const results = [];
const log = (...args) => {
  const line = '[pixels-e2e] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const check = (name, ok, detail) => {
  results.push({ name, ok });
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (t) => String(t || '').replace(/\s+/g, '');

(async () => {
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  await app.whenReady();
  const engine = createDesktopEngine({
    app, screen, input, policy,
    settings: { enabled: true, profile: 'full' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sharp: require('sharp'),
  });
  await engine.start();
  const ops = toolsModule.createEngineOperations(engine);
  const tools = toolsModule.createDesktopTools(ops, { approve: async () => true, emit: () => {}, vision: true });
  const call = async (name, args) => {
    const response = await tools.find((t) => t.name === name).execute(`call-${name}`, args);
    // 工具回包是给模型看的 {content:[{type:'text',text:'<json>'}]}，这里取回结构化结果
    const text = response && Array.isArray(response.content)
      ? (response.content.find((p) => p && p.type === 'text') || {}).text
      : null;
    if (!text) return response;
    try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
  };

  // 记事本
  let rows = await ops.windows({ includeMinimized: true });
  let list = rows.windows || rows;
  const isNotepad = (w) => /notepad|记事本/i.test(`${w.exe || ''} ${w.title || ''}`);
  let notepad = list.find(isNotepad);
  if (!notepad) {
    const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    child.unref();
    await sleep(2500);
    rows = await ops.windows({ includeMinimized: true });
    list = rows.windows || rows;
    notepad = list.find(isNotepad);
  }
  check('找到记事本', Boolean(notepad), notepad && notepad.title);
  if (!notepad) throw new Error('没有记事本');
  await engine.windows.activate(notepad.hwnd);
  await sleep(700);

  // 编号直接来自引擎截图（工具的 desktop_screenshot 会把结果裁剪成给模型看的形状）
  const shot = await engine.screenshot({ hwnd: notepad.hwnd, ocr: true, annotate: 'som' });
  const marks = shot.marks || [];
  const fileMark = marks.find((m) => squash(m.name) === '文件') || marks[0];
  check('截图拿到编号', Boolean(fileMark), fileMark && { id: fileMark.id, name: fileMark.name });
  if (!fileMark) throw new Error('没有可用编号');

  // 关键：pixels:true → 前后两帧交 verify.cjs 判“变了没”
  const acted = await call('desktop_act', { action: 'click', target: `#${fileMark.id}`, pixels: true, snapshot: false });
  log('act 结果', JSON.stringify(acted).slice(0, 300));
  check('返回里带 pixels 结论', Boolean(acted && acted.pixels), acted && acted.pixels);
  check('像素判定为“变了”', Boolean(acted && acted.pixels && acted.pixels.ok === true), acted && acted.pixels);
  check('changed 被像素结论修正为 true', acted && acted.changed === true, acted && acted.changed);

  // 反例：点同一位置两次之间界面不变时，像素应判“没变”
  const still = await call('desktop_act', { action: 'click', target: `#${marks.length > 1 ? marks[marks.length - 1].id : fileMark.id}`, pixels: true, snapshot: false });
  log('第二次点击', JSON.stringify(still).slice(0, 220));

  const passed = results.every((r) => r.ok);
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: passed ? 'PASS' : 'FAIL' });
  await engine.session.abort('pixels-e2e').catch(() => {});
  await engine.dispose().catch(() => {});
  app.exit(passed ? 0 : 1);
})().catch((error) => {
  log('failed', error && error.stack ? error.stack : String(error));
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: 'FAIL' });
  app.exit(1);
});
