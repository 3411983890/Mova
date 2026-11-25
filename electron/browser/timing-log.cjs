'use strict';
// 计时日志：每轮一行 JSONL，落在 userData/browser/timing/。
//
// 为什么落盘而不是只发事件：端到端计时是「验证重点」的直接证据，需要能跨轮对比，
// 也要能在不改 UI 的前提下被脚本读出来（scripts/browser-timing-report.cjs）。
// 写入是串行 + 按天分文件 + 单文件上限，避免长会话把磁盘写满。

const { appendFile, mkdir, readdir, readFile, stat, unlink } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_FILES = 7;

function dayStamp(date) {
  return date.toISOString().slice(0, 10);
}

function createTimingLog(options = {}) {
  const directory = typeof options.directory === 'string' ? options.directory : '';
  if (!directory) throw new Error('directory is required');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger ?? console;
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : MAX_FILE_BYTES;
  const keepFiles = Number.isInteger(options.keepFiles) ? options.keepFiles : KEEP_FILES;
  let queue = Promise.resolve();
  let warned = false;

  const fileFor = time => join(directory, `timing-${dayStamp(new Date(time ?? now()))}.jsonl`);

  async function prune() {
    try {
      const names = (await readdir(directory)).filter(name => /^timing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
      for (const name of names.slice(0, Math.max(0, names.length - keepFiles))) {
        await unlink(join(directory, name)).catch(() => {});
      }
    } catch { /* 目录还不存在：没有可清理的 */ }
  }

  /** 追加一条 summary；返回一个 promise 便于测试等待。 */
  function write(summary) {
    if (!summary || typeof summary !== 'object') return queue;
    const record = { v: 1, at: new Date(now()).toISOString(), ...summary };
    let line;
    try { line = `${JSON.stringify(record)}\n`; } catch { return queue; }
    queue = queue.then(async () => {
      await mkdir(directory, { recursive: true });
      const file = fileFor(now());
      const info = await stat(file).catch(() => null);
      if (info && info.size >= maxBytes) await unlink(file).catch(() => {});
      await appendFile(file, line, 'utf8');
      await prune();
    }).catch(error => {
      if (warned) return;
      warned = true;
      try { logger?.warn?.(`[timing] 无法写入计时日志：${error?.message || error}`); } catch { /* 无 stdout */ }
    });
    return queue;
  }

  /** 读最近几条，供脚本/诊断使用。 */
  async function recent(limit = 20) {
    const count = Math.max(1, Math.min(200, Number(limit) || 20));
    const rows = [];
    let names;
    try { names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort(); } catch { return []; }
    for (const name of (names || []).slice(-3)) {
      let text;
      try { text = await readFile(join(directory, name), 'utf8'); } catch { continue; }
      for (const line of String(text).split('\n')) {
        // 外部工具（PowerShell、编辑器）写出来的文件可能带 BOM，跳过它而不是整行丢弃。
        const body = line.charCodeAt(0) === 0xFEFF ? line.slice(1) : line;
        if (!body.trim()) continue;
        try { rows.push(JSON.parse(body)); } catch { /* 半行/损坏行直接跳过 */ }
      }
    }
    return rows.slice(-count);
  }

  return { write, recent, fileFor, directory, flush: () => queue };
}

module.exports = { createTimingLog, MAX_FILE_BYTES, KEEP_FILES };
