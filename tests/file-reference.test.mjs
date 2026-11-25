import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expandFileRefs,
  fileRefHref,
  isFilePath,
  parseFileRefHref,
  splitFileAnchor,
  withFileAnchor,
} from '../src/features/chat/file-reference.js';

test('file paths are recognised, commands and URLs are not', () => {
  for (const value of ['src/app.tsx', './src/app.tsx:12', 'docs/x.md#L7', 'README.md', 'a/b/c.json', 'scripts/build.mjs']) {
    assert.equal(isFilePath(value), true, value);
  }
  for (const value of ['npm run dev', 'https://example.com/a.ts', '/etc/passwd', 'C:\\tmp\\a.ts', '../a.ts', 'src/app', 'foo.unknown-ext', 'a b.ts', '']) {
    assert.equal(isFilePath(value), false, value);
  }
});

test('anchors split from paths and come back', () => {
  assert.deepEqual(splitFileAnchor('src/app.tsx#L12'), { path: 'src/app.tsx', line: 12 });
  assert.deepEqual(splitFileAnchor('src/app.tsx:7'), { path: 'src/app.tsx', line: 7 });
  assert.deepEqual(splitFileAnchor('src/app.tsx'), { path: 'src/app.tsx', line: 0 });
  assert.equal(withFileAnchor('src/app.tsx', 12), 'src/app.tsx#L12');
  assert.equal(withFileAnchor('./src/app.tsx', 0), 'src/app.tsx');
});

test('[[file:…]] expands outside fenced and inline code only', () => {
  const text = [
    '看 [[file:src/app.tsx#L12]] 和 [[file:docs/x.md]]。',
    '',
    '```',
    '[[file:should/not-change.ts]]',
    '```',
    '',
    '`[[file:inline/keep.ts]]`',
  ].join('\n');
  const out = expandFileRefs(text);
  assert.match(out, /\[src\/app\.tsx#L12\]\(mova-file:src\/app\.tsx#L12\)/);
  assert.match(out, /\[docs\/x\.md\]\(mova-file:docs\/x\.md\)/);
  assert.ok(out.includes('[[file:should/not-change.ts]]'));
  assert.ok(out.includes('`[[file:inline/keep.ts]]`'));
});

test('expanded links round-trip through the file scheme', () => {
  const href = fileRefHref('src/features/browser/viewer.js#L42');
  assert.equal(parseFileRefHref(href).path, 'src/features/browser/viewer.js');
  assert.equal(parseFileRefHref(href).line, 42);
  assert.equal(parseFileRefHref('https://example.com'), null);
  assert.equal(parseFileRefHref('mova-file:'), null);
});

test('markdown without the syntax is untouched', () => {
  const text = '# 标题\n\n普通段落，包含 [链接](https://example.com) 与 `code`。';
  assert.equal(expandFileRefs(text), text);
});
