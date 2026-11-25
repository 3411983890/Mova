const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createPermissionStore } = require('./permissions.cjs');

test('full preset grants read/write/exec on registered roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mova-perm-'));
  const store = createPermissionStore({ filePath: join(dir, 'permissions.json'), confirm: async () => 'allow' });
  await store.register([dir], {});
  await store.setPreset({ preset: 'full' });
  const roots = (await store.list()).roots;
  assert.equal(roots[0].capabilities.read, true);
  assert.equal(roots[0].capabilities.write, true);
  assert.equal(roots[0].capabilities.exec, true);
});

test('auto preset grants read/write but not exec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mova-perm-'));
  const store = createPermissionStore({ filePath: join(dir, 'permissions.json'), confirm: async () => 'allow' });
  await store.register([dir], {});
  await store.setPreset({ preset: 'auto_review' });
  const roots = (await store.list()).roots;
  assert.equal(roots[0].capabilities.read, true);
  assert.equal(roots[0].capabilities.write, true);
  assert.equal(roots[0].capabilities.exec, false);
});
