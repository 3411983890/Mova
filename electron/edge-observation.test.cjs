const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createObservationCache, observationKeyOf } = require('./edge-observation.cjs');

function clock(start = 1_000) {
  let value = start;
  return { now: () => value, advance: ms => { value += ms; return value; } };
}

test('reuses the same page version and stops reusing after a version bump', () => {
  const cache = createObservationCache({ now: () => 0 });
  const snapshot = { version: 4, url: 'https://a.example/x', mode: 'diff', text: '+ button "保存"' };
  cache.remember({ ...observationKeyOf(snapshot, { documentId: 'doc1' }), snapshot });
  const hit = cache.lookup({ documentId: 'doc1', url: snapshot.url, version: 4 });
  assert.equal(hit.snapshot.text, '+ button "保存"');
  assert.equal(cache.lookup({ documentId: 'doc1', url: snapshot.url, version: 5 }), null, '动作后版本变化必须重新观察');
  assert.deepEqual({ hits: cache.summary().hits, misses: cache.summary().misses }, { hits: 1, misses: 1 });
});

test('entries expire so a stale observation is never reported as current', () => {
  const time = clock();
  const cache = createObservationCache({ now: time.now, ttlMs: 500 });
  cache.remember({ url: 'https://a.example/', version: 1, snapshot: { text: 'a' } });
  time.advance(499);
  assert.ok(cache.lookup({ url: 'https://a.example/', version: 1 }));
  time.advance(2);
  assert.equal(cache.lookup({ url: 'https://a.example/', version: 1 }), null);
  assert.equal(cache.summary().expired, 1);
  assert.equal(cache.summary().entries, 0);
});

test('a navigation or document change cannot reuse the old page observation', () => {
  const cache = createObservationCache({ now: () => 0 });
  cache.remember({ documentId: 'doc1', url: 'https://a.example/', version: 2, snapshot: { text: 'a' } });
  assert.equal(cache.lookup({ documentId: 'doc2', url: 'https://a.example/', version: 2 }), null);
  assert.equal(cache.lookup({ documentId: 'doc1', url: 'https://b.example/', version: 2 }), null);
  cache.invalidate('action');
  assert.equal(cache.summary().invalidated, 1);
  assert.equal(cache.lookup({ documentId: 'doc1', url: 'https://a.example/', version: 2 }), null);
});

test('summary reports a measurable hit rate for the duplicate-observation work', () => {
  const cache = createObservationCache({ now: () => 0 });
  cache.remember({ url: 'u', version: 1, snapshot: { text: 'a' } });
  cache.lookup({ url: 'u', version: 1 });
  cache.lookup({ url: 'u', version: 1 });
  cache.lookup({ url: 'u', version: 1 });
  cache.lookup({ url: 'u', version: 9 });
  const summary = cache.summary();
  assert.equal(summary.hits, 3);
  assert.equal(summary.misses, 1);
  assert.equal(summary.hitRate, 75);
  assert.equal(typeof summary.reusedMs, 'number');
});

test('the key falls back to the url when a page cannot report a version', () => {
  const cache = createObservationCache({ now: () => 0 });
  cache.remember({ url: 'https://a.example/', snapshot: { text: 'no version' } });
  assert.equal(cache.lookup({ url: 'https://a.example/' }).snapshot.text, 'no version');
  assert.equal(cache.keyOf({ url: 'https://a.example/' }), 'u:https://a.example/');
  assert.deepEqual(observationKeyOf(null), { documentId: '', url: '', version: null });
});
