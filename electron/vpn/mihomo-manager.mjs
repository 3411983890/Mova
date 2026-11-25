/**
 * Mihomo 内核的可执行文件发现、进程守护与运行态配置落盘。
 *
 * 负责：
 * 1. 探测本机是否**已经有**内核（用户手动指定路径 → `userData/bin/mihomo.exe`）；
 * 2. 把 `buildRuntimeConfig(...)` 的 YAML 写到 `userData/vpn-runtime/running.yaml`，
 *    以 `windowsHide` 方式 spawn 它，并在超时/异常时**完整回收子进程**；
 * 3. 对外给一份可渲染的状态快照（state / pid / listeners / 失败原因）。
 * 不负责：生成配置内容（`runtime-config.mjs`）、下载内核、Controller API 测速、
 * 按模型注入代理（`router.mjs` / `runtime.mjs`）。
 * 被谁调用：`runtime.mjs`（主进程单例）、`tests/vpn-routing.test.mjs`。
 *
 * 关键取舍：
 * - **绝不自动下载内核**：构建与测试环境没有网络，联网下载只会变成静默卡住。
 *   探测不到就返回 `kernel_missing` + 安装指引，让用户自己放文件或用「选择内核」。
 * - 进程回收只用 `taskkill /T /F`（由调用方注入 `killTree`，实现见 `acp/engine.mjs`）：
 *   Windows 上 `child.kill()` 只杀父进程，留下的孤儿会继续占着端口，下次启动直接 EADDRINUSE。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { access as nodeAccess, mkdir as nodeMkdir, stat as nodeStat, writeFile as nodeWriteFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ERROR_TEXT, KERNEL_INSTALL_HINT, VpnError } from './contract.mjs';

/** 托管内核目录名（落在 `app.getPath('userData')/bin/`）。 */
export const MANAGED_BIN_DIR_NAME = 'bin';
/** 生成物文件名。 */
export const RUNNING_CONFIG_FILE = 'running.yaml';

/** 启动就绪等待上限：本机进程绑 loopback 端口通常在 300ms 内，8s 已经足够宽松。 */
const DEFAULT_START_TIMEOUT_MS = 8_000;
/** 优雅退出宽限期：先 `child.kill()`，到点还没退就 `taskkill /T /F`。 */
const DEFAULT_GRACE_MS = 1_500;
/** 强杀后等 exit 事件的上限。 */
const DEFAULT_REAP_TIMEOUT_MS = 4_000;
/** stderr 只留尾部这么多字符：Mihomo 启动失败的关键一行在最后。 */
const STDERR_TAIL_LIMIT = 800;

/** 平台对应的内核文件名。 */
export function kernelBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'mihomo.exe' : 'mihomo';
}

/**
 * 按优先级列出候选路径：用户显式指定的 > 托管目录。
 * 返回值里 `source` 会原样进状态快照，UI 用它说明「内核是从哪来的」。
 */
export function resolveKernelCandidates({ dir, binDir, binaryPath, platform = process.platform } = {}) {
  const name = kernelBinaryName(platform);
  const managedDir = binDir || (dir ? join(dir, '..', MANAGED_BIN_DIR_NAME) : '');
  const out = [];
  const configured = typeof binaryPath === 'string' ? binaryPath.trim() : '';
  if (configured) out.push({ path: configured, source: 'configured' });
  if (managedDir) out.push({ path: join(managedDir, name), source: 'managed' });
  return out;
}

/**
 * 探测本机是否已有内核。
 * @returns {Promise<{ found: boolean, path: string, source: string, candidates: string[], hint: string }>}
 */
export async function discoverKernel({
  dir, binDir, binaryPath, platform = process.platform,
  access = nodeAccess, stat = nodeStat,
} = {}) {
  const candidates = resolveKernelCandidates({ dir, binDir, binaryPath, platform });
  for (const item of candidates) {
    try {
      await access(item.path);
      const info = await stat(item.path).catch(() => null);
      // 目录同名会让人误以为「装好了」，这里要求必须是文件。
      if (info && typeof info.isFile === 'function' && !info.isFile()) continue;
      return { found: true, path: item.path, source: item.source, candidates: candidates.map(c => c.path), hint: '' };
    } catch {
      // 继续下一个候选
    }
  }
  return {
    found: false,
    path: '',
    source: '',
    candidates: candidates.map(c => c.path),
    hint: KERNEL_INSTALL_HINT,
  };
}

/** 默认就绪探测：能连上 Controller 端口就算起来了（Mihomo 先绑端口再读配置）。 */
function defaultWaitReady({ controllerPort, timeoutMs, isAlive, now = Date.now }) {
  return new Promise(resolve => {
    const deadline = now() + timeoutMs;
    const attempt = () => {
      if (!isAlive()) return resolve({ ready: false, reason: 'exited' });
      if (now() > deadline) return resolve({ ready: false, reason: 'timeout' });
      const socket = connect({ host: '127.0.0.1', port: controllerPort });
      let settled = false;
      const done = ready => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ready) return resolve({ ready: true, reason: '' });
        setTimeout(attempt, 120);
      };
      socket.setTimeout(400, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      return undefined;
    };
    attempt();
  });
}

/**
 * 创建内核守护实例。
 *
 * @param {object} options
 * @param {string} options.dir 运行态目录（`userData/vpn-runtime`）
 * @param {string} [options.binDir] 托管内核目录（`userData/bin`）
 * @param {string} [options.binaryPath] 用户手动指定的内核路径（也可以传 `() => string` 取值）
 * @param {Function} [options.spawn] 默认 `child_process.spawn`
 * @param {Function|null} [options.killTree] `(pid) => { ok, detail }`，默认不强杀
 * @param {Function} [options.waitReady] 就绪探测（测试注入立即成功）
 * @param {object} [options.logger] `getLogger('vpn')`
 */
export function createMihomoManager({
  dir,
  binDir = '',
  binaryPath = '',
  platform = process.platform,
  spawn = nodeSpawn,
  killTree = null,
  waitReady = defaultWaitReady,
  mkdir = nodeMkdir,
  writeFile = nodeWriteFile,
  access = nodeAccess,
  stat = nodeStat,
  now = Date.now,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  graceMs = DEFAULT_GRACE_MS,
  reapTimeoutMs = DEFAULT_REAP_TIMEOUT_MS,
  logger = null,
} = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new VpnError('internal', { message: '内核运行目录未配置' });
  const runtimeDir = dir.trim();
  const configPath = join(runtimeDir, RUNNING_CONFIG_FILE);
  /** 用户手选路径可以是函数：路由表改完不必重建 manager。 */
  const readConfiguredPath = typeof binaryPath === 'function'
    ? () => binaryPath() ?? ''
    : () => binaryPath;

  let child = null;
  let exited = false;
  let stderrTail = '';
  let lastConfig = null;
  let kernelInfo = { found: false, path: '', source: '', candidates: [], hint: KERNEL_INSTALL_HINT };
  const status = {
    state: 'idle',
    pid: 0,
    startedAt: 0,
    stoppedAt: 0,
    lastError: '',
    lastErrorCode: '',
  };

  const wait = ms => new Promise(resolve => { setTimeout(resolve, Math.max(0, ms)); });

  function isAlive() {
    if (!child || exited) return false;
    if (child.exitCode !== undefined && child.exitCode !== null) return false;
    if (child.signalCode !== undefined && child.signalCode !== null) return false;
    return true;
  }

  function snapshot() {
    return {
      state: status.state,
      pid: status.pid,
      startedAt: status.startedAt,
      stoppedAt: status.stoppedAt,
      configPath,
      controllerPort: lastConfig?.core?.controllerPort ?? 0,
      listeners: (lastConfig?.listeners ?? []).map(item => ({ ...item })),
      lastError: status.lastError,
      lastErrorCode: status.lastErrorCode,
      kernel: { ...kernelInfo },
      installHint: kernelInfo.found ? '' : KERNEL_INSTALL_HINT,
    };
  }

  /** 把子进程彻底收掉：先 kill，宽限期后 taskkill 整棵树，最后等 exit 事件。 */
  async function reap(reason = '') {
    const current = child;
    if (!current) return { ok: true, detail: 'no-process' };
    const pid = Number(current.pid) || 0;
    const alreadyExited = exited
      || (current.exitCode !== undefined && current.exitCode !== null)
      || (current.signalCode !== undefined && current.signalCode !== null);
    exited = false;
    child = null;
    status.pid = 0;
    status.stoppedAt = now();
    if (alreadyExited) {
      try { current.stderr?.destroy?.(); } catch { /* ignore */ }
      logger?.info?.('core-reaped', { pid, detail: 'already-exited', reason: String(reason).slice(0, 80) });
      return { ok: true, detail: 'already-exited', pid };
    }
    let exitWaiter = null;
    const waitExit = new Promise(resolve => { exitWaiter = resolve; });
    current.once?.('exit', () => { exited = true; exitWaiter?.(true); });
    try { current.kill?.('SIGTERM'); } catch { /* 已经退了 */ }
    const graceful = await Promise.race([waitExit, wait(graceMs).then(() => false)]);
    let detail = 'graceful';
    if (!graceful && pid && typeof killTree === 'function') {
      const killed = killTree(pid);
      detail = killed?.ok ? 'taskkill' : `taskkill-failed:${killed?.detail ?? 'unknown'}`;
      await Promise.race([waitExit, wait(reapTimeoutMs).then(() => false)]);
    } else if (!graceful) {
      detail = 'no-killTree';
    }
    try { current.stdin?.destroy?.(); } catch { /* ignore */ }
    try { current.stderr?.destroy?.(); } catch { /* ignore */ }
    logger?.info?.('core-reaped', { pid, detail, reason: String(reason).slice(0, 80) });
    return { ok: true, detail, pid };
  }

  /**
   * 启动内核。
   * @param {{ config: object }} input `config` 来自 `buildRuntimeConfig(...)`
   * @returns {Promise<{ ok: boolean, state?: string, error?: string, message?: string, installHint?: string, detail?: string }>}
   */
  async function start({ config } = {}) {
    if (!config || typeof config.yaml !== 'string' || !config.yaml.trim()) {
      throw new VpnError('request', { message: '缺少运行态配置，无法启动内核' });
    }
    if (isAlive()) return { ok: true, state: 'running', pid: Number(child.pid) || 0, reused: true };

    kernelInfo = await discoverKernel({ dir: runtimeDir, binDir, binaryPath: readConfiguredPath(), platform, access, stat });
    lastConfig = config;
    if (!kernelInfo.found) {
      status.state = 'kernel_missing';
      status.lastErrorCode = 'kernel_missing';
      status.lastError = ERROR_TEXT.kernel_missing;
      logger?.warn?.('core-missing', { candidates: kernelInfo.candidates.length });
      // 关键：这里 **不 spawn**，也不创建任何子进程。
      return {
        ok: false,
        state: 'kernel_missing',
        error: 'kernel_missing',
        message: ERROR_TEXT.kernel_missing,
        installHint: KERNEL_INSTALL_HINT,
      };
    }

    await mkdir(runtimeDir, { recursive: true });
    await writeFile(configPath, config.yaml, { mode: 0o600 });

    status.state = 'starting';
    status.lastError = '';
    status.lastErrorCode = '';
    stderrTail = '';
    const args = ['-f', configPath, '-d', runtimeDir];
    let spawned;
    try {
      spawned = spawn(kernelInfo.path, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        cwd: runtimeDir,
      });
    } catch (error) {
      return startFailed(error?.message || 'spawn failed');
    }

    child = spawned;
    exited = false;
    status.pid = Number(spawned.pid) || 0;
    spawned.stderr?.on?.('data', chunk => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_LIMIT);
    });
    spawned.once?.('error', error => {
      stderrTail = `${stderrTail}${String(error?.message || error)}`.slice(-STDERR_TAIL_LIMIT);
      exited = true;
      if (status.state === 'starting') {
        status.state = 'start_failed';
        status.lastErrorCode = 'core_start_failed';
        status.lastError = String(error?.message || ERROR_TEXT.core_start_failed).slice(0, 240);
      }
    });
    spawned.once?.('exit', (code, signal) => {
      exited = true;
      status.pid = 0;
      status.stoppedAt = now();
      if (status.state === 'starting') {
        status.state = 'start_failed';
        status.lastErrorCode = 'core_start_failed';
        status.lastError = (`内核进程在就绪前退出（code=${code ?? ''} signal=${signal ?? ''}）`).slice(0, 240);
      } else if (status.state === 'running') {
        status.state = 'stopped';
      }
      logger?.info?.('core-exited', { code: code ?? null, signal: signal ?? null });
    });

    const readiness = await waitReady({
      controllerPort: Number(config?.core?.controllerPort) || 0,
      timeoutMs: startTimeoutMs,
      isAlive,
      now,
    });
    if (!readiness?.ready) {
      const detail = stderrTail || readiness?.reason || 'not-ready';
      await reap('start-failed');
      return startFailed(detail);
    }

    status.state = 'running';
    status.startedAt = now();
    logger?.info?.('core-started', {
      pid: status.pid,
      listeners: (config.listeners ?? []).length,
      source: kernelInfo.source,
    });
    return { ok: true, state: 'running', pid: status.pid, listeners: (config.listeners ?? []).length };
  }

  function startFailed(detail) {
    status.state = 'start_failed';
    status.lastErrorCode = 'core_start_failed';
    status.lastError = String(detail || ERROR_TEXT.core_start_failed).slice(0, 240);
    status.pid = 0;
    logger?.error?.('core-start-failed', { detail: status.lastError });
    return { ok: false, error: 'core_start_failed', message: ERROR_TEXT.core_start_failed, detail: status.lastError };
  }

  /** 停止内核（幂等，绝不抛）。 */
  async function stop() {
    if (!child) {
      if (status.state === 'running' || status.state === 'starting') status.state = 'stopped';
      return { ok: true, state: status.state, stopped: true };
    }
    status.state = 'stopping';
    await reap('stop');
    status.state = 'stopped';
    return { ok: true, state: 'stopped', stopped: true };
  }

  /** 重启：配置变更后用它把 listeners 换成新的端口。 */
  async function restart({ config } = {}) {
    await stop();
    return start({ config });
  }

  /** 只重写 running.yaml；在跑就顺带重启，没跑就只落盘等下次启动。 */
  async function sync({ config } = {}) {
    if (!config || typeof config.yaml !== 'string') throw new VpnError('request', { message: '缺少运行态配置' });
    lastConfig = config;
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(configPath, config.yaml, { mode: 0o600 });
    if (!isAlive()) return { ok: true, state: status.state, reloaded: false };
    const result = await restart({ config });
    return { ...result, reloaded: true };
  }

  async function dispose() {
    await stop();
    status.state = 'stopped';
  }

  return {
    start,
    stop,
    restart,
    sync,
    dispose,
    status: snapshot,
    isRunning: isAlive,
    get configPath() { return configPath; },
    /** 读取一次内核信息（不启动），供状态接口在未启动时也能回答「有没有内核」。 */
    async probeKernel() {
      kernelInfo = await discoverKernel({ dir: runtimeDir, binDir, binaryPath: readConfiguredPath(), platform, access, stat });
      if (!kernelInfo.found && status.state === 'idle') status.state = 'kernel_missing';
      return { ...kernelInfo };
    },
  };
}
