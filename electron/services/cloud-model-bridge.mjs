/**
 * 负责：在隔离网络命名空间中启动供应商 CLI 和唯一的回环代理入口。
 * 不负责：读取模型数据或解释供应商协议通知。
 * 被谁调用：cloud-model-isolation.mjs 通过 bubblewrap。
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';

const [executable, ...args] = process.argv.slice(2);
const sockets = new Set();
const bridge = createServer(client => {
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => client.destroy());
  const remote = connect('/mova-proxy');
  client.on('close', () => remote.destroy());
  remote.on('error', () => client.destroy());
  remote.on('close', () => client.destroy());
  client.pipe(remote).pipe(client);
});

try {
  bridge.listen(18080, '127.0.0.1');
  await once(bridge, 'listening');
  const child = spawn(executable, args, { stdio: 'inherit' });
  const interrupt = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const [code] = await once(child, 'close');
  process.exitCode = code ?? 1;
} catch {
  process.stderr.write('无法启动隔离模型进程\n');
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  bridge.close();
}
