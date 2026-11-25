/**
 * 脱敏的单元测试。
 *
 * 这层是「绝不把令牌写进日志」的唯一保证，所以断言写得比较狠：
 * 既要求凭据消失，也要求无关字段（尤其是数字）一根汗毛都不少。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskEmail, redact, redactString } from '../electron/logging/redact.mjs';

/** 一段合法的三段式 JWT（内容随便，结构要真）。 */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik1vdmEifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
/** > 80 字符的 base64url 串（带大写和数字，属于「长 token」而不是普通标识符）。 */
const LONG_B64 = `${'AbCdEf0123456789'.repeat(5)}xyz`;

test('http 头里的凭据整段替换，普通头原样保留', () => {
  const out = redact({
    method: 'GET',
    headers: {
      Authorization: 'Bearer abcdef123456',
      'x-api-key': 'key-987654321',
      cookie: 'session=abc; theme=dark',
      'set-cookie': 'session=abc; Path=/',
      'proxy-authorization': 'Basic dXNlcjpwYXNz',
      'content-type': 'application/json',
    },
  });
  const headers = out.headers;
  for (const key of ['Authorization', 'x-api-key', 'cookie', 'set-cookie', 'proxy-authorization']) {
    assert.match(headers[key], /^\[redacted(:\d+)?\]$/, `${key} 应该被整段替换`);
  }
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(out.method, 'GET');
});

test('文本里的 authorization/cookie 头行也被替换', () => {
  const out = redactString('POST /v1/chat\nAuthorization: Bearer abcdef123456\nCookie: sid=zzz123');
  assert.ok(!out.includes('abcdef123456'), 'Bearer 后面的值必须消失');
  assert.ok(!out.includes('sid=zzz123'), 'Cookie 的值必须消失');
  assert.match(out, /POST \/v1\/chat/);
  assert.match(out, /Authorization: \[redacted:\d+\]/);
});

test('URL 查询串里的 code/state/access_token 被替换，无关参数保留', () => {
  const url = 'https://example.com/cb?code=abc123&state=st456uvw&access_token=tok789&refresh_token=ref987&foo=1&page=2';
  const out = redact(url);
  for (const secret of ['abc123', 'st456uvw', 'tok789', 'ref987']) {
    assert.ok(!out.includes(secret), `${secret} 不该出现在脱敏结果里`);
  }
  assert.match(out, /foo=1/);
  assert.match(out, /page=2/);
  assert.match(out, /code=\[redacted:6\]/);
});

test('对象里的凭据键被替换，error.code 与业务 state 不受影响', () => {
  const out = redact({
    access_token: 'a1',
    refresh_token: 'r2',
    id_token: 'i3',
    api_key: 'k4',
    apikey: 'k5',
    password: 'p6',
    client_secret: 's7',
    error: { code: 'ECONNREFUSED', message: 'connect failed' },
    state: { page: 2 },
  });
  for (const key of ['access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'password', 'client_secret']) {
    assert.match(out[key], /^\[redacted(:\d+)?\]$/, `${key} 应该被替换`);
  }
  // 这两条是刻意的取舍：吃掉 error.code 等于让报错无法定位。
  assert.equal(out.error.code, 'ECONNREFUSED');
  assert.deepEqual(out.state, { page: 2 });
});

test('sk-/ghp_/xoxb- 形式的密钥被替换', () => {
  const cases = [
    `调用 key=sk-abcdefghijklmnopqrstuvwx 结束`.replace('key=', ''),
    `token ghp_${'a'.repeat(30)} 结束`,
    'token xoxb-1234567890-abcdefghij 结束',
  ];
  for (const text of cases) {
    const out = redact(text);
    assert.match(out, /\[redacted:\d+\]/, `没被替换：${text}`);
    assert.ok(!out.includes('sk-abcdef'), 'sk- 形式的密钥必须消失');
    assert.ok(!out.includes('ghp_aaa'), 'ghp_ 形式的密钥必须消失');
    assert.ok(!out.includes('xoxb-123'), 'xoxb- 形式的密钥必须消失');
  }
});

test('JWT 与超长 base64url 被替换成定长占位', () => {
  const out = redact(`bearer_jwt=${JWT}`);
  assert.ok(!out.includes('eyJhbGci'), 'JWT 不能被写进日志');
  assert.match(out, new RegExp(`\\[redacted:${JWT.length}\\]`));

  const longOut = redact(LONG_B64);
  assert.equal(longOut, `[redacted:${LONG_B64.length}]`);

  // 纯小写字母的长串多半是 hash/路径片段，不该被误伤。
  const lowercase = 'x'.repeat(90);
  assert.equal(redact(lowercase), lowercase);
});

test('字符串化 JSON 里的凭据字段也被替换', () => {
  const body = JSON.stringify({ user: 'u', password: 'hunter2', access_token: 'at123456', keep: 1 });
  const out = redact(`payload: ${body}`);
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('at123456'));
  assert.match(out, /"user":"u"/);
  assert.match(out, /"keep":1/);
});

test('数字与布尔字段原样通过（脱敏不能吃掉耗时/状态码）', () => {
  const input = { durationMs: 1234, statusCode: 200, ratio: 0.5, ok: true, count: 0, retries: -1 };
  assert.deepEqual(redact(input), input);
  // token 作为键时，数字也不该被替换：有些统计字段就叫 token。
  assert.equal(redact({ token: 128 }).token, 128);
});

test('maskEmail 只留本地部分前两位并保留域名', () => {
  assert.equal(maskEmail('alice@example.com'), 'al***@example.com');
  assert.equal(maskEmail('a@b.cn'), 'a***@b.cn');
  assert.equal(maskEmail('BOB.SMITH@corp.co.uk'), 'BO***@corp.co.uk');
  // 不是邮箱就不动，免得把普通字符串改得面目全非。
  assert.equal(maskEmail('not-an-email'), 'not-an-email');
  assert.equal(maskEmail(''), '');
});

test('字符串里的邮箱被截断，域名保留', () => {
  const out = redact('账号 alice@example.com 登录失败，备用 bob@corp.co.uk');
  assert.ok(!out.includes('alice@'), '完整本地部分不该留在日志里');
  assert.match(out, /al\*\*\*@example\.com/);
  assert.match(out, /bo\*\*\*@corp\.co\.uk/);
});

test('对象/循环引用/带 getter 的对象/Error 都不会让脱敏抛异常', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.deepEqual(redact(cyclic), { name: 'root', self: '[circular]' });

  const angry = {
    get boom() {
      throw new Error('getter exploded');
    },
    keep: 1,
  };
  assert.deepEqual(redact(angry), { boom: '[unserializable]', keep: 1 });

  const error = Object.assign(new Error('bad sk-abcdefghijklmnop'), { code: 'E_BAD' });
  const plain = redact(error);
  assert.equal(plain.name, 'Error');
  assert.equal(plain.code, 'E_BAD');
  assert.ok(!plain.message.includes('sk-abcdef'));
  assert.equal(plain.stack, undefined, 'Error 的 stack 不进普通字段');

  assert.equal(redact(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(redact(new Uint8Array(3)), '[binary:3]');
  assert.equal(redact(10n), '10');
});

test('脱敏是幂等的：不会把 [redacted:12] 再洗一遍', () => {
  const once = redact({ token: 'abcdef', url: `https://x/cb?code=abc&mail=a@b.co` });
  const twice = redact(once);
  assert.deepEqual(twice, once);
});

test('深层嵌套会被截断而不是无限递归', () => {
  let node = { value: 'leaf' };
  for (let i = 0; i < 20; i += 1) node = { child: node };
  const out = redact(node);
  assert.match(JSON.stringify(out), /depth-limit/);
});
