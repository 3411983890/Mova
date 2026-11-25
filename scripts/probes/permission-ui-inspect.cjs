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
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };
  const info = await evaluate(`(() => {
    const root = document.querySelector('#composer [data-deep-agent-original]')?.shadowRoot;
    const trigger = root?.querySelector('.mova-approval-trigger');
    return JSON.stringify({ text: trigger?.innerText, html: trigger?.parentElement?.innerHTML.slice(0, 5000), all: [...root.querySelectorAll('[role=menuitemradio],button')].map(x => ({ t: x.innerText.trim(), v: x.dataset.value, a: x.getAttribute('aria-checked') })).filter(x => x.t) });
  })()`);
  console.log(info);
  await evaluate("document.querySelector('#composer [data-deep-agent-original]').shadowRoot.querySelector('.mova-approval-trigger')?.click(); true");
  await new Promise(r => setTimeout(r, 500));
  const menu = await evaluate(`(() => JSON.stringify([...document.querySelectorAll('body *')]
    .filter(x => /完全访问|自动接受|请求批准/.test(x.textContent || '') && x.children.length === 0)
    .map(x => ({ tag: x.tagName, text: x.textContent.trim(), cls: x.className, role: x.getAttribute('role') })).slice(-30)))()`);
  console.log(menu);
  ws.close();
})();
