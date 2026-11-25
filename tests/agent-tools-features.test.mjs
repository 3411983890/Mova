import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, createPermissionStore } from '../electron/permissions.cjs';
import { createProjectTools, MESSAGES } from '../electron/agent-tools.cjs';

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Counts every node in a project_tree payload, children included. */
function countNodes(nodes) {
  return nodes.reduce((sum, node) => sum + 1 + (node.children ? countNodes(node.children) : 0), 0);
}

/**
 * Throwaway project folders plus a store that approves every dialog, following
 * tests/agent-tools-hardening.test.mjs. `approvals` records only per-call
 * approvals, so a test can assert how many times the user was actually asked.
 */
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mova-features-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const name of options.folders ?? ['project']) {
    const root = join(base, name);
    await mkdir(root, { recursive: true });
    roots.push(root);
  }
  const approvals = [];
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => {
      if (request.mode === 'grant') return 'allow';
      approvals.push(request);
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
    approvals,
    store: permissionStore,
    historyDir,
    tools: () => createProjectTools({
      permissions: permissionStore, roots: granted, historyDir, emit: () => {},
    }),
  };
}

function tool(tools, name) {
  const found = tools.find(candidate => candidate.name === name);
  assert.ok(found, `missing tool: ${name}`);
  return found;
}

test('delete_path removes a file, records the change, and undo_change restores it', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  const projectTools = tools();
  await writeFile(join(root, 'note.txt'), 'hello mova');

  const deleted = parse(await tool(projectTools, 'delete_path').execute('d1', { path: 'note.txt' }));
  assert.equal(deleted.error, undefined);
  assert.equal(deleted.deleted, 'file');
  assert.ok(deleted.changeId, 'a file deletion must be undoable');
  await assert.rejects(access(join(root, 'note.txt')), 'the file is gone');

  const undone = parse(await tool(projectTools, 'undo_change').execute('u1', { changeId: deleted.changeId }));
  assert.equal(undone.error, undefined);
  assert.equal(undone.restored, true);
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'hello mova');
});

test('delete_path refuses a non-empty folder without recursive and removes it with recursive', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  const projectTools = tools();
  const remove = tool(projectTools, 'delete_path');
  await mkdir(join(root, 'logs', 'deep'), { recursive: true });
  await writeFile(join(root, 'logs', 'a.txt'), 'a');
  await writeFile(join(root, 'logs', 'deep', 'b.txt'), 'bb');

  const refused = parse(await remove.execute('d1', { path: 'logs' }));
  assert.equal(refused.error, 'directory-not-empty');
  assert.equal(refused.message, MESSAGES['directory-not-empty']);
  assert.deepEqual((await readdir(join(root, 'logs'))).sort(), ['a.txt', 'deep'], 'the folder is untouched');

  const removed = parse(await remove.execute('d2', { path: 'logs', recursive: true }));
  assert.equal(removed.error, undefined);
  assert.equal(removed.deleted, 'directory');
  assert.equal(removed.files, 2, 'both nested files are counted in the approval');
  assert.equal(removed.bytes, 3);
  assert.equal(removed.changeIds.length, 2, 'every file deletion is recorded for undo');
  await assert.rejects(access(join(root, 'logs')));

  // A recursive delete must not sweep a nested repository's .git away.
  await mkdir(join(root, 'repo', '.git'), { recursive: true });
  await writeFile(join(root, 'repo', '.git', 'config'), '[core]');
  const guarded = parse(await remove.execute('d3', { path: 'repo', recursive: true }));
  assert.equal(guarded.error, 'protected-path');
  assert.equal(await readFile(join(root, 'repo', '.git', 'config'), 'utf8'), '[core]');

  const restored = parse(await tool(projectTools, 'undo_change').execute('u1', { changeId: removed.changeIds[0] }));
  assert.equal(restored.error, undefined);
  assert.deepEqual((await readdir(join(root, 'logs'))).sort(), ['a.txt'], 'undo recreates the deleted file');
});

test('a recursive delete counts and records files the search walk would skip', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  const projectTools = tools();
  const remove = tool(projectTools, 'delete_path');
  await mkdir(join(root, 'pkg', 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'pkg', 'index.js'), 'module.exports = 1;\n');
  // node_modules is skipped by the search walk; deleting it must still be undoable.
  await writeFile(join(root, 'pkg', 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n');

  const removed = parse(await remove.execute('d1', { path: 'pkg', recursive: true }));
  assert.equal(removed.error, undefined);
  assert.equal(removed.files, 2, 'the skipped folder is counted, not silently swept');
  assert.equal(removed.changeIds.length, 2, 'both files can be restored');

  const restored = parse(await tool(projectTools, 'undo_change').execute('u1', { changeId: removed.changeIds[1] }));
  assert.equal(restored.error, undefined);
  const left = await readFile(join(root, 'pkg', 'node_modules', 'dep', 'index.js'), 'utf8');
  assert.equal(left, 'module.exports = 2;\n');
});

test('move_path moves inside one root and refuses clashes and cross-root moves', async t => {
  const { roots, tools } = await fixture(t, { folders: ['first', 'second'], capabilities: ['read', 'write'] });
  const move = tool(tools(), 'move_path');
  await writeFile(join(roots[0], 'note.txt'), 'v1');
  await writeFile(join(roots[1], 'other.txt'), 'x');

  const moved = parse(await move.execute('m1', { from: 'first/note.txt', to: 'first/docs/note.txt' }));
  assert.equal(moved.error, undefined);
  assert.equal(moved.moved, 'file');
  assert.ok(moved.changeIds.length >= 1);
  assert.equal(await readFile(join(roots[0], 'docs', 'note.txt'), 'utf8'), 'v1');
  await assert.rejects(access(join(roots[0], 'note.txt')));

  await writeFile(join(roots[0], 'exists.txt'), 'taken');
  const clash = parse(await move.execute('m2', { from: 'first/docs/note.txt', to: 'first/exists.txt' }));
  assert.equal(clash.error, 'already-exists');
  assert.equal(clash.message, MESSAGES['already-exists']);
  assert.equal(await readFile(join(roots[0], 'exists.txt'), 'utf8'), 'taken');

  const cross = parse(await move.execute('m3', { from: 'first/docs/note.txt', to: 'second/moved.txt' }));
  assert.equal(cross.error, 'cross-root-move');
  assert.equal(cross.message, MESSAGES['cross-root-move']);
  await assert.rejects(access(join(roots[1], 'moved.txt')));
  assert.equal(await readFile(join(roots[0], 'docs', 'note.txt'), 'utf8'), 'v1', 'a refused move changes nothing');

  // Windows refuses to rename onto an existing name, so the overwrite path must
  // clear the destination first.
  const overwritten = parse(await move.execute('m4', { from: 'first/docs/note.txt', to: 'first/exists.txt', overwrite: true }));
  assert.equal(overwritten.error, undefined);
  assert.equal(overwritten.overwritten, true);
  assert.equal(await readFile(join(roots[0], 'exists.txt'), 'utf8'), 'v1');
  await assert.rejects(access(join(roots[0], 'docs', 'note.txt')));
});

test('apply_changes writes several files behind exactly one approval', async t => {
  const { root, approvals, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  await writeFile(join(root, 'a.txt'), 'alpha\nbeta\n');

  const result = parse(await tool(tools(), 'apply_changes').execute('a1', {
    changes: [
      { path: 'a.txt', oldText: 'beta', newText: 'BETA' },
      { path: 'b.txt', content: 'brand new\n' },
    ],
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files.map(file => file.path).sort(), ['project/a.txt', 'project/b.txt']);
  assert.ok(result.files.every(file => file.changeId), 'each file gets its own undo entry');
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha\nBETA\n');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'brand new\n');

  assert.equal(approvals.length, 1, 'the batch is approved once, not once per file');
  const preview = approvals[0].preview;
  assert.equal(preview.kind, 'batch');
  assert.equal(preview.path, '2 个文件');
  assert.equal(preview.before, null);
  assert.equal(preview.after, null);
  assert.deepEqual(preview.files.map(file => file.path).sort(), ['project/a.txt', 'project/b.txt']);
  assert.deepEqual(preview.files.map(file => file.truncated), [false, false]);
  const entry = preview.files.find(file => file.path === 'project/a.txt');
  assert.equal(entry.before, 'alpha\nbeta\n');
  assert.equal(entry.after, 'alpha\nBETA\n');
});

test('apply_changes fails as a whole when one file lacks the old text', async t => {
  const { root, approvals, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  await writeFile(join(root, 'one.txt'), 'first');
  await writeFile(join(root, 'two.txt'), 'second');

  const result = parse(await tool(tools(), 'apply_changes').execute('a1', {
    changes: [
      { path: 'one.txt', content: 'rewritten' },
      { path: 'two.txt', oldText: 'missing text', newText: 'nope' },
    ],
  }));
  assert.equal(result.error, 'not-found-in-file');
  assert.equal(approvals.length, 0, 'a batch that cannot be planned is never shown for approval');
  assert.equal(await readFile(join(root, 'one.txt'), 'utf8'), 'first', 'the valid file is not written either');
  assert.equal(await readFile(join(root, 'two.txt'), 'utf8'), 'second');
});

test('apply_changes refuses the whole batch when a file changed during approval', async t => {
  const prompted = deferred();
  const approval = deferred();
  const { root, tools } = await fixture(t, {
    capabilities: ['read', 'write'],
    confirm: () => { prompted.resolve(); return approval.promise; },
  });
  await writeFile(join(root, 'a.txt'), 'a1');
  await writeFile(join(root, 'b.txt'), 'b1');
  const apply = tool(tools(), 'apply_changes');

  const running = apply.execute('a1', {
    changes: [
      { path: 'a.txt', content: 'a2' },
      { path: 'b.txt', content: 'b2' },
    ],
  });
  await prompted.promise;
  // Another run (or the user) edits one file while the dialog is open.
  await writeFile(join(root, 'a.txt'), 'tampered');
  approval.resolve('once');

  const result = parse(await running);
  assert.equal(result.error, 'conflict');
  assert.equal(result.message, MESSAGES.conflict);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'tampered');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b1', 'no file in the batch is written');
});

test('an approval preview carries enough of the file for a real diff, and says when it clipped', async t => {
  const { root, approvals, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  const projectTools = tools();
  const write = tool(projectTools, 'write_file');
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
  await writeFile(join(root, 'big.txt'), lines);

  const small = parse(await write.execute('w1', { path: 'big.txt', content: `${lines}\nlast` }));
  assert.equal(small.error, undefined);
  const preview = approvals.at(-1).preview;
  assert.equal(preview.kind, 'write');
  assert.equal(preview.truncated, false, '200 lines fit inside the preview budget');
  assert.equal(preview.before.split('\n').length, 200, 'the dialog previews the whole file, not just the first 60 lines');
  assert.ok(preview.before.includes('line 200'));

  const huge = Array.from({ length: 500 }, (_, index) => `row ${index + 1}`).join('\n');
  await writeFile(join(root, 'huge.txt'), huge);
  const clipped = parse(await write.execute('w2', { path: 'huge.txt', content: 'x' }));
  assert.equal(clipped.error, undefined);
  const hugePreview = approvals.at(-1).preview;
  assert.equal(hugePreview.truncated, true, 'a long file is clipped and flagged');
  assert.equal(hugePreview.before.split('\n').length, 300);
});

test('read_file names a binary file instead of refusing it', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read', 'write'] });
  const read = tool(tools(), 'read_file');
  // A real PNG header plus some payload: the model should learn the type.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0),
    Buffer.from('IHDR-chunk', 'ascii'),
  ]);
  await writeFile(join(root, 'icon.png'), png);

  const result = parse(await read.execute('b1', { path: 'icon.png' }));
  assert.equal(result.error, undefined);
  assert.equal(result.binary, true);
  assert.equal(result.mime, 'image/png', 'magic bytes identify the type');
  assert.equal(result.bytes, png.length);
  assert.equal(Buffer.from(result.excerptBase64, 'base64').length, png.length);
  assert.ok(result.strings.some(text => text.includes('IHDR')), 'printable runs are offered');

  // Overwriting a binary has no faithful undo snapshot, so it is refused.
  const write = tool(tools(), 'write_file');
  const refused = parse(await write.execute('w1', { path: 'icon.png', content: 'text' }));
  assert.equal(refused.error, 'binary');
});

test('read_file streams a file larger than 4 MB by line range', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read'] });
  const read = tool(tools(), 'read_file');
  const line = 'x'.repeat(99);
  const total = 60_000; // ~6 MB, above the old whole-file ceiling
  const rows = Array.from({ length: total }, (_, index) => `${String(index + 1).padStart(5, '0')}:${line}`).join('\n');
  await writeFile(join(root, 'big.log'), rows);

  const slice = parse(await read.execute('r1', { path: 'big.log', startLine: 50_000, endLine: 50_002 }));
  assert.equal(slice.error, undefined);
  assert.equal(slice.streamed, true);
  assert.equal(slice.content.split('\n').length, 3);
  assert.ok(slice.content.startsWith('50000:'));
  assert.ok(slice.content.endsWith('50002:' + line));
  assert.equal(slice.totalLines, null, 'a streamed range does not claim to know the total');

  const head = parse(await read.execute('r2', { path: 'big.log', startLine: 1, endLine: 2 }));
  assert.ok(head.content.startsWith('00001:'));
  assert.equal(head.streamed, true);
});

test('project_tree returns nested nodes and reports truncation', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read'] });
  const projectTools = tools();
  await mkdir(join(root, 'src', 'lib'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'src', 'app.js'), 'x');
  await writeFile(join(root, 'src', 'lib', 'util.js'), 'yy');
  await writeFile(join(root, 'README.md'), '#');

  const tree = parse(await tool(projectTools, 'project_tree').execute('t1', { depth: 3 }));
  assert.equal(tree.error, undefined);
  assert.equal(tree.truncated, false);
  assert.equal(tree.skipped, 0);
  assert.deepEqual(tree.errors, []);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].name, 'project');
  const nodes = tree.roots[0].tree;
  assert.deepEqual(nodes.map(node => node.name), ['src', 'README.md'], 'folders come first, node_modules is skipped');
  const src = nodes.find(node => node.name === 'src');
  assert.equal(src.type, 'dir');
  assert.deepEqual(src.children.map(node => node.name), ['lib', 'app.js']);
  const lib = src.children.find(node => node.name === 'lib');
  assert.deepEqual(lib.children, [{ name: 'util.js', type: 'file', size: 2 }]);
  assert.deepEqual(nodes.find(node => node.name === 'README.md'), { name: 'README.md', type: 'file', size: 1 });

  const capped = parse(await tool(projectTools, 'project_tree').execute('t2', { maxEntries: 1 }));
  assert.equal(capped.truncated, true);
  assert.equal(countNodes(capped.roots[0].tree), 1, 'the entry budget stops the walk');
});

test('find_symbol finds definitions and references with literal matching', async t => {
  const { root, tools } = await fixture(t, { capabilities: ['read'] });
  const projectTools = tools();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'greet.js'), [
    'function greet(name) {',
    '  return `hello ${name}`;',
    '}',
    'const total = greet("world");',
    '',
  ].join('\n'));
  await writeFile(join(root, 'src', 'other.js'), 'const greeting = "hi";\n');
  const find = tool(projectTools, 'find_symbol');

  const found = parse(await find.execute('f1', { name: 'greet' }));
  assert.equal(found.error, undefined);
  assert.equal(found.filesScanned, 2);
  assert.equal(found.truncated, false);
  assert.equal(found.definitions.length, 1);
  assert.deepEqual(
    { path: found.definitions[0].path, line: found.definitions[0].line },
    { path: 'src/greet.js', line: 1 },
  );
  assert.equal(found.references.length, 1);
  assert.deepEqual(
    { path: found.references[0].path, line: found.references[0].line },
    { path: 'src/greet.js', line: 4 },
  );

  const definitionsOnly = parse(await find.execute('f2', { name: 'greet', kind: 'definition' }));
  assert.equal(definitionsOnly.definitions.length, 1);
  assert.equal(definitionsOnly.references.length, 0);

  const referencesOnly = parse(await find.execute('f3', { name: 'greet', kind: 'reference' }));
  assert.equal(referencesOnly.definitions.length, 0);
  assert.equal(referencesOnly.references.length, 1);

  // Regex metacharacters are matched literally instead of being compiled: the
  // literal `greet(` exists once, and `.*` would have matched every line.
  const literal = parse(await find.execute('f4', { name: 'greet(' }));
  assert.equal(literal.error, undefined);
  assert.equal(literal.references.length, 1);
  const noRegex = parse(await find.execute('f5', { name: '.*' }));
  assert.equal(noRegex.error, undefined);
  assert.equal(noRegex.definitions.length + noRegex.references.length, 0);
});
