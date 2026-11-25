/**
 * 负责：通过 CDP 在当前运行的应用里求值一段脚本并打印结果——**不截图、不改视口**。
 * 不负责：截图（scripts/probes/shot-app.mjs；窗口最小化时 captureScreenshot 会挂住）。
 * 被谁调用：排查样式/状态时手工跑。
 *
 * 用法：node scripts/probes/eval-app.mjs <port> <脚本文件>
 */
import { readFile } from 'node:fs/promises';

const port = Number(process.argv[2] ?? 9223);
const scriptPath = process.argv[3];
if (!scriptPath) { console.error('用法：node scripts/probes/eval-app.mjs <port> <脚本文件>'); process.exit(1); }
const body = await readFile(scriptPath, 'utf8');

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(target => target.type === 'page');
if (!page) { console.error('没有找到 page 目标'); process.exit(1); }

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});
const send = (method, params = {}) => {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

try {
  await send('Runtime.enable');
  const timer = setTimeout(() => { console.error('求值超时'); process.exit(2); }, 25_000);
  const result = await send('Runtime.evaluate', {
    expression: `(async () => {\n${body}\n})()`, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  clearTimeout(timer);
  if (result.exceptionDetails) {
    console.error('页面异常：', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    process.exit(1);
  }
  console.log(JSON.stringify(result.result?.value ?? null, null, 2));
} finally {
  socket.close();
}
