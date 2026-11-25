import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHANNELS } from '../electron/subscription/contract.mjs';
import { installSubscriptionIpc } from '../electron/subscription/ipc.mjs';

/** 固定时钟：登录/过期判定都要可复现。 */
const T0 = 1_760_000_000_000;

const EXPECTED_SETTINGS = {
  autoSwitch: true,
  preferredAccountId: null,
  remindBelowPercent: null,
  refreshIntervalMins: 5,
  channel: 'chatgpt-plan',
  geminiRunner: 'acp',
  exposeToolsToCli: true,
  cliPath: '',
  chatgptModel: '',
  geminiModel: '',
  thinkingEffort: 'medium',
  imageInput: true,
};

/** 可逆 XOR 冒充 DPAPI：测试只关心值能往返与「落盘不是明文」。 */
function xor(value) {
  const bytes = Buffer.from(value);
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ 0x5a;
  return out;
}

/**
 * 假 safeStorage —— **必须与 Electron 45 的真实形状一致**，否则测试会漏掉线上故障：
 *   isAsyncEncryptionAvailable() → Promise<boolean>（不是同步 boolean！）
 *   encryptStringAsync(text)     → Promise<Buffer>      （不是 { result }）
 *   decryptStringAsync(buffer)   → Promise<{ shouldReEncrypt, result: string }>
 * 用同步 boolean 时，`=== true` 在测试里成立、在线上永远为假——这正是「登录必失败、报凭据存储不可用」的成因。
 */
function fakeSafeStorage({ available = true } = {}) {
  return {
    available,
    async isAsyncEncryptionAvailable() { return this.available; },
    async encryptStringAsync(text) { return xor(Buffer.from(text, 'utf8')); },
    async decryptStringAsync(data) {
      return { shouldReEncrypt: false, result: xor(Buffer.from(data)).toString('utf8') };
    },
  };
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) { handlers.set(channel, listener); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

/** 造一个结构正确的 ID token；测试里 JWKS 取不到，所以签名不参与校验。 */
function makeIdToken(payload, header = { alg: 'RS256', kid: 'key-1' }) {
  const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode(header)}.${encode(payload)}.${Buffer.from('signature').toString('base64url')}`;
}

/**
 * 造一个 Codex access token：chatgpt_account_id / 套餐 / 邮箱全在它的 JWT 声明里，
 * 这正是 wham/usage 与 codex/responses 需要的身份来源。
 */
function makeAccessToken({
  sub = 'user-42', email = 'alice@example.com', accountId = 'acct-1', plan = 'plus',
  exp = Math.floor(T0 / 1000) + 3600,
} = {}) {
  return makeIdToken({
    sub,
    exp,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan },
    'https://api.openai.com/profile': { email, email_verified: true },
  });
}


async function seedCredentialFile(dir, records) {
  const accounts = {};
  for (const record of records) accounts[`${record.provider}:${record.accountId}`] = record;
  await writeFile(join(dir, 'subscriptions.enc'), xor(Buffer.from(JSON.stringify({ version: 1, accounts }), 'utf8')));
}

async function readCredentialFile(dir) {
  const raw = await readFile(join(dir, 'subscriptions.enc'));
  return JSON.parse(xor(raw).toString('utf8'));
}

async function invoke(ipc, channel, ...args) {
  const listener = ipc.handlers.get(channel);
  assert.ok(listener, `通道 ${channel} 应已注册`);
  return listener({}, ...args);
}

async function waitFor(predicate, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail(`等待超时：${label}`);
}

async function harness(t, options = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'mova-sub-'));
  const ipc = fakeIpcMain();
  const events = [];
  const opened = [];
  const warnings = [];
  const instance = installSubscriptionIpc({
    ipcMain: ipc,
    app: { getPath: () => dir },
    shell: {
      openExternal: async (url) => { opened.push(url); return true; },
    },
    safeStorage: options.safeStorage ?? fakeSafeStorage(),
    dialog: options.dialog ?? { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    userDataDir: dir,
    fetch: options.fetch ?? (async (url) => { throw new Error(`unexpected fetch ${url}`); }),
    logger: { info() {}, warn: (...args) => warnings.push(args.join(' ')) },
    getWindows: () => [{ webContents: { send: (channel, payload) => events.push({ channel, payload }) } }],
    now: options.now ?? (() => T0),
    loginTimeoutMs: options.loginTimeoutMs,
    redirectPort: options.redirectPort ?? 0,
    // CLI 定位探针默认注入「没装」：不注入的话每个用例都会真的去文件系统里找 agy，
    // 单测就变成了跑本机环境，慢且不稳。需要真实状态的用例自己传 cliStatus。
    cliStatus: options.cliStatus ?? (async () => ({ found: false, code: 'cli_missing', tried: [] })),
    ...(options.vpnFetchForModel ? { vpnFetchForModel: options.vpnFetchForModel } : {}),
  });
  t.after(async () => {
    instance.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, ipc, instance, events, opened, warnings };
}

test('list returns masked account views without any credential field', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [{
    type: 'oauth',
    provider: 'chatgpt',
    accountId: 'acct-1',
    access: 'access-secret-value',
    refresh: 'refresh-secret-value',
    idToken: 'id-token-secret-value',
    email: 'alice@example.com',
    plan: 'Plus',
    state: 'ready',
    expiresAt: T0 + 3_600_000,
    createdAt: T0 - 1_000,
  }]);

  const result = await invoke(h.ipc, CHANNELS.list);
  assert.equal(result.ok, true, 'list 应当成功');
  assert.equal(result.value.accounts.length, 1, '应当列出一个账号');
  const [account] = result.value.accounts;
  assert.deepEqual(
    Object.keys(account).sort(),
    ['active', 'email', 'id', 'plan', 'provider', 'state'].sort(),
    '账号视图只应包含脱敏字段',
  );
  assert.equal(account.id, 'acct-1', 'id 应当是 accountId');
  assert.equal(account.email, 'alice@example.com', '邮箱应当透出');
  const serialized = JSON.stringify(result.value);
  assert.equal(serialized.includes('refresh-secret-value'), false, '视图不得包含 refresh token');
  assert.equal(serialized.includes('access-secret-value'), false, '视图不得包含 access token');
  assert.equal(serialized.includes('id-token-secret-value'), false, '视图不得包含 id token');
});

test('list falls back to documented settings defaults and built-in model catalog', async (t) => {
  const h = await harness(t);
  const result = await invoke(h.ipc, CHANNELS.list);
  assert.equal(result.ok, true, '空目录下 list 也应当成功');
  assert.deepEqual(result.value.accounts, [], '没有账号时列表为空');
  assert.deepEqual(result.value.settings, EXPECTED_SETTINGS, '缺省设置必须与 §5.4 一致');
  assert.deepEqual(result.value.models.chatgpt.map(item => item.id), ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.1-mini'], 'ChatGPT 内置目录');
  assert.deepEqual(result.value.models.gemini.map(item => item.id), ['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'], 'Gemini 内置目录');
});

// ── 回归：list 必须带上 CLI 状态与账号的「最后调用时间」 ─────────────────
// 这两个字段过去没有从主进程返回，界面因此永远停在「正在检测 CLI…」/「CLI 未就绪」，
// 而 CLI 明明装着、额度也读出来了——用户看到的是自相矛盾的两句话。
test('list carries the CLI status so the page never stays on 「正在检测 CLI…」', async (t) => {
  const h = await harness(t, {
    cliStatus: async () => ({
      found: true, command: 'C:\\tools\\agy.exe', version: { major: 1, minor: 5, patch: 8 }, compatible: true, tried: [],
    }),
  });
  await seedCredentialFile(h.dir, [geminiAccount('g-1', { email: 'one@example.com', plan: 'Pro', projectId: 'p-1' })]);

  const result = await invoke(h.ipc, CHANNELS.list);
  assert.equal(result.ok, true);
  assert.equal(result.value.cli?.found, true, 'list 必须返回 cli');
  assert.equal(result.value.cli?.compatible, true, 'compatible 要原样透出（决定「已就绪」还是「版本过旧」）');
  assert.deepEqual(result.value.cli?.version, { major: 1, minor: 5, patch: 8 }, '版本对象按 {major,minor,patch} 透出');

  const [gemini] = result.value.accounts;
  assert.deepEqual(gemini.cli, { ready: true, version: '1.5.8' }, 'Gemini 账号要带 CLI 就绪状态与字符串版本号');
});

test('list omits cli on ChatGPT accounts and tolerates a failing CLI probe', async (t) => {
  const h = await harness(t, { cliStatus: async () => { throw new Error('locate failed'); } });
  await seedCredentialFile(h.dir, [{
    type: 'oauth', provider: 'chatgpt', accountId: 'acct-1',
    access: 'a', refresh: 'r', email: 'alice@example.com', state: 'ready',
    expiresAt: T0 + 3_600_000, createdAt: T0 - 1_000, lastUsedAt: T0 - 60_000,
  }]);
  const result = await invoke(h.ipc, CHANNELS.list);
  assert.equal(result.ok, true, 'CLI 探测失败不能拖垮 list');
  assert.equal(result.value.cli?.found, false, '探测抛错时降级成 found:false');
  const [account] = result.value.accounts;
  assert.equal(account.cli, undefined, 'ChatGPT 订阅不经过本机 CLI，不该有 cli 字段');
  assert.equal(account.lastUsedAt, T0 - 60_000, 'lastUsedAt 要透出，否则卡片会谎称「还没有调用」');
});

// ── 回归：ChatGPT 额度探针必须走 `subscription:chatgpt` 的线路 ─────────────
// `wham/usage` 与 `auth.openai.com` 在国内直连都会超时，界面上表现为「额度读不到、
// 稍后自动重试」，而对话那边因为走了线路是好的——同一个订阅一半通一半不通。
test('ChatGPT 额度探针与令牌刷新都走 ChatGPT 的线路', async (t) => {
  const routed = [];
  const proxiedFetch = async url => {
    routed.push(String(url));
    return jsonResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
      },
    });
  };
  const h = await harness(t, {
    // 直连 fetch 一次都不该被调用：被调用说明线路没接上。
    fetch: async url => { throw new Error(`不该直连：${url}`); },
    vpnFetchForModel: async providerId => { routed.push(`route:${providerId}`); return proxiedFetch; },
  });
  await seedCredentialFile(h.dir, [{
    type: 'oauth', provider: 'chatgpt', accountId: 'acct-1',
    access: 'access-value', refresh: 'refresh-value', email: 'alice@example.com',
    state: 'ready', expiresAt: T0 + 3_600_000, createdAt: T0 - 1_000,
  }]);

  const result = await invoke(h.ipc, CHANNELS.refresh, { provider: 'chatgpt' });
  assert.equal(result.ok, true, '刷新应当成功');

  assert.ok(routed.includes('route:subscription:chatgpt'), '必须按 subscription:chatgpt 解析线路');
  assert.ok(
    routed.includes('https://chatgpt.com/backend-api/wham/usage'),
    `额度请求必须走代理 fetch，实际：${routed.join(', ')}`,
  );
  const stored = await readCredentialFile(h.dir);
  assert.equal(stored.accounts['chatgpt:acct-1'].usage.windows[0].usedPercent, 42, '额度按上游写回');
});

test('没有分配线路时退回直连 fetch（行为与改动前一致）', async (t) => {
  const direct = [];
  const h = await harness(t, {
    fetch: async url => {
      direct.push(String(url));
      return jsonResponse({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } } });
    },
    // 线路解析失败 = 没装 VPN / 内核没起：必须安全退回，而不是让额度读取整体报错。
    vpnFetchForModel: async () => { throw new Error('vpn unavailable'); },
  });
  await seedCredentialFile(h.dir, [{
    type: 'oauth', provider: 'chatgpt', accountId: 'acct-1',
    access: 'access-value', refresh: 'refresh-value', email: 'alice@example.com',
    state: 'ready', expiresAt: T0 + 3_600_000, createdAt: T0 - 1_000,
  }]);

  const result = await invoke(h.ipc, CHANNELS.refresh, { provider: 'chatgpt' });
  assert.equal(result.ok, true, '线路解析失败也要能刷新（直连）');
  assert.deepEqual(direct, ['https://chatgpt.com/backend-api/wham/usage'], '应退回直连 fetch');
});

test('settingsSet merges the patch, writes atomically and reloads from disk', async (t) => {
  const h = await harness(t);
  const saved = await invoke(h.ipc, CHANNELS.settingsSet, {
    autoSwitch: false,
    refreshIntervalMins: 15,
    chatgptModel: 'gpt-5.6-sol',
    imageInput: false,
  });
  assert.equal(saved.ok, true, '保存设置应当成功');
  assert.equal(saved.value.autoSwitch, false, '布尔值应当落盘');
  assert.equal(saved.value.refreshIntervalMins, 15, '刷新节奏应当落盘');
  assert.equal(saved.value.chatgptModel, 'gpt-5.6-sol', '会话模型必须原样回写');
  assert.equal(saved.value.imageInput, false, 'MODEL_SETTING_KEYS 的布尔项必须回写');
  assert.equal(saved.value.exposeToolsToCli, true, '未提交的字段保持默认值');

  const onDisk = JSON.parse(await readFile(join(h.dir, 'subscription-settings.json'), 'utf8'));
  assert.equal(onDisk.autoSwitch, false, '文件内容应当是新值');
  const leftovers = (await readdir(h.dir)).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写不应留下临时文件');

  const second = await harness(t, { dir: h.dir });
  const reloaded = await invoke(second.ipc, CHANNELS.settingsGet);
  assert.equal(reloaded.value.refreshIntervalMins, 15, '新实例应当从磁盘读到同一份设置');
});

test('a corrupt settings file falls back to defaults without throwing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-sub-'));
  await writeFile(join(dir, 'subscription-settings.json'), '{ this is not json');
  const h = await harness(t, { dir });
  const result = await invoke(h.ipc, CHANNELS.list);
  assert.equal(result.ok, true, '设置损坏不应让 list 失败');
  assert.deepEqual(result.value.settings, EXPECTED_SETTINGS, '损坏时回退缺省值');
  assert.equal(h.warnings.some(line => line.includes('corrupt')), true, '应当记一条损坏日志');
});

test('logout fails with not_configured when the account is unknown', async (t) => {
  const h = await harness(t);
  const result = await invoke(h.ipc, CHANNELS.logout, { accountId: 'missing-account' });
  assert.equal(result.ok, false, '未登录时登出必须失败');
  assert.equal(result.error, 'not_configured', '错误码应当是 not_configured');
  assert.equal(typeof result.message, 'string', '失败也要给可展示文案');
});

test('login writes the credential, then emits login and accounts events', async (t) => {
  const idToken = makeIdToken({ sub: 'user-42', email: 'alice@example.com', exp: Math.floor(T0 / 1000) + 3600 });
  const seen = [];
  const apiFetch = async (url) => {
    const href = String(url);
    if (href.includes('/oauth/token')) {
      seen.push(href);
      return jsonResponse({
        access_token: makeAccessToken({ sub: 'user-42', email: 'alice@example.com' }),
        refresh_token: 'refresh-token-login',
        id_token: idToken,
        expires_in: 3600,
        scope: 'openid profile email offline_access',
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  const h = await harness(t, { fetch: apiFetch });

  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  assert.equal(started.ok, true, '发起登录应当成功');
  assert.equal(typeof started.value.flowId, 'string', '发起登录应当返回 flowId');
  assert.equal(started.value.state, 'waiting', '发起后处于等待授权状态');
  assert.equal(h.opened.length, 1, '应当用系统浏览器打开授权页');

  const authorizeUrl = new URL(started.value.authorizeUrl);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256', '必须用 PKCE S256');
  assert.equal(authorizeUrl.searchParams.get('response_type'), 'code', '必须是授权码模式');
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
  const state = authorizeUrl.searchParams.get('state');
  assert.ok(redirectUri.startsWith('http://127.0.0.1:'), '回调必须落在本机随机端口');
  assert.ok(redirectUri.endsWith('/auth/callback'), '回调路径必须是 /auth/callback');

  const callback = await fetch(`${redirectUri}?code=code-1&state=${encodeURIComponent(state)}`);
  assert.equal(callback.status, 200, '回调应当返回成功页面');
  await waitFor(
    () => h.events.some(event => event.payload.kind === 'login' && event.payload.state === 'authorized'),
    { label: 'authorized 事件' },
  );

  const states = h.events.filter(event => event.payload.kind === 'login').map(event => event.payload.state);
  assert.deepEqual(states, ['waiting', 'verifying', 'authorized'], '登录状态机应当依次推进');
  assert.equal(h.events.every(event => event.channel === CHANNELS.event), true, '事件必须走 subscription:event 通道');
  assert.equal(h.events.some(event => event.payload.kind === 'accounts'), true, '成功后要推 accounts 让列表刷新');
  assert.equal(seen.length, 1, '只应换一次 token');

  const stored = await readCredentialFile(h.dir);
  const record = stored.accounts['chatgpt:user-42'] ?? Object.values(stored.accounts)[0];
  assert.ok(record, '凭据应当写入 subscriptions.enc');
  assert.equal(record.access, makeAccessToken({ sub: 'user-42', email: 'alice@example.com' }), 'access token 应当落盘');
  assert.equal(record.refresh, 'refresh-token-login', 'refresh token 应当落盘');
  assert.equal(record.email, 'alice@example.com', '应当从 access token 的声明里取邮箱');
  assert.equal(record.state, 'ready', '新账号状态应当是 ready');
  assert.notEqual(record.accountId, 'user-42', 'accountId 必须是 hash，不能是明文 sub');

  const listed = await invoke(h.ipc, CHANNELS.list);
  assert.equal(listed.value.accounts.length, 1, '登录后列表里应当有一个账号');
  assert.equal(listed.value.accounts[0].email, 'alice@example.com', '列表里应当显示邮箱');
});

test('login times out after the login window and releases the flow slot', async (t) => {
  const h = await harness(t, { loginTimeoutMs: 20 });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  assert.equal(started.ok, true, '第一次发起登录应当成功');

  await waitFor(
    () => h.events.some(event => event.payload.kind === 'login' && event.payload.state === 'failed'),
    { label: '登录超时事件' },
  );
  const failed = h.events.find(event => event.payload.kind === 'login' && event.payload.state === 'failed');
  assert.match(failed.payload.message, /超时/, '超时文案应当提示重新发起');

  const cancelled = await invoke(h.ipc, CHANNELS.cancelLogin, { provider: 'chatgpt' });
  assert.equal(cancelled.value.cancelled, false, '超时后 flow 应当已经释放');

  const again = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  assert.equal(again.ok, true, '超时后必须能重新发起登录');
});

test('a failed refresh keeps the old credential and marks the account expired', async (t) => {
  const bodies = [];
  const apiFetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/oauth/token')) {
      bodies.push(new URLSearchParams(String(init.body ?? '')));
      return jsonResponse({ error: 'invalid_grant' }, { status: 400 });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  const h = await harness(t, { fetch: apiFetch });
  await seedCredentialFile(h.dir, [{
    type: 'oauth',
    provider: 'chatgpt',
    accountId: 'acct-expired',
    access: 'stale-access-token',
    refresh: 'refresh-keep-me',
    clientId: 'dynamic_agent_client',
    email: 'bob@example.com',
    state: 'ready',
    expiresAt: T0 - 1_000,
    createdAt: T0 - 7_200_000,
  }]);

  const first = await invoke(h.ipc, CHANNELS.refresh, { accountId: 'acct-expired' });
  assert.equal(first.ok, true, '刷新失败只体现在状态上，IPC 不应抛错');

  const second = await invoke(h.ipc, CHANNELS.refresh, { accountId: 'acct-expired' });
  assert.equal(second.ok, true, '第二次刷新也应当能跑');
  assert.equal(bodies.length >= 2, true, '两次刷新都应当尝试换 token');
  assert.equal(bodies[0].get('refresh_token'), 'refresh-keep-me', '必须用记录里的 refresh token');
  assert.equal(bodies[1].get('refresh_token'), 'refresh-keep-me', '刷新失败后旧记录必须保留下来重试');

  const stored = await readCredentialFile(h.dir);
  const record = stored.accounts['chatgpt:acct-expired'];
  assert.ok(record, '刷新失败不得删除记录');
  assert.equal(record.refresh, 'refresh-keep-me', 'refresh token 必须原样保留');
  assert.equal(record.access, 'stale-access-token', 'access token 不得被清空');
  assert.equal(record.state, 'expired', '刷新失败应当标记 expired');

  const listed = await invoke(h.ipc, CHANNELS.list);
  assert.equal(listed.value.accounts[0].state, 'expired', '列表应当显示 expired');
  assert.equal(listed.value.accounts[0].usage.reason, 'probeFailed', '额度读不到时给 probeFailed 原因');
});

test('channelTest reports a network failure instead of throwing', async (t) => {
  const apiFetch = async (url) => { throw new Error(`offline: ${url}`); };
  const h = await harness(t, { fetch: apiFetch });
  await seedCredentialFile(h.dir, [{
    type: 'oauth',
    provider: 'chatgpt',
    accountId: 'acct-ready',
    access: 'usable-access-token',
    refresh: 'usable-refresh-token',
    clientId: 'dynamic_agent_client',
    state: 'ready',
    expiresAt: T0 + 3_600_000,
    createdAt: T0 - 1_000,
  }]);

  const result = await invoke(h.ipc, CHANNELS.channelTest, { kind: 'chatgpt-plan' });
  assert.equal(result.ok, true, '通道自检本身不应失败');
  assert.equal(result.value.status, 'failed', '网络不通应当是 failed');
  assert.equal(result.value.detail, 'network', 'detail 说明是网络问题');
});

test('with unreadable safeStorage every write is refused with credential', async (t) => {
  const h = await harness(t, { safeStorage: fakeSafeStorage({ available: false }) });

  const login = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  assert.equal(login.ok, false, '加密不可用时不能登录');
  assert.equal(login.error, 'credential', '登录失败码应当是 credential');

  const logout = await invoke(h.ipc, CHANNELS.logout, { accountId: 'any-account' });
  assert.equal(logout.ok, false, '加密不可用时不能登出');
  assert.equal(logout.error, 'credential', '登出失败码应当是 credential');

  const refresh = await invoke(h.ipc, CHANNELS.refresh, {});
  assert.equal(refresh.ok, false, '加密不可用时不能刷新');
  assert.equal(refresh.error, 'credential', '刷新失败码应当是 credential');

  const list = await invoke(h.ipc, CHANNELS.list);
  assert.equal(list.ok, true, '只读列表仍然可用');
  assert.deepEqual(list.value.accounts, [], '没有可读凭据时列表为空');
});

test('pickCliPath writes settings.cliPath and tolerates a cancelled dialog', async (t) => {
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:\\tools\\agy.exe'] }) };
  const h = await harness(t, { dialog });
  const picked = await invoke(h.ipc, CHANNELS.pickCliPath);
  assert.equal(picked.ok, true, '选择路径应当成功');
  assert.equal(picked.value.path, 'C:\\tools\\agy.exe', '应当返回选中的路径');
  const settings = await invoke(h.ipc, CHANNELS.settingsGet);
  assert.equal(settings.value.cliPath, 'C:\\tools\\agy.exe', '应当回写到设置');

  const cancelDir = await mkdtemp(join(tmpdir(), 'mova-sub-'));
  const cancelling = await harness(t, { dir: cancelDir, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  const cancelled = await invoke(cancelling.ipc, CHANNELS.pickCliPath);
  assert.equal(cancelled.ok, true, '取消选择不算错误');
  assert.equal(cancelled.value.path, '', '取消时返回空路径');
  assert.equal(cancelling.warnings.some(line => line.includes('failed')), false, '取消不应被当成失败');
});

test('dispose removes every registered handler', async (t) => {
  const h = await harness(t);
  // 用契约推导期望值而不是写死数字：以后加通道不会因为「数字对不上」而误报，
  // 但「契约里有、实际没注册」仍然会被抓到。
  const invokeChannels = Object.keys(CHANNELS).filter(key => key !== 'event').length;
  assert.equal(h.ipc.handlers.size, invokeChannels, '注册的通道数必须与契约里的 invoke 通道数一致');
  h.instance.dispose();
  assert.equal(h.ipc.handlers.size, 0, 'dispose 之后不应留下 handler');
});

// ── Gemini 多账号（追加用例；上面的既有用例只读不改）────────────────────
// 这里只能用本文件既有 harness 能注入的东西（fetch/now/safeStorage），因此 Gemini 的登录实现不做假，
// 只覆盖「凭据已落库」之后的列表 / 刷新 / 选号 / 登出——它们才是多账号语义的落点。

/** Gemini 凭据记录：凭据在 record.google + record.refresh（§5.1）。 */
function geminiAccount(accountId, overrides = {}) {
  const { projectId, ...rest } = overrides;
  return {
    type: 'oauth',
    provider: 'gemini',
    accountId,
    refresh: `gemini-refresh-${accountId}`,
    google: {
      clientId: `gemini-client-${accountId}.apps.googleusercontent.com`,
      clientSecret: `gemini-secret-${accountId}`,
      ...(projectId === undefined ? {} : projectId ? { projectId } : {}),
    },
    state: 'ready',
    limitedUntil: 0,
    lastError: '',
    createdAt: T0 - 1_000,
    ...rest,
  };
}

/** Gemini 探针的三段网络：换 token（按 refresh 区分）+ 两个 host 的 quota summary。 */
function geminiFetch({ usedByRefresh = {}, failRefresh = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push(href);
    if (href === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init.body ?? ''));
      const refreshToken = body.get('refresh_token');
      if (failRefresh.includes(refreshToken)) return jsonResponse({ error: 'invalid_grant' }, { status: 400 });
      return jsonResponse({ access_token: `gemini-access-for-${refreshToken}` });
    }
    if (href.includes('daily-cloudcode-pa.googleapis.com')) {
      const access = String(init.headers?.authorization ?? '');
      const key = Object.keys(usedByRefresh).find(refresh => access.includes(refresh));
      const usedPercent = key ? usedByRefresh[key] : 0;
      return jsonResponse({ buckets: [{ bucketId: 'gemini-2.5-pro', window: '5h', usedPercent }] });
    }
    if (href.includes('cloudcode-pa.googleapis.com')) return jsonResponse({}, { status: 500 });
    throw new Error(`unexpected fetch ${href}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('list returns every gemini account next to the chatgpt one', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    {
      type: 'oauth',
      provider: 'chatgpt',
      accountId: 'acct-chatgpt',
      access: 'chatgpt-access-value',
      refresh: 'chatgpt-refresh-value',
      email: 'chat@example.com',
      state: 'ready',
      expiresAt: T0 + 3_600_000,
      createdAt: T0 - 3_000,
    },
    geminiAccount('g-1', { email: 'one@example.com', plan: 'Pro', projectId: 'p-1' }),
    geminiAccount('g-2', { email: 'two@example.com', plan: 'Ultra', projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.list);
  assert.equal(result.ok, true, 'list 应当成功');
  assert.equal(result.value.accounts.length, 3, '两个 Gemini 账号都要列出，不能只取第一个');
  const gemini = result.value.accounts.filter(account => account.provider === 'gemini');
  assert.deepEqual(gemini.map(account => account.id).sort(), ['g-1', 'g-2'], 'Gemini 账号 id 齐全');
  assert.deepEqual(gemini.map(account => account.email).sort(), ['one@example.com', 'two@example.com'], '邮箱各自正确');
  assert.deepEqual(gemini.map(account => account.plan).sort(), ['Pro', 'Ultra'], '套餐各自正确');
  assert.equal(gemini.filter(account => account.active).length, 1, 'Gemini 只应有一个当前优先账号');
  assert.equal(JSON.stringify(result.value).includes('gemini-secret-g-1'), false, '视图不得含 clientSecret');
  assert.equal(JSON.stringify(result.value).includes('gemini-refresh-g-1'), false, '视图不得含 refresh token');
});

test('refresh writes usage for each gemini account through its own credentials', async (t) => {
  const apiFetch = geminiFetch({ usedByRefresh: { 'gemini-refresh-g-1': 25, 'gemini-refresh-g-2': 70 } });
  const h = await harness(t, { fetch: apiFetch });
  await seedCredentialFile(h.dir, [
    geminiAccount('g-1', { projectId: 'p-1' }),
    geminiAccount('g-2', { projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(result.ok, true, '刷新应当成功');
  assert.equal(result.value.updated, 2, '两个账号都应刷新成功');

  const stored = await readCredentialFile(h.dir);
  assert.equal(stored.accounts['gemini:g-1'].usage.windows[0].usedPercent, 25, 'g-1 的额度写回 g-1');
  assert.equal(stored.accounts['gemini:g-2'].usage.windows[0].usedPercent, 70, 'g-2 的额度写回 g-2');
  assert.equal(stored.accounts['gemini:g-1'].refresh, 'gemini-refresh-g-1', '刷新不得改写凭据');
});

test('one failing gemini probe does not stop the other account', async (t) => {
  const apiFetch = geminiFetch({
    usedByRefresh: { 'gemini-refresh-g-1': 15 },
    failRefresh: ['gemini-refresh-g-2'],
  });
  const h = await harness(t, { fetch: apiFetch });
  await seedCredentialFile(h.dir, [
    geminiAccount('g-1', { projectId: 'p-1' }),
    geminiAccount('g-2', { projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(result.ok, true, '单账号失败不能让整次刷新失败');
  assert.deepEqual(result.value.failed.map(item => item.id), ['g-2'], '失败账号回报在 failed 里');

  const stored = await readCredentialFile(h.dir);
  assert.equal(stored.accounts['gemini:g-1'].usage.windows[0].usedPercent, 15, '成功账号照常写入额度');
  assert.equal(stored.accounts['gemini:g-2'].usage.reason, 'probeFailed', '失败账号留下 probeFailed 原因');
  assert.equal(stored.accounts['gemini:g-2'].lastError, 'probeFailed', '失败账号记 lastError');
  assert.equal(stored.accounts['gemini:g-2'].refresh, 'gemini-refresh-g-2', '失败也不得丢掉凭据');
});

test('a gemini account without projectId reports noProject without any request', async (t) => {
  const apiFetch = geminiFetch({ usedByRefresh: {} });
  const h = await harness(t, { fetch: apiFetch });
  await seedCredentialFile(h.dir, [geminiAccount('g-no-project', { projectId: '' })]);

  await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });

  assert.deepEqual(apiFetch.calls, [], '缺 projectId 时一次网络都不发（不当成失败重试）');
  const stored = await readCredentialFile(h.dir);
  assert.equal(stored.accounts['gemini:g-no-project'].usage.reason, 'noProject', '原因必须是 noProject');
  assert.equal(stored.accounts['gemini:g-no-project'].lastError, '', 'noProject 不写 lastError');
});

test('select then list marks only the chosen gemini account active', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    geminiAccount('g-1', { projectId: 'p-1' }),
    geminiAccount('g-2', { projectId: 'p-2' }),
  ]);

  const selected = await invoke(h.ipc, CHANNELS.select, { accountId: 'g-2' });
  assert.equal(selected.ok, true, '设为优先账号应当成功');
  assert.equal(selected.value.preferredAccountId, 'g-2', 'preferredAccountId 必须写进设置');

  const listed = await invoke(h.ipc, CHANNELS.list);
  const byId = new Map(listed.value.accounts.map(account => [account.id, account]));
  assert.equal(byId.get('g-2').active, true, '被选中的账号 active 为 true');
  assert.equal(byId.get('g-1').active, false, '另一个账号 active 为 false');
  assert.equal((await h.instance.service.pool.pick('gemini')).account.accountId, 'g-2', 'pool.pick 跟随优先账号');
});

test('logout deletes only the named gemini account', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    geminiAccount('g-1', { projectId: 'p-1' }),
    geminiAccount('g-2', { projectId: 'p-2' }),
  ]);

  const removed = await invoke(h.ipc, CHANNELS.logout, { accountId: 'g-1' });
  assert.equal(removed.ok, true, '登出应当成功');

  const stored = await readCredentialFile(h.dir);
  assert.deepEqual(
    Object.keys(stored.accounts).filter(key => key.startsWith('gemini:')),
    ['gemini:g-2'],
    '同 provider 的其它账号不能被一起删掉',
  );
  const listed = await invoke(h.ipc, CHANNELS.list);
  assert.deepEqual(listed.value.accounts.map(account => account.id), ['g-2'], '列表里只剩没被登出的账号');
});

/**
 * 回归：Electron 45 的 `safeStorage.isAsyncEncryptionAvailable()` 返回 **Promise<boolean>**。
 *
 * 曾经的实现写成 `isAsyncEncryptionAvailable() === true`——在真机上永远为假，
 * 于是每一次登录都在 `assertWritable()` 处抛 `credential`，用户看到的就是
 * 「授权失败 / 凭据存储不可用 / 授权没有完成」。这三个用例锁住三种形态：
 * Promise<true>、旧的同步 boolean、以及 Promise<false>。
 */
test('login is allowed when isAsyncEncryptionAvailable resolves a Promise (Electron 45 shape)', async (t) => {
  const base = fakeSafeStorage();
  const h = await harness(t, {
    safeStorage: { ...base, isAsyncEncryptionAvailable: async () => true },
  });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  assert.equal(started.ok, true, 'Promise<true> 必须被当作「可用」，不能因为没 await 就拒绝登录');
  assert.equal(typeof started.value?.flowId, 'string', '应当真的进入等待授权状态');
});

test('login is allowed when isAsyncEncryptionAvailable returns a legacy sync boolean', async (t) => {
  const base = fakeSafeStorage();
  const h = await harness(t, {
    safeStorage: { ...base, isAsyncEncryptionAvailable: () => true },
  });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  assert.equal(started.ok, true, '同步 boolean 是旧版形态，也要兼容');
});

test('login is refused with credential when the Promise resolves false', async (t) => {
  const base = fakeSafeStorage();
  const h = await harness(t, {
    safeStorage: { ...base, isAsyncEncryptionAvailable: async () => false },
  });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  assert.equal(started.ok, false, '不可用时必须拒绝，不能退化成明文');
  assert.equal(started.error, 'credential', '错误码应当是 credential');
});

// ── 回归：回调响应不能被「关服务器」掐断（真机表现为「127.0.0.1 拒绝连接」）──────
// 曾经的实现是「先 finishFlow() 再 sendHtml()」，而 finishFlow 会 closeAllConnections()，
// 把正在写的那条连接直接 reset：浏览器看到的是错误页，登录其实已经成功。
// 单测里因为本机回环极快，status 200 常常还能拿到，所以断言必须看**响应体是否完整**。

test('callback body is delivered in full on success (no truncated response)', async (t) => {
  const idToken = makeIdToken({ sub: 'user-body', email: 'body@example.com', exp: Math.floor(T0 / 1000) + 3600 });
  const apiFetch = async (url) => {
    if (String(url).includes('/oauth/token')) {
      return jsonResponse({
        access_token: makeAccessToken({ sub: 'user-body', email: 'body@example.com' }),
        refresh_token: 'rt-body',
        id_token: idToken,
        expires_in: 3600,
        scope: 'openid profile email offline_access',
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const h = await harness(t, { fetch: apiFetch });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  const authorizeUrl = new URL(started.value.authorizeUrl);
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
  const state = authorizeUrl.searchParams.get('state');

  const response = await fetch(`${redirectUri}?code=code-body&state=${encodeURIComponent(state)}`);
  assert.equal(response.status, 200, '回调应当返回 200');
  const body = await response.text();
  assert.ok(body.length > 100, `响应体不能被截断，实际 ${body.length} 字符`);
  assert.match(body, /可以关闭这个页面了/, '必须完整收到「可以关闭这个页面了」这句');
  assert.match(body, /<\/html>|<\/body>/i, 'HTML 必须完整收尾（截断时不会有收尾标签）');
});

test('callback body is delivered in full on failure (so the user can read the reason)', async (t) => {
  const h = await harness(t);
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  const authorizeUrl = new URL(started.value.authorizeUrl);
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri');

  // 故意用错的 state：completeFlow 会抛 auth_cancelled，走失败分支
  const response = await fetch(`${redirectUri}?code=c&state=wrong-state`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.length > 60, '失败页也必须完整送达');
  assert.match(body, /登录失败/, '失败原因必须能被看到，而不是被 reset 掉');
});

// ── 手动完成登录（浏览器到不了 127.0.0.1 时的兜底）────────────────────────

test('completeLogin finishes the flow from a pasted callback URL', async (t) => {
  const idToken = makeIdToken({ sub: 'user-manual', email: 'manual@example.com', exp: Math.floor(T0 / 1000) + 3600 });
  const h = await harness(t, {
    fetch: async (url) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({
          access_token: makeAccessToken({ sub: 'user-manual', email: 'manual@example.com' }),
          refresh_token: 'rt-manual',
          id_token: idToken,
          expires_in: 3600,
          scope: 'openid profile email offline_access',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  const authorizeUrl = new URL(started.value.authorizeUrl);
  const state = authorizeUrl.searchParams.get('state');
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri');

  const pasted = `${redirectUri}?code=manual-code&state=${encodeURIComponent(state)}`;
  const done = await invoke(h.ipc, CHANNELS.completeLogin, {
    provider: 'chatgpt',
    flowId: started.value.flowId,
    url: pasted,
  });
  assert.equal(done.ok, true, '粘贴回调链接应当能完成登录');
  assert.equal(done.value.email, 'manual@example.com', '应当拿到邮箱');

  const stored = await readCredentialFile(h.dir);
  assert.equal(stored.accounts['chatgpt:manual-code']?.access ?? stored.accounts[Object.keys(stored.accounts)[0]]?.access,
    makeAccessToken({ sub: 'user-manual', email: 'manual@example.com' }), '凭据应当落盘');
});

test('completeLogin refuses a wrong state and reports a readable error', async (t) => {
  const h = await harness(t);
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  const redirectUri = new URL(started.value.authorizeUrl).searchParams.get('redirect_uri');

  const done = await invoke(h.ipc, CHANNELS.completeLogin, {
    provider: 'chatgpt',
    flowId: started.value.flowId,
    url: `${redirectUri}?code=c&state=not-the-state`,
  });
  assert.equal(done.ok, false, 'state 不匹配必须拒绝');
  assert.equal(done.error, 'auth_cancelled');
});

test('completeLogin without an active flow fails instead of hanging', async (t) => {
  const h = await harness(t);
  const done = await invoke(h.ipc, CHANNELS.completeLogin, { provider: 'chatgpt', url: 'http://127.0.0.1:1/auth/callback?code=c&state=s' });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'auth_cancelled');
});

// ── 回归：换 token 必须用回调返回的 client_id ───────────────────────────
// 回调里如果带了另一个 client_id，换 token 必须用它（否则 invalid_client）。
// 若忽略它、仍拿本地固定值去换 token，会 `invalid_client`——
// 表现就是「浏览器授权成功了，但 Mova 说授权失败」。

test('token exchange uses the client_id returned by the callback', async (t) => {
  const idToken = makeIdToken({ sub: 'user-cid', email: 'cid@example.com', exp: Math.floor(T0 / 1000) + 3600 });
  let exchangeBody = null;
  const h = await harness(t, {
    fetch: async (url, init) => {
      if (String(url).includes('/oauth/token')) {
        exchangeBody = new URLSearchParams(init.body);
        return jsonResponse({
          access_token: makeAccessToken({ sub: 'user-cid', email: 'cid@example.com' }),
          refresh_token: 'rt-cid',
          id_token: idToken,
          expires_in: 3600,
          scope: 'openid profile email offline_access',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  const authorizeUrl = new URL(started.value.authorizeUrl);
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
  const state = authorizeUrl.searchParams.get('state');

  const response = await fetch(`${redirectUri}?code=cid-code&state=${encodeURIComponent(state)}&client_id=oaiapp_registered`);
  await response.text();

  assert.ok(exchangeBody, '应当发生换 token 请求');
  assert.equal(exchangeBody.get('client_id'), 'oaiapp_registered', '必须用回调返回的 client_id，而不是固定的客户端 id');
  assert.equal(exchangeBody.get('grant_type'), 'authorization_code');
});

test('token exchange falls back to the fixed client id when the callback omits it', async (t) => {
  const idToken = makeIdToken({ sub: 'user-cid2', email: 'cid2@example.com', exp: Math.floor(T0 / 1000) + 3600 });
  let exchangeBody = null;
  const h = await harness(t, {
    fetch: async (url, init) => {
      if (String(url).includes('/oauth/token')) {
        exchangeBody = new URLSearchParams(init.body);
        return jsonResponse({
          access_token: makeAccessToken({ sub: 'user-cid2', email: 'cid2@example.com' }), refresh_token: 'rt-cid2', id_token: idToken, expires_in: 3600,
          scope: 'openid profile email offline_access',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const started = await invoke(h.ipc, CHANNELS.login, { provider: 'chatgpt' });
  const authorizeUrl = new URL(started.value.authorizeUrl);
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
  const state = authorizeUrl.searchParams.get('state');

  const response = await fetch(`${redirectUri}?code=cid2-code&state=${encodeURIComponent(state)}`);
  await response.text();

  assert.ok(exchangeBody);
  assert.equal(exchangeBody.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann', '没有返回 client_id 时退回 Codex 的公开客户端');
});
