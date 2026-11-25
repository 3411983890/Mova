import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIR, FILE, WEB, breadcrumbOf, codeLanguageOf, createLocationHistory, describeFilesError,
  directoryOf, editValueOf, entryIcon, entryMeta, extensionOf, foldBreadcrumb, formatSize,
  formatTime, joinPath, kindIcon, kindOfFile, labelOf, normalizeLocation, normalizePath,
  normalizeUrl, parentPath, rootNameOf, sameLocation, splitAnchor, truncateMiddle, truncateText,
} from '../src/features/browser/location.js';

test('normalizePath keeps relative paths and rejects anything that escapes the root', () => {
  assert.equal(normalizePath('src/app.js'), 'src/app.js');
  assert.equal(normalizePath('src\\app.js'), 'src/app.js');
  assert.equal(normalizePath('./src//app.js'), 'src/app.js');
  assert.equal(normalizePath('  docs/x.md  '), 'docs/x.md');
  assert.equal(normalizePath(''), '', 'root is the empty string, never "."');
  for (const bad of ['/etc/passwd', 'C:\\Windows', '\\\\server\\share', '..', '../x', 'src/../../x', 'a\u0000b', 'src/a.txt:stream', 'https://example.com']) {
    assert.equal(normalizePath(bad), null, bad);
  }
});

test('joinPath resolves relative links against the current folder', () => {
  assert.equal(joinPath('', 'README.md'), 'README.md');
  assert.equal(joinPath('src', './app.js'), 'src/app.js');
  assert.equal(joinPath('src/lib', '../index.ts'), 'src/index.ts');
  assert.equal(joinPath('docs', 'img/x.png'), 'docs/img/x.png');
  assert.equal(joinPath('', '../outside'), null);
  assert.equal(joinPath('src', '../../../etc/passwd'), null);
  assert.equal(joinPath('src', 'C:/x'), null);
  assert.equal(directoryOf('src/app.js'), 'src');
  assert.equal(directoryOf('app.js'), '');
  assert.equal(parentPath('src/app.js'), 'src');
  assert.equal(parentPath('src'), '');
  assert.equal(parentPath(''), null);
  assert.equal(extensionOf('src/App.TSX'), '.tsx');
  assert.equal(extensionOf('.gitignore'), '');
});

test('splitAnchor understands #L12 and :42 but leaves scheme URLs alone', () => {
  assert.deepEqual(splitAnchor('src/app.js#L12'), { path: 'src/app.js', line: 12 });
  assert.deepEqual(splitAnchor('src/app.js#L12-L20'), { path: 'src/app.js', line: 12 });
  assert.deepEqual(splitAnchor('src/app.js:42'), { path: 'src/app.js', line: 42 });
  assert.deepEqual(splitAnchor('https://example.com:8080/x'), { path: 'https://example.com:8080/x', line: 0 });
  assert.deepEqual(splitAnchor('README.md'), { path: 'README.md', line: 0 });
});

test('normalizeUrl allows http(s), bare hosts, and explicit file:// (local preview)', () => {
  assert.equal(normalizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('localhost:3000'), 'https://localhost:3000/'.replace('localhost', 'localhost'), 'host:port still parses');
  // 本地预览：只有显式 file:// 才算 URL；裸路径仍然去文件查看器看源码。
  assert.equal(normalizeUrl('file:///C:/Users/me/design/index.html'), 'file:///C:/Users/me/design/index.html');
  // `file:///etc` 语法合法（Windows 上会落到 C:/etc），安全性由主进程的「已登记项目根」判定负责，
  // 渲染层不重复实现那套规则。
  for (const bad of ['javascript:alert(1)', 'mailto:a@b.c', 'data:text/html,x', 'blob:https://x/y',
    'file://server/share/a.html', 'file:///', 'not a url', '']) {
    assert.equal(normalizeUrl(bad), null, bad);
  }
});

test('normalizeLocation produces the web/file/dir model and drops junk', () => {
  assert.deepEqual(normalizeLocation({ kind: 'web', url: 'https://example.com' }), { kind: WEB, url: 'https://example.com/' });
  assert.deepEqual(normalizeLocation({ kind: 'url', url: 'example.com' }), { kind: WEB, url: 'https://example.com/' });
  assert.deepEqual(normalizeLocation({ kind: FILE, rootId: 'root-1', path: 'src/app.js' }), { kind: FILE, rootId: 'root-1', path: 'src/app.js' });
  assert.deepEqual(normalizeLocation({ kind: FILE, rootId: 'root-1', path: 'a.md#L12' }), { kind: FILE, rootId: 'root-1', path: 'a.md', line: 12 });
  assert.deepEqual(normalizeLocation({ kind: 'dir', rootId: 'root-1', path: '' }), { kind: DIR, rootId: 'root-1', path: '' });
  assert.equal(normalizeLocation({ kind: FILE, rootId: '', path: 'a.js' }), null, 'rootId is required');
  assert.equal(normalizeLocation({ kind: FILE, rootId: 'r', path: '../a.js' }), null);
  assert.equal(normalizeLocation({ kind: 'weird', url: 'https://x.test' }), null);
  assert.equal(normalizeLocation(null), null);
  assert.ok(sameLocation(normalizeLocation({ kind: FILE, rootId: 'r', path: 'a.js' }), { kind: FILE, rootId: 'r', path: 'a.js' }));
  assert.ok(!sameLocation({ kind: FILE, rootId: 'r', path: 'a.js', line: 3 }, { kind: FILE, rootId: 'r', path: 'a.js' }));
});

test('extension → renderer kind matches the main-process stat().kind', () => {
  const cases = {
    'README.md': 'markdown', 'doc.mdx': 'markdown', 'x.markdown': 'markdown',
    'src/app.tsx': 'code', 'main.js': 'code', 'a.json': 'code', 'style.scss': 'code',
    'index.html': 'code', 'main.py': 'code', 'lib.rs': 'code', 'a.cpp': 'code', 'q.sql': 'code',
    'notes.txt': 'text', 'debug.log': 'text', '.gitignore': 'text', '.editorconfig': 'text', '.env': 'text', '.env.local': 'text',
    'logo.PNG': 'image', 'icon.svg': 'image', 'pic.avif': 'image',
    'paper.pdf': 'pdf',
    'archive.zip': 'binary', 'no-extension': 'binary', 'blob.bin': 'binary',
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(kindOfFile(name), expected, name);
});

test('code language mapping only points at grammars that are actually bundled', () => {
  assert.deepEqual(codeLanguageOf('src/app.ts'), { id: 'tsx', label: 'ts' });
  assert.deepEqual(codeLanguageOf('src/app.tsx'), { id: 'tsx', label: 'tsx' });
  assert.deepEqual(codeLanguageOf('src/app.js'), { id: 'javascript', label: 'js' });
  assert.deepEqual(codeLanguageOf('style.scss'), { id: 'css', label: 'scss' });
  assert.deepEqual(codeLanguageOf('main.py'), { id: 'python', label: 'python' });
  assert.deepEqual(codeLanguageOf('a.cpp'), { id: 'c', label: 'cpp' }, 'C++ falls back to the C grammar');
  assert.equal(codeLanguageOf('notes.md'), null, 'markdown is never rendered as code');
  assert.equal(codeLanguageOf('file.kt'), null);
  assert.equal(codeLanguageOf('README'), null);
});

test('location and entry icons stay in the shell icon vocabulary', () => {
  assert.equal(kindIcon(WEB), 'globe');
  assert.equal(kindIcon(FILE), 'file');
  assert.equal(kindIcon(DIR), 'folder');
  assert.equal(kindIcon(undefined), 'file');
  assert.equal(entryIcon({ name: 'src', type: 'dir' }), 'folder');
  assert.equal(entryIcon({ name: 'a.md', type: 'file' }), 'file-text');
  assert.equal(entryIcon({ name: 'a.ts', type: 'file' }), 'file-code');
  assert.equal(entryIcon({ name: 'a.png', type: 'file' }), 'file-image');
  assert.equal(entryIcon({ name: 'a.pdf', type: 'file' }), 'file');
});

test('breadcrumbs mark the last segment current and make ancestors navigable directories', () => {
  const roots = [{ id: 'r1', name: 'Mova' }];
  const crumbs = breadcrumbOf({ kind: FILE, rootId: 'r1', path: 'src/app/main.ts' }, { roots });
  assert.deepEqual(crumbs.map(crumb => crumb.label), ['Mova', 'src', 'app', 'main.ts']);
  assert.deepEqual(crumbs.map(crumb => crumb.current), [false, false, false, true]);
  assert.deepEqual(crumbs[0].loc, { kind: DIR, rootId: 'r1', path: '' });
  assert.deepEqual(crumbs[1].loc, { kind: DIR, rootId: 'r1', path: 'src' });
  assert.deepEqual(crumbs[2].loc, { kind: DIR, rootId: 'r1', path: 'src/app' });
  assert.deepEqual(crumbs[3].loc, { kind: FILE, rootId: 'r1', path: 'src/app/main.ts' });

  const dirCrumbs = breadcrumbOf({ kind: DIR, rootId: 'r1', path: 'src' }, { rootName: 'Mova' });
  assert.deepEqual(dirCrumbs.map(crumb => [crumb.label, crumb.current]), [['Mova', false], ['src', true]]);

  const rootCrumbs = breadcrumbOf({ kind: DIR, rootId: 'r1', path: '' }, { rootName: 'Mova' });
  assert.deepEqual(rootCrumbs.map(crumb => [crumb.label, crumb.current]), [['Mova', true]]);

  assert.equal(rootNameOf({ kind: FILE, rootId: 'r1', path: 'a.js' }, roots), 'Mova');
  assert.equal(labelOf({ kind: FILE, rootId: 'r1', path: 'src/a.js' }, { roots }), 'Mova/src/a.js');
  assert.equal(labelOf({ kind: WEB, url: 'https://example.com/x' }), 'https://example.com/x');
  assert.equal(editValueOf({ kind: FILE, rootId: 'r1', path: 'src/a.js', line: 12 }), 'src/a.js#L12');
});

test('foldBreadcrumb keeps the root and the last segment and folds from the left', () => {
  const crumbs = breadcrumbOf({ kind: FILE, rootId: 'r1', path: 'src/app/components/button.tsx' }, { rootName: 'Mova' });
  const wide = foldBreadcrumb(crumbs, 200);
  assert.equal(wide.hidden.length, 0);
  assert.equal(wide.visible.length, 5);

  const narrow = foldBreadcrumb(crumbs, 18);
  assert.ok(narrow.hidden.length > 0, 'middle segments collapse');
  assert.equal(narrow.visible[0].crumb.label, 'Mova');
  assert.equal(narrow.visible[narrow.visible.length - 1].crumb.label, 'button.tsx');
  assert.equal(narrow.visible[1].type, 'ellipsis');
  assert.deepEqual(narrow.hidden.map(crumb => crumb.label), ['src', 'app', 'components']);

  const even = foldBreadcrumb(crumbs, 30);
  assert.equal(even.visible[0].crumb.label, 'Mova');
  assert.equal(even.visible[even.visible.length - 1].crumb.label, 'button.tsx');
  assert.ok(even.hidden.every(crumb => crumb.label !== 'button.tsx'));

  assert.deepEqual(foldBreadcrumb([], 20).visible, []);
  assert.equal(foldBreadcrumb([{ label: 'a' }, { label: 'b' }], 1).hidden.length, 0, 'two segments never fold');
});

test('truncation helpers never lose the whole name', () => {
  assert.equal(truncateMiddle('short', 24), 'short');
  const middle = truncateMiddle('a-very-long-directory-name-here', 12);
  assert.ok(middle.length <= 12);
  assert.ok(middle.includes('…'));
  assert.ok(middle.startsWith('a-very'));
  assert.equal(truncateText('abc', 10), 'abc');
  assert.equal(truncateText('abcdefghij', 5), 'abcd…');
});

test('sizes, times and error copy are display-ready', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(20 * 1024 * 1024), '20 MB');
  assert.match(formatTime(Date.now()), /^\d{2}:\d{2}$/);
  assert.match(formatTime(Date.now() - 500 * 24 * 3600 * 1000), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatTime(null), '');
  assert.equal(entryMeta({ name: 'src', type: 'dir', size: 0, mtime: null }), '', 'directories show no time');
  assert.match(entryMeta({ name: 'a.js', type: 'file', size: 2048, mtime: Date.now() }), /^2\.0 KB · \d{2}:\d{2}$/);
  assert.match(describeFilesError('no-read'), /没有读取权限/);
  assert.match(describeFilesError('not-found'), /不存在/);
  assert.equal(describeFilesError('weird', '自定义失败'), '自定义失败');
});

test('location history is per tab: push truncates forward entries, replace keeps the cursor', () => {
  const history = createLocationHistory();
  assert.equal(history.current(), null);
  assert.equal(history.back(), null);
  history.push({ kind: WEB, url: 'https://a.test' });
  history.push({ kind: FILE, rootId: 'r1', path: 'a.js' });
  history.push({ kind: DIR, rootId: 'r1', path: 'src' });
  assert.equal(history.index, 2);
  assert.equal(history.current().kind, DIR);

  assert.equal(history.back().path, 'a.js');
  assert.equal(history.canForward(), true);
  assert.equal(history.forward().path, 'src');
  assert.equal(history.forward(), null);

  history.back();
  history.push({ kind: FILE, rootId: 'r1', path: 'b.js' });
  assert.equal(history.index, 2);
  assert.equal(history.canForward(), false, 'pushing after back drops the forward branch');
  history.replace({ kind: FILE, rootId: 'r1', path: 'c.js' });
  assert.equal(history.index, 2);
  assert.equal(history.current().path, 'c.js');
  assert.equal(history.push({ kind: 'nonsense' }), null, 'invalid locations are ignored');
});
