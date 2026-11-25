/**
 * 负责：云端主机显示选项和桌面 IPC 错误转换。
 * 被谁调用：工作位置选择器、设置页和项目会话。
 */
export const CLOUD_PROVIDERS = { codex: 'GPT 订阅', gemini: 'Gemini 订阅', api: 'API 模型', research: '联网研究' };
export const CLOUD_ORIGIN_STORAGE_KEY = 'mova.cloud.origin';
export const cloudProviderLabel = provider => Object.hasOwn(CLOUD_PROVIDERS, provider) ? CLOUD_PROVIDERS[provider] : '';
export function cloudTaskError(provider, message) {
  if (provider === 'api' && /配置 API 地址、密钥和模型/.test(message)) {
    return '此任务使用 API 模型，需要单独配置 API。若要用已登录的订阅，请切换到 GPT 订阅或 Gemini 订阅后重试。';
  }
  return message;
}

export async function desktopCloudCall(bridge, action, origin = '', input) {
  if (!bridge?.device) throw new Error('请在 Mova 桌面版连接远程主机');
  const result = await bridge.device(action, origin, input);
  if (!result.ok) throw Object.assign(new Error(result.message), { status: result.status, code: result.code });
  return result.value;
}
