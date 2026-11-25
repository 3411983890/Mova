'use strict';
// renderer 桥：状态 / 停止 / 恢复 / 设置 / 技能列表，以及执行器 → 渲染进程的三条事件。
//
// 两件事必须做对：
//  1. 每个 handler 都校验 authorize(event)（与 main.cjs 里 browser IPC 的 senderWindow 同一套）；
//  2. 引擎不存在（index.cjs 还没落地 / 当前平台不支持）时，返回“不可用”而不是抛异常 ——
//     设置页要能画出来并说明原因，应用不能因为桌面能力缺失而起不来。

const { join } = require('node:path');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { normalizeSettings, settingsDefaults } = require('./policy.cjs');

const SETTINGS_SECTION = 'settings';

/** 当前已安装的引擎。chat-agent 在没拿到显式注入时用它兜底（见 chat-agent.mjs TODO）。 */
let installedDesktop = null;
function currentDesktop() {
  return installedDesktop;
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 设置持久化：userData/desktop/policy.json 的 `settings` 段。
 * policy.json 里还有别的段（应用规则等由引擎维护），所以写入时必须保留未知键。
 */
function createDesktopSettingsStore({ directory }) {
  const file = directory ? join(directory, 'policy.json') : '';
  let cached = null;

  function readFileJson() {
    if (!file) return {};
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      return isPlainObject(raw) ? raw : {};
    } catch {
      // 缺失或损坏都回默认值：损坏的旧文件不该阻止设置页打开。
      return {};
    }
  }

  function read() {
    if (!cached) {
      const raw = readFileJson();
      cached = normalizeSettings(isPlainObject(raw[SETTINGS_SECTION]) ? raw[SETTINGS_SECTION] : null, settingsDefaults());
    }
    return cached;
  }

  function write(next) {
    if (!file) return next;
    const raw = readFileJson();
    raw[SETTINGS_SECTION] = next;
    mkdirSync(directory, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    renameSync(temp, file);   // 原子替换
    return next;
  }

  /** 只合并一层：传进来的分节键才改，未提及的保持原值。 */
  function patch(partial) {
    const current = read();
    const merged = {};
    if (isPlainObject(partial)) {
      for (const key of Object.keys(current)) {
        merged[key] = isPlainObject(partial[key]) ? { ...current[key], ...partial[key] } : current[key];
      }
      if (typeof partial.enabled === 'boolean') merged.enabled = partial.enabled;
      if (typeof partial.profile === 'string') merged.profile = partial.profile;
    }
    cached = normalizeSettings(merged, current);
    write(cached);
    return cached;
  }

  return { read, patch, file, defaults: () => normalizeSettings(null, settingsDefaults()) };
}

function pickFunction(source, names) {
  if (!source) return null;
  for (const name of names) {
    if (typeof source[name] === 'function') return source[name].bind(source);
  }
  return null;
}

/**
 * @param {{ipcMain:object, desktop?:object, authorize:(event:object)=>any,
 *          directory?:string, settings?:object, getWin?:()=>object,
 *          windows?:()=>object[]}} options
 */
function installDesktopIpc({ ipcMain, desktop = null, authorize, directory, settings, getWin, windows } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain is required');
  if (typeof authorize !== 'function') throw new TypeError('authorize is required');
  installedDesktop = desktop || null;

  const engineSettings = desktop?.settings && typeof desktop.settings.get === 'function' ? desktop.settings : null;
  const store = settings || createDesktopSettingsStore({ directory });

  /**
   * 渲染进程的设置形状（policy.cjs 的 DEFAULT_SETTINGS）是唯一权威；
   * 引擎（index.cjs）用的是平铺键，这里只做投影，绝不反过来读引擎的设置，
   * 否则设置页会拿到两套不同形状。
   */
  function applyToEngine(next) {
    if (!engineSettings || typeof engineSettings.set !== 'function') return;
    try {
      engineSettings.set({
        enabled: next.enabled,
        maxMinutes: next.budget.maxMinutes,
        maxActions: next.budget.maxActions,
        maxDepth: next.advanced.maxDepth,
        deadlineMs: next.advanced.treeTimeoutMs,
        excludeApps: next.advanced.excludeProcesses,
      });
    } catch { /* 投影失败不影响持久化 */ }
  }

  const readSettings = () => store.read();
  const writeSettings = patch => {
    const next = store.patch(patch);
    applyToEngine(next);
    return next;
  };
  applyToEngine(readSettings());

  /** 事件只能送到本应用的窗口；renderer 不可用时静默丢弃。 */
  function resolveWindows() {
    if (typeof windows === 'function') {
      try { return windows() || []; } catch { return []; }
    }
    if (typeof getWin === 'function') {
      try { const win = getWin(); return win ? [win] : []; } catch { return []; }
    }
    try {
      const { BrowserWindow } = require('electron');
      return BrowserWindow.getAllWindows();
    } catch {
      return [];
    }
  }

  function send(channel, payload) {
    let delivered = 0;
    for (const win of resolveWindows()) {
      if (!win || win.isDestroyed?.()) continue;
      try { win.webContents.send(channel, payload); delivered += 1; } catch { /* 窗口正在关闭 */ }
    }
    return delivered;
  }

  const emitStep = payload => send('desktop:step', {
    text: String(payload?.text ?? '').slice(0, 200),
    ...(payload?.emotion !== undefined ? { emotion: payload.emotion } : {}),
  });
  const emitState = payload => send('desktop:state', {
    state: String(payload?.state ?? payload ?? 'idle').slice(0, 20),
    ...(payload?.text ? { text: String(payload.text).slice(0, 200) } : {}),
    ...(payload?.reason ? { reason: String(payload.reason).slice(0, 120) } : {}),
  });
  const emitUnavailable = payload => send('desktop:unavailable', {
    available: false,
    reason: String(payload?.reason || payload?.message || 'desktop-unavailable').slice(0, 300),
  });

  const offline = reason => ({ available: false, reason, worker: null, session: null, enabled: false });

  function status() {
    if (!desktop || typeof desktop.status !== 'function') return offline('desktop engine unavailable');
    try {
      const value = desktop.status() || {};
      return { ...value, enabled: readSettings().enabled === true };
    } catch (error) {
      return offline(error?.message || 'desktop status failed');
    }
  }

  function handler(channel, operation) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        authorize(event);
      } catch {
        return { ok: false, error: 'unauthorized' };
      }
      try {
        return await operation(...args);
      } catch (error) {
        return { ok: false, error: error?.code || 'failed', message: error?.message || '桌面操作失败' };
      }
    });
  }

  // ── 状态 ───────────────────────────────────────────────────────────
  ipcMain.handle('desktop:status', event => {
    try { authorize(event); } catch { return offline('unauthorized'); }
    return status();
  });

  // ── 终止 / 恢复 ────────────────────────────────────────────────────
  handler('desktop:stop', async reason => {
    if (!desktop) return { ok: false, code: 'desktop-unavailable' };
    const stop = pickFunction(desktop, ['stop', 'abort']);
    if (!stop) return { ok: false, code: 'not-implemented' };
    await stop(typeof reason === 'string' ? reason : 'user');
    emitState({ state: 'aborted', reason: 'user' });
    return { ok: true };
  });

  handler('desktop:resume', async () => {
    if (!desktop) return { ok: false, code: 'desktop-unavailable' };
    const resume = pickFunction(desktop, ['resume', 'continue']);
    if (!resume) {
      const sessionResume = pickFunction(desktop.session, ['resume', 'continue']);
      if (!sessionResume) return { ok: false, code: 'not-implemented' };
      await sessionResume();
    } else {
      await resume();
    }
    emitState({ state: 'running', reason: 'user' });
    return { ok: true };
  });

  // ── 设置 ───────────────────────────────────────────────────────────
  // 设置页要的是一个对象（不是 {ok,value}），字段见 design/desktop-integration-notes.md。
  ipcMain.handle('desktop:get-settings', event => {
    try { authorize(event); } catch { return settingsDefaults(); }
    return readSettings();
  });

  handler('desktop:set-settings', patch => {
    if (!isPlainObject(patch)) return { ok: false, error: 'invalid-input' };
    const next = writeSettings(patch);
    return { ok: true, settings: next };
  });

  // ── 技能库 ─────────────────────────────────────────────────────────
  ipcMain.handle('desktop:skills', async event => {
    try { authorize(event); } catch { return { ok: false, error: 'unauthorized', skills: [] }; }
    const store2 = desktop?.procedures || desktop?.skills;
    const list = pickFunction(store2, ['list', 'skillList']);
    if (!list) return { ok: true, skills: [] };
    try { return { ok: true, skills: await list({ limit: 100 }) }; }
    catch (error) { return { ok: false, error: error?.code || 'failed', skills: [] }; }
  });

  handler('desktop:skills:remove', async id => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid-input' };
    const store2 = desktop?.procedures || desktop?.skills;
    const remove = pickFunction(store2, ['retire', 'remove']);
    if (!remove) return { ok: false, error: 'not-implemented' };
    return { ok: Boolean(await remove(id)) };
  });

  // ── 引擎 → 渲染进程事件 ────────────────────────────────────────────
  const offs = [];
  if (desktop && typeof desktop.on === 'function') {
    const bind = (name, fn) => {
      try {
        const off = desktop.on(name, fn);
        if (typeof off === 'function') offs.push(off);
      } catch { /* 引擎没实现这个事件 */ }
    };
    bind('step', payload => emitStep(payload));
    bind('state', payload => emitState(payload));
    bind('unavailable', payload => emitUnavailable(payload));
  }
  // 引擎在启动时就已经不可用：主动补一条，设置页不必等第一次调用。
  const initial = status();
  if (!initial.available) queueMicrotask(() => emitUnavailable({ reason: initial.reason }));

  const channels = [
    'desktop:status', 'desktop:stop', 'desktop:resume', 'desktop:get-settings',
    'desktop:set-settings', 'desktop:skills', 'desktop:skills:remove',
  ];

  function dispose() {
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* 已断开 */ }
    }
    for (const channel of channels) {
      try { ipcMain.removeHandler(channel); } catch { /* not registered */ }
    }
    installedDesktop = null;
  }

  return { settings: { read: readSettings, patch: writeSettings, store }, status, emitStep, emitState, emitUnavailable, dispose, channels };
}

module.exports = {
  installDesktopIpc,
  createDesktopSettingsStore,
  currentDesktop,
  SETTINGS_SECTION,
};
