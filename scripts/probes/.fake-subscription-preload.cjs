// 只为验收弹窗注入的假桥接：模拟「已连上桌面端、但本机没装 antigravity CLI」。
// 只用于 scripts/.verify-install-dialog.cjs，不参与打包。
const { contextBridge } = require('electron');

const snapshot = {
  accounts: [],
  settings: {
    autoSwitch: true,
    preferredAccountId: undefined,
    remindBelowPercent: null,
    refreshIntervalMins: 5,
    channel: 'chatgpt-plan',
    geminiRunner: 'acp',
    exposeToolsToCli: true,
  },
  models: {
    chatgpt: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: '272K 上下文' }],
    gemini: [{ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', note: '1M 上下文' }],
  },
  cli: {
    found: false,
    code: 'cli_missing',
    detail: '没有找到 antigravity CLI。',
    tried: ['C:/Users/me/AppData/Local/Programs/antigravity/agy.exe'],
  },
};

contextBridge.exposeInMainWorld('movaDesktop', {
  isMaximized: async () => false,
  // 窗口控制组件会订阅这个回调；缺失会在渲染层抛 TypeError，probe 的 console 就不干净了。
  onMaximizedChange: () => () => {},
  act: async () => ({ ok: true }),
  writeText: async () => ({ ok: true }),
  subscription: {
    list: async () => ({ ok: true, value: snapshot }),
    cliStatus: async () => ({ ok: true, value: snapshot.cli }),
    login: async () => ({ ok: false, error: 'cli_missing', message: '没有找到 antigravity CLI。' }),
    cancelLogin: async () => ({ ok: true, value: {} }),
    logout: async () => ({ ok: true, value: {} }),
    select: async () => ({ ok: true, value: {} }),
    refresh: async () => ({ ok: true, value: {} }),
    settingsGet: async () => ({ ok: true, value: snapshot.settings }),
    settingsSet: async () => ({ ok: true, value: {} }),
    models: async () => ({ ok: true, value: snapshot.models }),
    channelTest: async () => ({ ok: true, value: { status: 'ok' } }),
    pickCliPath: async () => ({ ok: false, error: 'request', message: 'probe 不支持' }),
    onEvent: () => () => {},
  },
});
