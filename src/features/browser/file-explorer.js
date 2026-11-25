// 目录视图（列表行，方案 §3.7）。
//
// 只读：主进程 `files:view:list` 负责权限、`.git` 过滤、符号链接跳过与 1000 条上限，
// 这里负责行结构、键盘、状态机（加载/空/无权限/截断）与竞态。

import { icon } from '../../shared/icons.js';
import {
  DIR, FILE, describeFilesError, entryIcon, entryMeta, parentPath, sameLocation,
} from './location.js';

export const SKELETON_ROWS = 6;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconNode(name) {
  try {
    return icon(name);
  } catch {
    return element('i', 'file-row-icon');
  }
}

/** 列表 IPC 的薄封装：`{ ok, value }` 信封 → value，异常带 code。 */
export async function listFolder(files, dirLoc) {
  if (!files?.list) {
    const error = new Error('desktop-only');
    error.code = 'desktop-only';
    throw error;
  }
  const result = await files.list({ rootId: dirLoc.rootId, path: dirLoc.path || '' });
  if (!result?.ok) {
    const error = new Error(result?.message || result?.error || '读取目录失败');
    error.code = result?.error || 'read-failed';
    throw error;
  }
  return result.value || { entries: [], path: dirLoc.path || '', total: 0, truncated: false, skippedLinks: 0 };
}

/**
 * @param {{
 *   container: HTMLElement,
 *   files: any,
 *   onOpen?: (loc: object) => void,
 *   onInfo?: (loc: object, info: { total: number, truncated: boolean }) => void,
 * }} options
 */
export function mountFileExplorer({ container, files, onOpen, onInfo }) {
  const root = element('div', 'file-explorer');
  const list = element('div', 'file-explorer-list');
  list.setAttribute('role', 'list');
  list.tabIndex = 0;
  list.setAttribute('aria-label', '文件夹内容');
  const foot = element('div', 'file-explorer-foot');
  foot.hidden = true;
  root.append(list, foot);
  container.append(root);

  let location = null;
  let entries = [];
  let selected = -1;
  let requestId = 0;
  let disposed = false;

  function clearFoot() {
    foot.replaceChildren();
    foot.hidden = true;
  }

  function addFootNote(text) {
    const note = element('p', 'file-explorer-note', text);
    foot.append(note);
    foot.hidden = false;
  }

  function showSkeleton() {
    clearFoot();
    const rows = [];
    for (let index = 0; index < SKELETON_ROWS; index += 1) {
      const row = element('div', 'file-row is-skeleton');
      row.setAttribute('aria-hidden', 'true');
      row.append(element('span', 'file-skeleton-icon'), element('span', 'file-skeleton-name'), element('span', 'file-skeleton-meta'));
      rows.push(row);
    }
    list.replaceChildren(...rows);
    list.setAttribute('aria-busy', 'true');
  }

  function showState(title, detail, options = {}) {
    clearFoot();
    list.setAttribute('aria-busy', 'false');
    const state = element('div', 'file-state');
    state.append(element('p', 'file-state-title', title));
    if (detail) state.append(element('p', 'file-state-detail', detail));
    if (options.retry) {
      const retry = element('button', 'file-state-action', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => { if (location) void load(location); });
      state.append(retry);
    }
    list.replaceChildren(state);
  }

  function rowId(index) {
    return `file-row-${index}`;
  }

  function select(index, options = {}) {
    if (!entries.length) return;
    const next = Math.min(Math.max(index, 0), entries.length - 1);
    selected = next;
    for (const row of list.querySelectorAll('.file-row[data-name]')) {
      const isSelected = Number(row.dataset.index) === next;
      row.dataset.selected = String(isSelected);
      row.setAttribute('aria-selected', String(isSelected));
    }
    list.setAttribute('aria-activedescendant', rowId(next));
    if (options.scroll !== false) list.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function openEntry(entry) {
    if (!entry || !location) return;
    const path = location.path ? `${location.path}/${entry.name}` : entry.name;
    const loc = entry.type === 'dir'
      ? { kind: DIR, rootId: location.rootId, path }
      : { kind: FILE, rootId: location.rootId, path };
    onOpen?.(loc);
  }

  function renderRows(payload) {
    entries = Array.isArray(payload.entries) ? payload.entries : [];
    list.setAttribute('aria-busy', 'false');
    if (!entries.length) {
      showState('这个文件夹是空的', '把文件放进来后回到这里刷新即可。');
      onInfo?.(location, { total: 0, truncated: false });
      return;
    }
    list.replaceChildren();
    selected = -1;
    entries.forEach((entry, index) => {
      const row = element('div', 'file-row');
      row.id = rowId(index);
      row.dataset.index = String(index);
      row.dataset.name = entry.name;
      row.dataset.type = entry.type;
      row.dataset.selected = 'false';
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-selected', 'false');
      row.title = entry.name;
      const glyph = iconNode(entryIcon(entry));
      glyph.classList.add('file-row-icon');
      glyph.setAttribute('aria-hidden', 'true');
      const name = element('span', 'file-row-name', entry.name);
      const meta = element('span', 'file-row-meta', entryMeta(entry));
      row.append(glyph, name, meta);
      row.addEventListener('click', () => { select(Number(row.dataset.index)); list.focus({ preventScroll: true }); });
      row.addEventListener('dblclick', () => openEntry(entry));
      list.append(row);
    });
    clearFoot();
    if (payload.truncated) addFootNote(`仅显示前 1000 项（共 ${payload.total ?? entries.length} 项）`);
    if (payload.skippedLinks > 0) addFootNote(`已跳过 ${payload.skippedLinks} 个符号链接`);
    select(0, { scroll: false });
    onInfo?.(location, { total: payload.total ?? entries.length, truncated: payload.truncated === true });
  }

  async function load(loc) {
    const ticket = ++requestId;
    list.setAttribute('aria-busy', 'true');
    showSkeleton();
    entries = [];
    selected = -1;
    if (!files?.list) {
      showState('目录视图仅在桌面版可用', '浏览器预览环境没有文件访问权限，安装 Mova 桌面版后即可浏览项目文件夹。');
      return;
    }
    try {
      const payload = await listFolder(files, loc);
      if (disposed || ticket !== requestId) return;
      renderRows(payload);
    } catch (error) {
      if (disposed || ticket !== requestId) return;
      showState('打不开这个文件夹', describeFilesError(error?.code, error?.message), { retry: true });
      onInfo?.(loc, null);
    }
  }

  list.addEventListener('keydown', event => {
    if (!entries.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      select(selected + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      select(selected - 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      select(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      select(entries.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      openEntry(entries[selected]);
      return;
    }
    if (event.key === 'Backspace') {
      if (!location) return;
      const parent = parentPath(location.path);
      if (parent === null) return;
      event.preventDefault();
      onOpen?.({ kind: DIR, rootId: location.rootId, path: parent });
    }
  });
  list.addEventListener('focus', () => {
    if (selected < 0) select(0, { scroll: false });
  });

  return {
    element: root,
    /** 切换到某个目录位置；`refresh` 强制重新读盘。 */
    show(loc, options = {}) {
      if (!loc) return;
      const same = location && sameLocation(location, loc);
      if (same && options.refresh !== true && entries.length && !list.querySelector('.file-state')) {
        list.focus?.();
        return;
      }
      location = loc;
      void load(loc);
    },
    reload() {
      if (location) void load(location);
    },
    entries() {
      return entries.slice();
    },
    getLocation() {
      return location;
    },
    focus() {
      list.focus();
    },
    dispose() {
      disposed = true;
      requestId += 1;
      root.remove();
    },
  };
}
