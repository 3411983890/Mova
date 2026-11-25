'use strict';

/**
 * Mova 桌面操作 · 浮层窗口（“AI 正在操作电脑”）
 *
 * 契约（design/desktop-build-plan.md §2.5）：
 *
 *   const overlay = createOverlay({ app, screen, getTargetDisplay });
 *   overlay.show({ displayId, emotion });   // 目标显示器左下角，一个显示器一个窗口
 *   overlay.hide();                         // 全部关闭（240ms 淡出后销毁）
 *   overlay.update('正在点击「数据透视表」'); // 推进一条气泡
 *   overlay.setEmotion('33');
 *   overlay.setTarget({ x, y, w, h }, { label }); // 目标控件矩形描边（§12.7，屏幕坐标）
 *   overlay.setTarget(null);                // 收起描边
 *   overlay.exists();                       // 真实窗口是否存活
 *   overlay.dispose();
 *
 * 窗口参数照 `Mova桌面操作开发方案.md` §12.2：透明、无边框、不抢焦点、不进截图、
 * 不吃鼠标事件。渲染层在 overlay.html / overlay.css，数据通过 executeJavaScript
 * 推进 `window.__movaOverlay`（sandbox:true 且不挂 preload，最省事也最可靠）。
 *
 * 自愈：show() 后窗口在 3s 内被销毁（GPU 进程崩溃、被安全软件关掉等）→ 重建一次。
 */

const path = require('node:path');

const OVERLAY_HTML = path.join(__dirname, 'overlay.html');

/** show() 后 3s 内窗口被销毁 → 允许重建一次（§12.9 的 watchdog）。 */
const WATCHDOG_MS = 3000;
/** §12.8：结束时 240ms 淡出，再销毁窗口。 */
const HIDE_FADE_MS = 240;
/** 显示器增删/缩放变化后的重建延迟（合并连续事件）。 */
const DISPLAY_SYNC_MS = 200;
const MAX_BUBBLES = 3;
const MAX_TEXT_LENGTH = 300;
/** 目标描边的标签只有一行，超过就会被窗口裁掉，先自己截断。 */
const MAX_TARGET_LABEL = 40;
const EMOTION_PATTERN = /^[0-9]{2}$/;

/* ─────────── 纯函数：屏幕坐标（DIP）→ 该显示器窗口内的本地坐标 ───────────
   抽出来是为了能单测：测试环境没有 app / screen，不能真去建窗口。 */

/** 数值化；NaN / Infinity 一律当缺失，避免一个坏字段把整块描边算到屏幕外。 */
function num(value, fallback = null) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 目标矩形归一成 {x,y,w,h}（屏幕坐标 / DIP）。
 * 兼容 UI 侧的 w/h 与 Electron 的 width/height；缺字段按 0 处理，
 * 宽高 <= 0 视为“没有目标”（等价于隐藏）。
 */
function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = num(rect.x, 0);
  const y = num(rect.y, 0);
  const w = num(rect.w != null ? rect.w : rect.width, 0);
  const h = num(rect.h != null ? rect.h : rect.height, 0);
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

/** 显示器 → 屏幕坐标下的 bounds；兼容 Electron display.bounds 与裸 {x,y,w,h}。 */
function normalizeBounds(display) {
  if (!display || typeof display !== 'object') return null;
  const src = display.bounds || display.workArea || display;
  const x = num(src.x, 0);
  const y = num(src.y, 0);
  const width = num(src.width != null ? src.width : src.w, 0);
  const height = num(src.height != null ? src.height : src.h, 0);
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/**
 * 屏幕坐标矩形 → 该显示器浮层窗口内的本地坐标。
 *
 * - 两者都是 DIP（CSS 像素），所以**不乘 scaleFactor**：scaleFactor 只决定物理像素，
 *   浮层窗口的 CSS 视口本来就等于 display.bounds。
 * - 跨显示器：按该显示器的 bounds 裁切，只画落在它上面的那部分。
 * - 完全在窗口外 / 宽高为 0 / 字段缺失：返回 null（调用方据此隐藏描边）。
 *
 * @param {{x?:number,y?:number,w?:number,h?:number,width?:number,height?:number}} rect 屏幕坐标
 * @param {object} display Electron display（或任何带 bounds 的对象）
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function toLocalRect(rect, display) {
  const r = normalizeRect(rect);
  if (!r) return null;
  const b = normalizeBounds(display);
  if (!b) return null;

  const left = Math.max(r.x, b.x);
  const top = Math.max(r.y, b.y);
  const right = Math.min(r.x + r.w, b.x + b.width);
  const bottom = Math.min(r.y + r.h, b.y + b.height);
  if (right <= left || bottom <= top) return null; // 完全在屏外

  const displayW = Math.max(1, Math.round(b.width));
  const displayH = Math.max(1, Math.round(b.height));
  // 取整后再夹一次：否则 0.5px 的边会被四舍五入到窗口外，描边缺一条。
  const x = Math.min(Math.max(0, Math.round(left - b.x)), displayW - 1);
  const y = Math.min(Math.max(0, Math.round(top - b.y)), displayH - 1);
  const w = Math.min(Math.max(1, Math.round(right - left)), displayW - x);
  const h = Math.min(Math.max(1, Math.round(bottom - top)), displayH - y);
  return { x, y, w, h };
}

/**
 * @param {object} options
 * @param {import('electron').App} [options.app]
 * @param {import('electron').Screen} [options.screen]
 * @param {() => (object|string|number|null)} [options.getTargetDisplay] 目标窗口所在的显示器
 * @param {Console} [options.logger]
 */
function createOverlay(options = {}) {
  const { app, screen, getTargetDisplay, logger = console } = options || {};

  // 延迟 require：这样纯 node 里 require 本文件不会炸（只有真正创建窗口时才需要 Electron）。
  const electron = require('electron');
  const BrowserWindow = electron && electron.BrowserWindow;
  if (typeof BrowserWindow !== 'function') {
    throw new Error('overlay：必须在 Electron 主进程中调用 createOverlay()');
  }
  // screen 模块在 ready 之前不可用：延迟解析，拿不到就返回 null（调用方都有 null 兜底）
  let displayApi = screen || null;
  function screenOf() {
    if (displayApi) return displayApi;
    try {
      const s = require('electron').screen;
      if (s) displayApi = s;
    } catch { /* ready 之前会抛，忽略 */ }
    return displayApi;
  }

  /** @type {Map<string, object>} displayId → entry */
  const entries = new Map();
  let activeKey = null;
  let disposed = false;
  let quitting = false;
  let defaultEmotion = '32';
  let displaySyncTimer = null;
  let detachDisplayListeners = null;
  const deferredShows = [];
  /** 当前目标描边（屏幕坐标 + 标签）：窗口重建 / show() 之后要重新推一遍。 */
  let currentTarget = null;

  /* ───────────────────────── 工具 ───────────────────────── */

  function warn(message, error) {
    const text = `[overlay] ${message}${error && error.message ? `：${error.message}` : ''}`;
    if (logger && typeof logger.warn === 'function') logger.warn(text);
  }

  function displayKey(display) {
    if (!display) return 'primary';
    return String(display.id == null ? 'primary' : display.id);
  }

  function listDisplays() {
    try {
      const d = screenOf();
    if (d && typeof d.getAllDisplays === 'function') return d.getAllDisplays();
    } catch (error) {
      warn('读取显示器列表失败', error);
    }
    return [];
  }

  function primaryDisplay() {
    try {
      const d = screenOf();
    if (d && typeof d.getPrimaryDisplay === 'function') return d.getPrimaryDisplay();
    } catch (error) {
      warn('读取主显示器失败', error);
    }
    return null;
  }

  function normalizeDisplay(display) {
    const bounds = (display && (display.bounds || display.workArea)) || { x: 0, y: 0, width: 1280, height: 800 };
    return {
      id: display && display.id != null ? display.id : 'primary',
      scaleFactor: (display && display.scaleFactor) || 1,
      bounds: {
        x: Math.round(Number(bounds.x) || 0),
        y: Math.round(Number(bounds.y) || 0),
        width: Math.max(1, Math.round(Number(bounds.width) || 0)),
        height: Math.max(1, Math.round(Number(bounds.height) || 0)),
      },
    };
  }

  function targetDisplay() {
    if (typeof getTargetDisplay !== 'function') return null;
    try {
      return getTargetDisplay();
    } catch (error) {
      warn('getTargetDisplay() 抛错，回退主显示器', error);
      return null;
    }
  }

  /** displayId（数字/字符串）或 display 对象 → 归一化显示器；未知则主显示器。 */
  function resolveDisplay(displayId) {
    const wanted = displayId == null ? targetDisplay() : displayId;
    if (wanted && typeof wanted === 'object' && (wanted.bounds || wanted.workArea)) {
      return normalizeDisplay(wanted);
    }
    if (wanted != null) {
      const hit = listDisplays().find((display) => displayKey(display) === String(wanted));
      if (hit) return normalizeDisplay(hit);
    }
    const primary = primaryDisplay();
    if (primary) return normalizeDisplay(primary);
    const all = listDisplays();
    if (all.length) return normalizeDisplay(all[0]);
    return null;
  }

  function findDisplayByKey(key) {
    const hit = listDisplays().find((display) => displayKey(display) === String(key));
    return hit ? normalizeDisplay(hit) : null;
  }

  function sameBounds(a, b) {
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function isAlive(entry) {
    return !!(entry && !entry.disposed && entry.win && !entry.win.isDestroyed());
  }

  function normalizeEmotion(id) {
    const value = id == null ? '' : String(id).trim();
    return EMOTION_PATTERN.test(value) ? value : null;
  }

  function normalizeText(text) {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!value) return '';
    return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH - 1)}…` : value;
  }

  /** 标签一行就够：太长会被窗口裁掉，先自己截断。 */
  function normalizeLabel(label) {
    const value = normalizeText(label);
    if (!value) return '';
    return value.length > MAX_TARGET_LABEL ? `${value.slice(0, MAX_TARGET_LABEL - 1)}…` : value;
  }

  function activeEntry() {
    const current = activeKey ? entries.get(activeKey) : null;
    if (isAlive(current) && !current.closing) return current;
    for (const entry of entries.values()) {
      if (isAlive(entry) && !entry.closing) return entry;
    }
    return null;
  }

  /* ───────────────────────── 渲染进程通信 ───────────────────────── */

  /**
   * 把一段 JS 推进渲染层。同一窗口的调用串成一条链，保证 push 顺序与调用顺序一致。
   * 窗口还没加载完 → 先排队，did-finish-load 后统一 flush。
   */
  function enqueue(entry, expression) {
    if (!entry || entry.disposed || !entry.win) return Promise.resolve(null);
    if (!entry.ready) {
      entry.pending.push(expression);
      return Promise.resolve(null);
    }
    entry.chain = entry.chain
      .then(() => {
        if (!isAlive(entry)) return null;
        return entry.win.webContents.executeJavaScript(expression, true).catch((error) => {
          warn('executeJavaScript 失败', error);
          return null;
        });
      })
      .catch(() => null);
    return entry.chain;
  }

  function flush(entry) {
    const queued = entry.pending.splice(0, entry.pending.length);
    for (const expression of queued) enqueue(entry, expression);
  }

  /* ───────────────────────── 窗口生命周期 ───────────────────────── */

  function createEntry(display, { emotion } = {}) {
    const bounds = display.bounds;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      alwaysOnTop: true,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: false,
      },
    });

    const entry = {
      key: displayKey(display),
      display,
      win,
      ready: false,
      wantVisible: false,
      closing: false,
      disposed: false,
      emotion: normalizeEmotion(emotion) || defaultEmotion,
      texts: [],
      pending: [],
      chain: Promise.resolve(),
      hideTimer: null,
      watchdogTimer: null,
      shownAt: 0,
      rebuilds: 0,
    };

    // 绝不抢焦点、绝不吃点击、绝不进截图（§12.2）。
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (error) { warn('setAlwaysOnTop 失败', error); }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (error) { warn('setVisibleOnAllWorkspaces 失败', error); }
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (error) { warn('setIgnoreMouseEvents 失败', error); }
    if (!process.env.MOVA_OVERLAY_NO_PROTECT) { try { win.setContentProtection(true); } catch (error) { warn('setContentProtection 失败', error); } }
    try { win.setSkipTaskbar(true); } catch { /* Windows 上设一次即可 */ }
    if (typeof win.setFocusable === 'function') {
      try { win.setFocusable(false); } catch { /* 不允许改也不影响 */ }
    }

    win.webContents.on('did-finish-load', () => {
      if (entry.disposed || !isAlive(entry)) return;
      entry.ready = true;
      flush(entry);
      if (entry.wantVisible) reveal(entry);
    });
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      warn(`overlay.html 加载失败（${code} ${description}）：${url}`);
    });
    // 浮层只是一张静态页面：禁止任何导航与弹窗。
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.on('closed', () => {
      entry.ready = false;
      entry.win = null;
      handleCrash(entry);
    });

    win.loadFile(OVERLAY_HTML).catch((error) => warn('加载 overlay.html 失败', error));

    return entry;
  }

  function reveal(entry) {
    if (!isAlive(entry) || !entry.wantVisible) return;
    try {
      entry.win.showInactive(); // 不抢焦点
    } catch (error) {
      warn('showInactive 失败', error);
    }
    // 每次显示都补一遍（窗口重建 / 系统主题切换后仍成立）。
    try { entry.win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* 已设置 */ }
    try { entry.win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* 已设置 */ }
    try { entry.win.setContentProtection(true); } catch { /* 已设置 */ }
  }

  function destroyEntry(entry) {
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    entry.closing = true;
    entry.wantVisible = false;
    clearTimeout(entry.hideTimer);
    clearTimeout(entry.watchdogTimer);
    entry.hideTimer = null;
    entry.watchdogTimer = null;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (entry.win && !entry.win.isDestroyed()) {
      try {
        entry.win.destroy();
      } catch (error) {
        warn('销毁浮层窗口失败', error);
      }
    }
    entry.win = null;
    if (activeKey === entry.key) activeKey = null;
  }

  function armWatchdog(entry) {
    clearTimeout(entry.watchdogTimer);
    entry.watchdogTimer = setTimeout(() => {
      entry.watchdogTimer = null;
      if (disposed || entry.disposed) return;
      if (entries.get(entry.key) !== entry) return;
      if (isAlive(entry)) return;
      // 3s 内被销毁 → 重建一次，避免“执行器在跑却没有浮层”。
      if (entry.rebuilds >= 1) {
        warn('浮层窗口 3s 内被销毁且已重建过，放弃重试');
        destroyEntry(entry);
        return;
      }
      entry.rebuilds += 1;
      warn('浮层窗口 3s 内被销毁，重建一次');
      recreate(entry);
    }, WATCHDOG_MS);
  }

  function handleCrash(entry) {
    if (disposed || quitting || entry.disposed || entry.closing) return;
    if (entries.get(entry.key) !== entry) return;
    const withinWatchdog = Date.now() - entry.shownAt <= WATCHDOG_MS;
    if (!entry.wantVisible || !withinWatchdog || entry.rebuilds >= 1) {
      // 非 show() 后 3s 内的崩溃：不在 watchdog 范围，直接回收。
      destroyEntry(entry);
      return;
    }
    entry.rebuilds += 1;
    warn('浮层窗口异常关闭，重建一次');
    // 从 map 里摘掉旧 entry，避免 recreate 时误判。
    entries.delete(entry.key);
    entry.disposed = true;
    recreate(entry);
  }

  /** 销毁旧窗口并按原状态重建（显示器变化 / watchdog 共用）。 */
  function recreate(entry, nextDisplay) {
    if (!entry || disposed) return null;
    const display = nextDisplay || findDisplayByKey(entry.key) || entry.display;
    if (!display) {
      destroyEntry(entry);
      return null;
    }
    const snapshot = {
      emotion: entry.emotion,
      texts: entry.texts.slice(-MAX_BUBBLES),
      visible: entry.wantVisible,
      rebuilds: entry.rebuilds,
    };
    destroyEntry(entry);

    const next = createEntry(display, { emotion: snapshot.emotion });
    next.rebuilds = snapshot.rebuilds;
    entries.set(next.key, next);

    if (snapshot.visible) {
      next.wantVisible = true;
      next.shownAt = Date.now();
      activeKey = next.key;
      enqueue(next, 'window.__movaOverlay.show()');
      enqueue(next, `window.__movaOverlay.setEmotion(${JSON.stringify(next.emotion)})`);
      for (const text of snapshot.texts) enqueue(next, `window.__movaOverlay.push(${JSON.stringify(text)})`);
      if (currentTarget) pushTarget(next);
      armWatchdog(next);
    }
    return next;
  }

  /* ───────────────────────── 显示器变化 ───────────────────────── */

  function syncDisplays() {
    if (disposed) return;
    for (const entry of [...entries.values()]) {
      const display = findDisplayByKey(entry.key);
      if (!display) {
        // 显示器被拔掉：窗口跟着收（不能把浮层留在不存在的坐标上）。
        destroyEntry(entry);
        continue;
      }
      if (!sameBounds(display.bounds, entry.display.bounds) || display.scaleFactor !== entry.display.scaleFactor) {
        // 透明窗口跨 DPI 用 setBounds 硬调会糊，直接重建（§12.2）。
        recreate(entry, display);
      }
    }
  }

  function scheduleDisplaySync() {
    if (disposed) return;
    clearTimeout(displaySyncTimer);
    displaySyncTimer = setTimeout(syncDisplays, DISPLAY_SYNC_MS);
  }

  function attachDisplayListeners() {
    const d = screenOf();
    if (!d || typeof d.on !== 'function') return;
    const events = ['display-added', 'display-removed', 'display-metrics-changed'];
    for (const event of events) d.on(event, scheduleDisplaySync);
    detachDisplayListeners = () => {
      for (const event of events) {
        try {
          const d = screenOf();
      if (d && typeof d.removeListener === 'function') d.removeListener(event, scheduleDisplaySync);
        } catch {
          /* 应用退出时 removeListener 可能失败 */
        }
      }
    };
  }

  /* ───────────────────────── 对外 API ───────────────────────── */

  function showNow(showOptions) {
    if (disposed) return null;
    const display = resolveDisplay(showOptions.displayId);
    if (!display) {
      warn('找不到可用显示器，浮层未显示');
      return null;
    }
    const key = displayKey(display);
    let entry = entries.get(key);
    let created = false;

    if (entry && !isAlive(entry)) {
      destroyEntry(entry);
      entry = null;
    }
    if (!entry) {
      entry = createEntry(display, { emotion: showOptions.emotion });
      entries.set(key, entry);
      created = true;
    } else if (entry.closing) {
      // hide() 的淡出还没结束就又 show()：取消销毁，继续用同一个窗口。
      entry.closing = false;
      clearTimeout(entry.hideTimer);
      entry.hideTimer = null;
    }

    entry.wantVisible = true;
    entry.shownAt = Date.now();
    activeKey = key;

    const emotion = normalizeEmotion(showOptions.emotion);
    if (emotion) entry.emotion = emotion;
    enqueue(entry, `window.__movaOverlay.setEmotion(${JSON.stringify(entry.emotion)})`);
    enqueue(entry, 'window.__movaOverlay.show()');
    // 新窗口没有旧状态：show() 之后把还没结束的描边补上（会话可能在 show 之前就设了目标）。
    if (currentTarget) pushTarget(entry);
    if (entry.ready) reveal(entry);
    armWatchdog(entry);
    startCursorTracking();

    return {
      displayId: display.id,
      created,
      windowId: entry.win && !entry.win.isDestroyed() ? entry.win.id : null,
    };
  }

  function show(showOptions = {}) {
    const opts = showOptions || {};
    if (disposed) return null;
    if (app && typeof app.isReady === 'function' && !app.isReady()) {
      // 应用还没 ready，BrowserWindow 会抛；等 ready 后再补上。
      deferredShows.push(opts);
      if (typeof app.whenReady === 'function') {
        app.whenReady().then(() => {
          const queued = deferredShows.splice(0, deferredShows.length);
          for (const item of queued) showNow(item);
        }).catch((error) => warn('等待 app ready 失败', error));
      }
      return null;
    }
    return showNow(opts);
  }

  function hideEntry(entry) {
    if (!entry || entry.disposed) return;
    entry.wantVisible = false;
    entry.closing = true;
    clearTimeout(entry.watchdogTimer);
    entry.watchdogTimer = null;
    enqueue(entry, 'window.__movaOverlay.hide()');
    clearTimeout(entry.hideTimer);
    entry.hideTimer = setTimeout(() => destroyEntry(entry), HIDE_FADE_MS + 60);
  }

  function hide() {
    stopCursorTracking();
    // 会话结束：描边跟着走，下一次 show() 不该看到上一次的残留矩形。
    currentTarget = null;
    for (const entry of entries.values()) hideEntry(entry);
    activeKey = null;
  }

  /* ── 光标光环：把真实光标位置推给浮层，用户能看见“AI 在动鼠标” ── */
  let cursorTimer = null;
  let lastCursor = { x: -9999, y: -9999 };

  function pushCursor(visible) {
    if (!screen || typeof screen.getCursorScreenPoint !== 'function') return;
    let point;
    try { point = screen.getCursorScreenPoint(); } catch { return; }
    if (!point) return;
    if (visible && Math.abs(point.x - lastCursor.x) < 2 && Math.abs(point.y - lastCursor.y) < 2) return;
    lastCursor = point;
    for (const entry of entries.values()) {
      enqueue(entry, `window.__movaOverlay && window.__movaOverlay.setCursor(${Math.round(point.x)},${Math.round(point.y)},${visible ? 'true' : 'false'})`);
    }
  }

  function startCursorTracking() {
    stopCursorTracking();
    lastCursor = { x: -9999, y: -9999 };
    pushCursor(true);
    cursorTimer = setInterval(() => pushCursor(true), 16);
    if (typeof cursorTimer.unref === 'function') cursorTimer.unref();
  }

  function stopCursorTracking() {
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
    pushCursor(false);
  }

  /* ── 目标控件矩形描边（§12.7）：只在真实注入点击/输入时画，跟着控件矩形走 ── */

  /** 该窗口应画的本地矩形：不在目标显示器上的窗口一律 null（不画重复的一份）。 */
  function localTargetFor(entry) {
    if (!currentTarget || !entry || entry.key !== currentTarget.displayKey) return null;
    const display = entry.display || findDisplayByKey(entry.key);
    return display ? toLocalRect(currentTarget.rect, display) : null;
  }

  function pushTarget(entry) {
    if (!entry || entry.disposed) return;
    const local = localTargetFor(entry);
    const label = local && currentTarget ? currentTarget.label : '';
    enqueue(entry, `window.__movaOverlay && window.__movaOverlay.setTarget(${JSON.stringify(local)}, ${JSON.stringify({ label })})`);
  }

  function clearTarget() {
    currentTarget = null;
    for (const entry of entries.values()) {
      enqueue(entry, 'window.__movaOverlay && window.__movaOverlay.setTarget(null)');
    }
  }

  /** 取与矩形交叠面积最大的显示器：跨屏时只画它上面那部分。 */
  function pickDisplayForRect(rect, displayId) {
    if (displayId != null) {
      const forced = resolveDisplay(displayId);
      if (forced) return forced;
    }
    let best = null;
    let bestArea = 0;
    for (const raw of listDisplays()) {
      const candidate = normalizeDisplay(raw);
      const local = toLocalRect(rect, candidate);
      if (!local) continue;
      const area = local.w * local.h;
      if (area > bestArea) {
        best = candidate;
        bestArea = area;
      }
    }
    if (best) return best;
    // screen 还没 ready 时没有显示器列表：退回浮层窗口自己的显示器。
    const entry = activeEntry();
    return entry && entry.display ? normalizeDisplay(entry.display) : null;
  }

  /**
   * 给目标控件套一圈方形描边（§12.7）。
   *
   * @param {{x:number,y:number,w:number,h:number}|null} rect 屏幕坐标（DIP，与 screen 模块同一坐标系）
   * @param {{label?:string, displayId?:string|number}} [targetOptions]
   * @returns {{displayId:any, rect:{x,y,w,h}, label:string}|null} 实际画的本地矩形
   *
   * 传 null / 宽高为 0 / 完全在屏外 → 清掉描边并返回 null（调用方不必自己判断）。
   */
  function setTarget(rect, targetOptions = {}) {
    if (disposed) return null;
    const opts = targetOptions || {};
    const normalized = normalizeRect(rect);
    if (!normalized) {
      clearTarget();
      return null;
    }
    const display = pickDisplayForRect(normalized, opts.displayId);
    const local = display ? toLocalRect(normalized, display) : null;
    if (!display || !local) {
      // 完全不在任何显示器内：忽略这次调用，但把旧描边清掉，别让它停在空处。
      clearTarget();
      return null;
    }
    const label = normalizeLabel(opts.label);
    currentTarget = { rect: normalized, label, displayKey: displayKey(display) };
    for (const entry of entries.values()) pushTarget(entry);
    return { displayId: display.id, rect: local, label };
  }

  function update(text) {
    const message = normalizeText(text);
    if (!message) return false;
    const entry = activeEntry();
    if (!entry) return false;
    entry.texts.push(message);
    if (entry.texts.length > MAX_BUBBLES) entry.texts.splice(0, entry.texts.length - MAX_BUBBLES);
    enqueue(entry, `window.__movaOverlay.push(${JSON.stringify(message)})`);
    return true;
  }

  /**
   * 会话状态：running / paused。
   * paused 时渲染层会把小球变红、边缘光转红，并支持“点击 Mova 恢复操作”。
   */
  function setState(next, options = {}) {
    const paused = next === 'paused';
    const note = normalizeText(options && options.note ? options.note : '');
    for (const entry of entries.values()) {
      entry.paused = paused;
      enqueue(entry, `window.__movaOverlay.setState(${JSON.stringify(paused ? 'paused' : 'running')}, ${JSON.stringify({ note })})`);
    }
    if (activeEntry() && note) {
      const entry = activeEntry();
      entry.texts.push(note);
      if (entry.texts.length > MAX_BUBBLES) entry.texts.splice(0, entry.texts.length - MAX_BUBBLES);
    }
    return true;
  }

  function setEmotion(id) {
    const emotion = normalizeEmotion(id);
    if (!emotion) return false;
    defaultEmotion = emotion;
    for (const entry of entries.values()) {
      entry.emotion = emotion;
      enqueue(entry, `window.__movaOverlay.setEmotion(${JSON.stringify(emotion)})`);
    }
    return true;
  }

  function exists() {
    for (const entry of entries.values()) {
      if (!entry.closing && isAlive(entry)) return true;
    }
    return false;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    currentTarget = null;
    stopCursorTracking();
    clearTimeout(displaySyncTimer);
    displaySyncTimer = null;
    if (typeof detachDisplayListeners === 'function') detachDisplayListeners();
    detachDisplayListeners = null;
    for (const entry of [...entries.values()]) destroyEntry(entry);
    entries.clear();
    deferredShows.length = 0;
    activeKey = null;
  }

  // 注意：不能在 app ready 之前碰 screen 模块（会抛 "can't be used before app ready"），
  // 而 main.cjs 是在模块顶层创建引擎的，所以这里延迟到 ready 之后再挂监听。
  const canTouchScreen = () => {
    try { return !app || typeof app.isReady !== 'function' || app.isReady(); } catch { return false; }
  };
  if (canTouchScreen()) {
    try { attachDisplayListeners(); } catch (error) { warn('挂显示器监听失败', error); }
  } else if (app && typeof app.whenReady === 'function') {
    app.whenReady().then(() => {
      if (disposed) return;
      try { attachDisplayListeners(); } catch (error) { warn('挂显示器监听失败', error); }
    }).catch(() => {});
  }

  // 退出时自己收拾干净：否则 Electron 关闭窗口触发的 'closed' 会被 watchdog 误判成
  // “浮层窗口异常关闭”，在退出过程中又建一个新窗口，导致进程退不掉。
  if (app && typeof app.once === 'function') {
    const onQuit = () => {
      quitting = true;
      dispose();
    };
    app.once('before-quit', onQuit);
    app.once('will-quit', onQuit);
  }

  return { show, hide, update, setState, setEmotion, setTarget, exists, dispose };
}

module.exports = { createOverlay, toLocalRect };
// 纯函数单测入口：不需要 Electron app，require 本文件即可测。
module.exports.__test__ = { toLocalRect, normalizeRect, normalizeBounds };
