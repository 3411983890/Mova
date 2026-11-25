// 验收：CLI 未检测到时点「添加 Google 账号」应当弹出安装指引弹窗（而不是发起登录）。
// 只读渲染产物，不改任何源文件。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1440, height: 980, useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      // 注入「桌面端已连上、但本机没装 CLI」的假桥接，才能走到真实弹窗分支。
      preload: path.join(__dirname, '.fake-subscription-preload.cjs'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(String(message).slice(0, 160));
  });
  await win.loadURL(pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href);
  win.showInactive();
  await new Promise(resolve => setTimeout(resolve, 1200));

  // 先真正打开设置视图（页面容器常驻 DOM，只点 nav 不会让它显示）
  const opened = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#settings-button')?.click();
    return !document.querySelector('#settings-view')?.hidden;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 500));
  await win.webContents.executeJavaScript(`document.querySelector('[data-settings-item="cli-models"]')?.click()`);
  await new Promise(resolve => setTimeout(resolve, 800));

  // 找 Gemini 卡片里的「添加 Google 账号」按钮并点击
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('#settings-page-cli-models button')];
    const target = buttons.find(b => /添加 Google 账号/.test(b.textContent || ''));
    if (!target) return { ok: false, reason: '找不到「添加 Google 账号」', buttons: buttons.map(b => b.textContent.trim()).slice(0, 20) };
    target.click();
    return { ok: true, label: target.textContent.trim() };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 700));

  const state = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('dialog[open]');
    const prompt = dialog?.querySelector('pre, .cm-install-prompt, [data-cli-prompt]');
    const text = prompt?.textContent ?? '';
    return {
      dialogOpen: Boolean(dialog),
      dialogTitle: dialog?.querySelector('h2,h3,strong')?.textContent?.trim() ?? null,
      hasPromptText: text.length > 200,
      promptChars: text.length,
      promptHasVersionCheck: /agy --version/.test(text),
      promptHasNoUrl: !/https?:\\/\\//.test(text),
      buttons: dialog ? [...dialog.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
    };
  })()`);

  const image = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'cli-install-dialog.png'), image.toPNG());

  console.log(JSON.stringify({ opened, clicked, state, errors: errors.slice(0, 4) }, null, 2));
  app.quit();
});
