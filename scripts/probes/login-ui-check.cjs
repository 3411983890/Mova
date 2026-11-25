'use strict';
// E2E for the HTML login card: real Mova renderer via remote debugging, real
// side browser, real CDP fill. It unchecks "remember" so it never writes the
// user's vault; this test is about the card + one-time fill path.
//
// Start Mova first:
//   npx electron . --remote-debugging-port=9333
// Then run:
//   node scripts/login-ui-test.cjs

const http = require('node:http');
const WebSocket = require('ws');

const PORT = 9333;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><title>Login Lab</title><h1>Login Lab</h1>
      <form id="f"><label>User<input id="user" autocomplete="username"></label>
      <label>Password<input id="pass" type="password" autocomplete="current-password"></label>
      <button id="submit" type="submit">Sign in</button></form>
      <div id="status">signed out</div>
      <script>document.getElementById('f').onsubmit=(event)=>{event.preventDefault();
        document.getElementById('status').textContent='Welcome '+document.getElementById('user').value;};</script>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`);
  return response.json();
}

async function waitTarget(timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const list = await targets();
      const page = list.find(item => item.type === 'page' && item.url.includes('mova://app'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* app still starting */ }
    await delay(250);
  }
  throw new Error('Mova renderer target not found');
}

function connect(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  async function send(method, params = {}) {
    await ready;
    const id = next++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result?.value;
  }
  return { send, evaluate, close: () => ws.close(), ready };
}

async function main() {
  const { server, port } = await startServer();
  const useTestVault = process.env.MOVA_TEST_VAULT === '1';
  const page = await waitTarget();
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;

  await cdp.evaluate("document.querySelector('#browser-toggle')?.click(); true");
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.browser-url');
    input.value = 'http://127.0.0.1:${port}/login';
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);

  let loaded = '';
  for (let i = 0; i < 60; i += 1) {
    loaded = await cdp.evaluate("document.querySelector('.browser-webview')?.getURL?.() || ''");
    if (loaded.includes('/login')) break;
    await delay(150);
  }
  if (!loaded.includes('/login')) throw new Error(`page did not load: ${loaded}`);

  await cdp.evaluate("document.querySelector('[data-login]')?.click(); true");
  let open = false;
  for (let i = 0; i < 40; i += 1) {
    open = await cdp.evaluate("!document.querySelector('.browser-login')?.hidden");
    if (open) break;
    await delay(100);
  }
  if (!open) throw new Error('login card did not open');

  await cdp.evaluate(`(() => {
    document.querySelector('.browser-login-user').value = 'ada';
    document.querySelector('.browser-login-password').value = 'secret';
    document.querySelector('.browser-login-remember').checked = ${useTestVault ? 'true' : 'false'};
    document.querySelector('.browser-login-submit').click();
    return true;
  })()`);

  let hidden = false;
  for (let i = 0; i < 60; i += 1) {
    hidden = await cdp.evaluate("document.querySelector('.browser-login')?.hidden === true");
    if (hidden) break;
    await delay(150);
  }
  const status = await cdp.evaluate("document.querySelector('.browser-webview').executeJavaScript(\"document.getElementById('status')?.textContent || ''\")");
  const hint = await cdp.evaluate("document.querySelector('.browser-login-hint')?.textContent || ''");
  let saved = null;
  if (useTestVault) {
    saved = await cdp.evaluate("window.movaDesktop.browser.credentials.list()");
  }
  const report = { loaded, cardHidden: hidden, status, hint, saved };
  console.log(JSON.stringify(report, null, 2));
  cdp.close();
  server.close();
  if (!hidden || !String(status).includes('Welcome ada')) process.exitCode = 1;
  if (useTestVault) {
    const rows = saved?.value?.credentials || [];
    if (!rows.some(row => String(row.origin || row.name || '').includes(`127.0.0.1:${port}`))) process.exitCode = 1;
  }
}

main().catch(error => { console.error('LOGIN UI TEST ERROR', error?.stack || error); process.exit(2); });
