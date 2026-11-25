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
  const clickScript = `(() => {
    const candidates = [...document.querySelectorAll('button,div,span,a')].filter(el => (el.innerText || '').trim() === '创建 API key');
    const el = candidates.find(x => x.tagName === 'BUTTON') || candidates[0];
    if (!el) return 'not-found';
    el.click();
    return el.tagName + '.' + el.className;
  })()`;
  const clickCreate = await evaluate(`document.querySelector('.browser-webview').executeJavaScript(${JSON.stringify(clickScript)})`);
  console.log('clicked', clickCreate);
  await delay(1200);
  const modal = await evaluate(`(() => {
    const w = document.querySelector('.browser-webview');
    return w.executeJavaScript("JSON.stringify({text:document.body.innerText.slice(-1800),inputs:[...document.querySelectorAll('input')].map(x=>({type:x.type,placeholder:x.placeholder,value:x.value})),buttons:[...document.querySelectorAll('button')].map(x=>({text:(x.innerText||x.getAttribute('aria-label')||'').trim(),disabled:x.disabled})).filter(x=>x.text)})");
  })()`);
  console.log(JSON.stringify(JSON.parse(modal || '{}'), null, 2));
  ws.close();
})().catch(error => { console.error(error); process.exit(1); });
