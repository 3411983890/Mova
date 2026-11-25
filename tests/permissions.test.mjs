import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionError, canonicalPath, createPermissionStore, installPermissionsIpc, resolveInside } from '../electron/permissions.cjs';
import { createProjectTools } from '../electron/agent-tools.cjs';

const execFileAsync = promisify(execFile);

async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'mova-permissions-'));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root };
}

async function store(t, options = {}) {
  const { base, root } = await workspace(t);
  const decisions = [];
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => {
      decisions.push(request);
      // Grants and per-call approvals are configured separately: a test that
      // refuses a write still needs the capability itself to be granted.
      if (request.mode === 'grant') return options.grant ?? 'allow';
      return typeof options.confirm === 'function' ? options.confirm(request) : options.confirm ?? 'once';
    },
  });
  await permissionStore.register([{ path: root }]);
  const id = canonicalPath(root).id;
  for (const capability of options.capabilities ?? []) {
    await permissionStore.setCapability({ rootId: id, capability, value: true });
  }
  return { base, root, id, store: permissionStore, decisions };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

test('canonicalPath normalizes folders and rejects anything that is not absolute', () => {
  const folder = canonicalPath(join(tmpdir(), 'Mova', '..', 'Mova'));
  assert.match(folder.id, /^project-[a-f0-9]{64}$/);
  assert.equal(folder.name, 'Mova');
  assert.equal(canonicalPath(folder.path).id, folder.id, 'ids are stable for the same folder');
  for (const value of ['relative/folder', '', 'bad\0path', null, 42]) {
    assert.throws(() => canonicalPath(value), /invalid-path/);
  }
});

test('registering a folder never grants access and is idempotent', async t => {
  const { root, store: permissionStore, id } = await store(t);
  const { roots } = await permissionStore.list();
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].capabilities, { read: false, write: false, exec: false });
  assert.deepEqual(roots[0].autoAccept, { write: false, exec: false });
  await permissionStore.register([{ path: root }, { path: root }]);
  assert.equal((await permissionStore.list()).roots.length, 1);
  assert.equal((await permissionStore.get(id)).path, root);
});

test('granting needs the native confirmation while revoking never asks', async t => {
  const denied = await store(t, { grant: 'deny' });
  await assert.rejects(
    denied.store.setCapability({ rootId: denied.id, capability: 'read', value: true }),
    /denied/,
  );
  assert.equal((await denied.store.get(denied.id)).capabilities.read, false);
  assert.equal(denied.decisions[0].mode, 'grant');
  assert.equal(denied.decisions[0].detail.includes(denied.root), true, 'the dialog shows the real folder');

  const allowed = await store(t, { capabilities: ['read'] });
  await allowed.store.setCapability({ rootId: allowed.id, capability: 'read', value: false });
  assert.equal(allowed.decisions.length, 1, 'revoking does not open a dialog');
  assert.equal((await allowed.store.get(allowed.id)).capabilities.read, false);
});

test('auto-accept needs the capability first and its own confirmation', async t => {
  const { store: permissionStore, id } = await store(t, { capabilities: ['read', 'write'], confirm: () => 'allow' });
  await permissionStore.setAutoAccept({ rootId: id, capability: 'write', value: true });
  assert.equal((await permissionStore.get(id)).autoAccept.write, true);
  await permissionStore.setCapability({ rootId: id, capability: 'write', value: false });
  assert.equal((await permissionStore.get(id)).autoAccept.write, false, 'revoking a capability clears auto-accept');
  await assert.rejects(
    permissionStore.setAutoAccept({ rootId: id, capability: 'write', value: true }),
    /not-granted/,
  );
});

test('authorize allows reads but asks for every write unless granted for the session', async t => {
  const decisions = ['once', 'session', 'deny'];
  const { store: permissionStore, id } = await store(t, {
    capabilities: ['read', 'write'],
    confirm: () => decisions.shift(),
  });
  assert.deepEqual(await permissionStore.authorize({ rootId: id, capability: 'read' }), { ok: true, via: 'capability' });
  assert.deepEqual(await permissionStore.authorize({ rootId: id, capability: 'write', sessionKey: 'w1' }), { ok: true, via: 'once' });
  assert.deepEqual(await permissionStore.authorize({ rootId: id, capability: 'write', sessionKey: 'w1' }), { ok: true, via: 'session' });
  assert.deepEqual(await permissionStore.authorize({ rootId: id, capability: 'write', sessionKey: 'w1' }), { ok: true, via: 'session' }, 'the session grant sticks');
  assert.deepEqual(await permissionStore.authorize({ rootId: id, capability: 'write', sessionKey: 'w2' }), { ok: false, reason: 'denied' });
  permissionStore.clearSession('w1');
  assert.equal((await permissionStore.authorize({ rootId: id, capability: 'write', sessionKey: 'w1' })).ok, false);
});

test('authorize refuses unknown roots and revoked capabilities', async t => {
  const { store: permissionStore, id } = await store(t, { capabilities: ['read'] });
  assert.deepEqual(await permissionStore.authorize({ rootId: 'project-unknown', capability: 'read' }), { ok: false, reason: 'not-registered' });
  await permissionStore.revoke(id);
  assert.deepEqual(await permissionStore.authorize({ rootId: id, capability: 'read' }), { ok: false, reason: 'not-granted' });
});

test('permissions survive a restart and a corrupt file fails closed', async t => {
  const { base, id, store: permissionStore } = await store(t, { capabilities: ['read'] });
  const file = join(base, 'permissions.json');
  const reopened = createPermissionStore({ filePath: file, confirm: async () => 'allow' });
  assert.equal((await reopened.get(id)).capabilities.read, true);

  await writeFile(file, '{ not json');
  const corrupt = createPermissionStore({ filePath: file, confirm: async () => 'allow' });
  assert.deepEqual((await corrupt.list()).roots, []);
  assert.equal((await corrupt.authorize({ rootId: id, capability: 'read' })).ok, false);
  assert.equal((await permissionStore.get(id)).capabilities.read, true, 'the in-memory store is unaffected');
});

test('write requires read first so the model never edits blind', async t => {
  const { id, store: permissionStore } = await store(t);
  await assert.rejects(
    permissionStore.setCapability({ rootId: id, capability: 'write', value: true }),
    /read-required/,
  );
  await permissionStore.setCapability({ rootId: id, capability: 'read', value: true });
  await permissionStore.setCapability({ rootId: id, capability: 'write', value: true });
  assert.equal((await permissionStore.get(id)).capabilities.write, true);
  // Without read, write cannot stay on: it would be editing blind.
  await permissionStore.setCapability({ rootId: id, capability: 'read', value: false });
  assert.equal((await permissionStore.get(id)).capabilities.write, false);
});

test('resolveInside rejects absolute paths, traversal and link escapes', async t => {
  const { base, root } = await workspace(t);
  await writeFile(join(root, 'notes.txt'), 'hello');
  await mkdir(join(root, 'src'), { recursive: true });

  assert.equal(await resolveInside(root, 'notes.txt'), join(root, 'notes.txt'));
  assert.equal(await resolveInside(root, 'src/new-file.ts', { allowMissing: true }), join(root, 'src', 'new-file.ts'));
  for (const bad of ['../outside.txt', 'src/../../outside.txt', 'C:\\Windows\\win.ini', '/etc/passwd', '\\\\server\\share']) {
    await assert.rejects(resolveInside(root, bad), /path-escape|absolute-path|invalid-path/);
  }
  await assert.rejects(resolveInside(root, 'missing.txt'), /not-found/);

  const outside = join(base, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(outside, join(root, 'link'), 'junction');
  } catch {
    return; // Link creation is unavailable on this machine; the textual checks above still ran.
  }
  await assert.rejects(resolveInside(root, 'link/secret.txt'), /path-escape/);
});

test('file tools are only created for granted capabilities', async t => {
  const { id, store: permissionStore } = await store(t);
  const none = await permissionStore.get(id);
  assert.deepEqual(createProjectTools({ permissions: permissionStore, roots: [none], emit: () => {} }), []);

  await permissionStore.setCapability({ rootId: id, capability: 'read', value: true });
  const readOnly = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  assert.deepEqual(readOnly.map(tool => tool.name), [
    'list_files', 'read_file', 'search_files', 'git_status', 'git_diff', 'project_tree', 'find_symbol',
  ]);

  await permissionStore.setCapability({ rootId: id, capability: 'write', value: true });
  await permissionStore.setCapability({ rootId: id, capability: 'exec', value: true });
  const full = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  assert.deepEqual(full.map(tool => tool.name), [
    'list_files', 'read_file', 'search_files', 'git_status', 'git_diff', 'project_tree', 'find_symbol',
    'write_file', 'replace_in_file', 'delete_path', 'move_path', 'apply_changes', 'run_command',
  ]);
});

test('read_file returns text and describes binaries and refuses traversal', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read'] });
  await writeFile(join(root, 'hello.txt'), 'line one\nline two\nline three');
  await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  const events = [];
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: event => events.push(event) });
  const read = tools.find(tool => tool.name === 'read_file');

  const result = parse(await read.execute('call-1', { path: 'hello.txt', startLine: 2, endLine: 3 }));
  assert.equal(result.content, 'line two\nline three');
  assert.equal(result.totalLines, 3);
  assert.deepEqual(events.map(event => event.status), ['running', 'done']);

  // A binary file is described instead of refused: type, size, base64 head.
  const binary = parse(await read.execute('call-2', { path: 'blob.bin' }));
  assert.equal(binary.error, undefined);
  assert.equal(binary.binary, true);
  assert.equal(binary.bytes, 9);
  assert.equal(binary.encoding, undefined);
  assert.ok(typeof binary.excerptBase64 === 'string' && binary.excerptBase64.length > 0);
  assert.ok(Array.isArray(binary.strings));

  assert.equal(parse(await read.execute('call-3', { path: '../outside.txt' })).error, 'path-escape');
  assert.equal(parse(await read.execute('call-4', { path: 'missing.txt' })).error, 'not-found');
});

test('write_file asks for approval and leaves the file alone when refused', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read', 'write'], confirm: () => 'deny' });
  const events = [];
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: event => events.push(event) });
  const write = tools.find(tool => tool.name === 'write_file');

  const refused = parse(await write.execute('call-1', { path: 'new.txt', content: 'hello' }));
  assert.equal(refused.error, 'denied');
  await assert.rejects(readFile(join(root, 'new.txt')), /ENOENT/);
  assert.equal(events.at(-1).status, 'denied');

  const allowed = await store(t, { capabilities: ['read', 'write'], confirm: () => 'once' });
  const allowedTools = createProjectTools({ permissions: allowed.store, roots: [await allowed.store.get(allowed.id)], emit: () => {} });
  const created = parse(await allowedTools.find(tool => tool.name === 'write_file').execute('call-2', { path: 'src/new.txt', content: 'hello' }));
  assert.equal(created.created, true);
  assert.equal(await readFile(join(allowed.root, 'src', 'new.txt'), 'utf8'), 'hello');
});

test('write_file refuses .git and replace_in_file needs a unique match', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read', 'write'] });
  await writeFile(join(root, 'app.txt'), 'alpha beta alpha');
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const write = tools.find(tool => tool.name === 'write_file');
  const replace = tools.find(tool => tool.name === 'replace_in_file');

  assert.equal(parse(await write.execute('c1', { path: '.git/config', content: 'x' })).error, 'protected-path');
  assert.equal(parse(await replace.execute('c2', { path: 'app.txt', oldText: 'alpha', newText: 'gamma' })).error, 'ambiguous-match');
  assert.equal(parse(await replace.execute('c3', { path: 'app.txt', oldText: 'nope', newText: 'gamma' })).error, 'not-found-in-file');

  const replaced = parse(await replace.execute('c4', { path: 'app.txt', oldText: 'alpha', newText: 'gamma', all: true }));
  assert.equal(replaced.replacements, 2);
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'gamma beta gamma');
});

test('revoking a capability stops the next tool call', async t => {
  const { id, store: permissionStore } = await store(t, { capabilities: ['read', 'write'] });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const write = tools.find(tool => tool.name === 'write_file');
  await permissionStore.revoke(id);
  const result = parse(await write.execute('call-1', { path: 'x.txt', content: 'x' }));
  assert.equal(result.error, 'not-granted');
});

test('run_command runs in the project folder and reports the exit code', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read', 'exec'] });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const run = tools.find(tool => tool.name === 'run_command');

  const ok = parse(await run.execute('c1', { command: 'echo mova-check' }));
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /mova-check/);

  const cwd = parse(await run.execute('c2', { command: process.platform === 'win32' ? 'cd' : 'pwd' }));
  assert.equal(cwd.stdout.trim().toLowerCase(), root.toLowerCase());
});

test('argv reaches the program untouched, so inline scripts need no shell quoting', async t => {
  const { id, store: permissionStore } = await store(t, { capabilities: ['read', 'exec'] });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const run = tools.find(tool => tool.name === 'run_command');

  // Quotes, spaces, %, ! and a Chinese literal would each be reinterpreted by
  // cmd.exe; argv hands them to node -e verbatim.
  const script = 'console.log(JSON.stringify(["一 二", "\\"quoted\\"", "a%b!c"]))';
  const inline = parse(await run.execute('c1', { argv: [process.execPath, '-e', script] }));
  assert.equal(inline.exitCode, 0);
  assert.deepEqual(JSON.parse(inline.stdout), ['一 二', '"quoted"', 'a%b!c']);
  assert.equal(inline.encoding, 'utf-8');

  // Exactly one shape per call, and shell:false only makes sense with argv.
  assert.equal(parse(await run.execute('c2', { command: 'echo x', argv: ['echo', 'y'] })).error, 'invalid-arguments');
  assert.equal(parse(await run.execute('c3', { command: 'echo x', shell: false })).error, 'invalid-arguments');
  assert.equal(parse(await run.execute('c4', { argv: ['echo', 'y'], shell: true })).error, 'invalid-arguments');
  assert.equal(parse(await run.execute('c5', {})).error, 'invalid-arguments');
});

test('an oversized command says so instead of failing schema validation', async t => {
  const { id, store: permissionStore } = await store(t, { capabilities: ['read', 'exec'] });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const run = tools.find(tool => tool.name === 'run_command');

  // No `maxLength` in the schema: the rejection is ours, with a fix in it.
  const oversized = parse(await run.execute('c1', { command: `echo ${'a'.repeat(2100)}` }));
  assert.equal(oversized.error, 'command-too-long');
  assert.match(oversized.message, /2000/);
  assert.match(oversized.message, /argv/);
});

test('shell lines keep their quotes, including a quoted executable path', async t => {
  const { id, store: permissionStore } = await store(t, { capabilities: ['read', 'exec'] });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const run = tools.find(tool => tool.name === 'run_command');

  // cmd /s ate the outer quotes and node then parsed a mangled script: exit 0
  // with empty stdout. The line is now handed over wrapped, so both shapes work.
  const plain = parse(await run.execute('c1', { command: `"${process.execPath}" -e "console.log(2+2)"` }));
  assert.equal(plain.exitCode, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), '4', `stderr: ${plain.stderr}`);

  const inline = parse(await run.execute('c2', { command: `"${process.execPath}" -e "console.log('quoted')"` }));
  assert.equal(inline.stdout.trim(), 'quoted');

  if (process.platform === 'win32') {
    const chained = parse(await run.execute('c3', { command: 'echo BEFORE & echo AFTER' }));
    assert.match(chained.stdout, /BEFORE[\s\S]*AFTER/);
  }
});

test('huge stdout is capped with head and tail instead of flooding the context', async t => {
  const { id, store: permissionStore } = await store(t, { capabilities: ['read', 'exec'] });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const run = tools.find(tool => tool.name === 'run_command');

  // ~900 KB over 30k lines: the old cap let 64k characters through, which the
  // 40k tool-result budget then cut — losing the `truncated` flag itself.
  const script = 'for (let i = 0; i < 30000; i += 1) console.log(`line ${i} padding padding`)';
  const result = await run.execute('c1', { argv: [process.execPath, '-e', script] });
  const payload = parse(result);

  assert.equal(payload.exitCode, 0);
  assert.equal(payload.truncated, true);
  assert.ok(payload.stdout.length <= 8_200, `stdout was ${payload.stdout.length} characters`);
  assert.match(payload.stdout, /line 0 /, 'the head is kept');
  assert.match(payload.stdout, /line 29999 /, 'the tail is kept');
  assert.match(payload.stdout, /省略/);
  assert.ok(result.content[0].text.length < 40_000, 'the whole tool result stays inside the conversation budget');
});

test('list_files treats "." as the project folder', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read'] });
  await writeFile(join(root, 'a.txt'), 'a');
  await mkdir(join(root, 'src'), { recursive: true });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const list = tools.find(tool => tool.name === 'list_files');

  const omitted = parse(await list.execute('c1', {}));
  const dotted = parse(await list.execute('c2', { path: '.' }));
  const dottedSlash = parse(await list.execute('c3', { path: './' }));
  assert.equal(dotted.error, undefined, dotted.message);
  assert.deepEqual(dotted.entries, omitted.entries);
  assert.deepEqual(dottedSlash.entries, omitted.entries);

  // "." is the root; ".." is still an escape attempt.
  assert.equal(parse(await list.execute('c4', { path: '..' })).error, 'path-escape');
});

test('cmd output is transcoded from the console code page', async t => {
  if (process.platform !== 'win32') return t.skip('cmd built-ins only exist on Windows');
  const { stdout: chcp } = await execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp']);
  if (!/936/.test(chcp)) return t.skip('the console code page is not GBK here');

  const { id, store: permissionStore } = await store(t, { capabilities: ['read', 'exec'] });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const run = tools.find(tool => tool.name === 'run_command');

  // echo is a cmd built-in: it writes the OEM code page, not UTF-8.
  const echoed = parse(await run.execute('c1', { command: 'echo 中文编码测试' }));
  assert.equal(echoed.exitCode, 0);
  assert.match(echoed.stdout, /中文编码测试/);
  assert.equal(echoed.encoding, 'gbk');
});

test('permission IPC authorizes every channel and sanitizes errors', async t => {
  const { id, store: permissionStore } = await store(t, { capabilities: ['read'] });
  const denied = new Map();
  installPermissionsIpc(() => { throw new Error('sender path secret'); }, {
    store: permissionStore,
    ipcMain: { handle: (name, callback) => denied.set(name, callback) },
  });
  for (const channel of ['permissions:list', 'permissions:register', 'permissions:set', 'permissions:set-auto', 'permissions:revoke', 'permissions:reveal']) {
    assert.deepEqual(await denied.get(channel)({}, { folders: [] }), { ok: false, error: 'unauthorized' });
  }

  const allowed = new Map();
  installPermissionsIpc(() => ({}), {
    store: permissionStore,
    ipcMain: { handle: (name, callback) => allowed.set(name, callback) },
  });
  const listed = await allowed.get('permissions:list')({});
  assert.equal(listed.ok, true);
  assert.equal(listed.value.roots[0].capabilities.read, true);
  assert.deepEqual(
    await allowed.get('permissions:set')({}, { rootId: id, capability: 'network', value: true }),
    { ok: false, error: 'unknown-capability' },
  );
});

test('Windows-only spellings are rejected instead of silently retargeted', async t => {
  const { root } = await workspace(t);
  const write = async name => resolveInside(root, name, { allowMissing: true });
  await assert.rejects(write('a.txt:stream'), /invalid-path/, 'NTFS alternate data stream');
  if (process.platform === 'win32') {
    await assert.rejects(write('a.txt.'), /invalid-path/, 'Windows strips a trailing dot');
    await assert.rejects(write('dir /a'), /invalid-path/, 'Windows strips a trailing space');
    for (const name of ['CON', 'nul.txt', 'COM1', 'lpt9.log']) {
      await assert.rejects(write(name), /invalid-path/, `${name} is a device name`);
    }
    await assert.rejects(write('a:'), /invalid-path|absolute-path/);
  }
});

test('an unreadable permissions file is kept aside, not overwritten', async t => {
  const { base, id, store: permissionStore } = await store(t, { capabilities: ['read'] });
  const file = join(base, 'permissions.json');
  await writeFile(file, '{ not json');
  const corrupt = createPermissionStore({ filePath: file, confirm: async () => 'allow' });
  assert.deepEqual((await corrupt.list()).roots, []);
  const names = await readdir(base);
  assert.ok(names.some(name => name.startsWith('permissions.json.corrupt-')), 'the old file is preserved');
  assert.equal((await permissionStore.get(id)).capabilities.read, true, 'the live store keeps its state');
});

test('a failed save rolls back the in-memory grant instead of claiming it', async t => {
  const { base, root, id } = await store(t);
  const file = join(base, 'blocked.json');
  const blocked = createPermissionStore({ filePath: file, confirm: async () => 'allow' });
  await blocked.register([{ path: root }]);
  assert.equal((await blocked.get(id)).capabilities.read, false);
  // Put a directory where the store file belongs so every later save fails.
  await rm(file, { force: true });
  await mkdir(file);

  await assert.rejects(
    blocked.setCapability({ rootId: id, capability: 'read', value: true }),
    error => error instanceof PermissionError,
  );
  assert.equal((await blocked.get(id)).capabilities.read, false, 'memory does not keep an unsaved grant');
});

test('search_files finds lines, supports regex, and rejects a bad pattern', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read'] });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'app.ts'), 'const answer = 42;\nexport function run() {}\n');
  await writeFile(join(root, 'README.md'), '# Demo\nanswer is forty-two\n');
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const search = tools.find(tool => tool.name === 'search_files');

  const literal = parse(await search.execute('s1', { query: 'answer' }));
  assert.equal(literal.matches.length, 2);
  assert.deepEqual(literal.matches.map(hit => hit.path).sort(), ['README.md', 'src/app.ts']);

  const regex = parse(await search.execute('s2', { query: 'function\\s+\\w+', regex: true }));
  assert.equal(regex.matches.length, 1);
  assert.equal(regex.matches[0].text.includes('export function run'), true);

  const bad = parse(await search.execute('s3', { query: '([', regex: true }));
  assert.equal(bad.error, 'invalid-arguments');

  const redos = parse(await search.execute('s4', { query: '(a+)+$', regex: true }));
  assert.equal(redos.error, 'invalid-arguments');
  assert.match(redos.message, /回溯爆炸/);
});

test('git_status and git_diff report a dirty tree without approval', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read'] });
  const run = async (command, args) => execFileAsync(command, args, { cwd: root });
  try {
    await run('git', ['init', '-q']);
    await run('git', ['config', 'user.email', 'test@example.com']);
    await run('git', ['config', 'user.name', 'Test']);
    await writeFile(join(root, 'tracked.txt'), 'one\n');
    await run('git', ['add', '.']);
    await run('git', ['commit', '-qm', 'init']);
  } catch {
    t.skip('git is not available');
    return;
  }
  await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n');
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });

  const status = parse(await tools.find(tool => tool.name === 'git_status').execute('g1', {}));
  assert.equal(status.clean, false);
  assert.equal(status.entries[0].path, 'tracked.txt');

  const diff = parse(await tools.find(tool => tool.name === 'git_diff').execute('g2', {}));
  assert.match(diff.diff, /\+two/);
});

test('write history allows undoing a change by id', async t => {
  const { base, root, id, store: permissionStore } = await store(t, { capabilities: ['read', 'write'], confirm: () => 'once' });
  const historyDir = join(base, 'history');
  await writeFile(join(root, 'note.txt'), 'original');
  const tools = createProjectTools({
    permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {}, historyDir,
  });
  const replace = tools.find(tool => tool.name === 'replace_in_file');
  const changed = parse(await replace.execute('c1', { path: 'note.txt', oldText: 'original', newText: 'changed' }));
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'changed');
  assert.ok(changed.changeId);

  const undone = parse(await tools.find(tool => tool.name === 'undo_change').execute('c2', { changeId: changed.changeId }));
  assert.equal(undone.restored, true);
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'original');

  const listed = parse(await tools.find(tool => tool.name === 'list_changes').execute('c3', { limit: 5 }));
  assert.ok(listed.changes.length >= 2);
});

test('one run has no per-run write counter, only the output budget stays', async t => {
  const { root, id, store: permissionStore } = await store(t, { capabilities: ['read', 'write'], confirm: () => 'once' });
  const tools = createProjectTools({ permissions: permissionStore, roots: [await permissionStore.get(id)], emit: () => {} });
  const write = tools.find(tool => tool.name === 'write_file');
  // Calls used to stop at 20 writes per run. The counter is gone on purpose:
  // a long refactor must not die halfway, and every write still needs approval.
  for (let index = 0; index < 25; index += 1) {
    const result = parse(await write.execute(`w${index}`, { path: `f${index}.txt`, content: 'x' }));
    assert.equal(result.error, undefined, `write ${index} should pass`);
  }
  const names = await readdir(root);
  assert.equal(names.length, 25);
  assert.equal(names.includes('f24.txt'), true);
});

test('renderer-initiated registration needs a native confirmation', async t => {
  const { base } = await workspace(t);
  const extra = join(base, 'extra');
  await mkdir(extra);
  const decisions = [];
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => { decisions.push(request); return 'deny'; },
  });
  const handlers = new Map();
  installPermissionsIpc(() => ({}), {
    store: permissionStore,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  });
  const refused = await handlers.get('permissions:register')({}, { folders: [{ path: extra }] });
  assert.deepEqual(refused, { ok: false, error: 'denied' });
  assert.equal(decisions[0].mode, 'grant');
  assert.deepEqual((await permissionStore.list()).roots, []);

  const picker = await permissionStore.register([{ path: extra }]);
  assert.equal(picker.roots.length, 1, 'the trusted picker path registers without a dialog');
  await access(extra);
});

/** A store holding one folder that is already granted read, write and auto-accept. */
async function grantedFolder(t, retention) {
  const { base, root } = await workspace(t);
  const requests = [];
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => {
      requests.push(request);
      // The grant itself always succeeds; only re-registration is under test.
      return request.title === '保留之前授予的权限？' ? retention : 'allow';
    },
  });
  const id = canonicalPath(root).id;
  await permissionStore.register([{ path: root }]);
  await permissionStore.setCapability({ rootId: id, capability: 'read', value: true });
  await permissionStore.setCapability({ rootId: id, capability: 'write', value: true });
  await permissionStore.setAutoAccept({ rootId: id, capability: 'write', value: true });
  requests.length = 0;
  return { root, id, store: permissionStore, requests };
}

test('re-registering a granted folder resets its grants when the user refuses', async t => {
  const { root, id, store: permissionStore, requests } = await grantedFolder(t, 'deny');
  await permissionStore.register([{ path: root }]);

  assert.equal(requests.length, 1, 'old grants are never inherited silently');
  assert.equal(requests[0].mode, 'grant');
  assert.equal(requests[0].title, '保留之前授予的权限？');
  assert.equal(requests[0].detail.includes(root), true, 'the dialog shows the real folder');
  const kept = await permissionStore.get(id);
  assert.deepEqual(kept.capabilities, { read: false, write: false, exec: false });
  assert.deepEqual(kept.autoAccept, { write: false, exec: false });
});

test('re-registering a granted folder keeps the grants only on an explicit allow', async t => {
  for (const decision of ['allow', 'once', 'session']) {
    const { root, id, store: permissionStore } = await grantedFolder(t, decision);
    await permissionStore.register([{ path: root }]);
    const kept = await permissionStore.get(id);
    if (decision === 'allow') {
      assert.deepEqual(kept.capabilities, { read: true, write: true, exec: false });
      assert.deepEqual(kept.autoAccept, { write: true, exec: false });
    } else {
      assert.deepEqual(kept.capabilities, { read: false, write: false, exec: false }, decision);
      assert.deepEqual(kept.autoAccept, { write: false, exec: false }, decision);
    }
  }
});

test('re-registering a folder without grants asks nothing', async t => {
  const { base, root } = await workspace(t);
  const requests = [];
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => { requests.push(request); return 'allow'; },
  });
  await permissionStore.register([{ path: root }]);
  await permissionStore.register([{ path: root }]);
  assert.deepEqual(requests, []);
  assert.equal((await permissionStore.list()).roots.length, 1);
});

test('permissions:forget removes a root and authorizes the sender', async t => {
  const { base, root } = await workspace(t);
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async () => 'allow',
  });
  const id = canonicalPath(root).id;
  await permissionStore.register([{ path: root }]);
  await permissionStore.setCapability({ rootId: id, capability: 'read', value: true });

  const denied = new Map();
  installPermissionsIpc(() => { throw new Error('untrusted'); }, {
    store: permissionStore,
    ipcMain: { handle: (name, callback) => denied.set(name, callback) },
  });
  assert.deepEqual(await denied.get('permissions:forget')({}, id), { ok: false, error: 'unauthorized' });
  assert.equal((await permissionStore.list()).roots.length, 1);

  const handlers = new Map();
  installPermissionsIpc(() => ({}), {
    store: permissionStore,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  });
  const result = await handlers.get('permissions:forget')({}, id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.roots, []);
  assert.deepEqual((await permissionStore.list()).roots, []);
});

test('authorize passes the run signal through to the confirmation', async t => {
  const { base, root } = await workspace(t);
  const requests = [];
  const permissionStore = createPermissionStore({
    filePath: join(base, 'permissions.json'),
    confirm: async request => {
      requests.push(request);
      return request.mode === 'grant' ? 'allow' : 'once';
    },
  });
  const id = canonicalPath(root).id;
  await permissionStore.register([{ path: root }]);
  await permissionStore.setCapability({ rootId: id, capability: 'read', value: true });
  await permissionStore.setCapability({ rootId: id, capability: 'write', value: true });
  requests.length = 0;

  const controller = new AbortController();
  const result = await permissionStore.authorize({
    rootId: id, capability: 'write', sessionKey: 'run-1', signal: controller.signal,
  });
  assert.deepEqual(result, { ok: true, via: 'once' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, 'approval');
  assert.equal(requests[0].signal, controller.signal);
  // The in-app bar needs the opaque root id to look up a file afterwards; the
  // root id is not a path, so sending it to the renderer adds no new capability.
  assert.equal(requests[0].rootId, id);
  assert.equal(requests[0].rootName, 'project');
});
