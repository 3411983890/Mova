/**
 * 负责：为 Linux 浏览器诊断会话提供单站 HTTPS 出口，固定到已校验的公网地址。
 * 不负责：通用浏览器代理、模型 VPN、私网或登录态。
 * 被谁调用：headless.mjs。
 */

import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { BlockList, connect } from 'node:net';

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) nonPublic.addSubnet(address, prefix, 'ipv4');

export function inspectUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new Error('需要使用默认端口、且不含账号密码的 HTTPS 网址');
  }
  return url;
}

function openTunnel(client, head, address) {
  const upstream = connect({ host: address, port: 443, family: 4 });
  upstream.setTimeout(30_000, () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  upstream.on('close', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.once('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
}

export async function startInspectProxy(url) {
  // 只用已检查的 IPv4 字面量建立连接，TLS 仍由 Chrome 验证原始主机名。
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(({ address }) => nonPublic.check(address, 'ipv4'))) {
    throw new Error('浏览器诊断只允许公网 IPv4 站点');
  }
  const expected = `${url.hostname.toLowerCase()}:443`;
  const sockets = new Set();
  const server = createServer((_req, res) => res.writeHead(403).end());
  server.maxConnections = 32;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client, head) => {
    // 子资源、重定向和弹窗也只可连接用户指定的主机。
    if (req.url.toLowerCase() !== expected) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    openTunnel(client, head, addresses[0].address);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    address: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
