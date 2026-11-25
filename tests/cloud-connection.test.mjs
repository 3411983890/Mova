/**
 * 负责：验证服务地址、探测协议和错误提示的边界。
 * 不负责：访问真实 Linux 机器或启动桌面窗口。
 * 被谁调用：node --test。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCloudOrigin } from '../src/services/cloud-connection.mjs';
import cloud from '../electron/cloud-connection.cjs';

const { probeCloudConnection } = cloud;
const target = 'https://mova.example.com:8443';
const healthy = { service: 'mova', status: 'ready', protocolVersion: 1 };

test('允许远端 HTTPS、本机 HTTP，拒绝凭据和远端明文地址', () => {
  assert.equal(parseCloudOrigin(`${target}/`), target);
  assert.equal(parseCloudOrigin('http://127.0.0.1:17642'), 'http://127.0.0.1:17642');
  for (const value of ['http://mova.example.com', 'https://user:secret@mova.example.com', `${target}/api`, `${target}?code=123`, 'file:///tmp/mova']) {
    assert.throws(() => parseCloudOrigin(value));
  }
});

test('只请求已输入服务的固定健康路径，按兼容协议报告可访问', async () => {
  const result = await probeCloudConnection(target, async (url, options) => {
    assert.equal(url.href, `${target}/v1/health`);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(healthy);
  });
  assert.deepEqual(result, { ok: true, protocolVersion: 1 });
});

test('拒绝重定向、通用网页、协议版本错位和超长响应', async () => {
  const probes = [
    [Response.redirect('https://example.com'), 'invalid_response'],
    [new Response('<html>Not a Mova service</html>'), 'not_mova'],
    [Response.json({ ...healthy, protocolVersion: 2 }), 'protocol_mismatch'],
    [Response.json({ ...healthy, extra: 'x'.repeat(8300) }), 'not_mova'],
  ];
  for (const [response, code] of probes) {
    const result = await probeCloudConnection(target, async () => response);
    assert.equal(result.code, code);
  }
});
