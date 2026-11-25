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
  await evalx(`(() => { const w=document.createElement('webview'); w.src='https://example.com'; w.style.cssText='position:fixed;left:10px;top:10px;width:400px;height:300px;z-index:9999;background:#fff'; document.body.append(w); return true; })()`);
  await new Promise(r => setTimeout(r, 3000));
  console.log(await evalx("JSON.stringify({count:document.querySelectorAll('webview').length, last:(()=>{const w=[...document.querySelectorAll('webview')].pop(); try{return w.getWebContentsId()}catch(e){return e.message}})()})"));
  ws.close();
})();
