/* 引用浮层的定位算子（方案 §4.6）。

   纯函数：不读 DOM、不碰 window，`tests/quote-position.test.mjs` 在 Node 里直接 import。
   坐标约定：anchorRect 与 bounds 用**同一套坐标系**（通常是视口坐标），
   返回的 left/top 是相对 bounds 左上角的偏移 —— 正好可以写进
   `.browser-stage` 内 `position: absolute` 的浮层。

   规则（与方案 §3.8 / §4.6 一致）：
   - 默认放在锚点上方 6px；上方放不下（含越界）翻到下方；
   - 上下都放不下时选空间大的一侧，再夹进 bounds；
   - 水平方向以锚点左边缘对齐，左右夹在 bounds 内 10px；
   - bounds 尺寸为 0（面板刚插入 / display:none）时退化成贴 margin，绝不返回 NaN。
*/

/** 浮层与锚点之间的间距。 */
export const POPOVER_GAP = 6;
/** 浮层与面板边缘的最小距离。 */
export const POPOVER_MARGIN = 10;

/** 视觉上最小的浮层尺寸，量不到尺寸（未布局）时用它兜底。 */
const FALLBACK_SIZE = { width: 0, height: 0 };

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value, fallback) {
  const number = finite(value);
  return number != null && number >= 0 ? number : fallback;
}

/**
 * 宽容地归一化矩形：既接受 DOMRect（left/top/width/height/right/bottom），
 * 也接受 CDP 的 `{x, y, w, h}`。非法输入返回 null。
 * @returns {{left:number, top:number, width:number, height:number, right:number, bottom:number}|null}
 */
export function normalizeRect(input) {
  if (!input || typeof input !== 'object') return null;
  const left = finite(input.left) ?? finite(input.x);
  const top = finite(input.top) ?? finite(input.y);
  const width = finite(input.width) ?? finite(input.w);
  const height = finite(input.height) ?? finite(input.h);
  const right = finite(input.right);
  const bottom = finite(input.bottom);
  if (left == null && top == null && width == null && height == null && right == null && bottom == null) {
    return null;
  }
  const resolvedLeft = left ?? (right != null && width != null ? right - width : 0);
  const resolvedTop = top ?? (bottom != null && height != null ? bottom - height : 0);
  const resolvedWidth = Math.max(0, width ?? (right != null ? right - resolvedLeft : 0));
  const resolvedHeight = Math.max(0, height ?? (bottom != null ? bottom - resolvedTop : 0));
  return {
    left: resolvedLeft,
    top: resolvedTop,
    width: resolvedWidth,
    height: resolvedHeight,
    right: resolvedLeft + resolvedWidth,
    bottom: resolvedTop + resolvedHeight,
  };
}

/**
 * 计算浮层位置。
 * @param {{left?:number, top?:number, width?:number, height?:number, right?:number, bottom?:number,
 *   x?:number, y?:number, w?:number, h?:number}} anchorRect 锚点（选区末行 / 元素矩形）
 * @param {{width?:number, height?:number, w?:number, h?:number}} size 浮层实测尺寸
 * @param {{left?:number, top?:number, width?:number, height?:number}} bounds 面板 / 视口
 * @param {number} [gap=POPOVER_GAP]
 * @param {number} [margin=POPOVER_MARGIN]
 * @returns {{left:number, top:number, placement:'top'|'bottom'}}
 */
export function placePopover(anchorRect, size, bounds, gap = POPOVER_GAP, margin = POPOVER_MARGIN) {
  const anchor = normalizeRect(anchorRect) ?? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const box = normalizeRect(bounds);
  const boxLeft = box ? box.left : 0;
  const boxTop = box ? box.top : 0;
  const boxWidth = box ? box.width : 0;
  const boxHeight = box ? box.height : 0;

  const g = positive(gap, POPOVER_GAP);
  const m = positive(margin, POPOVER_MARGIN);
  const width = positive(size?.width ?? size?.w, FALLBACK_SIZE.width);
  const height = positive(size?.height ?? size?.h, FALLBACK_SIZE.height);

  // 换算到 bounds 坐标系，越界的锚点（anchor 部分/完全在面板外）也按真实距离判断。
  const anchorLeft = anchor.left - boxLeft;
  const anchorTop = anchor.top - boxTop;
  const anchorBottom = anchor.bottom - boxTop;

  const roomAbove = anchorTop - g - m;
  const roomBelow = boxHeight - m - (anchorBottom + g);

  let placement;
  if (roomAbove >= height) placement = 'top';
  else if (roomBelow >= height) placement = 'bottom';
  else placement = roomAbove >= roomBelow ? 'top' : 'bottom';

  let top = placement === 'top' ? anchorTop - g - height : anchorBottom + g;

  // 竖直夹取：放得下就夹进 [margin, 下边界-margin]，放不下就钉在上边。
  const maxTop = boxHeight - m - height;
  top = maxTop < m ? m : Math.min(Math.max(top, m), maxTop);

  // 水平夹取：左边缘对齐锚点，超出面板时向里推；浮层比面板还宽就贴左边。
  const maxLeft = boxWidth - m - width;
  const left = maxLeft < m ? m : Math.min(Math.max(anchorLeft, m), maxLeft);

  return { left: Math.round(left), top: Math.round(top), placement };
}
