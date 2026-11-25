import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCloudStore } from '../electron/services/cloud-store.mjs';
import { allowedConnect } from '../electron/services/cloud-model-proxy.mjs';
import { normalizeVpnBundle } from '../electron/services/cloud-vpn.mjs';
import { validPushToken } from '../electron/services/cloud-push.mjs';

test('重复提交只有一份回执，超期租约可恢复，取消后旧执行器不能覆盖结果', () => {
  let clock = 1000;
  const store = openCloudStore(':memory:', () => clock);
  try {
    const request = { id: 'receipt', prompt: '查找来源', provider: 'research', model: '' };
    const first = store.tasks.submit(request);
    assert.deepEqual(store.tasks.submit(request), first);
    assert.throws(() => store.tasks.submit({ ...request, prompt: '另一项任务' }), { code: 'conflict' });
    assert.equal(store.tasks.claim('first', 10).status, 'running');
    assert.equal(store.tasks.claim('second', 10), null);
    clock += 11;
    assert.equal(store.tasks.claim('second', 10).attempt, 2);
    assert.equal(store.tasks.change(first.id, 'cancelled').status, 'cancelled');
    assert.equal(store.tasks.change(first.id, 'done', { owner: 'first', result: '过期响应' }).result, null);
    assert.equal(store.tasks.change(first.id, 'done', { owner: 'second', result: '晚到响应' }).status, 'cancelled');
    const snapshot = store.snapshot();
    assert.deepEqual(store.snapshot(snapshot.cursor), { cursor: snapshot.cursor, unchanged: true });
    assert.equal(store.tasks.events(snapshot.cursor - 1).at(-1).data.status, 'cancelled');
    assert.equal(store.tasks.change(first.id, 'queued').attempt, 0);
  } finally { store.close(); }
});

test('一次性配对码会过期，设备撤销后令牌立即失效', () => {
  let clock = Date.now();
  const store = openCloudStore(':memory:', () => clock);
  try {
    const invite = store.devices.invite('client');
    const phone = store.devices.pair(invite.code, 'iPhone');
    assert.throws(() => store.devices.pair(invite.code, '另一部手机'), { code: 'invalid_pair' });
    assert.equal(store.devices.authenticate(phone.token).role, 'client');
    assert.ok(store.devices.revoke(phone.id));
    assert.ok(!store.devices.authenticate(phone.token));
    const expired = store.devices.invite('owner');
    clock = expired.expiresAt;
    assert.throws(() => store.devices.pair(expired.code, 'Windows'), { code: 'invalid_pair' });
  } finally { store.close(); }
});

test('订阅代理只放行指定供应商 TLS，Mihomo 不接受直连类型或公网监听', () => {
  assert.equal(allowedConnect('CONNECT auth.openai.com:443 HTTP/1.1', 'codex'), true);
  assert.equal(allowedConnect('CONNECT openai.com.test.invalid:443 HTTP/1.1', 'codex'), false);
  assert.equal(allowedConnect('CONNECT 127.0.0.1:443 HTTP/1.1', 'gemini'), false);
  const config = { proxies: [{ name: '节点', type: 'socks5' }], listeners: [{ port: 18042, listen: '0.0.0.0', proxy: '节点' }], rules: ['MATCH,DIRECT'] };
  assert.deepEqual(normalizeVpnBundle({ config }).config.rules, ['MATCH,REJECT']);
  assert.equal(normalizeVpnBundle({ config }).config.listeners[0].listen, '127.0.0.1');
  assert.throws(() => normalizeVpnBundle({ config: { ...config, proxies: [{ name: '节点', type: 'direct' }] } }), { code: 'vpn_config' });
});

test('只有注册通知的设备进入投递队列，撤销时删除排队通知', () => {
  const store = openCloudStore(':memory:');
  try {
    const phone = store.devices.pair(store.devices.invite('client').code, 'iPhone');
    const token = 'ExpoPushToken[fixture123456]';
    assert.ok(validPushToken(token));
    assert.ok(!validPushToken('other[fixture123456]'));
    store.push.set(phone.id, token);
    const task = store.tasks.submit({ id: 'push', prompt: '私密任务文本', provider: 'research', model: '' });
    store.tasks.claim('worker', 12_000);
    store.tasks.change(task.id, 'done', { owner: 'worker', result: '私密结果' });
    store.push.set(phone.id, token);
    assert.deepEqual({ ...store.push.next()[0] }, { seq: 1, taskId: task.id, status: 'done', attempt: 0, token });
    store.devices.revoke(phone.id);
    assert.deepEqual(store.push.next(), []);
  } finally { store.close(); }
});
