'use strict';
// 记忆闭环真机验收：同一件事“第一次 N 次工具调用 → 编译成技能 → 第二次 1 次调用（desktop_batch {recipe}）”。
// 场景：记事本里点编辑区 → 输入一段带参数的文字。第二次换参数重放，用 OCR 验证文字真的落地。
// 运行：Remove-Item Env:\ELECTRON_RUN_AS_NODE; node_modules\electron\dist\electron.exe scripts/desktop-memory-e2e.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, screen } = require('electron');

const root = path.join(__dirname, '..');
const input = require(path.join(root, 'electron', 'desktop', 'input.cjs'));
const policy = require(path.join(root, 'electron', 'desktop', 'policy.cjs'));
const { createDesktopEngine } = require(path.join(root, 'electron', 'desktop', 'index.cjs'));
const toolsModule = require(path.join(root, 'electron', 'desktop', 'tools.cjs'));
const { compile } = require(path.join(root, 'electron', 'desktop', 'compiler.cjs'));
const { createProcedureStore } = require(path.join(root, 'electron', 'desktop', 'procedures.cjs'));

const outDir = path.join(root, 'design', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'memory-e2e.log');
const results = [];
const log = (...args) => {
  const line = '[memory-e2e] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (t) => String(t || '').replace(/\s+/g, '');

(async () => {
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  await app.whenReady();
  // 每次清空技能库：否则会命中上一次（可能是失败的）指纹，重放旧配方。
  const storeDir = path.join(outDir, 'memory-store');
  fs.rmSync(storeDir, { recursive: true, force: true });
  const procedures = createProcedureStore({ directory: storeDir });
  const engine = createDesktopEngine({
    app, screen, input, policy, procedures,
    settings: { enabled: true, profile: 'full', memory: { auto: true }, advanced: { vision: true } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sharp: require('sharp'),
  });
  await engine.start();

  const ops = toolsModule.createEngineOperations(engine);
  const tools = toolsModule.createDesktopTools(ops, {
    approve: async () => true,
    emit: () => {},
    vision: true,
  });
  const call = async (name, args) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`找不到工具 ${name}`);
    // 所有桌面工具的 execute 都是 (id, input, signal)：id 用于 emit 进度事件。
    return tool.execute(`call-${name}`, args);
  };

  // 0) 记事本在前台
  let rows = await ops.windows({ includeMinimized: true });
  let list = rows.windows || rows.items || rows;
  log('窗口列表', { keys: Object.keys(rows || {}), count: Array.isArray(list) ? list.length : -1, rows: (Array.isArray(list) ? list : []).map((w) => `${w.exe}|${String(w.title || '').slice(0, 24)}`) });
  const isNotepad = (w) => /notepad|记事本/i.test(String(w.exe || w.process || w.processName || '') + ' ' + String(w.title || ''));
  let notepad = list.find(isNotepad);
  if (!notepad) {
    const { spawn } = require('node:child_process');
    const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    child.unref();
    await sleep(2500);
    rows = await ops.windows({ includeMinimized: true });
    list = rows.windows || rows.items || rows;
    notepad = list.find(isNotepad);
  }
  if (!notepad) throw new Error('没有记事本窗口，且自动打开失败');
  await engine.windows.activate(notepad.hwnd);
  await sleep(600);

  // 1) 第一次：snapshot 拿编辑区 ref，然后 click + type（3 次工具调用）
  const callsFirstRun = [];
  // 用工具层 snapshot（它会建立会话快照，后面的 ref 才有效）；拿不到再退引擎原始树。
  const snap = await call('desktop_snapshot', { hwnd: notepad.hwnd });
  callsFirstRun.push('desktop_snapshot');
  let nodes = (snap && (snap.nodes || snap.tree)) || [];
  if (!Array.isArray(nodes) || !nodes.length) {
    const tree = await engine.windows.tree(notepad.hwnd, { depth: 3 });
    nodes = (tree && (tree.nodes || tree.tree)) || [];
  }
  const editor = (Array.isArray(nodes) ? nodes : []).find((n) => /document|edit/i.test(String(n.role || '')))
    || (Array.isArray(nodes) ? nodes : []).find((n) => /textbox/i.test(String(n.className || '')));
  check('snapshot 找到编辑区', Boolean(editor && editor.ref), editor && { ref: editor.ref, role: editor.role, name: editor.name });

  const tokenA = `mova-memory-A${String(Date.now() % 10000)}`;
  const r1 = await call('desktop_act', { action: 'click', target: editor.ref });
  log('act(click)', JSON.stringify(r1).slice(0, 200), 'state', engine.session.status().state);
  callsFirstRun.push('desktop_act(click)');
  await sleep(250);
  const r2 = await call('desktop_act', { action: 'type', target: editor.ref, value: tokenA });
  log('act(type)', JSON.stringify(r2).slice(0, 200), 'state', engine.session.status().state);
  callsFirstRun.push('desktop_act(type)');
  await sleep(400);
  // 第三步：回车（合法动作，也让轨迹够 3 步可编译）
  const r3 = await call('desktop_act', { action: 'key', target: editor.ref, keys: 'enter' });
  log('act(key)', JSON.stringify(r3).slice(0, 200), 'state', engine.session.status().state);
  callsFirstRun.push('desktop_act(key)');
  await sleep(600);
  log('第一次执行', { calls: callsFirstRun.length, tools: callsFirstRun });

  // 2) 轨迹 → 技能草稿 → 存盘（记忆闭环）
  // 轨迹来源：会话 trace（带 op + locator），契约见 design/desktop-handoff.md §3.1
  const sessionTrace = (engine.session.status().trace || []).filter((e) => e && e.op);
  const trace = (ops.recentTrace() || []).length ? ops.recentTrace() : sessionTrace;
  log('轨迹行数', trace.length, trace.map((e) => e.op), trace.map((e) => ({ op: e.op, key: e.stableKey, name: e.name, ts: e.ts, ok: e.ok })));
  const compiled = await compile(trace, { appKey: 'notepad.exe', title: '记事本记一笔' });
  log('编译结果', { ok: compiled.ok, code: compiled.code, stepCount: compiled.stepCount, title: compiled.title, steps: (compiled.steps || []).map((s) => s.op) });
  check('轨迹能编译成技能', compiled.ok === true, { stepCount: compiled.stepCount, params: (compiled.params || []).map((p) => p.name) });
  if (!compiled.ok) throw new Error(`编译失败：${compiled.code}`);
  const store = ops.procedures;
  if (!store || typeof store.save !== 'function') throw new Error('引擎没有 procedures 存储');
  const saved = await store.save({
    appKey: 'notepad.exe',
    title: compiled.title || '记事本记一笔',
    intent: compiled.intent || [],
    params: compiled.params || [],
    steps: compiled.steps || [],
    verify: compiled.verify || undefined,
  });
  log('技能存盘', saved && (saved.name || saved.id));
  const recipe = saved && (saved.name || saved.id);
  check('技能已写入 procedures', Boolean(recipe), recipe);

  // 3) 第二次：只用 1 次调用（desktop_batch {recipe}），并换一个参数
  const tokenB = `mova-memory-B${String(Date.now() % 10000)}`;
  const paramName = (compiled.params && compiled.params[0] && compiled.params[0].name) || 'p1';
  const liveNodes = typeof ops.currentNodes === 'function' ? ops.currentNodes() : [];
  log('重放前的活节点', {
    count: Array.isArray(liveNodes) ? liveNodes.length : -1,
    sample: (Array.isArray(liveNodes) ? liveNodes : []).slice(0, 5).map((n) => ({ ref: n.ref, role: n.role, name: n.name, key: n.stableKey })),
  });
  const replayed = await call('desktop_batch', { recipe, inputs: { [paramName]: tokenB } });
  log('重放结果', JSON.stringify(replayed).slice(0, 400));
  check('desktop_batch 重放成功', replayed && replayed.ok !== false, replayed && (replayed.code || `${replayed.steps || '?'} steps`));

  // 4) 用视觉验证第二段文字真的写进去了
  await engine.windows.activate(notepad.hwnd);
  await sleep(400);
  const shot = await engine.screenshot({ hwnd: notepad.hwnd, ocr: true });
  const digitsB = tokenB.replace(/[^0-9]/g, '');
  const foundB = (shot.lines || []).some((l) => squash(l.text).includes(digitsB));
  check('OCR 读回重放写入的文字', foundB, { token: tokenB, digits: digitsB });
  if (!foundB) log('ocr head', (shot.lines || []).slice(0, 20).map((l) => l.text));

  const firstRunCalls = callsFirstRun.length;
  log('调用次数对比', { firstRun: firstRunCalls, secondRun: 1, saved: firstRunCalls - 1 });

  const passed = results.every((r) => r.ok);
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: passed ? 'PASS' : 'FAIL' });
  await engine.session.abort('memory-e2e-done').catch(() => {});
  await engine.dispose().catch(() => {});
  app.exit(passed ? 0 : 1);
})().catch((error) => {
  log('failed', error && error.stack ? error.stack : String(error));
  log('汇总', { pass: results.filter((r) => r.ok).length, total: results.length, verdict: 'FAIL' });
  app.exit(1);
});
