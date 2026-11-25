import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, createPermissionStore } from '../electron/permissions.cjs';
import { createChangesIpc, installChangesIpc } from '../electron/changes-ipc.cjs';

/** A registered temporary project root plus an empty history folder. */
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mova-changes-'));
  const root = join(base, 'project');
  const historyDir = join(base, 'file-history');
  await mkdir(root, { recursive: true });
  await mkdir(historyDir, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  const permissions = createPermissionStore({ filePath: join(base, 'permissions.json') });
  await permissions.register([{ path: root }]);
  const id = canonicalPath(root).id;
  const historyPath = join(historyDir, `${id}.json`);
  const calls = [];
  const shell = {
    showItemInFolder(target) { calls.push(target); },
  };
  const changes = createChangesIpc({
    permissions,
    historyDir,
    shell: () => shell,
    audit: options.audit,
  });
  async function writeHistory(entries, { raw } = {}) {
    const body = raw ?? JSON.stringify({ version: 1, entries });
    await writeFile(historyPath, body, 'utf8');
  }
  return { base, root, historyDir, historyPath, id, permissions, changes, shell, calls, writeHistory };
}

function entry(overrides = {}) {
  return {
    id: 'change-1',
    time: 1_000,
    rootId: 'root',
    path: 'src/a.txt',
    kind: 'write',
    before: null,
    after: 'hello',
    ...overrides,
  };
}

test('list returns newest-first summaries without any file content', async t => {
  const f = await fixture(t);
  await f.writeHistory([
    entry({ id: 'old', time: 100, path: 'src/old.txt', after: 'x'.repeat(5) }),
    entry({ id: 'newest', time: 300, path: 'src/new.txt', after: null, before: 'y'.repeat(7) }),
    entry({ id: 'middle', time: 200, path: 'src/mid.txt', kind: 'delete', after: null, before: null }),
  ]);
  const result = await f.changes.list({ rootId: f.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.changes, [
    { id: 'newest', time: 300, path: 'src/new.txt', kind: 'write', bytes: 7 },
    { id: 'middle', time: 200, path: 'src/mid.txt', kind: 'delete', bytes: 0 },
    { id: 'old', time: 100, path: 'src/old.txt', kind: 'write', bytes: 5 },
  ]);
  for (const item of result.value.changes) {
    assert.equal('before' in item, false, 'list must not return content');
    assert.equal('after' in item, false, 'list must not return content');
    assert.deepEqual(Object.keys(item).sort(), ['bytes', 'id', 'kind', 'path', 'time']);
  }
});

test('list caps the answer at 100 entries and keeps the newest ones', async t => {
  const f = await fixture(t);
  const entries = Array.from({ length: 150 }, (_, index) => entry({ id: `change-${index}`, time: index + 1 }));
  await f.writeHistory(entries);
  const result = await f.changes.list({ rootId: f.id });
  assert.equal(result.ok, true);
  assert.equal(result.value.changes.length, 100);
  assert.equal(result.value.changes[0].id, 'change-149');
  assert.equal(result.value.changes.at(-1).id, 'change-50');
});

test('list treats a missing history file as an empty history', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.changes.list({ rootId: f.id }), { ok: true, value: { changes: [] } });
});

test('list refuses unregistered roots and leaves a corrupt history file untouched', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.changes.list({ rootId: 'project-not-a-real-root' }), { ok: false, error: 'not-registered' });
  assert.deepEqual(await f.changes.list({}), { ok: false, error: 'not-registered' });

  await f.writeHistory(null, { raw: '{"version":1,"entries":[' });
  assert.deepEqual(await f.changes.list({ rootId: f.id }), { ok: false, error: 'history-unreadable' });
  assert.equal(await readFile(f.historyPath, 'utf8'), '{"version":1,"entries":[', 'a corrupt history must not be rewritten');
});

test('diff returns both sides from history only', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'src.txt'), 'current file on disk', 'utf8').catch(() => {});
  await f.writeHistory([entry({ id: 'abc', time: 42, path: 'src/a.txt', kind: 'replace', before: 'old text', after: 'new text' })]);
  const result = await f.changes.diff({ rootId: f.id, changeId: 'abc' });
  assert.deepEqual(result, {
    ok: true,
    value: { id: 'abc', time: 42, path: 'src/a.txt', kind: 'replace', before: 'old text', after: 'new text', truncated: false },
  });
});

test('diff clips each side to 300 lines and 100k characters', async t => {
  const f = await fixture(t);
  const long = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
  const huge = 'z'.repeat(150_000);
  await f.writeHistory([
    entry({ id: 'lines', before: long, after: long }),
    entry({ id: 'chars', before: huge, after: huge }),
  ]);
  const lines = await f.changes.diff({ rootId: f.id, changeId: 'lines' });
  assert.equal(lines.ok, true);
  assert.equal(lines.value.truncated, true);
  assert.equal(lines.value.before.split('\n').length, 300);
  assert.equal(lines.value.after.split('\n').length, 300);

  const chars = await f.changes.diff({ rootId: f.id, changeId: 'chars' });
  assert.equal(chars.ok, true);
  assert.equal(chars.value.truncated, true);
  assert.equal(chars.value.before.length, 100_000);
  assert.equal(chars.value.after.length, 100_000);
});

test('diff rejects an unknown change and a malformed change id', async t => {
  const f = await fixture(t);
  await f.writeHistory([entry()]);
  assert.deepEqual(await f.changes.diff({ rootId: f.id, changeId: 'missing' }), { ok: false, error: 'not-found' });
  for (const changeId of [undefined, null, 42, '', 'x'.repeat(81)]) {
    assert.deepEqual(await f.changes.diff({ rootId: f.id, changeId }), { ok: false, error: 'invalid-arguments' });
  }
});

test('reveal shows an existing file through the injected shell', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'src'), { recursive: true });
  await writeFile(join(f.root, 'src', 'a.txt'), 'hi', 'utf8');
  const result = await f.changes.reveal({ rootId: f.id, path: 'src/a.txt' });
  assert.deepEqual(result, { ok: true, value: { revealed: true } });
  assert.deepEqual(f.calls, [join(f.root, 'src', 'a.txt')]);
});

test('reveal refuses escapes and never calls the shell for them', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.changes.reveal({ rootId: f.id, path: '../escape' }), { ok: false, error: 'path-escape' });
  assert.deepEqual(await f.changes.reveal({ rootId: 'project-nope', path: '../escape' }), { ok: false, error: 'not-registered' });
  assert.deepEqual(f.calls, [], 'the shell must not run for a refused path');
});

test('reveal reports not-found for a missing file', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.changes.reveal({ rootId: f.id, path: 'src/missing.txt' }), { ok: false, error: 'not-found' });
  assert.deepEqual(f.calls, []);
});

test('installChangesIpc authorizes the sender and forwards the answer unchanged', async t => {
  const f = await fixture(t);
  await f.writeHistory([entry({ id: 'abc' })]);
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const allowed = { sender: 'ok' };
  installChangesIpc(ipcMain, f.changes, event => {
    if (event !== allowed) throw new Error('IPC requires the Mova app');
  });
  assert.deepEqual([...handlers.keys()].sort(), ['changes:diff', 'changes:list', 'changes:reveal']);

  const denied = await handlers.get('changes:list')({ sender: 'other' }, { rootId: f.id });
  assert.deepEqual(denied, { ok: false, error: 'unauthorized' });

  const listed = await handlers.get('changes:list')(allowed, { rootId: f.id });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.changes[0].id, 'abc');

  const diffed = await handlers.get('changes:diff')(allowed, { rootId: f.id, changeId: 'abc' });
  assert.equal(diffed.ok, true);
  assert.equal(diffed.value.after, 'hello');

  const revealed = await handlers.get('changes:reveal')(allowed, { rootId: f.id, path: '../escape' });
  assert.deepEqual(revealed, { ok: false, error: 'path-escape' });
});

test('installChangesIpc turns an internal failure into ipc-failed', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const failure = new Error(`boom at ${join(tmpdir(), 'secret')}`);
  const changes = {
    list: async () => { throw failure; },
    diff: async () => ({ ok: true, value: { id: 'x' } }),
    reveal: async () => ({ ok: true, value: { revealed: true } }),
  };
  installChangesIpc(ipcMain, changes, () => {});
  assert.deepEqual(await handlers.get('changes:list')({}, {}), { ok: false, error: 'ipc-failed' });
  assert.deepEqual(await handlers.get('changes:diff')({}, {}), { ok: true, value: { id: 'x' } });
});
