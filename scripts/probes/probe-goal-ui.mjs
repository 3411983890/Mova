/**
 * 目标 / 计划面板与「自动继续」进度行的界面检查（浏览器模式，数据seed 进去）。
 * 用法：node qa/probe-goal-ui.mjs
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { launch } from '../../design/qa/cdp.mjs';

const root = normalize(join(process.cwd(), 'dist'));
const PORT = Number(process.env.PORT || 8770);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2',
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
try {
  await browser.goto(url);
  await browser.evaluate(`(() => {
    const key = JSON.stringify(['ChatMova', 'Mova', '目标循环检查']);
    const chat = (id, text, extra = {}) => ({ id, text, at: Date.now() - 60000, reply: { source: 'model', status: 'done', text: '好。' }, ...extra });
    localStorage.setItem('mova.workspace.v1', JSON.stringify({
      version: 1,
      projects: [{ name: 'Mova', chats: [{ title: '目标循环检查', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now() - 864e5, updatedAt: Date.now() }] }],
      conversations: [[key, [
        chat('m1', '帮我把面试资料整理成一页提纲'),
        { id: 'm2', at: Date.now() - 30000, internal: true, note: '自动继续 · 第 2/6 轮', text: '[自动继续 2/6] 请继续推进目标「整理面试资料」。', reply: { source: 'model', status: 'done', text: '已经开始写提纲。' } },
      ]]],
      aims: [[key, {
        goal: { title: '整理面试资料', detail: '产出一页提纲', status: 'active', accepted: true, summary: '先读现有笔记' },
        plan: { steps: [
          { label: '读笔记', status: 'done' },
          { label: '写提纲', status: 'active' },
          { label: '自检', status: 'pending' },
        ] },
        auto: { rounds: 2, stall: 0, enabled: true },
      }]],
      usage: [],
    }));
  })()`);
  await browser.goto(url);
  await browser.evaluate(`document.querySelector('.chat-row .chat-open')?.click()`);
  await browser.wait(700);

  const transcript = await browser.evaluate(`(() => ({
    note: document.querySelector('.turn-auto-note')?.textContent,
    userBubbles: [...document.querySelectorAll('#conversation .user-message')].map(node => node.textContent.slice(0, 20)),
  }))()`);

  await browser.evaluate(`document.querySelector('#chat-aim').click()`);
  await browser.wait(700);
  const panel = await browser.evaluate(`(() => ({
    open: !document.querySelector('#aim-panel').hidden,
    title: document.querySelector('#aim-panel-title').textContent,
    goal: document.querySelector('#aim-goal-title').textContent,
    state: document.querySelector('#aim-goal-state').textContent,
    foot: document.querySelector('#aim-foot-state').textContent,
    autoVisible: !document.querySelector('#aim-auto').hidden,
    autoPressed: document.querySelector('#aim-auto').getAttribute('aria-pressed'),
    steps: [...document.querySelectorAll('.aim-step')].map(step => step.textContent.trim()),
    pill: document.querySelector('#chat-aim-text').textContent,
  }))()`);
  await browser.shot('qa/goal-panel.png');

  await browser.evaluate(`document.querySelector('#aim-auto').click()`);
  await browser.wait(300);
  const afterToggle = await browser.evaluate(`(() => ({
    foot: document.querySelector('#aim-foot-state').textContent,
    pressed: document.querySelector('#aim-auto').getAttribute('aria-pressed'),
  }))()`);

  console.log(JSON.stringify({ transcript, panel, afterToggle, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
  server.close();
}
