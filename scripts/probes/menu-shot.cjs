'use strict';
const fs = require('node:fs');
const WebSocket = require('ws');
(async () => {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list.find(t => t.url.includes('mova://app'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.once('open', r));
  const send = (method, params = {}) => new Promise(r => { const id = next++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.evaluate', { expression: "if (document.querySelector('.browser-panel')?.hidden) document.querySelector('#browser-toggle')?.click(); true" });
  await new Promise(r => setTimeout(r, 500));
  await send('Runtime.evaluate', { expression: "document.querySelector('[data-menu]')?.click(); true" });
  await new Promise(r => setTimeout(r, 400));
  const state = await send('Runtime.evaluate', { expression: "JSON.stringify({hidden:document.querySelector('.browser-menu')?.hidden,html:document.querySelector('.browser-menu')?.innerHTML.slice(0,400),tabs:document.querySelectorAll('.browser-webview').length})", returnByValue: true });
  console.log(state.result.value);
  const geometry = await send('Runtime.evaluate', {
    expression: `JSON.stringify({menu:document.querySelector('.browser-menu')?.getBoundingClientRect().toJSON(),clip:document.querySelector('.browser-webview')?.style.clipPath,bg:document.querySelector('.browser-viewport')?.style.backgroundImage.slice(0,40),vp:document.querySelector('.browser-viewport')?.getBoundingClientRect().toJSON()})`,
    returnByValue: true,
  });
  console.log(geometry.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('design/browser-menu.png', Buffer.from(shot.data, 'base64'));
  console.log('wrote design/browser-menu.png');
  ws.close();
})();
