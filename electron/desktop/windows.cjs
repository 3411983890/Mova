'use strict';
// 顶层窗口：枚举 / 前台 / 激活 / 树 / 屏幕信息，全部走 worker；纯函数单独导出便于单测。
// 这里刻意不 require('electron')：screen 由调用方注入（Electron 的 screen 或 getAllDisplays() 数组），
// 这样 displayForRect 这类坐标换算能脱离 Electron 单测。

const { rectOf, rectCenter } = require('./tree.cjs');

const EXCLUDE_DEFAULT = Object.freeze(['Mova.exe']);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function normalizeWindow(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rect = rectOf(src.rect);
  return {
    hwnd: num(src.hwnd),
    pid: num(src.pid),
    exe: typeof src.exe === 'string' ? src.exe : '',
    title: typeof src.title === 'string' ? src.title : '',
    className: typeof src.className === 'string' ? src.className : (typeof src.class === 'string' ? src.class : ''),
    rect,
    foreground: src.foreground === true,
    minimized: src.minimized === true,
    index: num(src.index),
  };
}

// 一行摘要，给日志/审计/compact 头用
function windowLabel(win) {
  if (!win) return '';
  const w = normalizeWindow(win);
  const title = w.title || '(无标题)';
  const size = w.rect.w > 0 ? ` ${w.rect.w}x${w.rect.h}@${w.rect.x},${w.rect.y}` : '';
  const flags = [w.foreground ? 'foreground' : '', w.minimized ? 'minimized' : ''].filter(Boolean).join(',');
  return `${title}${w.exe ? ` [${w.exe}]` : ''}${size}${flags ? ` (${flags})` : ''}`;
}

function rectsOverlap(a, b) {
  const r1 = rectOf(a);
  const r2 = rectOf(b);
  if (r1.w <= 0 || r1.h <= 0 || r2.w <= 0 || r2.h <= 0) return false;
  return r1.x < r2.x + r2.w && r2.x < r1.x + r1.w && r1.y < r2.y + r2.h && r2.y < r1.y + r1.h;
}

function overlapArea(a, b) {
  const r1 = rectOf(a);
  const r2 = rectOf(b);
  const left = Math.max(r1.x, r2.x);
  const top = Math.max(r1.y, r2.y);
  const right = Math.min(r1.x + r1.w, r2.x + r2.w);
  const bottom = Math.min(r1.y + r1.h, r2.y + r2.h);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function toDisplays(screen) {
  if (!screen) return [];
  if (Array.isArray(screen)) return screen;
  if (typeof screen.getAllDisplays === 'function') return screen.getAllDisplays() || [];
  if (typeof screen.displayForRect === 'function') return [];
  return [];
}

function displayBounds(display) {
  if (!display) return { x: 0, y: 0, w: 0, h: 0 };
  if (display.bounds) return rectOf(display.bounds);
  return rectOf({ x: display.x, y: display.y, w: display.w || display.width, h: display.h || display.height });
}

/**
 * 找出 rect 落在哪块屏幕上（纯函数；screen 可以是 Electron screen 或 displays 数组）。
 * 优先“包含中心点”，其次“重叠面积最大”，最后回退到 primary / 第一块。
 * @returns {{display:object|null, id:any, scaleFactor:number, bounds:object, localRect:object, overlap:number}}
 */
function displayForRect(screen, rect) {
  const target = rectOf(rect);
  const displays = toDisplays(screen);
  if (!displays.length) {
    return { display: null, id: null, scaleFactor: 1, bounds: target, localRect: { x: 0, y: 0, w: target.w, h: target.h }, overlap: 0 };
  }
  const center = rectCenter(target);
  let best = null;
  let bestOverlap = 0;
  for (const display of displays) {
    const bounds = displayBounds(display);
    const inside = center.x >= bounds.x && center.x < bounds.x + bounds.w
      && center.y >= bounds.y && center.y < bounds.y + bounds.h;
    const area = overlapArea(bounds, target);
    if (inside) {
      best = display;
      bestOverlap = area;
      break;
    }
    if (area > bestOverlap) {
      best = display;
      bestOverlap = area;
    }
  }
  const chosen = best || displays.find((display) => display.primary) || displays[0];
  const bounds = displayBounds(chosen);
  return {
    display: chosen,
    id: chosen && chosen.id !== undefined ? chosen.id : null,
    scaleFactor: Number(chosen && chosen.scaleFactor) || 1,
    bounds,
    localRect: { x: target.x - bounds.x, y: target.y - bounds.y, w: target.w, h: target.h },
    overlap: bestOverlap,
  };
}

// 按标题 / exe / hwnd 找窗口，返回第一个命中
function matchWindow(windows, query) {
  const list = Array.isArray(windows) ? windows.map(normalizeWindow) : [];
  if (query === undefined || query === null || query === '') return null;
  if (typeof query === 'number' || /^\d+$/.test(String(query))) {
    const hwnd = Number(query);
    return list.find((win) => win.hwnd === hwnd) || null;
  }
  const needle = String(query).toLowerCase();
  const exact = list.find((win) => win.title.toLowerCase() === needle && !win.minimized);
  if (exact) return exact;
  const titleHit = list.filter((win) => win.title && win.title.toLowerCase().includes(needle));
  if (titleHit.length) return titleHit.find((win) => !win.minimized) || titleHit[0];
  return list.find((win) => win.exe && win.exe.toLowerCase().includes(needle)) || null;
}

function isExcluded(win, excludes = EXCLUDE_DEFAULT) {
  const exe = String((win && win.exe) || '').toLowerCase();
  if (!exe) return false;
  return excludes.some((item) => String(item).toLowerCase() === exe);
}

/**
 * @param {object} deps
 * @param {{call:Function}} deps.host 懒启动的 worker 客户端
 */
function createWindows({ host } = {}) {
  if (!host || typeof host.call !== 'function') {
    const error = new Error('windows 需要 host.call');
    error.code = 'invalid-deps';
    throw error;
  }

  async function list(options = {}) {
    const args = {};
    if (options.includeMinimized !== undefined) args.includeMinimized = options.includeMinimized === true;
    const result = await host.call('windows', args);
    const windows = (Array.isArray(result && result.windows) ? result.windows : []).map(normalizeWindow);
    // “不操作 Mova 自己”：优先按 pid 精确排除（比按 exe 名可靠，打包后 exe 名会变）
    const selfPid = options.selfPid === false ? 0 : (options.selfPid || process.pid);
    const excludes = options.exclude === false ? [] : (options.excludes || EXCLUDE_DEFAULT);
    const filtered = windows.filter((win) => {
      if (selfPid && win.pid === selfPid) return false;
      if (excludes.length && isExcluded(win, excludes)) return false;
      return true;
    });
    if (options.hwnd) {
      const hwnd = num(options.hwnd);
      return filtered.filter((win) => win.hwnd === hwnd);
    }
    return filtered;
  }

  async function foreground() {
    const result = await host.call('foreground');
    return result && result.window ? normalizeWindow(result.window) : null;
  }

  async function activate(hwnd) {
    const result = await host.call('activate', { hwnd: num(hwnd) });
    return {
      ok: Boolean(result && result.ok),
      foreground: Boolean(result && result.foreground),
      restored: Boolean(result && result.restored),
      hwnd: num(hwnd),
    };
  }

  async function tree(hwnd, options = {}) {
    const args = { hwnd: num(hwnd) };
    if (options.maxDepth !== undefined) args.maxDepth = num(options.maxDepth);
    if (options.maxNodes !== undefined) args.maxNodes = num(options.maxNodes);
    if (options.deadlineMs !== undefined) args.deadlineMs = num(options.deadlineMs);
    if (options.includeOffscreen !== undefined) args.includeOffscreen = options.includeOffscreen === true;
    const result = await host.call('tree', args);
    return {
      hwnd: num(result && result.hwnd ? result.hwnd : hwnd),
      window: result && result.window ? normalizeWindow(result.window) : null,
      nodes: Array.isArray(result && result.nodes) ? result.nodes : [],
      truncated: Boolean(result && result.truncated),
      timedOut: Boolean(result && result.timedOut),
      elapsedMs: num(result && result.elapsedMs),
    };
  }

  async function find(hwnd, by, options = {}) {
    const args = { hwnd: num(hwnd), by: by || {} };
    if (options.maxNodes !== undefined) args.maxNodes = num(options.maxNodes);
    const result = await host.call('find', args);
    return result && result.node ? result.node : null;
  }

  async function screenInfo() {
    const result = await host.call('screenInfo');
    const displays = (Array.isArray(result && result.displays) ? result.displays : []).map((item) => ({
      id: item.id,
      index: num(item.index),
      bounds: { x: num(item.x), y: num(item.y), w: num(item.w), h: num(item.h) },
      scaleFactor: Number(item.scaleFactor) || 1,
      primary: item.primary === true,
    }));
    return displays;
  }

  async function rectOfRef(ref) {
    const result = await host.call('rect', { ref });
    return {
      rect: rectOf(result && result.rect),
      clickable: Array.isArray(result && result.clickable)
        ? { x: num(result.clickable[0]), y: num(result.clickable[1]) }
        : rectCenter(result && result.rect),
    };
  }

  async function readText(ref, options = {}) {
    const args = { ref };
    if (options.maxChars !== undefined) args.maxChars = num(options.maxChars);
    const result = await host.call('readText', args);
    return {
      text: String((result && result.text) || ''),
      truncated: Boolean(result && result.truncated),
    };
  }

  return { list, foreground, activate, tree, find, screenInfo, rectOfRef, readText };
}

module.exports = {
  createWindows,
  normalizeWindow,
  windowLabel,
  displayForRect,
  displayBounds,
  toDisplays,
  matchWindow,
  isExcluded,
  rectsOverlap,
  overlapArea,
  EXCLUDE_DEFAULT,
};
