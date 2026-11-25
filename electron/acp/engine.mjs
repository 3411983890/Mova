/**
 * ACP 会话引擎：把「一轮 Gemini 对话」编排起来。
 *
 * 负责：找 CLI、起进程、initialize、session/new、把 session/update 翻译成 Mova 事件、
 *      把反向请求转给闸门或提问通道、收尾上报 usage、**本进程内 agy 的登记与进程树收尾**。
 * 不负责：协议分帧（client.mjs）、事件形状（translate.mjs）、权限与落盘（gate.mjs）。
 * 被谁调用：electron/chat-agent.mjs 的 engine==='acp' 分支。
 *
 * 关键决策：
 * - 会话可复用：一轮结束不关进程，只有异常退出或 dispose 才重建；中断只发 cancel。
 * - 并发直接拒绝：ACP 的 prompt 是串行语义，两个 runTurn 同时发会让上游会话状态错乱。
 * - 失败收敛成 `{ok:false, code}` 而不是抛：调用方是流式 emit 环境，抛出会打断整轮回复。
 * - Windows 上 `child.kill()` 只杀父进程：残留的 agy 子进程会让**下一次** `session/new`
 *   返回空模型列表且不报错（见 docs/architecture.md「已知坑」），所以要按 pid 登记并在
 *   宽限期后 `taskkill /T /F` 收整棵树。
 */
import { spawnSync } from 'node:child_process';

import { getLogger } from '../logging/index.mjs';
import { SubscriptionError } from '../subscription/contract.mjs';
import { createAcpClient } from './client.mjs';
import {
  createNotice,
  createTranslateState,
  translatePermissionRequest,
  translateSessionUpdate,
  translateUsage,
} from './translate.mjs';

/** ACP 协议版本：目前客户端与 agent 都用 1。 */
const PROTOCOL_VERSION = 1;
const CLIENT_NAME = 'Mova';

/** 优雅收尾 → 强杀之间的宽限期：给 stdin.end() + kill() 一点时间，通常几十毫秒就退。 */
const DEFAULT_GRACE_MS = 1_500;

const log = getLogger('acp');

/**
 * 本进程内「由本应用启动的 agy 进程」登记表：pid → { pid, child, exited, waiters }。
 * 只登记自己 spawn 的进程，绝不去猜/杀别人的进程。
 */
const activeProcesses = new Map();
/** exit 兜底钩子只挂一次（main.cjs 已有 before-quit，但没有 agy 相关清理）。 */
let exitHookInstalled = false;

/**
 * 默认强杀实现：Windows 上用 `taskkill /PID <pid> /T /F`。
 * `/T` 是关键——agy.exe 会派生工具子进程，只杀父进程会留下孤儿继续占着 CLI 状态。
 * 非 Windows 直接跳过：上游已经 `child.kill()`，这里不发明额外信号。
 *
 * @param {number} pid
 * @param {{ platform?: string, run?: Function }} [options] `run` 仅测试注入（默认 spawnSync）
 * @returns {{ ok: boolean, detail?: string }}
 */
export function killProcessTree(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return { ok: false, detail: 'not-win32' };
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, detail: 'invalid-pid' };
  try {
    const result = run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (result?.error) return { ok: false, detail: String(result.error.message ?? result.error).slice(0, 160) };
    const detail = String(result?.stderr || result?.stdout || '').trim().slice(0, 160);
    return { ok: (result?.status ?? 1) === 0, ...(detail ? { detail } : {}) };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * 默认存活判断：真实 ChildProcess 的退出码 + `process.kill(pid, 0)` 双重证据。
 * 关键取舍：**拿不到真实证据就不强杀**。测试用的假进程对象没有 exitCode/signalCode，
 * 直接 `process.kill(pid, 0)` 有可能命中同号的无关进程，绝不能对那种 pid 执行 taskkill。
 *
 * @param {{ pid: number, child?: any, exited?: boolean }} record
 * @returns {boolean}
 */
function defaultIsAlive(record) {
  if (!record || record.exited) return false;
  const child = record.child;
  if (!child || (child.exitCode === undefined && child.signalCode === undefined)) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但没权限发信号；ESRCH = 已经不在了。
    return error?.code === 'EPERM';
  }
}

/** 主进程退出兜底：同步强杀仍登记在案的 PID（`exit` 里只能做同步事）。 */
function reapActiveSync() {
  for (const record of [...activeProcesses.values()]) {
    try {
      if (!defaultIsAlive(record)) continue;
      const result = killProcessTree(record.pid);
      if (result.ok) log.info('exit-reap', { pid: record.pid });
      else log.warn('exit-reap-failed', { pid: record.pid, detail: result.detail ?? null });
    } catch { /* 退出路径里绝不能再抛 */ }
    activeProcesses.delete(record.pid);
  }
}

/** 只在真的登记过进程时才挂 exit 钩子：import 本模块不等于要改 process 的退出行为。 */
function ensureExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  try {
    process.once('exit', reapActiveSync);
  } catch {
    exitHookInstalled = false;
  }
}

/**
 * 登记一个刚 spawn 出来的 agy 进程（退出由 client 的 onProcessExit 回调标记）。
 * @param {{ pid?: number }} child
 * @returns {{ pid: number, child: any, exited: boolean, waiters: Set<Function> } | null}
 */
function trackProcess(child) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const record = { pid, child, exited: false, waiters: new Set() };
  activeProcesses.set(pid, record);
  ensureExitHook();
  return record;
}

/** 退出回来时标记；exit/close/error 可能各来一次，必须幂等。 */
function markProcessExited(pid) {
  const record = activeProcesses.get(pid);
  if (!record) return;
  record.exited = true;
  for (const resolve of record.waiters) resolve();
  record.waiters.clear();
  activeProcesses.delete(pid);
  log.debug('process-exit', { pid });
}

/** 诊断用只读快照：本进程内仍登记为活跃的 agy PID。 */
export function listActivePids() {
  return [...activeProcesses.keys()];
}

function asError(error) {
  if (error instanceof SubscriptionError) return error;
  return new SubscriptionError('acp_protocol', { detail: error?.message ? String(error.message).slice(0, 200) : 'unknown', cause: error });
}

/**
 * @param {object} options
 * @param {Function} options.spawn 注入的 spawn
 * @param {object} [options.gate] 反向请求闸门
 * @param {() => number} [options.now] 时钟
 * @param {number} [options.timeoutMs] 固定超时（initialize / session/new / cancel）
 * @param {number} [options.promptIdleMs] `session/prompt` 空闲阈值（缺省交给 client 的默认值）
 * @param {number} [options.promptCeilingMs] `session/prompt` 硬上限（缺省交给 client 的默认值）
 * @param {(pid: number) => { ok?: boolean, detail?: string }} [options.killTree] 强杀整棵树的注入点
 * @param {number} [options.graceMs] 优雅收尾的宽限期，默认 1500ms
 * @param {(record: object) => boolean} [options.isAlive] 存活判断注入点
 * @param {() => Promise<{ command?: string, args?: string[] } | null>} [options.locate] 没给 command 时用来找 CLI
 */
export function createAcpEngine({
  spawn, gate, now = Date.now, timeoutMs = 120_000, locate,
  promptIdleMs = null, promptCeilingMs = null, killTree = null, graceMs = null, isAlive = null,
} = {}) {
  const graceTimeout = Number.isFinite(Number(graceMs)) && Number(graceMs) > 0 ? Math.round(Number(graceMs)) : DEFAULT_GRACE_MS;
  const killTreeImpl = typeof killTree === 'function' ? killTree : killProcessTree;
  const isAliveImpl = typeof isAlive === 'function' ? isAlive : defaultIsAlive;
  let client = null;
  let sessionId = null;
  let translateState = createTranslateState();
  let busy = null;
  let disposed = false;
  let lastError = null;
  /** agent 在 initialize 里自报的能力位；未握手前为 null。 */
  let agentCapabilities = null;
  /** 当前轮的中断控制器：cancel() 与 signal 都走它。 */
  let activeAbort = null;

  function status() {
    if (disposed) return 'disposed';
    if (!client) return 'idle';
    return client.isRunning ? (sessionId ? 'ready' : 'started') : 'dead';
  }

  /** spawn 的唯一入口：登记 pid，退出由 client 的 onProcessExit 回调销账。 */
  function spawnTracked(...args) {
    const child = spawn(...args);
    trackProcess(child);
    return child;
  }

  /** 宽限期：进程自己退出就立刻返回，最多等 graceTimeout。 */
  function waitGrace(record) {
    return new Promise(resolve => {
      if (record.exited) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        record.waiters.delete(waiter);
        resolve(record.exited);
      }, graceTimeout);
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      record.waiters.add(waiter);
    });
  }

  /**
   * 进程树收尾：优雅收尾已经由 client.close() 做过（stdin.end() + child.kill()），
   * 这里只负责「宽限期后还活着就收整棵树」——Windows 上 agy 派生的子进程不会被父进程的
   * kill 带走，残留会让下一次 session/new 返回空模型列表。
   */
  async function reapTree(record) {
    if (!record) return;
    try {
      if (record.exited || !isAliveImpl(record)) return;
      await waitGrace(record);
      if (record.exited || !isAliveImpl(record)) return;
      const result = killTreeImpl(record.pid);
      if (result && result.ok === false) log.warn('dispose-reap-failed', { pid: record.pid, detail: result.detail ?? null });
      else log.info('dispose-reap', { pid: record.pid });
    } catch (error) {
      // 清理失败只记日志：dispose 处在退出路径上，抛出去会盖掉真正的失败原因。
      log.warn('dispose-reap-error', { pid: record.pid, detail: String(error?.message ?? error).slice(0, 160) });
    } finally {
      activeProcesses.delete(record.pid);
    }
  }

  /** 起进程 + initialize；已就绪则直接返回。 */
  async function ensureStarted(input) {
    if (client && client.isRunning) return;
    if (client) {
      // 上一轮进程已死：清掉会话，重建。
      client.close?.();
      client = null;
      sessionId = null;
      translateState = createTranslateState();
      agentCapabilities = null;
    }
    let target = { command: input.command, args: input.args ?? [] };
    if (!target.command) {
      if (typeof locate !== 'function') {
        throw new SubscriptionError('cli_missing', { detail: '没有提供 CLI 路径，也没有 locate 钩子' });
      }
      const found = await locate();
      if (!found || !found.command) throw new SubscriptionError('cli_missing', { detail: '没有找到 antigravity CLI' });
      target = { command: found.command, args: found.args ?? [] };
    }
    client = createAcpClient({
      spawn: spawnTracked,
      now,
      timeoutMs,
      promptIdleMs,
      promptCeilingMs,
      // 进程退出只报 pid：engine 用它把登记表里的条目标记成「已退出」，
      // dispose 才不会白等一个宽限期、也不会对已经退出的 pid 再 taskkill。
      onProcessExit: ({ pid }) => markProcessExited(pid),
    });
    const seen = { request: null, notification: null };
    /**
     * 子命令必须显式给出。实测：`agy` 不带 `acp` 启动时**完全不应答**（不退出也不响应 initialize），
     * 表现为每条消息卡满超时再重试，用户看到的就是「一直重连」。
     * 所以缺省值兜底成 `['acp']`，宁可让一个不认这个子命令的 CLI 立刻报错，也不要静默挂死。
     */
    const args = Array.isArray(target.args) && target.args.length > 0 ? target.args : ['acp'];
    client.start({ command: target.command, args, env: input.env, cwd: input.cwd });
    // 反向请求与通知处理器只注册一次：client 内部是数组，重复注册会重复派发。
    seen.request = client.onRequest((method, params, signal) => handleReverse(method, params, signal, input));
    // 通知处理器签名是 (method, params, signal)：第一个参数是方法名，真正的载荷在 params。
    seen.notification = client.onNotification((method, params) => handleNotification(params, input));
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: CLIENT_NAME },
    }).then(response => {
      // 记下 agent 自报的能力位：要不要给它挂 Mova 的工具（HTTP 型 MCP server）取决于它。
      // 拿不到就当作「不支持」，宁可不挂也不要挂上去被拒。
      agentCapabilities = response?.agentCapabilities ?? response?.capabilities ?? null;
    });  }

  /** 反向请求：先判「提问」，再交给闸门。 */
  async function handleReverse(method, params, signal, input) {
    let translated = null;
    try {
      translated = translatePermissionRequest(params, translateState);
    } catch {
      translated = null;
    }
    if (translated?.kind === 'question' && typeof input.onReverseRequest === 'function') {
      const answer = await input.onReverseRequest({ kind: 'question', question: translated.question, method, params });
      // 提问通道的返回可以是直接的 optionId，也可以整包 outcome；两种都放行。
      if (answer && typeof answer === 'object' && answer.outcome) return answer;
      if (typeof answer === 'string' && answer) return { outcome: { outcome: 'selected', optionId: answer } };
      return { outcome: { outcome: 'cancelled' } };
    }
    if (translated?.kind === 'approval' && translated.uncertain) {
      input.emit?.(createNotice('这条请求的类型无法确定，已按「需要授权」处理。', 'warn'));
    }
    if (gate && typeof gate.handle === 'function') {
      return gate.handle(method, params, signal);
    }
    throw new SubscriptionError('acp_protocol', { detail: `没有闸门可处理 ${method}` });
  }

  function handleNotification(notification, input) {
    let result;
    try {
      result = translateSessionUpdate(notification, translateState);
    } catch (error) {
      input.emit?.(createNotice('Gemini 返回了一段无法识别的事件，已跳过。', 'warn'));
      return;
    }
    translateState = result.state;
    for (const event of result.events ?? []) input.emit?.(event);
  }

  async function createSession(input) {
    // `mcpServers` 允许是一个函数：只有在 initialize 之后才知道对面支不支持 HTTP 型 MCP，
    // 所以把「要不要挂、挂什么」的决定权交回调用方（chat-agent）。
    const resolved = typeof input.mcpServers === 'function'
      ? await input.mcpServers({ capabilities: agentCapabilities })
      : input.mcpServers;
    const response = await client.request('session/new', {
      cwd: input.cwd,
      mcpServers: Array.isArray(resolved) ? resolved : [],
    });
    const id = response?.sessionId ?? response?.session?.id ?? null;
    if (typeof id !== 'string' || !id) {
      throw new SubscriptionError('acp_protocol', { detail: 'session/new 没有返回 sessionId' });
    }
    sessionId = id;
    /**
     * 选模型必须显式说：`session/new` 不会因为我们期望就改，`session/prompt` 也不带模型，
     * 所以不调这一步 = 用户在菜单里选什么都会被 CLI 当成默认模型。
     * 方法名与参数形态是实测出来的：`session/set_model({ sessionId, modelId })` 返回 `{}`；
     * `session/setModel` / `session/select_model` 都是 -32601。
     *
     * 失败处理（原来的实现自相矛盾：提示写着「这一轮沿用默认模型」却紧接着 throw，
     * 于是整轮被判失败去重试，用户看到提示又看到重连）：
     * ① 用同一家族的 `medium` 档再试一次（真实案例：`gemini-4-hydrogen-low` 在该版本偶发被拒）；
     * ② 仍然失败就**只提示不阻断**——`session/prompt` 会立刻暴露真正的错，没必要在这里提前放弃。
     */
    const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
    if (modelId) {
      const attempt = async candidate => {
        await client.request('session/set_model', { sessionId: id, modelId: candidate });
        return candidate;
      };
      let applied = '';
      try {
        applied = await attempt(modelId);
      } catch (error) {
        const familyFallback = /\-(?:minimal|low|medium|high|xhigh|max)$/.test(modelId)
          ? modelId.replace(/\-(?:minimal|low|medium|high|xhigh|max)$/, '-medium')
          : '';
        let recovered = '';
        if (familyFallback && familyFallback !== modelId) {
          try {
            recovered = await attempt(familyFallback);
          } catch {
            recovered = '';
          }
        }
        if (recovered) {
          input.emit?.(createNotice(`模型 ${modelId} 没被接受，已改用同家族的 ${recovered}。`, 'info'));
        } else {
          const detail = String(error?.message ?? error).slice(0, 160);
          log.warn('set-model-failed', { modelId, detail });
          input.emit?.(createNotice(`没能切到模型 ${modelId}，这一轮沿用 CLI 默认模型。`, 'warn'));
        }
      }
      if (applied) log.debug('model-applied', { modelId: applied });
    }
    return id;
  }

  async function runTurn(input = {}) {
    if (disposed) return { ok: false, code: 'acp_protocol', detail: 'disposed' };
    if (busy) return { ok: false, code: 'request', detail: 'busy' };
    const emit = typeof input.emit === 'function' ? input.emit : () => {};
    const controller = new AbortController();
    activeAbort = controller;
    const onAbort = () => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }
    busy = Promise.resolve();
    try {
      await ensureStarted(input);
      const id = sessionId ?? (await createSession(input));
      const prompt = typeof input.prompt === 'string' ? input.prompt : String(input.prompt ?? '');
      let response;
      try {
        response = await raceAbort(
          client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: prompt }] }),
          controller.signal,
        );
      } catch (error) {
        // 中断只取消本轮，不关进程：下一轮还能接着用同一个会话。
        if (controller.signal.aborted) {
          await client.request('session/cancel', { sessionId: id }).catch(() => {});
          return { ok: false, code: 'acp_protocol', detail: 'cancelled' };
        }
        throw error;
      }
      if (controller.signal.aborted) {
        await client.request('session/cancel', { sessionId: id }).catch(() => {});
        return { ok: false, code: 'acp_protocol', detail: 'cancelled' };
      }
      if (response?.usage) {
        const usageEvent = translateUsage(response.usage);
        if (usageEvent) emit(usageEvent);
      }
      const stopReason = response?.stopReason ?? response?.stop_reason ?? 'stop';
      return { ok: true, usage: response?.usage ?? null, stopReason };
    } catch (error) {
      const normalized = asError(error);
      lastError = normalized;
      if (client && !client.isRunning) {
        sessionId = null;
        client = null;
      }
      return { ok: false, code: normalized.code, detail: normalized.detail ?? normalized.message };
    } finally {
      busy = null;
      activeAbort = null;
      if (input.signal) input.signal.removeEventListener('abort', onAbort);
    }
  }

  /** 中断当前轮（不杀进程）。 */
  function cancel() {
    if (!activeAbort) return false;
    activeAbort.abort();
    return true;
  }

  async function dispose() {
    disposed = true;
    activeAbort?.abort();
    // 记录必须在 close() 之前取：close() 会触发退出回调，把登记表里的条目销掉，
    // 之后就拿不到「这个 pid 是谁」了。
    const pid = client?.pid;
    const record = Number.isInteger(pid) ? activeProcesses.get(pid) ?? null : null;
    try {
      client?.close?.();
    } catch {
      // 关闭失败也要继续清状态，不能把异常抛给退出流程。
    }
    client = null;
    sessionId = null;
    translateState = createTranslateState();
    await reapTree(record);
  }

  return {
    runTurn,
    cancel,
    dispose,
    get status() {
      return status();
    },
    get lastError() {
      return lastError;
    },
  };
}

/** 让请求能被中断：一旦 abort 就立刻结算，不等上游超时。 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new SubscriptionError('acp_protocol', { detail: 'cancelled' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new SubscriptionError('acp_protocol', { detail: 'cancelled' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
