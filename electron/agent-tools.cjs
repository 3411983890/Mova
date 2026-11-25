'use strict';
const { execFile, spawn } = require('node:child_process');
const { createReadStream } = require('node:fs');
const { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { dirname, join } = require('node:path');
const { IGNORED_WRITE_SEGMENTS, PermissionError, isInside, resolveInside } = require('./permissions.cjs');

const execFileAsync = promisify(execFile);

// Project file tools. Every call is scoped to a registered project root and
// re-checked against the live permission store, so revoking a capability in the
// settings page stops the very next call, not just the next conversation.
const LIMITS = Object.freeze({
  entries: 400,
  depth: 3,
  readChars: 40_000,
  /** Whole-file reads stay cheap; above this the tool streams only the asked lines. */
  readWholeBytes: 4_000_000,
  /** Even streamed reads refuse absurd sizes instead of tying up the main process. */
  readCeilingBytes: 512 * 1024 * 1024,
  writeChars: 512_000,
  /** Writes and delete snapshots still need the whole content in memory. */
  fileBytes: 4_000_000,
  binaryProbeBytes: 8192,
  binaryExcerptBytes: 4096,
  stringsBytes: 262_144,
  stringsMax: 40,
  /**
   * Command output is the one result that can be arbitrarily large, and every
   * character of it costs model context. The budget must stay well under the
   * 40k-character tool-result cap in chat-agent.mjs, otherwise the JSON reply
   * (where `truncated` lives) is what gets cut — the model then cannot even see
   * that anything was dropped. Head and tail are kept, the middle is elided.
   */
  commandOutput: 8_000,
  commandOutputHead: 2_000,
  /** Byte windows: a 100 MB build log must not sit in memory while it runs. */
  commandHeadBytes: 65_536,
  commandTailBytes: 65_536,
  commandDefaultMs: 60_000,
  commandMaxMs: 120_000,
  /**
   * The approval bar has to stay readable, and cmd.exe itself stops at 8191.
   * A shell line is capped here; argv is not a shell line, so it gets more room
   * (still far below the 32767-character CreateProcess limit).
   */
  commandChars: 2_000,
  commandArgs: 64,
  commandArgChars: 8_000,
  commandArgvChars: 16_000,
  searchFiles: 5_000,
  searchMatches: 120,
  searchFileBytes: 8_000_000,
  gitOutput: 40_000,
  // The approval dialog now renders a real line diff, so the preview has to
  // carry enough of the file to be worth diffing while staying bounded.
  previewLines: 300,
  previewChars: 100_000,
  historyEntries: 60,
  historyBytes: 4_000_000,
  /** One recursive delete must stay snapshot-able: 4 MB of content is the cap. */
  deleteBytes: 2_000_000,
});

const SKIPPED_DIRS = Object.freeze(['.git', 'node_modules', '.mova-backups']);

const MESSAGES = Object.freeze({
  'invalid-path': '路径无效',
  'absolute-path': '只能使用项目内的相对路径',
  'path-escape': '路径超出项目文件夹范围',
  'root-missing': '项目文件夹不存在或已被移动',
  'not-found': '文件或文件夹不存在',
  'not-a-file': '目标不是文件',
  'not-a-repository': '这个文件夹不是 Git 仓库',
  'git-missing': '没有找到 git 命令',
  'git-failed': 'git 执行失败',
  'file-too-large': '文件超过大小上限',
  binary: '二进制文件不能这样编辑（没有可撤销的文本快照）',
  'not-granted': '当前项目未授予该权限',
  denied: '你拒绝了这次操作',
  'root-required': '请用「项目名/相对路径」指定目标文件夹',
  'ambiguous-path': '多个项目文件夹里存在同名路径，请加上项目名前缀',
  'not-found-in-file': '文件里找不到要替换的原文',
  'ambiguous-match': '原文在文件中出现多次，请提供更长的唯一片段或允许全部替换',
  conflict: '文件在那次修改之后又被改动过，已放弃撤销',
  'invalid-arguments': '参数无效',
  'directory-not-empty': '文件夹里还有内容，需要确认递归删除才能删掉',
  'too-many-files': '一次要处理的文件太多或总体积太大，请分批处理',
  'already-exists': '目标位置已经有同名的文件或文件夹',
  'cross-root-move': '只能在同一个项目文件夹内移动，不能跨文件夹或跨磁盘',
  'batch-cross-root': '一次批量修改只能针对同一个项目文件夹',
  'same-path': '源路径和目标路径相同',
  aborted: '运行已取消',
  'protected-path': '不能修改版本库内部文件（.git）',
  timeout: '命令执行超时',
  'command-too-long': '命令太长，请拆成多条命令，或写进脚本文件后执行',
  'command-failed': '命令启动失败',
  failed: '操作失败',
});

function codeOf(error) {
  if (error instanceof PermissionError) return error.code;
  if (error?.code === 'ENOENT') return 'not-found';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'access-denied';
  if (error?.code === 'EISDIR') return 'not-a-file';
  return 'failed';
}

function messageOf(error, code) {
  if (error instanceof PermissionError && error.message && error.message !== error.code) return error.message;
  if (code === 'access-denied') return '系统拒绝了这次文件操作（可能被占用或没有权限）';
  return MESSAGES[code] ?? MESSAGES.failed;
}

function toolResult(payload, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * "path: '.'" is how many models say "the project folder". Normalise it (and a
 * leading "./") to the empty relative path the tools already use for the root,
 * instead of bouncing it off resolveInside as an invalid segment.
 */
function normalizeRelativePath(value) {
  let text = String(value).replace(/\\/g, '/').trim();
  while (text === '.' || text.startsWith('./')) text = text === '.' ? '' : text.slice(2);
  return text.trim();
}

/** True when a path argument means the project folder itself, or was left out. */
function isRootPathInput(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  return !value.trim() || normalizeRelativePath(value) === '';
}

function guardWrite(target) {
  const segments = target.rel.replace(/\\/g, '/').split('/').map(segment => segment.toLowerCase());
  if (segments.some(segment => IGNORED_WRITE_SEGMENTS.includes(segment))) {
    throw new PermissionError('protected-path');
  }
}

/** Atomic replace that keeps the destination's mode and never collides on the temp name. */
async function writeAtomic(path, content) {
  const temp = `${path}.${randomUUID()}.mova.tmp`;
  const previous = await stat(path).catch(() => null);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, content, { flag: 'wx' });
    if (previous) await chmod(temp, previous.mode).catch(() => {});
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// Two runs can target the same file at once. Writes to one path are chained so
// the last one wins whole; different paths keep writing in parallel. The stored
// tail never rejects, so one failed write cannot poison the queue.
const pathQueues = new Map();

/** Identifies the exact content a decision was made against; `absent` is its own state. */
function digestOf(content) {
  if (content == null) return 'absent';
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function withPathLock(target, work) {
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.catch(() => {});
  pathQueues.set(key, tail);
  tail.then(() => {
    if (pathQueues.get(key) === tail) pathQueues.delete(key);
  });
  return run;
}

/** The identity two paths share when they are the same file on this platform. */
function lockKey(path) {
  return process.platform === 'win32' ? String(path).toLowerCase() : String(path);
}

/**
 * Takes several path locks at once. The order is always the sorted key order,
 * so two multi-file operations that overlap cannot deadlock each other.
 */
function withPathLocks(paths, work) {
  const keys = [...new Set(paths.map(lockKey))].sort();
  const run = index => (index >= keys.length ? work() : withPathLock(keys[index], () => run(index + 1)));
  return run(0);
}

/** Magic bytes worth naming: enough for the model to know what it is looking at. */
const MAGIC = Object.freeze([
  { mime: 'image/png', test: head => head.length > 8 && head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG' },
  { mime: 'image/jpeg', test: head => head.length > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { mime: 'image/gif', test: head => head.toString('latin1', 0, 4) === 'GIF8' },
  { mime: 'image/webp', test: head => head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP' },
  { mime: 'image/bmp', test: head => head.toString('latin1', 0, 2) === 'BM' },
  { mime: 'application/pdf', test: head => head.toString('latin1', 0, 4) === '%PDF' },
  { mime: 'application/zip', test: head => head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04 },
  { mime: 'application/x-7z-compressed', test: head => head.toString('latin1', 0, 6) === '7z\xBC\xAF\x27\x1C' },
  { mime: 'application/gzip', test: head => head[0] === 0x1f && head[1] === 0x8b },
  { mime: 'application/wasm', test: head => head.toString('latin1', 0, 4) === '\0asm' },
  { mime: 'application/x-elf', test: head => head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF' },
  { mime: 'application/x-mach-binary', test: head => ['\xFE\xED\xFA\xCE', '\xCF\xFA\xED\xFE', '\xCA\xFE\xBA\xBE'].includes(head.toString('latin1', 0, 4)) },
  { mime: 'application/vnd.microsoft.portable-executable', test: head => head.toString('latin1', 0, 2) === 'MZ' },
]);

/** Best-effort type of a binary payload; `null` when nothing matched. */
function sniffMime(head) {
  for (const entry of MAGIC) {
    try { if (entry.test(head)) return entry.mime; } catch { /* Short buffer. */ }
  }
  return null;
}

/** Runs of printable ASCII, the same idea as `strings(1)`. */
function extractStrings(buffer, max) {
  const found = [];
  let current = '';
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= 4) found.push(current);
    if (found.length >= max) return found.slice(0, max);
    current = '';
  }
  if (current.length >= 4) found.push(current);
  return found.slice(0, max);
}

/**
 * A binary file cannot be handed over as text, so describe it instead: type,
 * size, a bounded base64 head, and printable runs. That is enough to recognize
 * an image, a PDF, a compiled binary or a corrupt file without shipping bytes
 * into the model context as mojibake.
 */
async function describeBinary(abs, size) {
  const handle = await open(abs, 'r');
  try {
    const excerptLength = Math.min(size, LIMITS.binaryExcerptBytes);
    const excerpt = Buffer.alloc(excerptLength);
    if (excerptLength) await handle.read(excerpt, 0, excerptLength, 0);
    const scanLength = Math.min(size, LIMITS.stringsBytes);
    const scan = Buffer.alloc(scanLength);
    if (scanLength) await handle.read(scan, 0, scanLength, 0);
    return {
      mime: sniffMime(excerpt.subarray(0, LIMITS.binaryProbeBytes)) ?? 'application/octet-stream',
      bytes: size,
      excerptBase64: excerpt.toString('base64'),
      strings: extractStrings(scan, LIMITS.stringsMax),
      stringsScannedBytes: scanLength,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Reads only the requested lines of a large text file. The whole file never
 * sits in memory, and the stream stops as soon as the range (or the per-result
 * character budget) is satisfied.
 */
async function readLineRange(abs, startLine, endLine, signal) {
  const wanted = [];
  let seen = 0;
  let chars = 0;
  let truncated = false;
  let stoppedEarly = false;
  let rest = '';
  const stream = createReadStream(abs, { encoding: 'utf8', highWaterMark: 1 << 20 });
  try {
    outer: for await (const chunk of stream) {
      if (signal?.aborted) throw new PermissionError('aborted', '运行已取消');
      rest += chunk;
      const parts = rest.split('\n');
      rest = parts.pop() ?? '';
      for (const line of parts) {
        seen += 1;
        if (seen < startLine) continue;
        if (seen > endLine) { stoppedEarly = true; break outer; }
        wanted.push(line);
        chars += line.length + 1;
        if (chars >= LIMITS.readChars) {
          truncated = true;
          stoppedEarly = true;
          break outer;
        }
      }
    }
    if (!stoppedEarly) {
      if (rest.length) {
        seen += 1;
        if (seen >= startLine && seen <= endLine) {
          wanted.push(rest);
          chars += rest.length;
          if (chars >= LIMITS.readChars) truncated = true;
        }
      }
    }
  } finally {
    stream.destroy();
  }
  return { lines: wanted, totalLines: stoppedEarly ? null : seen, truncated, stoppedEarly };
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Already gone. */ }
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
}

/** One side of an approval preview, clipped by lines and by characters. */
function clipSide(value) {
  if (value == null) return { text: null, truncated: false };
  const text = String(value);
  const lines = text.split('\n');
  let clipped = lines.length > LIMITS.previewLines ? lines.slice(0, LIMITS.previewLines).join('\n') : text;
  let truncated = lines.length > LIMITS.previewLines;
  if (clipped.length > LIMITS.previewChars) {
    clipped = clipped.slice(0, LIMITS.previewChars);
    truncated = true;
  }
  return { text: clipped, truncated };
}

function previewOf(kind, path, before, after) {
  const head = clipSide(before);
  const tail = clipSide(after);
  return { kind, path, before: head.text, after: tail.text, truncated: head.truncated || tail.truncated };
}

/**
 * One file inside a batch approval preview. The text is clipped to the same
 * budget as `previewOf`, and `truncated` says whether anything was cut.
 */
function previewFile(shownPath, before, after) {
  const head = clipSide(before);
  const tail = clipSide(after);
  return { path: shownPath, before: head.text, after: tail.text, truncated: head.truncated || tail.truncated };
}

/**
 * One folder of a bounded project tree. A folder that cannot be read becomes an
 * entry in `state.errors` instead of failing the whole snapshot, and symlinks are
 * never followed: a link could otherwise loop or lead outside the project.
 */
async function treeWithin(root, rel, depth, state) {
  const directory = rel ? await resolveInside(root.path, rel) : root.path;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    state.errors.push({ path: rel || '.', code: codeOf(error) });
    return [];
  }
  entries.sort((a, b) => {
    const rankA = a.isDirectory() && !a.isSymbolicLink() ? 0 : 1;
    const rankB = b.isDirectory() && !b.isSymbolicLink() ? 0 : 1;
    return rankA - rankB || a.name.localeCompare(b.name);
  });
  const nodes = [];
  for (const entry of entries) {
    if (state.count >= state.maxEntries) { state.truncated = true; return nodes; }
    if (SKIPPED_DIRS.includes(entry.name)) continue;
    if (entry.isSymbolicLink()) { state.skipped += 1; continue; }
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      state.count += 1;
      const node = { name: entry.name, type: 'dir' };
      if (depth > 1) {
        const children = await treeWithin(root, path, depth - 1, state);
        if (children.length) node.children = children;
      }
      nodes.push(node);
    } else if (entry.isFile()) {
      state.count += 1;
      const info = await stat(join(directory, entry.name)).catch(() => null);
      nodes.push({ name: entry.name, type: 'file', size: info?.size ?? 0 });
    }
  }
  return nodes;
}

function historyPath(dir, rootId) {
  return join(dir, `${rootId}.json`);
}

async function readHistory(dir, rootId) {
  try {
    const parsed = JSON.parse(await readFile(historyPath(dir, rootId), 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/** @type {Promise<any>} */
let historyQueue = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
function withHistoryLock(work) {
  const run = historyQueue.then(work);
  historyQueue = run.catch(() => {});
  return run;
}

/**
 * @param {string|null} dir
 * @param {{ rootId: string, path: string, kind: string, before: string|null, after: string|null, [key: string]: any }} entry
 * @returns {Promise<string|null>} the changeId, or null when history is disabled
 */
async function recordChange(dir, entry) {
  if (!dir) return null;
  return withHistoryLock(async () => {
    const entries = await readHistory(dir, entry.rootId);
    const record = { id: randomUUID(), time: Date.now(), ...entry };
    entries.push(record);
    while (entries.length > LIMITS.historyEntries) entries.shift();
    let total = 0;
    const kept = [];
    for (const item of entries.slice().reverse()) {
      total += (item.before?.length ?? 0) + (item.after?.length ?? 0);
      if (total > LIMITS.historyBytes && kept.length) break;
      kept.push(item);
    }
    kept.reverse();
    await mkdir(dir, { recursive: true });
    await writeFile(historyPath(dir, entry.rootId), JSON.stringify({ version: 1, entries: kept }), { mode: 0o600 });
    return record.id;
  });
}

// Catastrophic backtracking would freeze the main process, and Node cannot
// preempt a running regex. Reject the usual shapes up front: a quantified group
// whose body is itself quantified ((a+)+, (a*)*, (a|a)+) is the classic ReDoS.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

function compileSearch(query, regex, ignoreCase) {
  if (!regex) {
    const needle = ignoreCase ? query.toLowerCase() : query;
    return line => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  if (NESTED_QUANTIFIER.test(query)) {
    throw new PermissionError('invalid-arguments', '这个正则可能造成回溯爆炸，请改写或改用字面量搜索');
  }
  let pattern;
  try {
    pattern = new RegExp(query, ignoreCase ? 'i' : '');
  } catch {
    throw new PermissionError('invalid-arguments', '正则表达式无效');
  }
  return line => pattern.test(line);
}

/**
 * @typedef {{
 *   name: string, label: string, description: string, parameters: object,
 *   execute: (id: string, args: any, signal?: AbortSignal) => Promise<{ content: { type: string, text: string }[], isError?: boolean }>,
 * }} ProjectTool
 */

/**
 * Builds the file tools exposed to the model for one request.
 *
 * A tool is only created when at least one root grants its capability, so the
 * model never sees an action it cannot perform. Each call re-reads the store.
 */
function createProjectTools({ permissions, roots, sessionKey, win, emit, historyDir = null, approvalPreset = undefined }) {
  if (!permissions || !Array.isArray(roots)) return [];
  const usable = roots.filter(root => root?.path && root?.name);
  const readRoots = usable.filter(root => root.capabilities?.read === true);
  const writeRoots = usable.filter(root => root.capabilities?.write === true);
  const execRoots = usable.filter(root => root.capabilities?.exec === true);
  if (!readRoots.length && !writeRoots.length && !execRoots.length) return [];
  // `extra` carries the detail the trace row expands into (command line, output,
  // file diff). It is merged into every emit so the renderer can show the real
  // content instead of only the one-line summary.
  function announce(id, name, label, detail, extra) {
    emit({ type: 'tool', id, name, label, status: 'running', detail, ...extra });
  }
  function settle(id, name, label, status, detail, extra) {
    emit({ type: 'tool', id, name, label, status, detail, ...extra });
  }

  // The signal travels with the approval so cancelling the run closes the
  // pending bar at once instead of after the dialog timeout.
  async function authorize(capability, root, summary, detail, preview, signal) {
    const decision = await permissions.authorize({ rootId: root.id, capability, sessionKey, win, summary, detail, preview, signal, approvalPreset });
    if (!decision.ok) throw new PermissionError(decision.reason === 'denied' ? 'denied' : 'not-granted');
  }

  /**
   * Re-checked inside the path lock, immediately before a mutation: the run may
   * have been cancelled, or the capability revoked, while the user was looking
   * at the confirmation dialog.
   */
  async function stillAllowed(capability, root, signal) {
    if (signal?.aborted) throw new PermissionError('aborted', '运行已取消');
    if (typeof permissions.check !== 'function') return;
    const live = await permissions.check({ rootId: root.id, capability, approvalPreset });
    if (!live?.ok) throw new PermissionError(live?.reason === 'not-granted' ? 'not-granted' : 'denied');
  }

  /** Resolves a model path inside the candidate roots; ambiguity is an error, never a guess. */
  async function resolveTarget(pathInput, options = {}) {
    const candidates = options.roots ?? readRoots;
    if (!candidates.length) throw new PermissionError('not-granted');
    if (typeof pathInput !== 'string' || !pathInput.trim()) throw new PermissionError('invalid-path');
    const normalized = normalizeRelativePath(pathInput);
    if (!normalized) {
      // "." and "./" address the project folder itself, exactly like an omitted path.
      if (candidates.length === 1) return { root: candidates[0], rel: '', abs: candidates[0].path };
      throw new PermissionError('root-required');
    }
    const segments = normalized.split('/').filter(Boolean);
    if (!segments.length) throw new PermissionError('invalid-path');

    const named = segments.length > 1
      ? candidates.find(root => root.name.toLowerCase() === segments[0].toLowerCase())
      : undefined;
    if (named) {
      const rel = segments.slice(1).join('/');
      return { root: named, rel, abs: await resolveInside(named.path, rel, options) };
    }
    if (candidates.length === 1) {
      return { root: candidates[0], rel: normalized, abs: await resolveInside(candidates[0].path, normalized, options) };
    }
    const matches = [];
    for (const root of candidates) {
      try { matches.push({ root, abs: await resolveInside(root.path, normalized, options) }); } catch { /* Not in this root. */ }
    }
    if (matches.length === 1) return { ...matches[0], rel: normalized };
    if (matches.length > 1) throw new PermissionError('ambiguous-path');
    throw new PermissionError(options.allowMissing ? 'root-required' : 'not-found');
  }

  async function listWithin(root, rel, depth, out) {
    const directory = rel ? await resolveInside(root.path, rel) : root.path;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= LIMITS.entries) return;
      if (SKIPPED_DIRS.includes(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ root: root.name, path, type: 'dir' });
        if (depth > 1) await listWithin(root, path, depth - 1, out);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = (await stat(join(directory, entry.name))).size; } catch { /* Race with deletion. */ }
        out.push({ root: root.name, path, type: 'file', size });
      }
    }
  }

  async function collectFiles(root, rel, depth, out, stats = null) {
    if (out.length >= LIMITS.searchFiles) return;
    const directory = rel ? await resolveInside(root.path, rel) : root.path;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= LIMITS.searchFiles) return;
      if (SKIPPED_DIRS.includes(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth > 1) await collectFiles(root, path, depth - 1, out, stats);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(join(directory, entry.name)).catch(() => null);
      if (!info) continue;
      if (info.size > LIMITS.searchFileBytes) {
        // Skipping is fine; skipping silently is not. The caller reports the count.
        if (stats) stats.tooLarge += 1;
        continue;
      }
      out.push({ root, path, abs: join(directory, entry.name) });
    }
  }

  async function git(root, args) {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: root.path, timeout: 15_000, maxBuffer: 4_000_000, windowsHide: true,
      });
      return stdout;
    } catch (error) {
      if (error?.code === 'ENOENT') throw new PermissionError('git-missing');
      if (error?.code === 'ETIMEDOUT') throw new PermissionError('timeout');
      const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
      if (/not a git repository/i.test(stderr)) throw new PermissionError('not-a-repository');
      throw new PermissionError('git-failed', (stderr || error?.message || '').slice(0, 300) || undefined);
    }
  }

  /**
   * Git tools used to look only at the first project folder, so a repository in
   * a later folder read as "not a repository". Try candidates in order and keep
   * the first answer; a missing git binary is never retried.
   */
  async function firstGit(candidates, run) {
    let failure = null;
    for (const candidate of candidates) {
      try {
        return await run(candidate);
      } catch (error) {
        if (error instanceof PermissionError && error.code === 'git-missing') throw error;
        if (!(error instanceof PermissionError && error.code === 'not-a-repository') && !failure) failure = error;
      }
    }
    throw failure ?? new PermissionError('not-a-repository');
  }

  /** @type {ProjectTool[]} */
  const tools = [
    {
      name: 'list_files',
      label: '列出文件',
      description: 'List files and folders inside the project folders. Paths are relative to a project folder; prefix with the folder name when there are several.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: 400, description: 'Relative folder path; omit it — or pass "." — to list the top level of every project folder' },
          depth: { type: 'integer', minimum: 1, maximum: 3, description: 'How many folder levels to descend (default 1)' },
        },
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '列出文件';
        announce(id, 'list_files', label, args?.path || '项目根目录');
        try {
          const depth = clamp(args?.depth ?? 1, 1, LIMITS.depth);
          const entries = [];
          if (!isRootPathInput(args?.path)) {
            const target = await resolveTarget(args.path);
            await stillAllowed('read', target.root, toolSignal);
            await listWithin(target.root, target.rel, depth, entries);
          } else {
            for (const root of readRoots) {
              await stillAllowed('read', root, toolSignal);
              await listWithin(root, '', depth, entries);
            }
          }
          const truncated = entries.length >= LIMITS.entries;
          settle(id, 'list_files', label, 'done', `${entries.length} 项${truncated ? '（已截断）' : ''}`);
          return toolResult({ entries, truncated, skipped: [...SKIPPED_DIRS] });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'list_files', label, code === 'not-granted' || code === 'denied' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'read_file',
      label: '读取文件',
      description: 'Read a file inside the project folders. Text files: use startLine/endLine for large files; files above 4 MB are streamed by line range instead of refused. Binary files are not refused either — they come back described (mime, size, base64 head, printable strings).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 400, description: 'Relative file path, optionally prefixed with the project folder name' },
          startLine: { type: 'integer', minimum: 1, description: 'First line to return (1-based)' },
          endLine: { type: 'integer', minimum: 1, description: 'Last line to return (inclusive)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '读取文件';
        announce(id, 'read_file', label, args?.path);
        try {
          const target = await resolveTarget(args.path);
          await stillAllowed('read', target.root, toolSignal);
          const info = await stat(target.abs);
          if (!info.isFile()) throw new PermissionError('not-a-file');
          if (info.size > LIMITS.readCeilingBytes) {
            throw new PermissionError('file-too-large', '文件超过 512 MB，请改用 search_files 或其它方式取需要的片段');
          }
          const shown = `${target.root.name}/${target.rel}`;

          // One head probe decides text vs binary for both branches below.
          const handle = await open(target.abs, 'r');
          let head;
          try {
            const probeLength = Math.min(info.size, LIMITS.binaryProbeBytes);
            head = Buffer.alloc(probeLength);
            if (probeLength) await handle.read(head, 0, probeLength, 0);
          } finally {
            await handle.close();
          }
          const mime = sniffMime(head);
          const looksBinary = head.includes(0) || (mime != null && !mime.startsWith('text/'));

          if (looksBinary) {
            // Refusing outright used to make images, PDFs and compiled files
            // invisible. Describe them instead: type, size, a bounded base64
            // head and printable runs, so the model can tell what it is holding.
            const summary = await describeBinary(target.abs, info.size);
            settle(id, 'read_file', label, 'done', `${shown} · 二进制 ${summary.mime}`);
            return toolResult({
              path: shown,
              binary: true,
              ...summary,
              note: '这是二进制文件：excerptBase64 是前 4 KB，strings 是可打印片段。不能当作文本整体读取或编辑。',
            });
          }

          const requestedStart = clamp(args.startLine ?? 1, 1, Number.MAX_SAFE_INTEGER);
          const requestedEnd = args.endLine ? Math.max(requestedStart, clamp(args.endLine, 1, Number.MAX_SAFE_INTEGER)) : Number.MAX_SAFE_INTEGER;
          let startLine = requestedStart;
          let endLine;
          let totalLines = null;
          let content;
          let truncated = false;
          const streamed = info.size > LIMITS.readWholeBytes;

          if (!streamed) {
            const buffer = await readFile(target.abs);
            const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').split('\n');
            totalLines = lines.length;
            startLine = Math.min(requestedStart, totalLines);
            endLine = Math.min(requestedEnd, totalLines);
            content = lines.slice(startLine - 1, endLine).join('\n');
            if (content.length > LIMITS.readChars) {
              content = content.slice(0, LIMITS.readChars);
              truncated = true;
            }
          } else {
            // Large files are read by line range: nothing like the whole file
            // is ever buffered, so 4 MB is no longer a wall.
            const range = await readLineRange(target.abs, requestedStart, requestedEnd, toolSignal);
            content = range.lines.join('\n');
            totalLines = range.totalLines;
            truncated = range.truncated;
            endLine = range.lines.length ? requestedStart + range.lines.length - 1 : requestedStart - 1;
          }

          settle(id, 'read_file', label, 'done', `${shown} · ${content ? content.split('\n').length : 0} 行${streamed ? '（分段流式读取）' : ''}`);
          return toolResult({
            path: shown,
            startLine, endLine: Math.max(startLine, endLine ?? startLine), totalLines, content, truncated,
            ...(streamed ? { streamed: true, ...(totalLines == null ? { note: '文件较大，按行范围流式读取，未统计总行数' } : {}) } : {}),
            ...(truncated ? { note: streamed ? '已达到单次读取字符上限，请用 startLine/endLine 继续' : '内容已截断，请用 startLine/endLine 分段读取' } : {}),
          });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'read_file', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'search_files',
      label: '搜索文件内容',
      description: 'Search text inside the project folders and return matching lines with file paths and line numbers. Prefer this over reading whole files to find code. Files above 8 MB are skipped and the count is reported.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: 'Text to look for (literal by default)' },
          path: { type: 'string', maxLength: 400, description: 'Relative folder to search in; omit to search every project folder' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression' },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive matching (default true)' },
          maxResults: { type: 'integer', minimum: 1, maximum: 120, description: 'Maximum matching lines (default 60)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '搜索文件内容';
        announce(id, 'search_files', label, args?.query);
        try {
          if (typeof args?.query !== 'string' || !args.query.trim()) throw new PermissionError('invalid-arguments');
          const matches = compileSearch(args.query, args.regex === true, args.ignoreCase !== false);
          const limit = clamp(args.maxResults ?? 60, 1, LIMITS.searchMatches);
          const roots = isRootPathInput(args.path) ? readRoots.map(root => ({ root, rel: '', abs: null })) : [await resolveTarget(args.path)];
          const files = [];
          const stats = { tooLarge: 0 };
          for (const item of roots) {
            await stillAllowed('read', item.root, toolSignal);
            if (!item.abs) { await collectFiles(item.root, item.rel, 6, files, stats); continue; }
            // `path` is documented as a folder but may name one file; guessing
            // wrong turns a real match into a silent empty result.
            const info = await stat(item.abs).catch(() => null);
            if (info?.isDirectory()) await collectFiles(item.root, item.rel, 6, files, stats);
            else if (info?.isFile()) files.push({ root: item.root, path: item.rel, abs: item.abs });
            else throw new PermissionError(info ? 'not-a-file' : 'not-found');
          }
          const hits = [];
          let scanned = 0;
          for (const file of files) {
            if (hits.length >= limit) break;
            if (toolSignal?.aborted) throw new PermissionError('aborted', '运行已取消');
            const text = await readFile(file.abs, 'utf8').catch(() => null);
            if (text == null) continue;
            scanned += 1;
            if (text.includes('\0')) continue;
            const lines = text.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index];
              const hit = matches(line);
              if (!hit) continue;
              hits.push({ root: file.root.name, path: file.path, line: index + 1, text: line.trim().slice(0, 240) });
              if (hits.length >= limit) break;
            }
          }
          settle(id, 'search_files', label, 'done', `${hits.length} 处${hits.length >= limit ? '（已截断）' : ''} · 扫描 ${scanned} 个文件${stats.tooLarge ? ` · 跳过 ${stats.tooLarge} 个超大文件` : ''}`);
          return toolResult({
            matches: hits, truncated: hits.length >= limit, filesScanned: scanned,
            ...(stats.tooLarge ? { skippedTooLarge: stats.tooLarge, note: `有 ${stats.tooLarge} 个文件超过 ${Math.round(LIMITS.searchFileBytes / 1_000_000)} MB 未搜索，可用 read_file 按行范围查看` } : {}),
          });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'search_files', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'git_status',
      label: '查看 Git 状态',
      description: 'Show the working tree status of a project folder (branch plus changed files). Read-only; needs no approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: 400, description: 'Relative folder inside a Git repository; omit for the first project folder' },
        },
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '查看 Git 状态';
        announce(id, 'git_status', label, args?.path || '项目根目录');
        try {
          const candidates = isRootPathInput(args?.path) ? readRoots.map(root => ({ root, rel: '' })) : [await resolveTarget(args.path)];
          const stdout = await firstGit(candidates, candidate => git(candidate.root, ['status', '--porcelain=v1', '--branch']));
          const lines = stdout.split('\n').filter(Boolean);
          const branch = lines.find(line => line.startsWith('##'))?.slice(3) ?? '';
          const entries = lines.filter(line => !line.startsWith('##')).slice(0, 200).map(line => ({
            status: line.slice(0, 2).trim() || '??',
            path: line.slice(3).trim(),
          }));
          settle(id, 'git_status', label, 'done', `${entries.length} 个变更`);
          return toolResult({ branch, clean: entries.length === 0, entries });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'git_status', label, 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'git_diff',
      label: '查看 Git 差异',
      description: 'Show the unified diff of uncommitted changes in a project folder. Read-only; needs no approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: 400, description: 'Relative file or folder to diff; omit for the whole repository' },
          staged: { type: 'boolean', description: 'Show staged changes instead of the working tree' },
        },
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '查看 Git 差异';
        announce(id, 'git_diff', label, args?.path || '整个仓库');
        try {
          const candidates = isRootPathInput(args?.path) ? readRoots.map(root => ({ root, rel: '' })) : [await resolveTarget(args.path)];
          const found = await firstGit(candidates, async candidate => {
            const argv = ['diff', '--no-color', '--unified=3'];
            if (args?.staged === true) argv.push('--cached');
            if (candidate.rel) argv.push('--', candidate.rel);
            return { rel: candidate.rel, stdout: await git(candidate.root, argv) };
          });
          const truncated = found.stdout.length > LIMITS.gitOutput;
          settle(id, 'git_diff', label, 'done', truncated ? '差异已截断' : '已读取差异');
          return toolResult({
            path: found.rel || '.',
            diff: truncated ? found.stdout.slice(0, LIMITS.gitOutput) : found.stdout,
            truncated,
          });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'git_diff', label, 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
  ];

  if (readRoots.length) tools.push(
    {
      name: 'project_tree',
      label: '查看项目树',
      description: 'Show a bounded tree of the project folders (names, types, sizes). Skips .git, node_modules and symlinks. Read-only; needs no approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: 400, description: '相对文件夹路径；省略则列出每个项目文件夹' },
          depth: { type: 'integer', minimum: 1, maximum: 4, description: '向下展开几层（默认 3）' },
          maxEntries: { type: 'integer', minimum: 1, maximum: LIMITS.entries, description: `最多返回多少个条目（默认 ${LIMITS.entries}）` },
        },
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '查看项目树';
        announce(id, 'project_tree', label, args?.path || '项目根目录');
        try {
          const depth = clamp(args?.depth ?? LIMITS.depth, 1, 4);
          const maxEntries = clamp(args?.maxEntries ?? LIMITS.entries, 1, LIMITS.entries);
          const targets = isRootPathInput(args?.path) ? readRoots.map(root => ({ root, rel: '', abs: null })) : [await resolveTarget(args.path)];
          // Counted across every root: the budget is for the whole snapshot, so
          // a multi-root call cannot multiply the cost by the root count.
          const state = { count: 0, maxEntries, truncated: false, skipped: 0, errors: [] };
          const trees = [];
          for (const item of targets) {
            await stillAllowed('read', item.root, toolSignal);
            if (!item.rel) {
              trees.push({ name: item.root.name, tree: await treeWithin(item.root, '', depth, state) });
              continue;
            }
            const info = await stat(item.abs);
            if (info.isFile()) {
              trees.push({ name: item.root.name, tree: [{ name: item.rel.split('/').pop(), type: 'file', size: info.size }] });
              continue;
            }
            trees.push({ name: item.root.name, tree: await treeWithin(item.root, item.rel, depth, state) });
          }
          settle(id, 'project_tree', label, 'done', `${state.count} 项${state.truncated ? '（已截断）' : ''}`);
          return toolResult({
            roots: trees,
            truncated: state.truncated,
            skipped: state.skipped,
            ignored: [...SKIPPED_DIRS],
            errors: state.errors,
          });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'project_tree', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'find_symbol',
      label: '查找符号',
      description: 'Find where a name is defined or referenced across the project folders. Literal matching only (never a regular expression). Read-only; needs no approval.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120, description: '要查找的符号名（按字面量匹配，不使用正则）' },
          kind: { type: 'string', enum: ['any', 'definition', 'reference'], description: '查找范围：定义、引用或两者（默认 any）' },
          path: { type: 'string', maxLength: 400, description: '相对文件夹或文件；省略则搜索每个项目文件夹' },
          maxResults: { type: 'integer', minimum: 1, maximum: 120, description: '最多返回多少条命中（默认 60）' },
          ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认 false）' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '查找符号';
        announce(id, 'find_symbol', label, args?.name);
        try {
          const name = typeof args?.name === 'string' ? args.name.trim() : '';
          if (!name || name.length > 120) throw new PermissionError('invalid-arguments');
          const kind = ['any', 'definition', 'reference'].includes(args?.kind) ? args.kind : 'any';
          const limit = clamp(args?.maxResults ?? 60, 1, 120);
          const flags = args?.ignoreCase === true ? 'i' : '';
          // The name is escaped, so a symbol containing regex syntax is still a
          // literal and can never turn into a backtracking pattern.
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Word boundaries only make sense next to a word character: `greet(`
          // must not turn into `\bgreet\(\b`, which would match `greet("x")`.
          const lead = /^\w/.test(name) ? '\\b' : '';
          const tail = /\w$/.test(name) ? '\\b' : '';
          const word = new RegExp(`${lead}${escaped}${tail}`, flags);
          const declaration = new RegExp(
            `\\b(?:function|class|const|let|var|interface|type|enum|def|struct|fn|impl|trait)\\s+${escaped}${tail}`,
            flags,
          );
          // A method definition starts the line (after modifiers); excluding a
          // leading `.` keeps `object.name(...)` calls out of the definitions.
          const method = new RegExp(
            `^\\s*(?:(?:export|default|async|static|public|private|protected|override|virtual)\\s+)*${escaped}\\s*\\(`,
            flags,
          );
          const roots = isRootPathInput(args?.path) ? readRoots.map(root => ({ root, rel: '', abs: null })) : [await resolveTarget(args.path)];
          const files = [];
          for (const item of roots) {
            await stillAllowed('read', item.root, toolSignal);
            if (!item.abs) { await collectFiles(item.root, item.rel, 20, files); continue; }
            const info = await stat(item.abs).catch(() => null);
            if (info?.isDirectory()) await collectFiles(item.root, item.rel, 20, files);
            else if (info?.isFile()) files.push({ root: item.root, path: item.rel, abs: item.abs });
            else throw new PermissionError(info ? 'not-a-file' : 'not-found');
          }
          const definitions = [];
          const references = [];
          let scanned = 0;
          let truncated = false;
          for (const file of files) {
            if (definitions.length + references.length >= limit) { truncated = true; break; }
            if (toolSignal?.aborted) throw new PermissionError('aborted', '运行已取消');
            const text = await readFile(file.abs, 'utf8').catch(() => null);
            if (text == null) continue;
            scanned += 1;
            if (text.includes('\0')) continue;
            const lines = text.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index];
              const isDefinition = declaration.test(line) || method.test(line);
              if (!isDefinition && !word.test(line)) continue;
              if (kind === 'definition' && !isDefinition) continue;
              if (kind === 'reference' && isDefinition) continue;
              const hit = { root: file.root.name, path: file.path, line: index + 1, text: line.trim().slice(0, 240) };
              (isDefinition ? definitions : references).push(hit);
              if (definitions.length + references.length >= limit) { truncated = true; break; }
            }
          }
          settle(id, 'find_symbol', label, 'done', `${definitions.length} 个定义 · ${references.length} 处引用 · 扫描 ${scanned} 个文件`);
          return toolResult({ definitions, references, truncated, filesScanned: scanned });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'find_symbol', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
  );

  if (historyDir) {
    tools.push({
      name: 'list_changes',
      label: '查看最近的修改',
      description: 'List recent file changes this app made in the project folders, so one can be undone by id.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many recent changes to return (default 10)' } },
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '查看最近的修改';
        announce(id, 'list_changes', label, '最近修改');
        try {
          const limit = clamp(args?.limit ?? 10, 1, 30);
          const changes = [];
          for (const root of readRoots) {
            for (const entry of await readHistory(historyDir, root.id)) {
              changes.push({ id: entry.id, root: root.name, path: entry.path, time: entry.time, kind: entry.kind, bytes: entry.after?.length ?? 0 });
            }
          }
          changes.sort((a, b) => b.time - a.time);
          const recent = changes.slice(0, limit);
          settle(id, 'list_changes', label, 'done', `${recent.length} 条`);
          return toolResult({ changes: recent, truncated: changes.length > limit });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          settle(id, 'list_changes', label, 'error', MESSAGES.failed);
          return toolResult({ error: 'failed', message: MESSAGES.failed }, true);
        }
      },
    });
  }

  if (writeRoots.length) tools.push(
    {
      name: 'write_file',
      label: '写入文件',
      description: 'Create or overwrite a text file inside a project folder. Prefer replace_in_file for small edits. The user approves the change in the app.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 400, description: 'Relative file path, optionally prefixed with the project folder name' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '写入文件';
        announce(id, 'write_file', label, args?.path, { path: args?.path });
        try {
          if (typeof args?.content !== 'string') throw new PermissionError('invalid-arguments');
          if (args.content.length > LIMITS.writeChars) throw new PermissionError('file-too-large');
          const target = await resolveTarget(args.path, { allowMissing: true, roots: writeRoots });
          guardWrite(target);
          const existing = await stat(target.abs).catch(() => null);
          if (existing && !existing.isFile()) throw new PermissionError('not-a-file');
          if (existing && existing.size > LIMITS.fileBytes) throw new PermissionError('file-too-large');
          const before = existing ? await readFile(target.abs, 'utf8').catch(() => null) : null;
          // Overwriting content we could not read would make the change
          // impossible to review and impossible to undo, so refuse instead.
          if (existing && before == null) throw new PermissionError('access-denied');
          // A binary file has no faithful text snapshot, so an overwrite could
          // not be undone. Deleting it is the honest path (and also recorded).
          if (before != null && before.includes('\0')) {
            throw new PermissionError('binary', '这是二进制文件，覆盖后无法撤销；要替换请先 delete_path 再写入');
          }
          const approvedDigest = digestOf(before);
          const bytes = Buffer.byteLength(args.content);
          const preview = previewOf('write', `${target.root.name}/${target.rel}`, before, args.content);
          await authorize('write', target.root, `写入 ${target.root.name}/${target.rel}`, `${existing ? '覆盖' : '新建'}文件 · ${bytes} 字节`, preview, toolSignal);
          // The approval covered one exact file state. Everything that decides
          // the write, plus the history entry that makes it undoable, now runs
          // inside the same per-path lock so a concurrent run cannot slip in.
          const commit = await withPathLock(target.abs, async () => {
            await stillAllowed('write', target.root, toolSignal);
            const now = await stat(target.abs).catch(() => null);
            if (Boolean(now) !== Boolean(existing)) throw new PermissionError('conflict');
            if (now && !now.isFile()) throw new PermissionError('not-a-file');
            if (now && now.size > LIMITS.fileBytes) throw new PermissionError('file-too-large');
            const current = now ? await readFile(target.abs, 'utf8').catch(() => null) : null;
            if (digestOf(current) !== approvedDigest) throw new PermissionError('conflict');
            await writeAtomic(target.abs, args.content);
            let changeId = null;
            let historyWarning = null;
            try {
              changeId = await recordChange(historyDir, {
                rootId: target.root.id, path: target.rel, kind: existing ? 'write' : 'create', before: current, after: args.content,
              });
            } catch {
              // The write already landed; say so instead of pretending undo will work.
              historyWarning = '修改已完成，但撤销记录没有写入，这次修改无法撤销';
            }
            return { changeId, historyWarning };
          });
          settle(id, 'write_file', label, 'done', `${target.root.name}/${target.rel} · ${bytes} 字节`, {
            path: `${target.root.name}/${target.rel}`, diff: preview,
          });
          return toolResult({
            path: `${target.root.name}/${target.rel}`, bytes, created: !existing, ...commit,
          });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'write_file', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'replace_in_file',
      label: '修改文件',
      description: 'Replace one exact text fragment in a file. Fails when the fragment is missing or appears more than once, unless all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 400, description: 'Relative file path' },
          oldText: { type: 'string', minLength: 1, description: 'Exact text to find' },
          newText: { type: 'string', description: 'Replacement text' },
          all: { type: 'boolean', description: 'Replace every occurrence' },
        },
        required: ['path', 'oldText'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '修改文件';
        announce(id, 'replace_in_file', label, args?.path, { path: args?.path });
        try {
          if (typeof args?.oldText !== 'string' || !args.oldText) throw new PermissionError('invalid-arguments');
          const newText = typeof args.newText === 'string' ? args.newText : '';
          const target = await resolveTarget(args.path, { roots: writeRoots });
          guardWrite(target);
          const info = await stat(target.abs);
          if (!info.isFile()) throw new PermissionError('not-a-file');
          if (info.size > LIMITS.fileBytes) throw new PermissionError('file-too-large');
          const original = await readFile(target.abs, 'utf8');
          const occurrences = original.split(args.oldText).length - 1;
          if (!occurrences) throw new PermissionError('not-found-in-file');
          if (occurrences > 1 && args.all !== true) {
            throw new PermissionError('ambiguous-match', `${MESSAGES['ambiguous-match']}（出现 ${occurrences} 次）`);
          }
          const next = args.all === true
            ? original.split(args.oldText).join(newText)
            : original.replace(args.oldText, newText);
          if (next.length > LIMITS.writeChars) throw new PermissionError('file-too-large');
          const preview = previewOf('replace', `${target.root.name}/${target.rel}`, args.oldText, newText);
          const approvedDigest = digestOf(original);
          const replacements = args.all === true ? occurrences : 1;
          await authorize('write', target.root, `修改 ${target.root.name}/${target.rel}`, `${replacements} 处替换`, preview, toolSignal);
          // Approve-then-write is one transaction: verify the file still holds
          // what the user approved, write, and record history under one lock.
          const commit = await withPathLock(target.abs, async () => {
            await stillAllowed('write', target.root, toolSignal);
            const info2 = await stat(target.abs).catch(() => null);
            if (!info2 || !info2.isFile()) throw new PermissionError('not-found');
            const current = await readFile(target.abs, 'utf8');
            if (digestOf(current) !== approvedDigest) throw new PermissionError('conflict');
            const currentHits = current.split(args.oldText).length - 1;
            if (!currentHits) throw new PermissionError('not-found-in-file');
            if (currentHits > 1 && args.all !== true) throw new PermissionError('ambiguous-match');
            const target2 = args.all === true
              ? current.split(args.oldText).join(newText)
              : current.replace(args.oldText, newText);
            if (target2.length > LIMITS.writeChars) throw new PermissionError('file-too-large');
            await writeAtomic(target.abs, target2);
            let changeId = null;
            let historyWarning = null;
            try {
              changeId = await recordChange(historyDir, {
                rootId: target.root.id, path: target.rel, kind: 'replace', before: current, after: target2,
              });
            } catch {
              historyWarning = '修改已完成，但撤销记录没有写入，这次修改无法撤销';
            }
            return { changeId, historyWarning, bytes: Buffer.byteLength(target2) };
          });
          settle(id, 'replace_in_file', label, 'done', `${target.root.name}/${target.rel} · ${replacements} 处`, {
            path: `${target.root.name}/${target.rel}`, diff: preview,
          });
          return toolResult({
            path: `${target.root.name}/${target.rel}`, replacements, ...commit,
          });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'replace_in_file', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'delete_path',
      label: '删除文件或文件夹',
      description: 'Delete one file or one folder inside a project folder. A folder that still has content needs recursive=true. The user approves the deletion in the app; a file deletion is recorded so undo_change can restore the content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 400, description: '要删除的相对路径，可加项目文件夹名前缀' },
          recursive: { type: 'boolean', description: '删除文件夹时是否连同里面所有内容一起删除（默认 false）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '删除文件或文件夹';
        announce(id, 'delete_path', label, args?.path, { path: args?.path });
        try {
          const target = await resolveTarget(args.path, { roots: writeRoots });
          guardWrite(target);
          // Removing a project folder itself would leave the permission model
          // pointing at nothing; only paths inside it may be deleted.
          if (!target.rel) throw new PermissionError('protected-path', '不能删除项目文件夹本身');
          const info = await stat(target.abs);
          const shown = `${target.root.name}/${target.rel}`;

          if (info.isFile()) {
            // A deletion nobody can undo is a data-loss trap, so refuse exactly
            // the cases whose content cannot be kept for undo (as write_file does).
            if (info.size > LIMITS.fileBytes) throw new PermissionError('file-too-large', '文件太大，删除后无法撤销，已拒绝删除');
            const buffer = await readFile(target.abs);
            if (buffer.subarray(0, 8192).includes(0)) throw new PermissionError('binary', '二进制文件删除后无法撤销，已拒绝删除');
            const before = buffer.toString('utf8');
            const approved = digestOf(before);
            const preview = previewOf('delete', shown, before, null);
            await authorize('write', target.root, `删除 ${shown}`, `删除文件 · ${info.size} 字节\n删除后可用 list_changes / undo_change 恢复`, preview, toolSignal);
            const commit = await withPathLock(target.abs, async () => {
              await stillAllowed('write', target.root, toolSignal);
              const now = await stat(target.abs).catch(() => null);
              if (!now) throw new PermissionError('not-found');
              if (!now.isFile()) throw new PermissionError('not-a-file');
              const current = await readFile(target.abs, 'utf8');
              if (digestOf(current) !== approved) throw new PermissionError('conflict');
              await rm(target.abs, { force: true });
              let changeId = null;
              let historyWarning = null;
              try {
                changeId = await recordChange(historyDir, {
                  rootId: target.root.id, path: target.rel, kind: 'delete', before: current, after: null,
                });
              } catch {
                historyWarning = '文件已删除，但撤销记录没有写入，这次删除无法撤销';
              }
              return { changeId, historyWarning };
            });
            settle(id, 'delete_path', label, 'done', `${shown} 已删除`, { path: shown });
            return toolResult({ path: shown, deleted: 'file', bytes: info.size, ...commit });
          }
          if (!info.isDirectory()) throw new PermissionError('not-a-file');

          const entries = await readdir(target.abs).catch(error => { throw new PermissionError(codeOf(error), messageOf(error, codeOf(error))); });
          if (!entries.length) {
            await authorize('write', target.root, `删除文件夹 ${shown}`, '删除一个空文件夹', previewOf('delete', `${shown}/`, null, null), toolSignal);
            await withPathLock(target.abs, async () => {
              await stillAllowed('write', target.root, toolSignal);
              const now = await readdir(target.abs).catch(() => null);
              if (now == null) throw new PermissionError('not-found');
              if (now.length) throw new PermissionError('conflict', '文件夹里出现了新内容，已放弃删除');
              await rm(target.abs, { recursive: true, force: true });
            });
            settle(id, 'delete_path', label, 'done', `${shown} 已删除`, { path: shown });
            return toolResult({ path: shown, deleted: 'directory', files: 0, bytes: 0, changeIds: [] });
          }
          if (args?.recursive !== true) throw new PermissionError('directory-not-empty');
          // A recursive delete would sweep a repository's .git along with the
          // folder, bypassing the guard that protects it for single paths.
          if (entries.some(name => name.toLowerCase() === '.git')) {
            throw new PermissionError('protected-path', '这个文件夹里有 .git，不能整个删除');
          }

          // Walk the tree ourselves instead of reusing `collectFiles`: that
          // helper skips node_modules and every file over 1 MB, so those would
          // be swept by `rm -r` with no undo record and no line in the preview.
          const snapshot = [];
          let total = 0;
          const stack = [target.rel];
          while (stack.length) {
            const relative = stack.pop();
            const directory = await resolveInside(target.root.path, relative);
            const items = await readdir(directory, { withFileTypes: true });
            for (const entry of items) {
              const childRel = `${relative}/${entry.name}`;
              // A nested repository must not be swept away behind the same
              // guard that protects `.git` for single-path writes.
              if (entry.name.toLowerCase() === '.git') {
                throw new PermissionError('protected-path', '这个文件夹里有 .git，不能整个删除');
              }
              if (entry.isDirectory()) { stack.push(childRel); continue; }
              if (!entry.isFile()) continue;
              const abs = join(directory, entry.name);
              const fileInfo = await stat(abs);
              if (fileInfo.size > LIMITS.fileBytes) {
                throw new PermissionError('file-too-large', `${childRel} 太大，删除后无法撤销，请单独处理`);
              }
              if (snapshot.length >= 50) throw new PermissionError('too-many-files', '文件太多，请分几次删除');
              total += fileInfo.size;
              if (total > LIMITS.deleteBytes) throw new PermissionError('too-many-files', '这些文件合计太大，请分几次删除');
              const buffer = await readFile(abs);
              if (buffer.subarray(0, 8192).includes(0)) {
                throw new PermissionError('binary', `${childRel} 是二进制文件，删除后无法撤销，请单独处理`);
              }
              const content = buffer.toString('utf8');
              snapshot.push({ rel: childRel, abs, size: fileInfo.size, content, digest: digestOf(content) });
            }
          }
          const preview = previewOf('delete', `${shown}/`, null, null);
          await authorize('write', target.root, `删除文件夹 ${shown}`, `将删除 ${snapshot.length} 个文件、共 ${total} 字节\n每个文件都会写入撤销记录，可用 undo_change 逐个恢复`, preview, toolSignal);
          const commit = await withPathLock(target.abs, async () => {
            await stillAllowed('write', target.root, toolSignal);
            const now = await readdir(target.abs).catch(() => null);
            if (now == null) throw new PermissionError('not-found');
            // Verify every file before deleting any of them: a conflict halfway
            // through would leave a half-deleted tree with no good answer.
            for (const file of snapshot) {
              const current = await readFile(file.abs, 'utf8').catch(() => null);
              if (digestOf(current) !== file.digest) throw new PermissionError('conflict', '删除过程中文件被改动，已放弃');
            }
            const changeIds = [];
            let historyWarning = null;
            for (const file of snapshot) {
              await rm(file.abs, { force: true });
              try {
                const changeId = await recordChange(historyDir, {
                  rootId: target.root.id, path: file.rel, kind: 'delete', before: file.content, after: null,
                });
                if (changeId) changeIds.push(changeId);
              } catch {
                historyWarning = '有文件已删除但撤销记录没有写入，部分删除无法撤销';
              }
            }
            // Removes the emptied folders and any symlink the walk did not count.
            await rm(target.abs, { recursive: true, force: true });
            return { changeIds, historyWarning };
          });
          settle(id, 'delete_path', label, 'done', `${shown} · ${snapshot.length} 个文件已删除`, { path: shown });
          return toolResult({ path: shown, deleted: 'directory', files: snapshot.length, bytes: total, ...commit });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'delete_path', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'move_path',
      label: '移动文件或文件夹',
      description: 'Move one file or folder to another path inside the same project folder. Never copies across project folders or drives, so one approval always covers both endpoints.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', minLength: 1, maxLength: 400, description: '源路径（相对路径，可加项目文件夹名前缀）' },
          to: { type: 'string', minLength: 1, maxLength: 400, description: '目标路径（必须在同一个项目文件夹内）' },
          overwrite: { type: 'boolean', description: '目标已存在时是否覆盖（默认 false）' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '移动文件或文件夹';
        announce(id, 'move_path', label, `${args?.from ?? ''} → ${args?.to ?? ''}`, { path: args?.to || args?.from });
        try {
          const source = await resolveTarget(args.from, { roots: writeRoots });
          const destination = await resolveTarget(args.to, { roots: writeRoots, allowMissing: true });
          guardWrite(source);
          guardWrite(destination);
          if (!source.rel || !destination.rel) throw new PermissionError('protected-path', '不能移动项目文件夹本身');
          // A rename across roots (or drives) is not a rename at all; emulating
          // it with copy+delete would lose the file on a partial failure.
          if (source.root.id !== destination.root.id) throw new PermissionError('cross-root-move');
          if (lockKey(source.abs) === lockKey(destination.abs)) throw new PermissionError('same-path');
          const info = await stat(source.abs);
          const destInfo = await stat(destination.abs).catch(() => null);
          if (destInfo && args?.overwrite !== true) throw new PermissionError('already-exists');
          if (destInfo && destInfo.isDirectory() !== info.isDirectory()) {
            throw new PermissionError('already-exists', '目标已存在，而且类型不同');
          }
          const shownFrom = `${source.root.name}/${source.rel}`;
          const shownTo = `${destination.root.name}/${destination.rel}`;
          const locks = [source.abs, destination.abs];

          if (info.isDirectory()) {
            if (isInside(source.abs, destination.abs)) {
              throw new PermissionError('path-escape', '不能把文件夹移动到它自己里面');
            }
            const detail = `移动文件夹：${shownFrom} → ${shownTo}${destInfo ? '\n目标已存在，会被覆盖删除' : ''}\n文件夹移动不写入撤销记录，无法撤销。`;
            await authorize('write', source.root, `移动 ${shownFrom} → ${shownTo}`, detail, previewOf('move', shownFrom, null, null), toolSignal);
            await withPathLocks(locks, async () => {
              await stillAllowed('write', source.root, toolSignal);
              const now = await stat(source.abs).catch(() => null);
              if (!now) throw new PermissionError('not-found');
              if (destInfo) await rm(destination.abs, { recursive: true, force: true });
              await mkdir(dirname(destination.abs), { recursive: true });
              await rename(source.abs, destination.abs);
            });
            settle(id, 'move_path', label, 'done', `${shownFrom} → ${shownTo}`, { path: shownTo });
            return toolResult({ from: shownFrom, to: shownTo, moved: 'directory', overwritten: Boolean(destInfo), undoable: false });
          }

          if (info.size > LIMITS.fileBytes) throw new PermissionError('file-too-large', '文件太大，移动后无法撤销，已拒绝移动');
          const buffer = await readFile(source.abs);
          if (buffer.subarray(0, 8192).includes(0)) throw new PermissionError('binary', '二进制文件移动后无法撤销，已拒绝移动');
          const before = buffer.toString('utf8');
          const approved = digestOf(before);
          const detail = `${shownFrom} → ${shownTo}${destInfo ? '\n目标已存在，会被覆盖（覆盖前的内容会写入撤销记录）' : ''}`;
          await authorize('write', source.root, `移动 ${shownFrom} → ${shownTo}`, detail, previewOf('move', shownFrom, before, null), toolSignal);
          const commit = await withPathLocks(locks, async () => {
            await stillAllowed('write', source.root, toolSignal);
            const nowSource = await stat(source.abs).catch(() => null);
            if (!nowSource) throw new PermissionError('not-found');
            if (!nowSource.isFile()) throw new PermissionError('not-a-file');
            const current = await readFile(source.abs, 'utf8');
            if (digestOf(current) !== approved) throw new PermissionError('conflict');
            const nowDest = await stat(destination.abs).catch(() => null);
            if (nowDest && args.overwrite !== true) throw new PermissionError('conflict', '目标位置在审批期间出现了同名文件，已放弃移动');
            if (nowDest && nowDest.isDirectory()) throw new PermissionError('already-exists', '目标位置是一个文件夹');
            let overwritten = null;
            if (nowDest) {
              if (nowDest.size > LIMITS.fileBytes) throw new PermissionError('file-too-large', '目标文件太大，覆盖后无法撤销');
              overwritten = await readFile(destination.abs, 'utf8').catch(() => null);
              // Windows refuses to rename onto an existing name, so clear it first.
              await rm(destination.abs, { force: true });
            }
            await mkdir(dirname(destination.abs), { recursive: true });
            await rename(source.abs, destination.abs);
            const changeIds = [];
            let historyWarning = null;
            try {
              const movedId = await recordChange(historyDir, {
                rootId: source.root.id, path: source.rel, kind: 'move', before: current, after: null, movedTo: shownTo,
              });
              const createdId = await recordChange(historyDir, {
                rootId: destination.root.id, path: destination.rel, kind: 'create', before: overwritten, after: current,
              });
              if (movedId) changeIds.push(movedId);
              if (createdId) changeIds.push(createdId);
            } catch {
              historyWarning = '移动已完成，但撤销记录没有写入，这次移动无法撤销';
            }
            return { changeIds, historyWarning, overwritten: Boolean(nowDest) };
          });
          settle(id, 'move_path', label, 'done', `${shownFrom} → ${shownTo}`, { path: shownTo });
          return toolResult({ from: shownFrom, to: shownTo, moved: 'file', bytes: Buffer.byteLength(before), ...commit });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'move_path', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
    {
      name: 'apply_changes',
      label: '批量修改文件',
      description: 'Apply 1 to 20 whole-file writes and exact replacements in a single approval. Every change is validated first, and if any file changed while the dialog was open nothing is written at all.',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            description: '要一起应用的修改，必须都在同一个项目文件夹内，每个文件只能出现一次',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', minLength: 1, maxLength: 400, description: '相对文件路径' },
                content: { type: 'string', description: '整文件写入的完整内容（与 oldText 二选一）' },
                oldText: { type: 'string', minLength: 1, description: '要精确替换的原文（与 content 二选一）' },
                newText: { type: 'string', description: '替换后的文本' },
                all: { type: 'boolean', description: '替换全部出现的位置' },
              },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
      async execute(id, args, toolSignal) {
        const label = '批量修改文件';
        announce(id, 'apply_changes', label, Array.isArray(args?.changes) ? `${args.changes.length} 个文件` : '');
        try {
          const requested = args?.changes;
          if (!Array.isArray(requested) || requested.length < 1 || requested.length > 20) {
            throw new PermissionError('invalid-arguments', 'changes 必须是 1 到 20 项的数组');
          }
          // Plan every file up front: a batch is approved as one unit, so a
          // single bad item must abort the whole call before anything is asked
          // of the user or written to disk.
          const plans = [];
          const seen = new Set();
          for (const change of requested) {
            if (!change || typeof change !== 'object' || Array.isArray(change)) throw new PermissionError('invalid-arguments');
            const target = await resolveTarget(change.path, { allowMissing: true, roots: writeRoots });
            guardWrite(target);
            const key = lockKey(target.abs);
            if (seen.has(key)) throw new PermissionError('invalid-arguments', '同一个文件不能在 changes 里出现两次');
            seen.add(key);
            const info = await stat(target.abs).catch(() => null);
            if (info && !info.isFile()) throw new PermissionError('not-a-file');
            if (info && info.size > LIMITS.fileBytes) throw new PermissionError('file-too-large');
            const before = info ? await readFile(target.abs, 'utf8').catch(() => null) : null;
            if (info && before == null) throw new PermissionError('access-denied');
            if (before != null && before.includes('\0')) {
              throw new PermissionError('binary', '批量修改不能覆盖二进制文件：没有可撤销的文本快照');
            }
            let after;
            if (typeof change.content === 'string') {
              if (change.oldText != null) throw new PermissionError('invalid-arguments', 'content 与 oldText 只能二选一');
              after = change.content;
            } else if (typeof change.oldText === 'string' && change.oldText) {
              if (before == null) throw new PermissionError('not-found-in-file');
              const occurrences = before.split(change.oldText).length - 1;
              if (!occurrences) throw new PermissionError('not-found-in-file');
              if (occurrences > 1 && change.all !== true) {
                throw new PermissionError('ambiguous-match', `${MESSAGES['ambiguous-match']}（出现 ${occurrences} 次）`);
              }
              const newText = typeof change.newText === 'string' ? change.newText : '';
              after = change.all === true
                ? before.split(change.oldText).join(newText)
                : before.replace(change.oldText, newText);
            } else {
              throw new PermissionError('invalid-arguments', '每一项要么给 content，要么给 oldText');
            }
            if (after.length > LIMITS.writeChars) throw new PermissionError('file-too-large');
            plans.push({ target, shown: `${target.root.name}/${target.rel}`, before, after, digest: digestOf(before) });
          }
          // One dialog can only describe one root, so a batch stays inside one.
          if (plans.some(plan => plan.target.root.id !== plans[0].target.root.id)) {
            throw new PermissionError('batch-cross-root');
          }
          const preview = {
            kind: 'batch',
            path: `${plans.length} 个文件`,
            before: null,
            after: null,
            files: plans.map(plan => previewFile(plan.shown, plan.before, plan.after)),
          };
          const totalBytes = plans.reduce((sum, plan) => sum + Buffer.byteLength(plan.after), 0);
          await authorize(
            'write',
            plans[0].target.root,
            `批量修改 ${plans.length} 个文件`,
            `${plans.map(plan => plan.shown).join('\n')}\n共 ${totalBytes} 字节，全部成功或全部不写`,
            preview,
            toolSignal,
          );
          // All locks are taken before the hash checks and held until the last
          // write, so the whole batch commits against the state that was approved.
          const outcome = await withPathLocks(plans.map(plan => plan.target.abs), async () => {
            for (const plan of plans) await stillAllowed('write', plan.target.root, toolSignal);
            for (const plan of plans) {
              const current = await readFile(plan.target.abs, 'utf8').catch(() => null);
              if (digestOf(current) !== plan.digest) throw new PermissionError('conflict');
            }
            const written = [];
            try {
              for (const plan of plans) {
                await writeAtomic(plan.target.abs, plan.after);
                written.push(plan);
              }
            } catch (error) {
              // writeAtomic is atomic per file, so only the files already
              // written need restoring; report any that could not be restored.
              const rolledBack = [];
              const rollbackFailed = [];
              for (const plan of written.reverse()) {
                try {
                  if (plan.before == null) await rm(plan.target.abs, { force: true });
                  else await writeAtomic(plan.target.abs, plan.before);
                  rolledBack.push(plan.shown);
                } catch {
                  rollbackFailed.push(plan.shown);
                }
              }
              const code = codeOf(error);
              return { ok: false, code, message: messageOf(error, code), rolledBack, rollbackFailed };
            }
            const files = [];
            let historyWarning = null;
            for (const plan of plans) {
              let changeId = null;
              try {
                changeId = await recordChange(historyDir, {
                  rootId: plan.target.root.id,
                  path: plan.target.rel,
                  kind: plan.before == null ? 'create' : 'write',
                  before: plan.before,
                  after: plan.after,
                });
              } catch {
                historyWarning = '文件已写入，但撤销记录没有全部写入，部分修改无法撤销';
              }
              files.push({ path: plan.shown, bytes: Buffer.byteLength(plan.after), changeId });
            }
            return { ok: true, files, ...(historyWarning ? { historyWarning } : {}) };
          });
          if (!outcome.ok) {
            const suffix = outcome.rollbackFailed.length ? ` · ${outcome.rollbackFailed.length} 个文件未能回滚` : '';
            settle(id, 'apply_changes', label, 'error', `${outcome.message}${suffix}`);
            return toolResult({
              error: outcome.code,
              message: outcome.message,
              rolledBack: outcome.rolledBack,
              rollbackFailed: outcome.rollbackFailed,
            }, true);
          }
          settle(id, 'apply_changes', label, 'done', `${outcome.files.length} 个文件 · ${totalBytes} 字节`);
          return toolResult({
            files: outcome.files,
            ...(outcome.historyWarning ? { historyWarning: outcome.historyWarning } : {}),
          });
        } catch (error) {
          if (toolSignal?.aborted) throw error;
          const code = codeOf(error);
          settle(id, 'apply_changes', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
          return toolResult({ error: code, message: messageOf(error, code) }, true);
        }
      },
    },
  );

  if (writeRoots.length && historyDir) tools.push({
    name: 'undo_change',
    label: '撤销修改',
    description: 'Restore a file to the content it had before one earlier change, using its changeId. Works for writes, replacements, deletions and file moves. The user approves the restore in the app.',
    parameters: {
      type: 'object',
      properties: {
        changeId: { type: 'string', minLength: 1, maxLength: 80, description: 'changeId returned by write_file / replace_in_file / delete_path / move_path / apply_changes' },
      },
      required: ['changeId'],
      additionalProperties: false,
    },
    async execute(id, args, toolSignal) {
      const label = '撤销修改';
      announce(id, 'undo_change', label, args?.changeId);
      try {
        const changeId = String(args?.changeId ?? '');
        let found = null;
        for (const root of writeRoots) {
          const entry = (await readHistory(historyDir, root.id)).find(item => item.id === changeId);
          if (entry) { found = { root, entry }; break; }
        }
        if (!found) throw new PermissionError('not-found', '找不到这条修改记录，可能已被清理');
        // An entry that created the file or deleted it leaves the file possibly
        // absent, so its undo target may legitimately be missing right now.
        const mayBeMissing = found.entry.before == null || found.entry.after == null;
        const target = await resolveTarget(found.entry.path, { roots: [found.root], allowMissing: mayBeMissing });
        guardWrite(target);
        const current = await readFile(target.abs, 'utf8').catch(() => null);
        // Undoing an older change would silently discard newer edits, so the
        // file must still hold exactly what that change left behind.
        const drifted = found.entry.before == null
          ? current != null && current !== found.entry.after
          : current !== found.entry.after;
        if (drifted) {
          settle(id, 'undo_change', label, 'error', MESSAGES.conflict);
          return toolResult({ error: 'conflict', message: MESSAGES.conflict }, true);
        }
        const removeOnly = found.entry.before == null;
        if (removeOnly) {
          await authorize('write', target.root, `删除 ${target.root.name}/${target.rel}`, '这个文件是那次修改新建的，撤销会删除它', undefined, toolSignal);
        } else {
          const preview = previewOf('write', `${target.root.name}/${target.rel}`, current, found.entry.before);
          await authorize('write', target.root, `撤销修改 ${target.root.name}/${target.rel}`, '恢复到那次修改之前的内容', preview, toolSignal);
        }
        // The restore, its conflict check against the approved state, and the
        // history entry all run under one lock so nothing interleaves.
        const commit = await withPathLock(target.abs, async () => {
          await stillAllowed('write', target.root, toolSignal);
          const now = await readFile(target.abs, 'utf8').catch(() => null);
          if (removeOnly) {
            if (now != null && now !== found.entry.after) throw new PermissionError('conflict', MESSAGES.conflict);
            await rm(target.abs, { force: true });
          } else {
            if (now !== found.entry.after) throw new PermissionError('conflict', MESSAGES.conflict);
            await writeAtomic(target.abs, found.entry.before);
          }
          let historyWarning = null;
          try {
            await recordChange(historyDir, {
              rootId: target.root.id, path: target.rel, kind: 'undo', before: now, after: found.entry.before,
            });
          } catch {
            historyWarning = '已恢复文件，但撤销记录没有写入';
          }
          return { historyWarning };
        });
        settle(id, 'undo_change', label, 'done', `${target.root.name}/${target.rel} 已恢复`);
        return toolResult({ path: `${target.root.name}/${target.rel}`, restored: !removeOnly, ...commit });
      } catch (error) {
        if (toolSignal?.aborted) throw error;
        const code = codeOf(error);
        settle(id, 'undo_change', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
        return toolResult({ error: code, message: messageOf(error, code) }, true);
      }
    },
  });

  if (execRoots.length) tools.push({
    name: 'run_command',
    label: '运行命令',
    description: 'Run a command with the project folder as working directory. The user approves the command in the app. '
      + 'Two mutually exclusive ways to call it. `command` is a shell line (cmd.exe on Windows, /bin/sh elsewhere), at most 2000 characters; '
      + 'the shell parses quotes, spaces, $, %, ! and ^ before the program sees them. `argv` is [program, ...args] and runs with shell: false, '
      + 'so every argument reaches the program exactly as written: use it for inline scripts such as ["node", "-e", "console.log(1)"] and for any '
      + 'argument with quotes or spaces. cmd built-ins (dir, echo) and .cmd/.bat files have no executable, so they still need `command`. '
      + 'stdout/stderr are returned as UTF-8: output that is not valid UTF-8 is transcoded from the Windows console code page (GBK on a Chinese system) '
      + 'and the `encoding` field says which one was used. Each stream is capped at 8000 characters — the head and the tail are kept and the middle is '
      + 'replaced by a "…omitted…" marker with `truncated: true` — so redirect long output to a file and read the part you need with read_file. '
      + 'Use it for builds, tests and git operations that change state. The shell is NOT sandboxed: it runs with the user account\'s full rights, '
      + 'so it can touch files outside the project folder; only grant it to folders you trust the model with.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command line (at most 2000 characters). Mutually exclusive with argv.',
        },
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'Program and its arguments, run directly without a shell (shell: false). Mutually exclusive with command; '
            + 'at most 64 items and 16000 characters in total. '
            + 'Example: ["node", "-e", "console.log(\\"a b\\")"] — no shell quoting needed.',
        },
        shell: {
          type: 'boolean',
          description: 'Only meaningful with command. A shell line always runs through the shell, so `false` is rejected there; '
            + 'argv already runs without one.',
        },
        path: { type: 'string', maxLength: 400, description: 'Relative folder to use as working directory (default: first project folder)' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: LIMITS.commandMaxMs, description: 'Timeout in milliseconds (default 60000)' },
      },
      additionalProperties: false,
    },
    async execute(id, args, toolSignal) {
      const label = '运行命令';
      const shown = previewOfCommandArguments(args);
      announce(id, 'run_command', label, shown, { command: shown, output: [] });
      try {
        const spec = commandSpecOf(args);
        const target = args?.path
          ? await resolveTarget(args.path, { roots: execRoots })
          : { root: execRoots[0], rel: '', abs: execRoots[0].path };
        const cwd = `${target.root.name}${target.rel ? `/${target.rel}` : ''}`;
        announce(id, 'run_command', label, spec.display, { command: spec.display, cwd, output: [] });
        const timeoutMs = clamp(args?.timeoutMs ?? LIMITS.commandDefaultMs, 1000, LIMITS.commandMaxMs);
        const mode = spec.shell ? 'shell 行' : '直接执行（不经 shell）';
        await authorize('exec', target.root, spec.display.slice(0, 300),
          `工作目录：${cwd}\n方式：${mode}\n\n注意：命令在普通用户权限下运行，不受项目文件夹限制。`,
          undefined, toolSignal);
        // Revoking exec while the confirmation was open must still stop the shell.
        await stillAllowed('exec', target.root, toolSignal);
        const started = Date.now();
        const result = await runCommand(spec, target.abs, timeoutMs, toolSignal);
        const summary = result.timedOut ? '超时' : `退出码 ${result.exitCode ?? '—'}`;
        settle(id, 'run_command', label, result.exitCode === 0 ? 'done' : 'error', `${summary} · ${Date.now() - started} ms`, {
          command: spec.display, cwd, exitCode: result.exitCode ?? null, output: traceOutputLines(result),
        });
        return toolResult({ ...result, durationMs: Date.now() - started });
      } catch (error) {
        if (toolSignal?.aborted) throw error;
        const code = codeOf(error);
        settle(id, 'run_command', label, code === 'denied' || code === 'not-granted' ? 'denied' : 'error', messageOf(error, code));
        return toolResult({ error: code, message: messageOf(error, code) }, true);
      }
    },
  });

  return tools;
}

/** The timeline preview, computed before any argument is trusted. */
function previewOfCommandArguments(args) {
  if (Array.isArray(args?.argv)) {
    return formatCommandLine(args.argv.map(item => (typeof item === 'string' ? item : String(item))));
  }
  if (typeof args?.command === 'string') return args.command;
  return '';
}

/**
 * stdout/stderr as plain lines for the expandable trace row.
 * Bounded on purpose: the renderer keeps every emitted line in the session
 * snapshot, so a 8000-character stream must not become 8000 DOM nodes.
 */
function traceOutputLines(result) {
  const maxLines = 200;
  const maxLineChars = 400;
  const lines = [];
  for (const stream of [result?.stdout, result?.stderr]) {
    if (typeof stream !== 'string' || !stream) continue;
    for (const raw of stream.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.length > maxLineChars ? `${raw.slice(0, maxLineChars)}…` : raw;
      lines.push(line);
      if (lines.length >= maxLines) {
        lines.push(`…（输出过长，只显示前 ${maxLines} 行）`);
        return lines;
      }
    }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Quotes only what needs quoting, so the approval bar shows a copyable line. */
function formatCommandLine(argv) {
  return argv.map(part => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

/**
 * Reads the two accepted shapes into one spec. Every rejection names the fix:
 * a JSON Schema `maxLength` would only say "validation failed" and echo the
 * whole oversized command back at the model.
 */
function commandSpecOf(args) {
  if (args?.shell != null && typeof args.shell !== 'boolean') {
    throw new PermissionError('invalid-arguments', 'shell 只能是 true 或 false');
  }
  const hasCommand = typeof args?.command === 'string' && args.command.trim() !== '';
  const hasArgv = Array.isArray(args?.argv);
  if (hasCommand && hasArgv) {
    throw new PermissionError('invalid-arguments', 'command 与 argv 只能二选一：整行命令用 command，程序和参数用 argv');
  }
  if (!hasCommand && !hasArgv) {
    throw new PermissionError('invalid-arguments', '需要 command（shell 行）或 argv（[程序, ...参数]）其中之一');
  }
  if (hasArgv) {
    if (args.shell === true) {
      throw new PermissionError('invalid-arguments', 'argv 不经过 shell，请去掉 shell: true；需要经过 shell 时改用 command');
    }
    const argv = args.argv;
    if (!argv.length) throw new PermissionError('invalid-arguments', 'argv 至少要有程序本身');
    if (argv.length > LIMITS.commandArgs) {
      throw new PermissionError('invalid-arguments', `argv 最多 ${LIMITS.commandArgs} 项`);
    }
    let total = 0;
    for (const item of argv) {
      if (typeof item !== 'string') throw new PermissionError('invalid-arguments', 'argv 的每一项都必须是字符串');
      if (item.includes('\0')) throw new PermissionError('invalid-arguments', 'argv 里不能出现 NUL 字符');
      if (item.length > LIMITS.commandArgChars) {
        throw new PermissionError('command-too-long', `argv 的单个参数过长：${item.length} 个字符，上限 ${LIMITS.commandArgChars}`);
      }
      total += item.length;
    }
    if (!argv[0].trim()) throw new PermissionError('invalid-arguments', 'argv[0] 必须是要执行的程序名或路径');
    if (total > LIMITS.commandArgvChars) {
      throw new PermissionError('command-too-long',
        `argv 合计过长：${total} 个字符，上限 ${LIMITS.commandArgvChars}。请把脚本写成文件后执行，或拆成多条命令`);
    }
    return { shell: false, file: argv[0], args: argv.slice(1), display: formatCommandLine(argv) };
  }
  if (args.shell === false) {
    throw new PermissionError('invalid-arguments',
      'shell: false 需要配合 argv 使用，例如 {"argv": ["node", "-e", "console.log(1)"]}；command 本身就是交给 shell 的一整行');
  }
  const command = args.command.trim();
  if (command.includes('\0')) throw new PermissionError('invalid-arguments', '命令里不能出现 NUL 字符');
  if (command.length > LIMITS.commandChars) {
    throw new PermissionError('command-too-long',
      `命令过长：${command.length} 个字符，上限 ${LIMITS.commandChars} 个字符。请拆成多条命令，或用 argv 把脚本直接交给解释器（如 ["node", "-e", "…"]）`);
  }
  return { shell: true, command, display: command };
}

/** A spawn failure said in a way the model can act on. */
function spawnMessage(error, spec) {
  const name = spec.shell ? 'shell' : spec.file;
  const hint = process.platform === 'win32'
    ? 'Windows 上 .cmd/.bat 脚本和 cmd 内置命令（dir、echo、copy）没有可执行文件，不能直接启动，请改用 command 交给 shell'
    : '';
  const code = error?.code;
  if (code === 'ENOENT') return `找不到可执行文件：${name}${hint ? `。${hint}` : ''}`;
  if (code === 'EACCES' || code === 'EPERM') return `没有权限执行：${name}`;
  if (code === 'EINVAL' && !spec.shell) return `无法直接执行：${name}。${hint || '请改用 command'}`;
  return error?.message ? `无法启动 ${name}：${error.message}` : `无法启动 ${name}`;
}

/** WHATWG decoder labels for the Windows code pages a console pipe can use. */
const CODE_PAGE_LABELS = Object.freeze({
  // The OEM pages have no WHATWG label; windows-1252 keeps the ASCII half right.
  437: 'windows-1252',
  850: 'windows-1252',
  852: 'windows-1250',
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  20866: 'koi8-r',
  21866: 'koi8-u',
  54936: 'gb18030',
  65001: 'utf-8',
});

function decoderLabelForCodePage(codePage) {
  if (!Number.isInteger(codePage)) return null;
  const label = CODE_PAGE_LABELS[codePage];
  if (!label) return null;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return null;
  }
}

function resolveEncodingOverride(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return decoderLabelForCodePage(Number(text));
  try {
    new TextDecoder(text);
    return text;
  } catch {
    return null;
  }
}

/**
 * The console code page, asked once and cached. Only consulted when a stream is
 * not valid UTF-8, so a Node/Git/Python run never pays for it.
 */
let consoleEncodingPromise = null;
function consoleEncoding() {
  consoleEncodingPromise ??= detectConsoleEncoding();
  return consoleEncodingPromise;
}

async function detectConsoleEncoding() {
  const override = resolveEncodingOverride(process.env.MOVA_COMMAND_ENCODING);
  if (override) return override;
  if (process.platform !== 'win32') return 'utf-8';
  return decoderLabelForCodePage(await readConsoleCodePage()) ?? 'gbk';
}

function readConsoleCodePage() {
  return new Promise(resolvePromise => {
    let timer;
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    try {
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let text = '';
      // chcp's own wording is localized ("Active code page:" / "活动代码页:"); only the digits matter.
      child.stdout?.on('data', chunk => { text += chunk.toString('latin1'); });
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* already exited */ }
        finish(null);
      }, 1500);
      child.on('error', () => finish(null));
      child.on('close', () => {
        const match = /(\d{3,5})/.exec(text);
        finish(match ? Number(match[1]) : null);
      });
    } catch {
      finish(null);
    }
  });
}

/** One stream's bounded capture: the first bytes and the newest bytes, never the middle. */
function makeSink() {
  return { head: [], headBytes: 0, tail: [], tailBytes: 0, total: 0 };
}

function sinkWrite(sink, chunk) {
  sink.total += chunk.length;
  let rest = chunk;
  if (sink.headBytes < LIMITS.commandHeadBytes) {
    const take = Math.min(LIMITS.commandHeadBytes - sink.headBytes, rest.length);
    sink.head.push(rest.subarray(0, take));
    sink.headBytes += take;
    rest = rest.subarray(take);
  }
  if (!rest.length) return;
  sink.tail.push(rest);
  sink.tailBytes += rest.length;
  // A long build log is most useful at its end, so the tail keeps rolling.
  while (sink.tailBytes > LIMITS.commandTailBytes) {
    const first = sink.tail[0];
    const overflow = sink.tailBytes - LIMITS.commandTailBytes;
    if (first.length <= overflow) {
      sink.tail.shift();
      sink.tailBytes -= first.length;
    } else {
      sink.tail[0] = first.subarray(overflow);
      sink.tailBytes -= overflow;
    }
  }
}

function sinkBytes(sink) {
  return Buffer.concat([...sink.head, ...sink.tail]);
}

/**
 * Strict UTF-8 when the bytes are valid, else the console code page, else lossy
 * UTF-8. A dropped middle is marked in the text, because `truncated` alone does
 * not say what is missing.
 */
async function decodeSink(sink) {
  if (!sink.total) return { text: '', encoding: 'utf-8', droppedBytes: 0 };
  const head = Buffer.concat(sink.head, sink.headBytes);
  const tail = Buffer.concat(sink.tail, sink.tailBytes);
  const droppedBytes = Math.max(0, sink.total - head.length - tail.length);

  if (!droppedBytes) {
    // Contiguous capture: decode as one buffer so no seam can split a character.
    const all = sinkBytes(sink);
    const utf8 = decodeStrictUtf8(all);
    if (utf8 != null) return { text: utf8, encoding: 'utf-8', droppedBytes: 0 };
    const label = await consoleEncoding();
    return { text: decodeWith(label, all), encoding: label, droppedBytes: 0 };
  }

  // The seam lands on an arbitrary byte, so skip a partial character at the
  // start of the tail before asking whether the stream is UTF-8 at all.
  const headBytes = head;
  const tailBytes = trimLeadingContinuation(tail);
  const utf8Head = decodeStrictUtf8(headBytes);
  const utf8Tail = tailBytes.length ? decodeStrictUtf8(tailBytes) : '';
  const isUtf8 = utf8Head != null && utf8Tail != null;
  const label = isUtf8 ? 'utf-8' : await consoleEncoding();
  const headText = isUtf8 ? utf8Head : decodeWith(label, headBytes);
  const tailText = !tailBytes.length ? '' : (isUtf8 ? utf8Tail : decodeWith(label, tailBytes));
  return {
    text: `${headText}\n…（中间已省略 ${droppedBytes} 字节输出）…\n${tailText}`,
    encoding: label,
    droppedBytes,
  };
}

function decodeWith(label, bytes) {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** Last-resort decode for the impossible case: never throw, never hang the tool. */
function loseDecode(sink) {
  return sinkBytes(sink).toString('utf8');
}

function trimLeadingContinuation(bytes) {
  let start = 0;
  while (start < 3 && start < bytes.length && (bytes[start] & 0xC0) === 0x80) start += 1;
  return start ? bytes.subarray(start) : bytes;
}

function decodeStrictUtf8(bytes) {
  // A capped capture can end mid-character: drop that tail before concluding
  // the whole stream is some other encoding.
  for (let cut = 0; cut < 4 && cut < bytes.length; cut += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(cut ? bytes.subarray(0, bytes.length - cut) : bytes);
    } catch {
      // Not UTF-8, or too short after the cut; try the next candidate.
    }
  }
  return null;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

/** Substring that never starts or ends between the halves of a surrogate pair. */
function sliceChars(text, start, end) {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (to > 0 && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;
  return text.slice(from, to);
}

/** Char budget with the head and the tail kept; the middle is elided in the text. */
function clipOutput(text) {
  const limit = LIMITS.commandOutput;
  if (text.length <= limit) return { text, clipped: 0 };
  const head = sliceChars(text, 0, LIMITS.commandOutputHead);
  const tail = sliceChars(text, text.length - (limit - LIMITS.commandOutputHead), text.length);
  const cut = text.length - head.length - tail.length;
  return { text: `${head}\n…（中间已省略 ${cut} 字符）…\n${tail}`, clipped: cut };
}

/**
 * Runs one command (shell line or argv), caps captured output and kills the
 * whole tree on timeout.
 */
function runCommand(spec, cwd, timeoutMs, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      resolvePromise({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: true, encoding: 'utf-8' });
      return;
    }
    const stdio = /** @type {['ignore', 'pipe', 'pipe']} */ (['ignore', 'pipe', 'pipe']);
    let child;
    try {
      if (spec.shell) {
        const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
        // cmd /s strips the first and last quote of the line, so the line is
        // handed over wrapped in one extra pair. Without that, a shell line that
        // starts with a quote ("C:\Program Files\node.exe" -e "…") loses that
        // quote and cmd reports "C:\Program is not recognized".
        // windowsVerbatimArguments matters for the same reason on the other side:
        // Node would otherwise re-quote the argument with the C-runtime rule
        // "backslash escapes a quote", which cmd does not honour, and
        // `node -e "console.log(2+2)"` would reach node as a mangled script that
        // prints nothing and still exits 0.
        const line = process.platform === 'win32' ? `"${spec.command}"` : spec.command;
        const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', line] : ['-c', line];
        child = spawn(shell, shellArgs, {
          cwd,
          windowsHide: true,
          stdio,
          windowsVerbatimArguments: process.platform === 'win32',
        });
      } else {
        // shell: false is the point: nothing re-parses quotes on the way in.
        child = spawn(spec.file, spec.args, { cwd, windowsHide: true, stdio, shell: false });
      }
    } catch (error) {
      rejectPromise(new PermissionError('command-failed', spawnMessage(error, spec)));
      return;
    }
    const capture = { stdout: makeSink(), stderr: makeSink() };
    child.stdout?.on('data', chunk => sinkWrite(capture.stdout, chunk));
    child.stderr?.on('data', chunk => sinkWrite(capture.stderr, chunk));
    let settled = false;
    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      (async () => {
        // Decoding must never swallow the result: a surprise here falls back to
        // plain UTF-8 instead of leaving the promise pending.
        let out;
        let err;
        try {
          [out, err] = await Promise.all([decodeSink(capture.stdout), decodeSink(capture.stderr)]);
        } catch {
          out = { text: loseDecode(capture.stdout), encoding: 'utf-8', droppedBytes: 0 };
          err = { text: loseDecode(capture.stderr), encoding: 'utf-8', droppedBytes: 0 };
        }
        const stdout = clipOutput(out.text);
        const stderr = clipOutput(err.text);
        resolvePromise({
          ...payload,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: out.droppedBytes > 0 || err.droppedBytes > 0 || stdout.clipped > 0 || stderr.clipped > 0,
          encoding: out.encoding,
        });
      })();
    };
    const timer = setTimeout(() => { killTree(child); finish({ exitCode: null, timedOut: true }); }, timeoutMs);
    const onAbort = () => { killTree(child); finish({ exitCode: null, timedOut: true }); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      rejectPromise(new PermissionError('command-failed', spawnMessage(error, spec)));
    });
    child.on('close', code => finish({ exitCode: code, timedOut: false }));
  });
}

/** Kept for callers that pass a plain shell line. */
function runShell(command, cwd, timeoutMs, signal) {
  return runCommand({ shell: true, command, display: command }, cwd, timeoutMs, signal);
}

module.exports = { createProjectTools, runCommand, runShell, LIMITS, MESSAGES };
