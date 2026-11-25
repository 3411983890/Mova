import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SQL,
  VIEW_FIELDS,
  aadFor,
  createSubscriptionService,
} from '../electron/services/subscription-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = path.join(ROOT, 'electron', 'db', 'migrations', '006_subscription.sql');

const TENANT = 'tenant-acme';
const USER = 'user-ada';
const PROVIDER = 'chatgpt';
const ACCOUNT = 'acc-chatgpt-1';
const OTHER_ACCOUNT = 'acc-chatgpt-2';
const T0 = Date.UTC(2026, 10, 13, 10, 0, 0);
const DAY = 86_400_000;
// 故意用明显的占位串：夹具里不允许出现真实形态的令牌。
const RECORD = Object.freeze({
  type: 'oauth',
  provider: PROVIDER,
  accountId: ACCOUNT,
  access: 'test-access-placeholder',
  refresh: 'test-refresh-placeholder',
  idToken: 'test-idtoken-placeholder',
  expiresAt: T0 + 3600_000,
  email: 'ada@example.com',
  plan: 'plus',
});

const identity = (overrides = {}) => ({
  tenantId: TENANT,
  userId: USER,
  provider: PROVIDER,
  accountId: ACCOUNT,
  ...overrides,
});

const compact = sql => sql.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 假 PostgreSQL：按语句前缀分派，把 SQL 与参数都记下来。
 * 行形状刻意与 pg 的 snake_case 输出一致，这样服务层的字段映射也被顺带覆盖。
 */
function fakeDb() {
  const credentials = new Map();
  const events = [];
  const calls = [];
  let nextEventId = 1;
  const keyOf = (tenantId, userId, provider, accountId) => `${tenantId}|${userId}|${provider}|${accountId}`;

  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (query.failWith) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const text = compact(sql);

    if (text.startsWith('insert into subscription_credentials')) {
      const [tenantId, userId, provider, accountId, ciphertext, email, plan, expiresAt, createdAt] = params;
      const key = keyOf(tenantId, userId, provider, accountId);
      const existing = credentials.get(key);
      const row = {
        tenant_id: tenantId,
        user_id: userId,
        provider,
        account_id: accountId,
        ciphertext,
        email,
        plan,
        expires_at: expiresAt ?? null,
        created_at: existing ? existing.created_at : createdAt,
        last_used_at: existing ? existing.last_used_at : null,
      };
      credentials.set(key, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (text.startsWith('select ciphertext')) {
      const row = credentials.get(keyOf(...params));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (text.startsWith('select provider, account_id')) {
      const [tenantId, userId] = params;
      const rows = [...credentials.values()]
        .filter(row => row.tenant_id === tenantId && row.user_id === userId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))
          || a.provider.localeCompare(b.provider)
          || a.account_id.localeCompare(b.account_id))
        .map(row => ({
          provider: row.provider,
          account_id: row.account_id,
          email: row.email,
          plan: row.plan,
          expires_at: row.expires_at,
          created_at: row.created_at,
          last_used_at: row.last_used_at,
        }));
      return { rows, rowCount: rows.length };
    }

    if (text.startsWith('delete from subscription_credentials')) {
      const removed = credentials.delete(keyOf(...params));
      return { rows: [], rowCount: removed ? 1 : 0 };
    }

    if (text.startsWith('update subscription_credentials')) {
      const [tenantId, userId, provider, accountId, lastUsedAt] = params;
      const row = credentials.get(keyOf(tenantId, userId, provider, accountId));
      if (!row) return { rows: [], rowCount: 0 };
      row.last_used_at = lastUsedAt;
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (text.startsWith('insert into subscription_events')) {
      const [tenantId, userId, at, kind, provider, accountId, detail] = params;
      const row = {
        id: String(nextEventId++),
        tenant_id: tenantId,
        user_id: userId,
        at,
        kind,
        provider: provider ?? null,
        account_id: accountId ?? null,
        detail: JSON.parse(detail),
      };
      events.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (text.startsWith('select id, at, kind')) {
      const [tenantId, userId, limit] = params;
      const rows = events
        .filter(row => row.tenant_id === tenantId && row.user_id === userId)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)) || Number(b.id) - Number(a.id))
        .slice(0, limit);
      return { rows: rows.map(row => ({ ...row })), rowCount: rows.length };
    }

    if (text.startsWith('delete from subscription_events')) {
      const [before] = params;
      const kept = events.filter(row => String(row.at) >= String(before));
      const removed = events.length - kept.length;
      events.length = 0;
      events.push(...kept);
      return { rows: [], rowCount: removed };
    }

    throw new Error(`unexpected statement: ${sql}`);
  };

  query.calls = calls;
  query.credentials = credentials;
  query.events = events;
  query.failWith = false;
  return query;
}

/**
 * 假 cipher：把 AAD 一起存进「信封索引」，AAD 不同就模拟 GCM 认证失败。
 * 这样「换行密文必须解不开」的断言不依赖真实密钥，也能精确断言收到的 aad 字符串。
 */
function fakeCipher() {
  const envelopes = new Map();
  const encryptCalls = [];
  const decryptCalls = [];
  let counter = 0;
  const cipher = {
    async encrypt(plaintext, aad) {
      encryptCalls.push({ plaintext, aad });
      counter += 1;
      const payload = Buffer.from(`sealed-${counter}`, 'utf8');
      envelopes.set(payload.toString('base64'), { plaintext, aad });
      return payload;
    },
    async decrypt(payload, aad) {
      decryptCalls.push({ payload, aad });
      const envelope = envelopes.get(Buffer.from(payload).toString('base64'));
      if (!envelope) throw new Error('unknown envelope');
      if (envelope.aad !== aad) throw new Error('auth tag mismatch');
      return envelope.plaintext;
    },
  };
  cipher.encryptCalls = encryptCalls;
  cipher.decryptCalls = decryptCalls;
  return cipher;
}

/** 真 AES-256-GCM：用来证明 AAD 绑定在真实算法下同样成立（不是假 cipher 的一厢情愿）。 */
function realCipher(key) {
  return {
    encrypt(plaintext, aad) {
      const nonce = randomBytes(12);
      const enc = createCipheriv('aes-256-gcm', key, nonce);
      enc.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([enc.update(Buffer.from(plaintext, 'utf8')), enc.final()]);
      return Buffer.concat([nonce, enc.getAuthTag(), body]);
    },
    decrypt(payload, aad) {
      const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const dec = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      dec.setAAD(Buffer.from(aad, 'utf8'));
      dec.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([dec.update(buffer.subarray(28)), dec.final()]).toString('utf8');
    },
  };
}

function makeService({ db = fakeDb(), cipher = fakeCipher(), now = () => T0 } = {}) {
  // 服务只要 `{ query }`；假 db 本身是那个函数，这里包一层，便于测试直接查 calls/rows。
  const adapter = typeof db === 'function' ? { query: db } : db;
  return { service: createSubscriptionService({ db: adapter, cipher, now }), db, cipher };
}

const rejectsWith = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `期望 code=${code}，实际=${error?.code}`);
  return true;
});

const lastCall = db => db.calls[db.calls.length - 1];

// ---------------------------------------------------------------------------
// subscription_credentials 落库
// ---------------------------------------------------------------------------

test('putCredential upserts with a bytea ciphertext parameter', async () => {
  const { service, db, cipher } = makeService();
  await service.putCredential({ ...identity(), record: RECORD, email: 'ada@example.com', plan: 'plus' });

  const call = lastCall(db);
  assert.match(compact(call.sql), /on conflict \(tenant_id, user_id, provider, account_id\) do update/,
    'SQL 必须用四列主键做 upsert');
  assert.ok(Buffer.isBuffer(call.params[4]), 'ciphertext 参数必须是 Buffer（bytea）');
  assert.equal(call.params.length, 9, '参数个数必须与占位符一致');
  assert.equal(call.params[5], 'ada@example.com');
  assert.equal(call.params[6], 'plus');
  assert.equal(call.params[8], new Date(T0).toISOString(), 'created_at 用注入的 now');
  assert.equal(cipher.encryptCalls.length, 1);
});

test('putCredential keeps tokens out of every non-ciphertext column', async () => {
  const { service, db, cipher } = makeService();
  await service.putCredential({ ...identity(), record: RECORD });

  const call = lastCall(db);
  const plaintextColumns = call.params.filter((value, index) => index !== 4);
  const dumped = JSON.stringify(plaintextColumns);
  for (const secret of [RECORD.access, RECORD.refresh, RECORD.idToken]) {
    assert.ok(!dumped.includes(secret), '令牌只允许出现在密文参数里');
  }
  assert.equal(cipher.encryptCalls[0].plaintext.includes(RECORD.refresh), true,
    '令牌必须整体进入被加密的明文');
});

test('putCredential binds the AAD to tenant, user, provider and account', async () => {
  const { service, cipher } = makeService();
  await service.putCredential({ ...identity(), record: RECORD });

  assert.equal(aadFor(identity()), `${TENANT}|${USER}|${PROVIDER}|${ACCOUNT}`, 'AAD 必须是四段竖线拼接');
  assert.equal(cipher.encryptCalls[0].aad, `${TENANT}|${USER}|${PROVIDER}|${ACCOUNT}`);
});

test('putCredential returns a masked view without token fields', async () => {
  const { service } = makeService();
  const view = await service.putCredential({ ...identity(), record: RECORD, email: 'ada@example.com' });

  assert.deepEqual(Object.keys(view).sort(), [...VIEW_FIELDS].sort(), '返回值只能是白名单字段');
  assert.equal(view.accountId, ACCOUNT);
  assert.equal(view.createdAt, new Date(T0).toISOString());
  assert.ok(!JSON.stringify(view).includes(RECORD.access), '视图里不得出现 access');
});

test('putCredential rejects an empty or non-object record', async () => {
  const { service, db } = makeService();
  await rejectsWith(service.putCredential({ ...identity(), record: {} }), 'request');
  await rejectsWith(service.putCredential({ ...identity(), record: 'string' }), 'request');
  assert.equal(db.calls.length, 0, '参数不合法时不允许碰数据库');
});

// ---------------------------------------------------------------------------
// getCredential / AAD 越权
// ---------------------------------------------------------------------------

test('getCredential round-trips the record with the same AAD', async () => {
  const { service, cipher } = makeService();
  await service.putCredential({ ...identity(), record: RECORD, email: 'ada@example.com' });
  const got = await service.getCredential(identity());

  assert.deepEqual(got.record, RECORD, '同 AAD 必须解出原记录');
  assert.equal(got.email, 'ada@example.com', '明文列与记录一起返回');
  assert.equal(cipher.decryptCalls[0].aad, `${TENANT}|${USER}|${PROVIDER}|${ACCOUNT}`);
});

test('getCredential cannot decrypt a ciphertext moved to another account row', async () => {
  const { service, db } = makeService();
  await service.putCredential({ ...identity(), record: RECORD });
  await service.putCredential({ ...identity({ accountId: OTHER_ACCOUNT }), record: { ...RECORD, accountId: OTHER_ACCOUNT } });

  // 攻击模型：把 A 行的密文搬进 B 行（数据库层可写，应用层不可读）。
  const source = db.credentials.get(`${TENANT}|${USER}|${PROVIDER}|${ACCOUNT}`);
  const target = db.credentials.get(`${TENANT}|${USER}|${PROVIDER}|${OTHER_ACCOUNT}`);
  target.ciphertext = source.ciphertext;

  await rejectsWith(service.getCredential(identity({ accountId: OTHER_ACCOUNT })), 'credential');
});

test('getCredential fails the same way under a real AES-GCM cipher', async () => {
  const key = Buffer.alloc(32, 7);
  const { service, db } = makeService({ cipher: realCipher(key) });
  await service.putCredential({ ...identity(), record: RECORD });
  await service.putCredential({ ...identity({ accountId: OTHER_ACCOUNT }), record: { ...RECORD, accountId: OTHER_ACCOUNT } });

  assert.deepEqual((await service.getCredential(identity())).record, RECORD);

  const source = db.credentials.get(`${TENANT}|${USER}|${PROVIDER}|${ACCOUNT}`);
  const target = db.credentials.get(`${TENANT}|${USER}|${PROVIDER}|${OTHER_ACCOUNT}`);
  target.ciphertext = source.ciphertext;

  await rejectsWith(service.getCredential(identity({ accountId: OTHER_ACCOUNT })), 'credential');
});

test('getCredential returns null for an account that was never stored', async () => {
  const { service } = makeService();
  assert.equal(await service.getCredential(identity()), null);
});

test('getCredential refuses a record whose identity contradicts the row key', async () => {
  // 这个假 cipher 不校验 AAD，专门用来覆盖「AAD 之外」的那层身份核对。
  const envelopes = new Map();
  let counter = 0;
  const cipher = {
    encrypt(plaintext) {
      counter += 1;
      envelopes.set(`sealed-${counter}`, plaintext);
      return Buffer.from(`sealed-${counter}`, 'utf8');
    },
    decrypt(payload) {
      return envelopes.get(Buffer.from(payload).toString('utf8'));
    },
  };
  const { service } = makeService({ cipher });
  // 记录自带的 accountId 与请求不一致：AAD 能过（同一行），但这是跨账号搬运的迹象。
  await service.putCredential({ ...identity(), record: { ...RECORD, accountId: OTHER_ACCOUNT } });
  await rejectsWith(service.getCredential(identity()), 'forbidden');
});

// ---------------------------------------------------------------------------
// listCredentials 脱敏 / 租户隔离
// ---------------------------------------------------------------------------

test('listCredentials never exposes tokens or ciphertext', async () => {
  const { service } = makeService();
  await service.putCredential({ ...identity(), record: RECORD, email: 'ada@example.com' });
  const rows = await service.listCredentials({ tenantId: TENANT, userId: USER });

  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), [...VIEW_FIELDS].sort(), '脱敏视图只能有白名单字段');
  const dumped = JSON.stringify(rows);
  assert.ok(!dumped.includes('ciphertext'), '列表不允许带密文');
  for (const secret of [RECORD.access, RECORD.refresh, RECORD.idToken]) {
    assert.ok(!dumped.includes(secret), '列表不允许带令牌');
  }
  assert.match(compact(SQL.listCredentials), /select provider, account_id/);
});

test('every credential statement is scoped by tenant and user', async () => {
  const { service, db } = makeService();
  await service.putCredential({ ...identity(), record: RECORD });
  await service.listCredentials({ tenantId: TENANT, userId: USER });

  const statements = [SQL.selectCredential, SQL.listCredentials, SQL.deleteCredential, SQL.touchCredential];
  for (const sql of statements) {
    assert.match(compact(sql), /where tenant_id = \$1 and user_id = \$2/, '任何按账号查的路径都必须同时带租户与用户');
  }
  assert.equal(compact(SQL.listCredentials).includes('ciphertext'), false, '列表不查密文列');
  assert.match(compact(SQL.selectCredential), /where tenant_id = \$1 and user_id = \$2 and provider = \$3 and account_id = \$4/);
  assert.ok(!db.calls.some(call => /where\s+account_id\s*=/.test(compact(call.sql))), '不允许只按 account_id 查');
});

test('listCredentials separates tenants and users', async () => {
  const { service } = makeService();
  await service.putCredential({ ...identity(), record: RECORD });
  await service.putCredential({ ...identity({ tenantId: 'tenant-other' }), record: RECORD });
  await service.putCredential({ ...identity({ userId: 'user-other' }), record: RECORD });

  assert.equal((await service.listCredentials({ tenantId: TENANT, userId: USER })).length, 1);
  assert.equal((await service.listCredentials({ tenantId: 'tenant-other', userId: USER })).length, 1);
  assert.equal((await service.listCredentials({ tenantId: TENANT, userId: 'user-other' })).length, 1);
  assert.equal((await service.listCredentials({ tenantId: TENANT, userId: 'nobody' })).length, 0);
});

// ---------------------------------------------------------------------------
// delete / touch
// ---------------------------------------------------------------------------

test('deleteCredential binds tenant, user, provider and account', async () => {
  const { service, db } = makeService();
  await service.putCredential({ ...identity(), record: RECORD });
  await service.putCredential({ ...identity({ accountId: OTHER_ACCOUNT }), record: { ...RECORD, accountId: OTHER_ACCOUNT } });

  assert.equal(await service.deleteCredential(identity()), true);
  const call = lastCall(db);
  assert.deepEqual(call.params, [TENANT, USER, PROVIDER, ACCOUNT], '删除参数必须含租户、用户、provider 与账号');
  assert.match(compact(call.sql), /^delete from subscription_credentials where tenant_id = \$1 and user_id = \$2/);
  assert.equal(await service.deleteCredential(identity()), false, '重复删除返回 false');
  assert.equal((await service.listCredentials({ tenantId: TENANT, userId: USER })).length, 1, '只删目标账号');
});

test('touchCredential stamps last_used_at from the injected clock', async () => {
  const { service, db } = makeService();
  await service.putCredential({ ...identity(), record: RECORD });

  assert.equal(await service.touchCredential(identity()), true);
  assert.equal(lastCall(db).params[4], new Date(T0).toISOString());
  assert.equal((await service.listCredentials({ tenantId: TENANT, userId: USER }))[0].lastUsedAt, new Date(T0).toISOString());
  assert.equal(await service.touchCredential(identity({ accountId: 'missing' })), false);
});

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

test('recordEvent writes detail as JSON text and stamps at from now', async () => {
  const { service, db } = makeService();
  const event = await service.recordEvent({
    tenantId: TENANT,
    userId: USER,
    kind: 'tool_call',
    provider: PROVIDER,
    accountId: ACCOUNT,
    detail: { tool: 'fs.write', status: 'ok', retries: 0 },
  });

  const call = lastCall(db);
  assert.match(compact(call.sql), /^insert into subscription_events/);
  assert.equal(call.params[0], TENANT);
  assert.equal(call.params[1], USER);
  assert.equal(call.params[2], new Date(T0).toISOString(), 'at 用注入的 now');
  assert.equal(call.params[3], 'tool_call');
  assert.equal(typeof call.params[6], 'string', 'detail 必须以 JSON 字符串写库');
  assert.deepEqual(JSON.parse(call.params[6]), { tool: 'fs.write', status: 'ok', retries: 0 });
  assert.deepEqual(event.detail, { tool: 'fs.write', status: 'ok', retries: 0 });
  assert.equal(event.id, 1);
});

test('recordEvent defaults detail to an empty JSON object', async () => {
  const { service, db } = makeService();
  await service.recordEvent({ tenantId: TENANT, userId: USER, kind: 'login' });
  assert.equal(lastCall(db).params[6], '{}');
  assert.equal(lastCall(db).params[4], null, '可选的 provider 写 null 而不是空串');
});

test('recordEvent refuses token-shaped detail keys', async () => {
  const { service, db } = makeService();
  await rejectsWith(service.recordEvent({
    tenantId: TENANT,
    userId: USER,
    kind: 'login',
    detail: { access: 'test-access-placeholder' },
  }), 'request');
  await rejectsWith(service.recordEvent({
    tenantId: TENANT,
    userId: USER,
    kind: 'login',
    detail: { nested: { refresh_token: 'test-refresh-placeholder' } },
  }), 'request');
  assert.equal(db.calls.length, 0, '脏 detail 不允许落库');
});

test('listEvents passes the limit and maps rows to camelCase', async () => {
  const { service, db } = makeService();
  for (const kind of ['login', 'refresh', 'logout']) {
    await service.recordEvent({ tenantId: TENANT, userId: USER, kind, provider: PROVIDER, accountId: ACCOUNT, detail: { kind } });
  }
  await service.recordEvent({ tenantId: 'tenant-other', userId: USER, kind: 'login' });

  const rows = await service.listEvents({ tenantId: TENANT, userId: USER, limit: 2 });
  assert.equal(lastCall(db).params[2], 2, 'limit 必须作为第三个参数下发');
  assert.equal(rows.length, 2, 'limit 生效');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['accountId', 'at', 'detail', 'id', 'kind', 'provider']);
  assert.equal(rows[0].kind, 'logout', '按 at/id 倒序');
  assert.equal(rows[0].accountId, ACCOUNT);

  await rejectsWith(service.listEvents({ tenantId: TENANT, userId: USER, limit: 0 }), 'request');
  await rejectsWith(service.listEvents({ tenantId: TENANT, userId: USER, limit: 'x' }), 'request');
});

test('pruneEvents pins the 30-day boundary to the injected now', async () => {
  const { service, db } = makeService();
  db.events.push(
    { id: '1', tenant_id: TENANT, user_id: USER, at: new Date(T0 - 40 * DAY).toISOString(), kind: 'login' },
    { id: '2', tenant_id: TENANT, user_id: USER, at: new Date(T0 - 31 * DAY).toISOString(), kind: 'login' },
    { id: '3', tenant_id: TENANT, user_id: USER, at: new Date(T0 - 29 * DAY).toISOString(), kind: 'login' },
    { id: '4', tenant_id: 'tenant-other', user_id: 'user-other', at: new Date(T0 - 60 * DAY).toISOString(), kind: 'login' },
  );

  const result = await service.pruneEvents();
  const boundary = new Date(T0 - 30 * DAY).toISOString();
  assert.equal(boundary, '2026-10-14T10:00:00.000Z', '边界值 = now - 30*86400000');
  assert.equal(result.before, boundary);
  assert.deepEqual(lastCall(db).params, [boundary], '边界值作为唯一参数下发');
  assert.match(compact(lastCall(db).sql), /^delete from subscription_events where at < \$1/);
  assert.equal(result.deleted, 3, '跨租户按时间删，保留期内的一律不动');
  assert.deepEqual(db.events.map(row => row.id), ['3']);
});

test('pruneEvents honours a custom retention window', async () => {
  const { service, db } = makeService();
  db.events.push(
    { id: '1', tenant_id: TENANT, user_id: USER, at: new Date(T0 - 2 * DAY).toISOString(), kind: 'login' },
    { id: '2', tenant_id: TENANT, user_id: USER, at: new Date(T0 - DAY - 3600_000).toISOString(), kind: 'login' },
    { id: '3', tenant_id: TENANT, user_id: USER, at: new Date(T0).toISOString(), kind: 'login' },
  );
  const result = await service.pruneEvents({ olderThanDays: 1 });
  assert.equal(result.before, new Date(T0 - DAY).toISOString());
  assert.equal(result.deleted, 2);
  assert.deepEqual(db.events.map(row => row.id), ['3']);
  await rejectsWith(service.pruneEvents({ olderThanDays: -1 }), 'request');
});

// ---------------------------------------------------------------------------
// 参数与存储错误
// ---------------------------------------------------------------------------

test('missing tenantId or userId fails before touching the database', async () => {
  const { service, db } = makeService();
  const calls = [
    () => service.putCredential({ userId: USER, provider: PROVIDER, accountId: ACCOUNT, record: RECORD }),
    () => service.getCredential({ userId: USER, provider: PROVIDER, accountId: ACCOUNT }),
    () => service.listCredentials({ userId: USER }),
    () => service.deleteCredential({ userId: USER, provider: PROVIDER, accountId: ACCOUNT }),
    () => service.touchCredential({ userId: USER, provider: PROVIDER, accountId: ACCOUNT }),
    () => service.recordEvent({ userId: USER, kind: 'login' }),
    () => service.listEvents({ userId: USER }),
    () => service.listCredentials({ tenantId: '   ', userId: USER }),
    () => service.listCredentials({ tenantId: TENANT, userId: '' }),
  ];
  for (const call of calls) await rejectsWith(call(), 'request');
  assert.equal(db.calls.length, 0, '缺租户/用户时必须立即抛错，且不静默用空串');
});

test('storage failures surface as code credential with a storage detail', async () => {
  const { service, db } = makeService();
  db.failWith = true;
  await assert.rejects(service.listCredentials({ tenantId: TENANT, userId: USER }), error => {
    assert.equal(error.code, 'credential');
    assert.equal(error.detail, 'storage');
    assert.equal(error.cause?.code, 'ECONNREFUSED', '原始错误必须保留在 cause 里');
    return true;
  });
});

// ---------------------------------------------------------------------------
// migration 语法自检（本机没有 PostgreSQL，用正则锁住关键片段）
// ---------------------------------------------------------------------------

test('006_subscription.sql declares the three tables and their keys', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const flat = compact(sql);

  assert.equal((flat.match(/create table if not exists/g) ?? []).length, 3, '三张表都必须幂等创建');
  assert.match(flat, /create table if not exists subscription_credentials/);
  assert.match(flat, /create table if not exists subscription_flows/);
  assert.match(flat, /create table if not exists subscription_events/);
  assert.match(flat, /ciphertext bytea not null/, '密文列必须是 bytea');
  assert.match(flat, /primary key \(tenant_id, user_id, provider, account_id\)/, '凭据主键必须是四列');
  assert.match(flat, /flow_id text primary key/);
  assert.match(flat, /id bigserial primary key/);
  assert.match(flat, /detail jsonb not null default '\{\}'::jsonb/, 'detail 必须是 jsonb');
  assert.match(flat, /expires_at timestamptz not null/, '登录流程必须有过期时间');
});

test('006_subscription.sql ships the indexes the service relies on', () => {
  const flat = compact(readFileSync(MIGRATION, 'utf8'));

  assert.match(flat, /create index if not exists subscription_credentials_scope_idx on subscription_credentials \(tenant_id, user_id, created_at desc\)/, '按租户+用户查凭据');
  assert.match(flat, /create index if not exists subscription_events_scope_idx on subscription_events \(tenant_id, user_id, at desc, id desc\)/);
  assert.match(flat, /create index if not exists subscription_events_at_idx on subscription_events \(at\)/, '按 at 清理审计');
  assert.match(flat, /create index if not exists subscription_flows_expires_at_idx on subscription_flows \(expires_at\)/);
  assert.match(flat, /保留 30 天|30 days/, '注释里必须写明审计保留 30 天');
  assert.match(flat, /aad = tenant_id\|user_id\|provider\|account_id/, '注释里必须写明 AAD 的构造');
});

// ---------------------------------------------------------------------------
// subscription_flows（一次性 OAuth 登录流程）— 以下为追加用例，不改动上面的断言
// ---------------------------------------------------------------------------

const FLOW_ID = 'flow-1';
const FLOW_STATE = 'state-1';
const FLOW_VERIFIER = 'verifier-1';
const FLOW_TTL = 300_000;

/**
 * 假 PostgreSQL 的 flow 版本：按语句前缀分派，并把「行是否存在于本租户本用户」这件事
 * 真的实现出来——跨租户取不到必须由语句条件保证，而不是测试自己判。
 * `expires_at` 存 ISO 串，字符串比较就是时间比较（与 pg 的 timestamptz 语义等价）。
 */
function fakeFlowDb() {
  const flows = new Map();
  const calls = [];

  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (query.failWith) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const text = compact(sql);

    if (text.startsWith('insert into subscription_flows')) {
      const [flowId, tenantId, userId, provider, state, verifier, createdAt, expiresAt] = params;
      if (flows.has(flowId)) throw new Error('duplicate key value violates unique constraint');
      flows.set(flowId, {
        flow_id: flowId,
        tenant_id: tenantId,
        user_id: userId,
        provider,
        state,
        verifier: verifier ?? null,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.startsWith('select flow_id')) {
      const [tenantId, userId, flowId] = params;
      const row = flows.get(flowId);
      const hit = Boolean(row) && row.tenant_id === tenantId && row.user_id === userId;
      return { rows: hit ? [{ ...row }] : [], rowCount: hit ? 1 : 0 };
    }

    if (text.startsWith('delete from subscription_flows where tenant_id')) {
      const [tenantId, userId, flowId] = params;
      const row = flows.get(flowId);
      const hit = Boolean(row) && row.tenant_id === tenantId && row.user_id === userId;
      if (hit) flows.delete(flowId);
      return { rows: hit ? [{ ...row }] : [], rowCount: hit ? 1 : 0 };
    }

    if (text.startsWith('delete from subscription_flows where expires_at')) {
      const [boundary] = params;
      let removed = 0;
      for (const [id, row] of [...flows]) {
        if (String(row.expires_at) <= String(boundary)) {
          flows.delete(id);
          removed += 1;
        }
      }
      return { rows: [], rowCount: removed };
    }

    throw new Error(`unexpected statement: ${sql}`);
  };

  query.calls = calls;
  query.flows = flows;
  query.failWith = false;
  return query;
}

/** flow 版本的服务：时间可推进（过期边界），db 换成 fakeFlowDb。 */
function makeFlowService({ clock = { value: T0 } } = {}) {
  const db = fakeFlowDb();
  const service = createSubscriptionService({ db: { query: db }, cipher: fakeCipher(), now: () => clock.value });
  return { service, db, clock };
}

const flowInput = (overrides = {}) => ({
  tenantId: TENANT,
  userId: USER,
  provider: PROVIDER,
  state: FLOW_STATE,
  verifier: FLOW_VERIFIER,
  ...overrides,
});

test('createFlow stores flow_id, verifier and an expires_at derived from now + ttl', async () => {
  const { service, db } = makeFlowService();
  const created = await service.createFlow(flowInput());

  assert.deepEqual(Object.keys(created), ['flowId'], '对外只回 flowId');
  assert.match(created.flowId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'flowId 必须是 randomUUID() 的形态（不可猜测）');

  const call = lastCall(db);
  assert.match(compact(call.sql), /^insert into subscription_flows/);
  assert.equal(call.params.length, 8, '参数个数必须与占位符一致');
  assert.equal(call.params[0], created.flowId);
  assert.deepEqual(call.params.slice(1, 6), [TENANT, USER, PROVIDER, FLOW_STATE, FLOW_VERIFIER]);
  assert.equal(call.params[6], new Date(T0).toISOString(), 'created_at 用注入的 now');
  assert.equal(call.params[7], new Date(T0 + FLOW_TTL).toISOString(), '默认 ttl = 5 分钟');
  assert.equal(db.flows.size, 1, 'flow 必须真的落库');
});

test('createFlow honours ttlMs and rejects an unusable ttl', async () => {
  const { service, db, clock } = makeFlowService();
  await service.createFlow(flowInput({ ttlMs: 60_000 }));
  assert.equal(lastCall(db).params[7], new Date(T0 + 60_000).toISOString());

  // 注入 newFlowId：让 flowId 也可钉死（测试才能断言冲突分支）。
  const fixed = createSubscriptionService({
    db: { query: fakeFlowDb() },
    cipher: fakeCipher(),
    now: () => clock.value,
    newFlowId: () => 'flow-fixed',
  });
  assert.deepEqual(await fixed.createFlow(flowInput()), { flowId: 'flow-fixed' });

  for (const ttlMs of [0, -1, 1.5, 'soon', FLOW_TTL * 100]) {
    await rejectsWith(service.createFlow(flowInput({ ttlMs })), 'request');
  }
  await rejectsWith(fixed.createFlow({ userId: USER, provider: PROVIDER, state: FLOW_STATE }), 'request');
});

test('getFlow round-trips the row and turns null once expires_at is reached', async () => {
  const { service, clock } = makeFlowService();
  const { flowId } = await service.createFlow(flowInput());

  clock.value = T0 + FLOW_TTL - 1;
  const flow = await service.getFlow({ tenantId: TENANT, userId: USER, flowId });
  assert.deepEqual(Object.keys(flow).sort(),
    ['createdAt', 'expiresAt', 'flowId', 'provider', 'state', 'tenantId', 'userId', 'verifier'],
    'flow 一定要带 verifier（换 token 要用），且形状固定');
  assert.equal(flow.state, FLOW_STATE);
  assert.equal(flow.verifier, FLOW_VERIFIER);
  assert.equal(flow.expiresAt, new Date(T0 + FLOW_TTL).toISOString());

  clock.value = T0 + FLOW_TTL;
  assert.equal(await service.getFlow({ tenantId: TENANT, userId: USER, flowId }), null,
    '到期那一毫秒即不可用（fail closed）');
});

test('consumeFlow deletes the row and can only succeed once', async () => {
  const { service, db } = makeFlowService();
  const { flowId } = await service.createFlow(flowInput());

  const first = await service.consumeFlow({ tenantId: TENANT, userId: USER, flowId });
  assert.equal(first.flowId, flowId);
  assert.equal(first.verifier, FLOW_VERIFIER, '第一次取走必须拿到 verifier');
  assert.equal(db.flows.size, 0, 'consume 必须真的删除行（防重放）');

  assert.equal(await service.consumeFlow({ tenantId: TENANT, userId: USER, flowId }), null,
    '第二次必须拿不到（一次性）');
  assert.equal(await service.getFlow({ tenantId: TENANT, userId: USER, flowId }), null,
    'consume 之后 getFlow 也必须为空');
  assert.match(compact(SQL.consumeFlow), /^delete from subscription_flows where tenant_id = \$1 and user_id = \$2 and flow_id = \$3 returning/,
    'consumeFlow 必须是 delete ... returning（读删同一条语句）');
});

test('flows are invisible across tenants and users', async () => {
  const { service, db } = makeFlowService();
  const { flowId } = await service.createFlow(flowInput());

  for (const other of [{ tenantId: 'tenant-other', userId: USER }, { tenantId: TENANT, userId: 'user-other' }]) {
    assert.equal(await service.getFlow({ ...other, flowId }), null, '别人的 flow 读不到');
    assert.equal(await service.consumeFlow({ ...other, flowId }), null, '别人的 flow 也删不掉');
  }
  assert.equal(db.flows.size, 1, '越权尝试不得改动行');
  assert.equal((await service.getFlow({ tenantId: TENANT, userId: USER, flowId })).flowId, flowId);

  const statements = [SQL.insertFlow, SQL.selectFlow, SQL.consumeFlow];
  assert.match(compact(SQL.insertFlow), /tenant_id, user_id/, '落库必须带租户与用户');
  for (const sql of statements.slice(1)) {
    assert.match(compact(sql), /where tenant_id = \$1 and user_id = \$2/, '读写都必须同时带租户与用户');
  }
});

test('pruneFlows deletes exactly the expired rows at the injected boundary', async () => {
  const { service, db } = makeFlowService();
  const short = await service.createFlow(flowInput({ ttlMs: 60_000, state: 'state-short' }));
  const long = await service.createFlow(flowInput({ ttlMs: 600_000, state: 'state-long' }));

  const result = await service.pruneFlows();
  assert.equal(result.before, new Date(T0).toISOString(), '默认边界 = 注入的 now');
  assert.equal(result.deleted, 0, '都还没过期');
  assert.equal(db.flows.size, 2);

  // 边界恰好等于 expires_at 的必须被删（<=），毫秒级差一位的必须保留。
  const atBoundary = await service.pruneFlows({ now: T0 + 60_000 });
  assert.equal(atBoundary.before, new Date(T0 + 60_000).toISOString());
  assert.equal(atBoundary.deleted, 1);
  assert.equal(db.flows.has(short.flowId), false, '过期的那条被删掉');
  assert.equal(db.flows.has(long.flowId), true);

  await rejectsWith(service.pruneFlows({ now: 'not-a-time' }), 'request');
  assert.match(compact(SQL.pruneFlows), /^delete from subscription_flows where expires_at <= \$1/);
});

test('flow helpers reject missing tenant or user without touching the database', async () => {
  const { service, db } = makeFlowService();
  const calls = [
    () => service.createFlow({ userId: USER, provider: PROVIDER, state: FLOW_STATE }),
    () => service.createFlow({ ...flowInput(), tenantId: '   ' }),
    () => service.getFlow({ tenantId: TENANT, flowId: FLOW_ID }),
    () => service.consumeFlow({ userId: USER, flowId: FLOW_ID }),
    () => service.getFlow({ tenantId: TENANT, userId: USER }),
    () => service.consumeFlow({ tenantId: TENANT, userId: USER, flowId: '' }),
  ];
  for (const call of calls) await rejectsWith(call(), 'request');
  assert.equal(db.calls.length, 0, '缺租户/用户/flowId 时必须立即抛错');
});

test('flow storage failures surface as code credential', async () => {
  const { service, db } = makeFlowService();
  db.failWith = true;
  await rejectsWith(service.createFlow(flowInput()), 'credential');
  await rejectsWith(service.getFlow({ tenantId: TENANT, userId: USER, flowId: FLOW_ID }), 'credential');
  await rejectsWith(service.consumeFlow({ tenantId: TENANT, userId: USER, flowId: FLOW_ID }), 'credential');
  await rejectsWith(service.pruneFlows(), 'credential');
});
