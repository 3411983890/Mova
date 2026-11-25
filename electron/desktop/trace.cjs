'use strict';
// L0 轨迹：本次会话的动作元数据，环形缓冲（每会话 50 条 / 7 天）。
//
// 只记「够编译器复现流程」的东西：op、stableKey、role、name、rect、ts、ok。
// 不记输入值 —— 只留 valueHash + 长度；也不记截图、剪贴板、文件内容（§10.8）。
// name 是控件名（“确定”“保存”），但 OCR/表格里也可能带业务词，所以统一过一遍
// 轻量脱敏（邮箱、手机号、长数字），与 memory-redaction 的取向一致。

const { createHash } = require('node:crypto');
const { mkdir, appendFile, readFile, writeFile, rename } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_ENTRIES = 50;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashOf(value, length = 12) {
  const text = String(value ?? '');
  if (!text) return '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, length);
}

/** 控件的 name 可能夹带业务信息：只做便宜的脱敏，不做语义改写。 */
function redactName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/\b1[3-9]\d{9}\b/g, '<phone>')
    .replace(/\b\d{7,}\b/g, '<num>')
    .slice(0, 80);
}

/** 稳定键：优先 automationId，其次 name+role，最后弱路径。 */
function stableKeyOf(node = {}) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.stableKey === 'string' && node.stableKey) return node.stableKey.slice(0, 120);
  const aid = node.automationId || node.aid;
  if (aid) return `aid:${String(aid).slice(0, 100)}`;
  const name = redactName(node.name || node.label || '');
  const role = String(node.role || node.controlType || '').trim();
  if (name && role) return `nm:${role.toLowerCase()}:${name.toLowerCase()}`.slice(0, 120);
  if (name) return `nm:${name.toLowerCase()}`.slice(0, 120);
  if (Array.isArray(node.path) && node.path.length) return `path:${node.path.join('/')}`.slice(0, 120);
  return '';
}

function normalizeRect(rect) {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const numbers = rect.slice(0, 4).map(value => Math.round(Number(value) || 0));
  return numbers.every(Number.isFinite) ? numbers : null;
}

/**
 * @param {{directory?:string, conversationId?:string, maxEntries?:number,
 *          ttlMs?:number, now?:()=>number}} options
 */
function createTrace({ directory, conversationId = 'default', maxEntries = MAX_ENTRIES, ttlMs = TTL_MS, now = Date.now } = {}) {
  const key = String(conversationId || 'default').replace(/[^\w.-]/g, '_').slice(0, 80) || 'default';
  const file = directory ? join(directory, 'traces', `${key}.jsonl`) : '';
  let buffer = null;
  let loading = null;
  let queue = Promise.resolve();

  function normalize(entry = {}) {
    const value = typeof entry.value === 'string' ? entry.value : '';
    const row = {
      op: String(entry.op || entry.action || '').slice(0, 24),
      stableKey: stableKeyOf(entry),
      role: String(entry.role || '').slice(0, 40),
      name: redactName(entry.name),
      rect: normalizeRect(entry.rect),
      ts: Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : now(),
      ok: entry.ok !== false,
    };
    if (value) {
      row.valueHash = hashOf(value);
      row.valueLength = value.length;
    }
    if (entry.code) row.code = String(entry.code).slice(0, 40);
    if (entry.tier) row.tier = String(entry.tier).slice(0, 8);
    return row;
  }

  async function readAll() {
    if (!file) return [];
    try {
      const text = await readFile(file, 'utf8');
      const rows = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { rows.push(JSON.parse(trimmed)); } catch { /* 半截行：跳过 */ }
      }
      return rows;
    } catch {
      return [];
    }
  }

  async function load() {
    if (buffer) return buffer;
    if (!loading) {
      loading = readAll().then(rows => {
        const cutoff = now() - ttlMs;
        buffer = rows
          .filter(row => Number(row?.ts) > cutoff)
          .slice(-Math.max(1, maxEntries));
        return buffer;
      });
    }
    return loading;
  }

  /**
   * 记一步。value 只留 hash + 长度；异步落盘，失败不抛。
   */
  async function push(entry) {
    const row = normalize(entry);
    const rows = await load();
    rows.push(row);
    if (rows.length > maxEntries) rows.splice(0, rows.length - maxEntries);
    if (file) {
      const line = `${JSON.stringify(row)}\n`;
      const work = queue.then(async () => {
        await mkdir(join(directory, 'traces'), { recursive: true });
        await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
      }).catch(() => {});
      queue = work;
      await work;
    }
    return row;
  }

  async function recent(limit = maxEntries) {
    const rows = await load();
    const size = Math.max(0, Math.min(rows.length, Number(limit) || maxEntries));
    return rows.slice(rows.length - size).map(row => ({ ...row }));
  }

  /** 编译完成后清空“已消费”的轨迹；目录里只留一个空文件。 */
  async function clear() {
    buffer = [];
    if (!file) return true;
    const work = queue.then(async () => {
      await mkdir(join(directory, 'traces'), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, '', { mode: 0o600 });
      await rename(temp, file);
    }).catch(() => {});
    queue = work;
    return work.then(() => true, () => false);
  }

  return { push, recent, clear, file, key, redactName };
}

module.exports = { createTrace, stableKeyOf, redactName, hashOf, MAX_ENTRIES, TTL_MS };
