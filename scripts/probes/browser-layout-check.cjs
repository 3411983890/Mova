'use strict';
const WebSocket = require('ws');

async function main() {
  const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
  const page = list.find(t => t.url.includes('mova://app'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let next = 1;
  const pending = new Map();
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  await new Promise(resolve => ws.once('open', resolve));
  const send = (method, params) => new Promise(resolve => {
    const id = next++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  if (process.env.NEW_TAB === '1') {
    await evaluate("document.querySelector('.browser-tab-new')?.click(); true");
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  const all = await evaluate(`(async () => Promise.all([...document.querySelectorAll('.browser-webview')].map(async w => {
    const r = w.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, display: getComputedStyle(w).display, visibility: getComputedStyle(w).visibility, attrs: [...w.attributes].map(a => [a.name, a.value]), css: { width: getComputedStyle(w).width, height: getComputedStyle(w).height, transform: getComputedStyle(w).transform }, parent: w.parentElement?.className, inner: await w.executeJavaScript('innerWidth + "x" + innerHeight') };
  })))()`);
  const result = await evaluate(`(async () => {
    const w = [...document.querySelectorAll('.browser-webview')].find(x => getComputedStyle(x).display !== 'none') || document.querySelector('.browser-webview');
    const v = document.querySelector('.browser-viewport');
    const r = w.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    const info = await w.executeJavaScript('JSON.stringify({iw:innerWidth,ih:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:document.documentElement.clientWidth,ch:document.documentElement.clientHeight,text:document.body.innerText.slice(0,120)})');
    return { frame: { x: r.x, y: r.y, w: r.width, h: r.height }, viewport: { x: vr.x, y: vr.y, w: vr.width, h: vr.height }, info: JSON.parse(info) };
  })()`);
  const forced = await evaluate(`(async () => {
    const w = document.querySelector('.browser-webview');
    const v = document.querySelector('.browser-viewport');
    const panel = document.querySelector('.browser-panel');
    panel.style.animation = 'none';
    panel.style.transform = 'none';
    w.src = 'data:text/html,<title>Size</title><h1>Size</h1>';
    await new Promise(resolve => setTimeout(resolve, 1200));
    return await w.executeJavaScript('JSON.stringify({inner:innerWidth+"x"+innerHeight, outer:outerWidth+"x"+outerHeight, screen:screen.width+"x"+screen.height, vv:visualViewport.height, dpr:devicePixelRatio, doc:document.documentElement.getBoundingClientRect().toJSON()})');
  })()`);
  console.log(JSON.stringify({ all, result, forced }, null, 2));
  ws.close();
}
main().catch(error => { console.error(error); process.exit(2); });
