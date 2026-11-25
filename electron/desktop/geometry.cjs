'use strict';
// 坐标换算：图像坐标 ↔ 物理像素 ↔ DIP。纯函数，不 require('electron')、不碰文件系统。
//
// 空间定义（照 Mova桌面操作开发方案.md §3.4）：
//   physical  物理像素，虚拟桌面绝对坐标（多屏拼接，原点在最左屏左上，可为负）
//   dip       Electron screen 的逻辑坐标（display.bounds / getCursorScreenPoint）
//   image     模型看到的那张图（裁剪 + 缩放之后）
//   model     与 image 同空间，必须先 validatePoint 再反算
//
// ctx 形状（capture.cjs 产出，其它模块消费）：
//   {
//     display: { id, scaleFactor, bounds:{x,y,w,h}, physicalBounds:{x,y,w,h} },
//     crop: {x,y,w,h},        // 物理像素，绝对坐标（display 原点已算进去）
//     captureScale: 0.47,     // image = (physical - crop.origin) * captureScale
//     dpr: 2                  // display.scaleFactor
//   }
//
// 约定：点是 [x,y] 数组，矩形是 {x,y,w,h}（与 tree.cjs 的 rectOf 同形，
// 也接受 {x,y,width,height} 与 [x,y,w,h] 输入）。

const DEFAULT_MAX_LONG_EDGE = 1568;
const DEFAULT_MAX_PIXELS = 1150000; // 1.15MP，见 §8.2

const CODES = Object.freeze({
  INVALID_POINT: 'point-invalid',
  OUT_OF_BOUNDS: 'point-out-of-bounds',
  OUTSIDE_WINDOW: 'point-outside-window',
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 任意矩形写法 -> {x,y,w,h}。 */
function rectOf(raw) {
  if (!raw) return { x: 0, y: 0, w: 0, h: 0 };
  if (Array.isArray(raw)) {
    return { x: num(raw[0]), y: num(raw[1]), w: Math.max(0, num(raw[2])), h: Math.max(0, num(raw[3])) };
  }
  if (typeof raw === 'object') {
    const w = raw.w !== undefined ? raw.w : (raw.width !== undefined ? raw.width : 0);
    const h = raw.h !== undefined ? raw.h : (raw.height !== undefined ? raw.height : 0);
    return { x: num(raw.x), y: num(raw.y), w: Math.max(0, num(w)), h: Math.max(0, num(h)) };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function pointOf(raw) {
  if (Array.isArray(raw)) {
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  if (raw && typeof raw === 'object') {
    const x = Number(raw.x);
    const y = Number(raw.y);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  return null;
}

function isRectEmpty(rect) {
  const r = rectOf(rect);
  return r.w <= 0 || r.h <= 0;
}

/** 显示器归一化：补齐 physicalBounds 与 scaleFactor，负坐标原样保留。 */
function normalizeDisplay(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const scaleFactor = Math.max(0.1, num(src.scaleFactor, 1) || 1);
  const bounds = src.bounds ? rectOf(src.bounds) : rectOf({
    x: src.x,
    y: src.y,
    w: src.width !== undefined ? src.width : src.w,
    h: src.height !== undefined ? src.height : src.h,
  });
  // physicalBounds 优先：Windows 上 display.bounds 是 DIP，乘 scaleFactor 只对整数缩放严格成立，
  // 非整数缩放（125%/150%）会有取整误差，所以只要调用方给了物理矩形就用它。
  const physicalBounds = src.physicalBounds
    ? rectOf(src.physicalBounds)
    : {
      x: Math.round(bounds.x * scaleFactor),
      y: Math.round(bounds.y * scaleFactor),
      w: Math.round(bounds.w * scaleFactor),
      h: Math.round(bounds.h * scaleFactor),
    };
  return {
    ...src,
    id: src.id !== undefined ? src.id : null,
    scaleFactor,
    bounds,
    physicalBounds,
    primary: src.primary === true,
  };
}

function captureScaleOf(ctx) {
  const scale = num(ctx && ctx.captureScale, 1);
  return scale > 0 ? scale : 1;
}

function cropOf(ctx) {
  return rectOf(ctx && ctx.crop);
}

/**
 * 图像坐标 → 物理像素（虚拟桌面绝对坐标）。
 * phys = crop.origin + image / captureScale
 * @param {number[]|{x:number,y:number}} point
 * @param {{crop:object, captureScale:number}} ctx
 * @returns {number[]} [x,y]（不做取整；注入前用 roundPoint）
 */
function toPhysical(point, ctx) {
  const p = pointOf(point);
  if (!p) return [NaN, NaN];
  const crop = cropOf(ctx);
  const scale = captureScaleOf(ctx);
  return [crop.x + p[0] / scale, crop.y + p[1] / scale];
}

/**
 * 物理像素 → 图像坐标。
 * image = (physical - crop.origin) * captureScale
 */
function toImage(point, ctx) {
  const p = pointOf(point);
  if (!p) return [NaN, NaN];
  const crop = cropOf(ctx);
  const scale = captureScaleOf(ctx);
  return [(p[0] - crop.x) * scale, (p[1] - crop.y) * scale];
}

/**
 * 物理像素 → DIP（ctx.display 所属屏幕）。
 * dip = display.bounds.origin + (physical - display.physicalBounds.origin) / dpr
 */
function toDip(point, ctx) {
  const p = pointOf(point);
  if (!p) return [NaN, NaN];
  const display = normalizeDisplay(ctx && ctx.display);
  const dpr = Math.max(0.1, num(ctx && ctx.dpr, display.scaleFactor) || display.scaleFactor || 1);
  return [
    display.bounds.x + (p[0] - display.physicalBounds.x) / dpr,
    display.bounds.y + (p[1] - display.physicalBounds.y) / dpr,
  ];
}

/** DIP → 物理像素。 */
function toPhysicalFromDip(point, ctx) {
  const p = pointOf(point);
  if (!p) return [NaN, NaN];
  const display = normalizeDisplay(ctx && ctx.display);
  const dpr = Math.max(0.1, num(ctx && ctx.dpr, display.scaleFactor) || display.scaleFactor || 1);
  return [
    display.physicalBounds.x + (p[0] - display.bounds.x) * dpr,
    display.physicalBounds.y + (p[1] - display.bounds.y) * dpr,
  ];
}

/** 图像矩形 → 物理矩形（顺序同上，裁剪原点 + 反缩放）。 */
function rectToPhysical(rect, ctx) {
  const r = rectOf(rect);
  const [x, y] = toPhysical([r.x, r.y], ctx);
  const scale = captureScaleOf(ctx);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    w: r.w / scale,
    h: r.h / scale,
  };
}

/** 物理矩形 → 图像矩形。 */
function rectToImage(rect, ctx) {
  const r = rectOf(rect);
  const [x, y] = toImage([r.x, r.y], ctx);
  const scale = captureScaleOf(ctx);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    w: r.w * scale,
    h: r.h * scale,
  };
}

/**
 * 找出点落在哪块屏幕（默认按物理像素；{space:'dip'} 时按 DIP）。
 * 默认只返回“包含该点”的屏幕，找不到返回 null —— 绝不回退到别的屏，
 * 否则 point-out-of-bounds 会被悄悄吞掉（§8.4）。
 * @param {object[]} displays Electron display 数组或 normalizeDisplay 结果
 * @param {number[]|{x:number,y:number}} point
 * @param {{space?:'physical'|'dip', fallback?:'nearest'|'primary'|'none'}} [options]
 */
function displayForPoint(displays, point, options = {}) {
  const p = pointOf(point);
  const list = Array.isArray(displays) ? displays.map(normalizeDisplay) : [];
  if (!p || !list.length) return null;
  const space = options.space === 'dip' ? 'dip' : 'physical';
  const key = space === 'dip' ? 'bounds' : 'physicalBounds';
  for (const display of list) {
    if (pointInRect(p, display[key], { inclusive: false })) return display;
  }
  const fallback = options.fallback || 'none';
  if (fallback === 'primary') return list.find((display) => display.primary) || list[0] || null;
  if (fallback === 'nearest') {
    let best = null;
    let bestDistance = Infinity;
    for (const display of list) {
      const b = display[key];
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const distance = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
      if (distance < bestDistance) { best = display; bestDistance = distance; }
    }
    return best;
  }
  return null;
}

/**
 * 等比缩放到 token 预算内：长边 ≤ maxLongEdge、总像素 ≤ maxPixels，取更小的 scale。
 * 默认只缩不放（放大不增加信息，只烧 token）。
 * @returns {{scale:number, width:number, height:number}}
 */
function fitWithin(width, height, options = {}) {
  const maxLongEdge = Number.isFinite(Number(options.maxLongEdge)) && Number(options.maxLongEdge) > 0
    ? Number(options.maxLongEdge) : DEFAULT_MAX_LONG_EDGE;
  const maxPixels = Number.isFinite(Number(options.maxPixels)) && Number(options.maxPixels) > 0
    ? Number(options.maxPixels) : DEFAULT_MAX_PIXELS;
  const w = num(width);
  const h = num(height);
  if (!(w > 0) || !(h > 0)) {
    return { scale: 1, width: Math.max(0, Math.round(w)), height: Math.max(0, Math.round(h)) };
  }
  const candidates = [];
  const longEdge = Math.max(w, h);
  if (longEdge > 0) candidates.push(maxLongEdge / longEdge);
  candidates.push(Math.sqrt(maxPixels / (w * h)));
  let scale = Math.min(...candidates.filter((value) => Number.isFinite(value) && value > 0));
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  if (options.allowUpscale !== true) scale = Math.min(1, scale);
  return {
    scale,
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** 矩形裁剪到屏幕内；无交集返回零面积矩形（保留原点，便于报错定位）。 */
function clampRectToDisplay(rect, bounds) {
  const r = rectOf(rect);
  const b = rectOf(bounds);
  const left = Math.max(r.x, b.x);
  const top = Math.max(r.y, b.y);
  const right = Math.min(r.x + r.w, b.x + b.w);
  const bottom = Math.min(r.y + r.h, b.y + b.h);
  if (right <= left || bottom <= top) {
    return { x: Math.round(left), y: Math.round(top), w: 0, h: 0 };
  }
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

/** 两个矩形的并集；空矩形不参与（避免 (0,0,0,0) 把并集拉到原点）。 */
function rectUnion(a, b) {
  const r1 = rectOf(a);
  const r2 = rectOf(b);
  const e1 = isRectEmpty(r1);
  const e2 = isRectEmpty(r2);
  if (e1 && e2) return { x: r1.x, y: r1.y, w: 0, h: 0 };
  if (e1) return { ...r2 };
  if (e2) return { ...r1 };
  const left = Math.min(r1.x, r2.x);
  const top = Math.min(r1.y, r2.y);
  const right = Math.max(r1.x + r1.w, r2.x + r2.w);
  const bottom = Math.max(r1.y + r1.h, r2.y + r2.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 点是否在矩形内。默认半开区间 [x, x+w)，可传 {inclusive:true} 走闭区间。 */
function pointInRect(point, rect, options = {}) {
  const p = pointOf(point);
  if (!p) return false;
  const r = rectOf(rect);
  if (r.w <= 0 || r.h <= 0) return false;
  const inclusive = options.inclusive === true;
  const inX = inclusive ? p[0] >= r.x && p[0] <= r.x + r.w : p[0] >= r.x && p[0] < r.x + r.w;
  const inY = inclusive ? p[1] >= r.y && p[1] <= r.y + r.h : p[1] >= r.y && p[1] < r.y + r.h;
  return inX && inY;
}

/** 取整到物理像素（注入前用）。 */
function roundPoint(point) {
  const p = pointOf(point);
  if (!p) return [NaN, NaN];
  return [Math.round(p[0]), Math.round(p[1])];
}

/**
 * 反算后的校验（§8.4 清单前两条；第三条 WindowFromPoint 由 actions.cjs 做）。
 * @param {number[]|{x:number,y:number}} point 物理像素
 * @param {{display:object, window?:object}} ctx window 是物理矩形或 {rect}
 * @returns {{ok:boolean, code?:string, detail?:object}}
 */
function validatePoint(point, ctx = {}) {
  const p = pointOf(point);
  if (!p) return { ok: false, code: CODES.INVALID_POINT, detail: { point: null } };
  const display = ctx.display ? normalizeDisplay(ctx.display) : null;
  if (display && !pointInRect(p, display.physicalBounds)) {
    return {
      ok: false,
      code: CODES.OUT_OF_BOUNDS,
      detail: { point: p, displayId: display.id, physicalBounds: display.physicalBounds },
    };
  }
  const rawWindow = ctx.window && ctx.window.rect ? ctx.window.rect : ctx.window;
  if (rawWindow) {
    const windowRect = rectOf(rawWindow);
    if (!isRectEmpty(windowRect) && !pointInRect(p, windowRect)) {
      return { ok: false, code: CODES.OUTSIDE_WINDOW, detail: { point: p, window: windowRect } };
    }
  }
  return { ok: true };
}

const EMPTY_RECT = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });

module.exports = {
  // 换算
  toPhysical,
  toImage,
  toDip,
  toPhysicalFromDip,
  rectToPhysical,
  rectToImage,
  // 屏幕
  normalizeDisplay,
  displayForPoint,
  // 预算
  fitWithin,
  // 矩形
  rectOf,
  rectUnion,
  clampRectToDisplay,
  pointInRect,
  isRectEmpty,
  roundPoint,
  // 校验
  validatePoint,
  // 常量
  CODES,
  EMPTY_RECT,
  DEFAULT_MAX_LONG_EDGE,
  DEFAULT_MAX_PIXELS,
};
