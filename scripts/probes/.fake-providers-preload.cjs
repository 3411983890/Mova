// 只用于截图验收的假桥接：把 window.movaDesktop.providers 换成一版可控数据，
// 让「模型」页能渲染出订阅 provider 的卡片（真实应用里由 electron/providers.cjs 提供）。
const { contextBridge } = require('electron');

const catalog = (entries) => entries.map(([id, name, efforts, vision]) => ({
  id, name, vision, efforts, contextWindow: 272000, maxTokens: 128000,
}));

const providers = [
  {
    id: 'subscription:chatgpt',
    kind: 'subscription',
    subscriptionProvider: 'chatgpt',
    name: 'ChatGPT',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    hasKey: false,
    editable: true,
    removable: false,
    configured: true,
    subscription: { provider: 'chatgpt', accounts: 1, email: 'alice@example.com' },
    models: catalog([
      ['gpt-5.6-luna', 'GPT-5.6 Luna', ['low', 'medium', 'high', 'xhigh', 'max'], true],
      ['gpt-5.6-sol', 'GPT-5.6 Sol', ['low', 'medium', 'high'], true],
      ['gpt-5.1-mini', 'GPT-5.1 mini', ['low', 'medium', 'high'], true],
    ]),
  },
  {
    id: 'subscription:gemini',
    kind: 'subscription',
    subscriptionProvider: 'gemini',
    name: 'Gemini',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    hasKey: false,
    editable: true,
    removable: false,
    configured: false,
    subscription: { provider: 'gemini', accounts: 0, email: null },
    models: catalog([
      ['gemini-3.1-pro', 'Gemini 3.1 Pro', ['low', 'medium', 'high'], true],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash', ['low', 'medium', 'high'], true],
      ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', [], true],
    ]),
  },
  {
    id: 'local',
    kind: undefined,
    name: '本地网关',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8788/v1',
    hasKey: true,
    models: catalog([
      ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', ['low', 'high', 'max'], true],
      ['deepseek-v4-pro', 'DeepSeek V4 Pro', ['high', 'max'], false],
    ]),
  },
];

const ok = value => ({ ok: true, value });

contextBridge.exposeInMainWorld('movaDesktop', {
  platform: 'win32',
  providers: {
    list: async () => ok({ providers, active: { providerId: 'local', modelId: 'deepseek-v4.1-flash' }, searchConfigured: false }),
    save: async () => ok({ providers, active: { providerId: 'local', modelId: 'deepseek-v4.1-flash' } }),
    saveSubscription: async input => ok({ provider: providers.find(item => item.subscriptionProvider === input?.target) ?? null }),
    fetchSubscription: async input => ok({
      models: providers.find(item => item.subscriptionProvider === input?.target)?.models ?? [],
      source: 'builtin',
      note: '订阅通道暂时无法枚举模型，已列出当前目录；可以手动添加模型。',
    }),
    fetch: async () => ok([]),
    defaults: async () => ok([]),
    setActive: async input => ok(input),
    remove: async () => ok({ providers, active: {} }),
  },
  subscription: { onEvent: () => () => {} },
});
