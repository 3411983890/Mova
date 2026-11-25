'use strict';
const WebSocket = require('ws');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  const res = await fetch('http://127.0.0.1:9333/json');
  return res.json();
}

function connect(url, onEvent) {
  const ws = new WebSocket(url);
  let next = 1;
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id) return;
    onEvent(msg);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({
      send(method, params = {}) { return new Promise((res, rej) => { const id = next++; const h = raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id === id) { ws.off('message', h); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id, method, params })); }); },
      close: () => ws.close(),
    }));
    ws.once('error', reject);
  });
}

async function main() {
  const list = await targets();
  const page = list.find(t => t.type === 'page' && t.url.includes('mova://app'));
  if (!page) throw new Error('app target missing');
  const errors = [];
  const cdp = await connect(page.webSocketDebuggerUrl, msg => {
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push({ kind: 'exception', text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      errors.push({ kind: msg.params.type, text: msg.params.args?.map(a => a.value ?? a.description ?? '').join(' ') });
    }
    if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry?.level)) {
      errors.push({ kind: msg.params.entry.level, text: msg.params.entry.text, source: msg.params.entry.source });
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: false });
  await delay(7000);
  console.log(JSON.stringify({ count: errors.length, errors: errors.slice(0, 40) }, null, 2));
  cdp.close();
}

main().catch(e => { console.error(e); process.exit(2); });
