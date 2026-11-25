// 一次性探测：证明 installLogging 真的会落盘、脱敏、并对 IPC 计时。
// 用法：node scripts/.probe-logging.mjs [目录]
import { mkdtemp } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLogging } from '../../electron/logging/index.mjs';

const dir = process.argv[2] ?? await mkdtemp(join(tmpdir(), 'mova-log-probe-'));

// 假 ipcMain：只需要 handle/removeHandler 两种方法就能验证 patchIpcMain。
const handlers = new Map();
const ipcMain = {
  handle(channel, fn) { handlers.set(channel, fn); },
  removeHandler(channel) { handlers.delete(channel); },
};

const installed = installLogging({
  app: { getPath: () => dir, getVersion: () => '0.0.0-probe' },
  ipcMain,
  dir,
});

// 先装日志、后注册 handler，才能验证「补丁生效」这一段时序（与 main.cjs 一致）。
ipcMain.handle('probe:fast', async () => 'ok');
ipcMain.handle('probe:slow', async () => {
  const until = Date.now() + 1200;
  while (Date.now() < until) { /* 故意占用 1.2s，触发 slow-ipc 告警 */ }
  return 'slow-ok';
});
ipcMain.handle('probe:throw', async () => { throw Object.assign(new Error('boom'), { code: 'probe_fail' }); });

const fast = await handlers.get('probe:fast')({}, 'x');
const slow = await handlers.get('probe:slow')({});
let thrown = '';
try { await handlers.get('probe:throw')({}); } catch (error) { thrown = error.code; }

// 脱敏：令牌不能出现在日志里。
installed.logger.info('probe-secrets', {
  authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
  url: 'http://127.0.0.1:1/auth/callback?code=abc123&state=xyz',
  email: 'someone@example.com',
  durationMs: 1234,
});

await installed.flush(2000);
installed.stopWatchdog();
installed.restoreIpc();

const body = await readFile(join(dir, installed.latestFileName()), 'utf8');
const lines = body.trim().split('\n').map(line => JSON.parse(line));
const secrets = lines.find(line => line.msg === 'probe-secrets');
const slowIpc = lines.filter(line => line.msg === 'slow-ipc');
const failed = lines.filter(line => line.level === 'error' && line.channel === 'probe:throw');

console.log(JSON.stringify({
  dir,
  file: installed.latestFileName(),
  records: lines.length,
  levels: [...new Set(lines.map(line => line.level))],
  fast, slow, thrown,
  slowIpcChannels: slowIpc.map(line => line.channel),
  failedChannel: failed.map(line => ({ channel: line.channel, code: line.code })),
  secrets,
}, null, 2));
