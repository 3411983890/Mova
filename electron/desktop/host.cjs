'use strict';
// PowerShell UIA worker 的客户端：一行一个 JSON 请求/响应。
// 只做四件事：拉起子进程、按行切分 stdout、给每个请求配 id 和超时、超时/退出后重启一次。
// 协议见 design/desktop-build-plan.md §2.1。

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { join } = require('node:path');

const DEFAULT_TIMEOUT_MS = 15000;
const START_TIMEOUT_MS = 25000; // 首帧要编译 Add-Type，比普通命令慢
const DISPOSE_GRACE_MS = 200;
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const RESTART_DELAY_MS = 120;

function coded(code, message, detail) {
  const error = new Error(message || code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function defaultScriptPath() {
  return join(__dirname, 'host', 'uia-worker.ps1');
}

function normalizeArgs(args) {
  if (args === undefined || args === null) return undefined;
  return args;
}

/**
 * @param {object} options
 * @param {string} [options.scriptPath] uia-worker.ps1 路径
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs] 单请求超时，默认 15s
 * @param {object} [options.logger] {info,warn,error}
 * @param {object} [options.env] 追加的环境变量
 * @param {string} [options.powershellPath] 默认 powershell.exe
 */
function createHost(options = {}) {
  const scriptPath = options.scriptPath || defaultScriptPath();
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.round(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const powershellPath = options.powershellPath || 'powershell.exe';
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const env = { ...process.env, ...(options.env || {}), PYTHONIOENCODING: 'utf-8' };

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  let child = null;
  let buffer = '';
  let seq = 0;
  let disposed = false;
  let restarting = false;
  let restartCount = 0;
  let startPromise = null;
  let info = { pid: 0, version: '', uia: false, dpiMode: '' };
  const pending = new Map();

  function spawnWorker() {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ];
    const proc = spawn(powershellPath, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    buffer = '';

    proc.stdout.on('data', (chunk) => onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) logger.warn(`[desktop-worker] ${text}`);
    });
    proc.stdin.on('error', (error) => {
      // 子进程已退出时写 stdin 会 EPIPE，这里只记录，交给 exit 处理
      if (error && error.code !== 'EPIPE') logger.warn(`[desktop-worker] stdin ${error.code || error.message}`);
    });
    proc.on('error', (error) => {
      logger.error(`[desktop-worker] spawn failed: ${error.code || error.message}`);
      failAll('worker-exit', '无法启动 PowerShell worker');
    });
    proc.on('exit', (code, signal) => onExit(code, signal));
    return proc;
  }

  // stdout 是字节流：setEncoding('utf8') 已经用 StringDecoder 处理跨 chunk 的多字节字符，
  // 这里只负责按行切分，并保留最后一段不完整的半行。
  function onStdout(chunk) {
    buffer += chunk;
    if (buffer.length > MAX_LINE_CHARS) {
      logger.error('[desktop-worker] stdout line too long, resetting buffer');
      buffer = '';
      return;
    }
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) handleLine(line);
      index = buffer.indexOf('\n');
    }
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      logger.warn(`[desktop-worker] 无法解析的 stdout 行: ${line.slice(0, 200)}`);
      return;
    }
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    if (!hasId) {
      // 无 id 的行是事件（hotkey / log / notify）
      emitter.emit('event', message);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) {
      emitter.emit('event', { ...message, orphan: true });
      return;
    }
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok === false) {
      waiter.reject(coded(message.code || 'worker-failed', message.message || 'worker failed'));
      return;
    }
    waiter.resolve(message.result === undefined ? null : message.result);
  }

  function onExit(code, signal) {
    const wasCurrent = child !== null;
    child = null;
    if (wasCurrent) {
      failAll('worker-exit', `worker 退出 (code=${code} signal=${signal || '-'})`);
      emitter.emit('exit', { code, signal, restartCount });
      info = { ...info, pid: 0 };
    }
    if (!disposed) scheduleRestart('worker-exit');
  }

  function failAll(code, message) {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(coded(code, message));
    }
  }

  function write(payload) {
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw coded('worker-exit', 'worker 未运行');
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
  }

  async function call(cmd, args, callOptions = {}) {
    if (disposed) throw coded('disposed', 'host 已释放');
    if (!child) throw coded('worker-exit', 'worker 未运行');
    const id = ++seq;
    const request = { id, cmd };
    const normalized = normalizeArgs(args);
    if (normalized !== undefined) request.args = normalized;
    const limit = Number.isFinite(callOptions.timeoutMs) && callOptions.timeoutMs > 0
      ? Math.round(callOptions.timeoutMs)
      : timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(coded('worker-timeout', `worker 命令 ${cmd} 超时 (${limit}ms)`));
        // 超时的请求无法取消，只能让进程重启，避免后续请求排在卡死的调用后面
        killWorker('timeout');
        scheduleRestart('worker-timeout');
      }, limit);
      pending.set(id, { resolve, reject, timer, cmd, startedAt: Date.now() });
      try {
        write(request);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function killWorker(reason) {
    const proc = child;
    child = null;
    if (!proc) return;
    try {
      proc.stdout.removeAllListeners('data');
      proc.stdin.end();
    } catch {}
    // 进程被杀后仍在排队的请求立刻失败，别让它们等到各自超时
    failAll('worker-exit', `worker 已终止 (${reason})`);
    try {
      proc.kill();
    } catch (error) {
      logger.warn(`[desktop-worker] kill failed: ${error.code || error.message}`);
    }
    logger.warn(`[desktop-worker] killed (${reason})`);
  }

  function scheduleRestart(reason) {
    if (disposed || restarting) return;
    restarting = true;
    restartCount += 1;
    logger.warn(`[desktop-worker] restarting after ${reason} (#${restartCount})`);
    const timer = setTimeout(() => {
      restarting = false;
      if (disposed) return;
      try {
        child = spawnWorker();
        emitter.emit('restart', { reason, restartCount });
        // 重启后用 ping 确认可用；失败不抛给调用方，下一次 call 会报 worker-exit
        call('ping', undefined, { timeoutMs: START_TIMEOUT_MS }).then((pong) => {
          info = { ...info, ...summary(pong) };
        }).catch((error) => {
          logger.error(`[desktop-worker] restart handshake failed: ${error.code || error.message}`);
        });
      } catch (error) {
        logger.error(`[desktop-worker] respawn failed: ${error.code || error.message}`);
      }
    }, RESTART_DELAY_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function summary(pong) {
    return {
      pid: pong && Number(pong.pid) ? Number(pong.pid) : 0,
      version: pong && pong.version ? String(pong.version) : '',
      uia: Boolean(pong && pong.uia),
      dpiMode: pong && pong.dpiMode ? String(pong.dpiMode) : '',
    };
  }

  async function start() {
    if (disposed) throw coded('disposed', 'host 已释放');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (!child) child = spawnWorker();
      const pong = await call('ping', undefined, { timeoutMs: START_TIMEOUT_MS });
      info = summary(pong);
      restartCount = 0;
      if (!info.uia) logger.warn('[desktop-worker] UIA 不可用，桌面操作将退化为不可用');
      return pong;
    })();
    startPromise.catch(() => { startPromise = null; });
    return startPromise;
  }

  function isAlive() {
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  function status() {
    return {
      started: startPromise !== null,
      alive: isAlive(),
      disposed,
      pid: info.pid,
      version: info.version,
      uia: info.uia,
      dpiMode: info.dpiMode,
      restartCount,
      pending: pending.size,
    };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    const proc = child;
    if (proc) {
      try {
        write({ id: ++seq, cmd: 'quit' });
      } catch {}
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, DISPOSE_GRACE_MS);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        if (proc.exitCode === null) proc.kill();
      } catch {}
    }
    child = null;
    failAll('disposed', 'host 已释放');
    startPromise = null;
  }

  return {
    start,
    call,
    dispose,
    status,
    isAlive,
    on(event, listener) {
      emitter.on(event, listener);
      return () => emitter.off(event, listener);
    },
    off(event, listener) {
      emitter.off(event, listener);
    },
    get pid() {
      return info.pid;
    },
    get uia() {
      return info.uia;
    },
    scriptPath,
    timeoutMs,
  };
}

module.exports = { createHost, coded, DEFAULT_TIMEOUT_MS, MAX_LINE_CHARS };
