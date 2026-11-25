// 在 Electron 主进程里试几个「能列出 ChatGPT 模型」的候选端点。
// 为什么必须在 Electron 里跑：本机普通 node 的 fetch 走不到这些域名（fetch failed），
// 而应用内的 fetch 能正常读额度接口 —— 代理/DNS 的差别就在这里。
//
// 用法：node_modules\.bin\electron.cmd scripts\.probe-chatgpt-models.cjs
const { app } = require('electron');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const raw = JSON.parse(await readFile(join(process.env.USERPROFILE, '.codex', 'auth.json'), 'utf8'));
  const access = raw.tokens.access_token;
  const accountId = raw.tokens.account_id;
  const targets = [
    ['https://api.openai.com/v1/models', {}],
    ['https://chatgpt.com/backend-api/codex/models', { 'chatgpt-account-id': accountId }],
    ['https://chatgpt.com/backend-api/models', { 'chatgpt-account-id': accountId }],
    ['https://chatgpt.com/backend-api/wham/usage', { 'chatgpt-account-id': accountId, 'openai-beta': 'codex-1', originator: 'Mova' }],
  ];
  for (const [url, extra] of targets) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${access}`, accept: 'application/json', ...extra },
        signal: AbortSignal.timeout(15_000),
      });
      let head = '';
      try { head = (await response.text()).slice(0, 220).replace(/\s+/g, ' '); } catch { head = '(no body)'; }
      console.log(`${response.status}\t${url}\t${head}`);
    } catch (error) {
      console.log(`ERR\t${url}\t${String(error?.message ?? error).slice(0, 100)}`);
    }
  }
  app.quit();
});
