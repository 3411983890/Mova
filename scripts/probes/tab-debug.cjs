'use strict';
const WebSocket = require('ws');
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list.find(t => t.type === 'page' && (t.url.includes('mova://app') || t.title.includes('ChatMova') || t.title.includes('Mova')));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1; const pending = new Map(); const errors = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args?.map(x => x.value ?? x.description).join(' '));
  });
  await new Promise(r => ws.once('open', r));
  const send = (method, params = {}) => new Promise(r => { const id = next++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };
  await send('Runtime.enable');
  await evaluate("if (document.querySelector('.browser-panel')?.hidden) document.querySelector('#browser-toggle')?.click(); true");
  await delay(400);
  await evaluate(`(() => { const i=document.querySelector('.browser-url'); i.value='https://example.com'; i.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true; })()`);
  await delay(5000);
  const state = await evaluate(`JSON.stringify({
    webviews:[...document.querySelectorAll('webview')].map(w=>({src:w.src,display:getComputedStyle(w).display,tab:w.dataset.tab,rect:w.getBoundingClientRect().toJSON()})),
    tabs:document.querySelector('.browser-tab-list')?.innerHTML,
    menu:document.querySelector('.browser-menu')?.innerHTML,
    error:document.querySelector('.browser-error')?.innerText,
    panelHidden:document.querySelector('.browser-panel')?.hidden,
    viewportHidden:document.querySelector('.browser-viewport')?.hidden,
    viewportDisplay:getComputedStyle(document.querySelector('.browser-viewport')).display,
    webviewParent:document.querySelector('webview')?.parentElement?.className,
    webviewConnected:document.querySelector('webview')?.isConnected,
    desktop:typeof window.movaDesktop,
    href:location.href
  })`);
  console.log(state);
  console.log('errors', errors);
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
