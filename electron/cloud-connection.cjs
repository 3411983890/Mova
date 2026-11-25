/**
 * 负责：验证从 Mova 设置页直连的 Linux 服务健康端点。
 * 不负责：认证、执行远程命令、设备配对和任务同步。
 * 被谁调用：electron/main.cjs 的 cloud:probe IPC 和测试。
 */

const { parseCloudOrigin, isMovaHealth, CLOUD_HEALTH_PATH, CLOUD_PROTOCOL_VERSION } = require('../src/services/cloud-connection.mjs');

const MAX_HEALTH_BYTES = 8192;

async function readHealth(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HEALTH_BYTES) return null;
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function probeCloudConnection(input, fetchImpl = globalThis.fetch) {
  let origin;
  try { origin = parseCloudOrigin(input); } catch (error) {
    return { ok: false, code: 'invalid_address', message: error.message };
  }
  const signal = AbortSignal.timeout(5000);
  try {
    const response = await fetchImpl(new URL(CLOUD_HEALTH_PATH, origin), {
      signal, redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, code: 'invalid_response', message: '服务未返回 Mova 健康状态。请检查地址和反向代理。' };
    }
    const payload = await readHealth(response);
    if (!isMovaHealth(payload)) {
      return { ok: false, code: 'not_mova', message: '收到响应，但未识别为 Mova 服务。' };
    }
    if (payload.protocolVersion !== CLOUD_PROTOCOL_VERSION) {
      return { ok: false, code: 'protocol_mismatch', message: '桌面端与 Linux 服务的协议版本不一致。请更新后再试。' };
    }
    return { ok: true, protocolVersion: payload.protocolVersion,
      ...(Array.isArray(payload.capabilities) ? { capabilities: payload.capabilities.filter(name => ['pairing', 'tasks', 'vpn'].includes(name)) } : {}) };
  } catch {
    return signal.aborted
      ? { ok: false, code: 'timeout', message: '连接超时。请确认 Linux 服务已启动，并检查网络。' }
      : { ok: false, code: 'unreachable', message: '无法连接服务器。请检查地址、网络和 HTTPS 证书。' };
  }
}

module.exports = { probeCloudConnection };
