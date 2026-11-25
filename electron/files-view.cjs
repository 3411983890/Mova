'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveInside } = require('./permissions.cjs');

// Read-only file/directory view for the right-side panel.
//
// Trust boundary: the renderer is untrusted and only ever names a registered
// root id plus a *relative* path. Every call re-reads the permission store and
// re-resolves the path through `resolveInside`, so revoking a grant takes effect
// immediately and absolute paths, `..`, drive letters, UNC shares, ADS
// (`a.txt:stream`) and device names never reach the filesystem from here.
const MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 1_500_000;
const MAX_INLINE_BYTES = 20 * 1024 * 1024;
const MAX_BINARY_PREVIEW = 2048;
const SNIFF_BYTES = 4096;
const STAT_CONCURRENCY = 64;
const HIDDEN_NAMES = Object.freeze(['.git']);

const IMAGE_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
});

const CODE_MIME = Object.freeze({
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.less': 'text/x-less',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.vue': 'text/x-vue',
  '.svelte': 'text/x-svelte',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.rb': 'text/x-ruby',
  '.php': 'text/x-php',
  '.sh': 'text/x-sh',
  '.ps1': 'text/x-powershell',
  '.bat': 'text/x-bat',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/x-ini',
  '.sql': 'application/sql',
  '.xml': 'application/xml',
});

const MARKDOWN_MIME = Object.freeze({
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.markdown': 'text/markdown',
});

const TEXT_MIME = Object.freeze({
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.mk': 'text/x-makefile',
  '.cmake': 'text/x-cmake',
});

/** Dotfiles with no extension that the plan renders as plain text (§3.4). */
const TEXT_BASENAMES = Object.freeze(['.gitignore', '.editorconfig', '.env']);

/**
 * Build-tool / project files whose names carry no extension. They are text by
 * definition, so they skip the content sniff.
 */
const TEXT_NAME_PREFIXES = Object.freeze([
  'license', 'licence', 'copying', 'makefile', 'gnumakefile', 'dockerfile',
  'readme', 'changelog', 'authors',
]);

function filesError(code, detail) {
  const error = new Error(detail || code);
  error.name = 'FilesViewError';
  error.code = code;
  return error;
}

function normalizeRelative(value) {
  return value.replace(/\\/g, '/').trim();
}

/**
 * 去掉 `#L12` / `:12` 这种行锚点。
 * Windows 盘符（`C:\…`）必须排除在「冒号 + 数字」之外，否则 `C:` 后面跟着数字会被切坏。
 */
function splitAnchor(value) {
  const text = String(value ?? '').trim();
  const hash = /#L(\d{1,7})$/i.exec(text);
  if (hash) return { path: text.slice(0, hash.index), line: Number(hash[1]) || 0 };
  const colon = /:(\d{1,7})$/.exec(text);
  if (colon && colon.index > 1) return { path: text.slice(0, colon.index), line: Number(colon[1]) || 0 };
  return { path: text, line: 0 };
}

/**
 * `target` 相对 `rootPath` 的路径；不在里面返回 null。
 * 只做字符串规范化比较，真正的越界由 `resolveInside` 再判一次（它解 realpath）。
 * Windows 大小写不敏感：比较用小写副本，切片仍用原始字符串的长度。
 */
function relativeTo(rootPath, target) {
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rootAbsolute = path.resolve(rootPath).replace(/[\\/]+$/, '');
  const targetAbsolute = path.resolve(target);
  if (fold(targetAbsolute) === fold(rootAbsolute)) return '';
  if (!fold(targetAbsolute).startsWith(`${fold(rootAbsolute)}${path.sep}`)) return null;
  return targetAbsolute.slice(rootAbsolute.length).replace(/^[\\/]+/, '');
}

function normalizeMaxBytes(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_INLINE_BYTES);
}

/**
 * Maps a file name to `{ kind, mime, ext }` from its extension alone.
 * `kind: 'binary'` here only means "no table entry": callers sniff the first
 * bytes to decide whether an unknown file is actually readable text.
 */
function describe(absolute) {
  const name = path.basename(absolute).toLowerCase();
  const ext = path.extname(name);
  if (MARKDOWN_MIME[ext]) return { kind: 'markdown', mime: MARKDOWN_MIME[ext], ext };
  if (CODE_MIME[ext]) return { kind: 'code', mime: CODE_MIME[ext], ext };
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext], ext };
  if (TEXT_MIME[ext]) return { kind: 'text', mime: TEXT_MIME[ext], ext };
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf', ext };
  const named = TEXT_BASENAMES.includes(name)
    || name.startsWith('.env.')
    || TEXT_NAME_PREFIXES.some(prefix => name.startsWith(prefix));
  if (named) return { kind: 'text', mime: 'text/plain', ext };
  return { kind: 'binary', mime: 'application/octet-stream', ext };
}

/** Reads at most `limit` bytes from the start of a file. */
async function readHead(absolute, limit) {
  const handle = await fs.open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function decodesStrictly(buffer, encoding) {
  try {
    new TextDecoder(encoding, { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Content sniffing for files no table entry covers (`LICENSE`, `Makefile`, …).
 * A file is readable text when the head holds no NUL byte and decodes as UTF-8
 * or GBK; a byte limit can split a multi-byte character, so the last few bytes
 * are trimmed before giving up.
 */
function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  if (!buffer.length) return true;
  const candidates = [buffer];
  for (let cut = 1; cut <= 3 && buffer.length > cut; cut += 1) {
    candidates.push(buffer.subarray(0, buffer.length - cut));
  }
  return candidates.some(candidate => decodesStrictly(candidate, 'utf-8') || decodesStrictly(candidate, 'gbk'));
}

/**
 * Resolves the renderer-facing kind for one regular file. Both `stat` and
 * `read` go through here, so the two can never disagree about a file.
 * Returns the sniffed head so `read` does not open the file twice.
 */
async function classify(absolute, descriptor, size) {
  if (descriptor.kind === 'image' || descriptor.kind === 'pdf') {
    return { kind: descriptor.kind, mime: descriptor.mime, head: null };
  }
  const textual = descriptor.kind !== 'binary';
  if (size === 0) {
    return { kind: textual ? descriptor.kind : 'text', mime: textual ? descriptor.mime : 'text/plain', head: Buffer.alloc(0) };
  }
  let head;
  try {
    head = await readHead(absolute, Math.min(size, SNIFF_BYTES));
  } catch (error) {
    throw filesError('read-failed', error.code || 'read failed');
  }
  if (textual) {
    // A NUL byte means the extension lied; keep stat and read in agreement.
    if (!head.includes(0)) return { kind: descriptor.kind, mime: descriptor.mime, head };
    return { kind: 'binary', mime: 'application/octet-stream', head };
  }
  if (looksLikeText(head)) return { kind: 'text', mime: 'text/plain', head };
  return { kind: 'binary', mime: 'application/octet-stream', head };
}

/**
 * Decodes UTF-8 strictly, falling back to GBK (Windows Chinese text) when the
 * bytes are not valid UTF-8. When the read was cut at a byte limit, a trailing
 * partial multi-byte sequence is trimmed first so truncation never looks like a
 * different encoding.
 */
function decodeText(buffer, truncated) {
  const candidates = [buffer];
  if (truncated) {
    for (let cut = 1; cut <= 3; cut += 1) {
      if (buffer.length > cut) candidates.push(buffer.subarray(0, buffer.length - cut));
    }
  }
  for (const candidate of candidates) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(candidate), encoding: 'utf-8' };
    } catch { /* Try the next shorter prefix, then fall back to GBK. */ }
  }
  try {
    return { text: new TextDecoder('gbk').decode(buffer), encoding: 'gbk' };
  } catch {
    return { text: buffer.toString('latin1'), encoding: 'latin1' };
  }
}

function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (const char of text) if (char === '\n') lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Runs `mapper` over `items` with bounded concurrency, keeping the input order. */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function createFilesView({ permissions, shell } = {}) {
  if (!permissions || typeof permissions.get !== 'function') throw new TypeError('permissions.get is required');
  const shellOf = () => (typeof shell === 'function' ? shell() : shell);

  /**
   * Permission check, then path resolution. Both steps run on every call.
   * `''` means the root folder itself; the renderer controls no part of it.
   */
  async function authorize(input) {
    if (!input || typeof input !== 'object') throw filesError('request', 'input is required');
    if (typeof input.path !== 'string') throw filesError('invalid-path', 'path must be a string');
    let root;
    try {
      root = await permissions.get(input.rootId);
    } catch {
      throw filesError('store-error', 'permission store unavailable');
    }
    if (!root || typeof root.path !== 'string') throw filesError('not-registered', 'unknown root');
    if (root.capabilities?.read !== true) throw filesError('not-granted', 'read is not granted for this root');
    const relative = normalizeRelative(input.path);
    const absolute = relative ? await resolveInside(root.path, input.path) : path.resolve(root.path);
    return { absolute, relative };
  }

  async function list(input = {}) {
    const { absolute, relative } = await authorize(input);
    let dirents;
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') throw filesError('not-found', 'folder not found');
      if (error.code === 'ENOTDIR') throw filesError('not-a-directory', 'not a folder');
      throw filesError('read-failed', error.code || 'readdir failed');
    }
    let skippedLinks = 0;
    const visible = [];
    for (const dirent of dirents) {
      if (HIDDEN_NAMES.includes(dirent.name)) continue;
      // Links are listed as skipped, never followed: a junction inside the root
      // could otherwise point anywhere on the machine.
      if (dirent.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      visible.push({ name: dirent.name, type: dirent.isDirectory() ? 'dir' : 'file' });
    }
    visible.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    const total = visible.length;
    const page = visible.slice(0, MAX_ENTRIES);
    const entries = await mapLimit(page, STAT_CONCURRENCY, async entry => {
      if (entry.type === 'dir') return { name: entry.name, type: 'dir', size: 0, mtime: null };
      try {
        const info = await fs.stat(path.join(absolute, entry.name));
        return { name: entry.name, type: 'file', size: info.size, mtime: Math.round(info.mtimeMs) };
      } catch {
        // A file that vanished between readdir and stat must not fail the page.
        return { name: entry.name, type: 'file', size: 0, mtime: null };
      }
    });
    return { path: relative, entries, truncated: total > MAX_ENTRIES, skippedLinks, total };
  }

  async function stat(input = {}) {
    const { absolute } = await authorize(input);
    let info;
    try {
      info = await fs.stat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') throw filesError('not-found', 'file not found');
      throw filesError('stat-failed', error.code || 'stat failed');
    }
    const mtime = Math.round(info.mtimeMs);
    if (info.isDirectory()) return { type: 'dir', size: 0, mtime, ext: '', mime: '', kind: 'dir' };
    const descriptor = describe(absolute);
    // Unknown extensions (LICENSE, Makefile, …) are sniffed, never assumed binary.
    const classified = await classify(absolute, descriptor, info.size);
    return { type: 'file', size: info.size, mtime, ext: descriptor.ext, mime: classified.mime, kind: classified.kind };
  }

  async function read(input = {}) {
    const { absolute } = await authorize(input);
    let info;
    try {
      info = await fs.stat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') throw filesError('not-found', 'file not found');
      throw filesError('stat-failed', error.code || 'stat failed');
    }
    if (!info.isFile()) throw filesError('not-a-file', 'not a regular file');
    const size = info.size;
    const descriptor = describe(absolute);
    // Same decision as `stat`, from the same head bytes.
    const { kind, mime, head } = await classify(absolute, descriptor, size);

    if (kind === 'image' || kind === 'pdf') {
      if (size > MAX_INLINE_BYTES) throw filesError('too-large', 'file is larger than 20MB');
      let buffer;
      try {
        buffer = await fs.readFile(absolute);
      } catch (error) {
        throw filesError('read-failed', error.code || 'read failed');
      }
      return { kind, mime, base64: buffer.toString('base64'), bytes: buffer.length, truncated: false };
    }

    if (kind === 'binary') {
      return {
        kind: 'binary',
        mime,
        base64: head.subarray(0, MAX_BINARY_PREVIEW).toString('base64'),
        bytes: size,
        truncated: size > MAX_BINARY_PREVIEW,
      };
    }

    const limit = normalizeMaxBytes(input.maxBytes);
    const want = Math.min(limit, size);
    let buffer;
    if (size === 0) {
      buffer = Buffer.alloc(0);
    } else if (head.length >= want) {
      buffer = head.subarray(0, want);
    } else {
      try {
        buffer = await readHead(absolute, want);
      } catch (error) {
        throw filesError('read-failed', error.code || 'read failed');
      }
    }
    const truncated = size > buffer.length;
    if (buffer.includes(0)) {
      return {
        kind: 'binary',
        mime: 'application/octet-stream',
        base64: buffer.subarray(0, MAX_BINARY_PREVIEW).toString('base64'),
        bytes: size,
        truncated: size > MAX_BINARY_PREVIEW,
      };
    }
    const { text, encoding } = decodeText(buffer, truncated);
    return { kind: 'text', mime, encoding, text, bytes: size, truncated, lines: countLines(text) };
  }

  async function openDir(input = {}) {
    const { absolute } = await authorize(input);
    let info;
    try {
      info = await fs.stat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') throw filesError('not-found', 'folder not found');
      throw filesError('stat-failed', error.code || 'stat failed');
    }
    if (!info.isDirectory()) throw filesError('not-a-directory', 'not a folder');
    const target = shellOf();
    if (!target || typeof target.openPath !== 'function') throw filesError('open-failed', 'shell is unavailable');
    let failure;
    try {
      failure = await target.openPath(absolute);
    } catch (error) {
      throw filesError('open-failed', error?.message || 'openPath failed');
    }
    if (failure) throw filesError('open-failed', String(failure));
    return { opened: true };
  }

  /** 所有可读的已登记根。只用来做「这个路径落在哪个根里」的判定，不暴露给渲染层。 */
  async function readableRoots() {
    let state;
    try {
      state = await permissions.list();
    } catch {
      throw filesError('store-error', 'permission store unavailable');
    }
    const list = Array.isArray(state?.roots) ? state.roots : [];
    return list.filter(root => root && typeof root.path === 'string' && root.capabilities?.read === true);
  }

  /**
   * 把一个原始路径落到某个已登记根上：回答「它在哪个根、相对路径是什么」。
   *
   * 为什么要它：模型给出的路径经常是绝对的（Gemini 的 CLI 工具尤其如此），而渲染层只会说
   * 「rootId + 相对路径」。以前绝对路径在渲染层就被判死（`normalizePath` 拒绝盘符），
   * 所以「模型贴了路径却点不开」。归属判定放在主进程，因为这里才有 realpath 与根清单。
   *
   * @param {{raw?: string, path?: string}} input
   * @returns {Promise<{rootId: string, path: string, line?: number, type: 'file'|'dir'}>}
   */
  async function locate(input = {}) {
    const { path: rawPath, line } = splitAnchor(
      typeof input?.raw === 'string' ? input.raw : typeof input?.path === 'string' ? input.path : '',
    );
    if (!rawPath) throw filesError('invalid-path', 'path is required');
    const text = rawPath.replace(/^file:\/\/\//i, '').replace(/\//g, path.sep);
    const roots = await readableRoots();
    if (!roots.length) throw filesError('not-registered', 'no readable folder is registered');

    const candidates = [];
    if (path.isAbsolute(text)) {
      // 绝对路径：只有落在某个已登记根里才允许，绝不凭绝对路径直接读磁盘。
      for (const root of roots) {
        const relative = relativeTo(root.path, text);
        // `relative === ''` 就是根目录本身：允许（侧栏据此把根当目录打开），越界才是 null。
        if (relative !== null) candidates.push({ root, relative });
      }
    } else {
      // 相对路径：每个根都试一遍（多根同名文件按登记顺序取第一个真实存在的）。
      for (const root of roots) candidates.push({ root, relative: text });
    }

    for (const { root, relative } of candidates) {
      let absolute;
      try {
        // 空相对路径 = 根目录本身：resolveInside 只接受「根内的一层路径」，这里直接用它自己。
        absolute = relative ? await resolveInside(root.path, relative) : path.resolve(root.path);
      } catch {
        continue;
      }
      const info = await fs.stat(absolute).catch(() => null);
      if (!info) continue;
      return {
        rootId: root.id,
        path: normalizeRelative(relative),
        ...(line > 0 ? { line } : {}),
        type: info.isDirectory() ? 'dir' : 'file',
      };
    }
    throw filesError('not-found', 'not inside a registered folder');
  }

  /**
   * 用系统默认程序打开一个文件（等同在文件管理器里双击）。
   *
   * 目标可以是 `{rootId, path}`（渲染层已经知道归属），也可以是 `{raw}` 或 `{path}` 这样的原始路径
   * （由 `locate()` 找归属）。打开前仍然过 `authorize()`：能力位被撤掉的那一刻起就打不开。
   */
  async function openFile(input = {}) {
    const located = typeof input?.rootId === 'string' && input.rootId && typeof input?.path === 'string'
      ? { rootId: input.rootId, path: input.path }
      : await locate(input);
    const { absolute } = await authorize({ rootId: located.rootId, path: located.path });
    let info;
    try {
      info = await fs.stat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') throw filesError('not-found', 'file not found');
      throw filesError('stat-failed', error.code || 'stat failed');
    }
    if (!info.isFile()) throw filesError('not-a-file', 'not a regular file');
    const target = shellOf();
    if (!target || typeof target.openPath !== 'function') throw filesError('open-failed', 'shell is unavailable');
    let failure;
    try {
      failure = await target.openPath(absolute);
    } catch (error) {
      throw filesError('open-failed', error?.message || 'openPath failed');
    }
    if (failure) throw filesError('open-failed', String(failure));
    return { opened: true, rootId: located.rootId, path: located.path };
  }

  return { list, stat, read, openDir, locate, openFile };
}

module.exports = {
  createFilesView,
  MAX_ENTRIES,
  DEFAULT_MAX_BYTES,
  MAX_INLINE_BYTES,
  MAX_BINARY_PREVIEW,
};
