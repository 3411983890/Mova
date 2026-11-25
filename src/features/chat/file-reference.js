// File reference syntax shared by chat Markdown and the right-side viewer.
//
// Two forms are supported:
//   [[file:src/app.tsx#L12]]   explicit, safe inside prose
//   `src/app.tsx:12`           inline code that looks like a project path
//
// Both become a link that opens the right panel at the file (and line). The
// helpers here are pure so the syntax can be unit-tested without React.

const EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'scss', 'less',
  'html', 'htm', 'vue', 'svelte', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h',
  'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'toml',
  'ini', 'sql', 'xml', 'md', 'mdx', 'markdown', 'txt', 'log', 'env', 'svg',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'pdf', 'lock',
]);

const SCHEME = 'mova-file:';
const MAX_PATH = 300;

/** Split `src/app.tsx#L12` / `src/app.tsx:12` into `{ path, line }`. */
export function splitFileAnchor(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { path: '', line: 0 };
  let path = raw;
  let line = 0;
  const hash = /[#]L(\d{1,7})$/i.exec(path);
  if (hash) {
    path = path.slice(0, hash.index);
    line = Number(hash[1]) || 0;
  } else {
    const colon = /:(\d{1,7})$/.exec(path);
    if (colon) {
      path = path.slice(0, colon.index);
      line = Number(colon[1]) || 0;
    }
  }
  return { path, line };
}

/**
 * True for something that can only be a project-relative file path:
 * no scheme, no absolute root, no `..`, no whitespace, a known extension.
 */
export function isFilePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_PATH) return false;
  if (/\s/.test(raw)) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\|~)/i.test(raw)) return false;
  const { path } = splitFileAnchor(raw);
  if (!path || path.split(/[\\/]/).includes('..')) return false;
  if (!/^[\w.@+-]+(?:[/\\][\w.@+-]+)*$/.test(path)) return false;
  const name = path.split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** `src/app.tsx` + 12 → `src/app.tsx#L12`. */
export function withFileAnchor(path, line = 0) {
  const clean = String(path ?? '').replace(/^\.\//, '');
  return line > 0 ? `${clean}#L${Math.trunc(line)}` : clean;
}

/** Link target used between expandFileRefs() and the `a` renderer. */
export function fileRefHref(value) {
  const { path, line } = splitFileAnchor(value);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${SCHEME}${encoded}${line > 0 ? `#L${line}` : ''}`;
}

/** Reverse of fileRefHref(); returns null for other schemes. */
export function parseFileRefHref(href) {
  if (typeof href !== 'string' || !href.startsWith(SCHEME)) return null;
  const rest = href.slice(SCHEME.length);
  const [encoded, hash] = rest.split('#');
  let path;
  try {
    path = encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  if (!path) return null;
  const line = hash ? Number(/^L(\d{1,7})$/i.exec(hash)?.[1]) || 0 : 0;
  return { path, line };
}

const FILE_REF = /\[\[\s*file:\s*([^\]\n]{1,300})\s*\]\]/gi;
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

/**
 * Replace `[[file:…]]` with a Markdown link, leaving fenced and inline code
 * untouched. Everything else is passed through verbatim.
 */
export function expandFileRefs(text) {
  const value = String(text ?? '');
  if (!value.includes('[[file:')) return value;
  return value
    .split(CODE_SEGMENT)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(FILE_REF, (match, raw) => {
        const { path, line } = splitFileAnchor(raw);
        if (!path) return match;
        return `[${withFileAnchor(path, line)}](${fileRefHref(raw)})`;
      });
    })
    .join('');
}

export const FILE_REF_SCHEME = SCHEME;
