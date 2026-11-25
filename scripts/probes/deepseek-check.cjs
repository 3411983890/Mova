'use strict';
const WebSocket = require('ws');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list.find(t => t.type === 'page' && t.url.includes('mova://app'));
  if (!page) throw new Error('app target missing');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1;
  const pending = new Map();
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id) return;
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
    return r.result?.value;
  };

  await evaluate("if (document.querySelector('.browser-panel')?.hidden) document.querySelector('#browser-toggle')?.click(); true");
  await delay(300);
  await evaluate("document.querySelector('[data-takeover-resume]')?.click(); true");
  await delay(300);
  await evaluate(`(() => {
    const input = document.querySelector('.browser-url');
    input.value = 'https://platform.deepseek.com/usage';
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);

  let href = '';
  for (let i = 0; i < 100; i += 1) {
    href = await evaluate("document.querySelector('.browser-webview')?.getURL?.() || ''");
    if (href.includes('deepseek.com')) break;
    await delay(200);
  }
  await delay(2500);
  const info = await evaluate(`(() => {
    const w = document.querySelector('.browser-webview');
    return w.executeJavaScript("JSON.stringify({href:location.href,title:document.title,text:document.body.innerText.slice(0,1500)})");
  })()`);
  console.log(JSON.stringify({ href, info: JSON.parse(info || '{}') }, null, 2));
  ws.close();
}

main().catch(e => { console.error(e); process.exit(2); });
