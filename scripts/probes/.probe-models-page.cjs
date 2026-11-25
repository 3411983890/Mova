// 用假 providers 桥接渲染「模型」页：验收订阅 provider 的卡片、徽标、未登录提示、
// 以及「编辑」面板里只剩显示名称与模型目录（没有密钥/地址）。
//
// 用法：node_modules\.bin\electron.cmd scripts\.probe-models-page.cjs
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
    show: false, width: 1440, height: 1200, useContentSize: true,
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
    if (Number(name) >= 2) errors.push(String(message ?? event?.message ?? '').slice(0, 200));
  });
  await win.loadURL(distHtml);
  win.showInactive();
  await wait(1400);

  await win.webContents.executeJavaScript(`document.querySelector('#settings-button')?.click(), true`);
  await wait(600);
  await win.webContents.executeJavaScript(`document.querySelector('[data-settings-item="models"]')?.click(), true`);
  await wait(1200);

  const state = await win.webContents.executeJavaScript(`(() => {
    const page = document.getElementById('settings-page-models');
    const cards = [...(page?.querySelectorAll('.provider-card') ?? [])];
    return {
      cards: cards.map(card => ({
        kind: card.dataset.kind ?? null,
        title: card.querySelector('.provider-title strong')?.textContent ?? null,
        badge: card.querySelector('.provider-badge')?.textContent ?? null,
        dotOn: card.querySelector('.provider-dot')?.dataset.on ?? null,
        note: card.querySelector('.model-config-message')?.textContent?.slice(0, 70) ?? null,
        hasDelete: Boolean(card.querySelector('.provider-remove')),
        modelCount: card.querySelectorAll('.catalog-item').length,
      })),
    };
  })()`);
  const shotA = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'settings-models-subscription.png'), shotA.toPNG());

  // 打开未登录那条（Gemini）的编辑器：应该只有显示名称 + 模型目录，没有密钥/地址。
  const editor = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('#settings-page-models .provider-card')];
    const gemini = cards.find(card => card.textContent.includes('Gemini'));
    gemini?.querySelector('.settings-button')?.click();
    return Boolean(gemini);
  })()`);
  await wait(900);
  const editorState = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#settings-page-models .provider-card[data-editing="true"]');
    if (!card) return { editing: false };
    return {
      editing: true,
      kind: card.dataset.kind ?? null,
      fields: [...card.querySelectorAll('.provider-fields input, .provider-fields select')]
        .map(input => input.dataset.field ?? input.type),
      hasKeyField: Boolean(card.querySelector('input[data-field="key"]')),
      hasBaseUrlField: Boolean(card.querySelector('input[data-field="baseUrl"]')),
      hint: card.querySelector('.provider-fields .model-config-message')?.textContent?.slice(0, 60) ?? null,
      catalogSub: card.querySelector('.catalog-sub')?.textContent ?? null,
      catalogActions: [...card.querySelectorAll('.catalog-action')].map(button => button.textContent.trim()),
      rows: card.querySelectorAll('.catalog-item').length,
    };
  })()`);
  const shotB = await win.webContents.capturePage();
  await writeFile(path.join(__dirname, '..', 'assets', 'settings-models-subscription-edit.png'), shotB.toPNG());

  console.log(JSON.stringify({ state, editor, editorState, errors: errors.slice(0, 6) }, null, 2));
  app.quit();
});
