'use strict';
// Owns the browser targets for one Mova window. The renderer creates one
// <webview> per tab and reports tabReady/tabActive; this controller maps guest
// ids to tab ids and keeps exactly one active target. Spaces are still one
// default space; the tab shape is already in place.

const { mkdirSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { nativeImage } = require('electron');
const { stat } = require('node:fs/promises');
const { isAbsolute, join } = require('node:path');
const { PageTarget, resolveLocalFileTarget, isLocalFileUrl } = require('./target.cjs');
const { createBrowserTools } = require('./tools.cjs');
const { runBatch } = require('./batch.cjs');
const { createSerialQueue } = require('./serial.cjs');
const { runJavaScript } = require('./run-js.cjs');
const { createInspectSession } = require('./inspect.cjs');
const { stepsFromTrace, patternOf, originOf, fingerprintOf } = require('./procedures.cjs');
const { markIndeterminate } = require('./timing.cjs');

const ENSURE_TIMEOUT = 15000;
/** 站点技能候选门槛：少于 3 步的流程不值得留存。 */
const MIN_CANDIDATE_STEPS = 3;

function coded(code, message, detail) {
  const error = new Error(message || code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

/**
 * 站点技能候选：只描述「这次流程值得保存」，**不落盘**。
 * 是否真的保存由模型调用 browser_skill({action:'save'}) 决定（§3.13 / §4.8）。
 * 返回 null 的三种情况：步数不足、不是 http(s) 页面、库里已有同指纹技能。
 */
function skillCandidateOf({ trace, url, title, existing } = {}) {
  const steps = stepsFromTrace(Array.isArray(trace) ? trace : []);
  if (steps.length < MIN_CANDIDATE_STEPS) return null;
  const origin = originOf(url);
  if (!origin) return null;
  const fingerprint = fingerprintOf(steps);
  const rows = Array.isArray(existing) ? existing : [];
  const duplicate = rows.some(item => item && item.origin === origin && item.fingerprint === fingerprint);
  if (duplicate) return null;
  const pathPattern = patternOf(url);
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    origin,
    pathPattern,
    title: cleanTitle || pathPattern,
    stepCount: steps.length,
  };
}

function createBrowserController({ app, getWindow, credentials = null, procedures = null, cards = null, memoryMirror = null, downloadsDir = null, storageState = null, loginRecords = null, settings = null, getSession = null, openPath = null, humanWait = null, localFiles = null, logger = console } = {}) {
  const targets = new Map();
  const byGuest = new Map();
  const pendingReady = new Map();
  const spaceTabs = new Map();
  const pendingSpaces = new Map();
  const pendingTabs = new Map();
  const downloadSessions = new Set();
  let activeTabId = null;
  let activeSpaceId = 'default';
  let sequence = 0;
  const handoffs = new Map();
  const targetQueues = new WeakMap();
  const spaceQueues = new Map();
  let handoffSequence = 0;
  let passiveSequence = 0;

  /** 每个 target 最多一个注入会话（WeakMap：标签页关闭后自然释放）。 */
  const inspectSessions = new WeakMap();
  /** 当前正在进行「选择元素」的目标；同时只允许一个。 */
  let inspectActive = null;
  /** 最近一次建立注入会话的目标（选区监听可能一直挂着，停的时候要一并撤掉）。 */
  let inspectLast = null;

  /**
   * 设置每次调用时现读：改设置不需要重启浏览器，也不会缓存两份真相。
   * 缺失时回退到传入的静态值，保持旧行为。
   */
  const prefs = () => {
    try { return settings?.read() ?? null; } catch { return null; }
  };
  const transferPrefs = () => prefs()?.transfer ?? {};
  const advancedPrefs = () => prefs()?.advanced ?? {};
  const currentDownloadsDir = () => {
    const dir = transferPrefs().downloadDir;
    return dir || downloadsDir;
  };
  const currentActionTimeout = () => advancedPrefs().actionTimeoutMs;
  const currentWaitTimeout = () => advancedPrefs().waitTimeoutMs;
  const currentSnapshotBudget = () => advancedPrefs().snapshotBudget;
  const currentDiffThreshold = () => advancedPrefs().diffThreshold;
  /** 记录范围：'all' 时跨对话复用，否则按传入的会话标识隔离。 */
  const scopeOf = conversationId => (prefs()?.login?.recordScope === 'all' ? null : conversationId);

  function withTarget(target, operation) {
    let queue = targetQueues.get(target);
    if (!queue) { queue = createSerialQueue(); targetQueues.set(target, queue); }
    return queue(operation);
  }

  function withLockedTarget(target, operation) {
    if (target.lock === 'human') {
      throw coded('human-in-control', '用户正在操作浏览器，请等待接管结束后重试', { spaceId: target.spaceId });
    }
    const spaceId = target.spaceId || 'default';
    let queue = spaceQueues.get(spaceId);
    if (!queue) { queue = createSerialQueue(); spaceQueues.set(spaceId, queue); }
    return queue(async () => {
      // 上一次动作超时后，页面里的动作可能还在跑。等它收尾再开始下一个，
      // 否则两个动作会叠在同一页面上，产生无法解释的结果。
      if (target.ghost) {
        try { await target.ghost; } catch { /* 迟到的失败已经报告过了 */ }
        target.ghost = null;
      }
      return withTarget(target, operation);
    });
  }

  function window() {
    return typeof getWindow === 'function' ? getWindow() : null;
  }

  function current(spaceId) {
    if (spaceId) {
      const tabId = spaceTabs.get(spaceId);
      const target = tabId ? targets.get(tabId) : null;
      if (target) return target;
      return [...targets.values()].find(candidate => candidate.spaceId === spaceId) || null;
    }
    return activeTabId ? targets.get(activeTabId) || null : null;
  }

  function applyTabId(target, tabId) {
    if (!target || !tabId || target.tabId === tabId) return;
    const previous = target.tabId;
    targets.delete(previous);
    target.tabId = tabId;
    targets.set(tabId, target);
    if (activeTabId === previous) activeTabId = tabId;
    for (const [spaceId, currentTabId] of spaceTabs.entries()) {
      if (currentTabId === previous) spaceTabs.set(spaceId, tabId);
    }
  }

  function settleSpace(spaceId, target) {
    const waiter = pendingSpaces.get(spaceId);
    if (!waiter) return;
    pendingSpaces.delete(spaceId);
    clearTimeout(waiter.timer);
    waiter.resolve(target);
  }

  function settleTab(tabId, target) {
    const waiter = pendingTabs.get(tabId);
    if (!waiter) return;
    pendingTabs.delete(tabId);
    clearTimeout(waiter.timer);
    waiter.resolve(target);
  }

  function waitForSpace(spaceId, code = 'browser-unavailable') {
    const existing = pendingSpaces.get(spaceId);
    if (existing) return existing.promise;
    const entry = { promise: null, resolve: null, reject: null, timer: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(() => {
        pendingSpaces.delete(spaceId);
        // 诊断信息：区分「渲染层一个标签页都没上报」和「上报了别的 space」。
        reject(coded(code, 'browser tab did not become ready', {
          spaceId,
          targets: targets.size,
          spaces: [...spaceTabs.keys()],
          pendingSpaces: [...pendingSpaces.keys()],
          hint: targets.size
            ? '标签页已注册但不在请求的 space 里'
            : '渲染层没有任何标签页上报：检查分屏是否打开、webview 是否挂载为 guest',
        }));
      }, ENSURE_TIMEOUT);
    });
    pendingSpaces.set(spaceId, entry);
    return entry.promise;
  }

  function waitForTab(tabId, code = 'tab-not-found') {
    const existing = pendingTabs.get(tabId);
    if (existing) return existing.promise;
    const entry = { promise: null, resolve: null, reject: null, timer: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(() => {
        pendingTabs.delete(tabId);
        reject(coded(code, 'tab did not become active', { tabId }));
      }, 5000);
    });
    pendingTabs.set(tabId, entry);
    return entry.promise;
  }

  function wireDownloads(guest) {
    const targetSession = guest.session;
    if (!currentDownloadsDir() || downloadSessions.has(targetSession)) return;
    downloadSessions.add(targetSession);
    targetSession.on('will-download', (_event, item, webContents) => {
      const target = [...targets.values()].find(candidate => candidate.guest.id === webContents?.id) || current();
      if (!target) { try { item.cancel(); } catch { /* gone */ } return; }
      target.handleDownload(item);
    });
  }

  async function registerGuest(guest) {
    if (!guest || guest.isDestroyed()) return null;
    if (byGuest.has(guest.id)) return byGuest.get(guest.id);
    const tabId = `t${++sequence}`;
    const target = await PageTarget.create({ guest, tabId, spaceId: 'default', visible: true, downloadsDir: currentDownloadsDir(), getTransferPrefs: transferPrefs, openPath, localFiles });
    target.onUserInput = () => beginPassiveTakeover(target);
    wireDownloads(guest);
    targets.set(tabId, target);
    byGuest.set(guest.id, target);
    if (!activeTabId) activeTabId = tabId;
    const reported = pendingReady.get(guest.id);
    if (reported) {
      pendingReady.delete(guest.id);
      applyTabId(target, reported.tabId);
      if (typeof reported.spaceId === 'string' && reported.spaceId) target.spaceId = reported.spaceId;
      if (!spaceTabs.has(target.spaceId)) spaceTabs.set(target.spaceId, target.tabId);
      settleSpace(target.spaceId, target);
      settleTab(target.tabId, target);
    }
    if (!activeTabId) { activeTabId = target.tabId; activeSpaceId = target.spaceId; }
    return target;
  }

  function tabReady(tabId, guestId, spaceId) {
    if (typeof tabId !== 'string' || !Number.isInteger(guestId)) return false;
    const target = byGuest.get(guestId);
    if (!target) { pendingReady.set(guestId, { tabId, spaceId }); return false; }
    applyTabId(target, tabId);
    if (typeof spaceId === 'string' && spaceId) target.spaceId = spaceId;
    if (!spaceTabs.has(target.spaceId)) spaceTabs.set(target.spaceId, tabId);
    if (!activeTabId || activeTabId === tabId) { activeTabId = tabId; activeSpaceId = target.spaceId; }
    settleSpace(target.spaceId, target);
    settleTab(tabId, target);
    return true;
  }

  function tabActive(tabId, spaceId) {
    if (typeof tabId !== 'string') return false;
    activeTabId = tabId;
    if (typeof spaceId === 'string' && spaceId) activeSpaceId = spaceId;
    const target = targets.get(tabId);
    if (target) {
      activeSpaceId = target.spaceId;
      spaceTabs.set(target.spaceId, tabId);
      settleSpace(target.spaceId, target);
      settleTab(tabId, target);
    }
    for (const candidate of targets.values()) candidate.setVisible(candidate.tabId === tabId);
    return Boolean(target);
  }

  function tabCleared(spaceId) {
    if (typeof spaceId !== 'string' || !spaceId) return false;
    activeSpaceId = spaceId;
    activeTabId = null;
    spaceTabs.delete(spaceId);
    for (const target of targets.values()) target.setVisible(false);
    return true;
  }

  function tabClosed(tabId) {
    const target = targets.get(tabId);
    if (!target) return false;
    targets.delete(tabId);
    byGuest.delete(target.guest.id);
    if (spaceTabs.get(target.spaceId) === tabId) spaceTabs.delete(target.spaceId);
    if (activeTabId === tabId) activeTabId = null;
    void disposeInspect(target);
    settleTab(tabId, target);
    void target.close();
    return true;
  }

  function ensure(spaceId, url) {
    if (prefs()?.basics?.enabled === false) {
      return Promise.reject(coded('browser-disabled', '内置浏览器已在设置中关闭'));
    }
    const targetSpace = spaceId || activeSpaceId;
    const target = current(targetSpace);
    if (target) return Promise.resolve(target);
    const win = window();
    if (!win || win.isDestroyed()) return Promise.reject(coded('no-window', 'Mova window is not available'));
    if (!url) return Promise.reject(coded('browser-not-open', 'Open a page in the side browser first, or call browser_navigate with a URL', { spaceId: targetSpace }));
    const waiter = waitForSpace(targetSpace);
    try {
      win.webContents.send('browser:tab:new', { url, spaceId: targetSpace, background: targetSpace !== activeSpaceId });
    } catch (error) {
      const pending = pendingSpaces.get(targetSpace);
      if (pending) { clearTimeout(pending.timer); pendingSpaces.delete(targetSpace); pending.reject(coded('browser-unavailable', error?.message || 'cannot open the browser panel')); }
    }
    return waiter;
  }

  async function newTab(url, spaceId = activeSpaceId, options = {}) {
    const targetSpace = spaceId || activeSpaceId;
    const win = window();
    if (!win || win.isDestroyed()) throw coded('no-window', 'Mova window is not available');
    // 本地文件（file:）不能当 webview 的初始 src：主进程的 will-attach-webview 只放行 http(s)。
    // 所以先过「同一个」判定（target.cjs 的 resolveLocalFileTarget），再建一个普通标签页，
    // 最后走 target.navigate() 的加载路径——判定只有一处，这里不另写规则。
    const local = isLocalFileUrl(url) ? await resolveLocalFileTarget(url, localFiles) : null;
    const waiter = waitForSpace(targetSpace, 'browser-unavailable');
    try {
      win.webContents.send('browser:tab:new', {
        url: local ? undefined : url,
        spaceId: targetSpace,
        background: options.background === true || targetSpace !== activeSpaceId,
      });
    } catch (error) {
      const pending = pendingSpaces.get(targetSpace);
      if (pending) { clearTimeout(pending.timer); pendingSpaces.delete(targetSpace); pending.reject(coded('browser-unavailable', error?.message || 'cannot create tab')); }
    }
    const target = await waiter;
    if (local) await target.navigate(local.href);
    return target;
  }

  async function selectTab(tabId) {
    const win = window();
    if (!win || win.isDestroyed()) throw coded('no-window', 'Mova window is not available');
    const target = targets.get(tabId);
    if (target) {
      activeTabId = tabId;
      activeSpaceId = target.spaceId;
      spaceTabs.set(target.spaceId, tabId);
    }
    win.webContents.send('browser:tab:select', { tabId });
    if (target) return target;
    return waitForTab(tabId);
  }

  function closeTab(tabId) {
    const win = window();
    if (!win || win.isDestroyed()) throw coded('no-window', 'Mova window is not available');
    win.webContents.send('browser:tab:close', { tabId });
    return { ok: true, tabId };
  }

  async function navigate(url, spaceId, options = {}) {
    if (typeof url !== 'string' || !url.trim()) throw coded('invalid-argument', 'url is required');
    let href;
    try { href = new URL(url.trim()).href; } catch { throw coded('invalid-argument', 'invalid url'); }
    // file: 在开标签页之前先过唯一判定：默认关闭（未注入 localFiles 时仍是 blocked-url），
    // 根外/类型不允许都在这里早失败，不留下一个空标签页。
    // 本地文件不能当 webview 的初始 src（will-attach-webview 只放行 http(s)），
    // 所以「有标签页就复用，没有就先建一个普通标签页，再 loadURL」。
    const local = isLocalFileUrl(href) ? await resolveLocalFileTarget(href, localFiles) : null;
    const wanted = local ? local.href : href;
    const target = local
      ? (current(spaceId || activeSpaceId) ? await ensure(spaceId) : await newTab(undefined, spaceId))
      : await ensure(spaceId, href);
    // 导航后直接返回观察结果（P1）：模型最常见的一步是「打开页面再读一次」，
    // 合并成一次调用就少一个完整往返（约 1.5–4 s）。
    const observe = options.observe === 'none' ? 'none' : options.observe === 'full' ? 'full' : 'auto';
    return withLockedTarget(target, async () => {
      const startedAt = Date.now();
      // The panel may already be loading this URL because of browser:ensure.
      // Wait for that navigation instead of issuing a second one.
      await target.waitForLoad(Number.isInteger(options.timeout) ? options.timeout : 10000).catch(() => {});
      const info = target.url === wanted ? { url: target.url, title: target.title } : await target.navigate(wanted, { timeout: options.timeout });
      const loadMs = Date.now() - startedAt;
      let observation = null;
      let observationMs = 0;
      if (observe !== 'none') {
        const observedAt = Date.now();
        // 页面刚加载完往往还在渲染/跳转：先等稳定，再取一次快照。
        // 动画一直不停也不影响结果，只是标记 settled:false。
        let settled = true;
        try { await target.wait({ for: 'settle', quietMs: 150, timeout: 3000 }); } catch { settled = false; }
        try {
          const result = await target.snapshot({
            mode: observe === 'full' ? 'full' : 'auto',
            maxChars: currentSnapshotBudget(),
            threshold: currentDiffThreshold(),
          });
          observation = {
            mode: result.mode,
            text: result.text,
            chars: typeof result.text === 'string' ? result.text.length : 0,
            settled,
            ...(Array.isArray(result.frames) && result.frames.length ? { frames: result.frames } : {}),
            ...(result.truncated ? { truncated: true } : {}),
          };
        } catch (error) {
          observation = { mode: 'unavailable', code: error?.code || 'snapshot-failed', message: error?.message || 'snapshot failed', settled };
        }
        observationMs = Date.now() - observedAt;
      }
      let skills = [];
      if (procedures) {
        try { skills = await procedures.find({ url: target.url }); } catch { /* skills are optional */ }
      }
      let site = null;
      if (cards) {
        try { site = await cards.get(target.url); } catch { /* site cards are optional */ }
      }
      return {
        ok: true,
        ...info,
        tabId: target.tabId,
        timing: { loadMs, observationMs },
        ...(observation ? { observation } : {}),
        ...(skills.length ? { skills } : {}),
        ...(site ? { site: { landmarks: site.landmarks, notes: site.notes, visits: site.visits } } : {}),
      };
    });
  }

  async function snapshot(options = {}, spaceId) {
    const target = await ensure(spaceId);
    // 预算与 Diff 阈值来自设置；模型显式传参时以模型为准。
    const tuned = {
      ...options,
      maxChars: Number.isInteger(options.maxChars) ? options.maxChars : currentSnapshotBudget(),
      threshold: typeof options.threshold === 'number' ? options.threshold : currentDiffThreshold(),
    };
    return withLockedTarget(target, async () => {
      const result = await target.snapshot(tuned);
      if (cards && Array.isArray(result.entries)) {
        try { await cards.update({ url: result.url || target.url, title: result.title || target.title, entries: result.entries }); } catch { /* best effort */ }
      }
      // 按需采集的元信息必须跟着结果走，否则模型不知道还能再取哪个 frame。
      return {
        ok: true,
        mode: result.mode,
        text: result.text,
        url: result.url,
        title: result.title,
        ...(Array.isArray(result.frames) && result.frames.length ? { frames: result.frames } : {}),
        ...(result.scope ? { scope: result.scope } : {}),
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.crossOrigin ? { crossOrigin: true } : {}),
      };
    });
  }

  async function read(options = {}, spaceId) {
    const target = await ensure(spaceId);
    return withLockedTarget(target, async () => ({ ok: true, ...(await target.read(options)) }));
  }

  async function wait(condition = {}, spaceId) {
    const target = await ensure(spaceId);
    // 等待超时来自设置；模型显式传 timeout 时以模型为准。
    const tuned = { ...condition, timeout: Number.isInteger(condition.timeout) ? condition.timeout : currentWaitTimeout() };
    return withLockedTarget(target, async () => ({ ok: true, ...(await target.wait(tuned)) }));
  }

  async function act(action = {}, spaceId) {
    const target = await ensure(spaceId);
    // 动作超时来自设置：单次动作超过上限就报 action-timeout，不无限等待。
    const limit = currentActionTimeout();
    const tuned = {
      ...action,
      timeoutMs: Number.isInteger(action.timeoutMs) ? action.timeoutMs : limit,
      // 跨域 iframe 兜底：跟着设置走，关闭时动作层会明确拒绝而不是猜坐标。
      iframeFallback: action.iframeFallback !== false && advancedPrefs().iframeFallback !== false,
    };
    return withLockedTarget(target, async () => {
      let timer;
      const inner = target.act(tuned);
      // 超时后 inner 仍可能继续跑；先把 rejection 接住，避免出现未处理拒绝，
      // 同时把它挂到 target.ghost 上，让下一个动作等它收尾（见 withLockedTarget）。
      const guarded = inner.catch(() => {});
      try {
        const result = await Promise.race([
          inner,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const timeoutError = Object.assign(new Error('动作超时'), {
                code: 'action-timeout',
                suggestion: '动作可能已在页面执行但结果未确认：先 browser_snapshot / browser_wait 观察页面，不要直接重复点击。',
              });
              markIndeterminate(timeoutError, {
                mayHaveWritten: true,
                action: tuned.action,
                target: tuned.target || '',
                timeoutMs: Number.isInteger(tuned.timeoutMs) ? tuned.timeoutMs : 8000,
              });
              reject(timeoutError);
            }, Number.isInteger(tuned.timeoutMs) ? tuned.timeoutMs : 8000);
          }),
        ]);
        let visualReason = null;
        if (result.snapshotMode === 'diff' && !result.diff) {
          visualReason = 'diff-empty';
        } else if (result.snapshotMode) {
          try {
            if (await target.evaluate('!!document.querySelector("canvas,video")')) visualReason = 'canvas';
          } catch { /* guest may be navigating */ }
        }
        return { ok: true, ...result, ...(visualReason ? { visualFallbackSuggested: { reason: visualReason, mode: 'thumb' } } : {}) };
      } catch (error) {
        if (error?.code === 'action-timeout') target.ghost = guarded;
        throw error;
      } finally { clearTimeout(timer); }
    });
  }

  async function dialog(input = {}, spaceId) {
    const target = await ensure(spaceId);
    if (input.action === 'arm') return withLockedTarget(target, () => target.armDialog(input.policy || 'accept'));
    return withLockedTarget(target, () => target.handleDialog(input.action || 'accept', input.promptText || ''));
  }

  async function runJs(input = {}, spaceId) {
    const target = await ensure(spaceId);
    return withLockedTarget(target, () => runJavaScript(target, input.script, { timeout: input.timeout }));
  }

  async function storageExport(spaceId) {
    if (!storageState) throw coded('storage-state-unavailable', '当前环境不支持登录态导入导出');
    const target = await ensure(spaceId);
    return withLockedTarget(target, () => storageState.exportState(target));
  }

  async function storageImport(spaceId) {
    if (!storageState) throw coded('storage-state-unavailable', '当前环境不支持登录态导入导出');
    const target = await ensure(spaceId);
    return withLockedTarget(target, () => storageState.importState(target));
  }

  async function hasLoginRecord(origin) {
    if (!loginRecords) return { ok: false, code: 'login-records-unavailable' };
    try { return { ok: true, has: await loginRecords.has(origin) }; }
    catch (error) { return { ok: false, code: error?.code || 'login-records-error', message: error?.message }; }
  }

  async function saveLoginRecord(spaceId, conversationId) {
    if (!loginRecords) throw coded('login-records-unavailable', '登录记录不可用');
    // 「保存 Cookie / localStorage」关掉后不再写入登录态。
    if (prefs()?.login?.saveStorage === false) throw coded('login-records-disabled', '设置中已关闭保存 Cookie');
    const target = await ensure(spaceId);
    const origin = loginRecords.originOf(target.url);
    if (!origin) throw coded('invalid-origin', 'only http(s) pages can remember login');
    return withLockedTarget(target, () => loginRecords.save(origin, target, { conversationId: scopeOf(conversationId) }));
  }

  async function useLoginRecord(origin, spaceId, conversationId) {
    if (!loginRecords) throw coded('login-records-unavailable', '登录记录不可用');
    const target = await ensure(spaceId);
    return withLockedTarget(target, () => loginRecords.apply(origin, target, { conversationId: scopeOf(conversationId) }));
  }

  async function upload(input = {}, spaceId) {
    const target = await ensure(spaceId);
    const files = Array.isArray(input.files) ? input.files.slice(0, 5) : [];
    if (!files.length) throw coded('invalid-argument', 'files are required');
    const checked = [];
    for (const file of files) {
      if (typeof file !== 'string' || !isAbsolute(file)) throw coded('invalid-path', '上传文件必须是绝对路径');
      let info;
      try { info = await stat(file); } catch { throw coded('not-found', `找不到文件：${file}`); }
      if (!info.isFile()) throw coded('not-a-file', `不是文件：${file}`);
      const maxMb = Math.max(1, Math.min(512, Number(prefs()?.transfer?.uploadMaxMb) || 25));
      if (info.size > maxMb * 1024 * 1024) throw coded('file-too-large', `文件超过 ${maxMb} MB：${file}`);
      checked.push(file);
    }
    return withLockedTarget(target, () => target.upload({ target: input.target, files: checked }));
  }

  function applyInputs(steps, inputs = {}) {
    return (Array.isArray(steps) ? steps : []).map(step => {
      const next = { ...step };
      if (typeof next.value === 'string') next.value = next.value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, name) => String(inputs[name] ?? ''));
      if (typeof next.url === 'string') next.url = next.url.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, name) => String(inputs[name] ?? ''));
      return next;
    });
  }

  async function batch(steps, options = {}) {
    const target = await ensure(options.space);
    return withLockedTarget(target, async () => {
      const before = target.trace.length;
      let actualSteps = steps;
      let recipe = null;
      if (options.recipe && procedures) {
        const procedure = await procedures.get(options.recipe);
        actualSteps = applyInputs(procedure.steps, options.inputs);
        recipe = { id: procedure.id, title: procedure.title };
        options = { ...options, recipeId: procedure.id };
      }
      const result = await runBatch(target, actualSteps, options);
      if (recipe && procedures) {
        try { await procedures.report(recipe.id, { ok: result.ok, ms: result.ms }); } catch { /* stats are best effort */ }
      } else if (result.ok && procedures) {
        // 保存时机由设置决定：always 静默写库（老行为），model 只给候选，off 什么都不做。
        const mode = prefs()?.skills?.mode ?? 'model';
        if (mode === 'always') {
          try {
            const learned = await procedures.saveFromTrace({
              trace: target.trace.slice(before),
              url: target.url,
              title: target.title,
              minSteps: MIN_CANDIDATE_STEPS,
            });
            if (learned) {
              result.learned = learned;
              if (memoryMirror) {
                try { await memoryMirror.mirror(await procedures.get(learned.id)); } catch { /* best effort */ }
              }
            }
          } catch { /* learning is best effort */ }
        } else if (mode === 'model') {
          try {
            const candidate = skillCandidateOf({
              trace: target.trace.slice(before),
              url: target.url,
              title: target.title,
              existing: await procedures.list(),
            });
            // 只给模型一个提示，不落盘；模型自己决定要不要 browser_skill save。
            if (candidate) result.skillCandidate = candidate;
          } catch { /* 候选失败不能影响批量结果 */ }
        }
      }
      return { ok: true, ...result, ...(recipe ? { recipe } : {}) };
    });
  }

  async function skillList() {
    if (!procedures) return { ok: false, code: 'skills-unavailable' };
    return { ok: true, skills: await procedures.list() };
  }

  async function skillSave(input = {}) {
    if (!procedures) throw coded('skills-unavailable', '站点技能不可用');
    // off 模式：明确拒绝，模型不能声称已保存。
    if ((prefs()?.skills?.mode ?? 'model') === 'off') throw coded('skills-disabled', '站点技能已关闭');
    const target = await ensure();
    return withLockedTarget(target, async () => {
      const title = String(input.title || '').trim();
      if (!title) throw coded('invalid-argument', 'title 必填：给这条流程起一个能看懂的名字');
      const steps = input.steps || stepsFromTrace(target.trace);
      if (!Array.isArray(steps) || steps.length === 0) throw coded('invalid-argument', '还没有可保存的步骤');
      const record = await procedures.save({
        url: target.url,
        title,
        intent: Array.isArray(input.intent) ? input.intent : [],
        steps,
        verify: input.verify,
      });
      if (memoryMirror) {
        try { await memoryMirror.mirror(record); } catch { /* best effort */ }
      }
      return record;
    });
  }

  async function skillRemove(id) {
    if (!procedures) throw coded('skills-unavailable', '站点技能不可用');
    return { ok: await procedures.remove(id) };
  }

  // ---------------------------------------------------------------------------
  // 网页内选择（选区 / 元素）：注入会话 + picker 生命周期
  // ---------------------------------------------------------------------------

  function forwardInspect(target, payload) {
    const win = window();
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('browser:inspect:event', { ...payload, tabId: target.tabId }); } catch { /* 窗口正在关闭 */ }
  }

  /**
   * 取（或建）某个 target 的注入会话：每个 target 一个 binding、一个 nonce。
   * 导航后页内脚本会被重新注入到新文档，nonce 需要重新下发，否则上报会被丢弃；
   * 同时导航必须结束选择态，否则页面换了还在等点击。
   */
  function inspectSessionFor(target) {
    const existing = inspectSessions.get(target);
    if (existing) return existing;
    const nonce = randomUUID();
    const entry = { nonce, session: null, onNavigated: null };
    entry.session = createInspectSession({
      cdp: target.cdp,
      nonce,
      emit: payload => forwardInspect(target, payload),
      logger,
    });
    entry.onNavigated = () => {
      if (inspectActive && inspectActive.target === target) {
        inspectActive = null;
        forwardInspect(target, { type: 'exit', nonce });
      }
      // 新文档里脚本已重新注入；补一次 nonce（失败无所谓，下次 start 会再同步）。
      void entry.session.syncNonce();
    };
    try { target.guest.on('did-navigate', entry.onNavigated); } catch { /* guest 可能已销毁 */ }
    inspectSessions.set(target, entry);
    return entry;
  }

  async function stopPickerOn(target) {
    if (!target) return false;
    try {
      const stopped = await target.evaluate('!!(window.__movaInspect && window.__movaInspect.stopPicker && (window.__movaInspect.stopPicker(), true))');
      return stopped === true;
    } catch {
      return false;   // 页面已导航或已销毁，本来就没有 picker 了
    }
  }

  async function disposeInspect(target) {
    if (!target) return;
    if (inspectActive && inspectActive.target === target) inspectActive = null;
    if (inspectLast === target) inspectLast = null;
    const entry = inspectSessions.get(target);
    if (!entry) return;
    inspectSessions.delete(target);
    try { target.guest.removeListener('did-navigate', entry.onNavigated); } catch { /* guest 已销毁 */ }
    try { await entry.session.dispose(); } catch { /* best effort */ }
  }

  /**
   * 开始网页内选择。默认进入 picker；传 `{picker:false}`（或 `{mode:'selection'}`）
   * 只建立选区监听，不动页面交互。
   */
  async function inspectStart(input = {}) {
    const wantsPicker = input?.picker !== false && input?.mode !== 'selection';
    const requested = typeof input?.tabId === 'string' ? targets.get(input.tabId) : null;
    const target = requested || await ensure();
    if (!target) throw coded('browser-unavailable', '没有可用的标签页');

    // 重复调用 / 切换标签：先停旧的，避免两个页面同时抢点击。
    if (inspectActive) await stopPickerOn(inspectActive.target);
    inspectActive = null;

    try {
      await target.cdp.attach();
      await target.cdp.enable();
    } catch (error) {
      // DevTools 占用是最常见原因，给一个稳定错误码，别让渲染层静默失败。
      throw coded('inspect-unavailable', '无法在页面内启动选择，请先关闭开发者工具后重试', {
        cause: error?.code || 'attach-failed',
        message: error?.message || '',
      });
    }

    const entry = inspectSessionFor(target);
    try {
      await entry.session.start();
    } catch (error) {
      await disposeInspect(target);
      throw coded('inspect-unavailable', error?.message || '页面注入失败');
    }
    inspectLast = target;

    if (!wantsPicker) return { ok: true, active: false, picker: false, tabId: target.tabId };

    let started;
    try {
      started = await target.evaluate('!!(window.__movaInspect && window.__movaInspect.startPicker && (window.__movaInspect.startPicker(), true))');
    } catch (error) {
      await disposeInspect(target);
      throw coded('inspect-unavailable', error?.message || '无法在页面中启动选择');
    }
    if (!started) {
      await disposeInspect(target);
      throw coded('inspect-unavailable', '页面注入脚本不可用，请刷新页面后重试');
    }
    inspectActive = { target, entry };
    return { ok: true, active: true, tabId: target.tabId };
  }

  /** 结束选择并撤掉注入：之后再收到任何页面上报都不会转发。 */
  async function inspectStop() {
    // 可能有三处挂着会话：正在选择的目标、最近一次 arm 的目标、当前激活标签。
    const candidates = new Set();
    if (inspectActive) candidates.add(inspectActive.target);
    if (inspectLast) candidates.add(inspectLast);
    const active = current();
    if (active) candidates.add(active);
    inspectActive = null;
    inspectLast = null;
    for (const target of candidates) {
      await stopPickerOn(target);
      await disposeInspect(target);
    }
    return { ok: true };
  }

  async function credentialStatus() {
    if (!credentials) return { ok: false, code: 'vault-unavailable', message: '记忆保险柜不可用' };
    return credentials.status();
  }

  async function credentialList() {
    if (!credentials) return { ok: false, code: 'vault-unavailable', message: '记忆保险柜不可用' };
    try { return { ok: true, credentials: await credentials.list() }; }
    catch (error) { return { ok: false, code: error?.code || 'vault-error', message: error?.message || '无法读取保险柜' }; }
  }

  async function saveCredential(input = {}) {
    if (!credentials) throw coded('vault-unavailable', '记忆保险柜不可用（需要服务模式）');
    // 「保存登录密码」关掉后不再写入凭据；填写已有凭据不受影响。
    if (prefs()?.login?.savePasswords === false) throw coded('credentials-disabled', '设置中已关闭保存登录密码');
    const target = await ensure(input.space);
    const origin = credentials.normalizeOrigin(input.origin || target.url);
    if (!origin) throw coded('invalid-origin', '只有 http(s) 页面可以保存登录信息');
    return credentials.save({ origin, username: input.username, password: input.password });
  }

  async function fillCredential(input = {}) {
    if (!credentials) throw coded('vault-unavailable', '记忆保险柜不可用（需要服务模式）');
    const target = await ensure(input.space);
    const origin = credentials.normalizeOrigin(input.origin || target.url);
    if (!origin) throw coded('invalid-origin', '只有 http(s) 页面可以使用登录信息');
    return withLockedTarget(target, () => target.withInternal(() => credentials.fill(target, {
      origin,
      submit: input.submit === true,
      ...(input.credentials && typeof input.credentials === 'object' ? { credentials: input.credentials } : {}),
    })));
  }

  async function login(input = {}, spaceId) {
    const target = await ensure(spaceId);
    if (!credentials) throw coded('vault-unavailable', '记忆保险柜不可用（需要服务模式）');
    const origin = credentials.normalizeOrigin(target.url);
    if (!origin) throw coded('invalid-origin', 'only http(s) pages can use saved logins');
    return withLockedTarget(target, () => target.withInternal(async () => {
      target.lastDialog = null;
      const result = await credentials.fill(target, { origin, submit: input.submit === true });
      // 提交后不要固定睡 200 ms：等页面真的稳定（跳转/异步渲染）再返回。
      if (input.submit === true) {
        await target.waitForLoad(5000).catch(() => {});
        await target.wait({ for: 'settle', quietMs: 150, timeout: 2000 }).catch(() => {});
      }
      return { ...result, ...(target.lastDialog ? { dialog: target.lastDialog } : {}) };
    }));
  }

  function beginPassiveTakeover(target) {
    if (!target || target.lock !== 'agent' || handoffs.size > 0) return;
    const win = window();
    if (!win || win.isDestroyed()) return;
    const id = `p${++passiveSequence}`;
    target.lock = 'human';
    try { win.show(); win.focus(); } catch { /* best effort */ }
    win.webContents.send('browser:takeover', {
      id,
      reason: 'user-input',
      note: '你正在操作浏览器，Agent 已暂停',
      origin: target.url,
      title: target.title,
      passive: true,
    });
    handoffs.set(id, { resolve: () => {}, timer: null, signal: null, onAbort: null, target, passive: true });
  }

  function settleHandoff(id, decision) {
    const entry = handoffs.get(id);
    if (!entry) return false;
    handoffs.delete(id);
    clearTimeout(entry.timer);
    if (entry.onAbort && entry.signal) {
      try { entry.signal.removeEventListener('abort', entry.onAbort); } catch { /* detached */ }
    }
    entry.target.lock = 'agent';
    const win = window();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('browser:takeover:close', { id }); } catch { /* window closing */ }
    }
    entry.resolve({ ok: true, resumed: decision === 'resume', reason: decision });
    return true;
  }

  /**
   * 登记一条「用户正在接管浏览器」的人工等待，返回幂等的释放函数。
   *
   * 为什么要登记：接管期间既不调 `approvals.ask`，也一行 emit 都没有，
   * model-ipc 的 240s 静默计时会把它当成卡死并 abort 整个回合（前端显示「连接中断，正在重试」）。
   * 依赖注入与 approvals 一致：登记表由 main.cjs 建好后传进来，这里不碰 Electron 全局状态。
   * senderId 取本窗口的 `webContents.id`——model-ipc 里就是同一个 `sender.id`，
   * 别的窗口的接管不会给这一轮续命。
   * 没有注入登记表（纯 Node 测试）时退化成空操作：旁路故障不能把接管本身搞挂。
   */
  function beginHumanWait(win) {
    if (!humanWait || typeof humanWait.begin !== 'function') return () => {};
    try {
      return humanWait.begin(win?.webContents?.id ?? null, 'browser_handoff');
    } catch (error) {
      logger?.warn?.('human wait begin failed', error?.message || error);
      return () => {};
    }
  }

  async function handoff(input = {}, signal, spaceId) {
    const target = await ensure(spaceId);
    return withLockedTarget(target, async () => {
      if (handoffs.size > 0) throw coded('handoff-busy', 'already waiting for the user');
      if (signal?.aborted) throw coded('cancelled', 'run cancelled');
      const win = window();
      if (!win || win.isDestroyed()) throw coded('no-window', 'Mova window is not available');
      const id = `h${++handoffSequence}`;
      // 从这一刻起就是真的在等用户：整段包在 try/finally 里。
      // 五条退出路径全部落到同一个 release：resume（成功）、timeout（10 分钟上限）、
      // cancelled（回合被中止）、close()/窗口销毁（settleHandoff('cancel') 后 resolve）、
      // 以及任何同步/异步异常。release 本身幂等，重复调也只生效一次。
      const releaseHumanWait = beginHumanWait(win);
      try {
        target.lock = 'human';
        const reason = typeof input.reason === 'string' ? input.reason.slice(0, 40) : 'handoff';
        const note = typeof input.note === 'string' ? input.note.slice(0, 500) : '';
        try { win.show(); win.focus(); } catch { /* best effort */ }
        if (target.tabId !== activeTabId) win.webContents.send('browser:tab:select', { tabId: target.tabId });
        win.webContents.send('browser:takeover', { id, reason, note, origin: target.url, title: target.title });
        // 必须 await 这个 Promise：直接 `return new Promise(...)` 会让 finally 在
        // Promise 还没 settle 时就先跑，等于刚开始等就把 hold 放掉了。
        return await new Promise(resolve => {
          const timer = setTimeout(() => settleHandoff(id, 'timeout'), 10 * 60 * 1000);
          const onAbort = () => settleHandoff(id, 'cancelled');
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          handoffs.set(id, { resolve, timer, signal, onAbort, target });
          if (signal?.aborted) settleHandoff(id, 'cancelled');
        });
      } finally {
        releaseHumanWait();
      }
    });
  }

  function respondHandoff(id, decision) {
    if (typeof id !== 'string' || !['resume', 'cancel'].includes(decision)) return false;
    return settleHandoff(id, decision);
  }

  async function screenshot(options = {}, spaceId) {
    if (options.mode === 'none') return { ok: true, skipped: true, reason: options.reason || 'none' };
    const target = await ensure(spaceId);
    return withLockedTarget(target, async () => {
      const win = window();
      const mode = options.mode === 'thumb' || options.mode === 'full' ? options.mode : 'viewport';
      const fullPage = mode === 'full' || options.fullPage === true;
      const { getPointerViewport } = await import('../../edge-extension/pointer.js');
      const viewport = fullPage ? undefined : await getPointerViewport((method, params) => target.cdp.send(method, params));
      const result = await target.screenshot({ ...options, fullPage, windowVisible: Boolean(win && win.isVisible()) });
      const viewId = viewport ? randomUUID() : undefined;
      target.pointerView = viewport ? { id: viewId, viewport } : undefined;
      let buffer = result.buffer;
      let mimeType = 'image/png';
      let width = result.width;
      let height = result.height;
      if (mode === 'thumb') {
        const image = nativeImage.createFromBuffer(buffer);
        const size = image.getSize();
        const resized = size.width > 1024 ? image.resize({ width: 1024 }) : image;
        buffer = resized.toJPEG(72);
        mimeType = 'image/jpeg';
        const out = resized.getSize();
        width = out.width;
        height = out.height;
      }
      const directory = join(app.getPath('userData'), 'browser', 'shots');
      mkdirSync(directory, { recursive: true });
      const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const name = `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
      const file = join(directory, name);
      writeFileSync(file, buffer);
      return { ok: true, path: file, bytes: buffer.length, width, height, mode, mimeType, fullPage, viewId, viewport };
    });
  }

  function tabs() {
    const rows = [...targets.values()].map(target => ({ ...target.info(), active: target.tabId === activeTabId }));
    return { ok: true, activeTabId, tabs: rows };
  }

  async function close() {
    for (const id of [...handoffs.keys()]) settleHandoff(id, 'cancel');
    inspectActive = null;
    inspectLast = null;
    for (const target of targets.values()) await target.close();
    targets.clear();
    byGuest.clear();
    pendingReady.clear();
    for (const waiter of pendingSpaces.values()) { clearTimeout(waiter.timer); waiter.reject(coded('disposed', 'browser controller closed')); }
    for (const waiter of pendingTabs.values()) { clearTimeout(waiter.timer); waiter.reject(coded('disposed', 'browser controller closed')); }
    pendingSpaces.clear();
    pendingTabs.clear();
    spaceTabs.clear();
    activeTabId = null;
  }

  function tools(options = {}) {
    return createBrowserTools({
      navigate,
      snapshot,
      read,
      wait,
      act,
      dialog,
      runJs,
      storageExport,
      storageImport,
      hasLoginRecord,
      saveLoginRecord,
      useLoginRecord,
      upload,
      batch,
      login,
      handoff,
      screenshot,
      pointer: async (input, spaceId, signal) => {
        const target = await ensure(spaceId);
        return withLockedTarget(target, () => target.pointer(input, signal));
      },
      tabs,
      newTab,
      selectTab,
      closeTab,
      skillList,
      skillSave,
      skillRemove,
      emit: options.emit,
      approve: options.approve,
      // 同一轮的工具耗时、审批等待、接管等待都记在同一个账本里。
      timing: options.timing,
      getUrl: () => current()?.url || '',
      getPrefs: () => prefs(),
      logger,
    });
  }

  const BROWSER_PARTITION = 'persist:mova-browser';
  const CLEARABLE = ['cookies', 'cache', 'localStorage'];

  /**
   * 清空浏览器数据。`downloads` 被显式排除：本版本没有本地下载记录存储，
   * 与其假装清空，不如让界面如实说明。
   */
  async function clearData(input = {}) {
    if (!getSession) throw coded('session-unavailable', '当前环境无法清理浏览器数据');
    const requested = Array.isArray(input?.targets) ? input.targets : [];
    const wanted = new Set(requested.filter(name => CLEARABLE.includes(name)));
    if (!wanted.size) throw coded('invalid-input', '请选择要清理的数据');
    const partition = typeof input?.partition === 'string' && input.partition.startsWith('persist:')
      ? input.partition : BROWSER_PARTITION;
    const target = getSession(partition);
    const cleared = [];
    if (wanted.has('cookies')) { await target.clearStorageData({ storages: ['cookies'] }); cleared.push('cookies'); }
    if (wanted.has('localStorage')) {
      await target.clearStorageData({ storages: ['localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'] });
      cleared.push('localStorage');
    }
    if (wanted.has('cache')) { await target.clearCache(); cleared.push('cache'); }
    return { cleared, partition, unsupported: requested.filter(name => !CLEARABLE.includes(name)) };
  }

  /** 重置浏览器分区：清掉该分区的全部存储与缓存，相当于回到全新浏览器。 */
  async function resetPartition(input = {}) {
    if (!getSession) throw coded('session-unavailable', '当前环境无法重置浏览器分区');
    const partition = typeof input?.partition === 'string' && input.partition.startsWith('persist:')
      ? input.partition : BROWSER_PARTITION;
    const target = getSession(partition);
    await target.clearStorageData();
    await target.clearCache();
    try { await target.clearAuthCache(); } catch { /* 部分平台不支持 */ }
    return { partition };
  }

  return {
    registerGuest,
    tabReady,
    tabActive,
    tabClosed,
    tabCleared,
    ensure,
    newTab,
    selectTab,
    closeTab,
    navigate,
    snapshot,
    read,
    wait,
    act,
    dialog,
    runJs,
    storageExport,
    storageImport,
    hasLoginRecord,
    saveLoginRecord,
    useLoginRecord,
    upload,
    batch,
    skillList,
    skillSave,
    skillRemove,
    inspectStart,
    inspectStop,
    login,
    handoff,
    respondHandoff,
    credentialStatus,
    credentialList,
    saveCredential,
    fillCredential,
    screenshot,
    tabs,
    clearData,
    resetPartition,
    cardsList: () => (cards ? cards.list() : []),
    cardsClear: input => (cards && typeof cards.clear === 'function' ? cards.clear(input) : { cleared: 0 }),
    settings: () => (settings ? settings.read() : null),
    activeUrl: () => { const target = activeTabId ? targets.get(activeTabId) : current(); return target?.url || ''; },
    close,
    tools,
    status: () => ({ activeTabId, tabs: [...targets.keys()] }),
  };
}

module.exports = { createBrowserController, skillCandidateOf, MIN_CANDIDATE_STEPS };
