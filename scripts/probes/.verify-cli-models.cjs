// 验收脚本：打开打包后的设置页，切到「CLI 模型」，截图并回报渲染结果。
// 只读产物，不修改任何源文件。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const distHtml = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 980,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(String(message).slice(0, 200));
  });
  await win.loadURL(distHtml);
  win.showInactive();
  await new Promise(resolve => setTimeout(resolve, 1200));

  const opened = await win.webContents.executeJavaScript(`(() => {
    const nav = document.querySelector('[data-settings-item="cli-models"]');
    if (!nav) return { ok: false, reason: '导航项缺失' };
    nav.click();
    return { ok: true, navText: nav.textContent.trim() };
  })()`);

  await new Promise(resolve => setTimeout(resolve, 900));

  const state = await win.webContents.executeJavaScript(`(() => {
    const page = document.getElementById('settings-page-cli-models');
    const heading = document.getElementById('settings-heading');
    const root = page?.firstElementChild ?? null;
    const sections = page?.querySelectorAll('section').length ?? 0;
    const accountRows = page?.querySelectorAll('[class*="cm-account"]').length ?? 0;
    const quotaBars = page?.querySelectorAll('[role="progressbar"]').length ?? 0;
    return {
      pageExists: Boolean(page),
      pageHidden: page?.hidden ?? null,
      heading: heading?.textContent ?? null,
      source: root?.getAttribute('data-source') ?? null,
      className: root?.className ?? null,
      sections,
      accountRows,
      quotaBars,
      textSample: (page?.textContent ?? '').slice(0, 160),
    };
  })()`);

  const image = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'cli-models-live.png'), image.toPNG());

  console.log(JSON.stringify({ opened, state, errors: errors.slice(0, 5) }, null, 2));
  app.quit();
});
