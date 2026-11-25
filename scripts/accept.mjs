#!/usr/bin/env node
/**
 * 完结版验收脚本：一条命令跑完所有闸门并给出 PASS/FAIL 表。
 *
 * 为什么要有它：这个仓库不是 git 仓库，改动是否安全只能靠「与基线比对」。
 * 所以把基线固化在这里：失败项必须**恰好**是下面这 3 项，多一项即 FAIL。
 *
 * 用法：
 *   node scripts/accept.mjs            # 全量（测试 + 构建 + 类型检查）
 *   node scripts/accept.mjs --fast     # 跳构建
 *   node scripts/accept.mjs --tests    # 只跑测试
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 基线：这 3 项在本轮改造之前就是失败的，不属于回归。 */
const BASELINE_FAILURES = [
  'scripts\\popup-test.cjs',
  'tool events with detail render the expandable command and change rows',
  'transcript paginates recent turns, keeps stable IDs, renders Markdown and gates retry',
];

const args = new Set(process.argv.slice(2));
const fast = args.has('--fast');
const testsOnly = args.has('--tests');

function run(command, argv, { shell = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, argv, {
      cwd: root,
      shell,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', error => resolve({ code: -1, stdout, stderr: String(error) }));
  });
}

function parseSummary(output) {
  const pick = name => {
    const match = new RegExp(`^\\s*ℹ ${name} (\\d+)`, 'm').exec(output);
    return match ? Number(match[1]) : null;
  };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), skipped: pick('skipped') };
}

function failingNames(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = /^✖ (.+?) \([\d.]+ms\)/.exec(line.trim());
    if (match) names.add(match[1].trim());
  }
  return [...names];
}

const results = [];

// ── 闸门 1：全量测试 ────────────────────────────────────────────────
process.stdout.write('▸ node --test … ');
const test = await run('node', ['--test']);
const summary = parseSummary(test.stdout + test.stderr);
const failures = failingNames(test.stdout + test.stderr);
const unexpected = failures.filter(name => !BASELINE_FAILURES.includes(name));
const repaired = BASELINE_FAILURES.filter(name => !failures.includes(name));
process.stdout.write('done\n');

results.push({
  gate: '测试',
  ok: unexpected.length === 0,
  detail: unexpected.length
    ? `新增失败 ${unexpected.length} 项：${unexpected.join(' / ')}`
    : `${summary.tests ?? '?'} 例 / 通过 ${summary.pass ?? '?'} / 失败 ${summary.fail ?? '?'}（全是基线）`
      + (repaired.length ? `；基线中已修复 ${repaired.length} 项` : ''),
});

// ── 闸门 2：构建 ───────────────────────────────────────────────────
if (!testsOnly && !fast) {
  process.stdout.write('▸ npm run build … ');
  const build = await run('npm', ['run', 'build'], { shell: true });
  const matched = /built in ([\d.]+)s/.exec(build.stdout + build.stderr);
  process.stdout.write('done\n');
  results.push({
    gate: '构建',
    ok: build.code === 0,
    detail: build.code === 0 ? `通过${matched ? `（${matched[1]}s）` : ''}` : `失败，退出码 ${build.code}`,
  });
}

// ── 闸门 3：类型检查 ───────────────────────────────────────────────
if (!testsOnly && !fast) {
  process.stdout.write('▸ npm run typecheck … ');
  const typecheck = await run('npm', ['run', 'typecheck'], { shell: true });
  process.stdout.write('done\n');
  const firstError = /error TS\d+[^\n]*/.exec(typecheck.stdout + typecheck.stderr);
  results.push({
    gate: '类型检查',
    ok: typecheck.code === 0,
    detail: typecheck.code === 0 ? '通过' : (firstError?.[0] ?? `失败，退出码 ${typecheck.code}`),
  });
}

// ── 报告 ──────────────────────────────────────────────────────────
console.log('');
console.log('┌─ 验收结果 ─────────────────────────────────────────────');
for (const item of results) {
  console.log(`│ ${item.ok ? '✅' : '❌'} ${item.gate.padEnd(6, '　')} ${item.detail}`);
}
console.log('└────────────────────────────────────────────────────────');
if (repaired.length) {
  console.log(`\n注意：以下基线失败本轮被修复，请更新 scripts/accept.mjs 的 BASELINE_FAILURES：\n  - ${repaired.join('\n  - ')}`);
}
const failed = results.filter(item => !item.ok);
if (failed.length) {
  console.log(`\n结论：${failed.length} 项闸门未通过。`);
  process.exit(1);
}
console.log('\n结论：全部闸门通过。');
