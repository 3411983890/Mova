/**
 * Gemini 登录：触发本机 antigravity CLI 的授权流程，再从它写下的私有 profile 取凭据。
 *
 * 负责：定位 CLI（复用 cli.mjs）、用私有 profile 目录起 `auth login`、轮询 `acp_token.json`、
 *      算稳定的 accountId，并把失败收敛成 `{ ok:false, code }` 而不是抛异常。
 * 不负责：写入凭据库（由 ipc.mjs 落 store）、额度探针（usage.mjs）、ACP 会话与请求编排。
 * 被谁调用：electron/subscription/ipc.mjs 的 gemini 登录分支。
 *
 * 关键决策：
 * - Gemini 没有可自研的 OAuth：登录态归 CLI 所有，Mova 只能「触发登录 + 读 profile」（§7.2）。
 * - 「版本过旧」≠「没装」：locateCli 的 compatible:false 单独映射成 cli_incompatible（§9.4）。
 * - profile 目录私有（GEMINI_HOME/HOME 指向它），不覆盖用户自己那份 antigravity 登录态。
 * - 磁盘与进程全部注入（access/exec/readFile/mkdir/now），测试因此完全不碰真实环境。
 * - 任何返回值与 detail 都不含 refresh token 原文（§6）。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { locateCli } from './cli.mjs';
import { LOGIN_STATES } from './contract.mjs';

/** profile 里 CLI 自己维护的子目录与令牌文件名（与 t3code 同一套布局）。 */
const PROFILE_SUBDIR = 'antigravity-acp';
const TOKEN_FILE = 'acp_token.json';
/** 必填字段：缺任意一个都说明 CLI 还没写完，这时必须返回 null 而不是半截凭据。 */
const REQUIRED_FIELDS = Object.freeze(['client_id', 'client_secret', 'refresh_token']);
/** 轮询节奏：1s 一次，够快又不至于把磁盘刷爆。 */
const POLL_INTERVAL_MS = 1000;
/** 子进程超时比登录窗口多留一点：登录窗口一满我们会主动结束它，这个值只是兜底。 */
const CLI_GRACE_MS = 5000;

/** `<profile>/antigravity-acp/acp_token.json`：唯一信源，别处不许再拼这个路径。 */
function tokenPath(profileDir) {
  return join(profileDir, PROFILE_SUBDIR, TOKEN_FILE);
}

function messageOf(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String(error.message ?? error.code ?? error);
}

/**
 * 兜底脱敏：上游异常里万一带出令牌字段，只保留字段名、不留值。
 * 只在 detail 里用；成功路径的令牌原样返回给调用方写 store。
 */
function scrub(text) {
  return String(text ?? '')
    .replace(/(refresh_token|client_secret|access_token|id_token)\s*[=:]\s*"?[^"\s,}]+"?/gi, '$1=***')
    .slice(0, 200);
}

/** 排查用的命令行摘要：可执行文件 + 参数。环境变量与令牌一律不进 detail。 */
function commandLine(command, args) {
  return [command, ...(Array.isArray(args) ? args : [])]
    .filter(part => typeof part === 'string' && part.length > 0)
    .join(' ');
}

function failure(code, detail) {
  return { ok: false, code, detail: String(detail ?? '').slice(0, 300) };
}

function isAborted(signal) {
  return Boolean(signal && signal.aborted === true);
}

/** 只留字段齐全的令牌；JSON 是对象但字段没写完时同样返回 null（CLI 可能正在写）。 */
function pickToken(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const token = {};
  for (const field of REQUIRED_FIELDS) {
    const value = parsed[field];
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    token[field] = value.trim();
  }
  const projectId = parsed.project_id;
  if (typeof projectId === 'string' && projectId.trim().length > 0) token.project_id = projectId.trim();
  return token;
}

/**
 * 读 CLI 写下的令牌。
 *
 * @param {{ profileDir: string, readFile: Function }} options
 * @returns {Promise<{ client_id: string, client_secret: string, refresh_token: string, project_id?: string } | null>}
 *   文件缺失 / 正在写 / JSON 坏 / 字段不全 一律 null，绝不抛。
 */
export async function readGeminiToken({ profileDir, readFile } = {}) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) return null;
  if (typeof readFile !== 'function') return null;
  let raw;
  try {
    raw = await readFile(tokenPath(profileDir), 'utf8');
  } catch {
    // 文件还没出现，或 CLI 正在写（Windows 上会短暂锁文件）：下一轮再读。
    return null;
  }
  const text = typeof raw === 'string'
    ? raw
    : raw && typeof raw.toString === 'function' ? raw.toString('utf8') : '';
  if (text.trim().length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return pickToken(parsed);
}

/**
 * accountId = sha256(client_id \0 refresh_token \0 project_id)：
 * profile 里没有稳定的 Google 用户 id，只能拿凭据三元组当身份；重复登录同一账号才会被识别成同一个。
 */
function accountIdOf(token) {
  return createHash('sha256')
    .update(`${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ''}`)
    .digest('hex');
}

/**
 * 登录参数：locateCli 给的 args 是 ACP 会话用的 `['acp']`，登录要换成 `auth login`。
 * 保留其余既有参数（将来 CLI 加全局开关时不用改这里），只剥掉 acp 子命令。
 */
function loginArgs(args) {
  const rest = (Array.isArray(args) ? args : [])
    .filter(arg => typeof arg === 'string' && arg.length > 0 && arg !== 'acp');
  return [...rest, 'auth', 'login'];
}

/**
 * 私有 profile 环境：CLI 认 GEMINI_HOME，其余工具链按 HOME/USERPROFILE 找配置，三处一起指过去。
 * 复制注入的 env 而不是改 process.env：主进程其它模块还在用真实环境。
 */
function loginEnv(env, profileDir) {
  const source = env && typeof env === 'object' ? env : {};
  return { ...source, GEMINI_HOME: profileDir, HOME: profileDir, USERPROFILE: profileDir };
}

/** 可被 signal 唤醒的 sleep：取消要立刻返回，不能傻等满一个轮询间隔。 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/** 退出码归一：数字/数字串直接用；没有退出码视为正常结束；其它（ENOENT 等）记 -1。 */
function exitCodeOf(result) {
  const code = result?.code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  if (code === undefined || code === null) return 0;
  return -1;
}

/** 尽力结束子进程：注入的 exec 可能是 ChildProcess，也可能只是个 promise（那就只能靠 signal）。 */
function stopCli(handle) {
  for (const target of [handle, handle?.child]) {
    try { target?.kill?.(); } catch { /* 已经退出了 */ }
  }
  try { handle?.abort?.(); } catch { /* 同上 */ }
}

/**
 * 起 CLI 但**不 await**：登录期间要同时轮询 profile，等进程退出会把整段流程卡住。
 * 只记退出状态，供轮询循环判断「CLI 已经结束了但没写令牌」。
 */
function startCli({ exec, command, args, env, timeoutMs, signal }) {
  let handle = null;
  try {
    handle = exec(command, args, { env, timeoutMs: timeoutMs + CLI_GRACE_MS, signal });
  } catch (error) {
    return { state: { exited: true, code: -1, error: messageOf(error) }, stop() {} };
  }
  const state = { exited: false, code: 0, error: '' };
  // 挂上两个分支，避免进程退出/reject 变成未处理的 rejection。
  Promise.resolve(handle).then(
    (value) => { state.exited = true; state.code = exitCodeOf(value); },
    (error) => { state.exited = true; state.code = -1; state.error = messageOf(error); },
  );
  return { state, stop: () => stopCli(handle) };
}

/** CLI 结束了却没有令牌：按「用户拒绝 / 根本起不来 / 写了空 profile」三种处境分开报。 */
function exitFailure(state, command, args) {
  const line = commandLine(command, args);
  if (state.error) return failure('cli_missing', `spawn_failed: ${scrub(state.error)} · ${line}`);
  if (state.code !== 0) return failure('auth_denied', `cli_exit_${state.code} · ${line}`);
  return failure('credential', `token_missing · ${line}`);
}

/**
 * 触发 antigravity CLI 登录并等它把令牌写进私有 profile。
 *
 * @param {{
 *   settings?: { cliPath?: string },
 *   platform?: string,
 *   env?: Record<string, string>,
 *   home?: string,
 *   profileDir: string,
 *   access: (path: string) => Promise<boolean>,
 *   exec: (command: string, args: string[], options?: object) => any,
 *   readFile: (path: string, encoding?: string) => Promise<any>,
 *   mkdir: (path: string, options?: object) => Promise<any>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   signal?: AbortSignal,
 *   onProgress?: (state: string) => void,
 * }} options
 * @returns {Promise<{ ok: true, account: { accountId: string, projectId?: string }, token: object }
 *   | { ok: false, code: string, detail: string }>}
 */
export async function loginGemini({
  settings, platform, env = {}, home, profileDir, access, exec, readFile, mkdir,
  now, timeoutMs = 300_000, intervalMs = POLL_INTERVAL_MS, signal, onProgress,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const report = (state) => {
    // 只放行契约里的状态值：渲染层的状态机认死这几个字面量（§7.1）。
    if (typeof onProgress !== 'function' || !LOGIN_STATES.includes(state)) return;
    try { onProgress(state); } catch { /* 进度回调不许把登录带崩 */ }
  };

  if (typeof profileDir !== 'string' || profileDir.length === 0) return failure('request', 'profileDir');
  if (typeof readFile !== 'function' || typeof mkdir !== 'function') return failure('request', 'io');
  if (typeof exec !== 'function' || typeof access !== 'function') return failure('request', 'probe');

  // 1) 先找 CLI：找不到与版本过旧是两种处境，混成一个码会让用户去重装（§9.4）。
  const cli = await locateCli({ settings, platform, env, home, access, exec });
  if (!cli.found) return failure('cli_missing', cli.detail || 'cli_missing');
  const args = loginArgs(cli.args);
  if (cli.compatible === false) {
    return failure('cli_incompatible', [cli.detail, commandLine(cli.command, args)].filter(Boolean).join(' · '));
  }
  report('waiting');

  // 2) 私有 profile：目录先建好，环境变量指过去，用户自己那份配置一个字节都不动。
  const profileEnv = loginEnv(env, profileDir);
  try {
    await mkdir(join(profileDir, PROFILE_SUBDIR), { recursive: true });
  } catch (error) {
    return failure('credential', `profile_dir: ${scrub(messageOf(error))}`);
  }

  const waitMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : 300_000;
  const tickMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : POLL_INTERVAL_MS;

  // 3) 起登录：CLI 会自己打开浏览器完成 Google 授权，Mova 只轮询它写下的文件。
  const session = startCli({
    exec,
    command: cli.command,
    args,
    env: profileEnv,
    timeoutMs: waitMs,
    signal,
  });
  const deadline = clock() + waitMs;

  try {
    for (;;) {
      if (isAborted(signal)) return failure('auth_denied', 'cancelled');
      const token = await readGeminiToken({ profileDir, readFile });
      if (token) {
        report('verifying');
        const accountId = accountIdOf(token);
        return { ok: true, account: { accountId, ...(token.project_id ? { projectId: token.project_id } : {}) }, token };
      }
      // CLI 自己退出了：继续等到超时只会让用户多等几分钟，立刻按退出原因回报。
      if (session.state.exited) return exitFailure(session.state, cli.command, args);
      const remaining = deadline - clock();
      if (remaining <= 0) {
        return failure('auth_timeout', `等待 ${waitMs}ms 未读到 ${PROFILE_SUBDIR}/${TOKEN_FILE} · ${commandLine(cli.command, args)}`);
      }
      await sleep(Math.min(tickMs, remaining), signal);
    }
  } finally {
    // 成功、超时、取消都结束子进程：登录窗口留着 CLI 只会占着 profile 锁。
    session.stop();
  }
}
