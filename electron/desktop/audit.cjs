'use strict';
// 桌面操作审计。一行一条 JSON，只写“发生了什么”的元数据：
// 应用、窗口哈希、动作、目标哈希、层级、结果、错误码、耗时、审批 id。
// 绝不写：输入值、剪贴板内容、截图路径。理由见 §10.8 / §11.2。
//
// 5MB 轮转，保留 2 份：desktop-audit.jsonl / .1 / .2。写失败不影响执行，
// 但会通过返回值告诉调用方（工具层只记一次 console.warn）。

const { createHash } = require('node:crypto');
const { mkdir, rename, stat, unlink, appendFile } = require('node:fs/promises');
const { join } = require('node:path');

const FILE_NAME = 'desktop-audit.jsonl';
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 2;

/** 短哈希：目标是“可对账”，不是“可还原”。 */
function hashOf(value, length = 16) {
  const text = String(value ?? '');
  if (!text) return '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, length);
}

function clean(value, limit = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeEntry(entry = {}) {
  const ts = typeof entry.ts === 'string' && entry.ts ? entry.ts : new Date().toISOString();
  const ok = entry.ok !== false;
  const ms = Number(entry.ms);
  return {
    ts,
    app: clean(entry.app || entry.appKey || '', 80),
    // 窗口标题可能含业务信息（“张三的报销单”）→ 只留哈希。
    windowHash: clean(entry.windowHash || hashOf(entry.window || entry.windowTitle || entry.title), 32),
    action: clean(entry.action || entry.op || '', 40),
    targetHash: clean(entry.targetHash || hashOf(entry.target || entry.targetText), 32),
    tier: clean(entry.tier || entry.level || '', 8),
    ok,
    code: ok ? '' : clean(entry.code || 'failed', 60),
    ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0,
    approvalId: clean(entry.approvalId || '', 64),
  };
}

/**
 * @param {{directory?:string, file?:string, maxBytes?:number, keep?:number, now?:()=>number}} options
 */
function createAudit({ directory, file, maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  const base = directory || '';
  const target = file || (base ? join(base, FILE_NAME) : '');
  let queue = Promise.resolve();
  let pending = 0;
  let warned = false;
  let size = 0;
  let sized = false;

  async function rotate() {
    if (!target) return;
    try {
      const info = await stat(target);
      if (info.size <= maxBytes) return;
      // 保留 keep 份：删掉最老的，再逐个后移，最后把当前文件移到 .1。
      for (let index = keep; index >= 1; index -= 1) {
        const older = `${target}.${index}`;
        if (index === keep) await unlink(older).catch(() => {});
        else await rename(older, `${target}.${index + 1}`).catch(() => {});
      }
      await rename(target, `${target}.1`).catch(() => {});
      size = 0;
    } catch {
      // 文件不存在或正被占用：下次追加时再试，绝不让轮转挡住执行。
    }
  }

  async function append(entry) {
    if (!target) return false;
    await mkdir(base || '.', { recursive: true });
    if (!sized) { sized = true; size = (await stat(target).catch(() => null))?.size ?? 0; }
    if (size > maxBytes) await rotate();
    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(target, line, { encoding: 'utf8', mode: 0o600 });
    size += Buffer.byteLength(line, 'utf8');
    return true;
  }

  /**
   * 追加一条审计。永远不抛：审计失败不该让用户的桌面操作半路失败。
   * @returns {Promise<boolean>} 是否写入成功
   */
  function write(entry) {
    const normalized = normalizeEntry(entry);
    pending += 1;
    const work = queue.then(() => append(normalized)).catch(error => {
      if (!warned) {
        warned = true;
        console.warn('desktop audit unavailable', error?.message || error);
      }
      return false;
    }).finally(() => { pending -= 1; });
    queue = work;
    return work;
  }

  /** 等所有排队写入落盘（退出前调用一次）。 */
  async function flush() {
    await queue;
    return true;
  }

  return {
    write,
    flush,
    file: target,
    hashOf,
    pending: () => pending,
  };
}

module.exports = { createAudit, hashOf, normalizeEntry, FILE_NAME, MAX_BYTES, KEEP };
