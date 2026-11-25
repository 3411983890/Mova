import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rootIdsForRequest } from '../src/features/permissions/request-scope.js';

const roots = [
  { id: 'a', capabilities: { read: true, write: true, exec: true } },
  { id: 'b', capabilities: { read: true, write: false, exec: false } },
  { id: 'c', capabilities: { read: false, write: false, exec: false } },
];
const project = { sourceFolders: [{ id: 'a' }, { id: 'missing' }] };

test('normal presets keep the current project scope', () => {
  assert.deepEqual(rootIdsForRequest({ permissionPreset: 'default', permissionRoots: roots, mode: 'CodeMova', project }), ['a']);
  assert.deepEqual(rootIdsForRequest({ permissionPreset: 'auto', permissionRoots: roots, mode: 'CodeMova', project }), ['a']);
  assert.deepEqual(rootIdsForRequest({ permissionPreset: 'default', permissionRoots: roots, mode: 'ChatMova', project }), []);
});

test('full access widens to every registered folder, across projects and modes', () => {
  assert.deepEqual(rootIdsForRequest({ permissionPreset: 'full', permissionRoots: roots, mode: 'CodeMova', project }), ['a', 'b', 'c']);
  assert.deepEqual(rootIdsForRequest({ permissionPreset: 'full', permissionRoots: roots, mode: 'ChatMova', project }), ['a', 'b', 'c']);
});

test('invalid or missing roots never leak ids', () => {
  assert.deepEqual(rootIdsForRequest({ permissionPreset: 'full', permissionRoots: [{}, null, { id: '' }] }), []);
  assert.deepEqual(rootIdsForRequest({}), []);
  assert.deepEqual(rootIdsForRequest({ permissionPreset: 'full', permissionRoots: roots }).length, 3);
});
