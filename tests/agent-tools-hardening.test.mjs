import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, createPermissionStore } from '../electron/permissions.cjs';
import { createProjectTools, MESSAGES } from '../electron/agent-tools.cjs';

const execFileAsync = promisify(execFile);

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function gitAvailable() {
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Throwaway project folders plus a store that approves every dialog, following
 * the fixture in tests/permissions.test.mjs. `options.confirm` can still stall a
 * per-call approval, so a run can be cancelled while the user is deciding.
 */
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mova-hardening-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const name of options.folders ?? ['project']) {
    const root = join(base, name);
    await mkdir(root, { recursive: true });
    roots.push(root);
  }
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => {
      // Grants and per-call approvals are configured separately: a test that
      // stalls a write still needs the capability itself to be granted.
      if (request.mode === 'grant') return 'allow';
      return typeof options.confirm === 'function' ? options.confirm(request) : 'once';
    },
  });
  await permissionStore.register(roots.map(path => ({ path })));
  const ids = roots.map(root => canonicalPath(root).id);
  for (const id of ids) {
    for (const capability of options.capabilities ?? []) {
      await permissionStore.setCapability({ rootId: id, capability, value: true });
    }
  }
  const granted = [];
  for (const id of ids) granted.push(await permissionStore.get(id));
  const historyDir = join(base, 'history');
  return {
    base,
    roots,
    root: roots[0],
    store: permissionStore,
    historyDir,
    tools: () => createProjectTools({ permissions: permissionStore, roots: granted, historyDir, emit: () => {} }),
  };
}

function tool(tools, name) {
  const found = tools.find(candidate => candidate.name === name);
  assert.ok(found, `missing tool: ${name}`);
  return found;
}

test('a cancelled run cannot commit a write even when approval arrives afterwards', async t => {
  const prompted = deferred();
  const approval = deferred();
  const { root, tools } = await fixture(t, {
    capabilities: ['read', 'write'],
    confirm: () => { prompted.resolve(); return approval.promise; },
  });
  const write = tool(tools(), 'write_file');
  const controller = new AbortController();

  // The run is parked inside the approval dialog when the cancel lands.
  const running = write.execute('w1', { path: 'cancelled.txt', content: 'late write' }, controller.signal);
  await prompted.promise;
  controller.abort();
  approval.resolve('once');

  await assert.rejects(running, error => error?.code === 'aborted');
  await assert.rejects(access(join(root, 'cancelled.txt')), 'a cancelled run must not create the file');
});

test('cancelling the run refuses a still-pending approval and writes nothing', async t => {
  const prompted = deferred();
  const decisions = [];
  const { root, tools } = await fixture(t, {
    capabilities: ['read', 'write'],
    confirm: request => {
      prompted.resolve(request);
      // Stand-in for the approval broker: the run's own signal closes the bar.
      return new Promise(resolve => {
        const refuse = () => { decisions.push('deny'); resolve('deny'); };
        if (request.signal?.aborted) { refuse(); return; }
        request.signal?.addEventListener('abort', refuse, { once: true });
      });
    },
  });
  const write = tool(tools(), 'write_file');
  const controller = new AbortController();

  const running = write.execute('w1', { path: 'pending.txt', content: 'never written' }, controller.signal);
  const request = await prompted.promise;
  assert.equal(request.signal, controller.signal, 'the approval must follow the run signal');
  controller.abort();

  await assert.rejects(running, error => ['denied', 'aborted'].includes(error?.code));
  assert.deepEqual(decisions, ['deny'], 'the approval was refused, never approved');
  await assert.rejects(access(join(root, 'pending.txt')), 'an aborted approval must not create the file');
});

test('search_files accepts a folder, a single file, or no path at all', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read'] });
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'app.ts'), 'const answer = 42;\n');
  await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'const answer = 43;\n');
  await writeFile(join(root, 'README.md'), '# Demo\nanswer is forty-two\n');
  const search = tool(tools(), 'search_files');

  const folder = parse(await search.execute('s1', { query: 'answer', path: 'src' }));
  assert.equal(folder.error, undefined);
  assert.deepEqual(folder.matches.map(hit => hit.path).sort(), ['src/app.ts', 'src/nested/deep.ts']);
  assert.equal(folder.filesScanned, 2, 'a folder is descended, not read as one file');
  assert.equal(folder.truncated, false);

  const single = parse(await search.execute('s2', { query: 'answer', path: 'README.md' }));
  assert.equal(single.error, undefined);
  assert.deepEqual(single.matches.map(hit => hit.path), ['README.md']);
  assert.equal(single.filesScanned, 1);

  const every = parse(await search.execute('s3', { query: 'answer' }));
  assert.deepEqual(every.matches.map(hit => hit.path).sort(), ['README.md', 'src/app.ts', 'src/nested/deep.ts']);
  assert.equal(every.filesScanned, 3);
});

test('undo_change refuses to discard edits made after that change', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  const projectTools = tools();
  const write = tool(projectTools, 'write_file');
  const replace = tool(projectTools, 'replace_in_file');
  const undo = tool(projectTools, 'undo_change');

  const created = parse(await write.execute('w1', { path: 'note.txt', content: 'v1' }));
  assert.ok(created.changeId);
  const first = parse(await replace.execute('r1', { path: 'note.txt', oldText: 'v1', newText: 'v2' }));
  const second = parse(await replace.execute('r2', { path: 'note.txt', oldText: 'v2', newText: 'v3' }));
  assert.ok(first.changeId && second.changeId);
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'v3');

  const blocked = parse(await undo.execute('u1', { changeId: first.changeId }));
  assert.equal(blocked.error, 'conflict');
  assert.equal(blocked.message, MESSAGES.conflict);
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'v3', 'a conflicting undo writes nothing');

  const restored = parse(await undo.execute('u2', { changeId: second.changeId }));
  assert.equal(restored.error, undefined);
  assert.equal(restored.restored, true);
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'v2');
});

test('git_status reads a repository that lives in the second project folder', async t => {  if (!(await gitAvailable())) {
    t.skip('git is not available');
    return;
  }
  const { roots, tools } = await fixture(t, { folders: ['first', 'second'], capabilities: ['read'] });
  await execFileAsync('git', ['init'], { cwd: roots[1], windowsHide: true });

  const status = parse(await tool(tools(), 'git_status').execute('g1', {}));
  assert.equal(status.error, undefined);
  assert.equal(status.clean, true);
  assert.deepEqual(status.entries, []);
  assert.equal(typeof status.branch, 'string');
});

test('a write approved against old content refuses the commit when the file changed meanwhile', async t => {
  const prompted = deferred();
  const approval = deferred();
  const { root, tools } = await fixture(t, {
    capabilities: ['read', 'write'],
    confirm: () => { prompted.resolve(); return approval.promise; },
  });
  const projectTools = tools();
  const write = tool(projectTools, 'write_file');
  const listChanges = tool(projectTools, 'list_changes');
  await writeFile(join(root, 'note.txt'), 'original');

  const running = write.execute('w1', { path: 'note.txt', content: 'from the model' });
  await prompted.promise;
  // The user (or another program) edits the file while the dialog is open.
  await writeFile(join(root, 'note.txt'), 'edited elsewhere');
  approval.resolve('once');

  const result = parse(await running);
  assert.equal(result.error, 'conflict');
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'edited elsewhere', 'the approved write is dropped');
  const changes = parse(await listChanges.execute('l1', {}));
  assert.deepEqual(changes.changes, [], 'a refused commit records no undo entry');
});

test('a capability revoked while the approval is open stops the write', async t => {
  const prompted = deferred();
  const approval = deferred();
  const { root, store, tools } = await fixture(t, {
    capabilities: ['read', 'write'],
    confirm: () => { prompted.resolve(); return approval.promise; },
  });
  const write = tool(tools(), 'write_file');

  const running = write.execute('w1', { path: 'revoked.txt', content: 'nope' });
  await prompted.promise;
  const id = (await store.list()).roots[0].id;
  await store.setCapability({ rootId: id, capability: 'write', value: false });
  approval.resolve('once');

  const result = parse(await running);
  assert.equal(result.error, 'not-granted');
  await assert.rejects(access(join(root, 'revoked.txt')), 'a revoked capability must not write');
});

test('two concurrent writes to one path serialise: one wins, the other reports a conflict', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  const write = tool(tools(), 'write_file');
  const contentA = `A:${'a'.repeat(120_000)}`;
  const contentB = `B:${'b'.repeat(120_000)}`;

  // Neither is awaited first: both runs race for the same destination.
  const [first, second] = await Promise.all([
    write.execute('c1', { path: 'race.txt', content: contentA }),
    write.execute('c2', { path: 'race.txt', content: contentB }),
  ]);
  const results = [parse(first), parse(second)];
  const winners = results.filter(result => result.error === undefined);
  const losers = results.filter(result => result.error !== undefined);
  assert.equal(winners.length, 1, 'exactly one write lands');
  assert.equal(losers.length, 1, 'the other must not silently overwrite');
  assert.equal(losers[0].error, 'conflict');

  const final = await readFile(join(root, 'race.txt'), 'utf8');
  assert.ok([contentA, contentB].includes(final), 'the file holds exactly one complete payload');
});
