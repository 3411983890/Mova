'use strict';
// SoM 标注（Set-of-Marks）：把 UIA 可交互元素的矩形画到截图上，模型只回 `#12`。
// 标注样式照 Mova桌面操作开发方案.md §8.3：
//   - 候选框 1px 半透明描边 #4DA3FF，不填充（填充会盖住图标）；
//   - 左上角 2 位数字标签，底 #000A、白字 11px；
//   - 最近一次命中的框用 #8EE7FF。
//
// pickMarks 是纯函数（可单测）；annotate 只在最后一步用 sharp 合成 SVG。

const INTERACTIVE_ROLES = new Set([
  'button', 'splitbutton', 'edit', 'combobox', 'checkbox', 'radiobutton',
  'tabitem', 'tab', 'listitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'treeitem', 'dataitem', 'slider', 'spinner', 'hyperlink', 'check', 'link',
  'textbox', 'searchbox', 'switch', 'option', 'toolbar item', 'toolbaritem',
]);

// 容器/装饰：即使有名字也不该成为点击目标（会把界面框成一整块）
const CONTAINER_ROLES = new Set([
  'window', 'pane', 'group', 'custom', 'document', 'dialog', 'toolbar', 'menubar',
  'menu', 'list', 'table', 'grid', 'datagrid', 'tree', 'tablist', 'statusbar',
  'titlebar', 'scrollbar', 'separator', 'thumb', 'progressbar', 'caret', 'image',
  'text', 'label', 'static', 'heading', 'paragraph', 'region', 'application',
]);

const MARK_COLOR = '#4DA3FF';
const HIT_COLOR = '#8EE7FF';
const LABEL_BG = '#000000AA';
const LABEL_COLOR = '#FFFFFF';
const LABEL_FONT_SIZE = 11;
const LABEL_HEIGHT = 14;
const MIN_SIZE = 8; // 小于 8px 的框点不准，不标
const MAX_CONTAINER_AREA = 250000; // 容器角色超过这个面积（≈500x500）就不是点击目标
const DUPLICATE_TOLERANCE = 2;
const CONTAIN_RATIO = 0.92;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rectOf(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const x = num(raw[0], NaN);
    const y = num(raw[1], NaN);
    const w = num(raw[2], NaN);
    const h = num(raw[3], NaN);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return { x, y, w, h };
  }
  if (typeof raw === 'object') {
    const x = num(raw.x, NaN);
    const y = num(raw.y, NaN);
    const w = num(raw.w !== undefined ? raw.w : raw.width, NaN);
    const h = num(raw.h !== undefined ? raw.h : raw.height, NaN);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return { x, y, w, h };
  }
  return null;
}

function areaOf(rect) {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function overlapArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function containment(inner, outer) {
  const area = areaOf(inner);
  if (area <= 0) return 0;
  return overlapArea(inner, outer) / area;
}

function sameBox(a, b, tolerance = DUPLICATE_TOLERANCE) {
  return Math.abs(a.x - b.x) <= tolerance
    && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.w - b.w) <= tolerance
    && Math.abs(a.h - b.h) <= tolerance;
}

function isInteractive(node) {
  const role = String(node.role || '').toLowerCase();
  if (INTERACTIVE_ROLES.has(role)) return true;
  // 自绘应用（Qt/Flutter）常用 custom/document 角色，但会带 Invoke/Value 之类 Pattern，
  // 所以 Pattern 判断要排在容器排除之前，否则微信这类界面永远标不出东西。
  const patterns = Array.isArray(node.patterns) ? node.patterns.map((item) => String(item).toLowerCase()) : [];
  const hasAction = patterns.some((item) => ['invoke', 'value', 'selectionitem', 'toggle', 'expandcollapse', 'scroll', 'legacyiaccessible'].includes(item));
  if (hasAction) return true;
  // 有名字且可聚焦：自绘控件通常长这样（微信的输入框/发送键）
  if (node.states && node.states.focusable === true && Boolean(node.name)) return true;
  if (CONTAINER_ROLES.has(role)) return false;
  return false;
}

function rankOf(node) {
  const role = String(node.role || '').toLowerCase();
  if (INTERACTIVE_ROLES.has(role)) return 0;
  return 1;
}

function skipNode(node) {
  const states = node.states || {};
  if (states.offscreen === true) return true;
  if (states.password === true) return true; // 密码框不进模型视野
  const role = String(node.role || '').toLowerCase();
  if (CONTAINER_ROLES.has(role) && !isInteractive(node)) return true;
  return false;
}

function normalizeMark(node) {
  const box = rectOf(node.rect || node.box);
  if (!box) return null;
  if (box.w < MIN_SIZE || box.h < MIN_SIZE) return null;
  const name = typeof node.name === 'string' ? node.name.replace(/\s+/g, ' ').trim() : '';
  const role = String(node.role || 'custom').toLowerCase();
  // 完全无名、不可交互的节点对模型没有信息量
  if (!name && !isInteractive(node)) return null;
  // 自绘应用里整个面板也可能带名字+可聚焦；面积过大的容器不是点击目标
  if (CONTAINER_ROLES.has(role) && areaOf(box) > MAX_CONTAINER_AREA) return null;
  return {
    role,
    name: name.length > 48 ? `${name.slice(0, 47)}…` : name,
    box,
    stableKey: typeof node.stableKey === 'string' ? node.stableKey : '',
    rank: rankOf(node),
    area: areaOf(box),
    ref: typeof node.ref === 'string' ? node.ref : '',
  };
}

/**
 * 从 UIA 节点里挑可以标号的候选（纯函数）。
 * 排序：可交互优先 -> 面积大优先 -> 阅读顺序（上到下、左到右）。
 * 去重：完全重合的框只留一个；被更高优先级框几乎完全包含的（≥92%）去掉。
 * @param {object[]} nodes
 * @param {number|{limit?:number}} [limit=40]
 * @returns {{id:number, role:string, name:string, box:{x,y,w,h}, ref?:string, stableKey?:string}[]}
 */
function pickMarks(nodes, limit = 40) {
  const options = typeof limit === 'number' ? { limit } : (limit || {});
  const max = Math.max(1, Math.min(99, Math.round(num(options.limit, 40) || 40)));
  const list = Array.isArray(nodes) ? nodes : [];
  const candidates = [];
  for (const node of list) {
    if (!node || typeof node !== 'object') continue;
    if (skipNode(node)) continue;
    const mark = normalizeMark(node);
    if (mark) candidates.push(mark);
  }

  candidates.sort((a, b) => (a.rank - b.rank) || (b.area - a.area) || (a.box.y - b.box.y) || (a.box.x - b.box.x));

  const kept = [];
  for (const candidate of candidates) {
    const duplicate = kept.find((mark) => sameBox(mark.box, candidate.box));
    if (duplicate) continue;
    const contained = kept.find((mark) => mark.rank <= candidate.rank
      && containment(candidate.box, mark.box) >= CONTAIN_RATIO);
    if (contained) continue;
    kept.push(candidate);
    if (kept.length >= max) break;
  }

  return kept.map((mark, index) => ({
    id: index + 1,
    role: mark.role,
    name: mark.name,
    box: { ...mark.box },
    ...(mark.ref ? { ref: mark.ref } : {}),
    ...(mark.stableKey ? { stableKey: mark.stableKey } : {}),
  }));
}

/** 同 pickMarks，但可把框换算到图像空间（capture 缩放/裁剪）。 */
function marksFromTree(nodes, options = {}) {
  const marks = pickMarks(nodes, options.limit !== undefined ? options.limit : 40);
  const scale = options.boxScale !== undefined ? options.boxScale : 1;
  const sx = typeof scale === 'object' ? num(scale.x !== undefined ? scale.x : scale.sx, 1) : num(scale, 1);
  const sy = typeof scale === 'object' ? num(scale.y !== undefined ? scale.y : scale.sy, 1) : num(scale, 1);
  const ox = num(options.offsetX, 0);
  const oy = num(options.offsetY, 0);
  return marks.map((mark) => ({
    ...mark,
    box: {
      x: (mark.box.x - ox) * sx,
      y: (mark.box.y - oy) * sy,
      w: mark.box.w * sx,
      h: mark.box.h * sy,
    },
  }));
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clampBox(box, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(box.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(box.y)));
  const w = Math.max(1, Math.min(width - x, Math.round(box.w)));
  const h = Math.max(1, Math.min(height - y, Math.round(box.h)));
  return { x, y, w, h };
}

function boxScaleOf(scale) {
  if (scale && typeof scale === 'object') {
    return { sx: num(scale.x !== undefined ? scale.x : scale.sx, 1), sy: num(scale.y !== undefined ? scale.y : scale.sy, 1) };
  }
  const s = num(scale, 1) || 1;
  return { sx: s, sy: s };
}

/**
 * 在截图上画 SoM 标注（不填充，只描边 + 数字标签）。
 * @param {Buffer} buffer PNG/JPEG
 * @param {object} options
 * @param {object[]} options.marks [{id, box:[x,y,w,h]|{x,y,w,h}}]
 * @param {number|{x:number,y:number}} [options.boxScale=1] 把框换算到图像空间
 * @param {number} [options.hitId] 最近一次命中的 mark id（换成 #8EE7FF）
 * @param {object} [options.sharp] 注入 sharp（默认 require）
 * @returns {Promise<{buffer:Buffer, marks:object[], width:number, height:number}>}
 */
async function annotate(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw Object.assign(new Error('annotate 需要 Buffer'), { code: 'bad-image' });
  }
  const sharp = options.sharp || require('sharp');
  const marks = Array.isArray(options.marks) ? options.marks : [];
  const { sx, sy } = boxScaleOf(options.boxScale);
  const meta = await sharp(buffer).metadata();
  const width = num(meta.width);
  const height = num(meta.height);
  if (!(width > 0) || !(height > 0)) {
    throw Object.assign(new Error('无法读取图片尺寸'), { code: 'bad-image' });
  }
  const hitId = options.hitId !== undefined ? num(options.hitId, -1) : -1;

  const drawMarks = [];
  const parts = [];
  for (const mark of marks) {
    const raw = rectOf(mark.box || mark.rect);
    if (!raw) continue;
    const box = clampBox({ x: raw.x * sx, y: raw.y * sy, w: raw.w * sx, h: raw.h * sy }, width, height);
    const id = num(mark.id, drawMarks.length + 1);
    const color = id === hitId ? HIT_COLOR : MARK_COLOR;
    const label = String(id).slice(0, 2);
    const labelWidth = Math.max(14, label.length * 7 + 4);
    // 标签贴在框左上角外沿；框顶部没有空间时塞进框内
    const labelX = Math.max(0, Math.min(width - labelWidth, box.x));
    const labelY = box.y - LABEL_HEIGHT >= 0 ? box.y - LABEL_HEIGHT : Math.min(height - LABEL_HEIGHT, box.y);
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="${color}" stroke-opacity="0.9" stroke-width="1"/>`);
    parts.push(`<rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="${LABEL_HEIGHT}" rx="2" ry="2" fill="${LABEL_BG}"/>`);
    parts.push(`<text x="${labelX + 3}" y="${labelY + LABEL_FONT_SIZE}" font-family="Segoe UI, Arial, sans-serif" font-size="${LABEL_FONT_SIZE}" font-weight="600" fill="${LABEL_COLOR}">${escapeText(label)}</text>`);
    drawMarks.push({ ...mark, id, imageBox: box });
  }

  if (!parts.length) return { buffer, marks: drawMarks, width, height };

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
  const out = await sharp(buffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { buffer: out, marks: drawMarks, width, height };
}

module.exports = {
  annotate,
  pickMarks,
  marksFromTree,
  // 常量（测试与标注样式复用）
  INTERACTIVE_ROLES,
  CONTAINER_ROLES,
  MARK_COLOR,
  HIT_COLOR,
  LABEL_BG,
};
