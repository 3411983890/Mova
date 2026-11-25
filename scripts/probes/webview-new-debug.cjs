'use strict';
const WebSocket = require('ws');
(async () => {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.once('open', r));
  const send = (method, params = {}) => new Promise(r => { const id = next++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evalx = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  await evalx(`(() => { const w=document.createElement('webview'); w.className='browser-frame browser-webview'; w.setAttribute('partition','persist:mova-browser'); w.setAttribute('allowpopups',''); w.style.cssText='display:flex;width:320px;height:300px'; w.src='https://example.com'; document.querySelector('.browser-viewport').append(w); return true; })()`);
  await new Promise(r => setTimeout(r, 3000));
  console.log(await evalx("document.querySelectorAll('webview').length + ' webviews; ' + [...document.querySelectorAll('webview')].map(w=>{try{return w.getWebContentsId()}catch(e){return 'ERR'}}).join(',')"));
  ws.close();
})();
