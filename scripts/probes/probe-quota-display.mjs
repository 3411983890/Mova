/**
 * 用真实的 agy CLI 拉一次 Gemini 额度，再把结果喂给设置页那套视图函数（cli-models-view.js），
 * 证明界面上会显示「剩余 N%」而且条宽/颜色跟剩余额度一致——不是「额度未知」。
 *
 * 只读：不写账号、不改配置。跑完把 raw 输出抹掉（面板里含真实邮箱）。
 *
 * 用法：node scripts/probes/probe-quota-display.mjs [--proxy=http://127.0.0.1:17902]
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { probeGeminiUsageViaPrint } from '../../electron/subscription/gemini-usage-cli.mjs';
import { quotaRemaining, quotaValueText, quotaWidth, quotaTone, formatResetIn } from '../../src/features/cli-models/cli-models-view.js';

const require = createRequire(import.meta.url);
const command = process.env.AGY_COMMAND
  || join(homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
const cwd = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Mova', 'gemini-usage-probe');
mkdirSync(cwd, { recursive: true });

// --proxy=… 模拟「按模型线路」注入的环境变量：验证走代理也能读到额度（国内直连常常读不到）。
const proxyArg = process.argv.find(arg => arg.startsWith('--proxy='));
const proxy = proxyArg ? proxyArg.slice(8).trim() : '';
const env = proxy ? {
  HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
  http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
  NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
} : undefined;

const now = () => Date.now();
const started = Date.now();
const probed = await probeGeminiUsageViaPrint({ command, cwd, now, ...(env ? { env } : {}) });
const ms = Date.now() - started;

console.log(`# agy=${command}`);
console.log(`# cwd=${cwd}`);
console.log(`# 代理=${proxy || '（直连）'}`);
console.log(`# 耗时 ${ms}ms  status=${probed.status ?? '-'}  reason=${probed.reason ?? '-'}  detail=${probed.detail ?? '-'}`);
console.log(`# 窗口数 ${probed.windows?.length ?? 0}`);

if (!probed.windows?.length) {
  console.log('FAIL  没读到额度窗口');
  process.exit(1);
}

let failed = 0;
for (const window of probed.windows) {
  const used = window.usedPercent;
  const remaining = quotaRemaining(used);
  const width = quotaWidth(used);
  const tone = quotaTone(used);
  const text = quotaValueText(used);
  const reset = window.resetsAt ? formatResetIn(window.resetsAt) : '—';
  const ok = typeof remaining === 'number' && remaining === 100 - used && /剩余 \d+%/.test(text);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(window.label ?? window.key ?? '?').padEnd(28)} used=${String(used).padStart(3)}  “${text}”  条宽=${width}  tone=${tone}  重置=${reset}`);
}
console.log(`\n# 结果：${probed.windows.length - failed}/${probed.windows.length} 个窗口的展示文案正确`);
process.exit(failed ? 1 : 0);
