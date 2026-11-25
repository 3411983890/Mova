const assert = require('node:assert/strict');
const { test } = require('node:test');
const { diffSnapshots } = require('./diff.cjs');

function entry(key, role, name, options = {}) {
  const value = options.value || '';
  const flags = options.flags || '';
  const text = options.text || '';
  const depth = options.depth || 0;
  return {
    key, role, name, value, flags, text, depth,
    path: options.path || '',
    line: `${'  '.repeat(depth)}- ${role} "${name}"${flags}${value ? ` value="${value}"` : ''}`,
    fingerprint: [role, name, value, flags, text].join('\u0000'),
  };
}

test('first snapshot is always full', () => {
  const result = diffSnapshots(null, { entries: [entry('e:1', 'button', 'Go')], url: 'https://x.test/' });
  assert.equal(result.mode, 'full');
  assert.equal(result.reason, 'first-snapshot');
});

test('reports added, removed and changed lines', () => {
  const previous = {
    url: 'https://x.test/orders',
    entries: [
      entry('e:1', 'button', 'Go'),
      entry('e:2', 'textbox', 'Search', { value: '' }),
      entry('e:3', 'link', 'Old'),
    ],
  };
  const next = {
    url: 'https://x.test/orders',
    entries: [
      entry('e:1', 'button', 'Go', { flags: ' [disabled]' }),
      entry('e:2', 'textbox', 'Search', { value: 'A-10' }),
      entry('e:4', 'dialog', 'Confirm'),
    ],
  };
  const result = diffSnapshots(previous, next);
  assert.equal(result.mode, 'diff');
  assert.deepEqual(result.stats, { added: 1, removed: 1, changed: 2, unchanged: 0 });
  assert.match(result.text, /^~ .*button "Go"/m);
  assert.match(result.text, /^~ .*textbox "Search"/m);
  assert.match(result.text, /^\+ .*dialog "Confirm"/m);
  assert.match(result.text, /^- .*link "Old"/m);
  assert.match(result.text, /1 additions, 1 removals, 2 changed/);
});

test('reports no changes without emitting a fake diff', () => {
  const snapshot = { url: 'https://x.test/', entries: [entry('e:1', 'button', 'Go')] };
  const result = diffSnapshots(snapshot, snapshot);
  assert.equal(result.mode, 'diff');
  assert.match(result.text, /没有变化/);
  assert.equal(result.lines.length, 0);
});

test('suppresses replacement churn when the semantic node is unchanged', () => {
  const previous = { url: 'https://x.test/', entries: [entry('e:1', 'button', 'Go', { depth: 1 })] };
  const next = { url: 'https://x.test/', entries: [entry('e:99', 'button', 'Go', { depth: 1 })] };
  const result = diffSnapshots(previous, next);
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.removed, 0);
  assert.match(result.text, /没有变化/);
});

test('falls back to full when most of the page changed', () => {
  const previous = { url: 'https://x.test/', entries: [] };
  const next = { url: 'https://x.test/', entries: [] };
  for (let i = 0; i < 30; i += 1) {
    previous.entries.push(entry(`e:${i}`, 'button', `B${i}`, { value: 'old' }));
    next.entries.push(entry(`e:${i}`, 'button', `B${i}`, { value: 'new' }));
  }
  const result = diffSnapshots(previous, next);
  assert.equal(result.mode, 'full');
  assert.equal(result.reason, 'too-many-changes');
});

test('falls back to full when the document URL changed', () => {
  const previous = { url: 'https://x.test/a', entries: [entry('e:1', 'button', 'Go')] };
  const next = { url: 'https://x.test/b', entries: [entry('e:2', 'button', 'Go')] };
  const result = diffSnapshots(previous, next);
  assert.equal(result.mode, 'full');
  assert.equal(result.reason, 'url-changed');
});
