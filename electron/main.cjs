// stdout/stderr 的管道守卫必须是**第一条语句**：后面任何一个 require 都可能写日志，
// 而父进程/终端已经关掉时那一次写入就会把主进程变成「A JavaScript error occurred in
// the main process」弹窗。原因与边界见 electron/stdio-guard.cjs 的头注释。
const { installStdioGuards } = require('./stdio-guard.cjs');
/** 日志系统装好之前 onDrop 无处可写，装好后回填（文件日志走 fs，不依赖管道）。 */
let stdioLogSink = null;
installStdioGuards({
  onDrop: (error, stream) => {
    try { stdioLogSink?.warn?.('stdio-unwritable', { stream, code: error?.code ?? null, message: String(error?.message ?? '').slice(0, 160) }); } catch { /* 连文件日志都写不了就只能放弃 */ }
  },
});

const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, net, protocol, safeStorage, screen, session, shell } = require('electron');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { installModelIpc } = require('./model-ipc.cjs');
const { installProjectsIpc } = require('./projects.cjs');
const { installPermissionsIpc, createPermissionStore, createAuditLog } = require('./permissions.cjs');
const { createChangesIpc, installChangesIpc } = require('./changes-ipc.cjs');
const { installViewerIpc } = require('./viewer-ipc.cjs');
const { probeCloudConnection } = require('./cloud-connection.cjs');
const { createDesktopCloud } = require('./cloud-device.cjs');
// 订阅（CLI 模型）的 IPC 装配器。**必须是惰性 + 容错加载**：
// 它是整个应用里最大、最容易出事的一个模块，一旦它在解析期就抛错，
// 顶层 require 会把主进程一起带走 —— 表现为「软件打不开」，
// 而实际上聊天、记忆、浏览器这些功能根本不需要它。
// 所以这里只记下「能不能加载」，装配失败就让订阅页显示不可用，其它功能照常。
let installSubscriptionIpc = null;
let subscriptionLoadError = null;
try {
  ({ installSubscriptionIpc } = require('./subscription/ipc.mjs'));
} catch (error) {
  subscriptionLoadError = error;
  console.warn('subscription module failed to load', error?.message || error);
}
// 订阅 provider 的模型目录（显示名称 / 思考强度）与「是否已登录」的判定入口。
const subscriptionModels = require('./subscription-models.cjs');
// 运行日志：必须尽可能早装——它会给 ipcMain.handle 打计时补丁，装晚了就漏掉前面注册的通道。
const { installLogging, installRendererLogging, getLogger } = require('./logging/index.mjs');

/**
 * 日志先于一切其它模块初始化。
 * 目录 = `app.getPath('userData')/logs`（Windows 上是 %APPDATA%\Mova\logs），
 * 关掉软件后跑 `node scripts/collect-logs.mjs` 就能看到这次运行的全部记录与卡顿告警。
 */
let appLogging = null;
try {
  appLogging = installLogging({ app, ipcMain });
} catch (error) {
  // 日志装不上不能拖垮应用本身。
  console.warn('logging unavailable', error?.message || error);
}
const log = appLogging?.logger ?? getLogger('app');
stdioLogSink = appLogging?.logger ?? null;
const { createApprovalBroker, installApprovalIpc } = require('./approvals.cjs');
const { installInteractionNotifications, conversationFromSessionKey } = require('./interaction-notifications.cjs');
// 人工等待（浏览器接管）登记表：纯 ESM 模块，Node 24 可直接 require。
const { createHumanWaitRegistry } = require('./services/human-wait.mjs');
const { installMemoryIpc } = require('./memory-ipc.cjs');
const { createMemoryRuntime } = require('./memory-runtime.cjs');
const { createLlmMemoryExtractor } = require('./services/memory-extractor.cjs');
const { createChatTitleGenerator } = require('./services/chat-title.cjs');
const { serveChatImage } = require('./chat-images.cjs');
const { createMcpManager } = require('./mcp-manager.cjs');
const { installDesignIpc } = require('./design-ipc.cjs');
const { createAskBroker } = require('./ask.cjs');
const { startEdgeBridge } = require('./edge-bridge.cjs');
const { createSessionSync } = require('./session-sync.cjs');
const { createBrowserController } = require('./browser/controller.cjs');
const { createCredentialBroker } = require('./browser/credentials.cjs');
const { createProcedureStore } = require('./browser/procedures.cjs');
const { createSiteCardStore } = require('./browser/site-cards.cjs');
const { createMemoryMirror } = require('./browser/memory-mirror.cjs');
const { createStorageState } = require('./browser/storage-state.cjs');
const { createLoginRecords } = require('./browser/login-records.cjs');
const { createBrowserSettings } = require('./browser/settings.cjs');
const providers = require('./providers.cjs');
const { installDesktopIpc, createDesktopSettingsStore } = require('./desktop/ipc.cjs');
const { createAudit: createDesktopAudit } = require('./desktop/audit.cjs');
const { createProcedureStore: createDesktopProcedureStore } = require('./desktop/procedures.cjs');
const { createDesktopMemoryMirror } = require('./desktop/memory-mirror.cjs');
const desktopInput = require('./desktop/input.cjs');
const desktopPolicy = require('./desktop/policy.cjs');
const { createGuard: createDesktopGuard } = require('./desktop/guard.cjs');
const { createOverlay: createDesktopOverlay } = require('./desktop/overlay/overlay.cjs');
const { registerBotIpcHandlers } = require('./bots/ipc.mjs');
const { resolveInside } = require('./permissions.cjs');
const { readFile: readPreview, stat: statPreview } = require('node:fs/promises');
const { extname } = require('node:path');

const DIST = resolve(__dirname, '../dist');
const ENTRY = 'mova://app/index.html';
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "frame-src 'self' http: https: blob: data: mova-pdf:",
  "child-src http: https: blob:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'mova', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // PDFs stream from disk instead of a base64 data URL: Chromium refuses large
  // data URLs and the custom-origin blob URL in a frame.
  { scheme: 'mova-pdf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// `mova-pdf://pdf/<rootId>/<relative path>` — read-only, always inside a
// granted project root, capped at the same 20 MB as preview:file.
async function servePdf(request) {
  try {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.host !== 'pdf' || url.username || url.password) {
      return new Response(null, { status: 403 });
    }
    const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
    const rootId = segments.shift() || '';
    const rel = segments.join('/');
    if (!rootId || !rel) return new Response(null, { status: 400 });
    const root = await permissions.get(rootId);
    if (!root?.capabilities?.read) return new Response(null, { status: 403 });
    const absolute = await resolveInside(root.path, rel);
    const info = await statPreview(absolute);
    if (!info.isFile() || info.size > 20_000_000) return new Response(null, { status: 413 });
    const data = await readPreview(absolute);
    return new Response(data, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/**
 * 启动动画文档的 CSP：除 `frame-ancestors` 外与页面一致。
 *
 * 为什么要单独一份：默认 CSP 带 `frame-ancestors 'none'`——它会把启动动画的 iframe 直接废掉
 * （表现为覆盖层里一片空白），而那份动画必须被 `index.html` 嵌进来。收紧到只允许同源父页面。
 */
const SPLASH_CSP = CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

async function serveApp(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.host !== 'app' || url.username || url.password) {
    return new Response(null, { status: 403 });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  // Reject encoded Windows separators, drive/stream syntax and traversal.
  if (pathname.includes('\\') || pathname.includes(':') || pathname.includes('\0')) {
    return new Response(null, { status: 403 });
  }
  if (pathname.startsWith('/chat-images/')) return serveChatImage(pathname.slice('/chat-images/'.length));
  const file = resolve(DIST, `.${pathname}`);
  const name = relative(DIST, file);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
    return new Response(null, { status: 403 });
  }
  try {
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    // 启动动画被父页面 iframe 引用，需要放宽 frame-ancestors（见 SPLASH_CSP）。
    headers.set('Content-Security-Policy', name.startsWith(`splash${sep}`) ? SPLASH_CSP : CSP);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function senderWindow(event) {
  const frame = event.senderFrame;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !frame || frame !== event.sender.mainFrame || frame.url !== ENTRY) {
    throw new Error('IPC requires the Mova app');
  }
  return win;
}

let memoryRuntime;
let auditLog;
const permissionAudit = entry => {
  auditLog ??= createAuditLog(join(app.getPath('userData'), 'permissions-audit.jsonl'));
  void auditLog(entry);
};

// Native confirmation is the trust anchor for *granting* a capability: the
// renderer and the model cannot widen access on their own. A single write or
// command is approved in the app instead (see approvals.cjs), because an OS
// modal blocks the window and cannot be dismissed when the run is cancelled.
// 审批之外的人工等待都记在这里（browser handoff 最长 10 分钟，期间没有任何 emit）。
// 浏览器控制器负责 begin/end，model-ipc 订阅它来暂停静默计时——两处必须是同一个实例。
const humanWait = createHumanWaitRegistry();
// 审批等待上限必须 ≥ ACP idle（600s）与 browser handoff（10min），否则人工思考时间会被系统裁掉。
const approvals = createApprovalBroker({ timeoutMs: 600_000 });
const asks = createAskBroker({ ipcMain, authorize: senderWindow, humanWait });
const mcpManager = createMcpManager({ authorize: senderWindow, approvals });
const designRuntime = installDesignIpc({ ipcMain, directory: join(app.getPath('userData'), 'design'), authorize: senderWindow });
let mainWindow = null;
/** 应用图标（任务栏 / 标题栏 / Alt-Tab）；生成方式见 scripts/make-icon.cjs。 */
const ICON_PATH = resolve(__dirname, '..', 'assets', 'app-icon.png');
/**
 * 默认窗口尺寸：产品要求 2300×1450，单位是**物理像素**。
 * Electron 的 width/height 是 DIP，所以在缩放的屏幕上必须换算，再夹到工作区里。
 */
const TARGET_WINDOW = Object.freeze({ width: 2300, height: 1450 });

/**
 * 把「2300×1450 物理像素」换算成 Electron 要的 DIP，并夹在工作区内。
 * 不夹的话：1440×900 的逻辑屏上会开出一个四倍于屏幕的窗口，右上角的关闭按钮都点不到。
 */
function defaultWindowSize() {
  const { workArea, scaleFactor } = screen.getPrimaryDisplay();
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return {
    width: Math.max(360, Math.min(Math.round(TARGET_WINDOW.width / scale), workArea.width)),
    height: Math.max(480, Math.min(Math.round(TARGET_WINDOW.height / scale), workArea.height)),
    scale,
  };
}
let vaultRepository = null;
// Test-only in-memory vault; never selected unless the launcher opts in.
const testVault = process.env.MOVA_TEST_VAULT === '1'
  ? require('./browser/test-vault.cjs').createMemoryVault()
  : null;
const credentials = createCredentialBroker({ getVault: () => testVault || vaultRepository });
const procedures = createProcedureStore({ directory: join(app.getPath('userData'), 'browser') });
const cards = createSiteCardStore({ directory: join(app.getPath('userData'), 'browser') });
const memoryMirror = createMemoryMirror({ getMemory: () => memoryRepository });
const downloadsDir = join(app.getPath('userData'), 'browser', 'downloads');
mkdirSync(downloadsDir, { recursive: true });
const storageState = createStorageState({ app, safeStorage });
const loginRecords = createLoginRecords({ app, safeStorage });
// 浏览器设置是单一权威：下载目录、超时、Diff 阈值、快照预算、授权等级都由它派生。
const browserSettings = createBrowserSettings({
  filePath: () => join(app.getPath('userData'), 'browser', 'settings.json'),
  defaultDownloadsDir: downloadsDir,
});
const browser = createBrowserController({
  app, getWindow: () => mainWindow, credentials, procedures, cards, memoryMirror, downloadsDir, storageState, loginRecords,
  settings: browserSettings,
  // 人工接管期间登记成「人工等待」，让 model-ipc 的静默计时暂停（否则 240s 就 abort 整个回合）。
  humanWait,
  // 清理 / 重置需要分区会话；下载后打开需要外壳。
  getSession: partition => session.fromPartition(partition),
  openPath: target => shell.openPath(target),
  // 本地文件白名单：**默认关闭**，只有落在「已登记项目根」内的可展示类型（html/svg/图片/pdf 等）
  // 才允许 file: 导航；根外一律拒绝（file_outside_roots）。判定点在
  // electron/browser/target.cjs 的 resolveLocalFileTarget（realpath + 根归属）。
  // 这里只提供「已登记的绝对路径」：store 就在本文件下面几行创建（同一个实例），
  // 而 roots() 只在真正导航时才会被调用，所以用惰性闭包取，绝不另建一个 store。
  localFiles: {
    roots: async () => {
      const { roots } = await permissions.list();
      return roots.map(root => root.path).filter(Boolean);
    },
  },
});

// ── 桌面操作引擎（可选能力）──────────────────────────────────────────
// createDesktopEngine 由 electron/desktop/index.cjs 提供；它是并行开发的核心通道，
// 因此这里必须容错：文件缺失/平台不支持时只记一条日志，主窗口、聊天、浏览器照常工作，
// 设置页会显示「不可用：<原因>」（desktop:status 的 reason）。
const desktopDir = join(app.getPath('userData'), 'desktop');
const desktopAudit = createDesktopAudit({ directory: desktopDir });
// 设置只认一个形状（policy.cjs 的 DEFAULT_SETTINGS）：渲染进程、工具层、引擎都从这里派生，
// 引擎拿到的是它自己认识的平铺投影（见 policy.json#settings）。
const desktopSettings = createDesktopSettingsStore({ directory: desktopDir });
// 技能库（L2）用同一个实例给引擎、工具层和设置页，避免三份缓存互相覆盖。
const desktopProcedures = createDesktopProcedureStore({ directory: desktopDir });
// 桌面技能也进长期记忆：完整步骤留在 procedures.json，记忆库只放一条可检索的索引卡
// （key = desktop.procedure.<id>，重复保存会被 addMemory 按 text+key 去重）。
// memoryRepository 在下面才创建，所以用 getter 惰性取。
const desktopMemoryMirror = createDesktopMemoryMirror({ getMemory: () => memoryRepository });
const desktopSaveProcedure = desktopProcedures.save.bind(desktopProcedures);
desktopProcedures.save = async (input) => {
  const record = await desktopSaveProcedure(input);
  if (record && record.id) void desktopMemoryMirror.mirror(record);
  return record;
};

// ── 接地模型（视觉兜底的 callModel 真实实现）────────────────────────────────
// grounder.cjs 只认一个契约：{ system, prompt, image(PNG base64) } → 一段文本（严格 JSON 由它解析）。
// 这里走的就是聊天那条已有通道：providers 解析 provider/模型 + 已存 API key + pi-ai 的 streamSimple，
// 只是只问一次、20s 超时、失败降级成 {ok:false, code:'ground-model-failed'}，绝不把异常抛给桌面会话。
const GROUND_TIMEOUT_MS = 20_000;
let groundFramesUsed = 0; // 每真正调用一次模型算一帧（对齐 settings.budget.maxVisionFrames）

function groundFail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

/** 接地模型取 settings.advanced.groundingModel，留空跟随当前默认模型（与聊天一致）。 */
async function resolveGroundTarget() {
  const wanted = String(desktopSettings.read()?.advanced?.groundingModel || '').trim();
  if (!wanted) return providers.resolveActive();
  return providers.resolveActive(undefined, wanted).catch(async () => {
    // 接地模型可能挂在别的 provider 上：按模型 id 全局找一次。
    const list = await providers.listProviders();
    const hit = (list.providers || []).find((row) => (row.models || []).some((item) => item.id === wanted));
    if (!hit) throw groundFail('not_found', `找不到接地模型「${wanted}」`);
    return providers.resolveModel(hit.id, wanted);
  });
}

/** pi-ai 的模型描述（同一个适配层，只是接地固定要图像输入、不要推理）。 */
function groundPiModel(entry, provider) {
  const anthropic = provider?.protocol === 'anthropic';
  return {
    id: entry.id,
    name: entry.name || entry.id,
    api: anthropic ? 'anthropic-messages' : 'openai-completions',
    provider: `mova-${provider.id}`,
    baseUrl: provider.baseUrl,
    input: ['text', 'image'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(entry.contextWindow) || 128_000,
    maxTokens: 4_096,
  };
}

/** 注入给引擎（desktop/vision/grounder.cjs）的 callModel。 */
async function groundModel(input = {}) {
  const image = typeof input.image === 'string' ? input.image : '';
  const prompt = String(input.prompt || '').slice(0, 8000);
  const system = String(input.system || '').slice(0, 4000);
  if (!prompt) throw groundFail('ground-model-failed', '接地请求缺少 prompt');
  if (!image) throw groundFail('ground-model-failed', '接地请求缺少截图');
  // 帧预算再兜一层（与 grounder 内部同一个判定：policy.visionAllowed）。
  const now = desktopSettings.read();
  if (now?.advanced?.vision === false) throw groundFail('vision-disabled', '视觉通道已在设置中关闭');
  if (!desktopPolicy.visionAllowed(now, groundFramesUsed)) throw groundFail('vision-budget-exhausted', '视觉帧预算已用完');

  let provider;
  let model;
  try {
    ({ provider, model } = await resolveGroundTarget());
  } catch (error) {
    throw groundFail('ground-model-failed', error?.message || '没有可用的接地模型');
  }
  if (model.vision === false) throw groundFail('ground-model-failed', `接地模型「${model.id}」不支持图像输入`);
  const apiKey = await providers.loadProviderKey(provider.id).catch(() => '');
  if (!apiKey) throw groundFail('ground-model-failed', `接地模型「${model.id}」缺少 API key（设置 → 模型）`);

  const signal = AbortSignal.timeout(GROUND_TIMEOUT_MS);
  let stream;
  try {
    const sdk = await import(provider.protocol === 'anthropic'
      ? '@earendil-works/pi-ai/api/anthropic-messages'
      : '@earendil-works/pi-ai/api/openai-completions');
    stream = sdk.streamSimple(groundPiModel(model, provider), {
      messages: [
        ...(system ? [{ role: 'system', content: [{ type: 'text', text: system }], timestamp: Date.now() }] : []),
        {
          role: 'user',
          timestamp: Date.now(),
          content: [{ type: 'text', text: prompt }, { type: 'image', data: image, mimeType: 'image/png' }],
        },
      ],
    }, { apiKey, maxTokens: 512, maxRetries: 0, signal });
  } catch (error) {
    throw groundFail('ground-model-failed', error?.message || '接地模型请求失败');
  }
  groundFramesUsed += 1;

  let message;
  let timer;
  try {
    // result() 在中断/超时时可能永远不落定：再压一层硬超时，保证不挂住桌面会话。
    const ceiling = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(groundFail('ground-model-failed', `接地模型 ${Math.round(GROUND_TIMEOUT_MS / 1000)}s 超时`)),
        GROUND_TIMEOUT_MS + 1_000,
      );
      timer.unref?.();
    });
    message = await Promise.race([stream.result(), ceiling]);
  } catch (error) {
    throw groundFail('ground-model-failed', (error && error.message) || '接地模型调用失败');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (message?.stopReason === 'error') throw groundFail('ground-model-failed', message.errorMessage || '接地模型返回错误');
  const text = (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) throw groundFail('ground-model-failed', '接地模型没有返回文本');
  return text;
}

let desktop = null;
let desktopOverlay = null;
let desktopGuard = null;
try {
  const { createDesktopEngine } = require('./desktop/index.cjs');
  const initial = desktopSettings.read();

  // 浮层与守护：都允许失败（例如无显示器/无权限），失败只让能力降级，不影响引擎本体。
  try {
    desktopOverlay = createDesktopOverlay({ app, screen });
  } catch (error) {
    desktopOverlay = null;
    console.warn('desktop overlay unavailable', error?.message || error);
  }
  try {
    desktopGuard = createDesktopGuard({
      onAbort: (reason) => { void desktop?.stop?.(reason); },
    });
  } catch (error) {
    desktopGuard = null;
    console.warn('desktop guard unavailable', error?.message || error);
  }

  desktop = createDesktopEngine({
    app,
    screen,
    approvals,
    audit: desktopAudit,
    directory: desktopDir,
    getWin: () => mainWindow,
    // 桌面人工接管期间登记成「人工等待」：与 model-ipc 订阅的是同一个登记表（默认 10 分钟 / 最长 30 分钟）。
    humanWait,
    input: desktopInput,
    guard: desktopGuard,
    overlay: desktopOverlay,
    policy: desktopPolicy,
    // index.cjs 的 DEFAULT_SETTINGS 是平铺的；这里只投影它认识的键。
    settings: {
      enabled: initial.enabled,
      maxMinutes: initial.budget.maxMinutes,
      maxActions: initial.budget.maxActions,
      maxDepth: initial.advanced.maxDepth,
      deadlineMs: initial.advanced.treeTimeoutMs,
      excludeApps: initial.advanced.excludeProcesses,
    },
    procedures: desktopProcedures,
    // 视觉兜底的接地模型：真实 callModel + 设置口径（vision 开关 / maxVisionFrames）。
    groundModel,
    groundSettings: () => desktopSettings.read(),
  });
  if (desktop) {
    // 引擎没有把这两个挂到 api 上（核心通道还没接）：这里补上，工具层/设置页直接用。
    desktop.procedures = desktopProcedures;
    desktop.settingsView = () => desktopSettings.read();
    // 视觉兜底入口：SoM 截图 → grounder → {ok, point|mark} / {ok:false, code}（永不抛给会话）。
    desktop.ground = async (goal, options = {}) => {
      const grounder = typeof desktop.grounder === 'function' ? desktop.grounder() : null;
      if (!grounder) return { ok: false, code: 'vision-unavailable', message: '接地模型未注入' };
      // 先判开关：视觉关闭时连截图都不做（grounder 内部还会再判一次）。
      if (desktopSettings.read()?.advanced?.vision === false) {
        return { ok: false, code: 'vision-disabled', message: '视觉通道已在设置中关闭' };
      }
      let shot;
      try {
        shot = await desktop.screenshot({
          mode: options.mode || 'window',
          window: options.window || '',
          // 接地优先用编号（模型只回 #N，最稳）；OCR 只负责给编号供料，options.ocr=false 可关。
          annotate: 'som',
          ocr: options.ocr !== false,
          maxLongEdge: options.maxLongEdge || 1280,
          reason: 'visual-check',
        });
      } catch (error) {
        return { ok: false, code: (error && error.code) || 'screenshot-failed', message: (error && error.message) || '截图失败' };
      }
      const imagePath = shot && (shot.annotatedPath || shot.path);
      if (!imagePath) return { ok: false, code: 'screenshot-failed', message: '截图没有生成文件' };
      let buffer;
      try {
        buffer = await readPreview(imagePath);
      } catch {
        return { ok: false, code: 'screenshot-failed', message: '截图读取失败' };
      }
      return grounder.locate({
        buffer,
        size: [shot.width, shot.height],
        marks: Array.isArray(shot.marks) ? shot.marks : [],
        goal: String(goal || ''),
      });
    };
    // 已消耗的视觉帧数（排查预算用）。
    desktop.visionFrames = () => ({ used: groundFramesUsed, grounding: typeof desktop.grounder === 'function' ? desktop.grounder()?.stats?.() || null : null });
  }
} catch (error) {
  desktop = null;
  console.warn('desktop engine unavailable', error?.message || error);
}

async function nativeConfirm(request) {
  const win = request?.win && !request.win.isDestroyed?.() ? request.win : null;
  const approval = request?.mode === 'approval';
  const options = {
    type: 'warning',
    title: request?.title || '权限确认',
    message: request?.message || '允许这次操作？',
    detail: request?.detail || '',
    buttons: approval ? ['拒绝', '允许一次', '本次会话允许'] : ['取消', '允许'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  try {
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (!approval) return response === 1 ? 'allow' : 'deny';
    return response === 1 ? 'once' : response === 2 ? 'session' : 'deny';
  } catch {
    return 'deny';
  }
}

async function requestApproval(request) {
  if (request?.mode === 'approval' && request.win?.webContents && !request.win.isDestroyed?.()) {
    return approvals.ask(request.win.webContents, {
      kind: 'approval',
      conversationId: conversationFromSessionKey(request.sessionKey),
      title: request.title,
      message: request.message,
      detail: request.detail,
      capability: request.capability,
      // The bar needs the opaque root id to offer "reveal in file manager";
      // the root path itself never crosses to the renderer here.
      rootId: request.rootId ?? null,
      rootName: request.rootName ?? null,
      preview: request.preview ?? null,
    }, request.signal);
  }
  return nativeConfirm(request);
}

const permissions = createPermissionStore({
  filePath: () => join(app.getPath('userData'), 'permissions.json'),
  confirm: requestApproval,
  audit: permissionAudit,
});

// Right-side viewer: directory listing / file reading + in-page inspect.
// Both stay behind a granted project root; main.cjs only wires them.
installViewerIpc({ ipcMain, permissions, shell, browser, senderWindow });

// One source for the change-history folder: the chat agent writes entries here
// and the read-only change IPC reads the very same files.
const historyDir = () => join(app.getPath('userData'), 'file-history');
const sessionSync = createSessionSync();
const edgeHandlers = {};
let edgeBridge;

const memoryRepository = installMemoryIpc(senderWindow, {
  // The window is created immediately; the first memory call waits for Docker,
  // migrations, PostgreSQL and the local model to become ready.
  repositoryProvider: () => memoryRuntime.start(),
  sessionSync,
});
// The vault proxy is lazy: it is only used when the browser asks for it.
vaultRepository = memoryRepository;
// Conversation titles: one short request after the first exchange. It answers '' on any failure,
// and the renderer keeps the title it derived from the question in that case.
// 订阅账号没有 API key（`loadProviderKey` 对内置订阅 provider 恒返回空串），所以这里补两条依赖：
//   acquireChatgptToken —— 从账号池取一次 access token（装配顺序在下面，闭包里懒读，调用时已就绪）
//   resolveFetch        —— 该模型分配了 VPN 线路时用代理 fetch（直连环境打不开 chatgpt.com）
const chatTitleGenerator = createChatTitleGenerator({
  logger: console,
  acquireChatgptToken: async () => (typeof subscriptionIpc?.acquireChatgptTurn === 'function'
    ? subscriptionIpc.acquireChatgptTurn().catch(() => null)
    : null),
  resolveFetch: async (providerId, modelId) => {
    const runtime = vpnIpc?.runtime;
    const proxyUrl = runtime?.routeFor?.(providerId, modelId)?.proxyUrl || '';
    return proxyUrl && typeof runtime.createModelFetch === 'function' ? runtime.createModelFetch(proxyUrl) : null;
  },
});
ipcMain.handle('titles:suggest', async (event, input) => {
  try {
    if (await senderWindow(event) === false) return { ok: false, error: 'unauthorized' };
  } catch { return { ok: false, error: 'unauthorized' }; }
  try {
    const title = await chatTitleGenerator.generate({
      user: String(input?.user ?? ''),
      assistant: String(input?.assistant ?? ''),
      // 用「这条对话真正在跑的模型」取名：拿持久化的 active 会在订阅/自建 provider 混用时取不到 key。
      providerId: typeof input?.providerId === 'string' ? input.providerId : '',
      modelId: typeof input?.modelId === 'string' ? input.modelId : '',
    });
    return title ? { ok: true, value: { title } } : { ok: false, error: 'title-unavailable' };
  } catch (error) {
    return { ok: false, error: error?.message || 'title-unavailable' };
  }
});
const cancelModelRuns = installModelIpc(senderWindow, memoryRepository, {
  edgeHandlers,
  permissions,
  approvals,
  historyDir,
  mcpManager,
  cloudProjects: (action, origin, input) => cloudDevice()(action, origin, input),
  designRuntime,
  asks,
  browser,
  browserSettings,
  // 有人工等待（浏览器接管）时暂停静默计时：与 browser controller 共用同一个登记表。
  humanWait,
  // 桌面引擎由 chat-agent 通过 desktop/ipc.cjs 的 currentDesktop() 兜底获取；
  // 这里一并传下去，等 model-ipc 转发 desktop 参数后无需再改。
  desktop,
});
ipcMain.handle('edge:pair', async event => {
  const win = senderWindow(event);
  edgeBridge ??= startEdgeBridge({
    handlers: edgeHandlers, memory: memoryRepository, sync: sessionSync, approvals, asks,
    fileDirectory: join(app.getPath('userData'), 'edge-files'),
  });
  clipboard.writeText(edgeBridge.pair());
  await dialog.showMessageBox(win, {
    type: 'info', title: 'Mova Edge', message: '配对码已复制',
    detail: '在 Edge 的 Mova 侧边栏粘贴配对码。配对码五分钟内有效。',
  });
});
installProjectsIpc(senderWindow, { ipcMain, dialog, registerRoots: (folders, win) => permissions.register(folders, { win }) });
installPermissionsIpc(senderWindow, { ipcMain, store: permissions });
const changes = createChangesIpc({ permissions, historyDir, audit: permissionAudit });
installChangesIpc(ipcMain, changes, senderWindow);
installApprovalIpc(senderWindow, { ipcMain, broker: approvals });
installInteractionNotifications({ ipcMain, Notification, authorize: senderWindow });
let botIpc = null;
let botTray = null;

function showMainWindowAndNavigate(conversationId = null) {
  const dispatchNav = targetWin => {
    if (!conversationId || !targetWin || targetWin.isDestroyed?.()) return;
    try {
      targetWin.webContents.send('bots:event', { type: 'navigate:conversation', conversationId });
    } catch { /* ignore */ }
  };
  if (mainWindow && !mainWindow.isDestroyed?.()) {
    if (mainWindow.isMinimized?.()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    dispatchNav(mainWindow);
    return;
  }
  void createWindow().then(() => {
    if (mainWindow && !mainWindow.isDestroyed?.()) dispatchNav(mainWindow);
  }).catch(err => console.warn('recreate window from tray failed', err?.message || err));
}

function buildBotTrayMenu() {
  const convs = botIpc?.runtime?.conversationService?.listConversations?.() || [];
  const primaryConv = convs[0] || null;
  const triggers = botIpc?.runtime?.store?.state?.triggers || [];
  const hasEnabledTriggers = triggers.some(t => t.enabled);
  const template = [
    {
      label: '打开主窗口',
      click: () => showMainWindowAndNavigate(),
    },
    ...(primaryConv ? [{
      label: `打开最近 Bot 对话（${String(primaryConv.title || 'Bot').slice(0, 18)}）`,
      click: () => showMainWindowAndNavigate(primaryConv.id),
    }] : []),
    { type: 'separator' },
    {
      label: hasEnabledTriggers ? '暂停后台定时触发器' : '已无启用中的后台触发器',
      enabled: hasEnabledTriggers,
      click: () => {
        try {
          botIpc?.runtime?.store?.mutate?.(state => {
            for (const trg of state.triggers || []) {
              trg.enabled = false;
            }
          });
          botIpc?.runtime?.updateRuntimeSettings?.({ keepAliveOnWindowClose: false });
          if (botTray && !botTray.isDestroyed?.()) {
            botTray.setContextMenu(buildBotTrayMenu());
          }
        } catch (err) {
          console.warn('pause bot triggers failed', err?.message || err);
        }
      },
    },
    { type: 'separator' },
    {
      label: '彻底退出 Mova',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ];
  return Menu.buildFromTemplate(template);
}

function ensureBotTray() {
  try {
    if (botTray && !botTray.isDestroyed?.()) {
      botTray.setContextMenu(buildBotTrayMenu());
      return botTray;
    }
    let trayIcon = nativeImage.createFromPath(ICON_PATH);
    if (trayIcon.isEmpty?.()) {
      trayIcon = nativeImage.createEmpty();
    } else if (process.platform === 'win32') {
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
    }
    botTray = new Tray(trayIcon);
    botTray.setToolTip('Mova Bot · 后台定时任务与主动提醒运行中');
    botTray.setContextMenu(buildBotTrayMenu());
    botTray.on('click', () => showMainWindowAndNavigate());
    botTray.on('double-click', () => showMainWindowAndNavigate());
    botTray.on('right-click', () => {
      if (botTray && !botTray.isDestroyed?.()) {
        botTray.setContextMenu(buildBotTrayMenu());
        botTray.popUpContextMenu();
      }
    });
    return botTray;
  } catch (err) {
    console.warn('bot tray unavailable', err?.message || err);
    return null;
  }
}

try {
  botIpc = registerBotIpcHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    senderWindow,
    userDataPath: app.getPath('userData'),
    pgPool: () => memoryRuntime?.pool ?? null,
    memoryRepository,
    Notification,
    cloudTaskCall: (origin, action, input) => cloudDevice()(action, origin, input),
    onOpenConversation: conversationId => showMainWindowAndNavigate(conversationId),
    logger: console,
  });
} catch (error) {
  console.warn('bot ipc unavailable', error?.message || error);
}
/**
 * 按模型分配 VPN 线路（`electron/vpn/*`）：可选能力，装配失败只影响「网络与线路」设置页。
 * 同样走 try/catch：内核二进制、端口、safeStorage 任何一环出问题，
 * 聊天与其余设置页都必须照常可用（未分配线路 = 完全直连，与未安装本功能等价）。
 */
let vpnIpc = null;
try {
  const { installVpnIpc } = require('./vpn/ipc.mjs');
  vpnIpc = installVpnIpc({
    ipcMain,
    app,
    safeStorage,
    clipboard,
    dialog,
    authorize: senderWindow,
    getWin: () => mainWindow,
    logger: getLogger('vpn'),
    // `taskkill /T /F` 的既有实现只有一份（见 acp/engine.mjs 头注释）：这里只借用，不复制。
    // 惰性 require：内核没装时根本不加载这个模块，别拖慢启动。
    killTree: pid => require('./acp/engine.mjs').killProcessTree(pid),
  });
} catch (error) {
  log.error('vpn ipc unavailable', {
    message: String(error?.message || error).slice(0, 300),
  });
}
/**
 * 开机自启内核（`core.autoStart`，默认开）。
 *
 * 必须在**窗口起来之后**异步做，而且绝不能 await：内核启动要拉起子进程、写配置、开监听端口，
 * 让它挡住首屏是本末倒置。但也不能不做——内核没起时 `ports` 为空，`envForModel()` 返回 null，
 * ACP 子进程与额度探针都会直连，表现为「模型没连 VPN，国内连不上」。
 */
if (vpnIpc && typeof vpnIpc.runtime?.maybeAutoStart === 'function') {
  setTimeout(() => {
    vpnIpc.runtime.maybeAutoStart()
      .then(result => { if (result?.started) log.info('vpn core autostarted', result); })
      .catch(error => log.warn('vpn autostart failed', { message: String(error?.message || error).slice(0, 200) }));
  }, 1_500);
}
// 订阅（CLI 模型）：装配失败只告警——设置页显示不可用，主窗口与其他功能照常。
/**
 * 订阅模块的日志出口。
 * 它按 `log.warn('消息', 短字符串)` 这种形状调用，而我们的 logger 第二参是对象；
 * 这里做个收口，让「登录失败 / CLI 探测耗时」这类关键记录真正落进日志文件，
 * 而不是像以前那样只打到 console 就丢了。
 */
const subscriptionLogger = ['trace', 'debug', 'info', 'warn', 'error'].reduce((api, level) => {
  api[level] = (message, data) => log[level](message, data && typeof data === 'object' ? data : { detail: data });
  return api;
}, {});

let subscriptionIpc = null;
if (typeof installSubscriptionIpc === 'function') {
  try {
    subscriptionIpc = installSubscriptionIpc({
      ipcMain,
      app,
      shell,
      safeStorage,
      userDataDir: app.getPath('userData'),
      fetch: globalThis.fetch,
      logger: subscriptionLogger,
      // ChatGPT 走浏览器授权（Codex 公开 PKCE 客户端），不再复用本机 Codex CLI 的登录态。
    });
  } catch (error) {
    console.warn('subscription ipc unavailable', error?.message || error);
  }
} else {
  // 模块没能加载：订阅页会显示不可用，其它功能照常。把原因写进日志，别只留在控制台。
  log.error('subscription module unavailable', {
    message: String(subscriptionLoadError?.message || subscriptionLoadError || 'unknown').slice(0, 300),
  });
}
/**
 * 把「这个订阅通道有没有登录账号」告诉模型目录。
 *
 * 为什么必须注入：`listProviders()` 是纯同步装配，它自己不知道 OAuth 登录态；没有这个探针，
 * 两个订阅 provider 的 `configured` 永远是 false，右下角模型菜单里就永远不会出现它们。
 * 探针内部拿的是 service.list()（已带 CLI 状态缓存），subscription-models 侧还有 5s 缓存，
 * 所以一次设置页读取最多多一次账号快照，不会把主进程拖慢。
 */
if (subscriptionIpc?.service) {
  subscriptionModels.setAccountProbe(async () => {
    const snapshot = await subscriptionIpc.service.list();
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const out = {};
    for (const target of subscriptionModels.TARGETS) {
      const rows = accounts.filter(row => row.provider === target);
      out[target] = { configured: rows.length > 0, count: rows.length, email: rows[0]?.email || null };
    }
    return out;
  });
  // 预热一次：让「模型」页第一次 providers:list 不必等一次 CLI 探测（实测冷启动 3.5s）。
  void subscriptionModels.accountState().catch(() => {});
}

/**
 * 模型枚举探针：Gemini 侧的真清单来自 ACP（`initialize` + `session/new` 的 models，
 * 与 t3code 的 provider-acp 同一套）；ChatGPT 侧没有可用的枚举接口，
 * 返回 null 让上层回落到内置目录并如实说明。
 */
if (subscriptionIpc?.service?.listAcpModels) {
  subscriptionModels.setModelProbe(async target => {
    if (target !== 'gemini') return null;
    const cli = await subscriptionIpc.service.getCliStatus();
    if (!cli?.found || typeof cli.command !== 'string' || !cli.command) return null;
    const listed = await subscriptionIpc.service.listAcpModels(cli.command);
    if (!listed.ok) return { models: [], source: 'acp', note: `ACP 读不到模型清单：${listed.detail}` };
    return {
      models: listed.models,
      source: 'probe',
      note: '来自本机 antigravity CLI 的 ACP 会话（session/new）实时清单',
    };
  });
}
// 桌面操作：status/stop/resume/settings/skills + step/state/unavailable 事件。
// 引擎缺失时这些 handler 仍然注册，返回“不可用”，设置页才不会白屏。
const desktopIpc = installDesktopIpc({
  ipcMain,
  desktop,
  authorize: senderWindow,
  directory: desktopDir,
  settings: desktopSettings,
  getWin: () => mainWindow,
});
ipcMain.handle('preview:file', async (event, input) => {
  senderWindow(event);
  try {
    const root = await permissions.get(input?.rootId);
    if (!root?.capabilities?.read) throw new Error('没有读取权限');
    const path = await resolveInside(root.path, input?.path);
    const info = await statPreview(path);
    if (!info.isFile() || info.size > 20_000_000) throw new Error('文件不可预览或超过 20 MB');
    const ext = extname(path).toLowerCase();
    const mime = ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[ext];
    const data = await readPreview(path);
    if (mime) return { ok: true, value: { mime, data: data.toString('base64'), path: input.path } };
    if (data.includes(0)) throw new Error('此文件格式暂不支持预览');
    return { ok: true, value: { mime: 'text/plain', data: data.toString('utf8'), path: input.path } };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('browser:external', async (event, url) => {
  senderWindow(event);
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  await shell.openExternal(parsed.href); return true;
});

function browserHandler(channel, operation) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      senderWindow(event);
      return { ok: true, value: await operation(...args) };
    } catch (error) {
      return { ok: false, error: error?.code || 'failed', message: error?.message || '浏览器操作失败' };
    }
  });
}
browserHandler('browser:credential:status', () => browser.credentialStatus());
browserHandler('browser:credential:list', () => browser.credentialList());
browserHandler('browser:login-record:has', input => browser.hasLoginRecord(input?.origin, input?.conversationId));
ipcMain.handle('browser:login-record:ask', async (event, input) => {
  try {
    senderWindow(event);
    const origin = typeof input?.origin === 'string' ? input.origin : '';
    if (!origin) return { ok: false, error: 'origin' };
    // 「再次访问时询问」关掉后直接复用 Cookie，不再打断用户。
    if (browserSettings.read().login.askCookieLogin === false) {
      return { ok: true, value: { ok: true, decision: 'allow', skipped: true } };
    }
    const decision = await approvals.ask(event.sender, {
      capability: 'cookie',
      message: '发现该站点的登录记录，是否用 Cookie 登录？',
      detail: `${origin} · 已保存 Cookie 与本地存储`,
      allowSession: false,
    }, undefined);
    return { ok: true, value: { ok: true, decision } };
  } catch (error) {
    return { ok: false, error: error?.code || 'failed', message: error?.message || '审批失败' };
  }
});
browserHandler('browser:login-record:save', input => browser.saveLoginRecord(input?.spaceId, input?.conversationId));
browserHandler('browser:login-record:use', input => browser.useLoginRecord(input?.origin, input?.spaceId, input?.conversationId));
browserHandler('browser:credential:save', input => browser.saveCredential(input));
browserHandler('browser:credential:fill', input => browser.fillCredential(input));
browserHandler('browser:skill:list', () => browser.skillList());
browserHandler('browser:skill:save', input => browser.skillSave(input));
browserHandler('browser:skill:remove', id => browser.skillRemove(id));
// ── 浏览器设置：单一存储 + 运行时派生 ──────────────────────────────
browserHandler('browser:settings:get', () => browserSettings.read());
browserHandler('browser:settings:set', patch => browserSettings.patch(patch));
browserHandler('browser:settings:pick-download-dir', async event => {
  senderWindow(event);
  const current = browserSettings.read().transfer.downloadDir;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择下载目录',
    defaultPath: current || downloadsDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths?.length) return null;
  const dir = result.filePaths[0];
  browserSettings.patch({ transfer: { downloadDir: dir } });
  return dir;
});
browserHandler('browser:settings:reset-download-dir', () => {
  const dir = browserSettings.defaults().transfer.downloadDir;
  browserSettings.patch({ transfer: { downloadDir: dir } });
  return dir;
});
browserHandler('browser:settings:open-download-dir', async () => {
  const dir = browserSettings.read().transfer.downloadDir || downloadsDir;
  const error = await shell.openPath(dir);
  return { opened: !error, dir, error: error || null };
});
browserHandler('browser:cards:list', () => browser.cardsList());
browserHandler('browser:cards:clear', input => browser.cardsClear(input));
browserHandler('browser:active-url', () => browser.activeUrl());
browserHandler('browser:clear-data', input => browser.clearData(input));
browserHandler('browser:reset-partition', () => browser.resetPartition());
browserHandler('browser:storage:export', spaceId => browser.storageExport(spaceId));
browserHandler('browser:storage:import', spaceId => browser.storageImport(spaceId));
ipcMain.handle('browser:takeover:respond', (event, id, decision) => {
  try { senderWindow(event); } catch { return { ok: false, error: 'unauthorized' }; }
  return { ok: browser.respondHandoff(id, decision) };
});
ipcMain.on('browser:tab:ready', (event, payload) => {
  try { senderWindow(event); browser.tabReady(payload?.tabId, payload?.guestId, payload?.spaceId); } catch { /* ignore unauthorized */ }
});
ipcMain.on('browser:tab:active', (event, payload) => {
  try { senderWindow(event); browser.tabActive(payload?.tabId, payload?.spaceId); } catch { /* ignore unauthorized */ }
});
ipcMain.on('browser:tab:closed', (event, payload) => {
  try { senderWindow(event); browser.tabClosed(payload?.tabId); } catch { /* ignore unauthorized */ }
});
ipcMain.on('browser:tab:cleared', (event, payload) => {
  try { senderWindow(event); browser.tabCleared(payload?.spaceId); } catch { /* ignore unauthorized */ }
});

ipcMain.handle('clipboard:write', (event, text) => {
  senderWindow(event);
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid clipboard text');
  clipboard.writeText(text);
  return true;
});
ipcMain.handle('cloud:probe', (event, address) => {
  senderWindow(event);
  return probeCloudConnection(address);
});
let desktopCloud;
function cloudDevice() {
  return desktopCloud ??= createDesktopCloud({ userData: app.getPath('userData'), safeStorage,
    exportVpn: async () => (await import('./vpn/cloud-export.mjs')).exportCloudVpn(vpnIpc?.store) });
}
ipcMain.handle('cloud:device', async (event, action, address, input) => {
  senderWindow(event);
  try { return { ok: true, value: await cloudDevice()(action, address, input) }; }
  catch (error) { return { ok: false, status: error.status, code: error.code, message: String(error.message || '云端连接失败').slice(0, 300) }; }
});
ipcMain.handle('window:is-maximized', event => senderWindow(event).isMaximized());
ipcMain.handle('window:action', (event, action) => {
  const win = senderWindow(event);
  switch (action) {
    case 'minimize': win.minimize(); break;
    case 'toggleMaximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'close': win.close(); break;
    default: throw new Error('Unknown window action');
  }
});

/**
 * 主窗口。
 *
 * 启动动画**不再单开一个窗口**：它由 `index.html` 里的 `#boot-splash` 覆盖层承载
 * （iframe 引 `splash/mova-startup.html`），所以窗口从第一帧起就是最终大小、最终位置，
 * 动画放完只是把覆盖层收掉，全程不换窗口、不闪一下。收尾条件在渲染层（`app.js`）。
 */
async function createWindow() {
  const size = defaultWindowSize();
  const startedAt = Date.now();
  const win = new BrowserWindow({
    title: 'Mova',
    width: size.width,
    height: size.height,
    minWidth: 360,
    minHeight: 480,
    center: true,
    frame: false,
    show: false,
    backgroundColor: '#202020',
    icon: ICON_PATH,
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      webviewTag: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // 渲染进程的 console 错误、preload 失败、渲染进程崩溃、无响应都进同一份日志：
  // 「页面卡住 / 白屏」这类问题只有把主进程与渲染进程的记录放在一起才定位得到。
  try {
    installRendererLogging(win, log);
  } catch (error) {
    log.warn('renderer logging failed', { message: String(error?.message || error).slice(0, 200) });
  }
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    if (params.preload || !/^https?:\/\//i.test(params.src || '')) event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url || '')) {
        try { win.webContents.send('browser:tab:new', { url }); } catch { /* window gone */ }
      }
      return { action: 'deny' };
    });
    guest.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    guest.session.setPermissionCheckHandler(() => false);
    void browser.registerGuest(guest).catch(error => console.error('browser guest unavailable', error?.message || error));
  });
  mainWindow = win;
  win.on('close', event => {
    if (!app.isQuitting && botIpc?.runtime?.shouldKeepAliveOnWindowClose?.()) {
      event.preventDefault();
      win.hide();
      ensureBotTray();
    }
  });
  win.once('closed', () => { mainWindow = null; void browser.close(); });

  win.webContents.on('will-navigate', event => event.preventDefault());
  const senderId = win.webContents.id;
  win.webContents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) {
      cancelModelRuns(senderId);
      permissions.clearSessions(String(senderId));
      approvals.cancelSender(senderId);
    }
  });
  win.webContents.on('render-process-gone', () => { cancelModelRuns(senderId); approvals.cancelSender(senderId); });
  win.webContents.once('destroyed', () => { cancelModelRuns(senderId); approvals.cancelSender(senderId); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const link = typeof url === 'string' && url.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(url) ? URL.parse(url) : null;
    const web = link && ['http:', 'https:'].includes(link.protocol) && !link.username && !link.password;
    const mail = link?.protocol === 'mailto:' && link.pathname;
    if (web || mail) {
      void shell.openExternal(link.href).catch(error => console.error('无法打开链接', error));
    }
    return { action: 'deny' };
  });

  const notifyMaximized = () => {
    win.webContents.send('window:maximized-changed', win.isMaximized());
  };
  win.on('maximize', notifyMaximized);
  win.on('unmaximize', notifyMaximized);
  /**
   * 窗口在**首帧**就显示：第一帧画的是启动动画覆盖层（`#boot-splash`），
   * 所以用户看到的是「最终大小的窗口 + 动画」，全程不换窗口、不闪白。
   * 动画什么时候收掉由渲染层决定（app.js 在 initializeMemory() 结束后移除覆盖层），
   * 主进程这边只保留一个兜底：渲染层要是崩了也必须把窗口显示出来。
   */
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    log.info('window shown', { width: size.width, height: size.height, scale: size.scale, afterMs: Date.now() - startedAt });
  });
  await win.loadURL(ENTRY);
}

app.whenReady().then(() => {
  protocol.handle('mova', serveApp);
  protocol.handle('mova-pdf', servePdf);
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  memoryRuntime = createMemoryRuntime({ app, extractor: createLlmMemoryExtractor() });
  const windowReady = createWindow();
  // Do not block the first paint on Docker/model startup; IPC calls await start().
  void memoryRuntime.start().catch(error => console.error('Memory service unavailable:', error.message));
  return windowReady;
}).catch(error => {
  console.error(error);
  dialog.showErrorBox('无法启动 Mova', '请在项目目录运行 npm run desktop，重新构建并启动应用。');
  app.exit(1);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try { botTray?.destroy?.(); botTray = null; } catch { /* ignore */ }
  try { botIpc?.dispose?.(); } catch (error) { console.warn('bot dispose failed', error?.message || error); }
  edgeBridge?.close();
  mcpManager.stopAll();
  // VPN：内核是子进程，必须先收回（否则留下占着 17900 端口的孤儿），再注销 IPC handler。
  try { void vpnIpc?.dispose?.(); } catch (error) { console.warn('vpn dispose failed', error?.message || error); }
  designRuntime.close();
  void browser.close();
  void memoryRuntime?.stop();
  // 桌面：先让引擎收尾（释放按键、隐藏浮层、结束会话），再注销 IPC handler。
  try { desktop?.dispose?.(); } catch (error) { console.warn('desktop dispose failed', error?.message || error); }
  try { desktopGuard?.stop?.(); } catch { /* ignore */ }
  try { desktopOverlay?.dispose?.(); } catch { /* ignore */ }
  try { desktopInput.releaseAll(); } catch { /* ignore */ }
  try { desktopIpc.dispose(); } catch { /* handler 可能已被移除 */ }
  void desktopAudit.flush?.();
  // 最后一次写盘：异步 + 超时上限，绝不因为日志卡住退出。
  log.info('app-quit', { uptimeMs: Math.round(process.uptime() * 1000) });
  void appLogging?.flush(1200);
});
app.on('window-all-closed', () => {
  if (botIpc?.runtime?.shouldKeepAliveOnWindowClose?.()) return;
  app.quit();
});
