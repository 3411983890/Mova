import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { selectRelevantCandidates, selectRerankedCandidates } = createRequire(import.meta.url)('../electron/services/memory-context-selection.cjs');

test('specific requests filter unrelated recent memories, retaining pins and relevant signals', () => {
  const rows = [
    { id: 'unrelated', signals: { lexical: 0, semantic: 0 } },
    { id: 'pin', pinned: true, signals: {} },
    { id: 'lex', signals: { lexical: .2 } },
    { id: 'semantic', signals: { semantic: .3 } },
  ];
  assert.deepEqual(selectRelevantCandidates(rows, '如何部署项目').map(x => x.id), ['pin', 'lex', 'semantic']);
  assert.deepEqual(selectRelevantCandidates(rows, '你记得我说过什么吗'), rows);
  assert.deepEqual(selectRelevantCandidates(rows, ''), rows);
});

test('reranker returns only known chosen IDs, in order, without backfill', () => {
  const rows = [{ id: '1' }, { id: '2' }, { id: '3' }];
  assert.deepEqual(selectRerankedCandidates(rows, ['2', 'unknown', '2']).map(x => x.id), ['2']);
  assert.deepEqual(selectRerankedCandidates(rows, []), []);
});
