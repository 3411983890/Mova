'use strict';
const fs = require('node:fs');
const WebSocket = require('ws');

(async () => {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list.find(t => t.url.includes('mova://app'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1;
  const pending = new Map();
  ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } });
  await new Promise(resolve => ws.once('open', resolve));
  const send = (method, params = {}) => new Promise(resolve => { const id = next++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const result = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('design/browser-layout.png', Buffer.from(result.data, 'base64'));
  console.log('wrote design/browser-layout.png');
  ws.close();
})();
