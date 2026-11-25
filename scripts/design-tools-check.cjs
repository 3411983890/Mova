// Electron 真机检查：design 工具面（契约 design/openpencil-tools-contract.md §13.1）。
// 模式与 design-integration-smoke.cjs 相同：临时 profile + 临时设计目录，真正的 preload/IPC，
// 渲染进程里挂真实的画板。运行前需要 npm run build（本脚本从 dist/vendor 加载编辑器）。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { installDesignIpc } = require('../electron/design-ipc.cjs');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const profile = path.join(__dirname, '../.test-temp/design-tools-profile-' + Date.now());
require('node:fs').mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
setTimeout(() => { console.error('Design tools check timed out'); app.exit(1); }, 60000).unref();
app.whenReady().then(async () => {
  let win;
  const errors = [];
  const checks = [];
  // 每个断言带名字，失败时先报出是哪一条，再附主进程/渲染进程的原始错误。
  const check = async (name, fn) => {
    checks.push(name);
    try { return await fn(); } catch (error) { throw new Error(`检查「${name}」失败：${error.message}`, { cause: error }); }
  };
  try {
    const scope = 'tools';
    const directory = path.join(__dirname, '../.test-temp/design-tools-' + Date.now());
    await mkdir(directory, { recursive: true });
    const runtime = installDesignIpc({ ipcMain, directory, authorize: event => { assert.equal(event.sender.id, win.webContents.id); return win; } });
    const html = path.join(__dirname, '../dist/design-tools-check.html');
    await writeFile(html, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./vendor/open-pencil-editor/design-editor.css"><style>body{margin:0;color:#ddd;background:#181818;font-family:Segoe UI}.content-frame{display:flex;height:100vh}.rail-top{width:48px}.mova-design-panel{flex:1!important}</style><div class="content-frame"><div class="rail-top"></div></div><script type="module">import {mountDesignWorkspace} from './vendor/open-pencil-editor/index.js';const w=mountDesignWorkspace({getScope:()=> 'tools'});window.movaDesktop.design.onCommand(w.handleCommand);window.__ready=true;</script>`);
    win = new BrowserWindow({ width: 1360, height: 900, show: true, webPreferences: { preload: path.join(__dirname, '../electron/preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (event) => { console.log('RENDERER', event.message); if (event.level === 'error') errors.push(event.message); });
    win.webContents.on('render-process-gone', (_event, details) => console.log('RENDERER GONE', details));
    await win.loadFile(html);
    const waitReady = async () => { for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript('Boolean(window.__ready)')) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('editor entry did not load'); };
    await waitReady();
    const tools = runtime.tools(win.webContents, scope, new AbortController().signal, () => {}, { images: true });
    // tools[i].execute() 返回 { content, details }：所有断言都读 details。
    const read = async input => (await tools[0].execute('read', input)).details;
    const apply = async operations => (await tools[1].execute('apply', { operations })).details;
    const revision = async () => (await runtime.load(scope)).revision;

    await check('design_open: 打开右侧画板视图', async () => {
      const result = await tools[5].execute('open', {});
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(result.details.view, 'canvas', JSON.stringify(result.details));
      assert.ok(Array.isArray(result.details.pages) && result.details.pages.length > 0, JSON.stringify(result.details));
      assert.equal(typeof result.details.revision, 'number', JSON.stringify(result.details));
    });

    await check('fonts: count>0 且含 Microsoft YaHei', async () => {
      const fonts = (await tools[3].execute('fonts', {})).details;
      assert.ok(fonts.count > 0, `design_fonts.count = ${fonts.count}`);
      assert.ok(Array.isArray(fonts.families), 'design_fonts.families 不是数组');
      assert.ok(fonts.families.some(family => String(family).toLowerCase().includes('yahei')),
        `字体目录里没有 Microsoft YaHei；count=${fonts.count}，前 20 个：${JSON.stringify(fonts.families.slice(0, 20))}`);
    });

    // 字体拒绝要在建 fixture 之前：这条不该产生任何图层，也不该产生撤销步骤。
    await check('apply: 通用字体族 sans-serif 单条失败', async () => {
      const report = await apply([{ action: 'create', type: 'TEXT', name: '通用字体', x: 0, y: 0, width: 120, height: 40, text: { content: 'x', fontFamily: 'sans-serif' } }]);
      assert.equal(report.failed.length, 1, JSON.stringify(report.failed));
      assert.equal(report.failed[0].code, 'generic_font_family', JSON.stringify(report.failed[0]));
      assert.equal(report.applied.length, 0, JSON.stringify(report.applied));
    });

    // 子节点必须建在 FRAME 里，而 FRAME 的 id 这一批还不知道：用 children 嵌套，
    // 整份 fixture 一次 design_apply = 一个撤销步骤（§13.1 第 9 条要求一次 undo 清空）。
    const fixture = {
      action: 'create', type: 'FRAME', name: '工具检查', x: 0, y: 0, width: 640, height: 480,
      fill: '#101418', cornerRadius: 16, layout: { mode: 'NONE' },
      children: [
        {
          type: 'TEXT', name: '标题', x: 32, y: 32, width: 576, height: 48,
          text: {
            content: '检查中文排版', fontFamily: 'Microsoft YaHei', fontSize: 24, fontWeight: 600,
            lineHeight: 32, letterSpacing: 0.5, align: 'CENTER', autoResize: 'HEIGHT', color: '#f0f0f0',
          },
        },
        {
          type: 'RECTANGLE', name: '渐变卡片', x: 32, y: 120, width: 240, height: 120, cornerRadius: 12,
          fills: [{ type: 'GRADIENT_LINEAR', stops: [{ position: 0, color: '#2563eb' }, { position: 1, color: '#60a5fa' }], angle: 45 }],
          strokes: [{ color: '#3a3a3a', weight: 2, align: 'INSIDE' }],
          effects: [{ type: 'DROP_SHADOW', color: '#00000066', x: 0, y: 8, blur: 24, spread: 0 }],
          opacity: 0.5, rotation: 15,
        },
        { type: 'ELLIPSE', name: '白点', x: 320, y: 120, width: 120, height: 120, fill: '#ffffff' },
      ],
    };
    const created = await check('apply: 一次建立 FRAME + TEXT/RECTANGLE/ELLIPSE', async () => {
      const report = await apply([fixture]);
      assert.deepEqual(report.failed, [], JSON.stringify(report.failed));
      assert.equal(report.applied.length, 1, JSON.stringify(report.applied));
      assert.equal(report.created.length, 4, JSON.stringify(report.created));
      assert.equal(report.created[0].type, 'FRAME', JSON.stringify(report.created[0]));
      return report.created;
    });
    const frameId = created[0].id;

    await check('read: FRAME/矩形/文字的填充、描边、阴影、排版字段回读', async () => {
      const details = await read({ nodeId: frameId, depth: 2 });
      const frame = details.tree;
      assert.equal(frame.id, frameId);
      assert.equal(frame.fills[0]?.type, 'SOLID', JSON.stringify(frame.fills));
      assert.equal(frame.cornerRadius, 16, JSON.stringify(frame.cornerRadius));
      const children = frame.children || [];
      const rect = children.find(child => child.type === 'RECTANGLE');
      assert.ok(rect, `没有 RECTANGLE 子节点：${JSON.stringify(children.map(child => child.type))}`);
      assert.equal(rect.fills[0]?.type, 'GRADIENT_LINEAR', JSON.stringify(rect.fills));
      assert.equal(rect.fills[0].stops?.length, 2, JSON.stringify(rect.fills[0]));
      assert.equal(rect.strokes.length, 1, JSON.stringify(rect.strokes));
      assert.equal(rect.strokes[0].weight, 2, JSON.stringify(rect.strokes[0]));
      assert.equal(rect.effects.length, 1, JSON.stringify(rect.effects));
      assert.equal(rect.effects[0].type, 'DROP_SHADOW', JSON.stringify(rect.effects[0]));
      assert.equal(rect.opacity, 0.5, JSON.stringify(rect.opacity));
      assert.equal(rect.rotation, 15, JSON.stringify(rect.rotation));
      const text = children.find(child => child.type === 'TEXT');
      assert.ok(text, '没有 TEXT 子节点');
      assert.equal(text.lineHeight, 32, JSON.stringify(text.lineHeight));
      assert.equal(text.letterSpacing, 0.5, JSON.stringify(text.letterSpacing));
      assert.equal(text.textAlign, 'CENTER', JSON.stringify(text.textAlign));
      assert.equal(text.autoResize, 'HEIGHT', JSON.stringify(text.autoResize));
      assert.ok(String(text.fontFamily).includes('YaHei'), JSON.stringify(text.fontFamily));
      assert.ok(String(text.text).includes('检查中文排版'), JSON.stringify(text.text));
      assert.equal(details.fonts.ready, true, JSON.stringify(details.fonts));
      assert.deepEqual(details.fonts.issues, [], '实际缺失字形：' + JSON.stringify(details.fonts));
    });

    await check('screenshot: PNG 元数据 + image 内容块 + magic 89 50 4E 47', async () => {
      const result = await tools[4].execute('shot', { nodeId: frameId });
      const details = result.details;
      assert.ok(details.byteLength > 1000, JSON.stringify(details));
      assert.ok(details.width > 0 && details.height > 0, JSON.stringify(details));
      const part = result.content[1];
      assert.equal(part?.type, 'image', JSON.stringify(result.content.map(entry => entry.type)));
      assert.equal(typeof part.data, 'string');
      const bytes = Buffer.from(part.data, 'base64');
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], '不是 PNG：' + bytes.subarray(0, 8).toString('hex'));
      await writeFile(path.join(directory, 'tools-check.png'), bytes);
    });

    await check('read query: //TEXT 只命中 fixture 的那一个文字节点', async () => {
      const details = await read({ query: '//TEXT' });
      // 页面上只有 fixture 里的一个 TEXT（通用字体那条没有建成）。
      assert.equal(details.query.count, 1, JSON.stringify(details.query.nodes?.map(node => node.name)));
    });

    await check('undo: 一次撤销清掉整个 fixture 批次', async () => {
      await tools[2].execute('undo', {});
      const details = await read({ depth: 3 });
      assert.equal(details.tree.children.length, 0, JSON.stringify(details.tree.children.map(child => child.name)));
    });

    // 放在 undo 之后：这一批会留下新的撤销步骤，不能挡在 fixture 批次前面。
    await check('apply: 3 条好操作 + 1 条坏操作逐条容错', async () => {
      const before = await revision();
      const report = await apply([
        { action: 'create', type: 'RECTANGLE', name: '容忍-0', x: 0, y: 0, width: 10, height: 10, fill: '#ffffff' },
        { action: 'create', type: 'RECTANGLE', name: 'bad', width: 10, height: 10, bogus: 1 },
        { action: 'create', type: 'RECTANGLE', name: '容忍-2', x: 20, y: 0, width: 10, height: 10, fill: '#ffffff' },
        { action: 'create', type: 'RECTANGLE', name: '容忍-3', x: 40, y: 0, width: 10, height: 10, fill: '#ffffff' },
      ]);
      assert.equal(report.failed.length, 1, JSON.stringify(report.failed));
      assert.equal(report.failed[0].index, 1, JSON.stringify(report.failed[0]));
      assert.equal(report.failed[0].code, 'unknown_field', JSON.stringify(report.failed[0]));
      assert.ok(String(report.failed[0].reason).includes('bogus'), JSON.stringify(report.failed[0].reason));
      assert.equal(report.applied.length, 3, JSON.stringify(report.applied));
      assert.equal(report.revision, before + 1, `revision ${report.revision} != ${before} + 1`);
    });

    // ---- 第二轮修复的回归（R1/R2/R3/R4/R5/R6/R7/R10/R12）----------------------------------------
    // 1×1 红色 PNG，用来验证 IMAGE 填充的 base64 通道。
    const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    await check('R1: 显式 width 的自动布局容器保持尺寸，sizing 可读写', async () => {
      const report = await apply([{
        action: 'create', type: 'FRAME', name: 'R1-固定宽', x: 0, y: 600, width: 300, height: 200,
        fill: '#1b2028', layout: { mode: 'HORIZONTAL', gap: 8, padding: 12, sizing: { horizontal: 'FIXED' } },
        children: [
          { type: 'RECTANGLE', name: 'R1-a', width: 40, height: 40, fill: '#2563eb' },
          { type: 'RECTANGLE', name: 'R1-b', width: 40, height: 40, fill: '#60a5fa' },
        ],
      }]);
      assert.deepEqual(report.failed, [], JSON.stringify(report.failed));
      const frame = (await read({ nodeId: report.created[0].id, depth: 1 })).tree;
      assert.equal(frame.width, 300, `自动布局把宽度收缩成了 ${frame.width}`);
      assert.equal(frame.layout.sizing.horizontal, 'FIXED', JSON.stringify(frame.layout));
    });

    await check('R1: 未给 width 的自动布局容器按内容收缩（HUG）', async () => {
      const report = await apply([{
        action: 'create', type: 'FRAME', name: 'R1-HUG', x: 400, y: 600, layout: { mode: 'HORIZONTAL', gap: 8, padding: 12 },
        children: [{ type: 'RECTANGLE', name: 'R1-c', width: 40, height: 40, fill: '#2563eb' }],
      }]);
      assert.deepEqual(report.failed, [], JSON.stringify(report.failed));
      const frame = (await read({ nodeId: report.created[0].id, depth: 1 })).tree;
      assert.ok(frame.width < 300, `HUG 容器宽度 ${frame.width}`);
      assert.equal(frame.layout.sizing.horizontal, 'HUG', JSON.stringify(frame.layout));
    });

    await check('R1: layout.sizing 非法值单条失败', async () => {
      const report = await apply([{ action: 'create', type: 'FRAME', name: 'R1-bad', width: 100, height: 100, layout: { mode: 'HORIZONTAL', sizing: { horizontal: 'WIDE' } } }]);
      assert.equal(report.failed.length, 1, JSON.stringify(report.failed));
      const failure = report.failed[0];
      assert.ok(['invalid_value', 'unknown_field'].includes(failure.code), JSON.stringify(failure));
      assert.ok(String(failure.field ?? '').startsWith('layout.sizing'), JSON.stringify(failure));
    });

    await check('R2: 伪造 imageHash 直接失败，base64 通道可用', async () => {
      const bogus = await apply([{ action: 'create', type: 'RECTANGLE', name: 'R2-bogus', width: 40, height: 40, fills: [{ type: 'IMAGE', imageHash: 'deadbeef' }] }]);
      assert.equal(bogus.failed.length, 1, JSON.stringify(bogus.failed));
      assert.equal(bogus.failed[0].code, 'invalid_value', JSON.stringify(bogus.failed[0]));
      assert.ok(String(bogus.failed[0].field).includes('imageHash'), JSON.stringify(bogus.failed[0]));

      const good = await apply([{ action: 'create', type: 'RECTANGLE', name: 'R2-image', x: 0, y: 900, width: 40, height: 40, fills: [{ type: 'IMAGE', base64: PIXEL_PNG }] }]);
      assert.deepEqual(good.failed, [], JSON.stringify(good.failed));
      const node = (await read({ nodeId: good.created[0].id, depth: 0 })).tree;
      assert.equal(node.fills[0].type, 'IMAGE', JSON.stringify(node.fills));
      assert.ok(String(node.fills[0].imageHash ?? '').length > 0, JSON.stringify(node.fills));

      const garbage = await apply([{ action: 'create', type: 'RECTANGLE', name: 'R2-garbage', width: 10, height: 10, fills: [{ type: 'IMAGE', base64: 'bm90IGFuIGltYWdl' }] }]);
      assert.equal(garbage.failed.length, 1, JSON.stringify(garbage.failed));
      assert.equal(garbage.failed[0].code, 'invalid_value', JSON.stringify(garbage.failed[0]));
    });

    await check('R5: SECTION 默认是半透明区域，不是实心块', async () => {
      const report = await apply([{ action: 'create', type: 'SECTION', name: 'R5-Section', x: -400, y: 0, width: 200, height: 160 }]);
      assert.deepEqual(report.failed, [], JSON.stringify(report.failed));
      const node = (await read({ nodeId: report.created[0].id, depth: 0 })).tree;
      assert.equal(node.fills[0]?.type, 'SOLID', JSON.stringify(node.fills));
      assert.ok(node.fills[0].opacity < 1, `SECTION 填充仍不透明：${node.fills[0].opacity}`);
    });

    await check('R6: 渐变 angle 写入后可读回', async () => {
      const report = await apply([{
        action: 'create', type: 'RECTANGLE', name: 'R6-gradient', x: 200, y: 900, width: 120, height: 80,
        fills: [{ type: 'GRADIENT_LINEAR', stops: [{ position: 0, color: '#2563eb' }, { position: 1, color: '#60a5fa' }], angle: 45 }],
      }]);
      assert.deepEqual(report.failed, [], JSON.stringify(report.failed));
      const node = (await read({ nodeId: report.created[0].id, depth: 0 })).tree;
      const angle = node.fills[0]?.angle;
      assert.equal(typeof angle, 'number', `读回没有 angle：${JSON.stringify(node.fills[0])}`);
      assert.ok(Math.abs(angle - 45) < 0.5, `angle 读回 ${angle}，期望 45`);
    });

    await check('R7: 阴影颜色的 alpha 写入后可读回', async () => {
      const report = await apply([{
        action: 'create', type: 'RECTANGLE', name: 'R7-shadow', x: 340, y: 900, width: 80, height: 60,
        fill: '#ffffff', effects: [{ type: 'DROP_SHADOW', color: '#00000066', x: 0, y: 8, blur: 24, spread: 0 }],
      }]);
      assert.deepEqual(report.failed, [], JSON.stringify(report.failed));
      const node = (await read({ nodeId: report.created[0].id, depth: 0 })).tree;
      const color = String(node.effects[0]?.color ?? '');
      assert.match(color, /^#000000[0-9a-f]{2}$/i, `阴影颜色读回 ${color}，alpha 丢了`);
    });

    await check('R10/R12: 健康文档的 design_read 不带完整字体报告', async () => {
      const details = await read({ depth: 3 });
      assert.equal(details.fonts.status, undefined, '健康文档仍带了 fonts.status');
      assert.equal(details.fonts.boot, undefined, '健康文档仍带了 fonts.boot');
      assert.ok(!String(details.fonts.summary ?? '').startsWith('text-not-painted'), JSON.stringify(details.fonts));
      assert.deepEqual(details.fonts.issues ?? [], [], '字体缺字：' + JSON.stringify(details.fonts.issues));
      assert.deepEqual(details.fonts.substituted ?? [], [], '正常渲染的文字被标成 substituted：' + JSON.stringify(details.fonts.substituted));
      const bytes = Buffer.byteLength(JSON.stringify(details));
      assert.ok(bytes < 20000, `design_read 结果 ${bytes} 字节，偏大`);
    });

    await check('R3: 内置图标离线可用', async () => {
      const report = await apply([{ action: 'icon', name: 'lucide:heart', size: 24, color: '#60a5fa', x: 500, y: 900 }]);
      assert.deepEqual(report.failed, [], JSON.stringify(report.failed));
      assert.equal(report.created.length, 1, JSON.stringify(report.created));
    });

    await check('R4: JSX 两条路径都给出可执行的拒绝理由', async () => {
      const action = await apply([{ action: 'render', jsx: '<div />' }]);
      assert.equal(action.failed.length, 1, JSON.stringify(action.failed));
      assert.equal(action.failed[0].code, 'unknown_action', JSON.stringify(action.failed[0]));
      const create = await apply([{ action: 'create', jsx: '<div />' }]);
      assert.equal(create.failed.length, 1, JSON.stringify(create.failed));
      assert.equal(create.failed[0].code, 'unsupported', JSON.stringify(create.failed[0]));
      assert.ok(/CSP|安全策略|eval/.test(String(create.failed[0].reason)), JSON.stringify(create.failed[0].reason));
    });

    // 整页截图，给人工复核 R1（固定宽卡片）/R3（内置图标）/R5（半透明区域）用。
    await check('整页截图留档', async () => {
      const shot = await tools[4].execute('shot-page', { scale: 1, maxEdge: 1600 });
      // details 里只有元数据，PNG 本体在 image 内容块里。
      const part = shot.content.find(entry => entry.type === 'image');
      const bytes = Buffer.from(String(part?.data ?? ''), 'base64');
      assert.ok(bytes.length > 2000, `整页截图只有 ${bytes.length} 字节`);
      await writeFile(path.join(directory, 'tools-check-page.png'), bytes);
    });

    await check('renderer 控制台没有 error', async () => {
      assert.deepEqual(errors, []);
    });

    const artifact = await runtime.load(scope);
    console.log(JSON.stringify({ ok: true, directory, revision: artifact.revision, nodes: artifact.snapshot?.nodes.length ?? 0, checks, errors }));
    runtime.close(); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack);
    if (error.cause?.stack) console.error(error.cause.stack);
    console.error('CHECKS', JSON.stringify(checks), 'ERRORS', JSON.stringify(errors));
    win?.destroy(); app.exit(1);
  }
});
