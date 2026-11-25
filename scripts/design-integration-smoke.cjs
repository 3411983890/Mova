const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { installDesignIpc } = require('../electron/design-ipc.cjs');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const profile = path.join(__dirname, '../.test-temp/design-profile-' + Date.now());
require('node:fs').mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
setTimeout(() => { console.error('Design integration smoke timed out'); app.exit(1); }, 60000).unref();
app.whenReady().then(async () => {
  let win;
  const errors = [];
  try {
    const directory = path.join(__dirname, '../.test-temp/design-smoke-' + Date.now());
    await mkdir(directory, { recursive: true });
    const runtime = installDesignIpc({ ipcMain, directory, authorize: event => { assert.equal(event.sender.id, win.webContents.id); return win; } });
    const html = path.join(__dirname, '../dist/design-smoke.html');
    await writeFile(html, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./vendor/open-pencil-editor/design-editor.css"><style>body{margin:0;color:#ddd;background:#181818;font-family:Segoe UI}.content-frame{display:flex;height:100vh}.rail-top{width:48px}.mova-design-panel{flex:1!important}</style><div class="content-frame"><div class="rail-top"></div></div><script type="module">import {mountDesignWorkspace} from './vendor/open-pencil-editor/index.js';const w=mountDesignWorkspace({getScope:()=> 'smoke'});window.movaDesktop.design.onCommand(w.handleCommand);window.__ready=true;</script>`);
    win = new BrowserWindow({ width: 1360, height: 900, show: true, webPreferences: { preload: path.join(__dirname, '../electron/preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (event) => { console.log('RENDERER', event.message); if (event.level === 'error') errors.push(event.message); });
    win.webContents.on('render-process-gone', (_event, details) => console.log('RENDERER GONE', details));
    setTimeout(async () => { if (!win.isDestroyed()) console.log('STATE', await win.webContents.executeJavaScript('({ready:window.__ready,text:document.body.innerText})')); }, 12000);
    await win.loadFile(html);
    const waitReady = async () => { for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript('Boolean(window.__ready)')) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('editor entry did not load'); };
    await waitReady();
    const tools = runtime.tools(win.webContents, 'smoke', new AbortController().signal);
    const read = () => tools[0].execute('read', { depth: 4 });
    const apply = operations => tools[1].execute('apply', { operations });
    // Exercise the real chat agent and real renderer; fixture model responses avoid network charges.
    const { runChatAgent } = await import('../electron/chat-agent.mjs');
    const operations = [{ action: 'create', type: 'FRAME', name: 'App 登录页面', width: 600, height: 650, fill: '#f6f4ee', children: [{ type: 'TEXT', text: '你好，Mova', name: 'Heading', x: 35, y: 35, width: 480, height: 60, fontSize: 30, fill: '#263a30' }, { type: 'TEXT', name: '欢迎标题', text: '欢迎回来', fontFamily: 'Microsoft YaHei', fontWeight: 600, x: 35, y: 330, width: 530, height: 55, fontSize: 28, fill: '#263a30' }, { type: 'TEXT', name: '登录说明', text: '登录你的账号，继续未完成的工作', fontFamily: 'Microsoft YaHei', x: 35, y: 400, width: 530, height: 50, fontSize: 20, fill: '#263a30' }, { type: 'TEXT', name: 'Inter 中文', text: '中文与 English 混排', fontFamily: 'Inter', x: 35, y: 465, width: 530, height: 50, fontSize: 24, fill: '#263a30' }, { type: 'RECTANGLE', name: 'Card', x: 35, y: 140, width: 530, height: 160, fill: '#365a4d', cornerRadius: 12 }] }];
    const events = []; let calls = 0;
    await runChatAgent({
      key: 'fixture-key', provider: { id: 'design-fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' },
      entry: { id: 'fixture', name: 'Fixture', vision: false, efforts: ['low'] },
      request: { conversationId: 'smoke', messages: [{ role: 'user', text: '创建一个带中文标题和绿色卡片的仪表盘 UI' }] },
      signal: new AbortController().signal, sender: win.webContents, designRuntime: runtime, emit: event => { events.push(event); if (event.type === 'tool' && event.status === 'error') console.error('TOOL ERROR', event); },
      fetchModel: async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.ok(payload.tools.some(tool => tool.function.name === 'design_apply'));
        const index = calls++;
        const delta = index === 3 ? { content: '已创建可编辑的中文仪表盘。' } : { tool_calls: [{ index: 0, id: 'design_' + index, type: 'function', function: { name: index === 1 ? 'design_apply' : 'design_read', arguments: JSON.stringify(index === 1 ? { operations } : { depth: 4 }) } }] };
        const chunk = (value, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] }) + '\n\n';
        return new Response(chunk(delta) + chunk({}, index === 3 ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    assert.equal(calls, 4);
    assert.equal(events.filter(e => e.type === 'tool' && e.status === 'done').length, 3);
    let current = (await read()).details;
    assert.equal(current.tree.children[0].children[0].text, '你好，Mova');
    assert.ok(current.fonts.ready && current.fonts.checked >= 5, JSON.stringify(current.fonts));
    assert.equal(current.fonts.ready, true, JSON.stringify(current.fonts));
    assert.ok(Array.isArray(current.fonts.blocked), 'fonts.blocked is not an array: ' + JSON.stringify(current.fonts));
    assert.deepEqual(current.fonts.issues, [], 'Missing actual renderer glyphs: ' + JSON.stringify(current.fonts));
    const id = current.tree.children[0].id;
    await apply([{ action: 'update', id, props: { name: 'Edited dashboard', width: 620 } }]);
    await runtime.configure({ aiEdit: false });
    await assert.rejects(apply([{ action: 'delete', id }]));
    await read();
    await runtime.configure({ aiEdit: true });
    await tools[2].execute('undo', {});
    assert.equal((await read()).details.tree.children[0].width, 600);
    // A bad operation now fails alone; the rest of the batch applies (contract §4/§7).
    const tolerated = (await apply([{ action: 'create', type: 'RECTANGLE', name: 'Tolerated', width: 20, height: 20 }, { action: 'invalid' }])).details;
    assert.equal(tolerated.failed.length, 1, JSON.stringify(tolerated.failed));
    assert.equal(tolerated.failed[0].code, 'unknown_action', JSON.stringify(tolerated.failed[0]));
    assert.equal(tolerated.applied.length, 1, JSON.stringify(tolerated.applied));
    assert.equal((await read()).details.tree.children.length, 2);
    await apply([{ action: 'delete', id: tolerated.created[0].id }]);
    assert.equal((await read()).details.tree.children.length, 1);
    await apply([{ action: 'update', id, props: { name: 'Edited dashboard', width: 620 } }]);
    await win.webContents.reload(); await waitReady();
    current = (await read()).details;
    assert.equal(current.tree.children[0].name, 'Edited dashboard');
    assert.equal(current.tree.children[0].width, 620);
    assert.equal(current.tree.children[0].children[0].text, '你好，Mova');
    for (let i = 0; i < 200; i++) {
      if (await win.webContents.executeJavaScript(`!document.querySelector('.mova-design-loading')`)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await apply([{ action: 'update', id, props: { name: 'App 登录页面' } }]);
    await new Promise(r => setTimeout(r, 1500));
    const frame = await win.webContents.capturePage(); await writeFile(path.join(directory, 'editor.png'), frame.toPNG());
    const info = await win.webContents.executeJavaScript(`({canvas:!!document.querySelector('canvas'),w:document.querySelector('canvas')?.width,h:document.querySelector('canvas')?.height,text:document.body.innerText})`);
    assert.ok(info.canvas && info.w > 0 && info.h > 0, JSON.stringify(info));
    assert.ok(!info.text.includes('正在加载'), JSON.stringify(info));
    const artifact = await runtime.load('smoke'); assert.ok(artifact.snapshot.nodes.length > 3);
    console.log(JSON.stringify({ ok: true, directory, revision: artifact.revision, nodes: artifact.snapshot.nodes.length, canvas: info, errors }));
    runtime.close(); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack, JSON.stringify(errors)); win?.destroy(); app.exit(1); }
});
