/**
 * 验证「临时聊天」入口搬到标题栏后、以及「模型能力与隐私」折叠面板删除后的
 * 关键状态：新聊天 / 已开始聊天 / 发送后的临时会话，顺带核对 Token 用量面板
 * 用的确实是保存的真实 usage。
 *
 * 用法：node qa/probe-privacy.mjs  （自带 dist 静态服务 + 无头 Edge）
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { launch } from '../../design/qa/cdp.mjs';

const root = normalize(join(process.cwd(), 'dist'));
const PORT = Number(process.env.PORT || 8766);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
};
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(root)) throw new Error('outside root');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

const url = `http://127.0.0.1:${PORT}/`;
const browser = await launch({ width: 1280, height: 860, scale: 1, url });
const readState = () => browser.evaluate(`(() => {
  const header = document.querySelector('#chat-header');
  const toggle = document.querySelector('#chat-temporary-toggle');
  const tag = document.querySelector('#chat-header-tag');
  const panelButton = document.querySelector('#browser-toggle');
  return {
    headerVisible: !header.hidden,
    title: document.querySelector('#chat-header-title').textContent,
    toggleVisible: !toggle.hidden,
    togglePressed: toggle.getAttribute('aria-pressed'),
    tagVisible: !tag.hidden,
    tagText: tag.textContent,
    panelButtonDisplay: getComputedStyle(panelButton).display,
    capabilities: document.querySelectorAll('#chat-capabilities, .chat-capabilities').length,
    headerChildren: [...header.querySelector('.chat-header-actions').children].map(el => el.id || el.className),
  };
})()`);

try {
  await browser.goto(url);
  await browser.evaluate(`localStorage.removeItem('mova.workspace.v1')`);
  await browser.goto(url);
  const empty = await readState();

  await browser.evaluate(`document.querySelector('#chat-temporary-toggle').click()`);
  await browser.wait(300);
  const armed = await readState();
  const feedback = await browser.evaluate(`(() => {
    const note = document.querySelector('#chat-feedback');
    return { hidden: note.hidden, text: note.textContent };
  })()`);
  await browser.shot('qa/privacy-new-chat.png');

  // 新聊天右侧的「⋯」仍然能打开 Token 用量（真实数据为空态）。
  await browser.evaluate(`document.querySelector('#chat-more').click()`);
  await browser.wait(700);
  const emptyUsage = await browser.evaluate(`(() => ({
    open: !document.querySelector('#chat-usage').hidden,
    total: document.querySelector('#usage-total').textContent,
    calls: document.querySelector('#usage-calls').textContent,
  }))()`);
  await browser.shot('qa/privacy-new-chat-usage.png');
  await browser.evaluate(`document.querySelector('.chat-usage-close').click()`);
  await browser.wait(400);

  // 已开始的会话：标题 + 隐私图标消失；用量面板显示保存的真实 usage。
  await browser.evaluate(`(() => {
    const key = JSON.stringify(['ChatMova', 'Mova', '开发 Mova 界面 HTML 原型']);
    localStorage.setItem('mova.workspace.v1', JSON.stringify({
      version: 1,
      projects: [{ name: 'Mova', chats: [{ title: '开发 Mova 界面 HTML 原型', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now() - 8.64e7, updatedAt: Date.now() }] }],
      conversations: [[key, [{ id: 'msg-1', text: '你好', at: Date.now() - 3.6e6, reply: { source: 'model', status: 'done', text: '你好。' } }]]],
      usage: [[key, { input: 184320, output: 9240, cacheRead: 261120, cacheWrite: 4096, totalTokens: 198656, cost: 0.0413, calls: 7, lastCall: { input: 41200, output: 1180 }, elapsedMs: 102000 }]],
    }));
  })()`);
  await browser.goto(url);
  await browser.evaluate(`document.querySelector('.chat-row .chat-open')?.click()`);
  await browser.wait(800);
  const chatting = await readState();
  await browser.evaluate(`document.querySelector('#chat-more').click()`);
  await browser.wait(800);
  const usage = await browser.evaluate(`(() => ({
    open: !document.querySelector('#chat-usage').hidden,
    total: document.querySelector('#usage-total').textContent,
    totalSub: document.querySelector('#usage-total-sub').textContent,
    cacheRate: document.querySelector('#usage-cache-rate').textContent,
    inOut: document.querySelector('#usage-in-out').textContent,
    calls: document.querySelector('#usage-calls').textContent,
    elapsed: document.querySelector('#usage-elapsed').textContent,
    cost: document.querySelector('#usage-cost').textContent,
  }))()`);
  await browser.shot('qa/privacy-chatting-usage.png');

  // 发送后的状态（图标消失、灰字保留、临时会话不入库）由 tests/temporary-chat.test.mjs
  // 直接在真实发送路径上覆盖；这里只截界面状态，因为无头浏览器无法可靠输入到
  // open shadow root 里的输入栏。
  console.log(JSON.stringify({ empty, armed, feedback, emptyUsage, chatting, usage, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
  server.close();
}
