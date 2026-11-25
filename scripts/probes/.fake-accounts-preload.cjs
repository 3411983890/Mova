// 验收用假桥接：两个已登录账号（ChatGPT 有额度、Gemini 读不到额度），CLI 已就绪。
// 只为看「⋯ 菜单里有什么」以及额度条/文案，不参与打包。
const { contextBridge } = require('electron');

const now = Date.now();
const snapshot = {
  accounts: [
    {
      id: 'acct-chatgpt-1',
      provider: 'chatgpt',
      email: 'alice@example.com',
      plan: 'Plus',
      state: 'ready',
      active: true,
      lastUsedAt: now - 60_000,
      usage: {
        checkedAt: now - 30_000,
        stale: false,
        windows: [
          { id: 'session', label: '5 小时窗口', usedPercent: 62, resetsAt: now + 2 * 3600_000 },
          { id: 'weekly', label: '每周窗口', usedPercent: 34, resetsAt: now + 3 * 24 * 3600_000 },
        ],
      },
    },
    {
      id: 'acct-gemini-1',
      provider: 'gemini',
      email: 'alice@gmail.com',
      plan: 'AI Pro',
      state: 'ready',
      active: true,
      workspace: 'default',
      cli: { ready: true, version: '1.5.8' },
      usage: {
        checkedAt: now - 20_000,
        stale: false,
        reason: 'unsupported',
        windows: [
          { id: 'gemini-session', label: 'Gemini 5 小时窗口', usedPercent: 41, resetsAt: now + 3600_000 },
          { id: 'gemini-weekly', label: 'Gemini 每周窗口', usedPercent: 66, resetsAt: now + 4 * 24 * 3600_000 },
        ],
      },
    },
  ],
  settings: {
    autoSwitch: true,
    preferredAccountId: 'acct-chatgpt-1',
    remindBelowPercent: 10,
    refreshIntervalMins: 5,
    channel: 'chatgpt-plan',
    geminiRunner: 'acp',
    exposeToolsToCli: true,
    cliPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\antigravity\\agy.exe',
    credentialStorage: 'Windows DPAPI（系统钥匙串）',
  },
  models: {
    chatgpt: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: '272K 上下文' }],
    gemini: [{ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', note: '1M 上下文' }],
  },
  cli: {
    found: true,
    command: 'C:\\Users\\me\\AppData\\Local\\Programs\\antigravity\\agy.exe',
    args: ['acp'],
    version: { major: 1, minor: 5, step: 8 },
    compatible: true,
    source: 'auto',
  },
};

const ok = value => ({ ok: true, value });

contextBridge.exposeInMainWorld('movaDesktop', {
  isMaximized: async () => false,
  onMaximizedChange: () => () => {},
  act: async () => ({ ok: true }),
  writeText: async () => ({ ok: true }),
  subscription: {
    list: async () => ok(snapshot),
    cliStatus: async () => ok(snapshot.cli),
    login: async () => ok({ provider: 'chatgpt', state: 'waiting', flowId: 'flow-1' }),
    cancelLogin: async () => ok({ cancelled: true }),
    logout: async () => ok({}),
    select: async () => ok({}),
    refresh: async () => ok({ updated: snapshot.accounts.length, failed: [] }),
    settingsGet: async () => ok(snapshot.settings),
    settingsSet: async () => ok(snapshot.settings),
    models: async () => ok(snapshot.models),
    channelTest: async () => ok({ available: true, message: '通道可用' }),
    pickCliPath: async () => ok({ path: snapshot.cli.command }),
    onEvent: () => () => {},
  },
  providers: {
    list: async () => ok({
      providers: [
        {
          id: 'subscription:chatgpt', kind: 'subscription', subscriptionProvider: 'chatgpt',
          name: 'ChatGPT', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: false,
          configured: true, subscription: { provider: 'chatgpt', accounts: 1, email: 'alice@example.com' },
          models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vision: true, efforts: ['low', 'medium', 'high'], contextWindow: 272000, maxTokens: 128000 }],
        },
        {
          id: 'subscription:gemini', kind: 'subscription', subscriptionProvider: 'gemini',
          name: 'Gemini', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: false,
          configured: true, subscription: { provider: 'gemini', accounts: 1, email: 'alice@gmail.com' },
          models: [{ id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', vision: true, efforts: ['low', 'medium', 'high'], contextWindow: 1000000, maxTokens: 65536 }],
        },
      ],
      active: { providerId: 'subscription:chatgpt', modelId: 'gpt-5.6-luna' },
    }),
    save: async () => ok({}),
    saveSubscription: async () => ok({}),
    fetchSubscription: async () => ok({ models: [], source: 'builtin', note: '' }),
    fetch: async () => ok([]),
    defaults: async () => ok([]),
    setActive: async input => ok(input),
    remove: async () => ok({}),
  },
});
