/**
 * 负责：修饰键判定与两条外部打开的薄封装——左键进右侧面板、Ctrl/⌘+左键交给系统默认程序。
 * 不负责：右侧面板的打开逻辑（side-browser.js 消费 mova:open-reference）、路径越界校验（主进程 files-view.cjs）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么值得单测：这是「点了没反应 vs 点错地方」的唯一分岔口。ctrKey 拼错、把 shift 也当修饰键、
 * 或者把 ⌘ 忘了，都会变成用户要反复试的谜题，而这类 bug 在真机上很难复现到具体一次点击。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decideTarget, isExternalModifier, openFileExternally, openInPanel, openUrlExternally,
} from '../src/features/chat/open-target.mjs';

test('左键进面板，Ctrl 或 ⌘ 才走外部', () => {
  assert.equal(isExternalModifier({}), false);
  assert.equal(isExternalModifier({ ctrlKey: false, metaKey: false }), false);
  assert.equal(isExternalModifier({ ctrlKey: true }), true);
  assert.equal(isExternalModifier({ metaKey: true }), true, 'macOS 用 ⌘，必须认');
  assert.equal(decideTarget({}), 'panel');
  assert.equal(decideTarget({ ctrlKey: true }), 'external');
  assert.equal(decideTarget(undefined), 'panel', '没有事件对象时按左键处理，绝不默默走外部');
});

test('Shift / Alt 不是修饰键（别抢选区与拖拽的手势）', () => {
  assert.equal(isExternalModifier({ shiftKey: true }), false);
  assert.equal(isExternalModifier({ altKey: true }), false);
  assert.equal(decideTarget({ shiftKey: true, altKey: true }), 'panel');
});

test('没有桥（浏览器预览/旧主进程）时两个外部打开都返回 false，不抛错', async () => {
  assert.equal(await openFileExternally({ path: 'a.md' }), false);
  assert.equal(await openUrlExternally('https://example.com'), false);
  assert.equal(await openFileExternally(), false);
});

test('外部打开只接受 http(s)，其余协议一律不发请求', async () => {
  const calls = [];
  globalThis.window = {
    movaDesktop: {
      browser: { external: async url => { calls.push(url); return true; } },
      files: { view: { openExternal: async input => { calls.push(input); return { ok: true }; } } },
    },
  };
  try {
    assert.equal(await openUrlExternally('https://example.com/a'), true);
    assert.equal(await openUrlExternally('file:///C:/x.md'), false, 'file:// 不能走 openExternal');
    assert.equal(await openUrlExternally('javascript:alert(1)'), false);
    assert.equal(await openUrlExternally('example.com'), false, '没有协议头不猜');
    assert.deepEqual(calls, ['https://example.com/a']);

    assert.equal(await openFileExternally({ rootId: 'r1', path: 'docs/a.md' }), true);
    assert.equal(await openFileExternally({ raw: 'C:\\repo\\docs\\a.md' }), true, '绝对路径交给主进程判定归属');
    assert.equal(await openFileExternally({}), false, '空目标不发请求');
    assert.deepEqual(calls.slice(1), [{ rootId: 'r1', path: 'docs/a.md' }, { raw: 'C:\\repo\\docs\\a.md' }]);
  } finally {
    delete globalThis.window;
  }
});

test('主进程拒绝时返回 false（调用方据此给出提示，而不是假装打开了）', async () => {
  globalThis.window = {
    movaDesktop: {
      files: { view: { openExternal: async () => ({ ok: false, error: 'not-registered' }) } },
    },
  };
  try {
    assert.equal(await openFileExternally({ path: 'a.md' }), false);
  } finally {
    delete globalThis.window;
  }
});

test('openInPanel 派发既有事件形状（右边栏靠它识别 file / url）', () => {
  const seen = [];
  globalThis.window = { dispatchEvent: event => { seen.push(event.detail); return true; } };
  try {
    openInPanel({ kind: 'file', path: 'docs/a.md#L12' });
    openInPanel({ kind: 'url', url: 'https://example.com' });
    openInPanel(null);
    assert.deepEqual(seen, [
      { kind: 'file', path: 'docs/a.md#L12' },
      { kind: 'url', url: 'https://example.com' },
    ]);
  } finally {
    delete globalThis.window;
  }
});
