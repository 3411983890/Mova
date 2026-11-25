// Real main-process, mova:// CSP, preload, settings and manual canvas smoke test.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const directory = path.join(__dirname, '../.test-temp/design-app-' + Date.now());
require('node:fs').mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
process.env.MOVA_AUTOSTART_SERVICES = 'false';
process.env.MOVA_TEST_VAULT = '1';
let started = false;
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('did-finish-load', async () => {
    if (started || win.webContents.getURL() !== 'mova://app/index.html') return;
    started = true;
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async code => { for (let i = 0; i < 300; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + code); };
    try {
      await wait(`!!document.querySelector('.rail-top [aria-label="设计画板"]')`);
      await js(`document.querySelector('#settings-button').click()`);
      await wait(`!!document.querySelector('[data-settings-item="design"]')`, 'design settings item');
      await js(`document.querySelector('[data-settings-item="design"]').click()`);
      await wait(`document.querySelector('#settings-page-design [role="switch"]')?.disabled === false`);
      assert.equal(await js(`document.querySelector('#settings-heading').textContent`), '设计');
      await js(`document.querySelector('[aria-label="允许 AI 编辑画板"]').click()`);
      await wait(`document.querySelector('[aria-label="允许 AI 编辑画板"]').getAttribute('aria-checked') === 'false'`);
      assert.equal(await js(`window.movaDesktop.design.settings().then(r=>r.value.aiEdit)`), false);
      await js(`document.querySelector('[aria-label="允许 AI 编辑画板"]').click()`);
      await wait(`document.querySelector('[aria-label="允许 AI 编辑画板"]').getAttribute('aria-checked') === 'true'`);
      await fs.writeFile(path.join(directory, 'settings.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('.settings-view').hidden=true;document.querySelector('.rail-top [aria-label="设计画板"]').click()`);
      await wait(`!!document.querySelector('.browser-canvas .mova-design-panel .mova-design-canvas canvas') && !document.querySelector('.mova-design-loading')`, 'canvas ready');
      await js(`document.querySelector('.mova-design-tools [aria-label="画板"]').click()`);
      // A synthetic drag exercises the canvas's own handlers; injected OS mouse moves do not
      // carry the pressed-button state that the drawing gesture needs.
      await js(`(async () => {
        const canvas = document.querySelector('.mova-design-canvas canvas');
        const rect = canvas.getBoundingClientRect();
        const x = rect.x + 80, y = rect.y + 100;
        const fire = (type, dx, dy, buttons) => canvas.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, composed: true, button: 0, buttons,
          clientX: x + dx, clientY: y + dy, view: window,
        }));
        fire('mousedown', 0, 0, 1);
        for (let step = 1; step <= 6; step++) {
          await new Promise(r => setTimeout(r, 25));
          fire('mousemove', 240 * step / 6, 300 * step / 6, 1);
        }
        fire('mouseup', 240, 300, 0);
        await new Promise(r => setTimeout(r, 400));
      })()`);
      await wait(`!!document.querySelector('.mova-design-properties')`);
      await new Promise(r => setTimeout(r, 700));
      const files = (await fs.readdir(path.join(directory, 'design'))).filter(f => f !== 'settings.json' && f.endsWith('.json'));
      assert.equal(files.length, 1);
      const document = JSON.parse(await fs.readFile(path.join(directory, 'design', files[0]), 'utf8'));
      assert.ok(document.snapshot.nodes.some(n => n.type === 'FRAME' && n.parentId && n.width > 100));
      await fs.writeFile(path.join(directory, 'workspace.png'), (await win.webContents.capturePage()).toPNG());
      assert.ok(!errors.some(e => /Content Security Policy|WebAssembly|Failed to fetch|Uncaught/.test(e)), errors.join('\n'));
      console.log(JSON.stringify({ ok: true, directory, revision: document.revision, errors }));
      app.quit(); setTimeout(() => app.exit(0), 700);
    } catch (error) { console.error(error.stack, errors); app.exit(1); }
  });
});
require('../electron/main.cjs');
setTimeout(() => { console.error('Full app design test timed out'); app.exit(1); }, 45000).unref();
