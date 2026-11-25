'use strict';
// One tab = one guest WebContents + one CDP client + one snapshot engine.
// The controller owns visibility; this class refuses to screenshot an invisible
// page, because CDP hangs there (see design/browser-spike.md).

const { dirname, extname, resolve: resolvePath, sep } = require('node:path');
const { realpath, stat } = require('node:fs/promises');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { createCdp } = require('./cdp.cjs');
const { createSnapshotEngine } = require('./snapshot.cjs');
const { readPage } = require('./read.cjs');
const { waitFor } = require('./wait.cjs');
const actions = require('./actions.cjs');
const { handoffReasonOf } = require('./policy.cjs');
const { isBlocked, uniquePath } = require('./downloads.cjs');

const SCREENSHOT_TIMEOUT = 2500;
const MAX_FULL_HEIGHT = 12000;

/**
 * 可展示的本地文件类型：内置浏览器**唯一**放行的非 http(s) 导航。
 * 只放能被直接渲染的类型；脚本、可执行、源码、配置一律不在表里
 * （`file:///C:/x/setup.exe` 与 `file:///C:/x/a.js` 都会被 file_type_not_allowed 拒绝）。
 * 技能层（skills/packs/browser-automation）从这里取同一份清单，不另抄一份。
 */
const DEFAULT_LOCAL_FILE_EXTENSIONS = Object.freeze([
  '.html', '.htm', '.xhtml', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.pdf', '.txt', '.md',
]);

/** 根外一律用这一句：不带任何目标路径，模型与界面都拿不到真实位置。 */
const FILE_OUTSIDE_MESSAGE = '本地文件只能在已登记的项目目录内打开（不在项目目录内）';

function codedError(code, message, detail) {
  const error = new Error(message || code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

/** Windows 上路径比较不分大小写；其它平台按原样比较。 */
function foldPath(value) {
  const text = String(value || '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/** 根自身算在根内；否则要求严格前缀 + 分隔符，避免 `C:\proj-evil` 命中 `C:\proj`。 */
function insidePath(root, target) {
  if (typeof root !== 'string' || !root || typeof target !== 'string' || !target) return false;
  const base = foldPath(resolvePath(root));
  const full = foldPath(resolvePath(target));
  if (full === base) return true;
  return full.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** 注入的扩展名清单（可覆盖），统一成小写带点的形式；空清单退回默认。 */
function allowedExtensionsOf(localFiles) {
  const raw = Array.isArray(localFiles?.allowedExtensions) && localFiles.allowedExtensions.length
    ? localFiles.allowedExtensions
    : DEFAULT_LOCAL_FILE_EXTENSIONS;
  const list = raw
    .filter(extension => typeof extension === 'string' && extension.trim())
    .map(extension => {
      const value = extension.trim().toLowerCase();
      return value.startsWith('.') ? value : `.${value}`;
    });
  return list.length ? list : DEFAULT_LOCAL_FILE_EXTENSIONS.slice();
}

async function realpathOrNull(path) {
  try { return await realpath(path); } catch { return null; }
}

/**
 * 目标可能还不存在（写错的路径也会走到这里），所以要沿最近的已存在祖先取真实路径：
 * 这样路径里任何一段 symlink / junction 都会在 realpath 里暴露出来，不可能借链接逃到根外。
 * @returns {Promise<{ real: string, exists: boolean } | null>} null = 连根都没有（无法解析）
 */
async function nearestRealAncestor(path) {
  const start = resolvePath(path);
  let probe = start;
  for (;;) {
    const real = await realpathOrNull(probe);
    if (real) return { real, exists: probe === start };
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

/** 形如 `file:` 的字符串（不碰磁盘，只做协议判断）。 */
function isLocalFileUrl(value) {
  if (typeof value !== 'string' || !/^file:/i.test(value.trim())) return false;
  try { return new URL(value.trim()).protocol === 'file:'; } catch { return false; }
}

/**
 * 本地文件导航的**唯一**判定点（`PageTarget.navigate()`、渲染层地址栏之外的一切入口共用）。
 *
 * 拿到的判定顺序（顺序本身是安全要求，别调换）：
 * 1. 没有注入 `localFiles` → `blocked-url`，与放开这条能力之前一字不差（默认关闭）；
 * 2. `fileURLToPath()`：正确处理 `C:/…` 盘符与百分号编码，解不出来就按根外处理；
 * 3. 扩展名白名单（在磁盘访问之前判，根外路径连 I/O 都不会发生）；
 * 4. realpath（symlink/junction 解析）+ 最近的已存在祖先（目标不存在时也判得出归属）；
 * 5. 必须落在 `localFiles.roots()` 的某个已登记根内（Windows 大小写不敏感）；
 * 6. 必须存在且是普通文件；加载时用真实路径构造 URL。
 *
 * 错误码刻意与 `blocked-url` 区分：`file_outside_roots` / `file_type_not_allowed` / `file_not_found`。
 * 根外、类型不对的错误文案里**没有**目标路径（避免把用户磁盘结构带进模型上下文）。
 *
 * @param {string|URL} url
 * @param {{ allowedExtensions?: string[], roots: () => Promise<string[]> } | null} localFiles
 * @returns {Promise<{ href: string, path: string }>}
 */
async function resolveLocalFileTarget(url, localFiles) {
  if (!localFiles) throw codedError('blocked-url', 'only http(s) navigation is allowed');
  let absolute;
  try {
    absolute = fileURLToPath(url instanceof URL ? url : new URL(url));
  } catch {
    throw codedError('file_outside_roots', FILE_OUTSIDE_MESSAGE);
  }
  const target = resolvePath(absolute);
  const extension = extname(target).toLowerCase();
  const extensions = allowedExtensionsOf(localFiles);
  if (!extension || !extensions.includes(extension)) {
    throw codedError(
      'file_type_not_allowed',
      `这种本地文件不能在浏览器里打开（允许的扩展名：${extensions.join(' ')}）`,
    );
  }
  const probe = await nearestRealAncestor(target);
  // 连一个已存在的祖先都解析不出来（盘符不存在 / 整条路径不可达）：无法证明它在根内，
  // 按根外失败关闭，并且**不带**路径（这里还没验证过归属）。
  if (!probe) throw codedError('file_outside_roots', FILE_OUTSIDE_MESSAGE);
  let roots = [];
  try { roots = await localFiles.roots(); } catch { roots = []; }
  const list = Array.isArray(roots) ? roots.filter(root => typeof root === 'string' && root.trim()) : [];
  let inside = false;
  for (const root of list) {
    const realRoot = await realpathOrNull(root);
    // 根自己也可能是 junction（如 %TEMP% 的 8.3 短名）：真实路径与字面路径都算它。
    if (insidePath(realRoot || root, probe.real) || insidePath(root, probe.real)) { inside = true; break; }
  }
  if (!inside) throw codedError('file_outside_roots', FILE_OUTSIDE_MESSAGE);
  if (!probe.exists) throw codedError('file_not_found', `找不到这个本地文件：${absolute}`);
  const info = await stat(probe.real).catch(() => null);
  if (!info || !info.isFile()) throw codedError('file_not_found', `不是一个普通文件：${absolute}`);
  return { href: pathToFileURL(probe.real).href, path: probe.real };
}

function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`timeout: ${code}`);
        error.code = code;
        reject(error);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class PageTarget {
  constructor({ guest, tabId, spaceId, visible = true, downloadsDir = null, getTransferPrefs = null, openPath = null, localFiles = null }) {
    if (!guest || typeof guest.isDestroyed !== 'function') throw new TypeError('guest is required');
    this.guest = guest;
    this.tabId = tabId;
    this.spaceId = spaceId;
    this.visible = visible;
    this.lock = 'agent';
    this.internalInput = false;
    this.internalInputUntil = 0;
    this.onUserInput = null;
    this.cdp = createCdp(guest);
    this.snapshots = createSnapshotEngine(this.cdp);
    this.disposed = false;
    this.trace = [];
    this.dialog = null;
    this.lastDialog = null;
    this.dialogPolicy = null;
    this.downloadsDir = downloadsDir;
    // 下载策略每次现读设置：改「阻止可执行 / 下载后打开」不需要重建标签页。
    this.getTransferPrefs = getTransferPrefs;
    this.openPath = openPath;
    // 本地文件白名单：null = 没注入 = 依旧只允许 http(s)（默认关闭，回归锁在 tests/ 里）。
    this.localFiles = localFiles;
    this.lastDownload = null;
    this.downloadItem = null;
    this.downloadPromise = null;
    this.downloadResolve = null;
    this.onNavigated = () => { this.snapshots.reset(); this.pointerView = undefined; };
  }

  static async create(options) {
    const target = new PageTarget(options);
    await target.init();
    return target;
  }

  async init() {
    await this.cdp.attach();
    await this.cdp.enable();
    this.guest.on('did-navigate', this.onNavigated);
    this.guest.on('did-navigate-in-page', this.onNavigated);
    const userInput = () => {
      if (this.lock !== 'agent' || this.internalInput || Date.now() < this.internalInputUntil) return;
      this.onUserInput?.();
    };
    this.guest.on('before-input-event', (_event, input) => {
      if (input?.type === 'keyDown' || input?.type === 'char') userInput();
    });
    this.guest.on('before-mouse-event', (_event, mouse) => {
      // Hover/move is not a takeover; only a real click is.
      if (mouse?.type === 'mouseDown') userInput();
    });
    this.cdp.on((method, params) => {
      if (method === 'Page.javascriptDialogOpening') this.onDialog(params);
      if (method === 'Page.javascriptDialogClosed') { this.dialog = null; }
    });
    return this;
  }

  onDialog(params = {}) {
    this.dialog = {
      type: params.type || 'alert',
      message: String(params.message || '').slice(0, 500),
      defaultPrompt: String(params.defaultPrompt || '').slice(0, 500),
      url: params.url || this.url,
    };
    // Alerts are informational; confirm/prompt are dismissed by default so a
    // page can never freeze the agent. A one-shot arm() lets the caller choose
    // accept for the next dialog instead.
    const policy = this.dialogPolicy || (this.dialog.type === 'alert' || this.dialog.type === 'beforeunload' ? 'accept' : 'dismiss');
    this.dialogPolicy = null;
    this.handleDialog(policy === 'accept' ? 'accept' : 'dismiss').catch(() => {});
  }

  armDialog(policy = 'accept') {
    this.dialogPolicy = policy === 'accept' ? 'accept' : 'dismiss';
    return { ok: true, armed: this.dialogPolicy };
  }

  handleDownload(item) {
    const filename = item.getFilename();
    const prefs = this.getTransferPrefs?.() ?? {};
    // 默认仍然拦截可执行文件；只有用户显式关掉「阻止可执行文件」才放行。
    const blockExecutables = prefs.blockExecutables !== false;
    if (!this.downloadsDir || (blockExecutables && isBlocked(filename))) {
      try { item.cancel(); } catch { /* already gone */ }
      this.lastDownload = { filename, state: 'blocked', reason: this.downloadsDir ? 'executable' : 'no-directory' };
      this.downloadResolve?.(this.lastDownload);
      return this.lastDownload;
    }
    const path = uniquePath(this.downloadsDir, filename);
    this.downloadItem = item;
    this.lastDownload = { filename, path, state: 'started', bytes: 0 };
    this.downloadPromise = new Promise(resolve => { this.downloadResolve = resolve; });
    try { item.setSavePath(path); } catch {
      this.lastDownload = { filename, state: 'failed', reason: 'save-path' };
      this.downloadResolve?.(this.lastDownload);
      return this.lastDownload;
    }
    item.once('done', (_event, state) => {
      const record = { filename, path, state, bytes: item.getReceivedBytes() };
      this.lastDownload = record;
      // 下载完成后是否打开由设置决定；失败或被取消时不打开。
      if (state === 'completed' && prefs.openAfterDownload === true) {
        void this.openDownloaded(path);
      }
      this.downloadResolve?.(record);
    });
    return this.lastDownload;
  }

  /** 交给外壳打开文件；主进程没注入 openPath 时静默跳过，不影响下载本身。 */
  async openDownloaded(path) {
    try { await this.openPath?.(path); } catch { /* 打不开不是下载失败 */ }
  }

  async settleDownload(ms = 8000) {
    if (!this.downloadItem) return null;
    const started = Date.now();
    while (this.downloadItem.getState() === 'progressing' && Date.now() - started < ms) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const state = this.downloadItem.getState();
    this.lastDownload = {
      filename: this.lastDownload?.filename || this.downloadItem.getFilename(),
      path: this.lastDownload?.path || this.downloadItem.getSavePath(),
      state,
      bytes: this.downloadItem.getReceivedBytes(),
    };
    return this.lastDownload;
  }

  async handleDialog(action = 'accept', promptText = '') {
    if (!this.dialog) return { ok: false, code: 'no-dialog', last: this.lastDialog };
    // Page.javascriptDialogClosed can fire while the command is in flight and
    // clear this.dialog; keep a local copy for the result.
    const dialog = { ...this.dialog };
    const accept = action !== 'dismiss';
    try {
      await this.cdp.send('Page.handleJavaScriptDialog', {
        accept,
        ...(accept && typeof promptText === 'string' && promptText ? { promptText } : {}),
      }, 5000);
    } catch (error) {
      return { ok: false, code: 'dialog-failed', message: error?.message || 'dialog failed', dialog };
    }
    this.lastDialog = { ...dialog, handled: accept ? 'accepted' : 'dismissed' };
    this.dialog = null;
    return { ok: true, ...this.lastDialog };
  }

  assertAgent() {
    if (this.lock === 'human') {
      throw Object.assign(new Error('用户正在操作浏览器，请等待或调用 browser_handoff'), { code: 'human-in-control' });
    }
  }

  get url() { return this.guest.getURL(); }
  get title() { return this.guest.getTitle(); }

  setVisible(value) {
    this.visible = value === true;
    if (this.visible && !this.guest.isDestroyed()) this.guest.invalidate();
  }

  async waitForLoad(timeout = 15000) {
    if (this.guest.isLoading() === false) return;
    await new Promise((resolve, reject) => {
      let timer;
      const finish = () => { clearTimeout(timer); cleanup(); resolve(); };
      const fail = (_event, code, description, failedUrl, isMainFrame) => {
        if (isMainFrame === false) return;
        clearTimeout(timer);
        cleanup();
        reject(Object.assign(new Error(description || 'load failed'), { code: 'navigation-failed' }));
      };
      const cleanup = () => {
        this.guest.removeListener('did-finish-load', finish);
        this.guest.removeListener('did-fail-load', fail);
      };
      this.guest.once('did-finish-load', finish);
      this.guest.on('did-fail-load', fail);
      timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('load timeout'), { code: 'navigation-timeout' })); }, timeout);
    });
  }

  async navigate(url, options = {}) {
    if (this.disposed) throw Object.assign(new Error('target disposed'), { code: 'disposed' });
    this.assertAgent();
    let parsed;
    try { parsed = new URL(url); } catch { throw Object.assign(new Error('invalid url'), { code: 'invalid-url' }); }
    // 判定顺序：http(s) 原样走；file: 交给唯一入口（未注入 localFiles 时仍是 blocked-url）；
    // 其余 scheme（javascript: / data: / blob: …）照旧一律拒绝。
    let href = parsed.href;
    if (parsed.protocol === 'file:') {
      href = (await resolveLocalFileTarget(parsed, this.localFiles)).href;
    } else if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw Object.assign(new Error('only http(s) navigation is allowed'), { code: 'blocked-url' });
    }
    const timeout = Number.isInteger(options.timeout) ? options.timeout : 30000;
    const startedAt = Date.now();
    this.lastDialog = null;
    this.lastDownload = null;
    this.downloadItem = null;
    this.downloadPromise = null;
    try {
      await withTimeout(this.guest.loadURL(href), timeout, 'navigation-timeout');
    } catch (error) {
      if (error.code) throw error;
      throw Object.assign(new Error(error?.message || 'navigation failed'), { code: 'navigation-failed' });
    }
    const loadMs = Date.now() - startedAt;
    this.snapshots.reset();
    this.recordTrace({ op: 'navigate', url: this.url });
    return {
      url: this.url,
      title: this.title,
      timing: { loadMs },
      ...(this.lastDialog ? { dialog: this.lastDialog } : {}),
      ...(this.lastDownload ? { download: this.lastDownload } : {}),
    };
  }

  snapshot(options = {}) {
    return this.snapshots.take({ url: this.url, title: this.title, ...options });
  }

  read(options = {}) {
    return readPage(this.cdp, options);
  }

  wait(condition = {}) {
    if (condition.for === 'download') return this.waitForDownload(condition);
    return waitFor(this.cdp, condition);
  }

  /**
   * 下载是主进程事件，不是页面条件：只能在这里观察。
   * 「阻止可执行文件 / 保存失败」是确定的终态，直接返回记录，让模型看清 state，
   * 不要把它伪装成超时。
   */
  async waitForDownload(condition = {}) {
    const timeout = Math.max(100, Math.min(60000, Number(condition.timeout) || 15000));
    const started = Date.now();
    const terminal = state => Boolean(state) && state !== 'progressing' && state !== 'started';
    for (;;) {
      const state = this.downloadItem?.getState?.() || this.lastDownload?.state;
      if (terminal(state)) {
        return { ok: true, ms: Date.now() - started, condition: 'download', download: this.lastDownload, state };
      }
      if (Date.now() - started >= timeout) {
        const error = Object.assign(new Error('download wait timeout'), { code: 'download-timeout' });
        error.detail = { condition: 'download', state, ms: Date.now() - started };
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async withInternal(operation) {
    this.internalInput = true;
    try { return await operation(); }
    finally {
      this.internalInput = false;
      this.internalInputUntil = Date.now() + 1500;
    }
  }

  async pointer(input, signal) {
    this.assertAgent();
    if (!this.visible || !this.pointerView || this.pointerView.id !== input.viewId) throw new Error('Take a fresh viewport screenshot of the visible page.');
    const { getPointerViewport, dispatchPointer, pointerPoints } = await import('../../edge-extension/pointer.js');
    const send = (method, params) => this.cdp.send(method, params);
    const viewport = await getPointerViewport(send);
    const view = this.pointerView;
    if (!view || view.id !== input.viewId || JSON.stringify(view.viewport) !== JSON.stringify(viewport)) {
      throw new Error('The viewport changed. Take a fresh browser_screenshot.');
    }
    await this.snapshot({ mode: 'full' });
    const { from, to } = pointerPoints(input, viewport);
    const hits = await this.evaluate(`(${JSON.stringify([from, to])}).map(({x,y}) => {
      const el = document.elementFromPoint(x, y);
      const control = el?.closest('a,button,input,select,textarea,[role=button],[role=link]') || el;
      return {
        blocked: !control || control.matches('iframe,frame,input[type=password],input[type=file],[autocomplete="one-time-code"]'),
        label: (control?.getAttribute('aria-label') || control?.innerText || control?.title || '').slice(0, 140),
      };
    })`);
    if (hits.some(hit => hit.blocked || handoffReasonOf(hit.label))) {
      return { ok: false, status: 'requires-handoff', message: 'This target requires manual control.' };
    }
    const outcome = await this.withInternal(() => dispatchPointer(send, input, viewport, () => {
      signal?.throwIfAborted();
      this.assertAgent();
      if (this.pointerView !== view || !this.visible) throw new Error('The visible page changed.');
    }));
    this.pointerView = undefined;
    const snapshot = await this.snapshot({ mode: 'auto' }).catch(error => ({ mode: 'unavailable', message: error.message }));
    return { ...outcome, snapshot: { mode: snapshot.mode, text: snapshot.text, message: snapshot.message } };
  }

  async act(action = {}) {
    this.assertAgent();
    this.lastDialog = null;
    this.lastDownload = null;
    this.downloadItem = null;
    this.downloadPromise = null;
    const op = action.action || action.op;
    if (!op) throw Object.assign(new Error('action is required'), { code: 'invalid-argument' });
    let outcome;
    const phases = {};
    let phaseAt = Date.now();
    this.internalInput = true;
    try {
      switch (op) {
        case 'click':
          outcome = await actions.click(this.cdp, action.target, { clickCount: action.clickCount });
          break;
        case 'fill':
          outcome = await actions.fill(this.cdp, action.target, action.value ?? '', { slowly: false });
          break;
        case 'type':
          outcome = await actions.fill(this.cdp, action.target, action.value ?? '', { slowly: true });
          break;
        case 'press':
          outcome = await actions.press(this.cdp, action.value || action.key);
          break;
        case 'select':
          outcome = await actions.fill(this.cdp, action.target, action.value ?? '', { slowly: false });
          break;
        case 'check':
          outcome = await actions.check(this.cdp, action.target, !(action.value === false || action.value === 'false' || action.value === 'unchecked'));
          break;
        case 'hover':
          outcome = await actions.hover(this.cdp, action.target);
          break;
        case 'scroll':
          outcome = await actions.scroll(this.cdp, action.target, action.value);
          break;
        default:
          throw Object.assign(new Error(`unsupported action: ${op}`), { code: 'invalid-argument' });
      }
      if (action.submit === true) await actions.press(this.cdp, 'Enter');
    } finally {
      this.internalInput = false;
      this.internalInputUntil = Date.now() + 1500;
    }
    phases.actionMs = Date.now() - phaseAt;
    phaseAt = Date.now();

    if (action.expect) {
      const expect = { ...action.expect };
      expect.for = expect.for || (expect.selector ? 'selector' : expect.text ? 'text' : expect.url ? 'url' : 'load');
      expect.timeout = expect.timeout || 3000;
      try {
        await this.wait(expect);
      } catch (error) {
        error.code = 'expect-failed';
        error.detail = { ...(error.detail || {}), expect };
        throw error;
      }
    }

    // will-download 是比点击晚一个 tick 的事件，这里只等一个协议 tick（20 ms），
    // 不是固定等待页面稳定：页面稳定用下面的条件等待判断。
    await new Promise(resolve => setTimeout(resolve, 20));
    await this.settleDownload();
    // 用「DOM/动画/图片稳定」替代固定 120 ms。页面一直在动时不让动作失败，
    // diff 仍然有用，只是标注 settled:false。
    let settled = true;
    try {
      await this.wait({ for: 'settle', quietMs: 100, timeout: 1200 });
    } catch { settled = false; }
    phases.settleMs = Date.now() - phaseAt;
    phaseAt = Date.now();
    let diff = null;
    let snapshotMode = null;
    if (action.snapshot !== false) {
      const after = await this.snapshot({ mode: 'auto' });
      snapshotMode = after.mode;
      if (after.mode === 'diff') diff = after.text;
    }
    phases.snapshotMs = Date.now() - phaseAt;
    phases.totalMs = phases.actionMs + phases.settleMs + phases.snapshotMs;
    const fillValue = (op === 'fill' || op === 'type') && typeof action.value === 'string'
      && outcome?.element?.type !== 'password';
    this.recordTrace({
      op,
      selector: outcome?.element?.selector || action.target,
      ...(op === 'press' ? { key: action.value } : {}),
      ...(op === 'fill' || op === 'type' ? { valueLength: String(action.value || '').length } : {}),
      ...(fillValue && action.value ? { value: action.value, saveValue: true } : {}),
    });
    return {
      ...outcome,
      ...(diff ? { diff } : {}),
      snapshotMode,
      settled,
      timing: phases,
      ...(this.lastDialog ? { dialog: this.lastDialog } : {}),
      ...(this.lastDownload ? { download: this.lastDownload } : {}),
    };
  }

  recordTrace(action) {
    if (!action || typeof action !== 'object') return;
    this.trace.push({ ...action, ts: Date.now() });
    if (this.trace.length > 50) this.trace.splice(0, this.trace.length - 50);
  }

  async upload(action = {}) {
    this.assertAgent();
    let result;
    try {
      result = await actions.upload(this.cdp, action.target, action.files || []);
    } catch (error) {
      if (error?.code !== 'target-not-found') throw error;
      result = await actions.uploadViaChooser(this.cdp, action.target, action.files || []);
    }
    this.recordTrace({ op: 'upload', selector: result.element?.selector || action.target });
    return result;
  }

  async evaluate(expression, options = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, Number.isInteger(options.timeout) ? options.timeout : 10000);
    if (result.exceptionDetails) {
      throw Object.assign(new Error(result.exceptionDetails.text || 'evaluation failed'), { code: 'evaluate-failed' });
    }
    return result.result?.value;
  }

  async screenshot(options = {}) {
    if (this.disposed) throw Object.assign(new Error('target disposed'), { code: 'disposed' });
    if (!this.visible) throw Object.assign(new Error('tab is not visible'), { code: 'tab-not-visible' });
    if (options.windowVisible === false) {
      throw Object.assign(new Error('window is not visible'), { code: 'window-not-visible' });
    }
    if (!options.fullPage) {
      try {
        const image = await withTimeout(this.guest.capturePage(), SCREENSHOT_TIMEOUT, 'screenshot-timeout');
        return { buffer: image.toPNG(), width: image.getSize().width, height: image.getSize().height, fullPage: false };
      } catch {
        // capturePage can throw UnknownVizError when the compositor has not
        // produced a frame yet; CDP is the fallback, but it hangs on invisible
        // pages, so keep the same timeout and report a stable code.
        try {
          const shot = await withTimeout(this.cdp.send('Page.captureScreenshot', { format: 'png' }, SCREENSHOT_TIMEOUT), SCREENSHOT_TIMEOUT, 'screenshot-timeout');
          return { buffer: Buffer.from(shot.data, 'base64'), width: 0, height: 0, fullPage: false };
        } catch {
          const failure = new Error('screenshot failed: page is not painted yet');
          failure.code = 'screenshot-failed';
          throw failure;
        }
      }
    }
    const metrics = await this.cdp.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size) throw Object.assign(new Error('no layout metrics'), { code: 'screenshot-failed' });
    const height = Math.min(MAX_FULL_HEIGHT, Math.ceil(size.height));
    const shot = await withTimeout(this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height, scale: 1 },
    }, SCREENSHOT_TIMEOUT), SCREENSHOT_TIMEOUT, 'screenshot-timeout');
    const buffer = Buffer.from(shot.data, 'base64');
    return { buffer, width: Math.ceil(size.width), height, fullPage: true };
  }

  info() {
    return {
      tabId: this.tabId,
      spaceId: this.spaceId,
      url: this.url,
      title: this.title,
      visible: this.visible,
      loading: this.guest.isLoading(),
    };
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.guest.removeListener('did-navigate', this.onNavigated);
      this.guest.removeListener('did-navigate-in-page', this.onNavigated);
    } catch { /* guest may already be gone */ }
    this.cdp.detach();
  }
}

module.exports = {
  PageTarget,
  withTimeout,
  SCREENSHOT_TIMEOUT,
  DEFAULT_LOCAL_FILE_EXTENSIONS,
  FILE_OUTSIDE_MESSAGE,
  resolveLocalFileTarget,
  isLocalFileUrl,
  insidePath,
};
