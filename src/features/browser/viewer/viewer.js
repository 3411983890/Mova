// 渲染分发（方案 §3.4 / §4.4）。
//
//   show(loc) → requestId++ → 骨架 → IPC → 新鲜度校验 → 新节点替换旧节点
// 失败留在 ErrorState（面包屑还在，可重试）；目录交给 file-explorer。
// 卸载时撤销 blob / 断开 React 根 / 清缓存。

import './viewer.css';
import {
  FILE, DIR, codeLanguageOf, describeFilesError, directoryOf, extensionOf, formatSize,
  kindOfFile, labelOf, languageLabelOf, joinPath, splitAnchor, truncateText,
} from '../location.js';
import { mountFileExplorer, listFolder } from '../file-explorer.js';
import { createMarkdownView } from './markdown-view.js';
import { createCodeView } from './code-view.js';
import { createTextView } from './text-view.js';
import { createImageView } from './image-view.js';
import { createPdfView } from './pdf-view.js';
import { createBinaryView } from './binary-view.js';

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 8;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const READ_MAX_BYTES = 1_500_000;
const RENDER_MAX_CHARS = 1024 * 1024;
const RENDER_MAX_LINES = 5000;
const MAX_MARKDOWN_IMAGES = 16;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function invoke(files, name, payload) {
  const result = await files[name](payload);
  if (!result?.ok) {
    const error = new Error(result?.message || result?.error || '读取失败');
    error.code = result?.error || 'failed';
    throw error;
  }
  return result.value;
}

function sliceForRender(text) {
  let value = String(text ?? '');
  let note = '';
  if (value.length > RENDER_MAX_CHARS) {
    value = value.slice(0, RENDER_MAX_CHARS);
    note = `内容过大，只渲染了前 ${formatSize(RENDER_MAX_CHARS)}。`;
  }
  const lines = value.split('\n');
  if (lines.length > RENDER_MAX_LINES) {
    value = lines.slice(0, RENDER_MAX_LINES).join('\n');
    note = `内容过长，只渲染了前 ${RENDER_MAX_LINES} 行。`;
  }
  return { text: value, note };
}

/**
 * @param {{
 *   container: HTMLElement,
 *   files?: any,
 *   roots?: () => any[],
 *   onNavigate?: (loc: object, options?: { replace?: boolean }) => void,
 *   onDirectoryInfo?: (loc: object, info: { total: number, truncated: boolean } | null) => void,
 * }} options
 */
export function mountViewer({ container, files, roots, onNavigate, onDirectoryInfo }) {
  const host = element('div', 'viewer-host');
  host.hidden = true;
  const fileHost = element('div', 'viewer-file');
  const dirHost = element('div', 'viewer-dir');
  host.append(fileHost, dirHost);
  container.append(host);

  const cache = new Map();
  let cacheBytes = 0;
  let active = null;
  let activeKind = null;
  let requestId = 0;
  let location = null;
  let disposed = false;

  const explorer = mountFileExplorer({
    container: dirHost,
    files,
    onOpen: loc => onNavigate?.(loc),
    onInfo: (loc, info) => { if (loc) onDirectoryInfo?.(loc, info); },
  });

  function readCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL) {
      cache.delete(key);
      cacheBytes -= hit.bytes;
      return null;
    }
    // 命中即刷新 LRU 顺序。
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }

  function writeCache(key, value, bytes) {
    const previous = cache.get(key);
    if (previous) cacheBytes -= previous.bytes;
    cache.delete(key);
    cache.set(key, { value, bytes, at: Date.now() });
    cacheBytes += bytes;
    while (cache.size > CACHE_MAX_ENTRIES || (cacheBytes > CACHE_MAX_BYTES && cache.size > 1)) {
      const oldest = cache.keys().next().value;
      const entry = cache.get(oldest);
      cache.delete(oldest);
      cacheBytes -= entry?.bytes || 0;
    }
  }

  function releaseActive() {
    if (!active) return;
    try { active.dispose(); } catch { /* view already detached */ }
    active = null;
    activeKind = null;
    fileHost.replaceChildren();
  }

  function hideAll() {
    host.hidden = true;
  }

  function showLoading() {
    const state = element('div', 'viewer-state');
    state.dataset.state = 'loading';
    const skeleton = element('div', 'viewer-skeleton');
    for (let index = 0; index < 6; index += 1) skeleton.append(element('span', 'viewer-skeleton-row'));
    state.append(skeleton);
    state.append(element('p', 'viewer-state-detail', '正在读取…'));
    fileHost.replaceChildren(state);
  }

  function showMessage(title, detail, options = {}) {
    const state = element('div', 'viewer-state');
    state.dataset.state = options.state || 'error';
    state.append(element('p', 'viewer-state-title', title));
    if (detail) state.append(element('p', 'viewer-state-detail', detail));
    const actions = element('div', 'viewer-state-actions');
    if (options.retry) {
      const retry = element('button', 'viewer-state-button', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => { if (location) show(location, { refresh: true }); });
      actions.append(retry);
    }
    if (options.reveal && files && location) {
      const target = location;
      const reveal = element('button', 'viewer-state-button', '在资源管理器中显示');
      reveal.type = 'button';
      reveal.addEventListener('click', () => { void revealLocation(target); });
      actions.append(reveal);
    }
    if (actions.childElementCount) state.append(actions);
    fileHost.replaceChildren(state);
  }

  async function revealLocation(loc) {
    if (!files || !loc) return;
    try {
      if (loc.kind === DIR) await files.openDir?.({ rootId: loc.rootId, path: loc.path });
      else await window.movaDesktop?.files?.reveal?.({ rootId: loc.rootId, path: loc.path });
    } catch { /* 资源管理器不可用时保持静默，页面已有可见信息 */ }
  }

  async function loadMarkdownImages(text, loc, ticket) {
    const sources = new Map();
    if (!files?.read) return sources;
    const matches = [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].slice(0, MAX_MARKDOWN_IMAGES);
    await Promise.all(matches.map(async match => {
      const raw = match[2];
      if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return; // 远程图片只显示 alt
      const anchor = splitAnchor(raw);
      let decoded = anchor.path;
      try { decoded = decodeURIComponent(anchor.path); } catch { /* 保留原样的非法百分号编码 */ }
      const target = joinPath(directoryOf(loc.path), decoded);
      if (!target || !IMAGE_EXT.has(extensionOf(target))) return;
      try {
        const value = await invoke(files, 'read', { rootId: loc.rootId, path: target });
        if (disposed || ticket !== requestId) return;
        if (value?.base64) sources.set(raw, `data:${value.mime || 'application/octet-stream'};base64,${value.base64}`);
      } catch { /* 单张图片失败只显示 alt */ }
    }));
    return sources;
  }

  function openMarkdown(text, loc, ticket, note) {
    return loadMarkdownImages(text, loc, ticket).then(images => {
      if (disposed || ticket !== requestId) return;
      const view = createMarkdownView({
        container: fileHost,
        resolveLink(href) {
          if (typeof href !== 'string' || !href) return null;
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
          const anchor = splitAnchor(href);
          let decoded = anchor.path;
          try { decoded = decodeURIComponent(anchor.path); } catch { /* 保留原样 */ }
          const target = joinPath(directoryOf(loc.path), decoded);
          if (!target) return null;
          return {
            href: '#',
            onClick: event => {
              event.preventDefault();
              const next = { kind: FILE, rootId: loc.rootId, path: target };
              if (anchor.line) next.line = anchor.line;
              onNavigate?.(next);
            },
          };
        },
        resolveImage(src) {
          const source = images.get(src);
          return source ? { src: source, alt: truncateText(src, 60) } : null;
        },
        onOpenLink(href) {
          if (typeof href === 'string' && href) window.open?.(href, '_blank', 'noopener');
        },
      });
      active = view;
      activeKind = 'markdown';
      if (note) fileHost.prepend(element('p', 'viewer-note', note));
      view.render(text);
    });
  }

  async function openFile(loc) {
    const ticket = ++requestId;
    const key = `${loc.rootId}:${loc.path}`;
    releaseActive();
    showLoading();
    if (!files) {
      showMessage(
        '文件视图仅在桌面版可用',
        '浏览器预览环境没有文件访问接口。安装并打开 Mova 桌面版后，这里会渲染 Markdown、代码、图片与 PDF。',
      );
      return;
    }
    let stat = null;
    let read = null;
    const cached = readCache(key);
    if (cached) { stat = cached.stat || null; read = cached.read || null; }
    try {
      if (!stat) stat = await invoke(files, 'stat', { rootId: loc.rootId, path: loc.path });
      if (disposed || ticket !== requestId) return;
      if (stat?.type === 'dir') {
        // 链接可能指向目录：原地替换成目录位置，避免多一条历史。
        onNavigate?.({ kind: DIR, rootId: loc.rootId, path: loc.path }, { replace: true });
        return;
      }
      if (stat?.kind === 'pdf') {
        // PDF streams from disk through mova-pdf: — no base64 round-trip.
        releaseActive();
        fileHost.replaceChildren();
        const view = createPdfView({ container: fileHost });
        active = view; activeKind = 'pdf';
        view.render({
          rootId: loc.rootId,
          path: loc.path,
          bytes: stat.size,
          name: labelOf({ ...loc, path: loc.path }, { roots: roots?.() || [] }),
        });
        return;
      }
      if (!read) read = await invoke(files, 'read', { rootId: loc.rootId, path: loc.path, maxBytes: READ_MAX_BYTES });
      if (disposed || ticket !== requestId) return;
      writeCache(key, { stat, read }, (read?.text?.length || 0) + (read?.base64?.length || 0));
    } catch (error) {
      if (disposed || ticket !== requestId) return;
      const code = error?.code;
      showMessage('打不开这个文件', describeFilesError(code, error?.message), {
        retry: true,
        reveal: code !== 'invalid-path',
      });
      return;
    }

    const kind = stat?.kind || kindOfFile(loc.path);
    const name = labelOf({ ...loc, path: loc.path }, { roots: roots?.() || [] });
    releaseActive();
    // The loading skeleton was appended after the previous release; views mount
    // by appending themselves, so it has to be cleared here (otherwise the
    // skeleton stays on top of Markdown/image/PDF content).
    fileHost.replaceChildren();
    try {
      if (kind === 'markdown') {
        const { text, note } = sliceForRender(read?.text || '');
        const noteParts = [];
        if (read?.truncated) noteParts.push(`文件较大，只读取了前 ${formatSize(READ_MAX_BYTES)}。`);
        if (note) noteParts.push(note);
        await openMarkdown(text, loc, ticket, noteParts.join(' '));
        return;
      }
      if (kind === 'image') {
        const view = createImageView({ container: fileHost });
        active = view; activeKind = 'image';
        view.render({ base64: read?.base64, mime: read?.mime, bytes: read?.bytes, name });
        return;
      }
      if (kind === 'pdf') {
        const view = createPdfView({ container: fileHost });
        active = view; activeKind = 'pdf';
        view.render({ base64: read?.base64, mime: read?.mime, bytes: read?.bytes, name });
        return;
      }
      if (read?.kind === 'binary') {
        const view = createBinaryView({ container: fileHost, onReveal: () => revealLocation(loc) });
        active = view; activeKind = 'binary';
        view.render({ base64: read?.base64, mime: read?.mime, bytes: read?.bytes, truncated: read?.truncated, name });
        return;
      }
      const { text, note } = sliceForRender(read?.text || '');
      const notes = [];
      if (read?.truncated) notes.push(`文件较大，只读取了前 ${formatSize(READ_MAX_BYTES)}。`);
      if (note) notes.push(note);
      if (read?.encoding && read.encoding !== 'utf-8') notes.push(`按 ${read.encoding} 解码显示。`);
      const hint = notes.join(' ');
      if (kind === 'code') {
        const language = codeLanguageOf(loc.path);
        const view = createCodeView({ container: fileHost });
        active = view; activeKind = 'code';
        view.render({
          text,
          language: language?.id || 'text',
          label: languageLabelOf(loc.path),
          line: loc.line,
          note: hint,
        });
        return;
      }
      const view = createTextView({ container: fileHost });
      active = view; activeKind = 'text';
      view.render({ text, label: extensionOf(loc.path).slice(1) || 'text', note: hint, line: loc.line });
    } catch (error) {
      if (disposed) return;
      showMessage('内容渲染失败', error?.message || '未知错误', { retry: true });
    }
  }

  function show(loc, options = {}) {
    if (disposed) return;
    location = loc;
    if (!loc) {
      requestId += 1;
      releaseActive();
      hideAll();
      return;
    }
    host.hidden = false;
    if (options.refresh === true) cache.delete(`${loc.rootId}:${loc.path}`);
    if (loc.kind === DIR) {
      requestId += 1;
      releaseActive();
      fileHost.replaceChildren();
      fileHost.hidden = true;
      dirHost.hidden = false;
      explorer.show(loc, { refresh: options.refresh === true });
      return;
    }
    dirHost.hidden = true;
    fileHost.hidden = false;
    void openFile(loc);
  }

  async function directoryListing(loc) {
    if (!loc) return { entries: [], dir: null, truncated: false };
    if (loc.kind === DIR) {
      const current = explorer.getLocation();
      if (current && current.rootId === loc.rootId && current.path === loc.path) {
        return { entries: explorer.entries(), dir: current, truncated: false };
      }
      try {
        const payload = await listFolder(files, loc);
        return { entries: payload.entries || [], dir: loc, truncated: payload.truncated === true };
      } catch {
        return { entries: [], dir: loc, truncated: false };
      }
    }
    const parent = directoryOf(loc.path);
    if (parent === null) return { entries: [], dir: null, truncated: false };
    const dir = { kind: DIR, rootId: loc.rootId, path: parent };
    try {
      const payload = await listFolder(files, dir);
      return { entries: payload.entries || [], dir, truncated: payload.truncated === true };
    } catch {
      return { entries: [], dir, truncated: false };
    }
  }

  return {
    element: host,
    show,
    hide: hideAll,
    getLocation() {
      return location;
    },
    getActiveKind() {
      return activeKind;
    },
    directoryListing,
    refresh() {
      if (location) show(location, { refresh: true });
    },
    reveal() {
      if (location) revealLocation(location);
    },
    dispose() {
      disposed = true;
      requestId += 1;
      releaseActive();
      explorer.dispose();
      cache.clear();
      cacheBytes = 0;
      host.remove();
    },
  };
}
