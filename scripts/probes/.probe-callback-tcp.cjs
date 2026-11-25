// 决定性判断：回调端口有没有真的在监听 TCP。
// 用 node:net 直连（绕开 fetch/代理），再用 node:http 请求一次，最后才用 fetch。
const { app, safeStorage } = require('electron');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

app.whenReady().then(async () => {
  // 先起一个「对照组」：完全裸的 http server，确认本进程能连自己
  const control = http.createServer((req, res) => { res.writeHead(200); res.end('control-ok'); });
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
  const controlPort = control.address().port;

  const connect = port => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.end(); resolve('connected'); });
    socket.on('error', error => resolve(`error:${error.code || error.message}`));
    socket.setTimeout(3000, () => { socket.destroy(); resolve('timeout'); });
  });

  const viaHttp = port => new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/auth/callback?code=x&state=y' }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: body.slice(0, 60).replace(/\s+/g, ' ') }));
    });
    request.on('error', error => resolve(`error:${error.code || error.message}`));
    request.setTimeout(3000, () => { request.destroy(); resolve('timeout'); });
  });

  const useFetch = async url => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return `status:${response.status}`;
    } catch (error) {
      return `error:${error.cause?.code || error.code || error.message}`.slice(0, 80);
    }
  };

  const out = { control: {}, real: {} };

  out.control.tcp = await connect(controlPort);
  out.control.http = await viaHttp(controlPort);
  out.control.fetch = await useFetch(`http://127.0.0.1:${controlPort}/`);

  // 真实订阅登录：同样只看端口
  const { mkdtemp } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { pathToFileURL } = require('node:url');
  const ipcUrl = pathToFileURL(path.join(__dirname, '..', 'electron', 'subscription', 'ipc.mjs')).href;
  const { installSubscriptionIpc } = await import(ipcUrl);
  const handlers = new Map();
  installSubscriptionIpc({
    ipcMain: { handle(c, f) { handlers.set(c, f); }, removeHandler(c) { handlers.delete(c); } },
    app,
    shell: { openExternal: async () => {} },
    safeStorage,
    userDataDir: await mkdtemp(path.join(tmpdir(), 'mova-cb2-')),
    fetch: () => { throw new Error('no network'); },
    logger: { info() {}, warn() {} },
    getWindows: () => [],
  });
  const started = await handlers.get('subscription:login')({}, { provider: 'chatgpt' });
  const redirect = new URL(started.value.authorizeUrl).searchParams.get('redirect_uri');
  const port = Number(new URL(redirect).port);
  out.redirectUri = redirect;
  out.real.tcp = await connect(port);
  out.real.http = await viaHttp(port);
  out.real.fetch = await useFetch(`${redirect}?code=x&state=y`);

  console.log(JSON.stringify(out, null, 2));
  control.close();
  app.quit();
});
