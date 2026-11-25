/**
 * ACP stdio 客户端：NDJSON / JSON-RPC 2.0 的成帧层。
 *
 * 负责：写 `JSON.stringify(msg)+'\n'`、跨 chunk 的半行缓冲、请求 id 配对与超时
 * （`session/prompt` 走「空闲看门狗 + 硬上限」，其余方法仍是固定超时）、
 * 反向请求分发给 onRequest、进程退出时清空 pending 并把 pid 报给调用方。
 * 不负责：ACP 语义（initialize/session/update 映射）与审批、路径安全（在 gate.mjs）。
 * 被 chat-agent.mjs 的 engine==='acp' 分支调用；gate.handle 通过 onRequest 挂进来。
 *
 * spawn 依赖注入（简报 §2.6）：测试用 PassThrough 造假 stdio，不在测试里真起进程。
 */
import { StringDecoder } from 'node:string_decoder';
import { SubscriptionError } from '../subscription/contract.mjs';

/** 连续多少行非法 JSON 才判定协议异常（单行噪声来自 CLI 自己打的日志，不能一条就断）。 */
const MAX_INVALID_LINES = 5;
const STDERR_TAIL_LINES = 20;
const STDERR_LINE_MAX = 200;

/**
 * `session/prompt` 的空闲看门狗阈值：连续这么久没收到该会话的 `session/update` 才判超时。
 *
 * 为什么是 10 分钟：一轮 prompt 里存在**等人工审批**的合法静默期，而 `browser_handoff`
 * 的审批最长可到 10 分钟（见 electron/browser/batch.cjs 的 handoff 上限、approvals.cjs 的等待）。
 * 客户端的看门狗不能比审批上限还短——短了就是「用户在审批条上停 3 分钟，回来发现会话
 * 已经被 acp_protocol 杀掉，前端只看到『模型连接中断，正在第 N/5 次自动重试…』」。
 * 调用方可以覆盖（engine 透传，测试用极短值）。
 */
export const DEFAULT_PROMPT_IDLE_MS = 600_000;

/** 单次长请求的硬上限：只有「一直有 session/update」才能走到这里，默认 30 分钟。 */
export const DEFAULT_PROMPT_CEILING_MS = 30 * 60_000;

/** 走看门狗的方法：只有 prompt 会长时间安静（等审批/跑长任务），其余请求仍是固定超时。 */
const LONG_RUNNING_METHODS = new Set(['session/prompt']);

/** 回退开关：置 1 时 `session/prompt` 恢复「固定 timeoutMs 一刀切」的旧行为，用于对比排查。 */
const FLAT_TIMEOUT_ENV = 'MOVA_ACP_FLAT_TIMEOUT';
/** 硬上限的环境变量覆盖（毫秒）。 */
const PROMPT_CEILING_ENV = 'MOVA_ACP_PROMPT_CEILING_MS';

/**
 * 看门狗超时：`code` 区分「空闲超时」与「硬上限超时」，日志与上层重试策略才分得清。
 * 仍继承 SubscriptionError，既有的 `instanceof SubscriptionError` 分支不需要认识新类型。
 */
export class AcpTimeoutError extends SubscriptionError {
  /**
   * @param {'acp_idle_timeout' | 'acp_ceiling_timeout'} code
   * @param {{ detail?: string, idleMs?: number|null, ceilingMs?: number|null, sinceLastActivityMs?: number|null }} [extra]
   */
  constructor(code, { detail, idleMs = null, ceilingMs = null, sinceLastActivityMs = null } = {}) {
    super('acp_protocol', { detail });
    this.name = 'AcpTimeoutError';
    this.code = code;
    this.timeout = { idleMs, ceilingMs, sinceLastActivityMs };
  }
}

/** 「正的毫秒数」归一：非数字/<=0 一律当作没配（交给默认值）。 */
function positiveMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

/**
 * @param {object} options
 * @param {Function} options.spawn 注入的 spawn（测试用假 stdio）
 * @param {() => number} [options.now] 时钟（测试注入假时钟）
 * @param {number} [options.timeoutMs] 固定超时：非长请求，以及开了回退开关时的 prompt
 * @param {number} [options.promptIdleMs] 空闲阈值；缺省 `DEFAULT_PROMPT_IDLE_MS`
 * @param {number} [options.promptCeilingMs] 硬上限；其次 `MOVA_ACP_PROMPT_CEILING_MS`，缺省 `DEFAULT_PROMPT_CEILING_MS`
 * @param {Record<string, string|undefined>} [options.env] 读回退开关的环境变量表
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer] 定时器（测试注入假时钟）
 * @param {(handle: unknown) => void} [options.clearTimer] 取消定时器
 * @param {(info: { pid: number, code: number|null, signal: string|null }) => void} [options.onProcessExit]
 *   进程退出回调：engine 靠它判断「还需要不需要强杀整棵进程树」
 */
export function createAcpClient({
  spawn, now = Date.now, timeoutMs = 120000,
  promptIdleMs = null, promptCeilingMs = null, env = process.env,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle),
  onProcessExit = null,
} = {}) {
  if (typeof spawn !== 'function') throw new SubscriptionError('request', { detail: 'createAcpClient 需要注入 spawn' });
  const timeout = positiveMs(timeoutMs) ?? 120000;
  const idleTimeout = positiveMs(promptIdleMs) ?? DEFAULT_PROMPT_IDLE_MS;
  const ceilingTimeout = positiveMs(promptCeilingMs) ?? positiveMs(env?.[PROMPT_CEILING_ENV]) ?? DEFAULT_PROMPT_CEILING_MS;
  const flatTimeout = String(env?.[FLAT_TIMEOUT_ENV] ?? '') === '1';
  const decoder = new StringDecoder('utf8');
  /** id → { resolve, reject, timer, method } */
  const pending = new Map();
  const requestHandlers = [];
  const notificationHandlers = [];
  /** 只留最后几行 stderr：进程非零退出时用来说明原因，不落盘、不进日志。 */
  const stderrTail = [];
  let child = null;
  let running = false;
  let buffer = '';
  let nextId = 1;
  let invalidRun = 0;
  let controller = new AbortController();

  function send(message) {
    if (!running || !child || !child.stdin) {
      throw new SubscriptionError('acp_protocol', { detail: `ACP 进程未运行，无法发送 ${message.method ?? '响应'}` });
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw new SubscriptionError('acp_protocol', { detail: '写入 ACP stdin 失败', cause: error });
    }
  }

  function failAll(error) {
    for (const entry of pending.values()) {
      // 每个请求可能同时挂着「空闲/固定」与「硬上限」两个计时器：由 entry 自己统一清。
      entry.cleanup();
      entry.reject(error);
    }
    pending.clear();
  }

  /**
   * 任意该会话的 `session/update` 都算「还有进展」：续期所有在等的长请求。
   * 只认 `session/update`——别的通知（日志、权限回执）不代表模型在干活。
   */
  function touchWatchdogs(method, params) {
    if (method !== 'session/update') return;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
    for (const entry of pending.values()) {
      const watchdog = entry.watchdog;
      if (!watchdog) continue;
      // 通知带 sessionId 时必须对得上：别的会话的噪声不能给本会话续命。
      if (watchdog.sessionId && sessionId && watchdog.sessionId !== sessionId) continue;
      watchdog.touch();
    }
  }

  function isId(value) {
    return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length > 0);
  }

  function settle(message) {
    const entry = pending.get(message.id);
    // 超时之后才到的响应：已经没有等待者，直接丢弃（不能让 write 抛到读循环里）。
    if (!entry) return;
    pending.delete(message.id);
    entry.cleanup();
    if (message.error) {
      const upstream = typeof message.error.message === 'string' ? message.error.message : '';
      entry.reject(new SubscriptionError('acp_protocol', {
        detail: `${entry.method}: 上游返回错误（${message.error.code ?? 'no-code'}）${upstream}`,
      }));
      return;
    }
    entry.resolve(message.result ?? null);
  }

  function rpcError(error) {
    const contract = error instanceof SubscriptionError;
    const text = contract ? [error.message, error.detail].filter(Boolean).join('：') : '内部错误';
    return { code: -32603, message: String(text).slice(0, 500), data: { code: contract ? error.code : 'request' } };
  }

  function reply(id, payload) {
    // 反向请求的响应发不出去（进程刚退出）不算错误：对端已经不听了。
    try {
      send({ jsonrpc: '2.0', id, ...payload });
    } catch { /* ignore */ }
  }

  async function handleReverseRequest(message) {
    const { method } = message;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const signal = controller.signal;
    try {
      let handled = false;
      let result;
      // 多个处理器时按注册顺序询问；返回 undefined 表示「我不处理」，交给下一个。
      for (const handler of [...requestHandlers]) {
        const value = await handler(method, params, signal);
        if (value !== undefined) {
          handled = true;
          result = value;
          break;
        }
      }
      if (!handled) {
        reply(message.id, { error: { code: -32601, message: `未处理的反向请求：${method}` } });
        return;
      }
      reply(message.id, { result: result ?? null });
    } catch (error) {
      reply(message.id, { error: rpcError(error) });
    }
  }

  function notifyHandlers(method, params) {
    for (const handler of notificationHandlers) {
      try {
        handler(method, params, controller.signal);
      } catch { /* 通知处理器的异常不能打断读循环 */ }
    }
  }

  function noteInvalid() {
    invalidRun += 1;
    if (invalidRun < MAX_INVALID_LINES) return;
    // 连续噪声说明对端已经不是 JSON-RPC 了：判协议异常并断开，避免半死连接继续写。
    running = false;
    failAll(new SubscriptionError('acp_protocol', { detail: `连续 ${MAX_INVALID_LINES} 行不是合法 JSON，判定协议异常` }));
    controller.abort();
    const broken = child;
    child = null;
    buffer = '';
    invalidRun = 0;
    try { broken?.stdin?.end?.(); } catch { /* 尽力而为 */ }
    try { broken?.kill?.(); } catch { /* 尽力而为 */ }
  }

  function handleLine(raw) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      noteInvalid();
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      noteInvalid();
      return;
    }
    invalidRun = 0;
    if (typeof message.method === 'string' && message.method) {
      // 有 method 且有 id = 反向请求（要回包）；有 method 没 id = 通知。
      if (isId(message.id)) void handleReverseRequest(message);
      else {
        // 先续期再看分发：看门狗只关心「这条 notifications 说明对端还活着」。
        touchWatchdogs(message.method, message.params);
        notifyHandlers(message.method, message.params);
      }
      return;
    }
    if (isId(message.id) && ('result' in message || 'error' in message)) {
      settle(message);
      return;
    }
    noteInvalid();
  }

  function onChunk(chunk) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  }

  function onStderr(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      stderrTail.push(trimmed.slice(0, STDERR_LINE_MAX));
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  }

  function onExit(code, signal) {
    // 退出事件要先报给调用方：engine 靠它判断「还需要不需要 taskkill 整棵树」。
    // 必须放在 `!running` 的早返回**之前**——close() → kill() 之后 running 已经是 false，
    // 早返回会把这次退出吞掉，engine 就只能空等满一个宽限期。
    const pid = child?.pid;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        onProcessExit?.({ pid, code: code ?? null, signal: signal ?? null });
      } catch { /* 回调异常不能影响收尾 */ }
    }
    if (!running) {
      // close() 之后的二次事件：状态已经清过了。
      child = null;
      return;
    }
    running = false;
    const tail = stderrTail.length ? `；stderr: ${stderrTail.at(-1)}` : '';
    failAll(new SubscriptionError('acp_protocol', {
      detail: `ACP 进程已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）${tail}`,
    }));
    controller.abort();
    child = null;
    buffer = '';
    invalidRun = 0;
  }

  function start(options = {}) {
    if (running) throw new SubscriptionError('request', { detail: 'ACP 客户端已在运行，先 close() 再 start()' });
    const { command, args = [], env, cwd } = options;
    if (!command) throw new SubscriptionError('request', { detail: 'start 需要 command' });
    let spawned;
    try {
      spawned = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    } catch (error) {
      // ENOENT 是「没装 CLI」，其余当协议/启动失败，渲染层要能分开提示。
      if (error && error.code === 'ENOENT') throw new SubscriptionError('cli_missing', { cause: error });
      throw new SubscriptionError('acp_protocol', { detail: `启动 ACP 进程失败：${error?.message ?? 'unknown'}`, cause: error });
    }
    if (!spawned || typeof spawned !== 'object' || !spawned.stdout || !spawned.stdin
      || typeof spawned.stdout.on !== 'function' || typeof spawned.stdin.write !== 'function') {
      throw new SubscriptionError('acp_protocol', { detail: 'spawn 返回的进程缺少 stdin/stdout 管道' });
    }
    child = spawned;
    running = true;
    buffer = '';
    invalidRun = 0;
    stderrTail.length = 0;
    controller = new AbortController();
    spawned.stdout.on('data', onChunk);
    spawned.stdout.on('error', () => onExit(null, null));
    if (spawned.stderr && typeof spawned.stderr.on === 'function') spawned.stderr.on('data', onStderr);
    if (typeof spawned.on === 'function') {
      spawned.on('exit', onExit);
      spawned.on('close', onExit);
      spawned.on('error', onExit);
    }
    return { pid: spawned.pid ?? null };
  }

  function request(method, params) {
    if (typeof method !== 'string' || !method) throw new SubscriptionError('request', { detail: 'request 需要 method' });
    const id = nextId;
    nextId += 1;
    // 只有长请求 + 没开回退开关时才走看门狗；initialize / session/new 等仍是固定超时。
    const watchdog = !flatTimeout && LONG_RUNNING_METHODS.has(method);
    return new Promise((resolve, reject) => {
      let lastActivityAt = now();
      let primaryTimer = null;
      let ceilingTimer = null;
      let settled = false;
      const sinceLastActivity = () => Math.max(0, Math.round(now() - lastActivityAt));
      const cleanup = () => {
        if (primaryTimer) { clearTimer(primaryTimer); primaryTimer = null; }
        if (ceilingTimer) { clearTimer(ceilingTimer); ceilingTimer = null; }
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        cleanup();
        reject(error);
      };
      // 空闲计时器：每次活动都重新起算。硬上限另有一个只起一次的计时器。
      const armIdle = () => {
        if (primaryTimer) clearTimer(primaryTimer);
        primaryTimer = setTimer(() => {
          fail(new AcpTimeoutError('acp_idle_timeout', {
            detail: `${method}: 空闲超时（${idleTimeout}ms 内没有收到 session/update，距上次活动 ${sinceLastActivity()}ms）`,
            idleMs: idleTimeout,
            ceilingMs: ceilingTimeout,
            sinceLastActivityMs: sinceLastActivity(),
          }));
        }, idleTimeout);
      };
      const entry = { resolve, reject, cleanup, method, watchdog: null };
      if (watchdog) {
        entry.watchdog = {
          sessionId: typeof params?.sessionId === 'string' ? params.sessionId : null,
          touch() {
            lastActivityAt = now();
            armIdle();
          },
        };
        armIdle();
        ceilingTimer = setTimer(() => {
          fail(new AcpTimeoutError('acp_ceiling_timeout', {
            detail: `${method}: 触到单次请求硬上限（${ceilingTimeout}ms，距上次活动 ${sinceLastActivity()}ms）`,
            idleMs: idleTimeout,
            ceilingMs: ceilingTimeout,
            sinceLastActivityMs: sinceLastActivity(),
          }));
        }, ceilingTimeout);
      } else {
        primaryTimer = setTimer(() => {
          fail(new SubscriptionError('acp_protocol', {
            detail: `${method}: 等待响应超时（${timeout}ms，已等待 ${sinceLastActivity()}ms）`,
          }));
        }, timeout);
      }
      // 先入表再写：写入失败时能干净地回滚，不会留下孤儿 timer。
      pending.set(id, entry);
      try {
        send({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (error) {
        settled = true;
        pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  function notify(method, params) {
    if (typeof method !== 'string' || !method) throw new SubscriptionError('request', { detail: 'notify 需要 method' });
    send({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  function onRequest(handler) {
    if (typeof handler !== 'function') throw new SubscriptionError('request', { detail: 'onRequest 需要函数' });
    requestHandlers.push(handler);
    return () => {
      const index = requestHandlers.indexOf(handler);
      if (index >= 0) requestHandlers.splice(index, 1);
    };
  }

  function onNotification(handler) {
    if (typeof handler !== 'function') throw new SubscriptionError('request', { detail: 'onNotification 需要函数' });
    notificationHandlers.push(handler);
    return () => {
      const index = notificationHandlers.indexOf(handler);
      if (index >= 0) notificationHandlers.splice(index, 1);
    };
  }

  function close() {
    const active = child;
    const wasRunning = running;
    running = false;
    child = null;
    buffer = '';
    invalidRun = 0;
    failAll(new SubscriptionError('acp_protocol', { detail: 'ACP 连接已关闭，请求未完成' }));
    controller.abort();
    if (!active) return;
    try { active.stdin?.end?.(); } catch { /* ignore */ }
    // 文档 §10.2 的收尾口径：先关 stdin，再让调用方 kill（超过 3s 由上层决定）。
    if (wasRunning) {
      try { active.kill?.(); } catch { /* ignore */ }
    }
  }

  return {
    start,
    request,
    notify,
    onRequest,
    onNotification,
    close,
    get pid() {
      return child?.pid ?? null;
    },
    get isRunning() {
      return running;
    },
  };
}
