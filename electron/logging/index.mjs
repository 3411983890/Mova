/**
 * 运行日志系统的统一入口：安装、取 logger、渲染进程/崩溃事件采集。
 *
 * 为什么入口长这样：
 * - 主进程是 CommonJS（electron/main.cjs），本模块是 ESM，所以只能靠动态 import 接入，
 *   而接线由主进程负责（见 docs/plans/logging-design.md 里的精确片段）。
 * - electron 一律「懒拿」：本文件顶层不 import 'electron'，测试才能在纯 Node 下加载它。
 * - 所有能力都通过参数注入，installLogging({ app }) 里 app 是必填的：
 *   拿不到 app 就猜日志目录，猜错的代价是用户永远找不到日志——宁可启动时明确报错。
 */
import { createRequire } from 'node:module';
import { join, resolve as resolvePath } from 'node:path';

import { patchIpcMain } from './ipc-trace.mjs';
import { createLogger, createNoopLogger, resolveLevel } from './logger.mjs';
import { redact } from './redact.mjs';
import { createFileSink } from './rotate.mjs';
import { startHangWatchdog } from './watchdog.mjs';

export { createLogger, LEVELS, normalizeLevel, resolveLevel } from './logger.mjs';
export { maskEmail, redact } from './redact.mjs';
export { patchIpcMain, previewArgs } from './ipc-trace.mjs';
export { createFileSink, pruneLogs, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, LATEST_FILE_NAME } from './rotate.mjs';
export { startHangWatchdog } from './watchdog.mjs';

/** 崩溃栈截断长度：够看调用链，又不至于让一条日志几十 KB。 */
const STACK_LIMIT = 4000;
/** 渲染进程 console 单条上限。 */
const CONSOLE_LIMIT = 2000;
/** 渲染进程事件里 URL/源码位置的上限。 */
const SOURCE_LIMIT = 300;
/** 退出前等日志写完的上限。 */
const FLUSH_TIMEOUT_MS = 1500;

/** 当前安装的会话（重复 installLogging 时用来比较目录）。 */
let session = null;
/** 已安装的根 logger；未安装时 getLogger 返回空实现。 */
let rootLogger = null;

const fallbackLogger = createNoopLogger('app');
/** 已经挂过监听的 webContents（同一个窗口重复调用只生效一次）。 */
const hookedWebContents = new WeakSet();
/**
 * app / process 的监听同样按「目标对象」去重（WeakSet 而不是布尔开关）：
 * 布尔开关在测试里会互相污染，而且 uninstall 之后还得能重新装上。
 */
const hookedApps = new WeakSet();
const hookedProcs = new WeakSet();
let appHook = null;
let processHook = null;
/** 属于单次安装的监听（beforeExit 之类）。 */
const processHookDisposers = [];

/**
 * 子模块用的取 logger 入口：
 * 未安装时返回空实现，安装后返回带指定 scope 的真 logger。
 * 这样 `const log = getLogger('subscription')` 可以写在任何模块顶层，不必等安装完成。
 */
export function getLogger(scope) {
  const target = rootLogger ?? fallbackLogger;
  const name = typeof scope === 'string' && scope.trim().length > 0 ? scope.trim() : '';
  return name ? target.withScope(name) : target;
}

/** 日志目录：注入 dir → MOVA_LOG_DIR → app.getPath('userData')/logs。 */
export function resolveLogDir({ app, dir, env = process.env } = {}) {
  const injected = typeof dir === 'string' ? dir.trim() : '';
  if (injected) return resolvePath(injected);
  const fromEnv = typeof env?.MOVA_LOG_DIR === 'string' ? env.MOVA_LOG_DIR.trim() : '';
  if (fromEnv) return resolvePath(fromEnv);
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('无法确定日志目录：没有注入 dir，也没有 app.getPath 可用');
  }
  let userData;
  try {
    userData = app.getPath('userData');
  } catch (error) {
    // 保留 cause：调用方（或 qa 脚本）还能顺着原始异常看到真正的原因（权限、路径被删等）。
    throw new Error(`无法确定日志目录：app.getPath('userData') 失败（${error?.message ?? error}）`, { cause: error });
  }
  if (typeof userData !== 'string' || userData.trim().length === 0) {
    throw new Error("无法确定日志目录：app.getPath('userData') 返回空值");
  }
  return join(userData, 'logs');
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** 崩溃/异常用的错误字段：name + 脱敏 message + code + 截断栈 + 当时 phase。 */
function errorPayload(error, phase = null) {
  const plain = error instanceof Error
    ? { name: error.name || 'Error', message: redact(String(error.message ?? '')) }
    : { name: 'Error', message: redact(String(error ?? '')) };
  if (error && typeof error === 'object' && error.code !== undefined) plain.code = redact(error.code);
  const stack = error && typeof error === 'object' ? String(error.stack ?? '') : '';
  if (stack) plain.stack = String(redact(stack)).slice(0, STACK_LIMIT);
  if (phase) plain.phase = phase;
  return plain;
}

/**
 * 安装日志系统。
 *
 * 顺序是有讲究的：建目录 → 建 logger → 打 app-start（越早越好，后面崩了也有一条锚点）
 * → 起看门狗 → patch ipcMain。app-start 之前发生的错误只能靠 Electron 自己的 stderr。
 *
 * @param {{ app: any, ipcMain?: any, dir?: string, level?: string, hangThresholdMs?: number }} [options]
 * @returns {{ logger: object, dir: string, flush: (ms?: number) => Promise<boolean>, stopWatchdog: () => void, restoreIpc: () => void, latestFile: () => string, uninstall: () => void }}
 */
export function installLogging({ app, ipcMain, dir, level, hangThresholdMs } = {}) {
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('installLogging 需要注入 app（Electron 的 app 对象）：日志目录由 app.getPath("userData") 决定，缺失时不会静默降级。');
  }
  const logDir = resolveLogDir({ app, dir });
  // 幂等：同目录重复安装直接复用，换目录则先拆掉旧的（否则会同时写两个文件）。
  if (session) {
    if (session.dir === logDir) return session;
    session.uninstall();
  }

  const sink = createFileSink({ dir: logDir });
  const logger = createLogger({ scope: 'app', sink, level: level || resolveLevel(process.env) });
  rootLogger = logger;

  logger.info('app-start', {
    version: safeCall(() => app.getVersion(), 'unknown'),
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions?.electron ?? 'unknown',
    node: process.versions?.node ?? 'unknown',
    dir: logDir,
    level: logger.level,
  });

  const watchdog = startHangWatchdog({ logger, thresholdMs: hangThresholdMs });
  const ipc = ipcMain ? patchIpcMain(ipcMain, logger) : { restore() {}, patched: false };

  // app 级崩溃（GPU/utility/插件进程）与 process 级未捕获异常都挂在安装层：
  // 它们和「有没有窗口」无关，越早挂越好。
  installAppHooks(logger, app);
  installProcessLogging(logger);

  // beforeExit 只在事件循环排空时触发一次；异步写盘 + 超时上限，绝不卡住退出。
  const onBeforeExit = () => {
    void flush();
  };
  if (typeof process?.once === 'function') {
    try {
      process.once('beforeExit', onBeforeExit);
      processHookDisposers.push(() => process.removeListener('beforeExit', onBeforeExit));
    } catch {
      /* ignore */
    }
  }

  function flush(timeoutMs = FLUSH_TIMEOUT_MS) {
    return logger.flush(timeoutMs);
  }

  const api = {
    logger,
    dir: logDir,
    sink,
    watchdog,
    flush,
    stopWatchdog() {
      watchdog.stop();
    },
    restoreIpc() {
      ipc.restore();
    },
    /** 当前分段的绝对路径（latest.txt 指向它）。 */
    latestFile() {
      return sink.latestFile();
    },
    latestFileName() {
      return sink.latestFileName();
    },
    /** 测试/自检用：拆掉本次安装挂的所有东西。 */
    uninstall() {
      watchdog.stop();
      ipc.restore();
      disposeAppHooks();
      disposeProcessHooks();
      while (processHookDisposers.length > 0) {
        const dispose = processHookDisposers.pop();
        safeCall(dispose);
      }
      rootLogger = null;
      session = null;
    },
  };

  session = api;
  return api;
}

/**
 * 采集渲染进程与崩溃事件。
 *
 * @param {any} browserWindow BrowserWindow（也接受直接传 webContents）
 * @param {object} [logger] 不传就用 getLogger('renderer')
 */
export function installRendererLogging(browserWindow, logger) {
  const log = logger ?? getLogger('renderer');
  const contents = browserWindow?.webContents ?? browserWindow;
  if (!contents || typeof contents.on !== 'function') {
    return { installed: false, reason: 'no-web-contents' };
  }
  if (hookedWebContents.has(contents)) {
    return { installed: false, reason: 'already-installed', webContents: contents };
  }
  hookedWebContents.add(contents);

  contents.on('console-message', (...args) => {
    try {
      const info = readConsoleMessage(args);
      const name = consoleLevelName(info.level);
      // 只收 warning/error：渲染进程的 info/verbose 是开发期噪音，天天用会淹没真问题。
      if (name !== 'warning' && name !== 'error') return;
      log[name === 'error' ? 'error' : 'warn']('renderer-console', {
        rendererLevel: name,
        message: redact(String(info.message ?? '')).slice(0, CONSOLE_LIMIT),
        line: info.line,
        source: typeof info.source === 'string' ? info.source.slice(0, SOURCE_LIMIT) : null,
      });
    } catch {
      /* 采集失败不能影响渲染进程 */
    }
  });

  contents.on('render-process-gone', (event, details) => {
    const reason = String(details?.reason ?? 'unknown');
    const payload = {
      reason,
      exitCode: details?.exitCode ?? null,
      serviceName: details?.serviceName ?? null,
      phase: safeCall(() => log.getPhase?.(), null),
    };
    // 正常退出（关窗、reload）不是故障，别用 error 级别吓人。
    if (reason === 'clean-exit') log.info('render-process-gone', payload);
    else log.error('render-process-gone', payload);
  });

  contents.on('preload-error', (event, preloadPath, error) => {
    log.error('preload-error', {
      preloadPath: typeof preloadPath === 'string' ? preloadPath : null,
      error: errorPayload(error, safeCall(() => log.getPhase?.(), null)),
    });
  });

  contents.on('unresponsive', () => {
    log.warn('renderer-unresponsive', {
      phase: safeCall(() => log.getPhase?.(), null),
      kind: 'webContents',
    });
  });

  contents.on('responsive', () => {
    log.info('renderer-responsive', { kind: 'webContents' });
  });

  // 窗口装渲染日志时顺手补齐 app/process 两层的监听（幂等，不会重复）。
  installAppHooks(log, safeCall(() => resolveElectronApp(), null));
  installProcessLogging(log);
  return { installed: true, webContents: contents };
}

/**
 * console-message 的签名在 Electron 30+ 改过一次：
 * 老版本是 (event, level, message, line, sourceId)，新版本是一个 details 对象。
 * 两个都认，免得升级 Electron 后日志突然变空。
 */
export function readConsoleMessage(args) {
  const first = args?.[0];
  if (first && typeof first === 'object' && typeof first.message === 'string') {
    return {
      level: first.level,
      message: first.message,
      line: first.lineNumber ?? null,
      source: first.sourceId ?? null,
    };
  }
  return {
    level: args?.[1],
    message: args?.[2] === undefined ? '' : String(args[2]),
    line: args?.[3] ?? null,
    source: args?.[4] ?? null,
  };
}

/** 数字级别（老签名）与字符串级别（新签名）统一成 'error' / 'warning' / 'info' / 'verbose'。 */
export function consoleLevelName(level) {
  if (typeof level === 'number') {
    if (level >= 3) return 'error';
    if (level === 2) return 'warning';
    if (level === 1) return 'info';
    return 'verbose';
  }
  const text = String(level ?? '').toLowerCase();
  if (text === 'error') return 'error';
  if (text === 'warning' || text === 'warn') return 'warning';
  if (text === 'info') return 'info';
  return 'verbose';
}

/** 懒拿 electron 的 app：测试环境里 require('electron') 只会拿到一个字符串路径，必须判类型。 */
function resolveElectronApp() {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('electron');
    if (mod && typeof mod === 'object' && mod.app) return mod.app;
    return null;
  } catch {
    return null;
  }
}

/** app 级：GPU/utility/插件子进程崩溃。同一个 app 只挂一次。 */
export function installAppHooks(logger, app = null) {
  const target = app ?? safeCall(() => resolveElectronApp(), null);
  if (!target || typeof target.on !== 'function') return false;
  if (hookedApps.has(target)) return false;
  const handler = (event, details) => {
    try {
      const reason = String(details?.reason ?? 'unknown');
      const payload = {
        type: details?.type ?? null,
        reason,
        exitCode: details?.exitCode ?? null,
        serviceName: details?.serviceName ?? null,
        name: details?.name ?? null,
      };
      if (reason === 'clean-exit') logger.info('child-process-gone', payload);
      else logger.error('child-process-gone', payload);
    } catch {
      /* 采集失败不影响主进程 */
    }
  };
  try {
    target.on('child-process-gone', handler);
  } catch {
    return false;
  }
  hookedApps.add(target);
  appHook = { target, handler };
  return true;
}

function disposeAppHooks() {
  if (!appHook) return;
  const { target, handler } = appHook;
  try {
    target.removeListener?.('child-process-gone', handler);
  } catch {
    /* ignore */
  }
  hookedApps.delete(target);
  appHook = null;
}

/**
 * process 级：未捕获异常、未处理的 rejection、Node warning。
 *
 * 为什么不监听 'uncaughtException' 而是 'uncaughtExceptionMonitor'：
 * Node 只要看到有 'uncaughtException' 监听器，就会取消默认的崩溃退出——
 * 那等于我们用「装日志」这个动作改变了崩溃行为。monitor 版本只旁听，进程该退出还是退出。
 * 'unhandledRejection' 没有 monitor 版本，这是本设计里唯一一处「加了监听会改变默认行为」的
 * 地方，取舍写在 docs/plans/logging-design.md（结论：只记日志、绝不 process.exit）。
 */
export function installProcessLogging(logger, { proc = process } = {}) {
  if (!proc || typeof proc.on !== 'function') return false;
  if (hookedProcs.has(proc)) return false;

  const phaseOf = () => safeCall(() => logger.getPhase?.(), null);

  const onUncaughtMonitor = (error) => {
    logger.fatal('uncaught-exception', { error: errorPayload(error, phaseOf()) });
  };
  const onRejection = (reason, promise) => {
    logger.error('unhandled-rejection', {
      error: errorPayload(reason, phaseOf()),
      promiseType: promise === undefined ? null : typeof promise,
    });
  };
  const onWarning = (warning) => {
    logger.warn('process-warning', {
      name: warning?.name ?? null,
      message: String(warning?.message ?? ''),
      code: warning?.code ?? null,
      stack: warning?.stack ? String(redact(String(warning.stack))).slice(0, STACK_LIMIT) : undefined,
    });
  };

  const handlers = [
    ['uncaughtExceptionMonitor', onUncaughtMonitor],
    ['unhandledRejection', onRejection],
    ['warning', onWarning],
  ];
  const registered = [];
  for (const [event, handler] of handlers) {
    try {
      // prependListener：崩溃是最后一条日志，越早写越好，别排在别人的监听器后面。
      if (typeof proc.prependListener === 'function') proc.prependListener(event, handler);
      else proc.on(event, handler);
      registered.push([event, handler]);
    } catch {
      /* 单个事件挂不上不影响其它 */
    }
  }
  if (registered.length === 0) return false;
  hookedProcs.add(proc);
  processHook = { target: proc, registered };
  return true;
}

function disposeProcessHooks() {
  if (!processHook) return;
  const { target, registered } = processHook;
  for (const [event, handler] of registered) {
    try {
      target.removeListener?.(event, handler);
    } catch {
      /* ignore */
    }
  }
  hookedProcs.delete(target);
  processHook = null;
}
