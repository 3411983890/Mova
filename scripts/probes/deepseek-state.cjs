'use strict';
const WebSocket = require('ws');

(async () => {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list.find(t => t.url.includes('mova://app'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.once('open', r));
  const send = (method, params = {}) => new Promise(r => { const id = next++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval');
    return r.result?.value;
  };
  await evaluate("if (document.querySelector('.browser-panel')?.hidden) document.querySelector('#browser-toggle')?.click(); document.querySelector('[data-takeover-resume]')?.click(); true");
  await new Promise(r => setTimeout(r, 400));
  const info = await evaluate(`(() => {
    const w = document.querySelector('.browser-webview');
    return w.executeJavaScript("JSON.stringify({href:location.href,title:document.title,text:document.body.innerText.slice(0,2500),buttons:[...document.querySelectorAll('button,a')].map(x=>({tag:x.tagName,text:(x.innerText||x.getAttribute('aria-label')||'').trim(),href:x.href||''})).filter(x=>x.text).slice(0,80)})");
  })()`);
  console.log(JSON.stringify(JSON.parse(info || '{}'), null, 2));
  ws.close();
})().catch(error => { console.error(error); process.exit(1); });
