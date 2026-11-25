import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createMemoryJobs,
  MemoryJobsError,
  MAX_TEXT_CHARS,
  MAX_ERROR_CHARS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_PURGE_DAYS,
} = require('../electron/services/memory-jobs.cjs');

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '["CodeMova","Alpha","Chat"]';
const FIXED_NOW = new Date('2026-01-01T12:00:00.000Z');

/**
 * Fake pg driver: records every statement and answers from ordered routes.
 * `result` may be an object or a function of (sql, params). Unmatched statements
 * return no rows, like an UPDATE/DELETE that matched nothing.
 */
function fakeQuery(routes = []) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const route of routes) {
      if (route.match.test(sql)) {
        return typeof route.result === 'function' ? route.result(sql, params) : route.result;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  query.calls = calls;
  return query;
}

function jobRow(overrides = {}) {
  return {
    id: JOB_ID,
    conversation_id: CONVERSATION,
    message_id: 'm1',
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function jobs(routes, options = {}) {
  const query = fakeQuery(routes);
  const api = createMemoryJobs({ query, ownerId: OWNER, now: () => FIXED_NOW, id: () => JOB_ID, ...options });
  return { api, query };
}

const rejects = (fn, code) => assert.rejects(fn, error => {
  return error instanceof MemoryJobsError && error.code === code;
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('factory requires an injected query and a UUID owner; exposes the job API', () => {
  assert.throws(() => createMemoryJobs(), error => error.code === 'invalid-input');
  assert.throws(() => createMemoryJobs({ ownerId: OWNER }), error => error.code === 'invalid-input');
  assert.throws(() => createMemoryJobs({ query: () => ({ rows: [] }), ownerId: 'not-a-uuid' }), error => error.code === 'invalid-input');
  assert.throws(() => createMemoryJobs({ query: () => ({ rows: [] }), ownerId: OTHER_OWNER, maxPending: -1 }), error => error.code === 'invalid-input');

  const { api } = jobs([]);
  assert.equal(api.ownerId, OWNER);
  for (const name of ['enqueue', 'claim', 'complete', 'skip', 'fail', 'retry', 'list', 'purgeDone']) {
    assert.equal(typeof api[name], 'function', name);
  }
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

test('enqueue inserts owner-first, trims text and returns metadata without text', async () => {
  const { api, query } = jobs([{ match: /^insert into mova_memory_jobs/, result: { rows: [jobRow()] } }]);
  const job = await api.enqueue({ conversationId: `  ${CONVERSATION}  `, messageId: ' m1 ', text: '  I use pnpm.  ' });

  assert.equal(query.calls.length, 1);
  const [call] = query.calls;
  assert.match(call.sql, /insert into mova_memory_jobs \(owner_id, id, conversation_id, message_id, project_id, text\)/);
  assert.match(call.sql, /on conflict \(owner_id, conversation_id, message_id\) do nothing/);
  assert.match(call.sql, /values \(\$1, \$2, \$3, \$4, \$5, \$6\)/);
  assert.doesNotMatch(call.sql, /do update/i);
  assert.deepEqual(call.params.slice(0, 6), [OWNER, JOB_ID, CONVERSATION, 'm1', null, 'I use pnpm.']);

  assert.deepEqual(job, {
    id: JOB_ID,
    conversationId: CONVERSATION,
    messageId: 'm1',
    projectId: null,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: jobRow().created_at,
    updatedAt: jobRow().updated_at,
  });
  assert.equal('text' in job, false);
});

test('enqueue truncates oversized bodies and rejects empty or oversized identifiers', async () => {
  const { api, query } = jobs([{ match: /^insert into mova_memory_jobs/, result: { rows: [jobRow()] } }]);
  await api.enqueue({ conversationId: CONVERSATION, messageId: 'm1', text: 'x'.repeat(MAX_TEXT_CHARS + 5_000) });
  assert.equal(query.calls[0].params[5].length, MAX_TEXT_CHARS);

  for (const bad of [
    { conversationId: CONVERSATION, messageId: 'm1', text: '' },
    { conversationId: CONVERSATION, messageId: 'm1', text: '   ' },
    { conversationId: CONVERSATION, messageId: 'm1', text: 42 },
    { conversationId: '', messageId: 'm1', text: 'hello' },
    { conversationId: 'c'.repeat(1_001), messageId: 'm1', text: 'hello' },
    { conversationId: CONVERSATION, messageId: 'm'.repeat(501), text: 'hello' },
    { conversationId: CONVERSATION, messageId: 'm1' },
    null,
  ]) {
    await rejects(api.enqueue(bad), 'invalid-input');
  }
  assert.equal(query.calls.length, 1, 'invalid input never reaches SQL');
});

test('enqueue on conflict returns the existing row and never resets it', async () => {
  const existing = jobRow({ status: 'failed', attempts: 2, last_error: 'llm-timeout' });
  const { api, query } = jobs([
    { match: /^insert into mova_memory_jobs/, result: { rows: [] } },
    { match: /^select [\s\S]*from mova_memory_jobs/, result: { rows: [existing] } },
  ]);
  const job = await api.enqueue({ conversationId: CONVERSATION, messageId: 'm1', text: 'I use pnpm.' });

  assert.equal(query.calls.length, 2);
  assert.match(query.calls[1].sql, /where owner_id = \$1 and conversation_id = \$2 and message_id = \$3/);
  assert.deepEqual(query.calls[1].params, [OWNER, CONVERSATION, 'm1']);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 2);
  assert.equal(job.lastError, 'llm-timeout');
});

test('enqueue reports job-limit when the pending cap is reached, and storage-error when the row vanishes', async () => {
  const capped = jobs([{ match: /^select count/, result: { rows: [{ pending: 2 }] } }], { maxPending: 2 });
  await rejects(capped.api.enqueue({ conversationId: CONVERSATION, messageId: 'm1', text: 'hello' }), 'job-limit');
  assert.equal(capped.query.calls.length, 1);
  assert.match(capped.query.calls[0].sql, /status in \('pending','processing'\)/);

  const lost = jobs([{ match: /^insert into mova_memory_jobs/, result: { rows: [] } }]);
  await rejects(lost.api.enqueue({ conversationId: CONVERSATION, messageId: 'm1', text: 'hello' }), 'storage-error');
});

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

test('claim marks rows processing with FOR UPDATE SKIP LOCKED and returns text', async () => {
  const claimedRow = { ...jobRow({ status: 'processing', attempts: 1 }), text: 'I use pnpm.' };
  const { api, query } = jobs([{ match: /^with claimed as/, result: { rows: [claimedRow] } }]);
  const claimed = await api.claim({ limit: 5 });

  const { sql, params } = query.calls[0];
  assert.match(sql, /with claimed as \(/);
  assert.match(sql, /status = 'pending' or \(status = 'failed' and attempts < \$2\)/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /set status = 'processing',/);
  assert.match(sql, /attempts = mova_memory_jobs\.attempts \+ 1/);
  assert.match(sql, /where owner_id = \$1/);
  assert.deepEqual(params.slice(0, 3), [OWNER, 3, 5]);
  assert.ok(params[3] instanceof Date, 'updated_at is a timestamp parameter');

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].text, 'I use pnpm.');
  assert.equal(claimed[0].status, 'processing');
  assert.equal(claimed[0].attempts, 1);
});

test('claim defaults to one row and rejects invalid limits without querying', async () => {
  const { api, query } = jobs([]);
  assert.deepEqual(await api.claim(), []);
  assert.equal(query.calls[0].params[2], 1);
  for (const bad of [0, -1, 1.5, 201, '3']) await rejects(api.claim({ limit: bad }), 'invalid-input');
  assert.equal(query.calls.length, 1);
});

test('lease recovery is owner-scoped and preserves exhausted attempts; heartbeat and settlement are fenced', async () => {
  const { api, query } = jobs([{ match: /^update mova_memory_jobs/, result: { rows: [jobRow()], rowCount: 1 } }]);
  assert.equal(await api.recoverStale(), 1);
  assert.match(query.calls[0].sql, /status = 'processing' and updated_at < \$2/);
  assert.match(query.calls[0].sql, /when attempts >= \$3 then 'failed' else 'pending'/);
  assert.equal(query.calls[0].params[1].toISOString(), '2026-01-01T11:50:00.000Z');
  assert.equal(await api.heartbeat(JOB_ID, 2), true);
  assert.match(query.calls[1].sql, /status = 'processing' and attempts = \$3/);
  await api.complete(JOB_ID, 2);
  assert.match(query.calls[2].sql, /status = 'processing' and attempts = \$4/);
  assert.deepEqual(query.calls[2].params, [OWNER, JOB_ID, FIXED_NOW, 2]);
  await api.claim({ id: JOB_ID });
  assert.match(query.calls[3].sql, /id = \$5::uuid/);
  assert.equal(query.calls[3].params[4], JOB_ID);
});

test('recovered job rejects a stale attempt after another worker claims it', async () => {
  let status = 'processing';
  let attempts = 1;
  const query = async (sql, params) => {
    if (/last_error = 'lease-expired'/.test(sql)) { status = 'pending'; return { rowCount: 1, rows: [] }; }
    if (/^with claimed as/.test(sql)) {
      if (status !== 'pending') return { rows: [] };
      status = 'processing'; attempts++;
      return { rows: [jobRow({ status, attempts, text: 'saved text' })] };
    }
    if (/^update mova_memory_jobs/.test(sql)) {
      if (status !== 'processing' || params.at(-1) !== attempts) return { rows: [] };
      status = 'done'; return { rows: [jobRow({ status, attempts })] };
    }
    return { rows: [] };
  };
  const api = createMemoryJobs({ query, ownerId: OWNER, now: () => FIXED_NOW });
  await api.recoverStale();
  const [recovered] = await api.claim();
  assert.equal(recovered.attempts, 2);
  await rejects(api.complete(JOB_ID, 1), 'not-found');
  assert.equal(status, 'processing');
  await api.complete(JOB_ID, 2);
  assert.equal(status, 'done');
});

// ---------------------------------------------------------------------------
// complete / skip / fail
// ---------------------------------------------------------------------------

test('complete clears text, scopes by owner and reports not-found', async () => {
  const { api, query } = jobs([{ match: /^update mova_memory_jobs/, result: { rows: [jobRow({ status: 'done' })] } }]);
  const job = await api.complete(JOB_ID);
  const { sql, params } = query.calls[0];
  assert.match(sql, /set status = 'done', text = '', last_error = null, updated_at = \$3/);
  assert.match(sql, /where owner_id = \$1 and id = \$2/);
  assert.deepEqual(params, [OWNER, JOB_ID, FIXED_NOW]);
  assert.equal(job.status, 'done');

  await rejects(api.complete('not-a-uuid'), 'invalid-input');
  const missing = jobs([]);
  await rejects(missing.api.complete(JOB_ID), 'not-found');
});

test('skip clears text and truncates the reason; fail keeps text for a retry', async () => {
  const { api, query } = jobs([
    { match: /^update mova_memory_jobs/, result: { rows: [jobRow({ status: 'skipped' })] } },
  ]);
  await api.skip(JOB_ID, 'n'.repeat(MAX_ERROR_CHARS + 200));
  assert.match(query.calls[0].sql, /set status = 'skipped', text = '', last_error = \$3, updated_at = \$4/);
  assert.equal(query.calls[0].params[2].length, MAX_ERROR_CHARS);
  assert.deepEqual(query.calls[0].params.slice(0, 2), [OWNER, JOB_ID]);

  await api.skip(JOB_ID);
  assert.equal(query.calls[1].params[2], null, 'a missing reason is stored as null');

  const failed = jobs([{ match: /^update mova_memory_jobs/, result: { rows: [jobRow({ status: 'failed' })] } }]);
  await failed.api.fail(JOB_ID, 'HTTP 500 from provider');
  const failSql = failed.query.calls[0].sql;
  assert.match(failSql, /set status = 'failed', last_error = \$3, updated_at = \$4/);
  assert.doesNotMatch(failSql, /text =/, 'fail must keep the message text');
  assert.deepEqual(failed.query.calls[0].params.slice(0, 3), [OWNER, JOB_ID, 'HTTP 500 from provider']);
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

test('retry requeues failed/skipped rows below the attempt cap', async () => {
  const { api, query } = jobs([{ match: /^update mova_memory_jobs/, result: { rows: [jobRow({ status: 'pending' })] } }]);
  const job = await api.retry(JOB_ID);
  const { sql, params } = query.calls[0];
  assert.match(sql, /set status = 'pending', last_error = null, updated_at = \$3/);
  assert.match(sql, /status in \('failed','skipped'\) and attempts < \$4/);
  assert.match(sql, /where owner_id = \$1 and id = \$2/);
  assert.deepEqual(params.slice(0, 2), [OWNER, JOB_ID]);
  assert.equal(params[3], 3);
  assert.equal(job.status, 'pending');
});

test('retry distinguishes missing rows from rows that cannot be retried', async () => {
  const missing = jobs([{ match: /^update mova_memory_jobs/, result: { rows: [] } }]);
  await rejects(missing.api.retry(JOB_ID), 'not-found');

  const exhausted = jobs([
    { match: /^update mova_memory_jobs/, result: { rows: [] } },
    { match: /^select status, attempts/, result: { rows: [{ status: 'failed', attempts: 3 }] } },
  ]);
  await assert.rejects(exhausted.api.retry(JOB_ID), error => {
    return error.code === 'invalid-input' && error.detail.attempts === 3 && error.detail.status === 'failed';
  });

  const claimed = jobs([
    { match: /^update mova_memory_jobs/, result: { rows: [] } },
    { match: /^select status, attempts/, result: { rows: [{ status: 'processing', attempts: 1 }] } },
  ]);
  await rejects(claimed.api.retry(JOB_ID), 'invalid-input');
});

// ---------------------------------------------------------------------------
// list / purgeDone
// ---------------------------------------------------------------------------

test('list is owner-scoped, paginated, filterable and never selects text', async () => {
  const { api, query } = jobs([{ match: /^select [\s\S]*from mova_memory_jobs/, result: { rows: [jobRow()] } }]);
  const rows = await api.list();
  const { sql, params } = query.calls[0];
  assert.match(sql, /where owner_id = \$1 and \(\$2::text is null or status = \$2::text\)/);
  assert.match(sql, /order by created_at desc, id/);
  assert.match(sql, /limit \$3/);
  assert.doesNotMatch(sql, /,\s*text\s*,/);
  assert.deepEqual(params, [OWNER, null, DEFAULT_LIST_LIMIT]);
  assert.equal(rows.length, 1);
  assert.equal('text' in rows[0], false);

  await api.list({ status: 'failed', limit: 5 });
  assert.deepEqual(query.calls[1].params, [OWNER, 'failed', 5]);

  for (const bad of [{ status: 'unknown' }, { status: 5 }, { limit: 0 }, { limit: 999 }, { limit: 2.5 }]) {
    await rejects(api.list(bad), 'invalid-input');
  }
  assert.equal(query.calls.length, 2);
});

test('purgeDone deletes old terminal rows with a cutoff parameter', async () => {
  const { api, query } = jobs([{ match: /^delete from mova_memory_jobs/, result: { rows: [], rowCount: 4 } }]);
  const result = await api.purgeDone();
  const { sql, params } = query.calls[0];
  assert.match(sql, /where owner_id = \$1 and status in \('done','skipped'\) and updated_at < \$2/);
  assert.deepEqual(params.slice(0, 1), [OWNER]);
  assert.equal(params[1].toISOString(), '2025-12-25T12:00:00.000Z');
  assert.equal(result.deleted, 4);
  assert.equal(result.before.toISOString(), params[1].toISOString());

  await api.purgeDone({ olderThanDays: 0 });
  assert.equal(query.calls[1].params[1].toISOString(), FIXED_NOW.toISOString());
  assert.equal(DEFAULT_PURGE_DAYS, 7);

  for (const bad of [-1, 1.5, '7', 9_999]) await rejects(api.purgeDone({ olderThanDays: bad }), 'invalid-input');
});

// ---------------------------------------------------------------------------
// Owner scoping and failure mapping
// ---------------------------------------------------------------------------

test('every statement carries its own instance owner; two instances never share scope', async () => {
  const route = [
    { match: /^insert into mova_memory_jobs/, result: { rows: [jobRow()] } },
    { match: /^with claimed as/, result: { rows: [] } },
    { match: /^update mova_memory_jobs/, result: { rows: [jobRow()] } },
    { match: /^select [\s\S]*from mova_memory_jobs/, result: { rows: [jobRow()] } },
    { match: /^delete from mova_memory_jobs/, result: { rows: [], rowCount: 0 } },
  ];
  const first = jobs(route);
  const secondQuery = fakeQuery(route);
  const second = createMemoryJobs({ query: secondQuery, ownerId: OTHER_OWNER, now: () => FIXED_NOW });

  for (const api of [first.api, second]) {
    await api.enqueue({ conversationId: CONVERSATION, messageId: 'm1', text: 'hello' });
    await api.claim({ limit: 2 });
    await api.complete(JOB_ID);
    await api.skip(JOB_ID, 'not useful');
    await api.fail(JOB_ID, 'boom');
    await api.retry(JOB_ID);
    await api.list();
    await api.purgeDone({ olderThanDays: 1 });
  }

  assert.ok(first.query.calls.length >= 8);
  for (const [index, call] of first.query.calls.entries()) {
    assert.equal(call.params[0], OWNER, `call ${index} owner`);
  }
  for (const [index, call] of secondQuery.calls.entries()) {
    assert.equal(call.params[0], OTHER_OWNER, `call ${index} owner`);
  }
});

test('driver failures become storage-error without echoing SQL or message text', async () => {
  const logged = [];
  const query = async () => {
    throw Object.assign(new Error('connection terminated'), { code: '57P01' });
  };
  const api = createMemoryJobs({
    query,
    ownerId: OWNER,
    now: () => FIXED_NOW,
    logger: { error: (...args) => logged.push(args) },
  });

  await rejects(api.enqueue({ conversationId: CONVERSATION, messageId: 'm1', text: 'secret message' }), 'storage-error');
  await rejects(api.claim(), 'storage-error');
  await rejects(api.list(), 'storage-error');
  assert.equal(logged.length, 3);
  const serialized = JSON.stringify(logged);
  assert.equal(serialized.includes('secret message'), false);
  assert.equal(serialized.includes('insert into'), false);
});
