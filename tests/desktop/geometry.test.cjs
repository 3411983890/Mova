'use strict';
/* global require */
// geometry.cjs 单测：坐标换算 / 屏幕匹配 / token 预算 / 校验。
// 重点覆盖设计文档里点名的坑：负坐标副屏、150%/200% 缩放、竖屏、crop 偏移、maxPixels 限制。
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  toPhysical,
  toImage,
  toDip,
  toPhysicalFromDip,
  rectToPhysical,
  rectToImage,
  normalizeDisplay,
  displayForPoint,
  fitWithin,
  rectOf,
  rectUnion,
  clampRectToDisplay,
  pointInRect,
  validatePoint,
  roundPoint,
  CODES,
} = require('../../electron/desktop/geometry.cjs');

const EPS = 1e-6;

function close(actual, expected, message = '', eps = EPS) {
  assert.ok(Math.abs(actual - expected) <= eps, `${message} ${actual} 应约等于 ${expected}`);
}

function closePoint(actual, expected, message = '', eps = EPS) {
  close(actual[0], expected[0], `${message} x`, eps);
  close(actual[1], expected[1], `${message} y`, eps);
}

function display({ id, x, y, w, h, scaleFactor, physical }) {
  return {
    id,
    scaleFactor,
    bounds: { x, y, w, h },
    ...(physical ? { physicalBounds: physical } : {}),
  };
}

// 主屏：1440x900 DIP、scaleFactor 2 -> 2880x1800 物理
const primary = display({ id: 1, x: 0, y: 0, w: 1440, h: 900, scaleFactor: 2 });

// 副屏在左侧：1920x1080 物理、150% 缩放 -> DIP -1920,0 1280x720
const left150 = display({
  id: 2, x: -1920, y: 0, w: 1280, h: 720, scaleFactor: 1.5,
  physical: { x: -2880, y: 0, w: 1920, h: 1080 },
});

// 竖屏：900x1440 物理、100%，放在主屏右侧（DIP 与物理都是 x=2880）
const portrait = display({
  id: 3, x: 2880, y: 0, w: 900, h: 1440, scaleFactor: 1,
  physical: { x: 2880, y: 0, w: 900, h: 1440 },
});

test('normalizeDisplay 由 DIP bounds + scaleFactor 推出物理矩形（负原点）', () => {
  const d = normalizeDisplay({ id: 9, scaleFactor: 1.5, bounds: { x: -1920, y: -200, w: 1280, h: 720 } });
  assert.deepEqual(d.physicalBounds, { x: -2880, y: -300, w: 1920, h: 1080 });
  assert.equal(d.scaleFactor, 1.5);
  // 显式给 physicalBounds 时以它为准（整数缩放取整误差的兜底）
  const explicit = normalizeDisplay({ id: 9, scaleFactor: 1.25, bounds: { x: 0, y: 0, w: 800, h: 600 }, physicalBounds: { x: 0, y: 0, w: 1000, h: 750 } });
  assert.deepEqual(explicit.physicalBounds, { x: 0, y: 0, w: 1000, h: 750 });
});

test('主屏 1440x900@2：图像 ↔ 物理往返，无裁剪、captureScale 0.5', () => {
  const ctx = {
    display: primary,
    crop: { x: 0, y: 0, w: 2880, h: 1800 },
    captureScale: 0.5,
    dpr: 2,
  };
  closePoint(toPhysical([0, 0], ctx), [0, 0], '左上角');
  closePoint(toPhysical([1440, 900], ctx), [2880, 1800], '右下角');
  const phys = toPhysical([700, 400], ctx);
  closePoint(phys, [1400, 800], '中部');
  closePoint(toImage(phys, ctx), [700, 400], '往返');
  closePoint(toPhysical(toImage([1234, 567], ctx), ctx), [1234, 567], '往返二');
  // 1440x900@2 的整屏物理帧（2880x1800）经 fitWithin 压到 1.15MP 内
  const fit = fitWithin(2880, 1800);
  assert.ok(fit.width * fit.height <= 1150000);
  assert.ok(fit.width < 2880 && fit.height < 1800);
});

test('crop 偏移：图像原点对应裁剪区左上，而不是屏幕原点', () => {
  const ctx = {
    display: primary,
    crop: { x: 200, y: 100, w: 800, h: 600 },
    captureScale: 0.5,
    dpr: 2,
  };
  closePoint(toPhysical([0, 0], ctx), [200, 100], '裁剪原点');
  closePoint(toPhysical([100, 50], ctx), [400, 200], '裁剪内一点');
  closePoint(toImage([400, 200], ctx), [100, 50], '反算');
  const rect = rectToPhysical({ x: 10, y: 20, w: 100, h: 80 }, ctx);
  close(rect.x, 220); close(rect.y, 140); close(rect.w, 200); close(rect.h, 160);
  const back = rectToImage(rect, ctx);
  close(back.x, 10); close(back.y, 20); close(back.w, 100); close(back.h, 80);
});

test('负坐标副屏：图像点 → 负物理坐标，显示匹配不会串屏', () => {
  const ctx = {
    display: left150,
    crop: { x: -2880, y: 0, w: 1920, h: 1080 },
    captureScale: 1,
    dpr: 1.5,
  };
  closePoint(toPhysical([0, 0], ctx), [-2880, 0], '副屏左上');
  closePoint(toPhysical([960, 540], ctx), [-1920, 540], '副屏中心');
  closePoint(toImage([-1920, 540], ctx), [960, 540], '副屏反算');

  const hit = displayForPoint([primary, left150, portrait], [-1000, 500]);
  assert.equal(hit.id, 2);
  // 落在两块屏的接缝之外 -> null，绝不自动夹到最近的屏（§8.4 永不移除越界错误）
  assert.equal(displayForPoint([primary, left150], [-5000, 500]), null);
  assert.equal(displayForPoint([primary, left150], [-5000, 500], { fallback: 'nearest' }).id, 2);
});

test('150% 缩放：物理 ↔ DIP 用 dpr 换算，不是 captureScale', () => {
  const ctx = { display: left150, crop: { x: -2880, y: 0, w: 1920, h: 1080 }, captureScale: 0.7, dpr: 1.5 };
  closePoint(toDip([-2880 + 300, 300], ctx), [-1920 + 200, 200], '偏移 300 物理 = 200 DIP');
  closePoint(toPhysicalFromDip([-1920, 0], ctx), [-2880, 0], 'DIP 原点');
  closePoint(toPhysicalFromDip([-1720, 200], ctx), [-2580, 300], 'DIP 往返');
});

test('200% 缩放：DIP 是物理的一半，负原点同样成立', () => {
  const ctx = { display: primary, crop: { x: 0, y: 0, w: 2880, h: 1800 }, captureScale: 0.5, dpr: 2 };
  closePoint(toDip([720, 450], ctx), [360, 225], '主屏');
  closePoint(toPhysicalFromDip([360, 225], ctx), [720, 450], '反向');
  const left200 = display({ id: 4, x: -1440, y: 0, w: 1440, h: 900, scaleFactor: 2, physical: { x: -2880, y: 0, w: 2880, h: 1800 } });
  closePoint(toDip([-2880, 0], { display: left200, dpr: 2 }), [-1440, 0], '负原点 DIP');
  closePoint(toDip([-2160, 900], { display: left200, dpr: 2 }), [-1080, 450], '负原点内部');
});

test('竖屏 900x1440：长边 1568 不触发，但 maxPixels 会压到 1.15MP 内', () => {
  const fit = fitWithin(900, 1440);
  assert.ok(fit.height <= 1440);
  assert.ok(fit.width * fit.height <= 1150000, `${fit.width}x${fit.height} 应 <= 1.15MP`);
  assert.ok(fit.width < 900 && fit.height < 1440);
  assert.ok(Math.abs(fit.width / fit.height - 900 / 1440) < 0.01, '保持宽高比');

  const ctx = { display: portrait, crop: { x: 2880, y: 0, w: 900, h: 1440 }, captureScale: fit.width / 900, dpr: 1 };
  // captureScale 用宽度反算，纵向最多差 1px（取整），所以给 1.5px 容差
  closePoint(toPhysical([fit.width / 2, fit.height / 2], ctx), [2880 + 450, 720], '竖屏中心', 1.5);
  const hit = displayForPoint([primary, portrait], [3000, 1000]);
  assert.equal(hit.id, 3);
  assert.equal(displayForPoint([primary, portrait], [1000, 500]).id, 1);
});

test('fitWithin：长边 1568 与 1.15MP 取更小的 scale，且默认不放大', () => {
  const wide = fitWithin(4000, 1000, { maxPixels: 1e9 });
  assert.equal(wide.width, 1568);
  assert.equal(wide.height, 392);
  close(wide.scale, 1568 / 4000);

  const dense = fitWithin(1000, 2000, { maxLongEdge: 4096, maxPixels: 1150000 });
  assert.ok(dense.width * dense.height <= 1150000, `${dense.width}x${dense.height}`);
  close(dense.scale, Math.sqrt(1150000 / 2000000), 'pixels 主导');

  const small = fitWithin(100, 100);
  assert.deepEqual(small, { scale: 1, width: 100, height: 100 });

  const upscaled = fitWithin(100, 100, { allowUpscale: true, maxLongEdge: 400, maxPixels: 1e9 });
  assert.equal(upscaled.width, 400);

  assert.deepEqual(fitWithin(0, 0), { scale: 1, width: 0, height: 0 });
});

test('clampRectToDisplay：跨屏/负坐标裁剪，无交集返回零面积', () => {
  const clipped = clampRectToDisplay({ x: -3000, y: -50, w: 400, h: 200 }, left150.physicalBounds);
  assert.deepEqual(clipped, { x: -2880, y: 0, w: 280, h: 150 });
  const none = clampRectToDisplay({ x: 5000, y: 5000, w: 100, h: 100 }, primary.physicalBounds);
  assert.equal(none.w, 0);
  assert.equal(none.h, 0);
});

test('rectUnion：正常并集 + 空矩形不把并集拉到原点', () => {
  assert.deepEqual(rectUnion({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 0, y: 0, w: 15, h: 15 });
  assert.deepEqual(rectUnion({ x: 100, y: 100, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 0 }), { x: 100, y: 100, w: 10, h: 10 });
  assert.deepEqual(rectUnion({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }), { x: 0, y: 0, w: 0, h: 0 });
});

test('pointInRect 默认半开区间，闭区间可显式要求', () => {
  const rect = { x: 10, y: 20, w: 100, h: 50 };
  assert.equal(pointInRect([10, 20], rect), true);
  assert.equal(pointInRect([110, 70], rect), false, '右/下边界属于外部');
  assert.equal(pointInRect([110, 70], rect, { inclusive: true }), true);
  assert.equal(pointInRect([9, 20], rect), false);
  assert.equal(pointInRect([NaN, 20], rect), false);
  assert.equal(pointInRect([10, 20], { x: 10, y: 20, w: 0, h: 0 }), false);
});

test('validatePoint：越界/出窗口/非法坐标各自有稳定 code', () => {
  const ctx = { display: primary, crop: { x: 0, y: 0, w: 2880, h: 1800 }, captureScale: 0.47, dpr: 2 };
  assert.deepEqual(validatePoint([100, 200], ctx), { ok: true });

  const outOfBounds = validatePoint([-10, 200], ctx);
  assert.equal(outOfBounds.ok, false);
  assert.equal(outOfBounds.code, CODES.OUT_OF_BOUNDS);
  assert.equal(outOfBounds.detail.displayId, 1);

  const windowCtx = { ...ctx, window: { x: 100, y: 100, w: 400, h: 300 } };
  assert.deepEqual(validatePoint([120, 140], windowCtx), { ok: true });
  const outsideWindow = validatePoint([600, 140], windowCtx);
  assert.equal(outsideWindow.code, CODES.OUTSIDE_WINDOW);
  assert.deepEqual(outsideWindow.detail.window, { x: 100, y: 100, w: 400, h: 300 });

  assert.equal(validatePoint([NaN, 1], ctx).code, CODES.INVALID_POINT);
  assert.equal(validatePoint(null, ctx).code, CODES.INVALID_POINT);
});

test('rectOf / roundPoint：兼容 [x,y,w,h] 与 {x,y,width,height}', () => {
  assert.deepEqual(rectOf([1, 2, 3, 4]), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(rectOf({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(rectOf(null), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(roundPoint([10.4, 10.6]), [10, 11]);
});

test('displayForPoint 支持 DIP 空间查询', () => {
  const hit = displayForPoint([primary, left150], [-1800, 100], { space: 'dip' });
  assert.equal(hit.id, 2);
  assert.equal(displayForPoint([primary], [100, 100], { space: 'dip' }).id, 1);
  assert.equal(displayForPoint([], [0, 0]), null);
});
