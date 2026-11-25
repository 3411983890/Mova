import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedViewState } from '../src/features/browser/scoped-view-state.js';

function fixture() {
  let visible;
  let restores = 0;
  const controller = createScopedViewState({
    capture: () => ({ ...visible }),
    restore: state => { visible = { ...state }; restores++; },
  });
  return { controller, get visible() { return visible; }, set visible(value) { visible = value; }, get restores() { return restores; } };
}

test('panel visibility, surface and tab restore independently for each chat', () => {
  const f = fixture();
  f.controller.select('A');
  f.visible = { open: true, view: 'canvas', tabId: 'a' };
  f.controller.select('B');
  assert.deepEqual(f.visible, { open: false, view: 'web', tabId: null });
  f.visible = { open: true, view: 'file', tabId: 'b' };
  f.controller.select('A');
  assert.deepEqual(f.visible, { open: true, view: 'canvas', tabId: 'a' });
  f.visible.open = false;
  f.controller.select('B');
  assert.deepEqual(f.visible, { open: true, view: 'file', tabId: 'b' });
  f.controller.select('A');
  assert.equal(f.visible.open, false);
});

test('same chat does not reset its live view', () => {
  const f = fixture();
  f.controller.select('A');
  f.visible.open = true;
  f.controller.select('A');
  assert.equal(f.visible.open, true);
  assert.equal(f.restores, 1);
});

test('first send and rename migrate the active scope without losing its state', () => {
  const f = fixture();
  f.controller.select('draft');
  f.visible = { open: true, view: 'web', tabId: 'one' };
  f.controller.rekey('draft', 'chat');
  f.controller.select('chat');
  assert.equal(f.restores, 1);
  f.controller.select('other');
  f.controller.select('chat');
  assert.equal(f.visible.tabId, 'one');
  assert.equal(f.visible.open, true);
  f.controller.select('draft');
  assert.equal(f.visible.open, false);
});

test('renaming a background chat keeps its saved view', () => {
  const f = fixture();
  f.controller.select('A');
  f.visible.open = true;
  f.controller.select('B');
  f.controller.rekey('A', 'renamed');
  f.controller.select('renamed');
  assert.equal(f.visible.open, true);
});
