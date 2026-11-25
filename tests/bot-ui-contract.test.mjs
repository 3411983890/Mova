/**
 * 负责：验证 Bot UI 契约与结构回归保护（Bot 模式下输入框隐藏模型/思考/权限控件、index.html 与 styles.css 小程序入口与 Drawer 挂载、
 *   app.js 移除同名限制并接入完整协作面板、BotConversation 严格过滤内部事件、BotChatInfo/Contacts/BotBuilder 符号与图标完整）。
 * 不负责：启动 Electron GUI 进程或真实浏览器交互。
 * 被谁调用：`node --test` 与 `scripts/accept.mjs`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('UI contract: composer hides model/effort/permission selectors in Bot mode', () => {
  const css = read('src/features/composer/composer-dark.css');
  assert.match(css, /:host\(\[data-bot-mode="true"\]\)\s+\.composer-model-tools > :not\(\.composer-send-btn\)[\s\S]*display:\s*none/);
  assert.equal(css.includes(':host([data-bot-mode="true"]) .composer-model-tools,'), false);
  assert.match(css, /:host\(\[data-bot-mode="true"\]\)\s+\.mova-approval-trigger/);
});

test('UI contract: index.html and styles.css mount MiniApps rail entry, main view, and side drawer', () => {
  const html = read('index.html');
  assert.match(html, /id="miniapps-button"/);
  assert.match(html, /id="miniapps-view"/);
  assert.match(html, /id="miniapp-side-drawer"/);

  const css = read('styles.css');
  assert.match(css, /\.content-frame\.miniapps-mode/);
  assert.match(css, /\.miniapp-side-drawer/);
  assert.match(css, /\.bot-structured-card/);
  assert.match(css, /\.bot-mention-popover/);
});

test('UI contract: app.js allows duplicate Bot names, wires MiniApps surfaces, and connects desktop Bots API', () => {
  const appJs = read('app.js');
  assert.equal(appJs.includes('请换一个名字'), false);
  assert.match(appJs, /MiniAppsView/);
  assert.match(appJs, /MiniAppSideDrawer/);
  assert.match(appJs, /hydrateBotsAndChatsFromDesktop/);
  assert.match(appJs, /setActiveArea\('miniapps'\)/);
});

test('UI contract: BotConversation filters out internal visibility messages and MiniAppsView uses allow-scripts sandbox without allow-same-origin', () => {
  const convJsx = read('src/features/bot/bot-conversation.jsx');
  assert.match(convJsx, /visibility\s*!==\s*'internal'/);
  assert.match(convJsx, /function ConsensusCard\(/);
  assert.match(convJsx, /MiniAppDirectCard/);

  const miniappsJsx = read('src/features/miniapps/miniapps.jsx');
  assert.match(miniappsJsx, /sandbox="allow-scripts"/);
  assert.equal(/sandbox="[^"]*allow-same-origin/.test(miniappsJsx), false);
  assert.match(miniappsJsx, /让创建 Bot 修复/);
  assert.match(miniappsJsx, /导出原始数据/);
});

test('UI contract: group click-to-@, tray/notification navigation, and main.cjs tray integration', () => {
  const convJsx = read('src/features/bot/bot-conversation.jsx');
  assert.match(convJsx, /onMentionBot/);
  assert.match(convJsx, /bot-message-avatar-btn/);
  assert.match(convJsx, /is-mentionable/);

  const infoJsx = read('src/features/botchat/bot-chat-info.jsx');
  assert.match(infoJsx, /onMentionBot/);
  assert.match(infoJsx, /bot-info-member-pick/);

  const appJs = read('app.js');
  assert.match(appJs, /onMentionBot/);
  assert.match(appJs, /navigate:conversation/);
  assert.match(appJs, /conversation:updated/);
  assert.match(appJs, /task:proactive-sent/);
  assert.match(appJs, /bot:status/);

  const mainCjs = read('electron/main.cjs');
  assert.match(mainCjs, /ensureBotTray/);
  assert.match(mainCjs, /pgPool:\s*\(\)\s*=>\s*memoryRuntime\?\.pool/);
  assert.match(mainCjs, /memoryRepository/);
  assert.match(mainCjs, /Notification/);
  assert.match(mainCjs, /onOpenConversation/);
});
