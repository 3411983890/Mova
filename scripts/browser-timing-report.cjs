#!/usr/bin/env node
'use strict';
// 读计时日志，打印「模型 / 工具 / 人工等待」的拆分，用来验证 P0 的计时口径。
//
// 用法：
//   node scripts/browser-timing-report.cjs            # 最近 20 轮
//   node scripts/browser-timing-report.cjs --limit 50
//   node scripts/browser-timing-report.cjs --dir "C:\path\to\userData\browser\timing"
//
// 日志由 electron/browser/timing-log.cjs 写入（每轮一行 JSON）。

const { homedir } = require('node:os');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { createTimingLog } = require('../electron/browser/timing-log.cjs');

function defaultDirectory() {
  const product = 'Mova';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, product, 'browser', 'timing');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', product, 'browser', 'timing');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), product, 'browser', 'timing');
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const seconds = ms => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
const share = (part, total) => (total > 0 ? `${Math.round((part / total) * 100)}%` : '—');

async function main() {
  const directory = arg('dir', defaultDirectory());
  const limit = Number(arg('limit', '20')) || 20;
  if (!existsSync(directory)) {
    console.log(`没有找到计时日志目录：${directory}`);
    console.log('先跑一轮带浏览器操作的对话，或用 --dir 指定 userData 下的 browser/timing。');
    return;
  }
  const log = createTimingLog({ directory, logger: { warn() {} } });
  const rows = await log.recent(limit);
  if (!rows.length) {
    console.log(`目录里还没有计时记录：${directory}`);
    return;
  }
  const header = ['时间', '来源', '墙钟', '模型', '工具净', '人工', '扩展', '调用', '未知'];
  const table = rows.map(row => [
    String(row.at || '').replace('T', ' ').slice(5, 19),
    row.edge ? 'edge' : (row.label || 'app'),
    seconds(row.wallMs),
    `${seconds(row.modelMs)} (${share(row.modelMs, row.wallMs)})`,
    `${seconds(row.toolActiveMs)} (${share(row.toolActiveMs, row.wallMs)})`,
    `${seconds(row.humanMs)} (${share(row.humanMs, row.wallMs)})`,
    `${seconds(row.edgeMs)}`,
    `${row.toolCalls || 0}/${row.modelCalls || 0}`,
    String(row.unknown || 0),
  ]);
  const widths = header.map((_, column) => Math.max(header[column].length, ...table.map(row => row[column].length)));
  const line = row => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ');
  console.log(line(header));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of table) console.log(line(row));

  const total = rows.reduce((sum, row) => ({
    wall: sum.wall + (row.wallMs || 0), model: sum.model + (row.modelMs || 0),
    tool: sum.tool + (row.toolActiveMs || 0), human: sum.human + (row.humanMs || 0),
  }), { wall: 0, model: 0, tool: 0, human: 0 });
  console.log('');
  console.log(`合计 ${rows.length} 轮：墙钟 ${seconds(total.wall)}，模型 ${seconds(total.model)}（${share(total.model, total.wall)}），`
    + `工具净 ${seconds(total.tool)}（${share(total.tool, total.wall)}），人工等待 ${seconds(total.human)}（${share(total.human, total.wall)}）`);
  const slowest = rows.flatMap(row => (row.slowest || []).map(item => ({ ...item, at: row.at })))
    .sort((a, b) => b.ms - a.ms).slice(0, 8);
  if (slowest.length) {
    console.log('最慢的 span：');
    for (const item of slowest) console.log(`  ${seconds(item.ms).padStart(7)}  ${item.category}/${item.name}${item.outcome ? ` (${item.outcome})` : ''}`);
  }
}

main().catch(error => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
