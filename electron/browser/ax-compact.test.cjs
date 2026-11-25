const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compactAxTree, refOf, sanitizeUrl } = require('./ax-compact.cjs');

function n(id, role, name = '', extra = {}) {
  const node = {
    nodeId: String(id),
    ignored: false,
    role: { value: role },
    name: name === undefined ? undefined : { value: name },
    childIds: (extra.children || []).map(String),
  };
  if (extra.parent !== undefined) node.parentId = String(extra.parent);
  if (extra.backend !== undefined) node.backendDOMNodeId = extra.backend;
  if (extra.value !== undefined) node.value = { value: extra.value };
  if (extra.properties) node.properties = extra.properties;
  if (extra.ignored) node.ignored = true;
  if (extra.reasons) node.ignoredReasons = extra.reasons.map(name => ({ name }));
  return node;
}

function fixture() {
  return [
    n(1, 'RootWebArea', 'Orders', { children: [2, 8, 9, 11] }),
    n(2, 'generic', '', { parent: 1, children: [3, 4, 5, 6, 7] }),
    n(3, 'heading', 'Orders', { parent: 2 }),
    n(4, 'button', 'Go', { parent: 2, backend: 14 }),
    n(5, 'textbox', 'Search', { parent: 2, backend: 15, value: 'A-10' }),
    n(6, 'link', 'View', {
      parent: 2, backend: 16,
      properties: [{ name: 'url', value: { value: 'https://shop.example.com/orders/1?token=abc&page=2' } }],
    }),
    n(7, 'checkbox', 'Remember', {
      parent: 2, backend: 17,
      properties: [{ name: 'checked', value: { value: true } }],
    }),
    n(8, 'StaticText', 'Orders list', { parent: 1 }),
    n(9, 'paragraph', '', { parent: 1, children: [10] }),
    n(10, 'StaticText', 'Hello world', { parent: 9 }),
    n(11, 'generic', '', { parent: 1, children: [12], ignored: true, reasons: ['notVisible'] }),
    n(12, 'button', 'Hidden', { parent: 11, backend: 18 }),
  ];
}

test('keeps controls, headings and text while dropping presentational wrappers', () => {
  const result = compactAxTree(fixture(), { url: 'https://shop.example.com/orders', title: 'Orders' });
  const text = result.text;
  assert.match(text, /- heading "Orders"/);
  assert.ok(text.includes(`- button "Go" ${refOf({ backendDOMNodeId: 14 })}`));
  assert.match(text, /- textbox "Search" .* value="A-10"/);
  assert.match(text, /- link "View" .* href="\/orders\/1\?token=redacted&page=2"/);
  assert.match(text, /- checkbox "Remember" .* \[checked\]/);
  assert.match(text, /- text: Orders list/);
  assert.match(text, /- paragraph: Hello world/);
  assert.doesNotMatch(text, /Hidden/);
  assert.doesNotMatch(text, /generic/);
  assert.equal(result.truncated, false);
});

test('masks password values and truncates names', () => {
  const nodes = [
    n(1, 'RootWebArea', '', { children: [2] }),
    n(2, 'textbox', 'Password', {
      parent: 1, backend: 21, value: 'hunter2',
      properties: [{ name: 'protected', value: { value: true } }],
    }),
  ];
  const result = compactAxTree(nodes);
  assert.match(result.text, /value="••••"/);
  assert.doesNotMatch(result.text, /hunter2/);
});

test('honours the node and character budgets', () => {
  const nodes = [n(1, 'RootWebArea', '', { children: [2, 3, 4, 5] })];
  for (let i = 2; i <= 5; i += 1) nodes.push(n(i, 'button', `Button ${i}`, { parent: 1, backend: 30 + i }));
  const byNodes = compactAxTree(nodes, { maxNodes: 2 });
  assert.equal(byNodes.truncated, true);
  assert.match(byNodes.text, /快照已截断/);

  const byChars = compactAxTree(nodes, { maxChars: 60 });
  assert.equal(byChars.truncated, true);
  assert.ok(byChars.text.length <= 160, 'header plus marker stay small');
});

test('uses a frame prefix so iframe refs do not collide', () => {
  const result = compactAxTree([
    n(1, 'RootWebArea', '', { children: [2] }),
    n(2, 'button', 'Pay', { parent: 1, backend: 14 }),
  ], { framePrefix: 'f2:' });
  assert.match(result.text, /\[ref=f2:ee\]/);
});

test('sanitizes sensitive query parameters and keeps relative paths', () => {
  assert.equal(sanitizeUrl('https://x.test/a?token=1&page=2'), '/a?token=redacted&page=2');
  assert.equal(sanitizeUrl('/orders/1?auth=abc'), '/orders/1?auth=redacted');
  assert.equal(sanitizeUrl('not a url?code=1'), 'not a url?code=redacted');
});

test('preserves page order when a wrapper interleaves text and controls', () => {
  const result = compactAxTree([
    n(1, 'RootWebArea', '', { children: [2] }),
    n(2, 'generic', '', { parent: 1, children: [3, 4, 5] }),
    n(3, 'StaticText', 'before', { parent: 2 }),
    n(4, 'button', 'Go', { parent: 2, backend: 14 }),
    n(5, 'StaticText', 'after', { parent: 2 }),
  ]);
  const lines = result.lines.filter(line => line.startsWith('- '));
  assert.deepEqual(lines.map(line => line.trim()), [
    '- text: before',
    '- button "Go" [ref=ee]',
    '- text: after',
  ]);
});
