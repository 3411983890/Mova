import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createFilesView } from '../electron/files-view.cjs';

const ROOT_ID = 'project-mova';

/**
 * A temporary project root plus the fake collaborators the module takes: a
 * permission store that ignores the root id and a shell that records paths.
 */
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mova-files-view-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const opens = [];
  const permissions = options.permissions ?? {
    get: async rootId => (rootId === ROOT_ID
      ? { id: ROOT_ID, path: base, name: 'mova', capabilities: { read: true, write: false, exec: false } }
      : null),
  };
  const shell = {
    openPath: async target => {
      opens.push(target);
      return options.openError ?? '';
    },
  };
  const view = createFilesView({ permissions, shell });
  return { base, view, opens, shell };
}

test('list puts directories first, sorts by name and hides only .git', async t => {
  const { base, view } = await fixture(t);
  await mkdir(join(base, 'src'));
  await mkdir(join(base, '.git'));
  await writeFile(join(base, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(base, 'z.txt'), 'zz');
  await writeFile(join(base, 'a.txt'), 'a');
  await writeFile(join(base, 'b markdown.md'), '# hi');

  const result = await view.list({ rootId: ROOT_ID, path: '' });
  assert.deepEqual(result.entries.map(entry => entry.name), ['src', 'a.txt', 'b markdown.md', 'z.txt']);
  assert.equal(result.entries[0].type, 'dir');
  assert.equal(result.entries[0].size, 0);
  assert.equal(result.entries[1].type, 'file');
  assert.equal(result.entries[1].size, 1);
  assert.equal(typeof result.entries[1].mtime, 'number');
  assert.equal(result.path, '');
  assert.equal(result.truncated, false);
  assert.equal(result.skippedLinks, 0);
  assert.equal(result.total, 4);

  const nested = await view.list({ rootId: ROOT_ID, path: 'src' });
  assert.equal(nested.path, 'src');
  assert.deepEqual(nested.entries, []);
  assert.equal(nested.total, 0);
});

test('list rejects escaping and non-relative paths', async t => {
  const { base, view } = await fixture(t);
  await writeFile(join(base, 'a.txt'), 'a');
  const cases = [
    ['../outside.txt', 'path-escape'],
    ['src/../../outside.txt', 'path-escape'],
    ['C:\\Windows\\win.ini', 'absolute-path'],
    ['C:relative.txt', 'absolute-path'],
    ['/etc/passwd', 'absolute-path'],
    ['a.txt:stream', 'invalid-path'],
  ];
  for (const [bad, code] of cases) {
    await assert.rejects(view.list({ rootId: ROOT_ID, path: bad }), error => error.code === code, `${bad} should be rejected`);
    await assert.rejects(view.stat({ rootId: ROOT_ID, path: bad }), error => error.code === code, `${bad} should be rejected`);
  }
  await assert.rejects(view.list({ rootId: ROOT_ID, path: 42 }), error => error.code === 'invalid-path');
  await assert.rejects(view.list({ rootId: 'missing-root', path: '' }), error => error.code === 'not-registered');
});

test('list caps a directory at 1000 entries and reports the true total', async t => {
  const { base, view } = await fixture(t);
  const batch = [];
  for (let index = 0; index < 1005; index += 1) {
    batch.push(writeFile(join(base, `file${String(index).padStart(4, '0')}.txt`), ''));
    if (batch.length === 100) await Promise.all(batch.splice(0));
  }
  await Promise.all(batch);

  const result = await view.list({ rootId: ROOT_ID, path: '' });
  assert.equal(result.entries.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 1005);
  assert.equal(result.skippedLinks, 0);
  assert.match(result.entries[0].name, /^file\d{4}\.txt$/);
  assert.match(result.entries.at(-1).name, /^file\d{4}\.txt$/);
  assert.equal(result.entries[0].size, 0);
});

test('list skips symbolic links instead of following them', async t => {
  const { base, view } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'mova-files-view-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await writeFile(join(base, 'real.txt'), 'real');
  try {
    await symlink(join(outside, 'secret.txt'), join(base, 'link.txt'), 'file');
  } catch (error) {
    t.skip(`symlinks are unavailable here (${error.code})`);
    return;
  }

  const result = await view.list({ rootId: ROOT_ID, path: '' });
  assert.deepEqual(result.entries.map(entry => entry.name), ['real.txt']);
  assert.equal(result.skippedLinks, 1);
  assert.equal(result.total, 1);
  await assert.rejects(view.read({ rootId: ROOT_ID, path: 'link.txt' }), error => error.code === 'path-escape');
});

test('read decodes UTF-8 text with a line count', async t => {
  const { base, view } = await fixture(t);
  await writeFile(join(base, 'notes.md'), '# 标题\n第二行\n');
  const result = await view.read({ rootId: ROOT_ID, path: 'notes.md' });
  assert.equal(result.kind, 'text');
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, '# 标题\n第二行\n');
  assert.equal(result.lines, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.bytes, Buffer.byteLength('# 标题\n第二行\n'));
  assert.equal(result.mime, 'text/markdown');
  assert.equal(result.base64, undefined);
});

test('read falls back to GBK when the bytes are not valid UTF-8', async t => {
  const { base, view } = await fixture(t);
  await writeFile(join(base, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  const result = await view.read({ rootId: ROOT_ID, path: 'gbk.txt' });
  assert.equal(result.encoding, 'gbk');
  assert.equal(result.text, '中文');
  assert.equal(result.kind, 'text');
});

test('read truncates at maxBytes without mistaking a split character for GBK', async t => {
  const { base, view } = await fixture(t);
  const text = '中'.repeat(100);
  await writeFile(join(base, 'long.txt'), text, 'utf8');
  const result = await view.read({ rootId: ROOT_ID, path: 'long.txt', maxBytes: 100 });
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.truncated, true);
  assert.equal(result.text, '中'.repeat(33));
  assert.equal(result.bytes, 300);

  const whole = await view.read({ rootId: ROOT_ID, path: 'long.txt' });
  assert.equal(whole.truncated, false);
  assert.equal(whole.text, text);
});

test('read reports binary files with a 2KB preview', async t => {
  const { base, view } = await fixture(t);
  const payload = Buffer.alloc(5000, 7);
  payload[0] = 0;
  await writeFile(join(base, 'blob.bin'), payload);
  const binary = await view.read({ rootId: ROOT_ID, path: 'blob.bin' });
  assert.equal(binary.kind, 'binary');
  assert.equal(binary.bytes, 5000);
  assert.equal(binary.truncated, true);
  assert.equal(Buffer.from(binary.base64, 'base64').length, 2048);
  assert.equal(binary.text, undefined);

  // A NUL byte inside a "text" extension still means binary.
  await writeFile(join(base, 'fake.txt'), Buffer.from([0x41, 0x00, 0x42]));
  const fake = await view.read({ rootId: ROOT_ID, path: 'fake.txt' });
  assert.equal(fake.kind, 'binary');
  assert.equal(fake.bytes, 3);
  assert.equal((await view.stat({ rootId: ROOT_ID, path: 'fake.txt' })).kind, 'binary');
});

test('read refuses oversized images and non-files', async t => {
  const { base, view } = await fixture(t);
  await writeFile(join(base, 'huge.png'), Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(view.read({ rootId: ROOT_ID, path: 'huge.png' }), error => error.code === 'too-large');
  await assert.rejects(view.read({ rootId: ROOT_ID, path: 'missing.txt' }), error => error.code === 'not-found');
  await mkdir(join(base, 'src'));
  await assert.rejects(view.read({ rootId: ROOT_ID, path: 'src' }), error => error.code === 'not-a-file');
});

test('stat maps extensions onto the renderer kinds', async t => {
  const { base, view } = await fixture(t);
  const files = {
    'a.md': ['markdown', '.md', 'text/markdown'],
    'a.mdx': ['markdown', '.mdx', 'text/markdown'],
    'a.tsx': ['code', '.tsx', 'text/typescript'],
    'a.json': ['code', '.json', 'application/json'],
    'a.css': ['code', '.css', 'text/css'],
    'a.py': ['code', '.py', 'text/x-python'],
    'a.txt': ['text', '.txt', 'text/plain'],
    'a.log': ['text', '.log', 'text/plain'],
    '.gitignore': ['text', '', 'text/plain'],
    'a.png': ['image', '.png', 'image/png'],
    'a.svg': ['image', '.svg', 'image/svg+xml'],
    'a.pdf': ['pdf', '.pdf', 'application/pdf'],
    'build.mk': ['text', '.mk', 'text/x-makefile'],
    'CMakeLists.cmake': ['text', '.cmake', 'text/x-cmake'],
  };
  for (const name of Object.keys(files)) await writeFile(join(base, name), 'x');

  for (const [name, [kind, ext, mime]] of Object.entries(files)) {
    const result = await view.stat({ rootId: ROOT_ID, path: name });
    assert.equal(result.kind, kind, `${name} kind`);
    assert.equal(result.ext, ext || extname(name).toLowerCase(), `${name} ext`);
    assert.equal(result.mime, mime, `${name} mime`);
    assert.equal(result.type, 'file');
    assert.equal(result.size, 1);
    assert.equal(typeof result.mtime, 'number');
  }

  await mkdir(join(base, 'src'));
  const directory = await view.stat({ rootId: ROOT_ID, path: 'src' });
  assert.deepEqual(directory, { type: 'dir', size: 0, mtime: directory.mtime, ext: '', mime: '', kind: 'dir' });
  await assert.rejects(view.stat({ rootId: ROOT_ID, path: 'nope.txt' }), error => error.code === 'not-found');
});

test('unknown extensions are sniffed instead of assumed binary', async t => {
  const { base, view } = await fixture(t);
  // Extension-less project files: text by name.
  const named = [
    ['LICENSE', 'MIT License\n\nCopyright (c) 2026 Mova\n'],
    ['Makefile', 'all:\n\t@echo hi\n'],
    ['Dockerfile', 'FROM node:20\n'],
    ['Dockerfile.dev', 'FROM node:20\n'],
    ['README', '# Mova\n'],
    ['CHANGELOG', '## 0.1.0\n'],
    ['AUTHORS', 'Mova\n'],
    ['build.mk', 'all:\n'],
    ['CMakeLists.cmake', 'project(mova)\n'],
  ];
  for (const [name, body] of named) {
    await writeFile(join(base, name), body, 'utf8');
    const meta = await view.stat({ rootId: ROOT_ID, path: name });
    assert.equal(meta.kind, 'text', `${name} stat kind`);
    assert.match(meta.mime, /^text\//, `${name} mime`);
    const loaded = await view.read({ rootId: ROOT_ID, path: name });
    assert.equal(loaded.kind, 'text', `${name} read kind`);
    assert.equal(loaded.text, body, `${name} text`);
    assert.equal(loaded.encoding, 'utf-8', `${name} encoding`);
  }

  // No extension at all, readable UTF-8: sniffed as text, stat and read agree.
  await writeFile(join(base, 'notes'), 'hello 世界\nsecond line\n', 'utf8');
  const unknown = await view.stat({ rootId: ROOT_ID, path: 'notes' });
  assert.equal(unknown.kind, 'text');
  assert.equal(unknown.mime, 'text/plain');
  assert.equal(unknown.ext, '');
  const unknownBody = await view.read({ rootId: ROOT_ID, path: 'notes' });
  assert.equal(unknownBody.kind, 'text');
  assert.equal(unknownBody.text, 'hello 世界\nsecond line\n');
  assert.equal(unknownBody.lines, 2);

  // No extension and a NUL byte: binary in both calls, preview capped at 2KB.
  await writeFile(join(base, 'assets'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  assert.equal((await view.stat({ rootId: ROOT_ID, path: 'assets' })).kind, 'binary');
  const binaryBody = await view.read({ rootId: ROOT_ID, path: 'assets' });
  assert.equal(binaryBody.kind, 'binary');
  assert.equal(binaryBody.bytes, 4);
  assert.equal(Buffer.from(binaryBody.base64, 'base64').length, 4);

  // No extension and GBK bytes: text, decoded with the GBK fallback.
  await writeFile(join(base, '说明'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  assert.equal((await view.stat({ rootId: ROOT_ID, path: '说明' })).kind, 'text');
  const gbk = await view.read({ rootId: ROOT_ID, path: '说明' });
  assert.equal(gbk.kind, 'text');
  assert.equal(gbk.encoding, 'gbk');
  assert.equal(gbk.text, '中文');

  // An empty file with no extension is still text.
  await writeFile(join(base, 'EMPTY'), '');
  assert.equal((await view.stat({ rootId: ROOT_ID, path: 'EMPTY' })).kind, 'text');
  assert.equal((await view.read({ rootId: ROOT_ID, path: 'EMPTY' })).text, '');
});

test('openDir only opens folders', async t => {
  const { base, view, opens } = await fixture(t);
  await mkdir(join(base, 'src'));
  await writeFile(join(base, 'a.txt'), 'a');

  const result = await view.openDir({ rootId: ROOT_ID, path: '' });
  assert.deepEqual(result, { opened: true });
  assert.deepEqual(opens, [base]);

  await view.openDir({ rootId: ROOT_ID, path: 'src' });
  assert.equal(opens.at(-1), join(base, 'src'));

  await assert.rejects(view.openDir({ rootId: ROOT_ID, path: 'a.txt' }), error => error.code === 'not-a-directory');
  await assert.rejects(view.openDir({ rootId: ROOT_ID, path: 'missing' }), error => error.code === 'not-found');

  const failing = await fixture(t, { openError: '找不到该文件夹' });
  await assert.rejects(failing.view.openDir({ rootId: ROOT_ID, path: '' }), error => error.code === 'open-failed');
});

test('a root without the read capability is refused', async t => {
  const { view } = await fixture(t, {
    permissions: { get: async () => ({ id: ROOT_ID, path: tmpdir(), capabilities: { read: false } }) },
  });
  await assert.rejects(view.list({ rootId: ROOT_ID, path: '' }), error => error.code === 'not-granted');
  await assert.rejects(view.openDir({ rootId: ROOT_ID, path: '' }), error => error.code === 'not-granted');
});
