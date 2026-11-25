/**
 * CLI 模型设置页的演示数据（没有 Electron 桥接时用）。
 *
 * 负责：默认设置、模型目录后备值、以及「两个 ChatGPT 账号 + 一个 Gemini 账号」的
 * 演示快照——数字与 cli-models-settings.html 原型一致，时间相对 now 计算，倒计时是活的。
 * 不负责：任何 IPC（use-subscription.js）、任何文案换算（cli-models-view.js）。
 *
 * 只在 window.movaDesktop.subscription 缺失时被调用；页面根节点带 data-source="demo"，
 * 接上真实桥接后自动切到 IPC 数据。
 */

/** 设置项默认值：未写入存储时用它，保证控件都落在原型的位置上。 */
export const DEFAULT_SETTINGS = Object.freeze({
  autoSwitch: true,
  preferredAccountId: undefined,
  remindBelowPercent: null,
  refreshIntervalMins: 5,
  channel: 'chatgpt-plan',
  geminiRunner: 'acp',
  thinkingEffort: 'medium',
  imageInput: true,
  chatgptModel: '',
  geminiModel: '',
  cliPath: '',
  credentialStorage: '系统钥匙串（DPAPI）',
});

/** 模型目录后备值：真实清单来自 subscription:models，缺失时不让两个下拉变空。 */
export const DEFAULT_MODELS = Object.freeze({
  chatgpt: [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'gpt-5.6-luna · 272K 上下文 · 支持图片与推理强度' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'gpt-5.6-sol · 400K 上下文 · 支持图片与推理强度' },
    { id: 'gpt-5.1-mini', label: 'GPT-5.1 mini', note: 'gpt-5.1-mini · 128K 上下文 · 轻量任务优先' },
  ],
  gemini: [
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', note: 'gemini-3.1-pro · 1M 上下文 · 由 antigravity CLI 执行，工具调用走本机审批' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'gemini-3.8-flash · 1M 上下文 · 速度优先' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', note: 'gemini-3.1-flash-lite · 1M 上下文 · 最低成本' },
  ],
});

const pad = value => String(value).padStart(2, '0');

function atClock(now, hours, minutes) {
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

/** 下一个指定星期几的某个时刻（weekday 0 = 周日）。 */
function nextWeekdayAt(now, weekday, hours, minutes) {
  const date = new Date(now);
  const delta = (weekday - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + delta);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

export function demoSnapshot(now = Date.now()) {
  const later = minutes => now + minutes * 60_000;
  return {
    accounts: [
      {
        id: 'chatgpt-alice',
        provider: 'chatgpt',
        email: 'alice@example.com',
        plan: 'Plus',
        state: 'ready',
        active: true,
        lastUsedAt: atClock(now, 12, 40),
        usage: {
          checkedAt: now,
          windows: [
            { id: 'session', label: '5 小时窗口', usedPercent: 62, resetsAt: later(130) },
            { id: 'weekly', label: '每周窗口', usedPercent: 34, resetsAt: nextWeekdayAt(now, 0, 9, 0) },
          ],
        },
      },
      {
        id: 'chatgpt-bob',
        provider: 'chatgpt',
        email: 'bob@example.com',
        plan: 'Pro',
        state: 'limited',
        limitedUntil: later(192),
        usage: {
          checkedAt: now,
          windows: [
            { id: 'session', label: '5 小时窗口', usedPercent: 100, resetsAt: later(192) },
            { id: 'weekly', label: '每周窗口', usedPercent: 78, resetsAt: nextWeekdayAt(now, 0, 9, 0) },
          ],
        },
      },
      {
        id: 'gemini-alice',
        provider: 'gemini',
        email: 'alice@gmail.com',
        plan: 'AI Pro',
        state: 'ready',
        active: true,
        workspace: 'default',
        cli: { ready: true, version: '2.24.0' },
        usage: {
          checkedAt: now,
          windows: [
            { id: 'gemini-5h', label: 'Gemini 5 小时窗口', usedPercent: 41, resetsAt: later(106) },
            { id: 'weekly', label: 'Gemini 每周窗口', usedPercent: 66, resetsAt: nextWeekdayAt(now, 1, 8, 0) },
            { id: '3p-shared', label: '第三方模型额度', usedPercent: 12, resetsAt: nextWeekdayAt(now, 1, 8, 0) },
          ],
        },
      },
    ],
    settings: {
      ...DEFAULT_SETTINGS,
      preferredAccountId: 'chatgpt-alice',
      chatgptModel: 'gpt-5.6-luna',
      geminiModel: 'gemini-3.1-pro',
      cliPath: 'C:\\Users\\34119\\AppData\\Local\\Programs\\antigravity\\agy.exe',
    },
    models: DEFAULT_MODELS,
  };
}

/** 演示模式下登录成功后追加的账号（对应原型里的 carol@example.com）。 */
export function demoAccount(provider, now = Date.now()) {
  const suffix = `${pad(new Date(now).getHours())}${pad(new Date(now).getMinutes())}`;
  if (provider === 'gemini') {
    return {
      id: `gemini-demo-${suffix}`,
      provider: 'gemini',
      email: 'carol@gmail.com',
      plan: 'AI Pro',
      state: 'ready',
      active: false,
      workspace: 'default',
      cli: { ready: true, version: '2.24.0' },
      usage: {
        checkedAt: now,
        windows: [
          { id: 'gemini-5h', label: 'Gemini 5 小时窗口', usedPercent: 0, resetsAt: now + 5 * 3600_000 },
          { id: 'weekly', label: 'Gemini 每周窗口', usedPercent: 0, resetsAt: nextWeekdayAt(now, 1, 8, 0) },
        ],
      },
    };
  }
  return {
    id: `chatgpt-demo-${suffix}`,
    provider: 'chatgpt',
    email: 'carol@example.com',
    plan: 'Pro',
    state: 'ready',
    active: false,
    lastUsedAt: now,
    usage: {
      checkedAt: now,
      windows: [
        { id: 'session', label: '5 小时窗口', usedPercent: 0, resetsAt: now + 5 * 3600_000 },
        { id: 'weekly', label: '每周窗口', usedPercent: 0, resetsAt: nextWeekdayAt(now, 0, 9, 0) },
      ],
    },
  };
}
