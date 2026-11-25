/**
 * 端到端检查（直接连正在运行的桌面版）：
 * 重启后打开一条已经聊过的会话，点「⋯」看 Token 用量是否还带着累计值。
 * 只读界面操作，不改数据。
 *
 * 用法：应用需带 --remote-debugging-port=9223 启动。
 */
const PORT = Number(process.env.CDP_PORT || 9223);
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(response => response.json());
const page = list.find(item => item.type === 'page' && !/devtools/i.test(item.url));
if (!page) throw new Error('没有找到桌面版页面');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const task = pending.get(message.id);
  if (!task) return;
  pending.delete(message.id);
  if (message.error) task.reject(new Error(message.error.message));
  else task.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = async path => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.from(data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
// 让窗口回到前台，截图才有内容。
await send('Page.bringToFront');

const opened = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.chat-row')];
  const row = rows.find(item => item.textContent.includes('浏览器能力的边界'));
  if (!row) return { ok: false, titles: rows.map(item => item.textContent.trim()).slice(0, 12) };
  (row.querySelector('.chat-open') ?? row).click();
  return { ok: true };
})()`);
await wait(1200);

const before = await evaluate(`(() => ({
  title: document.querySelector('#chat-header-title')?.textContent,
  toggleHidden: document.querySelector('#chat-temporary-toggle')?.hidden,
  tagHidden: document.querySelector('#chat-header-tag')?.hidden,
}))()`);

await evaluate(`document.querySelector('#chat-more').click()`);
await wait(900);
const usage = await evaluate(`(() => {
  const panel = document.querySelector('#chat-usage');
  const text = id => document.querySelector('#' + id)?.textContent;
  return {
    open: !panel.hidden,
    total: text('usage-total'),
    totalSub: text('usage-total-sub'),
    cacheRate: text('usage-cache-rate'),
    inOut: text('usage-in-out'),
    calls: text('usage-calls'),
    elapsed: text('usage-elapsed'),
    cost: text('usage-cost'),
  };
})()`);
await shot('qa/desktop-usage-restart.png');
console.log(JSON.stringify({ opened, before, usage }, null, 2));
socket.close();
