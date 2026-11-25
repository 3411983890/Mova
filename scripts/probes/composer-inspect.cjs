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
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const root=document.querySelector('#composer [data-deep-agent-original]')?.shadowRoot; if(!root) return 'no-shadow'; return JSON.stringify({html:root.innerHTML.slice(0,5000), inputs:[...root.querySelectorAll('textarea,[contenteditable],input')].map(x=>({tag:x.tagName,cls:x.className,aria:x.getAttribute('aria-label'),role:x.getAttribute('role')})), buttons:[...root.querySelectorAll('button')].map(x=>({text:x.innerText.trim(),aria:x.getAttribute('aria-label'),cls:x.className})).filter(x=>x.text||x.aria)}); })()`,
    returnByValue: true,
  });
  console.log(r.result.value);
  ws.close();
})();
