/**
 * 负责：验证 Linux 浏览器诊断拒绝非 HTTPS 地址与非公网目标。
 * 不负责：在单测里启动浏览器或访问真实网页。
 * 被谁调用：node --test。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectUrl, startInspectProxy } from '../electron/browser/headless-network.mjs';

test('诊断网址使用 HTTPS 默认端口，且不能带用户名密码', () => {
  assert.equal(inspectUrl('https://example.com:443/path').origin, 'https://example.com');
  for (const value of ['http://example.com', 'file:///tmp/test.html', 'https://example.com:8443', 'https://user:pass@example.com']) {
    assert.throws(() => inspectUrl(value), /HTTPS/);
  }
});

test('诊断代理拒绝回环、私网和宿主元数据网段', async () => {
  for (const host of ['127.0.0.1', '2130706433', '10.0.1.2', '172.16.2.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '198.18.0.1']) {
    await assert.rejects(startInspectProxy(inspectUrl(`https://${host}`)), /公网 IPv4/);
  }
});
