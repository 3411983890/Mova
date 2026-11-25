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
    if (r.exceptionDetails) return { exception: r.exceptionDetails.text, description: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };
  console.log('before', JSON.stringify(await evaluate('window.movaDesktop.permissions.getPreset()')));
  console.log('set', JSON.stringify(await evaluate("window.movaDesktop.permissions.setPreset('full')")));
  console.log('after', JSON.stringify(await evaluate('window.movaDesktop.permissions.getPreset()')));
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
