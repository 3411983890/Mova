/* global require */
'use strict';

/**
 * input.cjs 纯函数单测（node --test）。
 *
 * 这里**不注入任何真实输入**：只测绝对坐标归一化、键序解析、滚轮换算这些纯计算，
 * 这样 CI 里不需要桌面会话，也不会动到用户的鼠标键盘。
 *
 *   node --test tests/desktop/input.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const input = require('../../electron/desktop/input.cjs');

/* ─────────────────── 绝对坐标归一化 ─────────────────── */

test('normalizeAbsolute：单屏 1920x1080 的四角', () => {
  const screen = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(input.normalizeAbsolute(0, 0, screen), { nx: 0, ny: 0 });
  assert.deepEqual(input.normalizeAbsolute(1920, 1080, screen), { nx: 65535, ny: 65535 });
  assert.deepEqual(input.normalizeAbsolute(960, 540, screen), { nx: 32768, ny: 32768 });
});

test('normalizeAbsolute：副屏在左时虚拟桌面原点为负', () => {
  // 主屏 1920x1080 在 (0,0)，副屏在左侧 (-1920,0)。
  const screen = { x: -1920, y: 0, w: 3840, h: 1080 };
  assert.deepEqual(input.normalizeAbsolute(-1920, 0, screen), { nx: 0, ny: 0 });
  // 主屏左上角正好是虚拟桌面的中点。
  const origin = input.normalizeAbsolute(0, 0, screen);
  assert.equal(origin.nx, 32768);
  assert.equal(origin.ny, 0);
  assert.deepEqual(input.normalizeAbsolute(1920, 1080, screen), { nx: 65535, ny: 65535 });
});

test('normalizeAbsolute：越界坐标被夹到 0..65535', () => {
  const screen = { x: 0, y: 0, w: 2560, h: 1440 };
  assert.deepEqual(input.normalizeAbsolute(-5000, -5000, screen), { nx: 0, ny: 0 });
  assert.deepEqual(input.normalizeAbsolute(999999, 999999, screen), { nx: 65535, ny: 65535 });
});

test('normalizeAbsolute：混合 DPI 的偏移原点', () => {
  const screen = { x: 100, y: 50, w: 800, h: 600 };
  assert.deepEqual(input.normalizeAbsolute(100, 50, screen), { nx: 0, ny: 0 });
  assert.deepEqual(input.normalizeAbsolute(900, 650, screen), { nx: 65535, ny: 65535 });
});

test('normalizeAbsolute：非法输入必须直接报错，不要悄悄发到 (0,0)', () => {
  const screen = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.throws(() => input.normalizeAbsolute(Number.NaN, 0, screen), TypeError);
  assert.throws(() => input.normalizeAbsolute('10', 0, screen), TypeError);
  assert.throws(() => input.normalizeAbsolute(10, 10, null), TypeError);
  assert.throws(() => input.normalizeAbsolute(10, 10, { x: 0, y: 0, w: 0, h: 0 }), RangeError);
});

/* ─────────────────── 组合键解析 / 键序 ─────────────────── */

test('parseCombo：ctrl+shift+s 的按下与逆序释放', () => {
  const parsed = input.parseCombo('ctrl+shift+s');
  assert.deepEqual(parsed.mods, [0x11, 0x10]);
  assert.equal(parsed.key, 0x53);
  assert.deepEqual(parsed.press, [0x11, 0x10, 0x53]);
  // 释放必须严格逆序，否则 Shift 会卡住。
  assert.deepEqual(parsed.release, [0x53, 0x10, 0x11]);
});

test('parseCombo：大小写与常见别名', () => {
  assert.deepEqual(input.parseCombo('Control+Alt+Delete').press, [0x11, 0x12, 0x2e]);
  assert.deepEqual(input.parseCombo('CTRL+V').press, [0x11, 0x56]);
  assert.deepEqual(input.parseCombo('Win+r').press, [0x5b, 0x52]);
  assert.deepEqual(input.parseCombo('Meta+Tab').press, [0x5b, 0x09]);
  assert.deepEqual(input.parseCombo('ctrl + shift + esc').release, [0x1b, 0x10, 0x11]);
});

test('parseCombo：功能键、方向键与符号键', () => {
  assert.equal(input.parseCombo('f12').key, 0x7b);
  assert.equal(input.parseCombo('f1').key, 0x70);
  assert.equal(input.parseCombo('alt+left').key, 0x25);
  assert.equal(input.parseCombo('ctrl+-').key, 0xbd);
  assert.equal(input.parseCombo('ctrl+plus').key, 0xbb);
  assert.equal(input.parseCombo('ctrl+]').key, 0xdd);
});

test('parseCombo：纯修饰键（长按 Ctrl+Shift 的备用入口）', () => {
  const parsed = input.parseCombo('ctrl+shift');
  assert.equal(parsed.key, null);
  assert.deepEqual(parsed.press, [0x11, 0x10]);
  assert.deepEqual(parsed.release, [0x10, 0x11]);
});

test('parseCombo：重复修饰键去重但保留顺序', () => {
  assert.deepEqual(input.parseCombo('shift+ctrl+shift+A').press, [0x10, 0x11, 0x41]);
});

test('parseCombo：非法组合键要报错', () => {
  assert.throws(() => input.parseCombo(''), /不能为空/);
  assert.throws(() => input.parseCombo('   '), /组合键/);
  assert.throws(() => input.parseCombo('ctrl+notakey'), /无法识别/);
  assert.throws(() => input.parseCombo('a+b'), /只能有一个非修饰键/);
  assert.throws(() => input.parseCombo(null), TypeError);
});

/* ─────────────────── 滚轮换算 ─────────────────── */

test('wheelDelta：格数换成 120 的倍数', () => {
  assert.equal(input.wheelDelta(1), 120);
  assert.equal(input.wheelDelta(-1), -120);
  assert.equal(input.wheelDelta(3), 360);
  assert.equal(input.wheelDelta(-3), -360);
  assert.equal(input.wheelDelta(0), 0);
});

test('wheelDelta：已经是 wheel delta 就原样使用', () => {
  assert.equal(input.wheelDelta(120), 120);
  assert.equal(input.wheelDelta(-240), -240);
  assert.equal(input.wheelDelta(600), 600);
  assert.throws(() => input.wheelDelta('scroll'), TypeError);
});

/* ─────────────────── 其它纯函数 ─────────────────── */

test('isPlainAscii：短 ASCII 才走 KEYEVENTF_UNICODE', () => {
  assert.equal(input.isPlainAscii('report.xlsx'), true);
  assert.equal(input.isPlainAscii('a'.repeat(64)), true);
  assert.equal(input.isPlainAscii('a'.repeat(65)), false);
  assert.equal(input.isPlainAscii('中文'), false);
  assert.equal(input.isPlainAscii('line\nbreak'), false);
  assert.equal(input.isPlainAscii(''), false);
});

test('isExtendedVk：方向键/Delete/Win 需要 EXTENDEDKEY', () => {
  assert.equal(input.isExtendedVk(0x25), true); // left
  assert.equal(input.isExtendedVk(0x2e), true); // delete
  assert.equal(input.isExtendedVk(0x5b), true); // win
  assert.equal(input.isExtendedVk(0x41), false); // a
  assert.equal(input.isExtendedVk(0x31), false); // 1
});

test('模块可在纯 node 下 require（不加载 koffi 时才不会抛）', () => {
  // 只要求导出形状正确；真正注入由 Electron 主进程负责。
  for (const name of ['moveTo', 'click', 'down', 'up', 'scroll', 'drag', 'typeText', 'pressCombo']) {
    assert.equal(typeof input[name], 'function', `${name} 应该导出`);
  }
  assert.equal(typeof input.releaseAll, 'function');
  assert.equal(typeof input.getAsyncKeyState, 'function');
  assert.equal(typeof input.lastInputTick, 'function');
  assert.equal(typeof input.cursor, 'function');
  assert.equal(typeof input.onInjection, 'function');
});
