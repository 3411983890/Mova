/**
 * ConPTY `/usage` 探针的可注入边界（方案 §3 §5.1 §5.2）。
 *
 * 这里**不**起任何真实进程：`openSession` 是假终端，时钟与节奏参数都传进去。
 * 重点断言三件事：失败有稳定错误码、需要人确认时**一个字节都不写**、同一账号 30s 内不重复探测。
 * 最后一组用例把探针接到 `subscription:refresh` 上，确认「接线」真的走新探针。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHANNELS } from '../electron/subscription/contract.mjs';
import { USAGE_CODES, probeGeminiCli } from '../electron/subscription/gemini-usage-cli.mjs';
import { createUsageProbeScheduler } from '../electron/subscription/gemini-usage-schedule.mjs';
import { installSubscriptionIpc } from '../electron/subscription/ipc.mjs';

const T0 = 1_794_601_170_000;

const PANEL = [
  '└ Models & Quota',
  '',
  '  Account:  bottarinathan780@gmail.com',
  '',
  'GEMINI MODELS',
  '     Weekly Limit Remaining  [ ████  ░░ ]  92.33%   Refreshes in 33h 18m',
  '     Five Hour Limit Remaining  [ ███  ░░ ]  82.33%   Refreshes in 1h 13m',
  '',
  'GEMINI 4 ARGON',
  '     Gemini 4 Argon Weekly Limit  [ █  ░░ ]  6.09%   Refreshes in 34h 1m',
].join('\r\n');

/**
 * 假伪终端：按顺序回放 chunk，记录所有写入。
 * 返回的 `state` 就是断言用的观察面（开了几次会话、写了什么、关了几次）。
 */
function createFakePty({ chunks = [], exitAfterMs = null, failOpen = false } = {}) {
  const state = { opens: 0, closes: 0, writes: [], exits: 0 };
  state.openSession = async (options) => {
    state.opens += 1;
    if (failOpen) throw new Error('spawn failed');
    const session = {
      write(text) { state.writes.push(text); },
      async close() { state.closes += 1; },
    };
    chunks.forEach((chunk, index) => {
      setTimeout(() => options.onData(chunk), index + 1);
    });
    if (exitAfterMs !== null) {
      setTimeout(() => {
        state.exits += 1;
        options.onExit({ code: 0 });
      }, exitAfterMs);
    }
    return session;
  };
  return state;
}

/** 安全红线：探针只允许写 `/usage` 与一个回车，绝不写确认/同意。 */
function assertOnlyUsageWrites(writes) {
  for (const text of writes) {
    assert.ok(
      text === '/usage' || text === '\r',
      `探针只允许写 /usage 和回车，实际写了 ${JSON.stringify(text)}`,
    );
  }
  for (const text of writes) {
    assert.equal(/^\s*(y|yes|ok|agree|accept|continue)\s*$/i.test(text), false, '绝不能替用户确认');
  }
}

const FAST = Object.freeze({ sendDelayMs: 0, settleMs: 10, fallbackSendMs: 20, timeoutMs: 120 });

test('CLI 不存在时立刻返回 usage_cli_missing，连会话都不开', async () => {
  const pty = createFakePty({ chunks: [PANEL] });
  const result = await probeGeminiCli({ command: '   ', openSession: pty.openSession, ...FAST });

  assert.equal(result.reason, 'probeFailed');
  assert.equal(result.detail, USAGE_CODES.cliMissing);
  assert.equal(result.status, 'cli_missing');
  assert.equal(pty.opens, 0, '没有可执行文件就不该起进程');
  assert.deepEqual(result.windows, []);
});

test('12s 内没出现面板就超时放弃，并且关掉会话', async () => {
  const pty = createFakePty({ chunks: [] });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 40 });

  assert.equal(result.detail, USAGE_CODES.timeout);
  assert.equal(result.status, 'timeout');
  assert.equal(pty.opens, 1);
  assert.equal(pty.closes, 1, '超时也必须收尾，否则残留 agy 会让后续 session/new 拿不到模型');
  assertOnlyUsageWrites(pty.writes);
});

test('进程正常退出但没有任何输出 → usage_parse_failed，而不是假装成功', async () => {
  const pty = createFakePty({ chunks: [], exitAfterMs: 5 });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 2_000 });

  assert.equal(result.detail, USAGE_CODES.parseFailed);
  assert.equal(result.status, 'exited');
  assert.equal(result.windows.length, 0);
  assert.equal(pty.closes, 1);
});

test('会话开不起来（spawn 失败）→ usage_probe_spawn_failed', async () => {
  const pty = createFakePty({ failOpen: true });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST });

  assert.equal(result.detail, USAGE_CODES.spawnFailed);
  assert.equal(result.status, 'spawn_failed');
});

test('首次向导（配色 / 条款）出现时立即放弃，且一个字节都不写', async () => {
  const pty = createFakePty({ chunks: ['Welcome to agy!\r\nChoose your color scheme\r\n'] });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 2_000 });

  assert.equal(result.detail, USAGE_CODES.onboarding);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(pty.writes, [], '安全红线：既不能发 /usage，更不能替用户按回车/同意');
  assert.equal(pty.closes, 1);
});

test('条款页出现时同样放弃，不会写入「已同意」的任何痕迹', async () => {
  const pty = createFakePty({ chunks: ['By continuing you accept the Terms of Service\r\n[Agree]  [Decline]\r\n'] });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 2_000 });

  assert.equal(result.detail, USAGE_CODES.onboarding);
  assert.deepEqual(pty.writes, []);
  assert.equal(JSON.stringify(result).includes('agree'), false, '结果里不得出现「已同意」类字段');
});

test('工作区信任确认出现时放弃本轮，返回 cli_trust_required', async () => {
  const pty = createFakePty({ chunks: ['Do you trust the files in this folder?\r\n> Yes\r\n  No\r\n'] });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 2_000 });

  assert.equal(result.detail, USAGE_CODES.trust);
  assert.deepEqual(pty.writes, [], '信任确认必须由人去终端点，探针不许代按');
});

test('停在 Signing in… / 未登录提示、且始终没有登录证据 → 归类 cli_not_logged_in', async () => {
  // 「Signing in...」本身是启动过渡帧，不能当场判死（真实 CLI 随后会自动登录成功）；
  // 但如果一直到超时都没有出现登录证据（邮箱/输入框），就必须明确报「没登录」，而不是笼统超时。
  const pty = createFakePty({ chunks: ['Signing in...\r\n'] });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 2_000 });
  assert.equal(result.detail, USAGE_CODES.notLoggedIn);

  const second = createFakePty({ chunks: ['You are not signed in. Run /login first.\r\n'] });
  const result2 = await probeGeminiCli({ command: 'agy.exe', openSession: second.openSession, ...FAST, timeoutMs: 2_000 });
  assert.equal(result2.detail, USAGE_CODES.notLoggedIn);
  // 仍然会按兜底时间点发 `/usage`（「未登录」不再是致命护栏，见 probe 文件头），
  // 但**安全红线不变**：整轮只可能出现这两个字节，绝不会往提示符里送 y / 回车确认。
  assertOnlyUsageWrites(second.writes);
});

test('先出现「not signed in」再出现邮箱：过渡帧不能吃掉这一轮', async () => {
  // 真实 agy 1.5.8 的启动序列就是「not signed in / Signing in...」→ 自动登录 → 邮箱 + 输入框。
  const pty = createFakePty({
    chunks: ['Welcome. You are currently not signed in.\r\n', ' Signing in...\r\n', '? for shortcuts', `\x1b[2J${PANEL}`],
  });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 2_000 });
  assert.equal(result.status, 'ok', '登录证据出现后必须继续抓面板');
  assert.equal(result.windows.length, 3);
});

test('就绪提示出现后发 `/usage` + 回车，抓到面板即返回 3 个窗口与真实邮箱', async () => {
  const pty = createFakePty({ chunks: ['\x1b[?25l', '? for shortcuts', `\x1b[2J${PANEL}`] });
  const result = await probeGeminiCli({ command: 'agy.exe', openSession: pty.openSession, ...FAST, timeoutMs: 2_000 });

  assert.equal(result.status, 'ok');
  assert.equal(result.reason, undefined);
  assert.equal(result.email, 'bottarinathan780@gmail.com');
  assert.equal(result.windows.length, 3);
  assert.deepEqual(pty.writes, ['/usage', '\r'], '只发一条斜杠命令，不夹带任何其它按键');
  assertOnlyUsageWrites(pty.writes);
  assert.equal(pty.closes, 1);
});

test('认不出就绪提示时也会在兜底时间点发出 `/usage`', async () => {
  const pty = createFakePty({ chunks: [PANEL] });
  const result = await probeGeminiCli({
    command: 'agy.exe', openSession: pty.openSession, sendDelayMs: 0, settleMs: 10, fallbackSendMs: 1, timeoutMs: 2_000,
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(pty.writes, ['/usage', '\r']);
});

test('面板底部出现 `esc Close` 后仍等一次 settle：TUI 会先画页脚再补窗口行', async () => {
  // 实测 agy 1.5.8：面板第一帧是「⣷ Loading quota summary…」+ 页脚，数据行随后才逐行补上。
  // 命中页脚就立刻收尾会拿到半张表（解析出 0 个窗口），所以现在只把 settle 窗口提前结束。
  const pty = createFakePty({ chunks: [`${PANEL}\r\n esc   Close`] });
  const started = Date.now();
  const result = await probeGeminiCli({
    command: 'agy.exe', openSession: pty.openSession, sendDelayMs: 0, settleMs: 120, fallbackSendMs: 1, timeoutMs: 5_000,
  });
  assert.equal(result.status, 'ok');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 100, `应当等一个 settle 窗口（约 120ms），实际 ${elapsed}ms`);
  assert.ok(elapsed < 1_500, `但不能等满 5s 超时，实际 ${elapsed}ms`);
});

test('调度器：同一账号 30s 内不重复探测，超过冷却窗才允许再探', async () => {
  let clock = T0;
  let calls = 0;
  const scheduler = createUsageProbeScheduler({ now: () => clock });
  const task = async () => { calls += 1; return { checkedAt: clock, windows: [{ id: 'gemini-5h' }] }; };

  const first = await scheduler.run('gemini-cli-local', task);
  assert.equal(first.skipped, null);
  assert.equal(calls, 1);

  clock = T0 + 29_999;
  const throttled = await scheduler.run('gemini-cli-local', task);
  assert.equal(throttled.skipped, 'throttled', '29.999s 内必须复用上次结果');
  assert.equal(calls, 1, '不能重复起进程');
  assert.equal(throttled.result.windows.length, 1, '节流时仍要把上次快照交回去');

  clock = T0 + 30_001;
  const again = await scheduler.run('gemini-cli-local', task);
  assert.equal(again.skipped, null);
  assert.equal(calls, 2);
});

test('调度器：并发调用只起一次进程（单飞），不同账号互不影响', async () => {
  let clock = T0;
  let calls = 0;
  const scheduler = createUsageProbeScheduler({ now: () => clock });
  const task = async () => {
    calls += 1;
    await new Promise(resolve => { setTimeout(resolve, 5); });
    return { checkedAt: clock, windows: [] };
  };

  const [a, b] = await Promise.all([
    scheduler.run('account-a', task),
    scheduler.run('account-a', task),
  ]);
  assert.equal(calls, 1, '同一个账号的并发请求必须共享一次探测');
  assert.ok(a.result && b.result, '两个调用方都要拿到结果');

  await scheduler.run('account-b', task);
  assert.equal(calls, 2, '不同账号可以各自探测');
});

test('调度器：失败后指数退避，退避窗内不再打进程', async () => {
  let clock = T0;
  let calls = 0;
  const scheduler = createUsageProbeScheduler({ now: () => clock });
  const failing = async () => { calls += 1; return { checkedAt: clock, windows: [], reason: 'probeFailed', detail: USAGE_CODES.timeout }; };

  await scheduler.run('acc', failing);
  assert.equal(calls, 1);
  assert.equal(scheduler.stats('acc').failures, 1);
  assert.equal(scheduler.stats('acc').retryAt, T0 + 60_000, '第一次失败退避 60s');

  clock = T0 + 30_000;
  const backedOff = await scheduler.run('acc', failing);
  assert.equal(backedOff.skipped, 'backoff');
  assert.equal(calls, 1, '退避窗内连冷却判断都不该走到');

  clock = T0 + 60_001;
  await scheduler.run('acc', failing);
  assert.equal(calls, 2);
  assert.equal(scheduler.stats('acc').retryAt, T0 + 60_001 + 120_000, '第二次失败退避翻倍');

  // 成功一次就清空退避，下一次立刻可探。
  clock = T0 + 400_000;
  await scheduler.run('acc', async () => { calls += 1; return { checkedAt: clock, windows: [{ id: 'gemini-5h' }] }; });
  assert.equal(scheduler.stats('acc').failures, 0);
  assert.equal(scheduler.stats('acc').retryAt, 0);
});

test('调度器 + 探针：30s 内连点两次只拉起一次会话', async () => {
  let clock = T0;
  const pty = createFakePty({ chunks: ['? for shortcuts', PANEL] });
  const scheduler = createUsageProbeScheduler({ now: () => clock });
  const run = () => scheduler.run('gemini-cli-local', () => probeGeminiCli({
    command: 'agy.exe', openSession: pty.openSession, sendDelayMs: 0, settleMs: 10, fallbackSendMs: 1, timeoutMs: 2_000,
  }));

  const first = await run();
  assert.equal(first.result.status, 'ok');
  assert.equal(pty.opens, 1);

  clock = T0 + 5_000;
  const second = await run();
  assert.equal(second.skipped, 'throttled');
  assert.equal(pty.opens, 1, '用户连点「刷新额度」也只起一次 agy');
});

// ---------------------------------------------------------------------------
// 接线：`subscription:refresh` 的 Gemini CLI 账号必须走新探针（方案 §6 的 ipc.mjs 一项）
// ---------------------------------------------------------------------------

/** 可逆 XOR 冒充 DPAPI（与 tests/subscription-ipc.test.mjs 同一套）。 */
function xor(value) {
  const bytes = Buffer.from(value);
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ 0x5a;
  return out;
}

function fakeSafeStorage() {
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(text) { return xor(Buffer.from(text, 'utf8')); },
    async decryptStringAsync(data) { return { shouldReEncrypt: false, result: xor(Buffer.from(data)).toString('utf8') }; },
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

/** 本机 CLI 托管账号的落盘记录：登录成功后就是这个形状（email 还是占位名）。 */
function cliRecord(overrides = {}) {
  return {
    type: 'cli',
    provider: 'gemini',
    accountId: 'gemini-cli-local',
    email: '本机 antigravity CLI',
    plan: 'Google AI Pro',
    state: 'ready',
    limitedUntil: 0,
    lastError: '',
    createdAt: T0 - 60_000,
    ...overrides,
  };
}

async function seedCliAccount(dir, record) {
  await writeFile(
    join(dir, 'subscriptions.enc'),
    xor(Buffer.from(JSON.stringify({ version: 1, accounts: { [`${record.provider}:${record.accountId}`]: record } }), 'utf8')),
  );
}

async function readStored(dir) {
  const raw = await readFile(join(dir, 'subscriptions.enc'));
  return JSON.parse(xor(raw).toString('utf8')).accounts;
}

async function harness(t, { probe, now = () => T0, record = cliRecord(), cliStatus, vpnEnvForModel, geminiCliTransport } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mova-gemini-usage-'));
  await seedCliAccount(dir, record);
  const ipc = fakeIpcMain();
  const instance = installSubscriptionIpc({
    ipcMain: ipc,
    app: { getPath: () => dir },
    shell: { openExternal: async () => true },
    safeStorage: fakeSafeStorage(),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    userDataDir: dir,
    fetch: async (url) => { throw new Error(`unexpected fetch ${url}`); },
    logger: { info() {}, warn() {} },
    getWindows: () => [],
    now,
    probeGeminiCli: probe,
    ...(cliStatus ? { cliStatus } : {}),
    ...(vpnEnvForModel ? { vpnEnvForModel } : {}),
    ...(geminiCliTransport ? { geminiCliTransport } : {}),
  });
  t.after(async () => {
    instance.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const invoke = async (channel, ...args) => {
    const listener = ipc.handlers.get(channel);
    assert.ok(listener, `通道 ${channel} 应已注册`);
    return listener({}, ...args);
  };
  return { dir, invoke };
}

test('subscription:refresh 的 CLI 托管账号走 `/usage` 探针，并把真实邮箱写回账号', async (t) => {
  let calls = 0;
  const { dir, invoke } = await harness(t, {
    probe: async () => {
      calls += 1;
      const parsed = await probeGeminiCli({
        command: 'agy.exe',
        openSession: createFakePty({ chunks: ['? for shortcuts', PANEL] }).openSession,
        sendDelayMs: 0,
        settleMs: 10,
        fallbackSendMs: 1,
        timeoutMs: 2_000,
      });
      return parsed;
    },
  });

  const result = await invoke(CHANNELS.refresh, { accountId: 'gemini-cli-local' });
  assert.equal(result.ok, true, '刷新应当成功');
  assert.equal(calls, 1, '必须真的调用注入的探针');

  const stored = (await readStored(dir))['gemini:gemini-cli-local'];
  assert.equal(stored.email, 'bottarinathan780@gmail.com', '占位名要被真实邮箱替换');
  assert.equal(stored.usage.windows.length, 3, '三个窗口都要落盘');
  assert.equal(stored.usage.windows.find(w => w.id === 'gemini-5h').usedPercent, 18);
  assert.equal(stored.usage.reason, undefined, '成功时不留 reason');
  assert.equal(stored.lastError, '', '成功刷新要清掉上次的 probeFailed');
  assert.equal(result.value.accounts.find(a => a.id === 'gemini-cli-local').email, 'bottarinathan780@gmail.com');
});

test('需要交互确认时只记录原因：不画进度条，也不把已登录账号判成 expired', async (t) => {
  const { dir, invoke } = await harness(t, {
    probe: async () => ({
      checkedAt: T0, windows: [], reason: 'probeFailed', detail: USAGE_CODES.onboarding, email: null, status: 'blocked', ms: 12,
    }),
  });

  const result = await invoke(CHANNELS.refresh, { accountId: 'gemini-cli-local' });
  assert.equal(result.ok, true, '探针失败不该让整个刷新通道报错');
  const stored = (await readStored(dir))['gemini:gemini-cli-local'];
  assert.deepEqual(stored.usage.windows, [], '读不到就没有窗口，界面因此不画假进度条');
  assert.equal(stored.usage.reason, 'probeFailed');
  assert.equal(stored.usage.detail, USAGE_CODES.onboarding);
  assert.equal(stored.state, 'ready', '向导没做完不等于登录过期');
  assert.equal(stored.email, '本机 antigravity CLI', '没读到邮箱就不要改邮箱');
});

test('同一账号 30s 内再点「刷新额度」不会重复起探针', async (t) => {
  let calls = 0;
  const { invoke } = await harness(t, {
    probe: async () => {
      calls += 1;
      return {
        checkedAt: T0, windows: [{ id: 'gemini-5h', label: 'Gemini · 5 小时窗口', usedPercent: 18 }],
        email: 'someone@example.com', status: 'ok', ms: 4_000,
      };
    },
  });

  await invoke(CHANNELS.refresh, { accountId: 'gemini-cli-local' });
  await invoke(CHANNELS.refresh, { accountId: 'gemini-cli-local' });
  assert.equal(calls, 1, '固定时钟下第二次刷新命中 30s 冷却');
});

test('noteGeminiRateLimit 把 429 的恢复时间写进快照与账号冷却', async (t) => {
  const { dir } = await harness(t, {
    record: cliRecord({
      usage: {
        checkedAt: T0 - 60_000,
        windows: [
          { id: 'gemini-5h', label: 'Gemini · 5 小时窗口', usedPercent: 100, windowDurationMins: 300 },
          { id: 'gemini-weekly', label: 'Gemini · 每周窗口', usedPercent: 71, windowDurationMins: 10080 },
        ],
      },
    }),
    // 回写之后的「主动校准」探针故意读不到（CLI 正被限流）：这样无论校准先完成还是后完成，
    // 落盘结果都只可能是「上一次快照 + 刚写进去的 resetsAt」，断言因此是确定的。
    probe: async () => ({
      checkedAt: T0, windows: [], reason: 'probeFailed', detail: USAGE_CODES.timeout, email: null, status: 'timeout', ms: 1,
    }),
  });

  // 拿 service 上的入口（ACP 侧就是这么调的：runtime 注册表 → service）。
  const service = (await import('../electron/subscription/runtime.mjs')).getSubscriptionRuntime();
  assert.ok(service && typeof service.noteGeminiRateLimit === 'function', 'service 上要暴露 noteGeminiRateLimit');

  const outcome = await service.noteGeminiRateLimit({
    accountId: 'gemini-cli-local',
    text: 'RESOURCE_EXHAUSTED: quota exceeded, retryDelay: "47s"',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.resetsAt, T0 + 47_000);

  // 等异步校准跑完，避免「读到一半」的竞态。
  await new Promise(resolve => { setTimeout(resolve, 30); });

  const stored = (await readStored(dir))['gemini:gemini-cli-local'];
  assert.equal(stored.usage.windows.find(w => w.id === 'gemini-5h').resetsAt, T0 + 47_000, '5h 窗口写上恢复时间');
  assert.equal(stored.usage.windows.find(w => w.id === 'gemini-weekly').resetsAt, undefined);
  assert.equal(stored.limitedUntil, T0 + 47_000, '账号同时进冷却');
});

// ── 回归：额度探针必须跟着 `subscription:gemini` 的线路走 ──────────────────
// 国内直连问 Google 必失败，表现就是「聊天在跑，额度永远额度未知」。对话链路已经按线路
// 分配了代理端口，探针不跟着走就会出现「同一个 CLI、同一个账号，一个通一个不通」。
// 注入的是默认探针内部的**传输层**（geminiCliTransport），所以「print 优先 + 代理环境变量」
// 这两层都还是真实代码——注入 probeGeminiCli 会整段换掉它们，那样就测不到这里了。
const okWindows = [{ id: 'gemini-weekly', label: 'Gemini · 每周窗口', usedPercent: 10, windowDurationMins: 10080 }];

test('额度探针把 Gemini 线路的代理环境变量交给子进程', async (t) => {
  const seen = [];
  const { invoke } = await harness(t, {
    // 指向一个不存在的可执行文件：print 路径会立刻失败，探针落到传输层上，
    // 于是「子进程拿到什么 env」这件事可以被确定地断言。
    cliStatus: async () => ({
      found: true, command: join(tmpdir(), 'no-such-agy.exe'), compatible: true, tried: [], version: { major: 1, minor: 5, patch: 9 },
    }),
    vpnEnvForModel: async () => ({ HTTPS_PROXY: 'http://127.0.0.1:17902', https_proxy: 'http://127.0.0.1:17902' }),
    geminiCliTransport: async options => {
      seen.push(options);
      return { checkedAt: T0, windows: okWindows, email: null, status: 'ok', ms: 1 };
    },
  });

  const result = await invoke(CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(result.ok, true, '刷新应当成功');
  assert.ok(seen.length >= 1, '应当真的跑了一次探针');
  assert.equal(seen[0].env?.HTTPS_PROXY, 'http://127.0.0.1:17902', '代理要传进子进程环境');
});

test('没分配线路时不注入 env（直连），探针照常工作', async (t) => {
  const seen = [];
  const { invoke } = await harness(t, {
    cliStatus: async () => ({
      found: true, command: join(tmpdir(), 'no-such-agy.exe'), compatible: true, tried: [],
    }),
    vpnEnvForModel: async () => null,
    geminiCliTransport: async options => {
      seen.push(options);
      return { checkedAt: T0, windows: okWindows, email: null, status: 'ok', ms: 1 };
    },
  });
  const result = await invoke(CHANNELS.refresh, { provider: 'gemini' });
  assert.equal(result.ok, true);
  assert.equal(seen[0].env, undefined, '没有线路时不许凭空造一个 env');
});
