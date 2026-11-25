// Dev utility: reload the app and report the first uncaught error.
// Usage: node qa/boot-error.mjs <port>
const port = Number(process.argv[2] ?? 9331);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(target => target.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const logs = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`EXCEPTION ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
  }
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise(resolve => setTimeout(resolve, 2500));
console.log(logs.join('\n') || '(no console output)');
socket.close();
