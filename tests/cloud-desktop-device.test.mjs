/**
 * 负责：验证桌面设备适配器能配对、读写工作区和清理已撤销的本机凭据。
 * 被谁调用：Node 测试运行器。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import desktopModule from '../electron/cloud-device.cjs';
import { createProjectRecord } from '../src/features/projects/project-data.js';

const fakeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(Buffer.from(value, 'utf8').toString('base64')),
  decryptStringAsync: async value => Buffer.from(value.toString(), 'base64').toString('utf8'),
};

test('桌面 IPC 适配器持有授权，交给渲染端的结果不携带设备令牌', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mova-cloud-test-'));
  const id = 'fixture-device';
  const token = 'T'.repeat(32);
  let revoked = false;
  let lastAuthorization;
  const server = createServer((req, res) => {
    lastAuthorization = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/pair') return res.end(JSON.stringify({ id, name: 'Windows 桌面', role: 'owner', token }));
    if (revoked) { res.statusCode = 401; return res.end(JSON.stringify({ message: '已撤销' })); }
    return res.end(JSON.stringify({ cursor: 6, unchanged: true }));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = desktopModule.createDesktopCloud({ userData: directory, safeStorage: fakeStorage });
    assert.deepEqual(await call('pair', origin, { code: 'fixture' }), { id, role: 'owner', name: 'Windows 桌面' });
    const file = join(directory, 'cloud-device.bin');
    assert.ok(!(await readFile(file, 'utf8')).includes(token));
    assert.deepEqual(await call('snapshot', origin, { after: 6 }), { cursor: 6, unchanged: true });
    assert.equal(lastAuthorization, `Bearer ${token}`);
    revoked = true;
    assert.equal(await call('forget', origin), null);
    assert.equal(await call('session', origin), null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('原有配对可与新主机并存，自动 VPN 同步只发往授权主机且仅在配置变化时提交', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mova-cloud-hosts-'));
  const older = 'https://existing.example';
  const token = 'N'.repeat(32);
  const seen = [];
  let revision = 1;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, data: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/pair' ? { id: 'new-id', role: 'owner', token }
      : req.url === '/v1/session' ? { role: 'owner' }
        : req.url === '/v1/tasks' ? { id: 'task1', conversationId: 'conv1', status: 'queued' }
          : { running: true }));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(join(directory, 'cloud-device.bin'), await fakeStorage.encryptStringAsync(JSON.stringify({ origin: older, id: 'legacy', token: 'O'.repeat(32) })));
    const call = desktopModule.createDesktopCloud({ userData: directory, safeStorage: fakeStorage, exportVpn: async () => ({ revision }) });
    await call('pair', origin, { code: 'fixture', label: '云主机', provider: 'gemini' });
    const hosts = await call('hosts', '');
    assert.deepEqual(hosts.map(host => host.origin), [older, origin]);
    assert.ok(hosts.every(host => !('token' in host)));
    await call('submit', origin, { prompt: 'one' });
    assert.equal(seen.at(-1).data.provider, 'gemini');
    assert.equal(seen.some(row => row.path === '/v1/vpn'), false);
    await call('preferences', origin, { autoVpn: true });
    await call('submit', origin, { prompt: 'two' });
    revision += 1;
    await call('submit', origin, { prompt: 'three' });
    assert.deepEqual(seen.filter(row => row.path === '/v1/vpn').map(row => [row.auth, row.data.revision]), [[`Bearer ${token}`, 1], [`Bearer ${token}`, 2]]);
    await call('forget', origin, { localOnly: true });
    assert.deepEqual((await call('hosts', '')).map(host => host.origin), [older]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('远程项目保存所属主机地址并将本地目录排除在远程项目范围之外', () => {
  const sourceFolders = [{ name: '本机目录', path: 'C:\\Work' }];
  assert.equal(createProjectRecord('本机', { sourceFolders }).sourceFolders.length, 1);
  assert.deepEqual(createProjectRecord('远程', { cloudOrigin: 'https://mova.example/', cloudLabel: '云机', sourceFolders }), {
    name: '远程', chats: [], sourceFolders: [], memory: 'default', instructions: '', device: 'cloud', cloudOrigin: 'https://mova.example', cloudLabel: '云机',
  });
});

test('项目重试可从 API 转到已配对主机的新默认订阅，且保留原云会话', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mova-cloud-retry-'));
  const original = { id: 'old-task', conversationId: 'thread', provider: 'api', model: 'old-api-model', prompt: '继续研究', status: 'blocked', research: 1 };
  const submissions = [];
  const operations = [];
  const server = createServer(async (req, res) => {
    operations.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/tasks') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      submissions.push(body);
      return res.end(JSON.stringify({ ...body, status: 'queued' }));
    }
    if (req.method === 'GET' && req.url === '/v1/tasks/old-task') return res.end(JSON.stringify(original));
    if (req.method === 'POST' && req.url === '/v1/tasks/old-task/retry') return res.end(JSON.stringify({ ...original, status: 'queued' }));
    res.statusCode = 404;
    res.end('{}');
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(join(directory, 'cloud-device.bin'), await fakeStorage.encryptStringAsync(JSON.stringify({ origin, id: 'desktop', token: 'T'.repeat(32), provider: 'gemini' })));
    const call = desktopModule.createDesktopCloud({ userData: directory, safeStorage: fakeStorage });
    assert.equal((await call('retry', origin, { id: original.id })).provider, 'api');
    assert.deepEqual(operations, ['POST /v1/tasks/old-task/retry']);
    const request = { id: original.id, useHostDefault: true, replacementId: 'new-task' };
    const retry = await call('retry', origin, request);
    assert.deepEqual(retry, { id: 'new-task', provider: 'gemini', conversationId: 'thread', prompt: '继续研究', research: true, status: 'queued' });
    await call('retry', origin, request);
    assert.deepEqual(submissions[0], submissions[1]);
    assert.deepEqual(operations.slice(1), ['GET /v1/tasks/old-task', 'POST /v1/tasks', 'GET /v1/tasks/old-task', 'POST /v1/tasks']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
