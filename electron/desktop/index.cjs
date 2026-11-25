'use strict';
// 桌面操作引擎：唯一出口，装配 host / windows / tree / compact / diff / actions / session。
// 懒启动：只有第一次真正调用时才 spawn PowerShell worker，避免拖慢主进程启动。
// 工具（desktop_*）由另一个 agent 的 tools.cjs 负责，这里只留接入点。

const { existsSync } = require('node:fs');
const { join } = require('node:path');

const { createHost } = require('./host.cjs');
const { createWindows, displayForRect, windowLabel, normalizeWindow } = require('./windows.cjs');
const { compact } = require('./compact.cjs');
const { diffTrees } = require('./diff.cjs');
const { createActions } = require('./actions.cjs');
const { createSession } = require('./session.cjs');
const { createInterlock } = require('./interlock.cjs');
const { grabScreen } = require('./capture-ps.cjs');
const { recognize } = require('./vision/ocr.cjs');
const { buildTree, normalizeNodes, fingerprintOf } = require('./tree.cjs');
const { toPhysical } = require('./geometry.cjs');

const VERSION = '0.1.0';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  maxMinutes: 10,
  maxActions: 60,
  maxDepth: 6,
  maxNodes: 2000,
  deadlineMs: 1500,
  maxChars: 6000,
  boxes: false,
  showCursor: false,
  excludeApps: ['Mova.exe'],
});

function resolveScriptPath(app) {
  const bundled = join(__dirname, 'host', 'uia-worker.ps1');
  if (existsSync(bundled)) return bundled;
  // 打包后源码在 asar 里不可执行：优先用 app.getAppPath() 下的解包副本
  if (app && typeof app.getAppPath === 'function') {
    try {
      const candidate = join(app.getAppPath(), 'electron', 'desktop', 'host', 'uia-worker.ps1');
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return bundled;
}

/**
 * @param {object} options
 * @param {object} [options.app] Electron app（可选，用来定位 worker 脚本）
 * @param {object} [options.screen] Electron screen（可选，displayForRect 用）
 * @param {object} [options.approvals] 审批（由 C 号 agent 接线，这里只透传）
 * @param {object} [options.audit] 审计记录器 {record(entry)}
 * @param {Function} [options.getWin] 取主窗口
 * @param {object} [options.logger] {info,warn,error}
 * @param {object} [options.settings] 初始设置覆盖
 * @param {object} [options.host] 已建好的 host（测试时注入）
 * @param {object} [options.input] input.cjs（B 号 agent）
 * @param {object} [options.guard] guard.cjs（B 号 agent）
 * @param {object} [options.overlay] overlay（B 号 agent）
 * @param {object} [options.policy] 策略（C 号 agent）
 * @param {object} [options.humanWait] 人工等待登记表（main.cjs 注入，与 model-ipc 订阅的是同一个实例）
 * @param {Function} [options.groundModel] 接地模型调用器（main.cjs 注入，契约见 vision/grounder.cjs）
 * @param {Function} [options.groundSettings] () => policy 形状设置，给 grounder 判视觉开关 / 帧预算
 */
function createDesktopEngine(options = {}) {
  const {
    app = null,
    screen = null,
    approvals = null,
    audit = null,
    getWin = null,
    humanWait = null,
    logger = null,
    host: injectedHost = null,
    input = null,
    guard = null,
    overlay = null,
    policy = null,
    groundModel = null,
    groundSettings = null,
    procedures = null,
  } = options;
  const log = logger || { info() {}, warn() {}, error() {} };
  const settings = { ...DEFAULT_SETTINGS, ...(options.settings || {}) };

  let hostInstance = injectedHost;
  let hostStartPromise = null;
  let disposed = false;
  let lastError = null;

  function rawHost() {
    if (!hostInstance) {
      hostInstance = createHost({
        scriptPath: resolveScriptPath(app),
        logger: log,
      });
      hostInstance.on('exit', (info) => log.warn?.(`[desktop] worker exit ${JSON.stringify(info)}`));
      hostInstance.on('event', (event) => log.info?.(`[desktop] worker event ${JSON.stringify(event)}`));
    }
    return hostInstance;
  }

  async function ensureHost() {
    if (disposed) {
      const error = new Error('引擎已释放');
      error.code = 'disposed';
      throw error;
    }
    if (!hostStartPromise) {
      hostStartPromise = rawHost().start()
        .then((pong) => {
          if (!pong || pong.uia === false) log.warn?.('[desktop] UIA 不可用，桌面操作会返回 unavailable');
          return pong;
        })
        .catch((error) => {
          lastError = { code: (error && error.code) || 'worker-exit', message: (error && error.message) || 'worker 启动失败' };
          hostStartPromise = null;
          throw error;
        });
    }
    return hostStartPromise;
  }

  // windows/actions/session 只依赖 host.call，这里包一层“懒启动 + 透传”
  const hostProxy = {
    call(cmd, args, callOptions) {
      return ensureHost().then(() => rawHost().call(cmd, args, callOptions));
    },
    on(...args) { return rawHost().on(...args); },
    get pid() { return hostInstance ? hostInstance.pid : 0; },
    status() { return hostInstance ? hostInstance.status() : { started: false, alive: false, pending: 0 }; },
  };

  const windows = createWindows({ host: hostProxy });
  const actions = createActions({ host: hostProxy, input, policy });

  /* 后置条件引擎（verify.cjs）：pixels / focused / element 这些 ΔTree 判不出来的条件靠它。
     懒创建是因为 pixels 条件要 sharp，而 sharp 只在真要截图时才值得 require。 */
  let verifierInstance = null;
  function getVerifier() {
    if (verifierInstance) return verifierInstance;
    const { createVerifier } = require('./verify.cjs');
    let sharpFn = null;
    try { sharpFn = require('sharp'); } catch { sharpFn = null; }
    verifierInstance = createVerifier({ diff: diffTrees, sharp: sharpFn });
    return verifierInstance;
  }

  // interlock 要在 session 之后创建（它依赖 session），但 session 的 deps 又需要它：
  // 用一个 getter 延迟解析，避免循环依赖。
  let interlock = null;

  const session = createSession({
    deps: {
      windows,
      actions,
      compact,
      guard,
      overlay,
      audit,
      input,
      get interlock() { return interlock; },
      // 条件引擎也走懒解析：没用到 pixels 的地方不会触发 sharp 加载。
      verify: { check: (...args) => getVerifier().check(...args) },
      onAbort: (reason) => {
        log.info?.(`[desktop] session aborted: ${reason}`);
        if (typeof options.onAbort === 'function') options.onAbort(reason);
      },
    },
    budget: { maxMinutes: settings.maxMinutes, maxActions: settings.maxActions },
    logger: log,
  });

  // 鼠标接管闸门：会话 running 时锁住真人鼠标，paused 时只吞“点在球上”的那一下。
  interlock = createInterlock({ session, screen, logger: log });

  /* ── 视觉：截图（懒创建，只有真的调用 desktop_screenshot 才加载 desktopCapturer/sharp） ── */
  let captureInstance = null;
  let lastMarks = [];

  // 接地器（视觉兜底）：只有 main.cjs 注入了 groundModel 才存在；未注入时返回 null。
  let grounderInstance = null;
  function getGrounder() {
    if (!groundModel) return null;
    if (!grounderInstance) {
      const { createGrounder } = require('./vision/grounder.cjs');
      grounderInstance = createGrounder({
        callModel: groundModel,
        ...(typeof groundSettings === 'function' ? { settings: groundSettings } : {}),
      });
    }
    return grounderInstance;
  }
  // 最近一帧的坐标上下文（crop + captureScale）：编号是“图像坐标”，
  // 不加这层换算会按 1:1 点到缩放后的图上去 —— 1440 宽屏缩到 1280 时会偏 11%。
  let lastFrameCtx = null;

  /**
   * 把桌面截图里的编号（#12）解析成屏幕坐标（物理像素，和 input.cjs 同一坐标系），
   * 供 desktop_act 直接点击。图像坐标 → 物理 = crop 原点 + 图内坐标 / captureScale。
   */
  function resolveMark(id, origin = { x: 0, y: 0 }) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    const mark = (lastMarks || []).find((m) => Number(m.id) === n);
    if (!mark || !Array.isArray(mark.box)) return null;
    const [x, y, w, h] = mark.box;
    const [px, py] = toPhysical([x + (w || 0) / 2, y + (h || 0) / 2], lastFrameCtx || {});
    return {
      id: n,
      name: mark.name || '',
      x: Math.round(px + (origin.x || 0)),
      y: Math.round(py + (origin.y || 0)),
      scale: lastFrameCtx ? lastFrameCtx.captureScale : 1,
    };
  }
  function getCapture() {
    if (captureInstance) return captureInstance;
    const { desktopCapturer } = require('electron');
    const { createCapture } = require('./capture.cjs');
    const cacheDir = app && typeof app.getPath === 'function'
      ? join(app.getPath('userData'), 'desktop', 'shots')
      : join(__dirname, '..', '..', '.desktop-shots');
    captureInstance = createCapture({
      desktopCapturer,
      screen,
      sharp: require('sharp'),
      cacheDir,
      logger: log,
    });
    return captureInstance;
  }

  async function screenshot(input = {}) {
    const wantOcr = input.ocr === true;
    let path = '';
    let width = 0;
    let height = 0;
    let origin = { x: 0, y: 0 };
    let tainted = false;
    let via = 'electron';

    // 指定窗口时按窗口矩形裁剪（PS 后端支持裁剪，Electron 后端先抓全屏）
    let region = null;
    let hwnd = Number(input.hwnd);
    const wantedTitle = typeof input.window === 'string' ? input.window.trim() : '';
    if (!Number.isFinite(hwnd) && wantedTitle) {
      const asNumber = Number(wantedTitle.replace(/[^0-9]/g, ''));
      if (wantedTitle.length > 6 && Number.isFinite(asNumber) && asNumber > 0) hwnd = asNumber;
    }
    if (Number.isFinite(hwnd) || wantedTitle) {
      try {
        const rows = await windows.list({ includeMinimized: true });
        const list = Array.isArray(rows) ? rows : rows.windows || [];
        const rectOf = (row) => (Array.isArray(row.rect)
          ? { x: row.rect[0], y: row.rect[1], w: row.rect[2], h: row.rect[3] }
          : row.rect);
        let row = Number.isFinite(hwnd) ? list.find((w) => w.hwnd === Number(hwnd)) : null;
        if (!row && wantedTitle) {
          row = list
            .filter((w) => String(w.title || '').includes(wantedTitle))
            .map((w) => ({ w, r: rectOf(w) }))
            .filter((it) => it.r && it.r.w > 0 && it.r.h > 0)
            .sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h)[0]?.w;
        }
        const r = row ? rectOf(row) : null;
        if (r && r.w > 0 && r.h > 0) region = { x: r.x, y: r.y, w: r.w, h: r.h };
        if (row) hwnd = row.hwnd;
      } catch { /* 取不到窗口就用全屏 */ }
    }

    try {
      const capture = getCapture();
      const frame = await capture.grab({
        displayId: input.displayId,
        // 指定窗口/区域时真的裁出来：OCR 只看目标窗口，标记坐标也少受别的窗口干扰。
        ...(region ? { region } : {}),
        maxLongEdge: input.maxLongEdge || 1280,
        maxPixels: input.maxPixels,
        format: input.format || 'png',
      });
      path = frame.path || '';
      width = frame.width;
      height = frame.height;
      tainted = frame.tainted === true;
      // internal:true = 内部取帧（像素对比），不能污染 lastFrameCtx / lastMarks，
      // 否则下一次 resolveMark('#N') 会按全屏帧算坐标，把点打到屏幕外。
      if (input.internal !== true) lastFrameCtx = { crop: frame.crop, captureScale: frame.captureScale || 1, dpr: frame.dpr };
    } catch (error) {
      // Electron/desktopCapturer + sharp 在这台机器上会因 colourspace 失败 → 退 PowerShell GDI 截图
      const shot = await grabScreen(region || {});
      path = shot.path;
      width = shot.width;
      height = shot.height;
      via = 'powershell';
      // PS 截图按物理像素 1:1 出图：区域原点记进 crop，origin 归零（避免 resolveMark 重复相加）。
      if (input.internal !== true) {
        lastFrameCtx = {
          crop: { x: shot.x || 0, y: shot.y || 0, w: shot.width, h: shot.height },
          captureScale: 1,
          dpr: 1,
        };
      }
      origin = { x: 0, y: 0 };
    }

    const result = { ok: true, path, width, height, origin, tainted, via };
    // 坐标上下文一起返回：调用方要自己换算坐标时（#N、SoM 框）不必再猜缩放比例。
    if (lastFrameCtx) {
      result.crop = lastFrameCtx.crop;
      result.captureScale = lastFrameCtx.captureScale;
    }
    let ocrLines = null;
    if (wantOcr) {
      const ocr = await recognize(path);
      ocrLines = ocr.lines;
      result.text = ocr.text;
      result.lines = ocr.lines;
      result.language = ocr.language;
    }

    // annotate=som：把可点区域编号画在图上（视觉模型只回编号，不用猜坐标）
    if (input.annotate === 'som' && path) {
      try {
        const { annotate } = require('./vision/som.cjs');
        const fs = require('node:fs');
        const source = ocrLines && ocrLines.length
          ? ocrLines.filter((line) => line.w > 8 && line.h > 6).slice(0, 60)
            .map((line, i) => ({ id: i + 1, role: 'text', name: line.text, box: [line.x, line.y, line.w, line.h] }))
          : [];
        if (source.length) {
          const annotated = await annotate(fs.readFileSync(path), { marks: source });
          const outPath = path.replace(/\.png$/i, '.som.png');
          fs.writeFileSync(outPath, annotated.buffer);
          result.annotatedPath = outPath;
          result.marks = annotated.marks;
          lastMarks = annotated.marks;
        }
      } catch (error) {
        result.annotateError = (error && error.code) || (error && error.message) || 'annotate-failed';
      }
    }
    return result;
  }

  /* ── 交给人：暂停会话，等用户点 Mova 继续（或超时/终止） ── */

  /**
   * 登记一条「用户正在人工接管桌面」的人工等待，返回幂等的释放函数。
   *
   * 为什么要登记：`desktop_handoff` 默认等 10 分钟（最长 30 分钟），期间既不调
   * `approvals.ask`、也一行 emit 都没有，model-ipc 的 240s 静默计时会把它当成卡死并 abort 回合。
   * 依赖注入与 approvals 一致：登记表由 main.cjs 建好后传进来，这里不碰 Electron 全局状态。
   * senderId 取主窗口的 `webContents.id`——model-ipc 里 `holdIdleDuringHumanWait({ senderId: sender.id })`
   * 用的就是同一个粒度（主窗口发起的回合 sender 就是它），别的窗口的接管不会给这一轮续命。
   * 没有注入登记表（纯 Node 测试 / 探针脚本）时退化成空操作：旁路故障不能把接管本身搞挂。
   */
  function beginHumanWait(win) {
    if (!humanWait || typeof humanWait.begin !== 'function') return () => {};
    try {
      return humanWait.begin(win?.webContents?.id ?? null, 'desktop_handoff');
    } catch (error) {
      log.warn?.(`[desktop] human wait begin failed: ${(error && error.message) || error}`);
      return () => {};
    }
  }

  async function handoff(input = {}) {
    const note = String(input.note || '').slice(0, 200);
    const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 600000, 5000), 1800000);
    const win = typeof getWin === 'function' ? getWin() : null;
    // 从这里起就是真的在等用户：整段包在 try/finally 里。
    // 四条退出路径全部落到同一个 release：resumed（用户点继续）、aborted（回合被终止）、
    // handoff-timeout（10 分钟 / 30 分钟上限）、以及任何同步/异步异常。release 幂等。
    const releaseHumanWait = beginHumanWait(win);
    try {
      session.pause('handoff');
      if (overlay && typeof overlay.setState === 'function') {
        overlay.setState('paused', { note: note ? `需要你处理：${note}` : '需要你处理，完成后点 Mova 继续' });
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const state = session.status().state;
        if (state === 'running') return { ok: true, resumed: true, note };
        if (state === 'aborted') return { ok: false, code: 'aborted', note };
      }
      return { ok: false, code: 'handoff-timeout', note };
    } finally {
      releaseHumanWait();
    }
  }

  async function start() {
    try {
      await ensureHost();
      interlock.start();
      return { ok: true, status: status() };
    } catch (error) {
      return { ok: false, code: (error && error.code) || 'worker-exit', message: (error && error.message) || 'worker 启动失败' };
    }
  }

  function status() {
    const platformOk = process.platform === 'win32';
    const worker = hostProxy.status();
    let available = platformOk;
    let reason = '';
    if (!platformOk) { available = false; reason = 'unsupported-platform'; }
    else if (worker.started && worker.uia === false) { available = false; reason = 'uia-unavailable'; }
    else if (lastError && !worker.alive) { available = false; reason = lastError.code; }
    else if (settings.enabled === false) { available = true; reason = 'disabled'; }
    return {
      available,
      reason,
      version: VERSION,
      platform: process.platform,
      worker,
      session: session.status(),
      settings: { ...settings },
    };
  }

  /**
   * 工具清单：desktop_* 由 tools.cjs 提供，operations 适配层由 createEngineOperations 从本引擎
   * 的公开能力（windows/session/actions/status…）拼出来。调用方（chat-agent）传 { emit, approve, vision }。
   */
  function tools(callOptions = {}) {
    const { createDesktopTools, createEngineOperations } = require('./tools.cjs');
    const operations = createEngineOperations(api);
    return createDesktopTools(operations, callOptions);
  }

  async function stop(reason = 'user') {
    const res = await session.abort(reason);
    return res;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    try { interlock.dispose(); } catch { /* ignore */ }
    try { await session.abort('dispose'); } catch {}
    try { await hostInstance?.dispose?.(); } catch (error) { log.warn?.(`[desktop] host dispose failed: ${error.code || error.message}`); }
    hostInstance = null;
    hostStartPromise = null;
  }

  const api = {
    VERSION,
    // 模块直通（tools.cjs / ipc.cjs 用）
    host: hostProxy,
    windows,
    actions,
    session,
    compact,
    diff: diffTrees,
    tree: { buildTree, normalizeNodes, fingerprintOf },
    overlay,
    guard,
    input,
    interlock,
    approvals,
    getWin,
    // 记忆闭环的存储（main.cjs 注入；未注入时 tools 的 desktop_skill 会报 not-implemented）
    procedures,
    // 生命周期
    start,
    ensureHost,
    status,
    stop,
    dispose,
    tools,
    // 视觉 / 交接
    screenshot,
    handoff,
    resolveMark,    // #12 → {x,y}：视觉标注编号直接可点
    grounder: getGrounder,  // 接地器实例（未注入模型时为 null）
    // 便捷方法
    listWindows: (opts) => windows.list(opts),
    foreground: () => windows.foreground(),
    displayForRect: (rect) => displayForRect(screen, rect),
    screenInfo: () => windows.screenInfo(),
    windowLabel,
    normalizeWindow,
    // 设置
    settings: {
      get() { return { ...settings }; },
      set(patch = {}) {
        if (patch && typeof patch === 'object') {
          for (const [key, value] of Object.entries(patch)) {
            if (key in DEFAULT_SETTINGS) settings[key] = value;
          }
          if (patch.maxMinutes !== undefined || patch.maxActions !== undefined) {
            session.setBudget({ maxMinutes: settings.maxMinutes, maxActions: settings.maxActions });
          }
        }
        return { ...settings };
      },
    },
  };

  return api;
}

module.exports = {
  createDesktopEngine,
  DEFAULT_SETTINGS,
  VERSION,
};
