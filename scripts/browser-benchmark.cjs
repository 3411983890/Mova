'use strict';
// Local benchmark for the implemented browser-agent surface. It is deliberately
// small and deterministic: 12 tasks against a throwaway HTTP fixture, driven
// through the same controller/tool layer the chat uses.
// Run: npx electron scripts/browser-benchmark.cjs

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserController } = require('../electron/browser/controller.cjs');
const { createProcedureStore } = require('../electron/browser/procedures.cjs');
const { createSiteCardStore } = require('../electron/browser/site-cards.cjs');
const { createCredentialBroker } = require('../electron/browser/credentials.cjs');

const OUT = path.join(__dirname, '..', 'design', 'browser-benchmark.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let crossPort = 0;

const PAGES = {
  '/one': '<!doctype html><title>One</title><h1>One</h1><button>One Button</button>',
  '/two': '<!doctype html><title>Two</title><h1>Two</h1><button>Two Button</button>',
  '/article': `<!doctype html><title>Benchmark Article</title><article><h1>Mova benchmark</h1>
    <p>This article exists so the reader can prove it extracts the main content instead of navigation chrome.</p>
    <p>It mentions a unique phrase: silver-orchid-42. The agent should find that phrase in browser_read output.</p>
    <p>${'Background detail. '.repeat(40)}</p></article>`,
  '/list': `<!doctype html><title>Orders</title><h1>Orders</h1>
    <input id="q" aria-label="Search" placeholder="Search">
    <button id="export">Export</button>
    <table aria-label="Orders"><thead><tr><th>ID</th><th>Status</th></tr></thead>
    <tbody><tr><td>A-1</td><td>Shipped</td></tr></tbody></table>`,
  '/counter': `<!doctype html><title>Counter</title><h1>Counter</h1>
    <button id="inc">Increase</button><div id="count">Count: 0</div>
    <script>let n=0;document.getElementById('inc').onclick=()=>{n+=1;document.getElementById('count').textContent='Count: '+n;}</script>`,
  '/search': `<!doctype html><title>Search</title><h1>Search</h1>
    <input id="q" aria-label="Search"><button id="search">Search</button><div id="results">idle</div>
    <script>document.getElementById('search').onclick=()=>{const q=document.getElementById('q').value.toLowerCase();
      const rows=['Alpha','Beta','Gamma'].filter(x=>x.toLowerCase().includes(q));
      document.getElementById('results').textContent=rows.join(', ')||'none';};</script>`,
  '/table': `<!doctype html><title>Table</title><h1>Table</h1>
    <table aria-label="Rows"><tbody><tr><td>A-1</td><td>New</td></tr><tr><td>A-2</td><td>New</td></tr></tbody></table>
    <button id="next">Next page</button>
    <script>document.getElementById('next').onclick=()=>{const tr=document.createElement('tr');
      tr.innerHTML='<td>A-3</td><td>Page 2</td>';document.querySelector('tbody').append(tr);};</script>`,
  '/form': `<!doctype html><title>Form</title><h1>Form</h1>
    <label>Name<input id="name"></label><label>Email<input id="email" type="email"></label>
    <button id="save">Save</button><div id="status">idle</div>
    <script>document.getElementById('save').onclick=()=>{document.getElementById('status').textContent='Saved';};</script>`,
  '/dialog': `<!doctype html><title>Dialog</title><h1>Dialog</h1>
    <button id="ask">Ask</button><script>document.getElementById('ask').onclick=()=>alert('benchmark alert');</script>`,
  '/confirm': `<!doctype html><title>Confirm</title><h1>Confirm</h1>
    <button id="ask">Ask</button><div id="result">idle</div>
    <script>document.getElementById('ask').onclick=()=>{document.getElementById('result').textContent=confirm('Continue?')?'yes':'no';};</script>`,
  '/slow': `<!doctype html><title>Slow</title><h1>Slow</h1><div id="late">waiting</div>
    <script>setTimeout(()=>{document.getElementById('late').textContent='ready';},700);</script>`,
  '/login': `<!doctype html><title>Login</title><h1>Login</h1>
    <form id="form"><label>User<input id="user" autocomplete="username"></label>
    <label>Password<input id="pass" type="password" autocomplete="current-password"></label>
    <button id="login" type="submit">Sign in</button></form><div id="status">signed out</div>
    <script>document.getElementById('form').onsubmit=(event)=>{event.preventDefault();document.getElementById('status').textContent='Welcome';};</script>`,
  '/download': `<!doctype html><title>Download</title><h1>Download</h1>
    <a id="dl" href="/file.csv" download="report.csv">Download report</a>`,
  '/upload': `<!doctype html><title>Upload</title><h1>Upload</h1>
    <input id="file" type="file"><div id="picked">none</div>
    <script>document.getElementById('file').onchange=(event)=>{document.getElementById('picked').textContent=event.target.files[0]?.name||'none';};</script>`,
  '/upload-button': `<!doctype html><title>Upload Button</title><h1>Upload Button</h1>
    <button id="pick">Pick file</button><input id="file" type="file" style="display:none">
    <div id="picked">none</div>
    <script>document.getElementById('pick').onclick=()=>document.getElementById('file').click();
    document.getElementById('file').onchange=(event)=>{document.getElementById('picked').textContent=event.target.files[0]?.name||'none';};</script>`,
  '/frame': `<!doctype html><title>Frame</title><h1>Frame</h1><div id="result">idle</div>
    <iframe src="/frame-inner" width="320" height="140"></iframe>
    <script>addEventListener('message',event=>{if(event.data==='inner')document.getElementById('result').textContent='inner';});</script>`,
  '/frame-inner': `<!doctype html><title>Inner</title><button id="inner">Inner</button>
    <script>document.getElementById('inner').onclick=()=>parent.postMessage('inner','*');</script>`,
  '/set': `<!doctype html><title>Set</title><h1>Set</h1><div id="who"></div>
    <script>const user=new URLSearchParams(location.search).get('user')||'none';document.cookie='bench_user='+user+'; path=/';document.getElementById('who').textContent='user='+user;</script>`,
  '/whoami': `<!doctype html><title>Whoami</title><h1>Whoami</h1><div id="who"></div>
    <script>document.getElementById('who').textContent=document.cookie||'empty';</script>`,
};

function startServer() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/frame-cross') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Cross Frame</title><h1>Cross Frame</h1><div id="result">idle</div>
        <iframe src="http://127.0.0.1:${crossPort}/frame-inner" width="320" height="140"></iframe>
        <script>addEventListener('message',event=>{if(event.data==='inner')document.getElementById('result').textContent='inner';});</script>`);
      return;
    }
    if (pathname === '/file.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="report.csv"',
        'Cache-Control': 'no-store',
      });
      res.end('id,status\nA-1,Shipped\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGES[pathname] || PAGES['/one']);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const primary = await startServer();
  const secondary = await startServer();
  crossPort = secondary.port;
  const { server, port } = primary;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mova-bench-'));
  const procedures = createProcedureStore({ directory });
  const cards = createSiteCardStore({ directory });
  const downloadsDir = path.join(directory, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const vaultEntries = new Map();
  const fakeVault = {
    async status() { return { configured: true, unlocked: true, count: vaultEntries.size }; },
    async put(input) { vaultEntries.set(input.name, input.value); return { updatedAt: new Date().toISOString() }; },
    async get(name) {
      if (!vaultEntries.has(name)) { const error = new Error('not-found'); error.code = 'not-found'; throw error; }
      return vaultEntries.get(name);
    },
    async list() { return [...vaultEntries.keys()].map(name => ({ name, kind: 'password', preview: '****', updatedAt: new Date().toISOString() })); },
  };
  const credentials = createCredentialBroker({ getVault: () => fakeVault });
  const win = new BrowserWindow({
    width: 1080, height: 820, show: true,
    webPreferences: {
      preload: path.join(__dirname, 'browser-spike-tabs-preload.cjs'),
      webviewTag: true, contextIsolation: true, sandbox: false,
    },
  });
  const controller = createBrowserController({ app, getWindow: () => win, procedures, cards, credentials, downloadsDir });
  ipcMain.on('browser:tab:ready', (_e, payload) => controller.tabReady(payload?.tabId, payload?.guestId, payload?.spaceId));
  ipcMain.on('browser:tab:active', (_e, payload) => controller.tabActive(payload?.tabId, payload?.spaceId));
  ipcMain.on('browser:tab:closed', (_e, payload) => controller.tabClosed(payload?.tabId));
  ipcMain.on('browser:tab:cleared', (_e, payload) => controller.tabCleared(payload?.spaceId));
  win.webContents.on('did-attach-webview', (_e, guest) => { void controller.registerGuest(guest); });

  let takeoverEvent = null;
  const rawSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'browser:takeover') takeoverEvent = payload;
    return rawSend(channel, payload);
  };
  await win.loadFile(path.join(__dirname, 'browser-spike-tabs.html'));
  const tools = controller.tools({ approve: async () => 'once' });

  const results = [];
  let calls = 0;
  let chars = 0;
  const timings = [];
  let clickCalls = 0;
  let clickFailures = 0;
  async function call(name, args) {
    calls += 1;
    const isClick = name === 'browser_act' && args?.action === 'click';
    if (isClick) clickCalls += 1;
    const started = Date.now();
    try {
      const tool = tools.find(item => item.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      const result = await tool.execute(`${name}-${calls}`, args);
      const text = result.content?.[0]?.text || '';
      chars += text.length;
      let value = null;
      try { value = JSON.parse(text); } catch { value = text; }
      if (result.isError) throw new Error(`${name}: ${value?.code || 'error'} ${value?.message || ''}`);
      return value;
    } catch (error) {
      if (isClick) clickFailures += 1;
      throw error;
    } finally {
      timings.push({ name, ms: Date.now() - started });
    }
  }
  async function task(name, fn) {
    const beforeCalls = calls;
    const beforeChars = chars;
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - started, calls: calls - beforeCalls, chars: chars - beforeChars, detail });
    } catch (error) {
      results.push({ name, ok: false, ms: Date.now() - started, calls: calls - beforeCalls, chars: chars - beforeChars, error: error.message });
    }
  }

  const base = `http://127.0.0.1:${port}`;

  await task('read-article', async () => {
    await call('browser_navigate', { url: `${base}/article` });
    const read = await call('browser_read', { maxChars: 4000 });
    if (!read.text.includes('silver-orchid-42')) throw new Error('unique phrase missing');
    return { chars: read.chars };
  });

  await task('snapshot-controls', async () => {
    await call('browser_navigate', { url: `${base}/list` });
    const snap = await call('browser_snapshot', { mode: 'full' });
    if (!snap.text.includes('button "Export"')) throw new Error('Export button missing');
    return { chars: snap.text.length, mode: snap.mode };
  });

  await task('click-and-expect', async () => {
    await call('browser_navigate', { url: `${base}/counter` });
    const act = await call('browser_act', { action: 'click', target: 'css=#inc', expect: { text: 'Count: 1' } });
    return { diff: Boolean(act.diff) };
  });

  await task('site-search', async () => {
    await call('browser_navigate', { url: `${base}/search` });
    await call('browser_act', { action: 'fill', target: 'css=#q', value: 'Bet' });
    await call('browser_act', { action: 'click', target: 'css=#search', expect: { text: 'Beta' } });
    const read = await call('browser_read', { maxChars: 1000 });
    if (!read.text.includes('Beta')) throw new Error('search result missing');
    return { chars: read.chars };
  });

  await task('table-pagination', async () => {
    await call('browser_navigate', { url: `${base}/table` });
    await call('browser_act', { action: 'click', target: 'css=#next', expect: { text: 'Page 2' } });
    const read = await call('browser_read', { maxChars: 1000 });
    if (!read.text.includes('A-3') || !read.text.includes('Page 2')) throw new Error('next page row missing');
    return { chars: read.chars };
  });

  await task('js-batch', async () => {
    const result = await call('browser_run_js', {
      script: `await page.goto('${base}/search');
        await page.fill('#q', 'Ga');
        await page.click('#search');
        await page.waitFor({ for: 'text', text: 'Gamma', timeout: 2000 });
        return { text: await page.text('#results') };`,
    });
    if (!String(result.result?.text || '').includes('Gamma')) throw new Error('js result missing');
    return { text: result.result.text };
  });

  await task('batch-form', async () => {
    await call('browser_navigate', { url: `${base}/form` });
    const batch = await call('browser_batch', {
      steps: [
        { op: 'fill', target: 'css=#name', value: 'Ada' },
        { op: 'fill', target: 'css=#email', value: 'ada@example.test' },
        { op: 'click', target: 'css=#save', expect: { text: 'Saved' } },
      ],
    });
    if (!batch.ok) throw new Error('batch failed');
    return { steps: batch.steps.length, learned: batch.learned?.id || null };
  });

  await task('dialog-auto-accept', async () => {
    await call('browser_navigate', { url: `${base}/dialog` });
    const act = await call('browser_act', { action: 'click', target: 'css=#ask', snapshot: false });
    if (act.dialog?.handled !== 'accepted') throw new Error('dialog not accepted');
    return { dialog: act.dialog };
  });

  await task('login-fill', async () => {
    await credentials.save({ origin: base, username: 'ada', password: 'secret' });
    await call('browser_navigate', { url: `${base}/login` });
    const login = await call('browser_login', { submit: true });
    const snap = await call('browser_snapshot', { mode: 'full' });
    if (!snap.text.includes('Welcome')) throw new Error('login did not submit');
    return { username: login.username, submitted: login.submitted };
  });

  await task('download', async () => {
    await call('browser_navigate', { url: `${base}/download` });
    const act = await call('browser_act', { action: 'click', target: 'css=#dl', snapshot: false });
    if (act.download?.state !== 'completed') throw new Error(`download ${act.download?.state || 'missing'}`);
    if (!fs.existsSync(act.download.path)) throw new Error('download file missing');
    return { bytes: act.download.bytes, filename: act.download.filename };
  });

  await task('upload', async () => {
    const file = path.join(directory, 'report.txt');
    fs.writeFileSync(file, 'uploaded by benchmark\n');
    await call('browser_navigate', { url: `${base}/upload` });
    const uploaded = await call('browser_upload', { target: 'css=#file', files: [file] });
    const snap = await call('browser_snapshot', { mode: 'full' });
    if (!snap.text.includes('report.txt')) throw new Error('file name not reflected');
    return { files: uploaded.files };
  });

  await task('upload-chooser', async () => {
    const file = path.join(directory, 'chooser.txt');
    fs.writeFileSync(file, 'picked through a button\n');
    await call('browser_navigate', { url: `${base}/upload-button` });
    const uploaded = await call('browser_upload', { target: 'css=#pick', files: [file] });
    const snap = await call('browser_snapshot', { mode: 'full' });
    if (!snap.text.includes('chooser.txt')) throw new Error('chosen file name not reflected');
    return { files: uploaded.files, via: uploaded.via };
  });

  await task('iframe', async () => {
    await call('browser_navigate', { url: `${base}/frame` });
    const snap = await call('browser_snapshot', { mode: 'full' });
    const match = snap.text.match(/button "Inner" \[ref=([^\]]+)\]/);
    if (!match) throw new Error('iframe button missing from snapshot');
    await call('browser_act', { action: 'click', target: `@${match[1]}`, expect: { text: 'inner' } });
    return { ref: match[1] };
  });

  await task('iframe-cross-origin', async () => {
    await call('browser_navigate', { url: `${base}/frame-cross` });
    await new Promise(resolve => setTimeout(resolve, 300));
    const snap = await call('browser_snapshot', { mode: 'full' });
    const match = snap.text.match(/button "Inner" \[ref=([^\]]+)\]/);
    if (!match) throw new Error('cross-origin iframe button missing');
    await call('browser_act', { action: 'click', target: `@${match[1]}`, snapshot: false });
    await delay(300);
    const after = await call('browser_snapshot', { mode: 'full' });
    if (!after.text.includes('inner')) throw new Error(`cross frame result missing: ${after.text.slice(0, 400)}`);
    return { ref: match[1] };
  });

  await task('dual-account', async () => {
    await call('browser_navigate', { url: `${base}/set?user=alice` });
    const second = await call('browser_tabs', { action: 'new', url: `${base}/set?user=bob`, space: 'space-2' });
    await delay(350);
    const list = await call('browser_tabs', { action: 'list' });
    const firstTab = list.tabs.find(tab => tab.spaceId === 'default');
    if (!firstTab || !second.tabId) throw new Error('expected two spaces');
    await call('browser_tabs', { action: 'select', tabId: firstTab.tabId });
    await call('browser_navigate', { url: `${base}/whoami` });
    const alice = await call('browser_read', { maxChars: 500 });
    if (!alice.text.includes('bench_user=alice')) throw new Error(`shared cookie: ${alice.text.slice(0, 120)}`);
    await call('browser_tabs', { action: 'select', tabId: second.tabId });
    await call('browser_navigate', { url: `${base}/whoami` });
    const bob = await call('browser_read', { maxChars: 500 });
    if (!bob.text.includes('bench_user=bob')) throw new Error(`isolated cookie: ${bob.text.slice(0, 120)}`);
    return { shared: 'alice', isolated: 'bob' };
  });

  await task('background-space', async () => {
    const before = await call('browser_tabs', { action: 'list' });
    const defaultTab = before.tabs.find(tab => tab.spaceId === 'default');
    if (defaultTab) await call('browser_tabs', { action: 'select', tabId: defaultTab.tabId });
    await call('browser_navigate', { url: `${base}/set?user=alice`, space: 'default' });
    const background = await call('browser_tabs', {
      action: 'new',
      url: `${base}/set?user=bob`,
      space: 'space-bg',
      background: true,
    });
    if (!background.tabId) throw new Error('background tab missing');
    await call('browser_navigate', { url: `${base}/whoami`, space: 'space-bg' });
    const bob = await call('browser_read', { maxChars: 500, space: 'space-bg' });
    if (!bob.text.includes('bench_user=bob')) throw new Error('background space cookie missing');
    await call('browser_navigate', { url: `${base}/whoami`, space: 'default' });
    const alice = await call('browser_read', { maxChars: 500, space: 'default' });
    if (!alice.text.includes('bench_user=alice')) throw new Error(`active space changed: ${alice.text.slice(0, 80)}`);
    const list = await call('browser_tabs', { action: 'list' });
    const active = list.tabs.find(tab => tab.active);
    if (active?.spaceId !== 'default') throw new Error(`active space is ${active?.spaceId}`);
    return { background: background.tabId, active: active.tabId };
  });

  await task('confirm-dismiss', async () => {
    await call('browser_navigate', { url: `${base}/confirm` });
    const act = await call('browser_act', { action: 'click', target: 'css=#ask', snapshot: false });
    if (act.dialog?.handled !== 'dismissed') throw new Error('confirm not dismissed');
    const read = await call('browser_read', { maxChars: 500 });
    if (!read.text.includes('no')) throw new Error('confirm dismiss result missing');
    return { dialog: act.dialog };
  });

  await task('confirm-accept', async () => {
    await call('browser_navigate', { url: `${base}/confirm` });
    await call('browser_dialog', { action: 'arm', policy: 'accept' });
    const act = await call('browser_act', { action: 'click', target: 'css=#ask', snapshot: false });
    if (act.dialog?.handled !== 'accepted') throw new Error('confirm not accepted');
    const read = await call('browser_read', { maxChars: 500 });
    if (!read.text.includes('yes')) throw new Error('confirm accept result missing');
    return { dialog: act.dialog };
  });

  await task('smart-wait', async () => {
    await call('browser_navigate', { url: `${base}/slow` });
    const wait = await call('browser_wait', { for: 'text', text: 'ready', timeout: 3000 });
    return { ms: wait.ms };
  });

  await task('snapshot-diff', async () => {
    await call('browser_navigate', { url: `${base}/counter` });
    await call('browser_snapshot', { mode: 'full' });
    await call('browser_act', { action: 'click', target: 'css=#inc', snapshot: false });
    const diff = await call('browser_snapshot', { mode: 'auto' });
    if (diff.mode !== 'diff' || !diff.text.includes('Count: 1')) throw new Error(`unexpected diff ${diff.mode}`);
    return { mode: diff.mode, chars: diff.text.length };
  });

  await task('tabs', async () => {
    await call('browser_navigate', { url: `${base}/one` });
    const second = await call('browser_tabs', { action: 'new', url: `${base}/two` });
    const list = await call('browser_tabs', { action: 'list' });
    if (list.tabs.length < 2) throw new Error('second tab missing');
    const first = list.tabs.find(tab => tab.tabId !== second.tabId);
    await call('browser_tabs', { action: 'select', tabId: first.tabId });
    await call('browser_tabs', { action: 'close', tabId: second.tabId });
    return { tabs: list.tabs.length, second: second.tabId };
  });

  await task('skill-replay', async () => {
    await call('browser_navigate', { url: `${base}/form` });
    const batch = await call('browser_batch', {
      steps: [
        { op: 'fill', target: 'css=#name', value: 'Skill' },
        { op: 'click', target: 'css=#save' },
      ],
    });
    const id = batch.learned?.id;
    if (!id) throw new Error('no learned skill');
    const replay = await call('browser_batch', { recipe: id });
    if (!replay.ok) throw new Error('replay failed');
    return { id, steps: replay.steps.length };
  });

  await task('site-card', async () => {
    await call('browser_navigate', { url: `${base}/list` });
    await call('browser_snapshot', { mode: 'full' });
    const again = await call('browser_navigate', { url: `${base}/list` });
    if (!again.site?.landmarks) throw new Error('site card missing');
    return { landmarks: again.site.landmarks };
  });

  await task('screenshot', async () => {
    await call('browser_navigate', { url: `${base}/one` });
    const shot = await call('browser_screenshot', {});
    if (!shot.bytes || shot.bytes < 1000) throw new Error('empty screenshot');
    return { bytes: shot.bytes, width: shot.width };
  });

  await task('handoff', async () => {
    const pending = call('browser_handoff', { reason: 'login', note: 'benchmark' });
    for (let i = 0; i < 50 && !takeoverEvent; i += 1) await delay(100);
    if (!takeoverEvent) throw new Error('no takeover event');
    controller.respondHandoff(takeoverEvent.id, 'resume');
    const result = await pending;
    if (!result.resumed) throw new Error('not resumed');
    return { id: takeoverEvent.id };
  });

  const ok = results.filter(item => item.ok).length;
  const report = {
    generatedAt: new Date().toISOString(),
    environment: { electron: process.versions.electron, chrome: process.versions.chrome },
    summary: {
      tasks: results.length,
      passed: ok,
      successRate: Math.round((ok / results.length) * 100),
      calls,
      chars,
      approxTokens: Math.round(chars / 4),
      p50TaskMs: (() => {
        const values = results.map(item => item.ms).sort((a, b) => a - b);
        return values.length ? values[Math.floor(values.length / 2)] : null;
      })(),
      actCalls: timings.filter(item => item.name === 'browser_act').length,
      clickCalls,
      clickFailures,
      p50ActMs: (() => {
        const values = timings.filter(item => item.name === 'browser_act').map(item => item.ms).sort((a, b) => a - b);
        return values.length ? values[Math.floor(values.length / 2)] : null;
      })(),
    },
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.ms}ms ${item.calls} calls ${item.chars} chars${item.error ? ` — ${item.error}` : ''}`);

  await controller.close();
  win.destroy();
  server.close();
  secondary.server.close();
}

const hard = setTimeout(() => { console.error('BENCHMARK TIMEOUT'); app.exit(3); }, 120000);
hard.unref?.();
app.whenReady().then(async () => {
  try { await main(); app.exit(0); }
  catch (error) { console.error('BENCHMARK ERROR', error?.stack || error); app.exit(1); }
});
