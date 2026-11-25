import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountStore } from '../electron/subscription/store.mjs';

const DIR = 'C:\\fixture\\userData';

/** 内存文件系统：所有 IO 注入，测试不碰真实磁盘。 */
function memoryFs({ failWrite } = {}) {
  const files = new Map();
  const writes = [];
  const removals = [];
  const renames = [];
  return {
    files,
    writes,
    removals,
    renames,
    readFile: async path => {
      const key = String(path);
      if (!files.has(key)) {
        const error = new Error('ENOENT: no such file');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(key);
    },
    writeFile: async (path, data, options) => {
      writes.push({ path: String(path), data, options });
      if (typeof failWrite === 'function' && failWrite(String(path))) {
        const error = new Error('EIO: disk full');
        error.code = 'EIO';
        throw error;
      }
      files.set(String(path), data);
    },
    rename: async (from, to) => {
      const key = String(from);
      if (!files.has(key)) throw new Error('ENOENT: rename source missing');
      files.set(String(to), files.get(key));
      files.delete(key);
      renames.push({ from: String(from), to: String(to) });
    },
    mkdir: async () => {},
    rm: async path => {
      removals.push(String(path));
      files.delete(String(path));
    },
  };
}

function fakeSafeStorage() {
  return {
    encrypt: async text => Buffer.from(`enc\u0000${text}`, 'utf8'),
    decrypt: async data => {
      const text = Buffer.from(data).toString('utf8');
      if (!text.startsWith('enc\u0000')) throw new Error('bad payload');
      return text.slice(4);
    },
  };
}

function setup(options = {}) {
  const fs = memoryFs(options);
  const store = createAccountStore({ dir: DIR, ...fakeSafeStorage(), ...fs, now: () => 1_000 });
  return { store, fs };
}

const baseRecord = {
  type: 'oauth',
  access: 'access-value-do-not-print',
  refresh: 'refresh-value-do-not-print',
  idToken: 'id-token-value',
  email: 'a@example.com',
  plan: 'plus',
  state: 'ready',
  expiresAt: 9_000,
  createdAt: 1_000,
};

test('list() drops every token field and keeps only the account view', async () => {
  const { store } = setup();
  await store.upsert('chatgpt', { ...baseRecord, accountId: 'acct_a' });
  const accounts = await store.list('chatgpt');
  assert.equal(accounts.length, 1, '应该只列出 chatgpt 的一个账号');
  assert.deepEqual(
    Object.keys(accounts[0]).sort(),
    ['accountId', 'createdAt', 'email', 'expiresAt', 'plan', 'provider', 'state'],
    '对外视图只能有白名单字段',
  );
  for (const secret of ['access', 'refresh', 'idToken']) {
    assert.equal(secret in accounts[0], false, `${secret} 不得出现在对外视图里`);
  }
  assert.equal(accounts[0].accountId, 'acct_a', '账号 id 必须保留');
});

test('read() still returns the credential material for the main process', async () => {
  const { store } = setup();
  await store.upsert('chatgpt', { ...baseRecord, accountId: 'acct_a' });
  const record = await store.read('chatgpt', 'acct_a');
  assert.equal(record.access, baseRecord.access, '主进程读得到 access token');
  assert.equal(record.refresh, baseRecord.refresh, '主进程读得到 refresh token');
  assert.equal(await store.read('gemini', 'acct_a'), null, '跨 provider 不能读到别人的记录');
});

test('a failed write leaves no temp file and no half-written account file', async () => {
  const { store, fs } = setup({ failWrite: path => path.endsWith('.tmp') });
  await assert.rejects(
    () => store.upsert('chatgpt', { ...baseRecord, accountId: 'acct_a' }),
    error => error.code === 'credential',
    '写失败必须收敛成 credential',
  );
  const file = store.__testing.path;
  assert.equal(fs.files.size, 0, '失败后不应留下任何文件（含 .tmp）');
  assert.equal(fs.files.has(file), false, '目标文件必须是原子的，不能是半截');
  assert.equal(fs.renames.length, 0, '写失败不应发生 rename');
  assert.equal(fs.removals.length, 1, '临时文件必须被清理');
  assert.match(fs.removals[0], /\.tmp$/, '清理的应该是临时文件');
  for (const write of fs.writes) assert.match(write.path, /\.tmp$/, '只能先写临时文件');
});

test('concurrent modify() calls never lose an update', async () => {
  const { store } = setup();
  await store.upsert('chatgpt', { accountId: 'acct_a', state: 'ready', count: 0 });
  await Promise.all(Array.from({ length: 12 }, () => store.modify('chatgpt', 'acct_a', record => ({
    ...record,
    count: record.count + 1,
  }))));
  const record = await store.read('chatgpt', 'acct_a');
  assert.equal(record.count, 12, '12 次并发自增必须全部生效（串行写链）');
});

test('a corrupt file throws credential and is never silently emptied', async () => {
  const { store, fs } = setup();
  const file = store.__testing.path;
  const corrupt = Buffer.from('enc\u0000{"version":1,"accounts":', 'utf8');
  fs.files.set(file, corrupt);
  await assert.rejects(() => store.list('chatgpt'), error => error.code === 'credential', 'JSON 坏了要报 credential');
  assert.deepEqual(fs.files.get(file), corrupt, '损坏文件必须原样保留，便于诊断/人工恢复');
  assert.equal(fs.removals.length, 0, '不得删文件');
});

test('a decrypt failure throws credential instead of returning an empty list', async () => {
  const { store, fs } = setup();
  fs.files.set(store.__testing.path, Buffer.from('not-encrypted', 'utf8'));
  await assert.rejects(() => store.list('chatgpt'), error => error.code === 'credential', '解密失败必须报 credential');
});

test('remove() deletes one account and reports whether anything was deleted', async () => {
  const { store } = setup();
  await store.upsert('chatgpt', { ...baseRecord, accountId: 'acct_a' });
  await store.upsert('gemini', { ...baseRecord, accountId: 'acct_g' });
  assert.equal(await store.remove('chatgpt', 'acct_a'), true, '删除已存在的账号返回 true');
  assert.equal(await store.remove('chatgpt', 'acct_a'), false, '重复删除返回 false');
  assert.deepEqual(await store.list('chatgpt'), [], 'chatgpt 池子已空');
  assert.equal((await store.list('gemini')).length, 1, '删除必须按 provider 隔离');
});

test('modify() with null deletes and with undefined skips the write', async () => {
  const { store, fs } = setup();
  await store.upsert('chatgpt', { ...baseRecord, accountId: 'acct_a' });
  await store.upsert('gemini', { ...baseRecord, accountId: 'acct_g' });
  const before = fs.writes.length;
  await store.modify('chatgpt', 'acct_a', () => undefined);
  assert.equal(fs.writes.length, before, '返回 undefined 表示不改，不应写盘');
  const removed = await store.modify('chatgpt', 'acct_a', () => null);
  assert.equal(removed, null, '返回 null 表示删除');
  assert.equal(await store.read('chatgpt', 'acct_a'), null, '记录确实被删掉了');
  assert.equal((await store.list('gemini')).length, 1, '别的 provider 不受影响');
});

test('writes use a unique temp file created exclusively with 0600', async () => {
  const { store, fs } = setup();
  await store.upsert('chatgpt', { ...baseRecord, accountId: 'acct_a' });
  await store.upsert('chatgpt', { ...baseRecord, accountId: 'acct_b' });
  assert.equal(fs.writes.length, 2, '两次 upsert 各写一次');
  for (const write of fs.writes) {
    assert.deepEqual(write.options, { flag: 'wx', mode: 0o600 }, '临时文件必须以 wx + 0600 创建');
  }
  assert.notEqual(fs.writes[0].path, fs.writes[1].path, '临时文件名不能复用');
  assert.equal(fs.files.has(store.__testing.path), true, '最终数据要落到 subscriptions.enc');
});

test('upsert() keeps createdAt stable and rejects unknown providers', async () => {
  const { store } = setup();
  await store.upsert('chatgpt', { ...baseRecord, createdAt: 777, accountId: 'acct_a' });
  const updated = await store.upsert('chatgpt', { accountId: 'acct_a', state: 'expired' });
  assert.equal(updated.createdAt, 777, '重复 upsert 不能重置创建时间');
  assert.equal(updated.state, 'expired', '新字段要覆盖旧值');
  assert.equal(updated.provider, 'chatgpt', 'provider 由参数钉住');
  await assert.rejects(() => store.upsert('anthropic', { accountId: 'x' }), error => error.code === 'request', '未知 provider 必须报 request');
  await assert.rejects(() => store.list('anthropic'), error => error.code === 'request', '未知 provider 列表也要报 request');
});
