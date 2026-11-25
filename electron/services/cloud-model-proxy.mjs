/**
 * 负责：把隔离模型进程的 Unix 套接字接到明确选中的 Mihomo 入口。
 * 不负责：选择线路、TLS 解密或向浏览器提供代理。
 * 被谁调用：cloud-model-isolation.mjs。
 */

import { once } from 'node:events';
import { createServer, connect } from 'node:net';

const providerDomains = {
  codex: ['chatgpt.com', 'openai.com', 'oaistatic.com', 'auth0.com'],
  gemini: ['antigravity.google', 'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'google.dev'],
};

export function allowedConnect(line, provider) {
  const hostname = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/i.exec(line)?.[1]?.toLowerCase();
  return Boolean(hostname && providerDomains[provider]?.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)));
}

export async function startCloudModelProxy(path, upstream, provider) {
  const sockets = new Set();
  const server = createServer(client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(8000, () => client.destroy());
    let data = Buffer.alloc(0);
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0 && data.length < 8192) return;
      client.off('data', onData);
      const line = data.subarray(0, data.indexOf('\r\n')).toString('ascii');
      if (end < 0 || end >= 8192 || !allowedConnect(line, provider)) {
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      client.setTimeout(0);
      const remote = connect({ host: '127.0.0.1', port: Number(new URL(upstream).port) });
      client.on('close', () => remote.destroy());
      remote.on('error', () => client.destroy());
      remote.on('close', () => client.destroy());
      client.pause();
      remote.once('connect', () => { remote.write(data); client.pipe(remote).pipe(client); });
    };
    client.on('data', onData);
  });
  server.maxConnections = 32;
  server.listen(path);
  await once(server, 'listening');
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  };
}
