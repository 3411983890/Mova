// 验收：右下角模型菜单里的厂商分组标题 + 未配置通道不出现。
//
// 菜单在输入栏的 shadow root 里，由 vendor 的 React 渲染；组标题是我们往 shadow DOM 里插的
// div.mova-model-group，靠 vendor 写在每个模型项上的 data-menu-item 复原分组。
//
// 用法：node_modules\.bin\electron.cmd scripts\.probe-model-menu.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const distHtml = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const step = (win, code) => win.webContents.executeJavaScript(`(() => { ${code} })()`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1440, height: 980, useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(__dirname, '.fake-providers-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    const name = typeof level === 'number' ? level : event?.level;
    if (Number(name) >= 2) errors.push(String(message ?? event?.message ?? '').slice(0, 160));
  });
  await win.loadURL(distHtml);
  win.showInactive();
  await wait(1600);

  // 1) 找到输入栏的 shadow root
  const found = await step(win, `
    const host = document.querySelector('#composer');
    if (!host) return { ok: false, reason: 'no #composer' };
    const root = host.shadowRoot
      ?? [...host.querySelectorAll('*')].map(node => node.shadowRoot).find(Boolean)
      ?? null;
    if (!root) {
      return { ok: false, reason: 'no shadow root', tag: host.firstElementChild?.tagName ?? null,
        html: (host.innerHTML ?? '').slice(0, 160) };
    }
    window.__probeRoot = root;
    return { ok: true, buttons: root.querySelectorAll('button').length,
      triggerText: [...root.querySelectorAll('button')]
        .map(button => button.textContent.trim()).filter(Boolean).slice(0, 6) };
  `);

  // 2) 点模型触发器（按钮文案里带当前模型显示名）
  const opened = await step(win, `
    const root = window.__probeRoot;
    const buttons = [...root.querySelectorAll('button')];
    const trigger = buttons.find(button => button.className.includes('mova-model-trigger'))
      ?? buttons.find(button => /DeepSeek|deepseek|ChatGPT|Gemini/.test(button.textContent));
    if (!trigger) return { ok: false, reason: 'no trigger', sample: buttons.map(b => b.textContent.trim()).slice(0, 10) };
    trigger.click();
    return { ok: true, trigger: trigger.textContent.trim() };
  `);
  await wait(450);

  // 3) 点进「模型」二级视图
  const entered = await step(win, `
    const root = window.__probeRoot;
    const row = [...root.querySelectorAll('.mova-row-button, button')]
      .find(node => /模型|妯″瀷/.test(node.textContent) && !node.className.includes('mova-model-trigger'));
    if (!row) return { ok: false, reason: 'no models row' };
    row.click();
    return { ok: true, row: row.textContent.trim().slice(0, 40) };
  `);
  await wait(500);

  // 4) 读菜单内容：分组标题 + 模型项
  const menu = await step(win, `
    const root = window.__probeRoot;
    const items = [...root.querySelectorAll('[data-menu-item]')];
    const headers = [...root.querySelectorAll('.mova-model-group')];
    const container = items[0]?.parentElement ?? null;
    const order = container
      ? [...container.children]
        .filter(node => node.matches('[data-menu-item], .mova-model-group'))
        .map(node => node.classList.contains('mova-model-group')
          ? '## ' + node.textContent
          : '   ' + node.textContent.trim() + '  [' + node.getAttribute('data-menu-item') + ']')
      : [];
    return {
      itemKeys: items.map(node => node.getAttribute('data-menu-item')),
      itemLabels: items.map(node => node.textContent.trim()),
      headerTexts: headers.map(node => node.textContent),
      headerCount: headers.length,
      order,
      groupsMap: Object.keys(window.__MOVA_MODEL_GROUPS ?? {}),
      namesMap: window.__MOVA_MODEL_NAMES ?? {},
    };
  `);

  const shot = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'composer-model-groups.png'), shot.toPNG());

  console.log(JSON.stringify({ found, opened, entered, menu, errors: errors.slice(0, 5) }, null, 2));
  app.quit();
});
