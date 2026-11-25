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
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  await evaluate("document.querySelector('[data-takeover-resume]')?.click(); true");
  await evaluate("window.movaDesktop.browser.respondTakeover?.('p1','resume')");
  await new Promise(r => setTimeout(r, 500));
  const result = await evaluate('window.movaDesktop.browser.credentials.loginRecord.save()');
  console.log(JSON.stringify(result, null, 2));
  ws.close();
})();
