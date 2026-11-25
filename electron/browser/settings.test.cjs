'use strict';
// 浏览器设置的存储校验，以及「授权等级 / 会话免确认 / 敏感动作」在工具层的实际效果。

const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createBrowserSettings, normalize, defaults } = require('./settings.cjs');
const { createBrowserTools } = require('./tools.cjs');
const { PageTarget } = require('./target.cjs');

function toolsWith(prefs, calls) {
  const noop = async () => ({ ok: true });
  return createBrowserTools({
    navigate: noop, snapshot: noop, read: noop, wait: noop, act: noop, dialog: noop, runJs: noop,
    storageExport: noop, storageImport: noop, upload: noop, batch: noop, login: noop, handoff: noop,
    screenshot: noop, tabs: noop, newTab: noop, selectTab: noop, closeTab: noop,
    skillList: noop, skillSave: noop, skillRemove: noop,
    emit: () => {},
    getUrl: () => 'https://shop.example.com/cart',
    approve: async request => { calls.push(request); return 'once'; },
    getPrefs: () => prefs,
  });
}

const actTool = tools => tools.find(tool => tool.name === 'browser_act');
const click = { action: 'click', target: '@e1', value: '' };

test('settings defaults match the page spec', () => {
  const value = defaults('/tmp/downloads');
  assert.equal(value.basics.enabled, true);
  assert.equal(value.basics.newTabUrl, 'https://www.google.com');
  assert.equal(value.basics.restoreTabs, false);
  assert.equal(value.basics.rememberWidth, true);
  assert.equal(value.basics.autoCollapseSidebar, false);
  assert.equal(value.agent.tier, 'interact');
  assert.equal(value.agent.confirmPerSite, true);
  assert.equal(value.agent.sessionWaiver, false);
  assert.equal(value.agent.sensitiveAlwaysConfirm, true);
  assert.equal(value.login.recordScope, 'conversation');
  assert.equal(value.transfer.uploadMaxMb, 25);
  assert.equal(value.transfer.blockExecutables, true);
  assert.deepEqual(value.skills, { mode: 'model' });
  assert.equal(value.advanced.jsBatch, false);
  assert.equal(value.advanced.actionTimeoutMs, 8000);
  assert.equal(value.advanced.waitTimeoutMs, 30000);
  assert.equal(value.advanced.snapshotBudget, 24000);
  assert.deepEqual([value.advanced.diffThreshold, value.advanced.iframeFallback], [0.6, true]);
});

test('sensitive confirmation is locked on and URLs are normalized', () => {
  const base = defaults('/tmp/downloads');
  const off = normalize({ agent: { sensitiveAlwaysConfirm: false } }, base);
  assert.equal(off.agent.sensitiveAlwaysConfirm, true, '敏感动作确认不可关闭');

  assert.equal(normalize({ basics: { newTabUrl: '' } }, base).basics.newTabUrl, '', '空串表示空白页');
  assert.equal(normalize({ basics: { newTabUrl: 'about:blank' } }, base).basics.newTabUrl, '');
  assert.equal(normalize({ basics: { newTabUrl: 'example.com' } }, base).basics.newTabUrl, 'https://example.com/');
  assert.equal(normalize({ basics: { newTabUrl: 'ftp://x' } }, base).basics.newTabUrl, 'https://www.google.com');
  assert.equal(normalize({ agent: { tier: 'root' } }, base).agent.tier, 'interact', '未知等级回落到默认');
  assert.equal(normalize({ advanced: { diffThreshold: 5 } }, base).advanced.diffThreshold, 1);
  assert.equal(normalize({ transfer: { uploadMaxMb: 9999 } }, base).transfer.uploadMaxMb, 512);
});

test('settings persist to disk and survive a reload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-browser-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'settings.json');
  const first = createBrowserSettings({ filePath, defaultDownloadsDir: dir });
  first.patch({ agent: { tier: 'submit' }, basics: { newTabUrl: 'https://example.org' } });
  const second = createBrowserSettings({ filePath, defaultDownloadsDir: dir });
  assert.equal(second.read().agent.tier, 'submit');
  assert.equal(second.read().basics.newTabUrl, 'https://example.org/');
});

test('read tier confirms even actions the session already allowed', async () => {
  const calls = [];
  await actTool(toolsWith({ tier: 'read', confirmPerSite: true, sessionWaiver: false, sensitiveAlwaysConfirm: true }, calls))
    .execute('a', click, undefined);
  assert.equal(calls.length, 1, '超出授权等级必须确认');
  assert.equal(calls[0].allowSession, false, '超等级动作不能复用会话许可');
  assert.equal(calls[0].overTier, true);
});

test('session waiver skips per-site confirmation but never for sensitive actions', async () => {
  const calls = [];
  const tools = toolsWith({ tier: 'interact', confirmPerSite: true, sessionWaiver: true, sensitiveAlwaysConfirm: true }, calls);
  await actTool(tools).execute('b', click, undefined);
  assert.equal(calls.length, 0, '会话免确认时普通点击不再询问');

  await actTool(tools).execute('c', { action: 'click', target: '@e9', value: '支付', submit: true }, undefined);
  assert.equal(calls.length, 1, '敏感动作始终确认');
  assert.equal(calls[0].allowSession, false);
});

test('turning per-site confirmation off lets in-tier actions through', async () => {
  const calls = [];
  await actTool(toolsWith({ tier: 'interact', confirmPerSite: false, sessionWaiver: false, sensitiveAlwaysConfirm: true }, calls))
    .execute('d', click, undefined);
  assert.equal(calls.length, 0);
});

test('download policy honours blockExecutables', () => {
  const fakeItem = name => ({
    cancelled: false,
    getFilename: () => name,
    cancel() { this.cancelled = true; },
    setSavePath() {}, once() {}, getReceivedBytes: () => 1, getState: () => 'completed',
  });
  const guest = { isDestroyed: () => false };
  const target = prefs => new PageTarget({ guest, tabId: 't', spaceId: 's', downloadsDir: process.cwd(), getTransferPrefs: () => prefs });

  const blocked = fakeItem('setup.exe');
  target({ blockExecutables: true }).handleDownload(blocked);
  assert.equal(blocked.cancelled, true, '默认拦截可执行文件');

  const allowed = fakeItem('setup.exe');
  target({ blockExecutables: false }).handleDownload(allowed);
  assert.equal(allowed.cancelled, false, '关闭后允许下载');
});
