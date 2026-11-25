// 复现/回归探针：「CLI 模型」页切走再切回来会不会整页空白。
//
// 背景：这一页由 React 挂载，根节点也带 `.settings-page` 类（它需要那一套 padding/滚动）。
// 而 app.js 的 selectSettingsPage 以前用 settingsView.querySelectorAll('.settings-page')
// 遍历所有后代并设 hidden，于是第二次进入时把 React 的根 div 一起藏了——表现就是白屏。
//
// 用法：node_modules\.bin\electron.cmd scripts\.probe-settings-pages.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const distHtml = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function snapshot(win, label) {
  return win.webContents.executeJavaScript(`(() => {
    const page = document.getElementById('settings-page-cli-models');
    const root = page?.firstElementChild ?? null;
    const rect = root?.getBoundingClientRect?.() ?? null;
    return {
      label: ${JSON.stringify(label)},
      pageHidden: page?.hidden ?? null,
      rootPresent: Boolean(root),
      rootHidden: root?.hidden ?? null,
      rootHasHiddenAttr: root?.hasAttribute?.('hidden') ?? null,
      rootHeight: rect ? Math.round(rect.height) : null,
      visibleText: Math.round((root?.innerText ?? '').length),
      heading: document.getElementById('settings-heading')?.textContent ?? null,
    };
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1440, height: 980, useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(String(message).slice(0, 200));
  });
  await win.loadURL(distHtml);
  win.showInactive();
  await wait(1200);

  const results = [];
  const open = id => win.webContents.executeJavaScript(
    `document.querySelector('[data-settings-item="${id}"]')?.click(), true`);

  // 先真的进设置页：只点导航项不会把 #settings-view 打开（那是 #settings-button 的事），
  // 否则截到的还是聊天页，看起来像「白屏」，其实是没进设置。
  await win.webContents.executeJavaScript(`document.querySelector('#settings-button')?.click(), true`);
  await wait(600);

  await open('cli-models');
  await wait(900);
  results.push(await snapshot(win, 'first-open'));
  const first = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'settings-cli-first.png'), first.toPNG());

  // 切到别的页面，再切回来——这就是用户报「白屏」的路径。
  await open('models');
  await wait(700);
  await open('cli-models');
  await wait(900);
  results.push(await snapshot(win, 'second-open'));
  const second = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'settings-cli-second.png'), second.toPNG());

  // 再切一次，确认第三次也正常（排除「只有第二次坏」的巧合）。
  await open('usage');
  await wait(600);
  await open('cli-models');
  await wait(900);
  results.push(await snapshot(win, 'third-open'));

  // 「模型」页：订阅 provider 的卡片、徽标、未登录提示都要在这里看清楚。
  await open('models');
  await wait(900);
  const modelsState = await win.webContents.executeJavaScript(`(() => {
    const page = document.getElementById('settings-page-models');
    const cards = [...(page?.querySelectorAll('.provider-card') ?? [])];
    return {
      labels: page?.querySelector('#models-page-caption')?.textContent ?? null,
      cards: cards.map(card => ({
        kind: card.dataset.kind ?? null,
        title: card.querySelector('.provider-title strong')?.textContent ?? null,
        badge: card.querySelector('.provider-badge')?.textContent ?? null,
        dot: card.querySelector('.provider-dot')?.dataset.on ?? null,
        note: card.querySelector('.model-config-message')?.textContent?.slice(0, 60) ?? null,
        hasDelete: Boolean(card.querySelector('.provider-remove')),
      })),
    };
  })()`);
  const models = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'settings-models-subscription.png'), models.toPNG());

  console.log(JSON.stringify({ results, modelsState, errors: errors.slice(0, 6) }, null, 2));
  app.quit();
});
