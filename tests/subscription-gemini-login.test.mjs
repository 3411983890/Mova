/**
 * Gemini 登录（CLI 触发 + 读 profile）的单元测试。
 *
 * 全部走注入：access / exec / readFile / mkdir 都是假的，跑测试不碰真实磁盘、进程与网络。
 * 断言消息用中文，测试名用英文，失败时能直接看出是哪条行为退化。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { LOGIN_STATES } from '../electron/subscription/contract.mjs';
import { loginGemini, readGeminiToken } from '../electron/subscription/gemini-login.mjs';

/** 纯字符串路径（不落盘）：PROFILE 只用来验证「私有目录被拼对、被注入给 CLI」。 */
const PROFILE = join('mova-test', 'gemini-profile');
const TOKEN_DIR = join(PROFILE, 'antigravity-acp');
const TOKEN_PATH = join(TOKEN_DIR, 'acp_token.json');
const ENV = { PATH: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' };

const TOKEN = Object.freeze({
  client_id: 'fake-client-id.apps.googleusercontent.com',
  client_secret: 'fake-client-secret',
  refresh_token: 'fake-refresh-token-value',
  project_id: 'fake-project-id',
});
const TOKEN_TEXT = JSON.stringify(TOKEN);

/** 期望的 accountId：用与实现无关的独立算法重算一遍。 */
function expectedAccountId(token) {
  return createHash('sha256')
    .update(`${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ''}`)
    .digest('hex');
}

function enoent() {
  const error = new Error('ENOENT: no such file or directory');
  error.code = 'ENOENT';
  return error;
}

/** 可推进的假时钟：step 毫秒/次读表，让超时判定在测试里瞬时到达。 */
function fakeClock(step = 0) {
  let value = 1_760_000_000_000;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

/** 只认白名单里的 CLI 路径，同时记录被探过哪些（函数本体上挂 calls，符合 locateCli 的入参形状）。 */
function fakeAccess(existing = []) {
  const set = new Set(existing.map(item => item.toLowerCase()));
  const calls = [];
  const access = async (target) => {
    calls.push(target);
    return set.has(String(target).toLowerCase());
  };
  access.calls = calls;
  return access;
}

/** 记录每次 exec 的 (command, args, options)，按脚本返回结果。默认永不结束（CLI 在等浏览器授权）。 */
function fakeExec(handler = () => new Promise(() => {})) {
  const calls = [];
  const exec = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    return handler(command, args, options);
  };
  exec.calls = calls;
  exec.authCalls = () => calls.filter(call => call.args.includes('auth'));
  return exec;
}

/** 版本探针脚本：--version 回一段正常输出，子命令回同样的内容。 */
function versionExec(text) {
  const exec = fakeExec((command, args) => (args.includes('--version') || args.includes('version')
    ? Promise.resolve({ stdout: text, stderr: '', code: 0 })
    : new Promise(() => {})));
  return exec;
}

/** 假子进程：kill 次数可断言。 */
function fakeChild() {
  const child = { kills: 0, kill() { this.kills += 1; } };
  const pending = new Promise(() => {});
  pending.kill = () => child.kill();
  return { child, pending };
}

/** 按轮次返回内容的 readFile：第 appearAfter 轮起才读得到令牌。 */
function fakeReadFile(script) {
  const state = { calls: 0, paths: [] };
  const readFile = async (path, encoding) => {
    state.calls += 1;
    state.paths.push({ path, encoding });
    const value = script(state.calls, path);
    if (value instanceof Error) throw value;
    return value;
  };
  readFile.state = state;
  return readFile;
}

function fakeMkdir(error = null) {
  const calls = [];
  const mkdir = async (path, options) => {
    calls.push({ path, options });
    if (error) throw error;
  };
  mkdir.calls = calls;
  return mkdir;
}

/** loginGemini 的公共底座：CLI 已装、版本够、令牌按 script 出现。 */
function baseOptions(overrides = {}) {
  const mkdir = overrides.mkdir ?? fakeMkdir();
  const options = {
    settings: { cliPath: 'agy' },
    platform: process.platform,
    env: ENV,
    home: 'C:\\Users\\u',
    profileDir: PROFILE,
    access: fakeAccess(['agy', 'agy.exe', 'agy.cmd']),
    exec: versionExec('agy 2.24.0'),
    readFile: fakeReadFile(() => TOKEN_TEXT),
    mkdir,
    now: fakeClock(),
    timeoutMs: 50,
    intervalMs: 5,
    ...overrides,
  };
  return options;
}

// ── readGeminiToken ──────────────────────────────────────────────

test('readGeminiToken returns null when acp_token.json does not exist yet', async () => {
  const readFile = fakeReadFile(() => enoent());
  const token = await readGeminiToken({ profileDir: PROFILE, readFile });
  assert.equal(token, null, '文件缺失必须返回 null，不能抛');
  assert.equal(readFile.state.paths[0].path, TOKEN_PATH, '只读 <profile>/antigravity-acp/acp_token.json');
  assert.equal(readFile.state.paths[0].encoding, 'utf8', '按 utf8 读');
});

test('readGeminiToken returns null for corrupt JSON', async () => {
  const token = await readGeminiToken({ profileDir: PROFILE, readFile: fakeReadFile(() => '{ not json') });
  assert.equal(token, null, 'JSON 坏掉必须返回 null');
});

test('readGeminiToken returns null when a required field is missing or blank', async () => {
  const cases = [
    { client_secret: 'a', refresh_token: 'b' },
    { client_id: 'a', refresh_token: 'b' },
    { client_id: 'a', client_secret: 'b' },
    { client_id: 'a', client_secret: 'b', refresh_token: '   ' },
    { client_id: 42, client_secret: 'b', refresh_token: 'c' },
    ['client_id', 'client_secret', 'refresh_token'],
  ];
  for (const value of cases) {
    const token = await readGeminiToken({ profileDir: PROFILE, readFile: fakeReadFile(() => JSON.stringify(value)) });
    assert.equal(token, null, `字段不全必须返回 null：${JSON.stringify(value)}`);
  }
});

test('readGeminiToken returns the credential fields including optional project_id', async () => {
  const token = await readGeminiToken({ profileDir: PROFILE, readFile: fakeReadFile(() => TOKEN_TEXT) });
  assert.deepEqual(token, TOKEN, '三要素与 project_id 原样返回');

  const withoutProject = JSON.stringify({ ...TOKEN, project_id: undefined });
  const partial = await readGeminiToken({ profileDir: PROFILE, readFile: fakeReadFile(() => withoutProject) });
  assert.equal(partial.project_id, undefined, '没有 project_id 时不伪造字段');
});

test('readGeminiToken accepts a Buffer because the CLI writes raw bytes', async () => {
  const token = await readGeminiToken({
    profileDir: PROFILE,
    readFile: fakeReadFile(() => Buffer.from(TOKEN_TEXT, 'utf8')),
  });
  assert.deepEqual(token, TOKEN, 'Buffer 也要能解析');
});

test('readGeminiToken tolerates missing probes instead of throwing', async () => {
  assert.equal(await readGeminiToken(), null, '没有参数时返回 null');
  assert.equal(await readGeminiToken({ profileDir: '', readFile: async () => TOKEN_TEXT }), null, '空 profileDir 返回 null');
  assert.equal(await readGeminiToken({ profileDir: PROFILE }), null, '没有 readFile 返回 null');
});

// ── loginGemini：定位 CLI ────────────────────────────────────────

test('loginGemini reports cli_missing when no antigravity CLI exists', async () => {
  const exec = versionExec('agy 2.24.0');
  const result = await loginGemini(baseOptions({ access: fakeAccess([]), exec }));
  assert.equal(result.ok, false, '没装 CLI 不能假装成功');
  assert.equal(result.code, 'cli_missing', '错误码必须是 cli_missing');
  assert.match(result.detail, /已尝试 \d+ 个位置/, 'detail 要说明试过多少位置');
  assert.deepEqual(exec.authCalls(), [], '找不到 CLI 时不得尝试登录');
});

test('loginGemini reports cli_incompatible instead of cli_missing for an old CLI', async () => {
  // 门槛是 1.0.0：1.x（例如实测可用的 1.5.8）必须放行，只有 0.x 才算过旧。
  const result = await loginGemini(baseOptions({ exec: versionExec('agy 0.9.0') }));
  assert.equal(result.ok, false, '版本过旧不能放行');
  assert.equal(result.code, 'cli_incompatible', '版本过旧必须是 cli_incompatible，不能说没装');
  assert.match(result.detail, /0\.9\.0/, 'detail 要带上真实版本号');
});

// ── loginGemini：正常登录 ───────────────────────────────────────

test('loginGemini polls the profile and returns a stable accountId once the token appears', async () => {
  const exec = versionExec('agy 2.24.0');
  const readFile = fakeReadFile(call => (call < 3 ? enoent() : TOKEN_TEXT));
  const mkdir = fakeMkdir();
  const result = await loginGemini(baseOptions({ exec, readFile, mkdir }));

  assert.equal(result.ok, true, '令牌出现后应当成功');
  assert.deepEqual(result.token, TOKEN, '令牌原样交给调用方写 store');
  assert.equal(result.account.accountId, expectedAccountId(TOKEN), 'accountId 必须是 sha256(client_id\\0refresh_token\\0project_id)');
  assert.equal(result.account.projectId, TOKEN.project_id, 'projectId 透出给调用方');
  assert.ok(readFile.state.calls >= 3, '必须轮询到第 3 轮才拿到令牌');
  assert.deepEqual(mkdir.calls, [{ path: TOKEN_DIR, options: { recursive: true } }], '必须先建出 <profile>/antigravity-acp');

  const again = await loginGemini(baseOptions({ exec: versionExec('agy 2.24.0'), readFile: fakeReadFile(() => TOKEN_TEXT) }));
  assert.equal(again.account.accountId, result.account.accountId, '同输入两次的 accountId 必须一致（refresh 换 access 不影响身份）');
});

test('loginGemini launches `auth login` and points the CLI at the private profile', async () => {
  const pending = fakeChild();
  const exec = fakeExec((command, args) => (args.includes('--version')
    ? Promise.resolve({ stdout: 'agy 2.24.0', stderr: '', code: 0 })
    : pending.pending));
  const before = { GEMINI_HOME: process.env.GEMINI_HOME, HOME: process.env.HOME };
  const result = await loginGemini(baseOptions({ exec }));
  assert.equal(result.ok, true, '轮询到令牌后成功');

  const [login] = exec.authCalls();
  assert.ok(login, '必须调起一次登录子命令');
  assert.deepEqual(login.args, ['auth', 'login'], '登录参数是 auth login，不是 ACP 的 acp 子命令');
  assert.equal(login.options.env.GEMINI_HOME, PROFILE, 'GEMINI_HOME 指向私有 profile');
  assert.equal(login.options.env.HOME, PROFILE, 'HOME 也要指过去（CLI 可能按 HOME 找配置）');
  assert.equal(login.options.env.USERPROFILE, PROFILE, 'Windows 上 USERPROFILE 才是真实 home');
  assert.equal(login.options.env.PATH, ENV.PATH, '注入的 env 其余字段必须保留');
  assert.equal(process.env.GEMINI_HOME, before.GEMINI_HOME, '不得改 process.env');
  assert.equal(process.env.HOME, before.HOME, '不得改 process.env');
  assert.equal(pending.child.kills >= 1, true, '成功后要结束子进程');
});

test('loginGemini emits only contract login states to onProgress', async () => {
  const seen = [];
  const result = await loginGemini(baseOptions({ onProgress: state => seen.push(state) }));
  assert.equal(result.ok, true, '正常登录应当成功');
  assert.ok(seen.length >= 2, '至少要报 waiting 与 verifying');
  assert.equal(seen.every(state => LOGIN_STATES.includes(state)), true, `进度状态必须来自契约：${seen.join(',')}`);
  assert.equal(seen[0], 'waiting', '第一条是 waiting');
  assert.equal(seen[seen.length - 1], 'verifying', '读到令牌后进入 verifying（authorized 由 ipc 广播）');
});

test('loginGemini keeps working when onProgress throws', async () => {
  const result = await loginGemini(baseOptions({ onProgress: () => { throw new Error('ui broken'); } }));
  assert.equal(result.ok, true, '渲染层回调抛错不能把登录带崩');
});

// ── loginGemini：失败与中断 ─────────────────────────────────────

test('loginGemini reports auth_timeout when the profile never gets a token', async () => {
  const result = await loginGemini(baseOptions({
    readFile: fakeReadFile(() => enoent()),
    now: fakeClock(7),
    timeoutMs: 5,
    intervalMs: 5,
  }));
  assert.equal(result.ok, false, '一直读不到令牌必须失败');
  assert.equal(result.code, 'auth_timeout', '超时码必须是 auth_timeout');
  assert.match(result.detail, /acp_token\.json/, 'detail 要说明在等哪个文件');
});

test('loginGemini returns auth_denied cancelled on abort and still stops the CLI', async () => {
  const pending = fakeChild();
  const exec = fakeExec((command, args) => (args.includes('--version')
    ? Promise.resolve({ stdout: 'agy 2.24.0', stderr: '', code: 0 })
    : pending.pending));
  const controller = new AbortController();
  controller.abort();
  const result = await loginGemini(baseOptions({ exec, signal: controller.signal }));

  assert.equal(result.ok, false, '取消后不能报成功');
  assert.equal(result.code, 'auth_denied', '取消归到 auth_denied');
  assert.equal(result.detail, 'cancelled', 'detail 固定为 cancelled，方便界面识别');
  assert.equal(exec.authCalls()[0].options.signal, controller.signal, 'signal 必须传给子进程');
  assert.equal(pending.child.kills >= 1, true, '取消后要尽力结束子进程');
});

test('loginGemini reports auth_denied when the CLI exits non-zero without a token', async () => {
  const exec = fakeExec((command, args) => (args.includes('--version')
    ? Promise.resolve({ stdout: 'agy 2.24.0', stderr: '', code: 0 })
    : Promise.resolve({ stdout: '', stderr: 'denied', code: 3 })));
  const result = await loginGemini(baseOptions({ exec, readFile: fakeReadFile(() => enoent()) }));
  assert.equal(result.ok, false, 'CLI 异常退出不能报成功');
  assert.equal(result.code, 'auth_denied', '退出码非 0 视为未授权');
  assert.match(result.detail, /cli_exit_3/, 'detail 要带退出码，便于排查');
  assert.match(result.detail, /auth login/, 'detail 要带实际用的命令行');
});

test('loginGemini reports credential when the CLI exits cleanly but wrote no token', async () => {
  const exec = fakeExec((command, args) => (args.includes('--version')
    ? Promise.resolve({ stdout: 'agy 2.24.0', stderr: '', code: 0 })
    : Promise.resolve({ stdout: '', stderr: '', code: 0 })));
  const result = await loginGemini(baseOptions({ exec, readFile: fakeReadFile(() => enoent()) }));
  assert.equal(result.code, 'credential', 'CLI 正常退出却没令牌属于凭据问题');
  assert.match(result.detail, /token_missing/, 'detail 说明令牌缺失');
});

test('loginGemini reports credential when the private profile cannot be created', async () => {
  const mkdir = fakeMkdir(new Error('EACCES: permission denied'));
  const result = await loginGemini(baseOptions({ mkdir }));
  assert.equal(result.ok, false, '建不出 profile 目录必须失败');
  assert.equal(result.code, 'credential', '目录建不出来归到 credential');
  assert.match(result.detail, /profile_dir/, 'detail 标出是 profile 目录的问题');
});

test('loginGemini never leaks the refresh token into a failure detail', async () => {
  const leaky = new Error('spawn failed: refresh_token=fake-refresh-token-value, client_secret=fake-client-secret');
  const exec = fakeExec((command, args) => (args.includes('--version')
    ? Promise.resolve({ stdout: 'agy 2.24.0', stderr: '', code: 0 })
    : Promise.reject(leaky)));
  const result = await loginGemini(baseOptions({ exec, readFile: fakeReadFile(() => enoent()) }));
  assert.equal(result.ok, false, '子进程起不来必须失败');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('fake-refresh-token-value'), false, 'detail 不得含 refresh token 原文');
  assert.equal(serialized.includes('fake-client-secret'), false, 'detail 不得含 client_secret 原文');
  assert.match(result.detail, /refresh_token=\*\*\*/, '泄漏内容应当被脱敏成 ***');
});

test('loginGemini explains a half-written token file as a timeout, not a success', async () => {
  const half = JSON.stringify({ client_id: 'fake-client-id', refresh_token: 'fake-refresh-token-value' });
  const result = await loginGemini(baseOptions({
    readFile: fakeReadFile(() => half),
    now: fakeClock(7),
    timeoutMs: 5,
    intervalMs: 5,
  }));
  assert.equal(result.ok, false, '字段不全不得当成登录完成');
  assert.equal(result.code, 'auth_timeout', 'CLI 还没写完时继续等，超时报 auth_timeout');
  assert.equal(JSON.stringify(result).includes('fake-refresh-token-value'), false, '失败结果不得带出 refresh token 原文');
});
