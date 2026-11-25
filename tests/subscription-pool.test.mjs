import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool } from '../electron/subscription/pool.mjs';

/** 内存 store：list() 故意脱敏且不带 usage，逼 pool 走 read()（与真实 store 行为一致）。 */
function fakeStore(records) {
  const map = new Map();
  for (const record of records) {
    const full = { type: 'oauth', state: 'ready', createdAt: 1, access: `access-${record.accountId}`, ...record };
    map.set(`${full.provider}:${full.accountId}`, full);
  }
  return {
    map,
    async list(provider) {
      return [...map.values()]
        .filter(record => record.provider === provider)
        .map(record => {
          const { access, refresh, idToken, usage, ...view } = record;
          return view;
        });
    },
    async read(provider, accountId) {
      const record = map.get(`${provider}:${accountId}`);
      return record ? { ...record } : null;
    },
    async modify(provider, accountId, fn) {
      const key = `${provider}:${accountId}`;
      const current = map.get(key) ?? null;
      const next = await fn(current ? { ...current } : null);
      if (next === null) {
        map.delete(key);
        return null;
      }
      if (next === undefined) return current;
      const merged = { ...current, ...next };
      map.set(key, merged);
      return merged;
    },
  };
}

function account(accountId, { provider = 'chatgpt', usedPercent = null, resetsAt, ...rest } = {}) {
  const record = { provider, accountId, ...rest };
  if (usedPercent !== null) {
    record.usage = {
      checkedAt: 1,
      windows: [{ id: 'session', label: '5 小时窗口', usedPercent, ...(resetsAt ? { resetsAt } : {}) }],
    };
  }
  return record;
}

const T0 = 1_700_000_000_000;

test('the preferred account wins even when another account has more quota left', async () => {
  const store = fakeStore([
    account('acct_a', { usedPercent: 10 }),
    account('acct_b', { usedPercent: 80 }),
  ]);
  const pool = createPool({ store, now: () => T0, settings: { preferredAccountId: 'acct_b' } });
  const { account: picked, event } = await pool.pick('chatgpt');
  assert.equal(picked.accountId, 'acct_b', '优先账号必须优先');
  assert.equal(event.reason, 'preferred', '选择原因应为 preferred');
  assert.equal(event.provider, 'chatgpt', '事件要带 provider');
  assert.deepEqual(event.skipped, [], '没有账号被跳过');
});

test('without a preferred account the account with most remaining quota wins', async () => {
  const store = fakeStore([
    account('acct_busy', { usedPercent: 92 }),
    account('acct_idle', { usedPercent: 5 }),
    account('acct_half', { usedPercent: 50 }),
  ]);
  const pool = createPool({ store, now: () => T0, settings: {} });
  const { account: picked, event } = await pool.pick('chatgpt');
  assert.equal(picked.accountId, 'acct_idle', '剩余额度最多的账号优先');
  assert.equal(event.reason, 'least_used', '没有优先账号时的原因应为 least_used');
  assert.equal(picked.access, 'access-acct_idle', 'pick 返回的记录必须带令牌，上游请求要用');
});

test('a limited account is skipped and comes back by itself once the cooldown ends', async () => {
  let now = T0;
  const store = fakeStore([
    account('acct_free', { usedPercent: 0 }),
    account('acct_busy', { usedPercent: 60 }),
  ]);
  const pool = createPool({ store, now: () => now, settings: { preferredAccountId: 'acct_busy' } });
  await pool.markLimited('chatgpt', 'acct_busy', T0 + 60 * 60 * 1000);

  const first = await pool.pick('chatgpt');
  assert.equal(first.account.accountId, 'acct_free', '冷却中的账号必须被跳过');
  assert.deepEqual(first.event.skipped, [{ id: 'acct_busy', why: 'limited' }], '跳过原因应为 limited');

  now = T0 + 61 * 60 * 1000;
  const second = await pool.pick('chatgpt');
  assert.equal(second.account.accountId, 'acct_busy', '到点后优先账号自动恢复');
  assert.equal(second.event.reason, 'preferred', '恢复的优先账号仍按 preferred 记事件');
  assert.deepEqual(second.event.skipped, [], '恢复后不再有 skipped');
});

test('a non-preferred account that recovers is reported as recovered', async () => {
  let now = T0;
  const store = fakeStore([
    account('acct_a', { usedPercent: 0 }),
    account('acct_b', { usedPercent: 70 }),
  ]);
  const pool = createPool({ store, now: () => now, settings: {} });
  await pool.markLimited('chatgpt', 'acct_a', T0 + 60_000);
  await pool.pick('chatgpt');
  now = T0 + 61_000;
  const { account: picked, event } = await pool.pick('chatgpt');
  assert.equal(picked.accountId, 'acct_a', '恢复的账号额度更多，应被选中');
  assert.equal(event.reason, 'recovered', '这次选择应标记为 recovered');
});

test('markLimited only sets limitedUntil and keeps the stored state ready', async () => {
  const store = fakeStore([account('acct_a', { usedPercent: 30 })]);
  const pool = createPool({ store, now: () => T0, settings: {} });
  await pool.markLimited('chatgpt', 'acct_a', T0 + 3_600_000);
  assert.equal(store.map.get('chatgpt:acct_a').state, 'ready', '磁盘上的 state 不改成 limited');
  assert.equal(store.map.get('chatgpt:acct_a').limitedUntil, T0 + 3_600_000, 'limitedUntil 要写回凭据库');
  const snapshot = await pool.snapshot('chatgpt');
  assert.equal(snapshot.accounts[0].state, 'limited', '展示状态由 limitedUntil 推导');
  assert.equal(snapshot.accounts[0].available, false, '冷却中不可用');
  assert.equal(snapshot.activeAccountId, null, '没有可用账号时 active 为空');
});

test('markExpired blocks the account and stores a redacted reason', async () => {
  const store = fakeStore([
    account('acct_a', { state: 'ready' }),
    account('acct_b', { state: 'ready' }),
  ]);
  const pool = createPool({ store, now: () => T0, settings: {} });
  const tokenLike = 'Bearer eyJhbGciOiJIUzI1NiJ9.ayJzdWIiOiJ4In0.signaturevalue';
  await pool.markExpired('chatgpt', 'acct_a', `invalid_token ${tokenLike}`);
  const stored = store.map.get('chatgpt:acct_a');
  assert.equal(stored.state, 'expired', '过期的账号要落成 expired');
  assert.equal(/eyJhbGci/.test(stored.lastError), false, '错误里不得残留令牌片段');
  const { account: picked, event } = await pool.pick('chatgpt');
  assert.equal(picked.accountId, 'acct_b', '过期账号不参与调度');
  assert.deepEqual(event.skipped, [{ id: 'acct_a', why: 'expired' }], '跳过原因应为 expired');
});

test('clear() brings a marked account back into rotation', async () => {
  const store = fakeStore([account('acct_a', { state: 'ready' })]);
  const pool = createPool({ store, now: () => T0, settings: {} });
  await pool.markExpired('chatgpt', 'acct_a', 'auth');
  await assert.rejects(() => pool.pick('chatgpt'), error => error.code === 'no_account_available', '标记后池子为空');
  await pool.clear('chatgpt', 'acct_a');
  const { account: picked } = await pool.pick('chatgpt');
  assert.equal(picked.accountId, 'acct_a', 'clear 后可以再次选到');
  assert.equal(store.map.get('chatgpt:acct_a').state, 'ready', 'clear 要把 state 落回 ready');
});

test('noteUsed() updates lastUsedAt, which breaks ties between equal quotas', async () => {
  const store = fakeStore([
    account('acct_a', { usedPercent: 20 }),
    account('acct_b', { usedPercent: 20 }),
  ]);
  const pool = createPool({ store, now: () => T0, settings: {} });
  const first = await pool.pick('chatgpt');
  assert.equal(first.account.accountId, 'acct_a', '都没用过时按 accountId 稳定排序');
  await pool.noteUsed('chatgpt', 'acct_a');
  assert.equal(store.map.get('chatgpt:acct_a').lastUsedAt, T0, 'lastUsedAt 要落盘');
  const second = await pool.pick('chatgpt');
  assert.equal(second.account.accountId, 'acct_b', '刚用过的账号排到后面');
});

test('picking right after a failure is reported as failover', async () => {
  const store = fakeStore([
    account('acct_a', { usedPercent: 5 }),
    account('acct_b', { usedPercent: 60 }),
  ]);
  const pool = createPool({ store, now: () => T0, settings: { preferredAccountId: 'acct_a' } });
  assert.equal((await pool.pick('chatgpt')).event.reason, 'preferred', '首选账号可用时是 preferred');
  await pool.markLimited('chatgpt', 'acct_a', T0 + 3_600_000);
  const { event } = await pool.pick('chatgpt');
  assert.equal(event.reason, 'failover', '失败后一分钟内换号应标记 failover');
});

test('an empty pool reports the nearest reset time in no_account_available', async () => {
  const store = fakeStore([
    account('acct_a', { usedPercent: 100, resetsAt: T0 + 600_000 }),
    account('acct_b', { usedPercent: 100, resetsAt: T0 + 7_200_000 }),
  ]);
  const now = () => T0;
  const pool = createPool({ store, now, settings: {} });
  await pool.markLimited('chatgpt', 'acct_a', T0 + 600_000);
  await pool.markLimited('chatgpt', 'acct_b', T0 + 7_200_000);
  await assert.rejects(
    () => pool.pick('chatgpt'),
    error => {
      assert.equal(error.code, 'no_account_available', '没有可用账号要抛 no_account_available');
      assert.match(error.detail, /最近重置/, 'detail 里要带重置时间提示');
      assert.match(error.detail, /分后重置/, '要用人话给出最近的重置时刻');
      return true;
    },
  );
});

test('an unauthenticated pool raises no_account_available instead of a bare error', async () => {
  const pool = createPool({ store: fakeStore([]), now: () => T0, settings: {} });
  await assert.rejects(() => pool.pick('chatgpt'), error => error.code === 'no_account_available', '空池子也要用契约错误码');
  assert.deepEqual(await pool.snapshot('chatgpt'), {
    provider: 'chatgpt', at: T0, activeAccountId: null, accounts: [],
  }, '空池子的快照要可渲染');
});

test('snapshot() hides tokens, flags the active account and keeps providers apart', async () => {
  const store = fakeStore([
    account('acct_a', { usedPercent: 10 }),
    account('acct_b', { usedPercent: 90 }),
    account('gemini_x', { provider: 'gemini' }),
  ]);
  const pool = createPool({ store, now: () => T0, settings: {} });
  const snapshot = await pool.snapshot('chatgpt');
  assert.equal(snapshot.accounts.length, 2, '只列本 provider 的账号');
  assert.equal(snapshot.activeAccountId, 'acct_a', '额度最多的账号是 active');
  for (const view of snapshot.accounts) {
    assert.equal('access' in view, false, '快照里不能有 access');
    assert.equal('refresh' in view, false, '快照里不能有 refresh');
    assert.equal('idToken' in view, false, '快照里不能有 idToken');
  }
  assert.deepEqual(snapshot.accounts.map(view => view.active), [true, false], 'active 标记只给一个账号');
  assert.throws(() => createPool({ store: {} }), error => error.code === 'request', '没有 store 必须立刻报错');
});
