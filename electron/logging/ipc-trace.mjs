/**
 * IPC 计时：把 ipcMain.handle / handleOnce 包一层，记录每次调用耗时与失败。
 *
 * 为什么值得单独做：桌面端「卡住」最常见的形态是「点了按钮没反应，其实主进程里某个
 * IPC 正在跑一次几十秒的网络/文件操作」。有了这条时间线，用户报「设置页打不开」时
 * 能直接看到是 `settings:load` 卡了 32 秒，还是渲染进程根本没发请求。
 *
 * 三条自我约束：
 * - 不改变 IPC 语义：返回值原样透传，异常原样重抛（同一个 error 实例），
 *   handleOnce 的一次性语义也交给 Electron 自己维护。
 * - 不记 payload 原文：只记脱敏后截断的 argsPreview。聊天内容、令牌都可能在里面。
 * - 序列化绝不抛：参数里可能有函数、循环引用、甚至抛错的 getter，
 *   它们只该换来一个 `[unserializable]`，不该让 IPC 本身失败。
 */
import { redact } from './redact.mjs';

/** 慢调用阈值：超过 1 秒的 IPC，体感上已经能明确感觉到「点了没反应」。 */
const DEFAULT_SLOW_MS = 1000;
const DEFAULT_PREVIEW_LIMIT = 200;

/** 幂等标记：挂在 ipcMain 上，即使模块被加载两次也只会包一层。 */
const PATCH_STATE = Symbol.for('mova.logging.ipcTrace');

/** 截断到 limit 个字符（含省略号），用于 argsPreview / 日志里的长文本。 */
export function truncateText(text, limit = DEFAULT_PREVIEW_LIMIT) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_PREVIEW_LIMIT;
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * JSON 序列化兜底：循环引用 → `[circular]`，BigInt → 字符串，
 * 任何抛错（含 toJSON 抛错）→ `[unserializable]`。
 */
export function safeStringify(value) {
  const seen = new WeakSet();
  try {
    const text = JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    });
    return typeof text === 'string' ? text : '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

/**
 * 参数预览：先脱敏再序列化再截断。
 * 顺序不能反——先截断会把 token 从中间切断，就不再匹配任何密钥规则了。
 */
export function previewArgs(args, limit = DEFAULT_PREVIEW_LIMIT) {
  const list = Array.isArray(args) ? args : args === undefined ? [] : [args];
  if (list.length === 0) return '[]';
  let text;
  try {
    text = safeStringify(redact(list));
  } catch {
    text = '[unserializable]';
  }
  return truncateText(text, limit);
}

/** 报错归一化：只留排查要用的 name / code / 脱敏后的 message。 */
export function normalizeIpcError(error) {
  if (error instanceof Error) {
    const plain = { name: error.name || 'Error', message: redact(String(error.message ?? '')) };
    if (error.code !== undefined) plain.code = redact(error.code);
    return plain;
  }
  return { name: 'Error', message: redact(String(error ?? '')) };
}

function roundMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10) / 10;
}

/**
 * 包装 ipcMain。
 *
 * @param {object} ipcMain Electron 的 ipcMain（测试里可以传假对象）
 * @param {object} logger createLogger 的产物
 * @param {{ slowMs?: number, now?: () => number, previewLimit?: number }} [options]
 * @returns {{ restore: () => void, patched: boolean }}
 */
export function patchIpcMain(ipcMain, logger, options = {}) {
  const { slowMs = DEFAULT_SLOW_MS, now = () => Date.now(), previewLimit = DEFAULT_PREVIEW_LIMIT } = options;

  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    return { restore() {}, patched: false };
  }
  // 幂等：重复调用直接返回同一个控制器，避免「日志里每次 IPC 出现两条」。
  const existing = ipcMain[PATCH_STATE];
  if (existing) return existing;

  // 原函数和「绑定版」分开存：restore 要还回原函数本身（身份相等），调用时再 bind。
  const originalHandle = ipcMain.handle;
  const callHandle = originalHandle.bind(ipcMain);
  const originalHandleOnce = typeof ipcMain.handleOnce === 'function' ? ipcMain.handleOnce : null;
  const callHandleOnce = originalHandleOnce ? originalHandleOnce.bind(ipcMain) : null;

  function safeLog(level, msg, data) {
    try {
      logger?.[level]?.(msg, data);
    } catch {
      /* 日志失败不影响 IPC */
    }
  }

  function wrap(channel, handler) {
    if (typeof handler !== 'function') return handler;
    return async function timedHandler(event, ...args) {
      const started = now();
      try {
        const result = await handler.call(this, event, ...args);
        const durationMs = roundMs(now() - started);
        if (durationMs > slowMs) {
          safeLog('warn', 'slow-ipc', { channel, durationMs, ok: true });
        } else {
          safeLog('debug', 'ipc', { channel, durationMs, ok: true });
        }
        return result;
      } catch (error) {
        const durationMs = roundMs(now() - started);
        safeLog('error', 'ipc-error', {
          channel,
          durationMs,
          ok: false,
          error: normalizeIpcError(error),
          argsPreview: previewArgs(args, previewLimit),
        });
        // 必须原样抛：调用方（渲染进程）靠 error.message/code 决定提示什么。
        throw error;
      }
    };
  }

  const patchedHandle = function patchedHandle(channel, handler) {
    return callHandle(channel, wrap(channel, handler));
  };

  const patchedHandleOnce = callHandleOnce
    ? function patchedHandleOnce(channel, handler) {
      return callHandleOnce(channel, wrap(channel, handler));
    }
    : ipcMain.handleOnce;

  ipcMain.handle = patchedHandle;
  if (originalHandleOnce) ipcMain.handleOnce = patchedHandleOnce;

  function restore() {
    // 只还原「还是我们自己包的那一版」的方法，别把别人后续的替换覆盖掉。
    if (ipcMain.handle === patchedHandle) ipcMain.handle = originalHandle;
    if (originalHandleOnce && ipcMain.handleOnce === patchedHandleOnce) ipcMain.handleOnce = originalHandleOnce;
    delete ipcMain[PATCH_STATE];
  }

  const controller = { restore, patched: true, slowMs };
  Object.defineProperty(ipcMain, PATCH_STATE, {
    value: controller,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return controller;
}
