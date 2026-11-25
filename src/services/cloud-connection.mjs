/**
 * 负责：定义 Mova 服务检测地址、协议版本和桌面输入校验。
 * 不负责：HTTP 请求、网络监听、设备凭证或状态持久化。
 * 被谁调用：Windows 设置页、Electron 连接检测和 Linux CLI。
 */

export const LOCAL_MOVA_ORIGIN = 'http://127.0.0.1:17642';
export const CLOUD_HEALTH_PATH = '/v1/health';
export const CLOUD_PROTOCOL_VERSION = 1;
export const CLOUD_TASK_PROVIDERS = Object.freeze(['research', 'api', 'codex', 'gemini']);

export function parseCloudOrigin(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) {
    throw new Error('请输入 Mova 服务地址');
  }
  let url;
  try { url = new globalThis.URL(input.trim()); } catch { throw new Error('请输入完整地址，例如 https://mova.example.com'); }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) {
    throw new Error('云端地址须使用 HTTPS，本机地址可使用 HTTP');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('只填写服务地址和端口，凭据请在配对时处理');
  }
  return url.origin;
}

export function isMovaHealth(payload) {
  return payload?.service === 'mova' && payload.status === 'ready'
    && Number.isSafeInteger(payload.protocolVersion) && payload.protocolVersion > 0;
}
