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
  const runGuest = script => evaluate(`document.querySelector('.browser-webview').executeJavaScript(${JSON.stringify(script)})`);

  const filled = await runGuest(`(() => {
    const input = [...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('API key'));
    if (!input) return 'input-not-found';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'mova-acceptance');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  console.log('filled', filled);

  const clicked = await runGuest(`(() => {
    const exact = [...document.querySelectorAll('button,div,span')].filter(el => (el.innerText || '').trim() === '创建');
    const el = exact.find(x => String(x.className).includes('button')) || exact[exact.length - 1];
    if (!el) return 'button-not-found';
    el.click();
    return String(el.className);
  })()`);
  console.log('clicked', clicked);
  await delay(2200);

  const result = await runGuest(`JSON.stringify({
    text: document.body.innerText.slice(-2200),
    codes: [...document.querySelectorAll('code,pre')].map(x => x.innerText).filter(Boolean).slice(-10),
    inputs: [...document.querySelectorAll('input')].map(x => ({ type: x.type, value: x.value, placeholder: x.placeholder })),
    html: document.body.innerHTML.slice(-3000)
  })`);
  const parsed = JSON.parse(result || '{}');
  const haystack = `${parsed.text || ''}\n${(parsed.codes || []).join('\n')}\n${parsed.html || ''}`;
  const keys = [...new Set(haystack.match(/sk-[A-Za-z0-9_-]{20,}/g) || [])];
  console.log(JSON.stringify({ keys, text: parsed.text, codes: parsed.codes, inputs: parsed.inputs }, null, 2));
  ws.close();
})().catch(error => { console.error(error); process.exit(1); });
