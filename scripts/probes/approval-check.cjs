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
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval');
    return r.result?.value;
  };
  await evaluate("if (document.querySelector('.browser-panel')?.hidden) document.querySelector('#browser-toggle')?.click(); true");
  await evaluate("document.querySelector('[data-takeover-resume]')?.click(); window.movaDesktop.browser.respondTakeover?.('p1','resume'); true");
  await delay(300);
  await evaluate("window.movaDesktop.browser.credentials.loginRecord.ask('https://platform.deepseek.com')", false);
  await delay(900);
  const state = await evaluate("JSON.stringify({text:document.querySelector('#approval-host')?.innerText || '', buttons:[...document.querySelectorAll('#approval-host button')].map(x=>x.innerText.trim())})");
  console.log(state);
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('#approval-host button')].find(x => x.innerText.trim() === '允许一次');
    if (!btn) return false; btn.click(); return true;
  })()`);
  console.log('clicked', clicked);
  await delay(500);
  console.log(await evaluate("document.querySelector('#approval-host')?.innerText || ''"));
  ws.close();
})().catch(error => { console.error(error); process.exit(1); });
