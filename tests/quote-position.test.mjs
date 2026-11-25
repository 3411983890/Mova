import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  normalizeRect,
  placePopover,
} from '../src/features/browser/quote-position.js';

/** 面板：左右两条边界之间可用的水平区间。 */
const MARGE = POPOVER_MARGIN;

const panel = (width, height = 557) => ({ left: 0, top: 43, width, height });
const anchor = (left, top, width = 120, height = 18) => ({ left, top, width, height });
const popover = (width = 300, height = 34) => ({ width, height });

test('normalizeRect 同时吃 DOMRect 与 CDP 的 {x,y,w,h}', () => {
  assert.deepEqual(normalizeRect({ x: 10, y: 20, w: 100, h: 30 }), {
    left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50,
  });
  assert.deepEqual(normalizeRect({ left: 10, top: 20, right: 110, bottom: 50 }), {
    left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50,
  });
  assert.deepEqual(normalizeRect({ left: 0, top: 0, width: -5, height: -5 }), {
    left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0,
  });
  for (const bad of [null, undefined, {}, 'x', 42, { left: 'a', top: NaN }]) {
    assert.equal(normalizeRect(bad), null, String(bad));
  }
});

test('默认放在锚点上方 gap 6px，左边缘与锚点对齐', () => {
  const result = placePopover(anchor(600, 300), popover(), panel(1280));
  assert.equal(result.placement, 'top');
  // 300 - 6 - 34 = 260，再减去 bounds.top（43）
  assert.equal(result.top, 300 - 43 - POPOVER_GAP - 34);
  assert.equal(result.left, 600);
  assert.equal(POPOVER_GAP, 6);
  assert.equal(POPOVER_MARGIN, 10);
});

test('上方空间不够时翻到下方', () => {
  const result = placePopover(anchor(600, 55), popover(), panel(1280));
  assert.equal(result.placement, 'bottom');
  // 锚点底边(73) - bounds.top(43) + 6 = 36
  assert.equal(result.top, 55 + 18 - 43 + POPOVER_GAP);
});

test('上下都放不下时选空间大的一侧，并夹进面板', () => {
  // 面板只有 100 高，浮层 80 高，上下都装不下：下方空间更大 → bottom，再钉回上边。
  const result = placePopover(anchor(10, 30, 100, 10), popover(300, 80), { left: 0, top: 0, width: 320, height: 100 });
  assert.equal(result.placement, 'bottom');
  assert.equal(result.top, POPOVER_MARGIN);
});

test('左右夹取：越出面板左右边界时向内推', () => {
  const wide = popover(300, 34);
  // 右侧越界：1280 面板，锚点左边缘 1000 → 最大可用 1280-10-300 = 970
  assert.equal(placePopover(anchor(1000, 300), wide, panel(1280)).left, 1280 - MARGE - 300);
  // 左侧越界（锚点被裁到面板外）：贴左边 margin
  assert.equal(placePopover(anchor(-40, 300), wide, panel(1280)).left, MARGE);
  // 中间：保持与锚点左边缘对齐
  assert.equal(placePopover(anchor(600, 300), wide, panel(1280)).left, 600);
});

test('面板 320px：浮层 300px 时左右都只剩 margin，永远压在 10px', () => {
  const wide = popover(300, 34);
  for (const left of [-200, 0, 40, 160, 280, 400]) {
    const result = placePopover(anchor(left, 300), wide, panel(320));
    assert.equal(result.left, MARGE, `anchor.left=${left}`);
  }
});

test('面板 1280px：浮层可活动的水平区间是 [10, 970]', () => {
  const wide = popover(300, 34);
  const low = placePopover(anchor(0, 300), wide, panel(1280)).left;
  const high = placePopover(anchor(5000, 300), wide, panel(1280)).left;
  assert.equal(low, MARGE);
  assert.equal(high, 1280 - MARGE - 300);
  assert.ok(high > low);
});

test('浮层比面板还宽时贴左边，不产生负值', () => {
  const result = placePopover(anchor(40, 300), popover(400, 34), panel(320));
  assert.equal(result.left, POPOVER_MARGIN);
  assert.ok(result.left >= 0);
});

test('anchor 部分越界：上下左右都仍落在面板内', () => {
  const bounds = { left: 100, top: 100, width: 320, height: 400 };

  // 锚点在面板上方（top 越界）→ 翻下方，且不低于上边界 margin
  const above = placePopover(anchor(180, 80, 100, 20), popover(), bounds);
  assert.equal(above.placement, 'bottom');
  assert.equal(above.top, POPOVER_MARGIN);

  // 锚点在面板下方（bottom 越界）→ 仍放上方，但夹回面板内
  const below = placePopover(anchor(180, 520, 100, 20), popover(), bounds);
  assert.equal(below.placement, 'top');
  assert.equal(below.top, 400 - MARGE - 34);

  // 锚点在左边界外 / 右边界外 → 水平夹取
  assert.equal(placePopover(anchor(20, 300), popover(), bounds).left, MARGE);
  assert.equal(placePopover(anchor(500, 300), popover(), bounds).left, 320 - MARGE - 300);

  for (const rect of [above, below]) {
    assert.ok(rect.top >= MARGE && rect.top + 34 <= bounds.height - MARGE + 34, JSON.stringify(rect));
    assert.ok(Number.isFinite(rect.left) && Number.isFinite(rect.top));
  }
});

test('零尺寸 bounds（面板刚插入 / display:none）只回落到 margin，不返回 NaN', () => {
  for (const bounds of [{ left: 0, top: 0, width: 0, height: 0 }, null, undefined, {}]) {
    const result = placePopover(anchor(40, 300), popover(), bounds);
    assert.ok(Number.isFinite(result.left), String(bounds));
    assert.ok(Number.isFinite(result.top), String(bounds));
    assert.ok(result.left >= 0 && result.top >= 0);
    assert.equal(result.left, POPOVER_MARGIN);
    assert.equal(result.top, POPOVER_MARGIN);
    assert.ok(result.placement === 'top' || result.placement === 'bottom');
  }
});

test('零尺寸 anchor（拿不到选区矩形）按上边界对齐，不抛错', () => {
  const result = placePopover({ left: 0, top: 0, width: 0, height: 0 }, popover(), panel(320));
  assert.equal(result.left, POPOVER_MARGIN);
  assert.equal(result.top, POPOVER_MARGIN);
  assert.equal(placePopover(null, popover(), panel(320)).top, POPOVER_MARGIN);
});

test('未量到尺寸（size 为 0）时按 0 处理，位置仍然合法', () => {
  const result = placePopover(anchor(600, 300), { width: 0, height: 0 }, panel(1280));
  assert.equal(result.placement, 'top');
  assert.equal(result.top, 300 - 43 - POPOVER_GAP);
  assert.ok(Number.isFinite(result.left));
});

test('gap / margin 可覆盖，且负数被忽略', () => {
  const custom = placePopover(anchor(600, 300), popover(), panel(1280), 12, 4);
  assert.equal(custom.top, 300 - 43 - 12 - 34);
  const negative = placePopover(anchor(600, 300), popover(), panel(1280), -20, -20);
  assert.equal(negative.top, 300 - 43 - POPOVER_GAP - 34);
  const right = placePopover(anchor(5000, 300), popover(), panel(1280), 6, 4);
  assert.equal(right.left, 1280 - 4 - 300);
});

test('返回值是整数像素，且 left/top 永远是数字', () => {
  const result = placePopover(anchor(40.4, 300.6), popover(), panel(1280));
  assert.equal(result.left, 40);
  assert.equal(result.top, Math.round(300.6 - 43 - POPOVER_GAP - 34));
  assert.equal(typeof result.left, 'number');
  assert.equal(typeof result.top, 'number');
});
