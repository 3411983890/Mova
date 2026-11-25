/**
 * Gemini 多账号（登录落库 / 列表 / 额度刷新 / 选号 / 登出）的 IPC 层测试。
 *
 * 覆盖的是 `electron/subscription/ipc.mjs` 的 gemini 分支：账号身份来自登录侧的 accountId，
 * 刷新逐账号独立收敛（一条失败不连坐），缺 projectId 只报 noProject 不重试。
 * 全部走注入：登录实现、探针、fetch、getWindows、时钟都是假的，跑测试不碰真实 CLI/网络/DPAPI。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHANNELS } from '../electron/subscription/contract.mjs';
import { installSubscriptionIpc } from '../electron/subscription/ipc.mjs';

/** 固定时钟：checkedAt / createdAt 要可复现。 */
const T0 = 1_760_000_000_000;

/** 可逆 XOR 冒充 DPAPI：只关心值能往返，以及落盘不是明文。 */
function xor(value) {
  const bytes = Buffer.from(value);
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ 0x5a;
  return out;
}

/** 与 Electron 45 真实形状一致的假 safeStorage：可用性是 Promise，加密出 Buffer，解密出 `{ result }`。 */
function fakeSafeStorage() {
  return {
    async isAsyncEncryptionAvailable() { return true; },
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

/** Gemini 账号夹具：凭据形状与 §5.1 一致（record.google + record.refresh）。 */
function geminiRecord(accountId, overrides = {}) {
  const { projectId, ...rest } = overrides;
  return {
    type: 'oauth',
    provider: 'gemini',
    accountId,
    refresh: `refresh-${accountId}-value`,
    google: {
      clientId: `client-${accountId}.apps.googleusercontent.com`,
      clientSecret: `secret-${accountId}-value`,
      ...(projectId === undefined ? {} : projectId ? { projectId } : {}),
    },
    state: 'ready',
    limitedUntil: 0,
    lastError: '',
    createdAt: T0 - 60_000,
    ...rest,
  };
}

/** 一段合法的额度快照（探针的返回形状）。 */
function usageSnapshot(usedPercent) {
  return {
    checkedAt: T0,
    windows: [{ id: 'gemini-5h', label: 'Gemini · 5 小时窗口', usedPercent, windowDurationMins: 300 }],
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

async function harness(t, options = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'mova-sub-gemini-'));
  const ipc = fakeIpcMain();
  const events = [];
  const warnings = [];
  const fetchCalls = [];
  const defaultFetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error(`unexpected fetch ${url}`);
  };
  const instance = installSubscriptionIpc({
    ipcMain: ipc,
    app: { getPath: () => dir },
    shell: { openExternal: async () => true },
    safeStorage: fakeSafeStorage(),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    userDataDir: dir,
    fetch: options.fetch ?? defaultFetch,
    logger: { info() {}, warn: (...args) => warnings.push(args.join(' ')) },
    getWindows: () => [{ webContents: { send: (channel, payload) => events.push({ channel, payload }) } }],
    now: options.now ?? (() => T0),
    loginGemini: options.loginGemini,
    probeGemini: options.probeGemini,
  });
  t.after(async () => {
    instance.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, ipc, instance, events, warnings, fetchCalls };
}

/** 记录每次探针调用的入参，方便断言「一个账号一次」。 */
function fakeProbe(handler) {
  const calls = [];
  const probe = async (input) => {
    calls.push(input);
    return handler(input, calls.length);
  };
  probe.calls = calls;
  return probe;
}

/** 假登录：按次序返回固定结果，记录被调用的 profileDir 等入参。 */
function fakeLogin(results) {
  const calls = [];
  const queue = Array.isArray(results) ? [...results] : [results];
  const login = async (input) => {
    calls.push(input);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next;
  };
  login.calls = calls;
  return login;
}

function okLogin(accountId, { refreshToken = `refresh-${accountId}-value`, projectId = `project-${accountId}` } = {}) {
  return {
    ok: true,
    account: { accountId, ...(projectId ? { projectId } : {}) },
    token: {
      client_id: `client-${accountId}.apps.googleusercontent.com`,
      client_secret: `secret-${accountId}-value`,
      refresh_token: refreshToken,
      ...(projectId ? { project_id: projectId } : {}),
    },
  };
}

// ── 列表 ────────────────────────────────────────────────────────

test('list returns every gemini account with its own email, plan and state', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { email: 'one@example.com', plan: 'Pro', projectId: 'p-1' }),
    geminiRecord('g-2', { email: 'two@example.com', plan: 'Ultra', projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.list);
  assert.equal(result.ok, true, 'list 应当成功');
  assert.equal(result.value.accounts.length, 2, '两个 Gemini 账号都必须列出来，不能只取第一个');

  const byId = new Map(result.value.accounts.map(account => [account.id, account]));
  assert.equal(byId.get('g-1').email, 'one@example.com', '第一个账号的邮箱必须对上');
  assert.equal(byId.get('g-1').plan, 'Pro', '第一个账号的套餐必须对上');
  assert.equal(byId.get('g-2').email, 'two@example.com', '第二个账号的邮箱必须对上');
  assert.equal(byId.get('g-2').plan, 'Ultra', '第二个账号的套餐必须对上');
  for (const account of result.value.accounts) {
    assert.equal(account.provider, 'gemini', 'provider 必须是 gemini');
    assert.equal(account.state, 'ready', '未标记冷却的账号状态是 ready');
  }
  assert.equal(result.value.accounts.filter(account => account.active).length, 1, '同一 provider 只应有一个当前优先账号');
});

test('list never exposes the refresh token, client secret or google credential block', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { email: 'one@example.com', plan: 'Pro', projectId: 'p-1' }),
    geminiRecord('g-2', { email: 'two@example.com', plan: 'Ultra', projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.list);
  const dumped = JSON.stringify(result.value);
  for (const secret of [
    'refresh-g-1-value', 'refresh-g-2-value',
    'secret-g-1-value', 'secret-g-2-value',
    'client-g-1.apps.googleusercontent.com',
  ]) {
    assert.equal(dumped.includes(secret), false, `list 返回里不得出现 ${secret.slice(0, 12)}…`);
  }
  for (const account of result.value.accounts) {
    assert.equal(Object.prototype.hasOwnProperty.call(account, 'google'), false, '视图不得带 google 凭据块');
    assert.equal(Object.prototype.hasOwnProperty.call(account, 'refresh'), false, '视图不得带 refresh');
    assert.equal(Object.prototype.hasOwnProperty.call(account, 'access'), false, '视图不得带 access');
  }
});

// ── 登录落库 ────────────────────────────────────────────────────

test('logging in the same gemini account twice upserts a single record', async (t) => {
  const login = fakeLogin([okLogin('g-1', { refreshToken: 'refresh-first' }), okLogin('g-1', { refreshToken: 'refresh-second' })]);
  const h = await harness(t, { loginGemini: login });

  const first = await invoke(h.ipc, CHANNELS.login, { provider: 'gemini' });
  assert.equal(first.ok, true, '第一次登录应当成功');
  assert.equal(first.value.accountId, 'g-1', '登录结果回传真实 accountId');

  const second = await invoke(h.ipc, CHANNELS.login, { provider: 'gemini' });
  assert.equal(second.ok, true, '第二次登录同一账号也应当成功（覆盖而不是报重复）');
  assert.equal(login.calls.length, 2, '两次登录各调一次 CLI 登录实现');
  assert.equal(login.calls[0].profileDir, join(h.dir, 'gemini-profile'), '私有 profile 必须落在 userData 下');

  const stored = await readCredentialFile(h.dir);
  const geminiKeys = Object.keys(stored.accounts).filter(key => key.startsWith('gemini:'));
  assert.deepEqual(geminiKeys, ['gemini:g-1'], '同一账号只能有一条记录');
  const record = stored.accounts['gemini:g-1'];
  assert.equal(record.refresh, 'refresh-second', 'upsert 应当用最新一次登录的 refresh token 覆盖');
  assert.equal(record.google.clientId, 'client-g-1.apps.googleusercontent.com', '凭据落在 record.google 上');
  assert.equal(record.google.projectId, 'project-g-1', 'projectId 一并落库');
  assert.equal(record.state, 'ready', '重新登录后状态回到 ready');

  const listed = await invoke(h.ipc, CHANNELS.list);
  assert.equal(listed.value.accounts.length, 1, '列表里同样只有一条');

  const kinds = h.events.filter(event => event.payload.kind === 'accounts').map(event => event.payload.provider);
  assert.deepEqual(kinds, ['gemini', 'gemini'], '每次登录都要推 accounts 事件让列表刷新');
});

test('logging in a different gemini account adds a second record', async (t) => {
  const login = fakeLogin([okLogin('g-1'), okLogin('g-2')]);
  const h = await harness(t, { loginGemini: login });

  await invoke(h.ipc, CHANNELS.login, { provider: 'gemini' });
  await invoke(h.ipc, CHANNELS.login, { provider: 'gemini' });

  const stored = await readCredentialFile(h.dir);
  assert.deepEqual(
    Object.keys(stored.accounts).filter(key => key.startsWith('gemini:')).sort(),
    ['gemini:g-1', 'gemini:g-2'],
    '不同账号必须各占一条',
  );
  const listed = await invoke(h.ipc, CHANNELS.list);
  assert.deepEqual(listed.value.accounts.map(account => account.id).sort(), ['g-1', 'g-2'], '列表里两个账号都在');
});

test('a failed gemini login surfaces the login code instead of writing a record', async (t) => {
  const login = fakeLogin([{ ok: false, code: 'cli_missing', detail: '没有找到 CLI' }]);
  const h = await harness(t, { loginGemini: login });

  const result = await invoke(h.ipc, CHANNELS.login, { provider: 'gemini' });
  assert.equal(result.ok, false, '登录失败必须报错');
  assert.equal(result.error, 'cli_missing', '错误码取自登录实现');
  await assert.rejects(readCredentialFile(h.dir), '失败时不应写出凭据文件');
});

// ── 额度刷新 ────────────────────────────────────────────────────

test('refresh probes every gemini account and keeps the successful one when another rejects', async (t) => {
  const h = await harness(t, {
    probeGemini: fakeProbe(async (input) => {
      if (input.refreshToken === 'refresh-g-2-value') throw new Error('probe exploded');
      return usageSnapshot(30);
    }),
  });
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { projectId: 'p-1' }),
    geminiRecord('g-2', { projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(result.ok, true, '单账号探针抛错不应让整次刷新失败');
  assert.equal(result.value.updated, 1, '只有成功的那条计入 updated');
  assert.deepEqual(result.value.failed.map(item => item.id), ['g-2'], '失败账号要单独回报');
  assert.equal(result.value.failed[0].reason, 'probeFailed', '失败原因固定为 probeFailed');

  const stored = await readCredentialFile(h.dir);
  const good = stored.accounts['gemini:g-1'];
  const bad = stored.accounts['gemini:g-2'];
  assert.equal(good.usage.windows.length, 1, '成功的账号必须写入额度快照');
  assert.equal(good.usage.windows[0].usedPercent, 30, '额度数值来自探针');
  assert.equal(good.lastError, '', '成功账号不留 lastError');
  assert.equal(bad.usage.reason, 'probeFailed', '失败账号要留下 probeFailed 快照');
  assert.equal(bad.lastError, 'probeFailed', '失败账号要记 lastError');
  assert.equal(bad.state, 'ready', '额度读不到不等于登录失效，状态保持 ready');

  const listed = await invoke(h.ipc, CHANNELS.list);
  const byId = new Map(listed.value.accounts.map(account => [account.id, account]));
  assert.equal(byId.get('g-1').usage.windows.length, 1, '列表里成功账号带着额度');
  assert.equal(byId.get('g-2').usage.reason, 'probeFailed', '列表里失败账号带着原因');
});

test('refresh maps record.google and record.refresh into the gemini probe', async (t) => {
  const seen = [];
  const apiFetch = async (url, init = {}) => {
    const href = String(url);
    if (href === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init.body ?? ''));
      seen.push({
        refreshToken: body.get('refresh_token'),
        clientId: body.get('client_id'),
        clientSecret: body.get('client_secret'),
      });
      return jsonResponse({ access_token: `access-for-${body.get('refresh_token')}` });
    }
    if (href.includes('daily-cloudcode-pa.googleapis.com')) {
      // 每个账号的 access 不同 → 用不同的 usedPercent，证明额度写回了正确的记录。
      const access = String(init.headers?.authorization ?? '');
      const used = access.includes('refresh-g-1') ? 20 : 55;
      return jsonResponse({ buckets: [{ bucketId: 'gemini-2.5-pro', window: '5h', usedPercent: used }] });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  const h = await harness(t, { fetch: apiFetch });
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { projectId: 'p-1' }),
    geminiRecord('g-2', { projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(result.ok, true, '刷新应当成功');
  assert.equal(seen.length, 2, '两个账号各换一次 google access token');
  assert.deepEqual(
    seen.map(item => item.refreshToken).sort(),
    ['refresh-g-1-value', 'refresh-g-2-value'],
    '探针必须拿到各自的 refresh token',
  );
  assert.deepEqual(
    seen.map(item => item.clientSecret).sort(),
    ['secret-g-1-value', 'secret-g-2-value'],
    '探针必须拿到各自的 client_secret',
  );

  const stored = await readCredentialFile(h.dir);
  assert.equal(stored.accounts['gemini:g-1'].usage.windows[0].usedPercent, 20, 'g-1 的额度写到 g-1');
  assert.equal(stored.accounts['gemini:g-2'].usage.windows[0].usedPercent, 55, 'g-2 的额度写到 g-2');
});

test('refresh only probes the account named by accountId', async (t) => {
  const probe = fakeProbe(async () => usageSnapshot(42));
  const h = await harness(t, { probeGemini: probe });
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { projectId: 'p-1' }),
    geminiRecord('g-2', { projectId: 'p-2' }),
  ]);

  const result = await invoke(h.ipc, CHANNELS.refresh, { accountId: 'g-2' });
  assert.equal(result.ok, true, '按账号刷新应当成功');
  assert.deepEqual(probe.calls.map(call => call.refreshToken), ['refresh-g-2-value'], '只探针指定的那个账号');

  const stored = await readCredentialFile(h.dir);
  assert.equal(stored.accounts['gemini:g-2'].usage.windows[0].usedPercent, 42, '目标账号写入了额度');
  assert.equal(stored.accounts['gemini:g-1'].usage, undefined, '其它账号不应被顺手刷新');
});

test('an account without projectId reports noProject and is never retried', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [geminiRecord('g-no-project', { projectId: '' })]);

  const first = await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(first.ok, true, '缺 projectId 不是致命错误');
  const second = await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(second.ok, true, '再次刷新也不应报错');

  assert.deepEqual(h.fetchCalls, [], '缺 projectId 时探针不应发任何请求（不把它当失败重试）');
  const stored = await readCredentialFile(h.dir);
  const record = stored.accounts['gemini:g-no-project'];
  assert.equal(record.usage.reason, 'noProject', '原因必须是 noProject');
  assert.equal(record.lastError, '', 'noProject 不算失败，不写 lastError');
  assert.equal(record.state, 'ready', '账号仍然可用');
});

test('refresh caps concurrent gemini probes at three', async (t) => {
  let inflight = 0;
  let peak = 0;
  let calls = 0;
  const probe = async () => {
    calls += 1;
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    inflight -= 1;
    return usageSnapshot(10);
  };
  const h = await harness(t, { probeGemini: probe });
  await seedCredentialFile(h.dir, ['g-1', 'g-2', 'g-3', 'g-4', 'g-5'].map(id => geminiRecord(id, { projectId: `p-${id}` })));

  const result = await invoke(h.ipc, CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(result.ok, true, '五个账号一起刷新也应当成功');
  assert.equal(calls, 5, '每个账号各探针一次');
  assert.equal(peak, 3, '并发上限必须是 3');
  assert.equal(result.value.updated, 5, '五条都写入了额度');
});

// ── 选号与登出 ──────────────────────────────────────────────────

test('select marks the chosen gemini account active and pool.pick follows it', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { projectId: 'p-1' }),
    geminiRecord('g-2', { projectId: 'p-2' }),
  ]);

  const selected = await invoke(h.ipc, CHANNELS.select, { accountId: 'g-2' });
  assert.equal(selected.ok, true, '设为优先账号应当成功');
  assert.equal(selected.value.preferredAccountId, 'g-2', '设置里要落 preferredAccountId');

  const listed = await invoke(h.ipc, CHANNELS.list);
  const byId = new Map(listed.value.accounts.map(account => [account.id, account]));
  assert.equal(byId.get('g-2').active, true, '被选中的账号 active 为 true');
  assert.equal(byId.get('g-1').active, false, '另一个账号 active 为 false');

  const picked = await h.instance.service.pool.pick('gemini');
  assert.equal(picked.account.accountId, 'g-2', 'pool.pick 必须选到优先账号');
  assert.equal(picked.event.reason, 'preferred', '选号原因应为 preferred');
});

test('logout removes only the targeted gemini account', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { projectId: 'p-1' }),
    geminiRecord('g-2', { projectId: 'p-2' }),
  ]);

  const removed = await invoke(h.ipc, CHANNELS.logout, { accountId: 'g-1' });
  assert.equal(removed.ok, true, '登出应当成功');
  assert.equal(removed.value.provider, 'gemini', '回报的 provider 是 gemini');

  const stored = await readCredentialFile(h.dir);
  assert.deepEqual(
    Object.keys(stored.accounts).filter(key => key.startsWith('gemini:')),
    ['gemini:g-2'],
    '同 provider 的其它账号必须保留',
  );
  const listed = await invoke(h.ipc, CHANNELS.list);
  assert.deepEqual(listed.value.accounts.map(account => account.id), ['g-2'], '列表里只剩没被登出的那个');
  const picked = await h.instance.service.pool.pick('gemini');
  assert.equal(picked.account.accountId, 'g-2', '池子仍能选到剩下的账号');
});

test('logging out the preferred gemini account clears the preference', async (t) => {
  const h = await harness(t);
  await seedCredentialFile(h.dir, [
    geminiRecord('g-1', { projectId: 'p-1' }),
    geminiRecord('g-2', { projectId: 'p-2' }),
  ]);
  await invoke(h.ipc, CHANNELS.select, { accountId: 'g-1' });

  await invoke(h.ipc, CHANNELS.logout, { accountId: 'g-1' });

  const settings = await invoke(h.ipc, CHANNELS.settingsGet);
  assert.equal(settings.value.preferredAccountId, null, '优先账号被删后设置必须清空，不能指向不存在的账号');
  const listed = await invoke(h.ipc, CHANNELS.list);
  assert.equal(listed.value.accounts[0].id, 'g-2', '剩下的账号仍然在列表里');
});
