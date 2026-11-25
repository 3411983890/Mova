import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconNames } from '../src/shared/icons.js';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');
// The shell sources used to sit in the repository root; they now live per feature.
const scanDirs = [
  here,
  join(here, 'src', 'shared'),
  join(here, 'src', 'features', 'bot'),
  join(here, 'src', 'features', 'chat'),
  join(here, 'src', 'features', 'composer'),
  join(here, 'src', 'features', 'projects'),
  join(here, 'src', 'features', 'sidebar'),
];
const known = new Set(iconNames);

/**
 * Regression guard for an earlier crash: one unmapped `ph-*` icon in index.html
 * threw inside replaceStaticIcons and aborted the rest of app.js, so the project
 * list, the settings listeners and the workspace restore never ran.
 */
test('every ph-* icon used by the shell is mapped', async () => {
  const html = await readFile(join(here, 'index.html'), 'utf8');
  const used = new Set();
  for (const match of html.matchAll(/class="[^"]*\bph-([a-z0-9-]+)/g)) {
    if (match[1] !== 'fill') used.add(match[1]);
  }
  assert.ok(used.size > 20, `expected the shell to use icons, found ${used.size}`);
  const missing = [...used].filter(name => !known.has(name));
  assert.deepEqual(missing, [], `unmapped icons in index.html: ${missing.join(', ')}`);
});

test('every literal icon("...") call in the app source is mapped', async () => {
  const files = [];
  for (const dir of scanDirs) {
    for (const file of await readdir(dir)) {
      if (!/\.(js|jsx)$/.test(file) || file === 'icons.js') continue;
      files.push(join(dir, file));
    }
  }
  const used = new Set();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bicon\(\s*'([a-z0-9-]+)'/g)) used.add(match[1]);
  }
  const missing = [...used].filter(name => !known.has(name));
  assert.deepEqual(missing, [], `icon() called with unmapped names: ${missing.join(', ')}`);
});

test('an unknown icon name still rejects, but replaceStaticIcons keeps going', async () => {
  const { icon } = await import('../src/shared/icons.js');
  assert.throws(() => icon('definitely-not-an-icon'), /Unknown icon: definitely-not-an-icon/);

  // Minimal DOM stub: one bad element followed by one good one.
  const warn = [];
  const originalWarn = console.warn;
  console.warn = message => warn.push(message);
  try {
    const elements = [
      { classList: ['ph', 'ph-not-mapped'], replaceWith() { throw new Error('should not be reached for the bad one'); } },
      { classList: ['ph', 'ph-gear'], replaced: false, replaceWith() { this.replaced = true; } },
    ];
    const stubDocument = { createElement: () => ({ className: '', setAttribute() {}, set innerHTML(value) { this.raw = value; }, cloneNode() { return { replaced: false }; } }) };
    globalThis.document = stubDocument;
    const { replaceStaticIcons } = await import('../src/shared/icons.js');
    replaceStaticIcons({ querySelectorAll: () => elements });
    assert.equal(elements[1].replaced, true, 'the mapped icon is still replaced after the bad one');
    assert.equal(warn.length, 1);
    assert.match(warn[0], /Unknown icon/);
  } finally {
    console.warn = originalWarn;
    delete globalThis.document;
  }
});
