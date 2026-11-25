'use strict';
const WebSocket = require('ws');
(async () => {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.once('open', r));
  const send = (method, params = {}) => new Promise(r => { const id = next++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evalx = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  console.log(await evalx(`document.querySelector('.browser-webview').executeJavaScript("window.open('https://example.com','_blank')")`));
  await new Promise(r => setTimeout(r, 2500));
  console.log(await evalx("JSON.stringify({webviews:document.querySelectorAll('webview').length,tabs:document.querySelectorAll('.browser-tab').length,active:[...document.querySelectorAll('.browser-tab')].map(x=>x.innerText)})"));
  ws.close();
})();
