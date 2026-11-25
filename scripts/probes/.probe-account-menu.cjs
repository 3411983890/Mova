// 验收：CLI 模型页的账号行「⋯」菜单里到底有没有可用的操作（退出登录 = 删除当前登录状态）。
//
// 用法：node_modules\.bin\electron.cmd scripts\.probe-account-menu.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const distHtml = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1440, height: 1100, useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(__dirname, '.fake-accounts-preload.cjs'),
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
  await wait(1500);

  await win.webContents.executeJavaScript(`document.querySelector('#settings-button')?.click(), true`);
  await wait(600);
  await win.webContents.executeJavaScript(`document.querySelector('[data-settings-item="cli-models"]')?.click(), true`);
  await wait(1400);

  const before = await win.webContents.executeJavaScript(`(() => {
    const page = document.getElementById('settings-page-cli-models');
    const rows = [...(page?.querySelectorAll('[class*="cm-account"]') ?? [])];
    return {
      text: (page?.innerText ?? '').slice(0, 400),
      hasSharedPool: /共享池/.test(page?.innerText ?? ''),
      accountRows: rows.length,
      triggers: [...(page?.querySelectorAll('button[aria-haspopup="menu"]') ?? [])].length,
    };
  })()`);

  // 点第一个「⋯」
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const page = document.getElementById('settings-page-cli-models');
    const trigger = [...(page?.querySelectorAll('button[aria-haspopup="menu"]') ?? [])][0];
    if (!trigger) return { ok: false };
    trigger.click();
    return { ok: true, label: trigger.getAttribute('aria-label') };
  })()`);
  await wait(500);

  const menu = await win.webContents.executeJavaScript(`(() => {
    const popup = document.querySelector('.cm-popup');
    if (!popup) return { present: false };
    const rect = popup.getBoundingClientRect();
    const style = getComputedStyle(popup);
    return {
      present: true,
      visibility: style.visibility,
      display: style.display,
      zIndex: style.zIndex,
      rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
      items: [...popup.querySelectorAll('.cm-menu-item')].map(node => node.textContent.trim()),
      // 真凶候选：菜单被别的东西盖住 / 尺寸为 0 / visibility 仍是 hidden
      elementAtPoint: (() => {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit ? (hit.className || hit.tagName) : null;
      })(),
    };
  })()`);

  const shot = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'cli-account-menu.png'), shot.toPNG());

  console.log(JSON.stringify({ before, clicked, menu, errors: errors.slice(0, 5) }, null, 2));
  app.quit();
});
