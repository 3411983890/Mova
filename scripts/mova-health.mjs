/**
 * 负责：把 CLI serve 的端口、退出信号和提示交给 Linux 云服务。
 * 不负责：处理 HTTP 路由或运行后台队列。
 * 被谁调用：scripts/mova.mjs 的 serve 命令。
 */

import { LOCAL_MOVA_ORIGIN } from '../src/services/cloud-connection.mjs';
import { startCloudService } from '../electron/services/cloud-api.mjs';

export async function serveHealth(portValue, signal) {
  const port = Number(portValue ?? new URL(LOCAL_MOVA_ORIGIN).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535 之间的整数');
  process.umask(0o077);
  const service = await startCloudService({ port, signal });
  try {
    if (!signal.aborted) {
      console.log(`Mova 服务 http://127.0.0.1:${port}`);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
  } finally {
    await service.close();
  }
}
