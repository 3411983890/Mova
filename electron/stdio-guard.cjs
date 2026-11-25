'use strict';
/**
 * 负责：把「写 stdout / stderr 失败」从致命错误降级成被处理的事件（给流挂 `'error'` 监听器）。
 * 不负责：日志格式、分级与落盘（那是 electron/logging/），也不处理非管道类错误。
 * 被谁调用：electron/main.cjs 的第一条语句。
 *
 * 为什么需要它
 * ------------
 * 从终端或父进程启动时，Electron 的 stdout / stderr 是**管道**。父进程退出、终端关掉，
 * 或者从任务栏启动根本没有控制台时，管道读端就没了；此后任何一次 console.log /
 * console.error 都会拿到 `EPIPE: broken pipe, write`。
 *
 * 关键点：这个错误**不是**同步抛出的。`Writable.write()` 先把数据排进缓冲，真正的
 * `Socket._write` 失败后由内部 `errorOrDestroy()` 触发流的 `'error'` 事件。没人监听
 * `'error'`，Node 就把它升级成 uncaughtException —— Electron 随即弹出
 * 「A JavaScript error occurred in the main process」，而这个弹窗和用户正在做的事毫无关系，
 * 点掉之前界面完全不可用。
 *
 * 所以 `try { console.error(...) } catch {}` 挡不住它（electron/memory-runtime.cjs 里就是
 * 这么写的，注释写着「stdout is gone」，实际只覆盖了同步抛错那部分路径）。唯一可靠的挡法
 * 是挂 `'error'` 监听器：一旦有监听器，EPIPE 就只是被消费掉的普通事件。
 *
 * 边界
 * ----
 * 只吞「管道写不出去」这一类错误（EPIPE / ERR_STREAM_DESTROYED / ERR_STREAM_WRITE_AFTER_END）。
 * 其它写失败（例如磁盘满的 ENOSPC）不会被静默掉：交给 `onDrop` 记一次文件日志——
 * 那是真实故障，不该假装没发生。
 */

/** 管道断掉类错误：写不出去，但应用本身完全健康。 */
const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

/** 这段文字出现在 message 里（Electron 有时不给 `code`）也认作管道断掉。 */
const BROKEN_PIPE_MESSAGE = /EPIPE|broken pipe|stream was destroyed|write after end/i;

function isBrokenPipe(error) {
  if (!error) return false;
  if (BROKEN_PIPE_CODES.has(error.code)) return true;
  return BROKEN_PIPE_MESSAGE.test(typeof error.message === 'string' ? error.message : '');
}

/**
 * 给 stdout / stderr 挂容错监听器。幂等：同一进程里重复调用不会叠加。
 *
 * @param {{process?: NodeJS.Process, onDrop?: (error: Error, stream: string) => void}} [options]
 *   `onDrop` 在第一次写失败时被调用一次，用于把「日志写不出去」记进文件日志
 *   （文件日志走 fs，不依赖管道）。不传就纯静默。
 * @returns {{installed: string[], skipped: string[]}}
 */
function installStdioGuards(options = {}) {
  const proc = options.process || process;
  const onDrop = typeof options.onDrop === 'function' ? options.onDrop : null;
  const installed = [];
  const skipped = [];
  let reported = false;
  const report = (error, stream) => {
    if (reported || !onDrop) return;
    reported = true;
    try { onDrop(error, stream); } catch { /* 回调自己不许炸 */ }
  };
  for (const name of ['stdout', 'stderr']) {
    const stream = proc[name];
    if (!stream || typeof stream.on !== 'function') {
      skipped.push(name);
      continue;
    }
    // 主进程和测试可能各 require 一次，用不可枚举标记去重。
    if (stream.__movaPipeGuard) {
      skipped.push(name);
      continue;
    }
    Object.defineProperty(stream, '__movaPipeGuard', { value: true, enumerable: false, configurable: true });
    stream.on('error', error => report(error, name));
    installed.push(name);
  }
  return { installed, skipped };
}

module.exports = { installStdioGuards, isBrokenPipe, BROKEN_PIPE_CODES };
