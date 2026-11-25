import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent, safeMarkdownUrl } from '../src/features/chat/markdown-renderer.js';

const render = text => renderToStaticMarkup(React.createElement(MarkdownContent, { text }));

test('renders headings, emphasis, nested lists, blockquotes and GFM tables', () => {
  const html = render('# Heading\n\n**bold** and *italic*\n\n- first\n  - nested\n\n1. ordered\n\n> quoted\n\n| Name | Value |\n| --- | --- |\n| a | b |');
  for (const tag of ['h1', 'strong', 'em', 'ul', 'ol', 'blockquote', 'table', 'th', 'td']) {
    assert.ok(html.includes(`<${tag}`), `missing ${tag}`);
  }
  assert.match(html, /markdown-table-scroll/);
});

test('fenced code is escaped, labeled and has a copy button, including incomplete fences', () => {
  for (const closing of ['', '\n```']) {
    const html = render('```javascript\nconst html = "<script>alert(1)</script>";' + closing);
    assert.match(html, /markdown-code-language">javascript/);
    assert.match(html, /aria-label="复制代码"/);
    assert.match(html, /&lt;script&gt;/);
    assert.ok(!html.includes('<script>'));
  }
  assert.match(render('```\nplain\n```'), /markdown-code-language">text/);
  assert.match(render('Use `inline` code'), /<code>inline<\/code>/);
});

test('file references and path-like inline code link to the right panel', () => {
  const html = render('看 [[file:src/app.tsx#L12]] 和 `src/main.ts:4`。');
  assert.match(html, /class="markdown-file-ref"[^>]*>src\/app\.tsx#L12</);
  assert.match(html, /<button[^>]*class="markdown-file-ref"[^>]*>src\/main\.ts:4<\/button>/);
  // A command is not a path and must stay plain inline code.
  assert.match(render('运行 `npm run dev`'), /<code>npm run dev<\/code>/);
  // Fenced code keeps the literal marker.
  assert.match(render('```\n[[file:a.ts]]\n```'), /\[\[file:a\.ts\]\]/);
});

test('only explicit http, https and mailto links are enabled', () => {
  const html = render('[secure](https://example.com) [web](http://example.com) [mail](mailto:test@example.com)');
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /href="http:\/\/example.com"/);
  assert.match(html, /href="mailto:test@example.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
  for (const url of ['javascript:alert(1)', 'data:text/html,evil', 'file:///secret', '//evil.test', '/relative', '#fragment', 'vbscript:evil', 'java\nscript:evil', 'https://example.com\u0000', 'https:example.com']) {
    assert.equal(safeMarkdownUrl(url), undefined, url);
  }
  const unsafe = render('[bad](javascript:alert%281%29) [relative](/secret) [data](data:text/html,evil)');
  assert.ok(!unsafe.includes('href='));
});

test('plain web URLs in replies render as new-tab links', () => {
  // 桌面版：左键进右侧面板、Ctrl+点击交给默认浏览器，所以 title 里必须把这个行为写清楚。
  const html = render('打开 https://example.com/path');
  assert.match(html, /href="https:\/\/example\.com\/path"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Ctrl\+点击用默认浏览器打开/);
});

test('raw HTML never executes and Markdown images never fetch remote content', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.test"></iframe>\n\n![alt text](https://tracker.test/image.png)');
  assert.ok(!/<script|<img|<iframe|onerror=/.test(html));
  assert.ok(!html.includes('tracker.test'));
  assert.match(html, /alt text/);
});

test('streaming partial Markdown remains renderable at every prefix', () => {
  const text = '# Title\n\n**bold** and [safe](https://example.com)\n\n```ts\nconst a = 1;\n```\n';
  for (let index = 0; index <= text.length; index++) assert.doesNotThrow(() => render(text.slice(0, index)));
});
