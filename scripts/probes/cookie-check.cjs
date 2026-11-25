'use strict';
const WebSocket = require('ws');
const delay = ms => new Promise(r => setTimeout(r, ms));

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
  await evaluate("document.querySelector('[data-menu]')?.click(); document.querySelector('[data-takeover-resume]')?.click(); true");
  await delay(300);
  const saved = await evaluate("window.movaDesktop.browser.credentials.loginRecord.save()");
  console.log('saved', JSON.stringify(saved));
  await evaluate("document.querySelector('.browser-webview').reload(); true");
  await delay(3000);
  const state = await evaluate("JSON.stringify({cookieHidden:document.querySelector('.browser-cookie-login').hidden, loginHidden:document.querySelector('.browser-login').hidden, origin:document.querySelector('.browser-cookie-origin').textContent})");
  console.log(state);
  ws.close();
})().catch(error => { console.error(error); process.exit(1); });
