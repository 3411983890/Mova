// 右侧面板的位置模型。
//
// 这里只放纯函数：不碰 DOM、不读 window，因此 `tests/viewer-utils.test.mjs`
// 可以直接在 Node 里导入。所有导航（链接、地址栏、三个点、目录双击、面包屑）
// 都必须先变成一个 Location，再由 side-browser 统一 push + render（方案 §4.3）。
//
// Location:
//   { kind: 'web', url }
//   { kind: 'file', rootId, path, line? }
//   { kind: 'dir',  rootId, path }
// 路径永远是相对 root 的 POSIX 形式，root 本身是 `''`（不是 `'.'`）。

export const WEB = 'web';
export const FILE = 'file';
export const DIR = 'dir';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[a-z]:/i;

const MARKDOWN_EXT = new Set(['.md', '.mdx', '.markdown']);
const TEXT_EXT = new Set(['.txt', '.log']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']);
const CODE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.jsonc',
  '.css', '.scss', '.less', '.html', '.htm', '.vue', '.svelte',
  '.py', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx',
  '.cs', '.rb', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.yml', '.yaml', '.toml', '.ini', '.sql', '.xml',
]);
const TEXT_BASENAMES = new Set(['.gitignore', '.editorconfig', '.env']);

/**
 * Shiki 首批内置语言（方案 §3.6，按 IIFE 体积预算裁剪）。
 * `id` 必须是 highlighter 里已经注册的 grammar 名。
 * `.cpp` 没有内置（grammar 单体 534KB），退回 C 的高亮。
 */
const LANGUAGE_BY_EXT = Object.freeze({
  '.js': { id: 'javascript', label: 'js' },
  '.jsx': { id: 'javascript', label: 'jsx' },
  '.mjs': { id: 'javascript', label: 'mjs' },
  '.cjs': { id: 'javascript', label: 'cjs' },
  '.ts': { id: 'tsx', label: 'ts' },
  '.tsx': { id: 'tsx', label: 'tsx' },
  '.json': { id: 'json', label: 'json' },
  '.jsonc': { id: 'json', label: 'jsonc' },
  '.css': { id: 'css', label: 'css' },
  '.scss': { id: 'css', label: 'scss' },
  '.less': { id: 'css', label: 'less' },
  '.html': { id: 'html', label: 'html' },
  '.htm': { id: 'html', label: 'html' },
  '.vue': { id: 'html', label: 'vue' },
  '.svelte': { id: 'html', label: 'svelte' },
  '.py': { id: 'python', label: 'python' },
  '.rs': { id: 'rust', label: 'rust' },
  '.go': { id: 'go', label: 'go' },
  '.java': { id: 'java', label: 'java' },
  '.c': { id: 'c', label: 'c' },
  '.h': { id: 'c', label: 'c' },
  '.cpp': { id: 'c', label: 'cpp' },
  '.hpp': { id: 'c', label: 'cpp' },
  '.cc': { id: 'c', label: 'cpp' },
  '.cxx': { id: 'c', label: 'cpp' },
  '.hxx': { id: 'c', label: 'cpp' },
  '.sh': { id: 'shellscript', label: 'sh' },
  '.bash': { id: 'shellscript', label: 'bash' },
  '.zsh': { id: 'shellscript', label: 'zsh' },
  '.yml': { id: 'yaml', label: 'yml' },
  '.yaml': { id: 'yaml', label: 'yaml' },
  '.sql': { id: 'sql', label: 'sql' },
  '.xml': { id: 'xml', label: 'xml' },
});

/** 面板顶部的类型图标（Keyline 图标名，见 icons.js）。 */
const ICON_BY_KIND = Object.freeze({ web: 'globe', file: 'file', dir: 'folder' });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把任意输入整理成安全相对路径。
 * 拒绝绝对路径、盘符、UNC、`..`、控制字符与 `:`（ADS / 设备名）。
 * 合法结果可能是 `''`（root 本身）；非法输入返回 `null`。
 */
export function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\\/g, '/');
  if (CONTROL_CHARS.test(value)) return null;
  if (!value) return '';
  if (DRIVE_PREFIX.test(value) || value.startsWith('/') || value.startsWith('//')) return null;
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    if (part.includes(':')) return null;
    parts.push(part);
  }
  return parts.join('/');
}

/**
 * 相对某个目录解析链接（Markdown 里的 `./x`、`../y`）。
 * 越出 root 的 `..` 返回 `null`。
 */
export function joinPath(base, relative) {
  if (typeof relative !== 'string' || CONTROL_CHARS.test(relative)) return null;
  const baseParts = (normalizePath(typeof base === 'string' ? base : '') ?? '').split('/').filter(Boolean);
  const out = [...baseParts];
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    if (DRIVE_PREFIX.test(part) || part.includes(':')) return null;
    out.push(part);
  }
  return out.join('/');
}

/** 文件所在目录（root 下的顶层文件返回 `''`）。 */
export function directoryOf(path) {
  const normalized = normalizePath(path);
  if (!normalized) return normalized === '' ? '' : null;
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

/** 当前路径的上一级目录；root 本身返回 `null`。 */
export function parentPath(path) {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  const dir = directoryOf(normalized);
  return dir === normalized ? null : dir;
}

export function pathSegments(path) {
  const normalized = normalizePath(path);
  return normalized ? normalized.split('/').filter(Boolean) : [];
}

/** 扩展名（小写，含点）；`.env` 这类 dotfile 返回 `''`。 */
export function extensionOf(name) {
  if (typeof name !== 'string') return '';
  const base = name.trim().toLowerCase();
  const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  const file = slash >= 0 ? base.slice(slash + 1) : base;
  const index = file.lastIndexOf('.');
  return index <= 0 ? '' : file.slice(index);
}

export function baseNameOf(path) {
  if (typeof path !== 'string') return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** `a.md#L12` / `a.md#L12-L20` / `src/app.js:42` → `{ path, line }`。 */
export function splitAnchor(value) {
  if (typeof value !== 'string') return { path: '', line: 0 };
  const hash = /#L(\d+)(?:-L?\d+)?$/i.exec(value);
  if (hash) return { path: value.slice(0, hash.index), line: Number(hash[1]) };
  if (!value.includes('://')) {
    const colon = /:(\d+)$/.exec(value);
    if (colon && !DRIVE_PREFIX.test(value)) return { path: value.slice(0, colon.index), line: Number(colon[1]) };
  }
  return { path: value, line: 0 };
}

/**
 * 规范化 URL：允许 `https://x`、`http://x`、`file:///C:/…`（本地预览）以及裸主机名（补 https://）；
 * 其他协议（`mailto:`、`javascript:`、`data:`、`blob:` …）一律拒绝。
 *
 * `file:` 只在**显式**写成 `file://` 时接受：裸路径（`C:\x\a.html`）仍然走文件查看器看源码，
 * 不会被偷偷变成网页渲染。真正的安全判定在主进程（只允许已登记项目根内的白名单类型），
 * 这里只做语法与「不许 UNC/网络共享」这一层。
 */
export function normalizeUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || CONTROL_CHARS.test(raw)) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'file:') return null;
      // `file://server/share` 是 UNC 路径：跨机器读取，一律不认。
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return null;
      if (!url.pathname || url.pathname === '/' || url.pathname === '//') return null;
      return url.href;
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  // `localhost:3000` / `127.0.0.1:8080` 看起来像协议，其实是主机+端口。
  if (hasScheme && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(raw)) return null;
  if (/\s/.test(raw)) return null;
  try {
    const url = new URL(`https://${raw}`);
    const host = url.hostname || '';
    // 裸主机名至少要像个域名；`localhost` 与 IP 是开发者常用的例外。
    if (!host) return null;
    if (!host.includes('.') && host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** 任意输入 → 规范 Location（或 `null`）。 */
export function normalizeLocation(input) {
  if (typeof input === 'string') {
    const url = normalizeUrl(input);
    if (url) return { kind: WEB, url };
    const anchor = splitAnchor(input);
    const path = normalizePath(anchor.path);
    if (path === null) return null;
    const location = { kind: FILE, rootId: '', path };
    return anchor.line ? { ...location, line: anchor.line } : location;
  }
  if (!isPlainObject(input)) return null;
  const kind = input.kind === 'url' ? WEB : input.kind;
  if (kind === WEB) {
    const url = normalizeUrl(input.url ?? '');
    return url ? { kind: WEB, url } : null;
  }
  if (kind !== FILE && kind !== DIR) return null;
  if (typeof input.rootId !== 'string' || !input.rootId) return null;
  const anchor = splitAnchor(typeof input.path === 'string' ? input.path : '');
  const path = normalizePath(anchor.path);
  if (path === null) return null;
  const location = { kind, rootId: input.rootId, path };
  const line = Number(input.line) > 0 ? Math.floor(Number(input.line)) : anchor.line;
  if (kind === FILE && line) location.line = line;
  return location;
}

export function sameLocation(a, b) {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === WEB) return a.url === b.url;
  return a.rootId === b.rootId && a.path === b.path && (a.line || 0) === (b.line || 0);
}

/** 位置类型 → 顶部图标名。 */
export function kindIcon(kind) {
  return ICON_BY_KIND[kind] || ICON_BY_KIND.file;
}

/** 文件扩展名 → 渲染器类别（与主进程 `stat().kind` 对齐）。 */
export function kindOfFile(name) {
  const base = baseNameOf(String(name ?? '')).toLowerCase();
  if (!base) return 'binary';
  if (TEXT_BASENAMES.has(base) || base.startsWith('.env.')) return 'text';
  const ext = extensionOf(base);
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (CODE_EXT.has(ext)) return 'code';
  if (TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'binary';
}

/** 行图标：目录在前（方案 §3.7 的行结构）。 */
export function entryIcon(entry) {
  if (!entry || entry.type === 'dir') return 'folder';
  const kind = kindOfFile(entry.name);
  if (kind === 'markdown' || kind === 'text') return 'file-text';
  if (kind === 'code') return 'file-code';
  if (kind === 'image') return 'file-image';
  return 'file';
}

/** 文件扩展名 → `{ id, label }`；未内置高亮的语言返回 `null`。 */
export function codeLanguageOf(name) {
  const ext = extensionOf(baseNameOf(String(name ?? '')));
  return LANGUAGE_BY_EXT[ext] ? { ...LANGUAGE_BY_EXT[ext] } : null;
}

export function languageLabelOf(name) {
  return codeLanguageOf(name)?.label || extensionOf(baseNameOf(String(name ?? ''))).slice(1) || 'text';
}

export function rootNameOf(loc, roots = []) {
  if (!loc || loc.kind === WEB) return '';
  const root = (Array.isArray(roots) ? roots : []).find(item => item && item.id === loc.rootId);
  return root?.name || loc.rootId || '项目';
}

/** 显示用标签（标签页 title、tooltip、toast）。 */
export function labelOf(loc, options = {}) {
  if (!loc) return '';
  if (loc.kind === WEB) return loc.url;
  const rootName = options.rootName || rootNameOf(loc, options.roots);
  return loc.path ? `${rootName}/${loc.path}` : rootName;
}

/** 地址栏编辑态的输入值（相对路径，root 用 `''`）。 */
export function editValueOf(loc) {
  if (!loc || loc.kind === WEB) return loc?.url || '';
  const anchor = loc.line ? `#L${loc.line}` : '';
  return `${loc.path || ''}${anchor}`;
}

/**
 * 面包屑分段。除最后一段外每段都可点回目录（方案 §3.3）。
 * 返回 `[{ label, loc, current }]`，最后一段 `current === true`。
 */
export function breadcrumbOf(loc, options = {}) {
  if (!loc) return [];
  if (loc.kind === WEB) {
    let label = loc.url;
    try { label = new URL(loc.url).host || loc.url; } catch { /* keep raw url */ }
    return [{ label, loc: { ...loc }, current: true }];
  }
  const rootId = loc.rootId;
  const rootName = options.rootName || rootNameOf(loc, options.roots);
  const parts = pathSegments(loc.path);
  const dirParts = loc.kind === FILE ? parts.slice(0, Math.max(0, parts.length - 1)) : parts;
  const crumbs = [{ label: rootName, loc: { kind: DIR, rootId, path: '' } }];
  dirParts.forEach((part, index) => {
    crumbs.push({ label: part, loc: { kind: DIR, rootId, path: parts.slice(0, index + 1).join('/') } });
  });
  if (loc.kind === FILE) {
    const file = { kind: FILE, rootId, path: loc.path };
    if (loc.line) file.line = loc.line;
    crumbs.push({ label: parts[parts.length - 1] || baseNameOf(loc.path) || '', loc: file });
  }
  return crumbs.map((crumb, index) => ({ ...crumb, current: index === crumbs.length - 1 }));
}

/**
 * 窄宽折叠：根名与末段始终保留，从左侧开始把中间段收进 `…`。
 * `budget` 是可用字符数（面板 320px 时约 26–30）。
 */
export function foldBreadcrumb(crumbs, budget = 30) {
  const list = Array.isArray(crumbs) ? crumbs.filter(Boolean) : [];
  const asVisible = () => list.map(crumb => ({ type: 'crumb', crumb }));
  if (list.length <= 2) return { visible: asVisible(), hidden: [] };
  const widthOf = crumb => String(crumb?.label ?? '').length + 3;
  const total = list.reduce((sum, crumb) => sum + widthOf(crumb), 0);
  if (total <= budget) return { visible: asVisible(), hidden: [] };
  const head = list[0];
  const tail = list[list.length - 1];
  const middle = list.slice(1, -1);
  let used = widthOf(head) + widthOf(tail) + 2;
  const keep = [];
  for (let index = middle.length - 1; index >= 0; index -= 1) {
    const width = widthOf(middle[index]);
    if (used + width > budget) break;
    used += width;
    keep.unshift(middle[index]);
  }
  const hidden = middle.slice(0, middle.length - keep.length);
  const visible = [{ type: 'crumb', crumb: head }];
  if (hidden.length) visible.push({ type: 'ellipsis', hidden });
  for (const crumb of keep) visible.push({ type: 'crumb', crumb });
  visible.push({ type: 'crumb', crumb: tail });
  return { visible, hidden };
}

/** 中间省略的短名（目录行 / 面包屑 tooltip）。 */
export function truncateMiddle(value, max = 24) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** 尾部省略（单行文本）。 */
export function truncateText(value, max = 60) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function pad(number) {
  return String(number).padStart(2, '0');
}

/** 目录行的“修改时间”：今天只显示时分，今年显示月日，跨年显示年月日。 */
export function formatTime(mtime, now = Date.now()) {
  const value = Number(mtime);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === today.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 目录行的右侧弱化元信息；目录（size=0 / mtime=null）不显示时间。 */
export function entryMeta(entry) {
  if (!entry) return '';
  if (entry.type === 'dir') return '';
  const size = formatSize(entry.size);
  const time = formatTime(entry.mtime);
  return time ? `${size} · ${time}` : size;
}

/** 错误码 → 人话（IPC 只回码，文案在渲染层）。 */
export function describeFilesError(code, fallback = '') {
  switch (code) {
    case 'not-found': return '文件或文件夹不存在，可能已被移动或删除';
    case 'not-a-file': return '这个位置不是文件';
    case 'not-a-directory': return '这个位置不是文件夹';
    case 'not-registered': return '这个文件夹没有登记到 Mova';
    case 'not-granted':
    case 'forbidden':
    case 'no-read': return '没有读取权限，请先在设置里授权这个文件夹';
    case 'too-large': return '文件超过 20MB，无法在面板内预览';
    case 'invalid-path': return '路径不合法，只能打开已授权文件夹内的文件';
    case 'open-failed': return '系统无法打开这个位置';
    default: return fallback || '读取失败';
  }
}

/**
 * 每个标签一份的位置栈。网页仍然优先 webview 自身历史
 * （由 side-browser 判断），这里是文件/目录以及回退路径的唯一真源。
 */
export function createLocationHistory(initial = []) {
  const stack = [];
  let cursor = -1;
  const history = {
    get index() { return cursor; },
    list() { return stack.slice(); },
    current() { return cursor >= 0 ? stack[cursor] : null; },
    canBack() { return cursor > 0; },
    canForward() { return cursor >= 0 && cursor < stack.length - 1; },
    push(input) {
      const next = normalizeLocation(input);
      if (!next) return null;
      stack.splice(cursor + 1);
      stack.push(next);
      cursor = stack.length - 1;
      return next;
    },
    replace(input) {
      const next = normalizeLocation(input);
      if (!next) return null;
      if (cursor < 0) {
        stack.push(next);
        cursor = 0;
      } else {
        stack[cursor] = next;
      }
      return next;
    },
    back() {
      if (!history.canBack()) return null;
      cursor -= 1;
      return stack[cursor];
    },
    forward() {
      if (!history.canForward()) return null;
      cursor += 1;
      return stack[cursor];
    },
    clear() {
      stack.length = 0;
      cursor = -1;
    },
    restore(locations = [], index = -1) {
      stack.length = 0;
      for (const item of locations) {
        const next = normalizeLocation(item);
        if (next) stack.push(next);
      }
      cursor = Math.min(Math.max(index, stack.length ? 0 : -1), stack.length - 1);
      return history.current();
    },
  };
  for (const loc of initial) history.push(loc);
  return history;
}
