import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { redactSensitive, REDACTED } = require('../electron/services/memory-redaction.cjs');

function expectRedacted(input, kinds, forbidden) {
  const result = redactSensitive(input);
  assert.equal(result.redacted, true, input);
  assert.deepEqual(result.kinds, kinds, input);
  assert.ok(result.text.includes(REDACTED), input);
  for (const secret of forbidden) {
    assert.ok(!result.text.includes(secret), `${secret} leaked from ${input}`);
    assert.ok(!JSON.stringify(result).includes(secret), `${secret} leaked in result payload`);
  }
  return result;
}

test('redacts provider API keys: sk-, AKIA, ghp', () => {
  expectRedacted('sk-abcdefghijklmnopqrstuvwxyz012345', ['api-key'], ['abcdefghijklmnopqrstuvwxyz']);
  expectRedacted('key AKIAIOSFODNN7EXAMPLE here', ['api-key'], ['AKIAIOSFODNN7EXAMPLE']);
  expectRedacted('export GITHUB=ghp_abcdefghijklmnopqrstuvwxyz0123456789', ['api-key'], ['ghp_abcdefghijklmnopqrstuvwxyz']);
});

test('redacts Bearer tokens and keeps the scheme readable', () => {
  const result = expectRedacted(
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    ['bearer-token'],
    ['eyJhbGciOiJIUzI1NiJ9'],
  );
  assert.equal(result.text, `Authorization: Bearer ${REDACTED}`);
});

test('redacts complete and truncated PEM private keys', () => {
  const complete = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  expectRedacted(complete, ['private-key'], ['MIIEowIBAAKCAQEA']);
  const truncated = '-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA';
  expectRedacted(truncated, ['private-key'], ['MIIEowIBAAKCAQEA']);
});

test('redacts password assignments in Chinese and English', () => {
  expectRedacted('密码是 hunter2', ['password'], ['hunter2']);
  expectRedacted('密码：hunter2', ['password'], ['hunter2']);
  expectRedacted('password: hunter2', ['password'], ['hunter2']);
  expectRedacted('My password is hunter2.', ['password'], ['hunter2']);
  expectRedacted('password: "hunter2"', ['password'], ['hunter2']);
  expectRedacted('口令为 abc12345', ['password'], ['abc12345']);
});

test('redacts API key assignments', () => {
  expectRedacted('API key: abc', ['api-key'], ['abc']);
  expectRedacted('api_key=sk_live_abcdefghij', ['api-key'], ['sk_live_abcdefghij']);
  expectRedacted('API 密钥：abc123', ['api-key'], ['abc123']);
});

test('redacts Chinese ID card numbers with and without a label', () => {
  expectRedacted('身份证号 110101199003071234', ['id-card'], ['110101199003071234']);
  expectRedacted('我的身份证号码是110101199003071234。', ['id-card'], ['110101199003071234']);
  expectRedacted('110101199003071234', ['id-card'], ['110101199003071234']);
});

test('redacts bank cards with a label and Luhn-valid bare numbers', () => {
  expectRedacted('银行卡号：6222020200001234', ['bank-card'], ['6222020200001234']);
  expectRedacted('卡号 4111 1111 1111 1111', ['bank-card'], ['4111 1111 1111 1111']);
  expectRedacted('4111-1111-1111-1111', ['bank-card'], ['4111-1111-1111-1111']);
});

test('does not flag ordinary phrases without an actual value', () => {
  const safe = [
    '我用密码管理器保存密码',
    '密钥管理很重要',
    '密码长度至少 8 位',
    '密码：管理',
    'The password manager is installed',
    'API key rotation policy',
    'secret manager: enabled',
    'token 有效期 30 分钟',
    'Bearer token',
    '订单号 1234567890123456',
    '手机号 13800138000',
    '版本 2.1.0 已发布',
  ];
  for (const text of safe) {
    const result = redactSensitive(text);
    assert.equal(result.redacted, false, text);
    assert.deepEqual(result.kinds, [], text);
    assert.equal(result.text, text, text);
  }
});

test('does not flag 18-digit numbers that are not date-shaped ID numbers', () => {
  const result = redactSensitive('123456789012345678');
  assert.equal(result.redacted, false);
  assert.equal(result.text, '123456789012345678');
});

test('redaction is idempotent and leaves existing placeholders alone', () => {
  const once = redactSensitive('密码是 hunter2');
  const twice = redactSensitive(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.redacted, false);
  assert.deepEqual(twice.kinds, []);

  const placeholder = redactSensitive('token: [REDACTED]');
  assert.equal(placeholder.redacted, false);
  assert.equal(placeholder.text, 'token: [REDACTED]');
});

test('reports every kind once, sorted, for mixed input', () => {
  const result = redactSensitive('密码是 hunter2，API key: abc');
  assert.deepEqual(result.kinds, ['api-key', 'password']);
  assert.ok(!result.text.includes('hunter2'));
  assert.ok(!result.text.includes('abc'));
});

test('handles empty and non-string input without throwing', () => {
  assert.deepEqual(redactSensitive(''), { text: '', redacted: false, kinds: [] });
  assert.deepEqual(redactSensitive(null), { text: '', redacted: false, kinds: [] });
  assert.deepEqual(redactSensitive(undefined), { text: '', redacted: false, kinds: [] });
  assert.deepEqual(redactSensitive(123), { text: '123', redacted: false, kinds: [] });
});
