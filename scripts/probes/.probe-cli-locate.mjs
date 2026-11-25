// 一次性探测：本机 CLI 定位到底花了多久、找到了什么、为什么 compatible 是 false。
// 用法：node scripts/.probe-cli-locate.mjs
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { locateCli } from '../../electron/subscription/cli.mjs';

const started = Date.now();
const result = await locateCli({
  settings: { cliPath: '' },
  platform: process.platform,
  env: process.env,
  home: homedir(),
  access: async candidate => { try { await access(candidate); return true; } catch { return false; } },
  exec: (command, args, options = {}) => new Promise(resolve => {
    execFile(command, args, { timeout: options.timeoutMs ?? 5000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0 });
    });
  }),
  // 刻意不传 timeoutMs：要测的是产品默认值，不是脚本自己挑的值。
});

console.log(JSON.stringify({ ms: Date.now() - started, ...result }, null, 2));
