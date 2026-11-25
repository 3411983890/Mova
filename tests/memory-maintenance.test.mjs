import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planMaintenance,
  MemoryMaintenanceError,
  ARCHIVE_REASONS,
  DEFAULTS,
  HIGH_IMPORTANCE_FLOOR,
} = require('../electron/services/memory-maintenance.cjs');
const { normalizeMemoryText } = require('../electron/services/memory-quality.cjs');

const DAY = 86_400_000;
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const iso = offsetDays => new Date(NOW + offsetDays * DAY).toISOString();

// A healthy, recently used memory. Every field is overridable so a test states
// only the property it is about.
function memory(id, overrides = {}) {
  return {
    id,
    text: `memory ${id}`,
    ownerId: 'owner-1',
    projectId: 'project-1',
    createdAt: iso(-30),
    updatedAt: iso(-1),
    importance: 0.5,
    useCount: 3,
    pinned: false,
    status: 'active',
    ...overrides,
  };
}

const ids = entries => entries.map(entry => entry.id);
const reasons = entries => entries.map(entry => entry.reason);

test('empty input produces an empty, well-formed plan', () => {
  const plan = planMaintenance([], { now: NOW });
  assert.deepEqual(plan, {
    archive: [],
    merge: [],
    keep: [],
    stats: { total: 0, archive: 0, mergeGroups: 0, keep: 0 },
  });
});

test('expired memories are archived with reason "expired"', () => {
  const plan = planMaintenance([
    memory('live', { expiredAt: iso(1) }),
    memory('past', { expiredAt: iso(-1) }),
    memory('boundary', { expiredAt: new Date(NOW).toISOString() }),
    memory('never'),
  ], { now: NOW });

  assert.deepEqual(ids(plan.archive), ['past', 'boundary']);
  assert.deepEqual(reasons(plan.archive), [ARCHIVE_REASONS.EXPIRED, ARCHIVE_REASONS.EXPIRED]);
  assert.deepEqual(plan.keep, ['live', 'never']);
  assert.equal(plan.stats.total, 4);
  assert.equal(plan.stats.archive, 2);
  assert.equal(plan.stats.keep, 2);
});

test('stale low-value memories are archived with reason "stale-low-value"', () => {
  const plan = planMaintenance([
    memory('stale', { importance: 0.1, useCount: 0, updatedAt: iso(-366) }),
    memory('unused-but-recent', { importance: 0.1, useCount: 0, updatedAt: iso(-10) }),
    memory('used', { importance: 0.1, useCount: 1, updatedAt: iso(-400) }),
    memory('important-enough', { importance: 0.3, useCount: 0, updatedAt: iso(-400) }),
    memory('healthy', { importance: 0.6, useCount: 4, updatedAt: iso(-5) }),
  ], { now: NOW });

  assert.deepEqual(plan.archive, [{ id: 'stale', reason: 'stale-low-value' }]);
  assert.deepEqual(plan.keep, ['unused-but-recent', 'used', 'important-enough', 'healthy']);
});

test('staleDays, minImportance and maxUseCount are configurable', () => {
  const rows = [
    // Stale only once staleDays drops below 40.
    memory('a', { importance: 0.2, useCount: 0, updatedAt: iso(-40) }),
    // Stale only once minImportance rises above 0.4.
    memory('b', { importance: 0.4, useCount: 0, updatedAt: iso(-400) }),
    // Stale only once maxUseCount allows a use count of 2.
    memory('c', { importance: 0.2, useCount: 2, updatedAt: iso(-400) }),
  ];

  assert.deepEqual(ids(planMaintenance(rows, { now: NOW }).archive), []);

  assert.deepEqual(
    ids(planMaintenance(rows, { now: NOW, staleDays: 30 }).archive),
    ['a'],
  );
  assert.deepEqual(
    ids(planMaintenance(rows, { now: NOW, minImportance: 0.5 }).archive),
    ['b'],
  );
  assert.deepEqual(
    ids(planMaintenance(rows, { now: NOW, maxUseCount: 2 }).archive),
    ['c'],
  );
  assert.deepEqual(
    ids(planMaintenance(rows, { now: NOW, staleDays: 30, minImportance: 0.5, maxUseCount: 2 }).archive),
    ['a', 'b', 'c'],
  );
});

test('missing importance, useCount or updatedAt never counts as stale', () => {
  const plan = planMaintenance([
    memory('no-importance', { importance: undefined, useCount: 0, updatedAt: iso(-900) }),
    memory('no-use-count', { useCount: undefined, importance: 0.1, updatedAt: iso(-900) }),
    memory('no-updated', { updatedAt: undefined, importance: 0.1, useCount: 0 }),
    memory('bad-updated', { updatedAt: 'not-a-date', importance: 0.1, useCount: 0 }),
  ], { now: NOW });

  assert.deepEqual(plan.archive, []);
  assert.deepEqual(plan.keep, ['no-importance', 'no-use-count', 'no-updated', 'bad-updated']);
});

test('pinned memories are never archived, even when expired or stale', () => {
  const plan = planMaintenance([
    memory('pinned-expired', { pinned: true, expiredAt: iso(-5) }),
    memory('pinned-stale', { pinned: true, importance: 0.01, useCount: 0, updatedAt: iso(-5000) }),
    memory('plain-expired', { expiredAt: iso(-5) }),
  ], { now: NOW });

  assert.deepEqual(ids(plan.archive), ['plain-expired']);
  assert.deepEqual(plan.keep, ['pinned-expired', 'pinned-stale']);
});

test('high importance memories are never archived, even when expired', () => {
  const plan = planMaintenance([
    memory('critical', { importance: 0.95, expiredAt: iso(-5) }),
    memory('at-floor', { importance: HIGH_IMPORTANCE_FLOOR, expiredAt: iso(-5) }),
    memory('below-floor', { importance: 0.79, expiredAt: iso(-5) }),
  ], { now: NOW });

  assert.deepEqual(ids(plan.archive), ['below-floor']);
  assert.deepEqual(plan.keep, ['critical', 'at-floor']);
});

test('disabled candidates follow includeDisabled', () => {
  const rows = [
    memory('flag-disabled', { disabled: true }),
    memory('status-disabled', { status: 'disabled' }),
    memory('active'),
  ];

  const off = planMaintenance(rows, { now: NOW });
  assert.deepEqual(off.archive, []);
  assert.deepEqual(off.keep, ['flag-disabled', 'status-disabled', 'active']);

  const on = planMaintenance(rows, { now: NOW, includeDisabled: true });
  assert.deepEqual(on.archive, [
    { id: 'flag-disabled', reason: ARCHIVE_REASONS.DISABLED },
    { id: 'status-disabled', reason: ARCHIVE_REASONS.DISABLED },
  ]);
  assert.deepEqual(on.keep, ['active']);
});

test('a disabled row is never a merge canonical or duplicate', () => {
  const rows = [
    memory('disabled', { disabled: true, text: 'Use pnpm' }),
    memory('active', { text: 'Use pnpm' }),
  ];
  const off = planMaintenance(rows, { now: NOW });
  assert.deepEqual(off.merge, []);
  assert.deepEqual(off.keep, ['disabled', 'active']);

  const on = planMaintenance(rows, { now: NOW, includeDisabled: true });
  assert.deepEqual(on.merge, []);
  assert.deepEqual(ids(on.archive), ['disabled']);
});

test('expired wins over disabled when both apply', () => {
  const plan = planMaintenance([
    memory('both', { disabled: true, expiredAt: iso(-1) }),
  ], { now: NOW, includeDisabled: true });

  assert.deepEqual(plan.archive, [{ id: 'both', reason: 'expired' }]);
});

test('exact normalized-hash duplicates in one scope form a merge group', () => {
  const plan = planMaintenance([
    memory('newer', { text: 'Hello, world', createdAt: iso(-1) }),
    memory('oldest', { text: '  hello,   world  ', createdAt: iso(-10) }),
    memory('middle', { text: 'Ｈｅｌｌｏ， world', createdAt: iso(-5) }),
  ], { now: NOW });

  assert.equal(plan.merge.length, 1);
  assert.equal(plan.stats.mergeGroups, 1);

  const [group] = plan.merge;
  assert.equal(group.canonicalId, 'oldest');
  assert.deepEqual(group.duplicateIds, ['middle', 'newer']);
  // The canonical text is the raw stored text, never the normalized form.
  assert.equal(group.text, '  hello,   world  ');
  assert.notEqual(group.text, normalizeMemoryText(group.text));

  assert.deepEqual(plan.keep, ['oldest']);
  assert.deepEqual(plan.archive, []);
});

test('canonical tie on createdAt is broken by id', () => {
  const plan = planMaintenance([
    memory('b-row', { text: 'same text', createdAt: iso(-5) }),
    memory('a-row', { text: 'same text', createdAt: iso(-5) }),
    memory('c-row', { text: 'same text', createdAt: iso(-5) }),
  ], { now: NOW });

  assert.equal(plan.merge.length, 1);
  assert.equal(plan.merge[0].canonicalId, 'a-row');
  assert.deepEqual(plan.merge[0].duplicateIds, ['b-row', 'c-row']);
});

test('a missing createdAt sorts after every known createdAt', () => {
  const plan = planMaintenance([
    memory('undated', { text: 'same text', createdAt: undefined }),
    memory('dated', { text: 'same text', createdAt: iso(-2) }),
  ], { now: NOW });

  assert.equal(plan.merge[0].canonicalId, 'dated');
  assert.deepEqual(plan.merge[0].duplicateIds, ['undated']);
});

test('duplicates in different scopes are not merged', () => {
  const plan = planMaintenance([
    memory('proj-a', { text: 'Use pnpm', projectId: 'project-a' }),
    memory('proj-b', { text: 'Use pnpm', projectId: 'project-b' }),
    memory('proj-null', { text: 'Use pnpm', projectId: null }),
    memory('owner-2', { text: 'Use pnpm', ownerId: 'owner-2' }),
  ], { now: NOW });

  assert.deepEqual(plan.merge, []);
  assert.deepEqual(plan.keep, ['proj-a', 'proj-b', 'proj-null', 'owner-2']);
});

test('scope keys accept snake_case DB rows and never treat null as a wildcard', () => {
  const plan = planMaintenance([
    { id: 'row-1', text: 'Use pnpm', owner_id: 'owner-1', project_id: 'project-1' },
    { id: 'row-2', text: 'Use pnpm', owner_id: 'owner-1', project_id: 'project-1' },
    { id: 'row-3', text: 'Use pnpm', owner_id: 'owner-1', project_id: null },
    { id: 'row-4', text: 'Use yarn', owner_id: 'owner-1' },
  ], { now: NOW });

  assert.equal(plan.merge.length, 1);
  assert.equal(plan.merge[0].canonicalId, 'row-1');
  assert.deepEqual(plan.merge[0].duplicateIds, ['row-2']);
  assert.deepEqual(plan.keep, ['row-1', 'row-3', 'row-4']);
});

test('empty text rows neither merge nor archive each other', () => {
  const plan = planMaintenance([
    memory('empty-1', { text: '' }),
    memory('empty-2', { text: '   ' }),
    memory('empty-3', { content: '' }),
  ], { now: NOW });

  assert.deepEqual(plan.merge, []);
  assert.deepEqual(plan.keep, ['empty-1', 'empty-2', 'empty-3']);
});

test('content is accepted as an alias for text', () => {
  const plan = planMaintenance([
    memory('a', { text: undefined, content: 'Use pnpm' }),
    memory('b', { text: undefined, content: 'use pnpm' }),
  ], { now: NOW });

  assert.equal(plan.merge.length, 1);
  assert.equal(plan.merge[0].text, 'Use pnpm');
});

test('merge groups are ordered by canonical age, then id', () => {
  const plan = planMaintenance([
    memory('z1', { text: 'alpha', createdAt: iso(-1) }),
    memory('z2', { text: 'alpha', createdAt: iso(-1) }),
    memory('b1', { text: 'beta', createdAt: iso(-20) }),
    memory('b2', { text: 'beta', createdAt: iso(-21) }),
    memory('g1', { text: 'gamma', createdAt: iso(-10) }),
    memory('g2', { text: 'gamma', createdAt: iso(-10) }),
  ], { now: NOW });

  assert.deepEqual(plan.merge.map(group => group.canonicalId), ['b2', 'g1', 'z1']);
});

test('planning is deterministic and does not mutate the input', () => {
  const rows = [
    memory('a', { text: 'dup text', createdAt: iso(-3) }),
    memory('b', { text: 'DUP text', createdAt: iso(-4) }),
    memory('c', { expiredAt: iso(-1) }),
    memory('d', { pinned: true, expiredAt: iso(-1) }),
    memory('e', { importance: 0.1, useCount: 0, updatedAt: iso(-800) }),
  ];
  const snapshot = structuredClone(rows);
  const arrayOrder = rows.map(row => row.id);

  const first = planMaintenance(rows, { now: NOW });
  const second = planMaintenance(rows, { now: new Date(NOW) });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(rows, snapshot);
  assert.deepEqual(rows.map(row => row.id), arrayOrder);
});

test('archive order follows input order', () => {
  const plan = planMaintenance([
    memory('c', { expiredAt: iso(-1) }),
    memory('a', { expiredAt: iso(-2) }),
    memory('b', { expiredAt: iso(-3) }),
  ], { now: NOW });

  assert.deepEqual(ids(plan.archive), ['c', 'a', 'b']);
});

test('stats account for every row exactly once', () => {
  const plan = planMaintenance([
    memory('expired', { expiredAt: iso(-1) }),
    memory('stale', { importance: 0.05, useCount: 0, updatedAt: iso(-400) }),
    memory('dup-1', { text: 'same' }),
    memory('dup-2', { text: 'same' }),
    memory('dup-3', { text: 'same' }),
    memory('kept'),
  ], { now: NOW });

  const duplicates = plan.merge.reduce((sum, group) => sum + group.duplicateIds.length, 0);
  assert.equal(plan.stats.total, 6);
  assert.equal(plan.stats.archive, 2);
  assert.equal(plan.stats.mergeGroups, 1);
  assert.equal(plan.stats.keep, 2);
  assert.equal(plan.stats.total, plan.stats.archive + plan.stats.keep + duplicates);
});

test('now accepts ms, Date and ISO forms', () => {
  const rows = [memory('x', { expiredAt: iso(0) })];
  for (const now of [NOW, new Date(NOW), new Date(NOW).toISOString()]) {
    assert.deepEqual(ids(planMaintenance(rows, { now }).archive), ['x']);
  }
  // Default now is the current clock; a memory far in the past is still expired.
  assert.deepEqual(ids(planMaintenance([memory('y', { expiredAt: '2000-01-01T00:00:00Z' })]).archive), ['y']);
});

test('invalid input is rejected with a stable error code', () => {
  const throwsInvalid = (fn, detail) => assert.throws(fn, error => {
    assert.ok(error instanceof MemoryMaintenanceError);
    assert.ok(error instanceof TypeError);
    assert.equal(error.code, 'invalid-input');
    if (detail !== undefined) assert.equal(error.detail, detail);
    return true;
  });

  throwsInvalid(() => planMaintenance(null), 'memories');
  throwsInvalid(() => planMaintenance({}), 'memories');
  throwsInvalid(() => planMaintenance('nope'), 'memories');
  throwsInvalid(() => planMaintenance([null]), 'memories[0]');
  throwsInvalid(() => planMaintenance([memory('ok'), 'row']), 'memories[1]');
  throwsInvalid(() => planMaintenance([{ text: 'no id' }]), 'memories[0].id');
  throwsInvalid(() => planMaintenance([memory('dup'), memory('dup')]));
  throwsInvalid(() => planMaintenance([], { now: 'not-a-date' }), 'now');
  throwsInvalid(() => planMaintenance([], { staleDays: -1 }), 'staleDays');
  throwsInvalid(() => planMaintenance([], { minImportance: 2 }), 'minImportance');
  throwsInvalid(() => planMaintenance([], { maxUseCount: -1 }), 'maxUseCount');
  throwsInvalid(() => planMaintenance([], { includeDisabled: 'yes' }), 'includeDisabled');
  throwsInvalid(() => planMaintenance([], 5), 'options');
});

test('numeric ids are supported and preserved as-is', () => {
  const plan = planMaintenance([
    { id: 2, text: 'same text', createdAt: iso(-1) },
    { id: 1, text: 'same text', createdAt: iso(-1) },
    { id: 3, text: 'other' },
  ], { now: NOW });

  assert.equal(plan.merge[0].canonicalId, 1);
  assert.deepEqual(plan.merge[0].duplicateIds, [2]);
  assert.deepEqual(plan.keep, [1, 3]);
});

test('defaults are exported for callers that build their own options', () => {
  assert.deepEqual(DEFAULTS, {
    staleDays: 365,
    minImportance: 0.25,
    maxUseCount: 0,
    includeDisabled: false,
  });
  assert.equal(HIGH_IMPORTANCE_FLOOR, 0.8);
});
