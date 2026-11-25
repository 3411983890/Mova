// Strict schema validation and field writing for Mova's design canvas (`design_apply`).
//
// The canvas is driven by a model, so a field it invents has to fail loudly instead of being
// dropped: a silently ignored `shadow`/`gap` typo is how a layer used to come back "created" but
// wrong. The authoritative description is design/openpencil-tools-contract.md (§4 protocol,
// §5 sub-structures, §8 this module).
//
// The validators are plain data-in / data-out code with no editor, no `window` and no top-level
// `await`, so they can be exercised in Node without the canvas runtime. Only `createNode` /
// `updateNode` / `applyPaint` touch the toolkit.

import { parseColor, SECTION_DEFAULT_FILLS, weightToStyle } from '@open-pencil/core';
import { linearGradientTransform } from '@open-pencil/scene-graph/gradient';

import { bundledIconSvg, hasBundledIcon } from './design-icons-offline.js';

/** A rejected operation. `code` is one of the report codes in contract §6. */
export class SpecError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Layer types that a `create` operation may build with the plugin-API factories.
 *
 * `COMPONENT` is listed by contract §4.1 and has a `createComponent()` factory. `VECTOR` and
 * `GROUP` are deliberately absent: core cannot build an empty vector and has no group factory
 * (§12), so they have to arrive as `svg` / `icon` instead.
 */
export const NODE_TYPES = new Set([
  'FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'LINE', 'STAR', 'POLYGON', 'SECTION', 'COMPONENT',
]);

const LIMIT = 100000;
const MAX_LIST = 64;
const MAX_CHILDREN = 500;
const MAX_DEPTH = 12;

const COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Figma cannot resolve these, and neither can the document font manager: they must never reach a
// text node. Checked even when no font hook is installed so unit tests see the same failure.
const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset',
]);

// `#RRGGBBAA` is not a paint colour Figma understands, so it folds into the paint opacity instead.
const DEFAULT_SHADOW_COLOR = '#00000033';

// An image paint can carry its bytes inline, so a wrong payload has to be refused at write time
// rather than stored as a hash that paints nothing: 4 MB of decoded bytes is the ceiling, and the
// magic numbers are what tells a real PNG from a chunk of base64 text.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_SIGNATURES = [
  { format: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { format: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { format: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];
const DATA_URL = /^data:([^;,]*);base64,([\s\S]*)$/i;

// Mova's canvas clears transparent and draws its dot matrix beneath the sections, while OpenPencil's
// canvas is #1e1e1e behind them: the SDK's opaque section fill would read as a slab here. A section
// the caller did not paint keeps that same colour at this opacity, so it reads as a region.
const SECTION_FILL_OPACITY = 0.32;

const LAYOUT_MODES = ['NONE', 'HORIZONTAL', 'VERTICAL'];
const MAIN_AXIS_ALIGN = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'];
const CROSS_AXIS_ALIGN = ['MIN', 'CENTER', 'MAX', 'STRETCH'];
const LAYOUT_SIZING = ['FIXED', 'HUG', 'FILL'];
const TEXT_ALIGN = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'];
const TEXT_ALIGN_VERTICAL = ['TOP', 'CENTER', 'BOTTOM'];
const TEXT_AUTO_RESIZE = ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'];
const STROKE_ALIGN = ['INSIDE', 'CENTER', 'OUTSIDE'];
const IMAGE_SCALE_MODES = ['FILL', 'FIT', 'CROP', 'TILE'];
const EFFECT_KINDS = ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'];

const CREATE_KEYS = new Set([
  'action', 'parentId', 'type', 'name', 'x', 'y', 'width', 'height', 'clipsContent',
  'fills', 'strokes', 'effects', 'opacity', 'rotation', 'cornerRadius',
  'layout', 'text', 'children', 'jsx', 'svg', 'icon',
  // `size` / `color` are the icon extras of contract §4.6; they only matter with `icon`.
  'size', 'color',
  // Legacy flat aliases kept for older callers (contract §4.1 backward compatibility).
  'fill', 'gap', 'padding', 'layoutMode', 'fontSize', 'fontFamily', 'fontWeight',
  'textAlignHorizontal', 'layoutSizingHorizontal', 'layoutSizingVertical',
]);

const UPDATE_KEYS = new Set([
  'name', 'x', 'y', 'width', 'height', 'clipsContent',
  'fills', 'strokes', 'effects', 'opacity', 'rotation', 'cornerRadius',
  'layout', 'text',
  'fill', 'gap', 'padding', 'layoutMode', 'fontSize', 'fontFamily', 'fontWeight',
  'textAlignHorizontal', 'layoutSizingHorizontal', 'layoutSizingVertical',
]);

// Recognised fields that still cannot be changed through an update, with the reason to report.
const UPDATE_BLOCKED = new Map([
  ['type', '不能修改图层类型，请新建图层'],
  ['children', 'update 不能动子节点：新增请用 create，删除请用 delete'],
  ['jsx', 'jsx 已移除（内容安全策略禁用 eval）；结构请用 create 的嵌套 children，矢量请用 svg 或 icon'],
  ['svg', 'update 不能重建 SVG，请用 create 或 svg 工具'],
  ['icon', 'update 不能重建图标，请用 create 或 icon 工具'],
  ['parentId', 'update 不能改父级，请用重排工具'],
  ['action', 'action 属于操作对象，不属于 props'],
  ['size', 'size 只在 create 时用于图标'],
  ['color', 'color 只在 create 时用于图标，请改用 fills'],
]);

const TEXT_KEYS = new Set([
  'content', 'fontFamily', 'fontSize', 'fontWeight', 'italic',
  'lineHeight', 'letterSpacing', 'align', 'alignVertical', 'autoResize', 'color',
]);

const LAYOUT_KEYS = new Set(['mode', 'gap', 'padding', 'align', 'counterAlign', 'sizing']);
const LAYOUT_SIZING_KEYS = new Set(['horizontal', 'vertical']);
const PADDING_SIDES = ['top', 'right', 'bottom', 'left'];
const PADDING_KEYS = new Set(PADDING_SIDES);

const PAINT_KEYS = {
  SOLID: new Set(['type', 'color', 'opacity']),
  GRADIENT_LINEAR: new Set(['type', 'stops', 'angle']),
  IMAGE: new Set(['type', 'imageHash', 'base64', 'dataUrl', 'mimeType', 'scaleMode']),
};

const GRADIENT_STOP_KEYS = new Set(['position', 'color']);
const STROKE_KEYS = new Set(['color', 'weight', 'align', 'opacity']);
const SHADOW_KEYS = new Set(['type', 'color', 'x', 'y', 'blur', 'spread', 'visible']);
const BLUR_KEYS = new Set(['type', 'blur', 'visible']);

const FACTORIES = {
  FRAME: figma => figma.createFrame(),
  RECTANGLE: figma => figma.createRectangle(),
  ELLIPSE: figma => figma.createEllipse(),
  TEXT: figma => figma.createText(),
  LINE: figma => figma.createLine(),
  STAR: figma => figma.createStar(),
  POLYGON: figma => figma.createPolygon(),
  SECTION: figma => figma.createSection(),
  COMPONENT: figma => figma.createComponent(),
};

// --- small helpers -----------------------------------------------------------------------------

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value, field, limits = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SpecError('invalid_value', field, `${field} 必须是有限数字`);
  if (Math.abs(value) > LIMIT) throw new SpecError('invalid_value', field, `${field} 超出范围（绝对值最大 ${LIMIT}）`);
  if (limits.min !== undefined && value < limits.min) throw new SpecError('invalid_value', field, `${field} 不能小于 ${limits.min}`);
  if (limits.max !== undefined && value > limits.max) throw new SpecError('invalid_value', field, `${field} 不能大于 ${limits.max}`);
  return value;
}

function str(value, field) {
  if (typeof value !== 'string') throw new SpecError('invalid_value', field, `${field} 必须是字符串`);
  return value;
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new SpecError('invalid_value', field, `${field} 必须是布尔值`);
  return value;
}

function hex(value, field) {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    throw new SpecError('invalid_value', field, `${field} 必须是 #RGB / #RRGGBB / #RRGGBBAA 颜色`);
  }
  return value;
}

function pick(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new SpecError('invalid_value', field, `${field} 只能是 ${allowed.join(' | ')}`);
  }
  return value;
}

function assertKnownKeys(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (allowed.has(key)) continue;
    const field = path ? `${path}.${key}` : key;
    throw new SpecError('unknown_field', field, `未知字段 ${field}；允许：${[...allowed].join(', ')}`);
  }
}

function present(value) {
  return value !== undefined && value !== null;
}

// --- validation: paints / strokes / effects ----------------------------------------------------

function normalizePaintArray(value, field) {
  if (!Array.isArray(value)) throw new SpecError('invalid_value', field, `${field} 必须是数组`);
  if (value.length > MAX_LIST) {
    throw new SpecError('invalid_value', field, `${field} 一次最多 ${MAX_LIST} 项`);
  }
  return value.map((paint, index) => normalizePaint(paint, `${field}[${index}]`));
}

function normalizePaint(paint, field) {
  if (!isObject(paint)) throw new SpecError('invalid_value', field, `${field} 必须是对象`);
  const type = paint.type;
  if (typeof type !== 'string' || !Object.hasOwn(PAINT_KEYS, type)) {
    throw new SpecError('invalid_value', `${field}.type`, `不支持的填充类型 ${String(type)}；可用：SOLID, GRADIENT_LINEAR, IMAGE`);
  }
  assertKnownKeys(paint, PAINT_KEYS[type], field);

  if (type === 'SOLID') {
    if (!present(paint.color)) throw new SpecError('missing_field', `${field}.color`, 'SOLID 填充缺少 color');
    const solid = { type, color: hex(paint.color, `${field}.color`) };
    if (present(paint.opacity)) solid.opacity = num(paint.opacity, `${field}.opacity`, { min: 0, max: 1 });
    return solid;
  }

  if (type === 'GRADIENT_LINEAR') {
    if (!Array.isArray(paint.stops)) {
      throw new SpecError('missing_field', `${field}.stops`, 'GRADIENT_LINEAR 缺少 stops 数组');
    }
    if (paint.stops.length < 2 || paint.stops.length > 8) {
      throw new SpecError('invalid_value', `${field}.stops`, 'stops 必须是 2..8 个 { position, color }');
    }
    let previous = -Infinity;
    const stops = paint.stops.map((stop, index) => {
      const path = `${field}.stops[${index}]`;
      if (!isObject(stop)) throw new SpecError('invalid_value', path, `${path} 必须是对象`);
      assertKnownKeys(stop, GRADIENT_STOP_KEYS, path);
      if (!present(stop.position)) throw new SpecError('missing_field', `${path}.position`, '渐变停靠点缺少 position');
      if (!present(stop.color)) throw new SpecError('missing_field', `${path}.color`, '渐变停靠点缺少 color');
      const position = num(stop.position, `${path}.position`, { min: 0, max: 1 });
      if (position < previous) {
        throw new SpecError('invalid_value', `${path}.position`, '渐变停靠点的 position 必须非递减');
      }
      previous = position;
      return { position, color: hex(stop.color, `${path}.color`) };
    });
    const gradient = { type, stops };
    if (present(paint.angle)) gradient.angle = num(paint.angle, `${field}.angle`);
    return gradient;
  }

  // An image paint names its bytes one of three ways: an existing `imageHash`, or raw data as
  // `base64` / `dataUrl`. Exactly one, because two sources cannot agree on which image is meant
  // (contract §5 keeps `imageHash` for re-using an image the document already has).
  const given = ['imageHash', 'base64', 'dataUrl'].filter(key => present(paint[key]) && paint[key] !== '');
  if (given.length === 0) {
    throw new SpecError('missing_field', `${field}.imageHash`,
      'IMAGE 填充缺少图片来源：imageHash（复用文档里的图片）或 base64 / dataUrl（直接给图片数据）三选一');
  }
  if (given.length > 1) {
    throw new SpecError('invalid_value', `${field}.${given[1]}`,
      `IMAGE 填充的 ${given.join(' / ')} 只能给一个：imageHash 复用已有图片，base64 / dataUrl 直接提供图片数据`);
  }
  const image = { type };
  for (const key of given) image[key] = str(paint[key], `${field}.${key}`);
  if (present(paint.mimeType)) {
    const mimeType = str(paint.mimeType, `${field}.mimeType`);
    if (!/^image\/[\w.+-]+$/i.test(mimeType.trim())) {
      throw new SpecError('invalid_value', `${field}.mimeType`, 'mimeType 必须是 image/* 类型，例如 image/png');
    }
    image.mimeType = mimeType;
  }
  if (present(paint.scaleMode)) image.scaleMode = pick(paint.scaleMode, `${field}.scaleMode`, IMAGE_SCALE_MODES);
  return image;
}

function normalizeStrokeArray(value) {
  const field = 'strokes';
  if (!Array.isArray(value)) throw new SpecError('invalid_value', field, 'strokes 必须是数组');
  if (value.length > MAX_LIST) throw new SpecError('invalid_value', field, `strokes 一次最多 ${MAX_LIST} 项`);
  return value.map((stroke, index) => {
    const path = `strokes[${index}]`;
    if (!isObject(stroke)) throw new SpecError('invalid_value', path, `${path} 必须是对象`);
    assertKnownKeys(stroke, STROKE_KEYS, path);
    if (!present(stroke.color)) throw new SpecError('missing_field', `${path}.color`, '描边缺少 color');
    const out = { color: hex(stroke.color, `${path}.color`) };
    if (present(stroke.weight)) out.weight = num(stroke.weight, `${path}.weight`, { min: 0 });
    if (present(stroke.align)) out.align = pick(stroke.align, `${path}.align`, STROKE_ALIGN);
    if (present(stroke.opacity)) out.opacity = num(stroke.opacity, `${path}.opacity`, { min: 0, max: 1 });
    return out;
  });
}

function normalizeEffectArray(value) {
  const field = 'effects';
  if (!Array.isArray(value)) throw new SpecError('invalid_value', field, 'effects 必须是数组');
  if (value.length > MAX_LIST) throw new SpecError('invalid_value', field, `effects 一次最多 ${MAX_LIST} 项`);
  return value.map((effect, index) => {
    const path = `effects[${index}]`;
    if (!isObject(effect)) throw new SpecError('invalid_value', path, `${path} 必须是对象`);
    const type = effect.type;
    if (typeof type !== 'string' || !EFFECT_KINDS.includes(type)) {
      throw new SpecError('invalid_value', `${path}.type`, `不支持的效果类型 ${String(type)}；可用：${EFFECT_KINDS.join(', ')}`);
    }
    const blur = type === 'LAYER_BLUR' || type === 'BACKGROUND_BLUR';
    assertKnownKeys(effect, blur ? BLUR_KEYS : SHADOW_KEYS, path);
    const out = { type };
    if (!blur && present(effect.color)) out.color = hex(effect.color, `${path}.color`);
    for (const key of blur ? ['blur'] : ['x', 'y', 'blur']) {
      if (present(effect[key])) out[key] = num(effect[key], `${path}.${key}`);
    }
    if (out.blur !== undefined && out.blur < 0) {
      throw new SpecError('invalid_value', `${path}.blur`, 'blur 不能小于 0');
    }
    if (!blur && present(effect.spread)) out.spread = num(effect.spread, `${path}.spread`);
    if (present(effect.visible)) out.visible = bool(effect.visible, `${path}.visible`);
    return out;
  });
}

// --- validation: layout / text -----------------------------------------------------------------

function normalizePadding(value, field) {
  if (typeof value === 'number') {
    const uniform = num(value, field, { min: 0 });
    return { top: uniform, right: uniform, bottom: uniform, left: uniform };
  }
  if (!isObject(value)) {
    throw new SpecError('invalid_value', field, 'padding 必须是数字或 { top, right, bottom, left }');
  }
  assertKnownKeys(value, PADDING_KEYS, field);
  const padding = {};
  for (const side of PADDING_SIDES) {
    if (!present(value[side])) throw new SpecError('missing_field', `${field}.${side}`, `padding 缺少 ${side}`);
    padding[side] = num(value[side], `${field}.${side}`, { min: 0 });
  }
  return padding;
}

/**
 * `layout.sizing` is an object by design: a bare `'FIXED'` would leave the reader guessing which
 * axis it means, so the flat shorthand is refused with the value rules the axes use.
 */
function normalizeLayoutSizing(value, field) {
  if (!isObject(value)) {
    throw new SpecError('invalid_value', field, `${field} 必须是对象 { horizontal?, vertical? }，不能是单个字符串`);
  }
  assertKnownKeys(value, LAYOUT_SIZING_KEYS, field);
  const sizing = {};
  if (present(value.horizontal)) sizing.horizontal = pick(value.horizontal, `${field}.horizontal`, LAYOUT_SIZING);
  if (present(value.vertical)) sizing.vertical = pick(value.vertical, `${field}.vertical`, LAYOUT_SIZING);
  if (Object.keys(sizing).length === 0) {
    throw new SpecError('missing_field', `${field}.horizontal`, `${field} 至少要给出 horizontal 或 vertical`);
  }
  return sizing;
}

function normalizeLayout(value) {
  if (!isObject(value)) throw new SpecError('invalid_value', 'layout', 'layout 必须是对象');
  assertKnownKeys(value, LAYOUT_KEYS, 'layout');
  const layout = {};
  // `mode` is what the contract asks for, but the legacy `gap` / `padding` aliases describe a
  // partial layout on their own, so it is only required when nothing at all was given.
  if (present(value.mode)) layout.mode = pick(value.mode, 'layout.mode', LAYOUT_MODES);
  if (present(value.gap)) layout.gap = num(value.gap, 'layout.gap', { min: 0 });
  if (present(value.padding)) layout.padding = normalizePadding(value.padding, 'layout.padding');
  if (present(value.align)) layout.align = pick(value.align, 'layout.align', MAIN_AXIS_ALIGN);
  if (present(value.counterAlign)) layout.counterAlign = pick(value.counterAlign, 'layout.counterAlign', CROSS_AXIS_ALIGN);
  if (present(value.sizing)) layout.sizing = normalizeLayoutSizing(value.sizing, 'layout.sizing');
  if (Object.keys(layout).length === 0) throw new SpecError('missing_field', 'layout.mode', 'layout 缺少 mode');
  return layout;
}

function fontFamilyValue(value, hooks) {
  const family = str(value, 'text.fontFamily').trim();
  if (family === '') throw new SpecError('invalid_value', 'text.fontFamily', 'fontFamily 不能为空');
  if (GENERIC_FAMILIES.has(family.toLowerCase())) {
    throw new SpecError('generic_font_family', 'text.fontFamily',
      `fontFamily 不能是通用族名 ${family}；请写具体字体（如 "Inter"、"Microsoft YaHei"），可先查 design_fonts`);
  }
  if (hooks?.assertFontFamily) {
    try {
      hooks.assertFontFamily(family);
    } catch (error) {
      if (error instanceof SpecError) throw error;
      throw new SpecError(error?.code ?? 'font_not_available', 'text.fontFamily',
        error?.message ?? `字体不可用：${family}`);
    }
  }
  return family;
}

function normalizeTextObject(value, hooks) {
  const text = {};
  if (present(value.content)) text.content = str(value.content, 'text.content');
  if (present(value.fontFamily)) text.fontFamily = fontFamilyValue(value.fontFamily, hooks);
  if (present(value.fontSize)) text.fontSize = num(value.fontSize, 'text.fontSize', { min: 1 });
  if (present(value.fontWeight)) {
    const weight = num(value.fontWeight, 'text.fontWeight', { min: 100, max: 900 });
    if (weight % 100 !== 0) throw new SpecError('invalid_value', 'text.fontWeight', 'fontWeight 必须是 100..900 的整百');
    text.fontWeight = weight;
  }
  if (present(value.italic)) text.italic = bool(value.italic, 'text.italic');
  if (present(value.lineHeight)) {
    text.lineHeight = value.lineHeight === 'auto' ? 'auto' : num(value.lineHeight, 'text.lineHeight', { min: 0 });
  }
  if (present(value.letterSpacing)) text.letterSpacing = num(value.letterSpacing, 'text.letterSpacing');
  if (present(value.align)) text.align = pick(value.align, 'text.align', TEXT_ALIGN);
  if (present(value.alignVertical)) text.alignVertical = pick(value.alignVertical, 'text.alignVertical', TEXT_ALIGN_VERTICAL);
  if (present(value.autoResize)) text.autoResize = pick(value.autoResize, 'text.autoResize', TEXT_AUTO_RESIZE);
  if (present(value.color)) text.color = hex(value.color, 'text.color');
  return text;
}

// --- validation: shared fields -----------------------------------------------------------------

/**
 * Validate everything `create` and `update` have in common and write it into `target`.
 * `hooks.assertFontFamily` is optional so the pure validator works without the font module.
 */
function assignCommonFields(source, target, { hooks }) {
  if (present(source.name)) target.name = str(source.name, 'name');
  if (present(source.x)) target.x = num(source.x, 'x');
  if (present(source.y)) target.y = num(source.y, 'y');
  if (present(source.width)) target.width = num(source.width, 'width', { min: 0 });
  if (present(source.height)) target.height = num(source.height, 'height', { min: 0 });
  if (present(source.clipsContent)) target.clipsContent = bool(source.clipsContent, 'clipsContent');
  if (present(source.opacity)) target.opacity = num(source.opacity, 'opacity', { min: 0, max: 1 });
  if (present(source.rotation)) target.rotation = num(source.rotation, 'rotation');
  if (present(source.cornerRadius)) target.cornerRadius = num(source.cornerRadius, 'cornerRadius', { min: 0 });

  // `fill` is the single-colour legacy alias. Both at once is ambiguous, so it is an error rather
  // than a silent preference.
  if (present(source.fill) && present(source.fills)) {
    throw new SpecError('invalid_value', 'fill', 'fill 与 fills 不能同时出现；请统一用 fills');
  }
  if (present(source.fills)) target.fills = normalizePaintArray(source.fills, 'fills');
  if (present(source.fill)) target.fill = hex(source.fill, 'fill');

  if (present(source.strokes)) target.strokes = normalizeStrokeArray(source.strokes);
  if (present(source.effects)) target.effects = normalizeEffectArray(source.effects);

  // Legacy `layoutMode` / `gap` / `padding` fold into `layout`; an explicit `layout` wins.
  const layout = {};
  if (present(source.layoutMode)) layout.mode = pick(source.layoutMode, 'layoutMode', LAYOUT_MODES);
  if (present(source.gap)) layout.gap = num(source.gap, 'gap', { min: 0 });
  if (present(source.padding)) layout.padding = normalizePadding(source.padding, 'padding');
  if (present(source.layout)) Object.assign(layout, normalizeLayout(source.layout));
  if (Object.keys(layout).length > 0) target.layout = layout;

  // Legacy flat text keys fold into `text`, the shape `writeFields` reads.
  const flat = {};
  if (present(source.fontSize)) flat.fontSize = source.fontSize;
  if (present(source.fontFamily)) flat.fontFamily = source.fontFamily;
  if (present(source.fontWeight)) flat.fontWeight = source.fontWeight;
  if (present(source.textAlignHorizontal)) flat.align = source.textAlignHorizontal;

  let nested = {};
  if (typeof source.text === 'string') nested = { content: source.text };
  else if (isObject(source.text)) {
    assertKnownKeys(source.text, TEXT_KEYS, 'text');
    nested = normalizeTextObject(source.text, hooks);
  } else if (present(source.text)) {
    throw new SpecError('invalid_value', 'text', 'text 必须是字符串或对象');
  }
  const merged = { ...normalizeTextObject(flat, hooks), ...nested };
  if (Object.keys(merged).length > 0) target.text = merged;

  if (present(source.layoutSizingHorizontal)) {
    target.layoutSizingHorizontal = pick(source.layoutSizingHorizontal, 'layoutSizingHorizontal', LAYOUT_SIZING);
  }
  if (present(source.layoutSizingVertical)) {
    target.layoutSizingVertical = pick(source.layoutSizingVertical, 'layoutSizingVertical', LAYOUT_SIZING);
  }
}

/**
 * `svg` / `icon` are the two mutually exclusive ways to build a layer that has no primitive type.
 * `jsx` used to be the third; it is gone because Mova's renderer runs under a Content-Security
 * Policy without `unsafe-eval`, so core's `render` tool cannot compile JSX there. The key stays
 * recognised so a caller gets that reason instead of a bare `unknown_field`.
 */
function vectorSourceOf(spec) {
  if (present(spec.jsx)) {
    throw new SpecError('unsupported', 'jsx', '本应用的内容安全策略禁用 eval，JSX 无法执行，已移除 jsx 与 render 动作：结构请用 create 的嵌套 children 表达，矢量请用 svg（原始 SVG 标记）或 icon（内置图标名）');
  }
  const sources = ['svg', 'icon'].filter(key => present(spec[key]));
  if (sources.length > 1) {
    throw new SpecError('invalid_value', sources[1], 'svg / icon 二选一，不能同时出现');
  }
  for (const key of sources) str(spec[key], key);
  return sources[0];
}

function resolveType(spec, source) {
  if (present(spec.type) && typeof spec.type !== 'string') {
    throw new SpecError('invalid_value', 'type', 'type 必须是字符串');
  }
  // A vector source decides the layer, so an accompanying `type` is ignored (contract §4.1).
  if (source) return undefined;
  if (!present(spec.type)) {
    throw new SpecError('missing_field', 'type', '缺少 type；或改用 svg / icon 建立图层');
  }
  const type = spec.type.trim().toUpperCase();
  if (type === 'VECTOR' || type === 'GROUP') {
    throw new SpecError('unsupported', 'type', `${type} 无法直接创建；请改用 svg / icon`);
  }
  if (!NODE_TYPES.has(type)) {
    throw new SpecError('unsupported', 'type', `不支持的图层类型 ${spec.type}；可用：${[...NODE_TYPES].join(', ')}`);
  }
  return type;
}

function normalizeCreate(spec, context) {
  if (!isObject(spec)) throw new SpecError('invalid_value', 'spec', '每个图层必须是对象');
  assertKnownKeys(spec, CREATE_KEYS, '');

  const source = vectorSourceOf(spec);
  const type = resolveType(spec, source);
  const normalized = {};
  if (present(spec.action)) normalized.action = str(spec.action, 'action');
  if (present(spec.parentId)) normalized.parentId = str(spec.parentId, 'parentId');
  if (type) normalized.type = type;
  if (source) normalized[source] = spec[source];
  if (present(spec.size)) normalized.size = num(spec.size, 'size', { min: 1 });
  if (present(spec.color)) normalized.color = hex(spec.color, 'color');

  assignCommonFields(spec, normalized, { hooks: context.hooks });

  // Text fields only make sense on a TEXT layer; anything else would be silently ignored.
  if (normalized.text !== undefined) {
    if (type !== 'TEXT') {
      throw new SpecError('unsupported', 'text', type
        ? `text / fontSize / fontFamily 只适用于 TEXT，当前类型是 ${type}`
        : 'text / fontSize / fontFamily 只适用于 TEXT，不能和 svg / icon 同时使用');
    }
    if (typeof normalized.text.content !== 'string') {
      throw new SpecError('missing_field', 'text.content', 'TEXT 图层必须给出 text.content（或旧字段 text）');
    }
  } else if (type === 'TEXT') {
    throw new SpecError('missing_field', 'text.content', 'TEXT 图层必须给出 text.content（或旧字段 text）');
  }

  if (present(spec.children)) {
    if (!Array.isArray(spec.children)) throw new SpecError('invalid_value', 'children', 'children 必须是数组');
    if (spec.children.length > MAX_CHILDREN) {
      throw new SpecError('invalid_value', 'children', `children 一次最多 ${MAX_CHILDREN} 个`);
    }
    if (context.depth >= MAX_DEPTH) {
      throw new SpecError('invalid_value', 'children', `children 嵌套最多 ${MAX_DEPTH} 层`);
    }
    normalized.children = spec.children.map(child => normalizeCreate(child, {
      hooks: context.hooks,
      depth: context.depth + 1,
    }));
  }
  return normalized;
}

/**
 * Validate one `create` operation (or one child of it) and return the normalized spec.
 * `options.hooks` is optional: without it font families are only checked against the generic list.
 */
export function validateNodeSpec(spec, options = {}) {
  const index = present(options.index) ? options.index : null;
  try {
    return normalizeCreate(spec, { hooks: options.hooks ?? null, depth: 0 });
  } catch (error) {
    // Carry the operation index on the error so a batch can report which item failed.
    if (index !== null && error instanceof SpecError) error.index = index;
    throw error;
  }
}

/** Validate an `update.props` patch and return the normalized patch. */
export function validateProps(patch, options = {}) {
  if (!isObject(patch)) throw new SpecError('invalid_value', 'props', 'props 必须是对象');
  for (const [key, reason] of UPDATE_BLOCKED) {
    if (Object.hasOwn(patch, key)) throw new SpecError('unsupported', key, `${key} 不能在 props 里修改：${reason}`);
  }
  assertKnownKeys(patch, UPDATE_KEYS, '');
  if (options.allowGeometry === false) {
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Object.hasOwn(patch, key)) {
        throw new SpecError('unsupported', key, `此操作不允许修改 ${key}`);
      }
    }
  }
  const normalized = {};
  assignCommonFields(patch, normalized, { hooks: options.hooks ?? null });
  return normalized;
}

// --- field writing -----------------------------------------------------------------------------

/**
 * A hex colour as Figma keeps paint colours, plus the `#RRGGBBAA` alpha to fold into `opacity`.
 * Figma stores paint opacity separately from the colour, so the alpha cannot stay in `color`.
 */
function paintColor(value) {
  const parsed = parseColor(value);
  const alpha = typeof parsed.a === 'number' && Number.isFinite(parsed.a) ? parsed.a : 1;
  return { color: { r: parsed.r, g: parsed.g, b: parsed.b, a: 1 }, alpha };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function startsWithBytes(bytes, signature) {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** `PNG` / `JPEG` / `WEBP` / `GIF` for bytes a browser can paint, `null` for anything else. */
function imageFormat(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  for (const signature of IMAGE_SIGNATURES) {
    if (startsWithBytes(bytes, signature.bytes)) return signature.format;
  }
  if (startsWithBytes(bytes, WEBP_RIFF) && bytes.length >= 12
    && WEBP_TAG.every((byte, index) => bytes[8 + index] === byte)) {
    return 'WEBP';
  }
  return null;
}

/** Base64 → bytes. `atob` is the renderer's own decoder and rejects anything malformed. */
function decodeBase64(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact === '') throw new Error('空字符串');
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The bytes a `base64` / `dataUrl` paint carries, checked before they reach the scene graph: a
 * wrong payload must fail here, because an image fill with unusable bytes paints nothing and the
 * model would otherwise report success.
 */
function imageBytes(figma, paint, field) {
  const key = paint.base64 !== undefined ? 'base64' : 'dataUrl';
  const path = `${field}.${key}`;
  let text = paint[key];
  let mimeType = paint.mimeType ?? null;
  if (key === 'dataUrl') {
    const match = DATA_URL.exec(String(text).trim());
    if (!match) {
      throw new SpecError('invalid_value', path,
        'dataUrl 必须是 data:<mime>;base64,<数据> 形式；也可以只传 base64（不含 data: 前缀）');
    }
    if (!mimeType && match[1]) mimeType = match[1];
    text = match[2];
  }
  let bytes;
  try {
    bytes = decodeBase64(String(text));
  } catch (error) {
    throw new SpecError('invalid_value', path,
      `${key} 不是合法的 Base64 图片数据（${messageOf(error)}）；请传图片文件本身的编码内容`);
  }
  if (bytes.length === 0) throw new SpecError('invalid_value', path, `${key} 解码后没有任何字节`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new SpecError('invalid_value', path,
      `图片数据解码后 ${bytes.length} 字节，超过上限 ${MAX_IMAGE_BYTES} 字节（4 MB）；请缩小图片`);
  }
  const format = imageFormat(bytes);
  if (!format) {
    throw new SpecError('invalid_value', path,
      `解码结果不是可识别的图片（只支持 PNG / JPEG / WEBP / GIF）${mimeType ? `；声明的 mimeType 是 ${mimeType}` : ''}。`
      + ' 请确认 base64 来自图片文件本身，而不是文本、HTML 或 SVG');
  }
  return bytes;
}

/**
 * The hash an image paint should store, resolved at write time so both the `fills` path and
 * `applyPaint` are covered: an `imageHash` that is not in `graph.images` would paint nothing, so
 * it is refused instead of silently stored, and inline bytes are registered with `createImage`.
 */
function resolveImageHash(figma, paint, field) {
  if (paint.imageHash !== undefined) {
    const images = figma.graph?.images;
    if (!(images instanceof Map) || !images.has(paint.imageHash)) {
      throw new SpecError('invalid_value', `${field}.imageHash`,
        `未知的 imageHash ${paint.imageHash}：当前文档里没有这张图片，imageHash 只能复用文档中已有的图片；`
        + ' 请改传 base64 或 dataUrl（data:image/png;base64,…）来提供图片数据');
    }
    return paint.imageHash;
  }
  const bytes = imageBytes(figma, paint, field);
  let created;
  try {
    created = figma.createImage(bytes);
  } catch (error) {
    throw new SpecError('invalid_value', `${field}.${paint.base64 !== undefined ? 'base64' : 'dataUrl'}`,
      `图片数据无法写入画板：${messageOf(error)}`);
  }
  if (!created || typeof created.hash !== 'string' || created.hash === '') {
    throw new SpecError('invalid_value', `${field}.base64`, '图片数据没有换到 imageHash：画板拒绝了这份数据');
  }
  return created.hash;
}

function buildFills(paints, figma) {
  return paints.map((paint, index) => {
    if (paint.type === 'SOLID') {
      const { color, alpha } = paintColor(paint.color);
      return { type: 'SOLID', color, opacity: (paint.opacity ?? 1) * alpha, visible: true };
    }
    if (paint.type === 'GRADIENT_LINEAR') {
      // 0° runs left → right; the angle grows clockwise on screen, where y points down.
      const radians = (paint.angle ?? 0) * Math.PI / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const start = { x: 0.5 - 0.5 * cos, y: 0.5 - 0.5 * sin };
      const end = { x: 0.5 + 0.5 * cos, y: 0.5 + 0.5 * sin };
      return {
        type: 'GRADIENT_LINEAR',
        color: parseColor(paint.stops[0].color),
        opacity: 1,
        visible: true,
        gradientStops: paint.stops.map(stop => ({ position: stop.position, color: parseColor(stop.color) })),
        gradientTransform: linearGradientTransform(start, end),
      };
    }
    return {
      type: 'IMAGE',
      color: parseColor('#000000'),
      opacity: 1,
      visible: true,
      imageHash: resolveImageHash(figma, paint, `fills[${index}]`),
      imageScaleMode: paint.scaleMode ?? 'FILL',
    };
  });
}

function buildStrokes(strokes) {
  return strokes.map(stroke => {
    const { color, alpha } = paintColor(stroke.color);
    return {
      type: 'SOLID',
      color,
      opacity: (stroke.opacity ?? 1) * alpha,
      visible: true,
      weight: stroke.weight ?? 1,
      align: stroke.align ?? 'INSIDE',
    };
  });
}

/**
 * Scene effects in the shape Figma's plugin API takes, because the proxy `effects` setter
 * validates against Figma's effect schema: shadows name a blend mode and blurs carry no colour.
 */
function buildEffects(effects) {
  return effects.map(effect => {
    if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
      return { type: effect.type, radius: effect.blur ?? 0, visible: effect.visible ?? true };
    }
    return {
      type: effect.type,
      color: parseColor(effect.color ?? DEFAULT_SHADOW_COLOR),
      offset: { x: effect.x ?? 0, y: effect.y ?? 0 },
      radius: effect.blur ?? 0,
      spread: effect.spread ?? 0,
      visible: effect.visible ?? true,
      blendMode: 'NORMAL',
    };
  });
}

/**
 * Write one paint list onto a node. Kept separate from `writeFields` so the gradient math and the
 * "paint the whole list at once" semantics have a single owner.
 */
export async function applyPaint(toolkit, nodeId, fills) {
  const figma = toolkit.figma();
  const node = figma.getNodeById(nodeId);
  if (!node) throw new SpecError('invalid_value', 'id', `找不到图层 ${nodeId}`);
  node.fills = buildFills(normalizePaintArray(fills, 'fills'), figma);
  return 'fills';
}

/** The paint list of a spec: explicit `fills`, else `text.color`, else the legacy `fill`. */
function resolveFills(spec) {
  if (spec.fills !== undefined) return spec.fills;
  if (spec.text?.color !== undefined) return [{ type: 'SOLID', color: spec.text.color }];
  if (spec.fill !== undefined) return [{ type: 'SOLID', color: spec.fill }];
  return null;
}

function applyLayout(node, layout) {
  const changed = [];
  if (layout.mode !== undefined) { node.layoutMode = layout.mode; changed.push('layoutMode'); }
  if (layout.gap !== undefined) { node.itemSpacing = layout.gap; changed.push('itemSpacing'); }
  if (layout.padding) {
    for (const side of PADDING_SIDES) {
      const field = `padding${side[0].toUpperCase()}${side.slice(1)}`;
      node[field] = layout.padding[side];
      changed.push(field);
    }
  }
  if (layout.align !== undefined) { node.primaryAxisAlignItems = layout.align; changed.push('primaryAxisAlignItems'); }
  if (layout.counterAlign !== undefined) { node.counterAxisAlignItems = layout.counterAlign; changed.push('counterAxisAlignItems'); }
  return changed;
}

async function applyText(figma, node, text, hooks) {
  const changed = [];
  const weight = text.fontWeight;
  const italic = text.italic ?? false;
  if (text.fontFamily !== undefined) {
    const style = weightToStyle(weight ?? 400, italic);
    // The font must be in the document before the name is assigned, otherwise the text measures
    // and paints with a fallback face.
    if (hooks?.loadFont) {
      try {
        await hooks.loadFont(text.fontFamily, style);
      } catch (error) {
        throw new SpecError(error?.code ?? 'font_not_available', 'text.fontFamily',
          error?.message ?? `字体加载失败：${text.fontFamily}`);
      }
    }
    node.fontName = { family: text.fontFamily, style };
    changed.push('fontName');
  }
  if (text.content !== undefined) { node.characters = text.content; changed.push('characters'); }
  if (text.fontSize !== undefined) { node.fontSize = text.fontSize; changed.push('fontSize'); }
  if (weight !== undefined) { node.fontWeight = weight; changed.push('fontWeight'); }
  if (text.align !== undefined) { node.textAlignHorizontal = text.align; changed.push('textAlignHorizontal'); }
  if (text.alignVertical !== undefined) { node.textAlignVertical = text.alignVertical; changed.push('textAlignVertical'); }
  if (text.autoResize !== undefined) { node.textAutoResize = text.autoResize; changed.push('textAutoResize'); }

  // `lineHeight` and `letterSpacing` are written straight to the graph. The proxy setters take
  // Figma's `{ unit, value }` object form and route the value through per-character style runs,
  // while the scene stores one px number per node -- which is also what design_read reports back.
  const graph = figma.graph;
  const spacing = {};
  if (text.lineHeight !== undefined) spacing.lineHeight = text.lineHeight === 'auto' ? null : text.lineHeight;
  if (text.letterSpacing !== undefined) spacing.letterSpacing = text.letterSpacing;
  if (text.italic !== undefined) spacing.italic = italic;
  if (Object.keys(spacing).length > 0) {
    graph.updateNode(node.id, spacing);
    if (spacing.lineHeight !== undefined) changed.push('lineHeight');
    if (spacing.letterSpacing !== undefined) changed.push('letterSpacing');
    if (spacing.italic !== undefined) changed.push('italic');
  }
  return changed;
}

/**
 * A new SECTION starts with the SDK's opaque theme fill (`#444444` in dark). Mova's canvas clears
 * transparent and draws its dot matrix beneath the sections, where OpenPencil's own canvas is
 * `#1e1e1e` behind them, so that fill reads as an opaque slab instead of a region. The same colour
 * at a low opacity fixes that without inventing a palette, and the dashed default stroke that
 * `newLayerDefaults` installed is left exactly as it is.
 */
function softenSectionFill(figma, node) {
  const theme = figma.theme === 'light' ? 'light' : 'dark';
  const base = SECTION_DEFAULT_FILLS[theme] ?? SECTION_DEFAULT_FILLS.dark;
  if (!base) return false;
  node.fills = [{ ...base, color: { ...base.color }, opacity: SECTION_FILL_OPACITY, visible: true }];
  return true;
}

/** Whether `layoutSizing*` can be written at all: Figma refuses it outside auto-layout. */
function hasAutoLayout(figma, node) {
  if (node.layoutMode !== undefined && node.layoutMode !== 'NONE') return true;
  const graph = figma.graph;
  const scene = typeof graph?.getNode === 'function' ? graph.getNode(node.id) : null;
  const parent = scene?.parentId && typeof graph.getNode === 'function' ? graph.getNode(scene.parentId) : null;
  return Boolean(parent && parent.layoutMode !== 'NONE');
}

/**
 * Sizing, in the only order that keeps an explicit size (R1).
 *
 * A new frame hugs its content (`createFrame()` leaves `primaryAxisSizing: 'HUG'`), so switching
 * auto-layout on collapses a frame that was given `width: 300` to the width of its children. Hence:
 *
 *   1. `applyLayout` runs first and sets `layoutMode` (and the rest of the layout);
 *   2. the caller's explicit `layout.sizing` values are written next -- they are the answer, not a
 *      guess, so nothing below overrides them;
 *   3. an axis the caller sized explicitly (`width` / `height`) but did not mention in `sizing` is
 *      pinned to `FIXED` -- only there, so a caller that asks for `HUG` keeps its hug;
 *   4. the size is re-applied with `resize()`, which is what actually restores the width after the
 *      hug already collapsed it in step 1.
 *
 * The legacy flat `layoutSizingHorizontal` / `layoutSizingVertical` aliases are written after this
 * block by `writeFields` (their historical position, after `text`), so they win over the pin: they
 * count as explicit and the pin never fires for those axes.
 */
function applySizing(toolkit, node, spec, size) {
  const changed = [];
  const explicit = new Set();
  // The legacy aliases are written later; treating them as explicit keeps the pin from duplicating
  // (and contradicting) them.
  if (spec.layoutSizingHorizontal !== undefined) explicit.add('horizontal');
  if (spec.layoutSizingVertical !== undefined) explicit.add('vertical');

  const sizing = spec.layout?.sizing;
  // Figma refuses HUG / FILL outside auto-layout (the proxy setter throws); report that against the
  // field the caller wrote instead of letting a bare proxy error escape the operation.
  const writeAxis = (axis, value, field) => {
    try {
      if (axis === 'horizontal') node.layoutSizingHorizontal = value;
      else node.layoutSizingVertical = value;
    } catch (error) {
      throw new SpecError('invalid_value', field, `${field} 无法写入：${messageOf(error)}`);
    }
  };
  if (sizing?.horizontal !== undefined) {
    writeAxis('horizontal', sizing.horizontal, 'layout.sizing.horizontal');
    explicit.add('horizontal');
    changed.push('layoutSizingHorizontal');
  }
  if (sizing?.vertical !== undefined) {
    writeAxis('vertical', sizing.vertical, 'layout.sizing.vertical');
    explicit.add('vertical');
    changed.push('layoutSizingVertical');
  }

  const pin = hasAutoLayout(toolkit.figma(), node);
  if (pin && size?.width !== undefined && !explicit.has('horizontal')) {
    node.layoutSizingHorizontal = 'FIXED';
    changed.push('layoutSizingHorizontal');
  }
  if (pin && size?.height !== undefined && !explicit.has('vertical')) {
    node.layoutSizingVertical = 'FIXED';
    changed.push('layoutSizingVertical');
  }

  if (size?.width !== undefined || size?.height !== undefined) {
    node.resize(size.width ?? node.width, size.height ?? node.height);
  }
  return changed;
}

/**
 * Write every present field of `spec` onto an existing node, in the contract's order, and return
 * the names of the fields that were actually written.
 *
 * `size` is the explicit size the caller gave (`spec.width` / `spec.height` of a create, or the
 * patch of an update): `applySizing` needs it to pin and then restore the axes the caller sized.
 */
async function writeFields({ toolkit, node, spec, hooks, size }) {
  const changed = [];

  if (spec.clipsContent !== undefined) { node.clipsContent = spec.clipsContent; changed.push('clipsContent'); }
  if (spec.cornerRadius !== undefined) { node.cornerRadius = spec.cornerRadius; changed.push('cornerRadius'); }
  if (spec.opacity !== undefined) { node.opacity = spec.opacity; changed.push('opacity'); }

  const fills = resolveFills(spec);
  if (fills) changed.push(await applyPaint(toolkit, node.id, fills));
  if (spec.strokes) { node.strokes = buildStrokes(spec.strokes); changed.push('strokes'); }
  if (spec.effects) { node.effects = buildEffects(spec.effects); changed.push('effects'); }

  if (spec.layout) changed.push(...applyLayout(node, spec.layout));
  changed.push(...applySizing(toolkit, node, spec, size));

  if (spec.text && node.type === 'TEXT') {
    changed.push(...await applyText(toolkit.figma(), node, spec.text, hooks));
  }

  if (spec.layoutSizingHorizontal !== undefined) {
    node.layoutSizingHorizontal = spec.layoutSizingHorizontal;
    changed.push('layoutSizingHorizontal');
  }
  if (spec.layoutSizingVertical !== undefined) {
    node.layoutSizingVertical = spec.layoutSizingVertical;
    changed.push('layoutSizingVertical');
  }

  // Rotation is applied last, and written to the graph rather than through the proxy. The proxy's
  // `rotation` setter and getter disagree on sign (`rotation: 15` read back as -15), and any later
  // geometric write -- `resize` in particular -- recomputes the angle from the transform matrix and
  // loses precision, so a value written earlier comes back as 14.999999999999998. `SceneNode.rotation`
  // is the degrees value the renderer rotates by (`Matrix.rotated(rotation * PI / 180)`), so writing
  // it after the size is settled is what makes it round-trip exactly.
  if (spec.rotation !== undefined) {
    toolkit.figma().graph.updateNode(node.id, { rotation: spec.rotation });
    changed.push('rotation');
  }
  return changed;
}

// --- creation ----------------------------------------------------------------------------------

function createdId(result, source) {
  if (result && typeof result === 'object') {
    if (typeof result.id === 'string') return result.id;
    for (const list of [result.inserted, result.siblings]) {
      if (Array.isArray(list) && typeof list[0]?.id === 'string') return list[0].id;
    }
  }
  throw new SpecError('invalid_value', 'id', `${source} 没有返回图层 id`);
}

function requireNode(toolkit, id, field) {
  const node = toolkit.figma().getNodeById(id);
  if (!node) throw new SpecError('invalid_value', field, `找不到图层 ${id}`);
  return node;
}

function placeNode(node, spec) {
  if (spec.name !== undefined) node.name = spec.name;
  if (spec.x !== undefined) node.x = spec.x;
  if (spec.y !== undefined) node.y = spec.y;
}

function createWithFactory(toolkit, spec, parentId) {
  const figma = toolkit.figma();
  const factory = FACTORIES[spec.type];
  if (!factory) throw new SpecError('unsupported', 'type', `不支持的图层类型 ${String(spec.type)}`);
  // The plugin-API factories are used instead of the `create_shape` tool, whose strict schema
  // would reject the extra fields a design_apply operation carries (fills, effects, layout...).
  const node = factory(figma);
  // A section is the one layer whose SDK default fill is visible as a slab on Mova's transparent
  // canvas (R5). Only when the caller paints nothing: an explicit `fills` / `fill` is written by
  // `writeFields` afterwards anyway, and guessing over it would be wrong.
  if (node.type === 'SECTION' && spec.fills === undefined && spec.fill === undefined) {
    softenSectionFill(figma, node);
  }
  placeNode(node, spec);
  if (spec.width !== undefined || spec.height !== undefined) {
    node.resize(spec.width ?? node.width, spec.height ?? node.height);
  }
  if (parentId) {
    const parent = figma.getNodeById(parentId);
    if (!parent) throw new SpecError('invalid_value', 'parentId', `父图层 ${parentId} 不存在`);
    parent.appendChild(node);
  }
  return node;
}

async function createSvg(toolkit, spec, parentId) {
  const result = await toolkit.run('import_svg', {
    svg: spec.svg,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    ...(spec.color !== undefined ? { color: spec.color } : {}),
    ...(spec.x !== undefined ? { x: spec.x } : {}),
    ...(spec.y !== undefined ? { y: spec.y } : {}),
  });
  const node = requireNode(toolkit, createdId(result, 'import_svg'), 'id');
  placeNode(node, spec);
  return node;
}

async function createIcon(toolkit, spec, parentId) {
  // An icon takes its colour from the tool (it replaces `currentColor`), so legacy `fill` is used
  // as that colour rather than painted over the icon frame afterwards.
  const color = spec.color ?? spec.fill;
  const size = spec.size;

  // Bundled Lucide icons are drawn locally first: `insert_icon` needs Iconify over the network, so
  // an offline desktop would fail every `lucide:*` operation. `import_svg` is already on the
  // allow-list and takes the very markup built here (R3a).
  if (hasBundledIcon(spec.icon)) {
    const svg = bundledIconSvg(spec.icon, { size: size ?? 24, color: color ?? '#000000' });
    if (svg) {
      const result = await toolkit.run('import_svg', {
        svg,
        ...(parentId ? { parent_id: parentId } : {}),
        ...(spec.name !== undefined ? { name: spec.name } : {}),
        ...(spec.x !== undefined ? { x: spec.x } : {}),
        ...(spec.y !== undefined ? { y: spec.y } : {}),
      });
      const node = requireNode(toolkit, createdId(result, 'import_svg'), 'id');
      placeNode(node, spec);
      return node;
    }
  }

  // Not bundled: the network tool is the only remaining source, and its failure keeps its own code
  // (`network` when the host cannot be reached) through the toolkit's error mapping.
  const result = await toolkit.run('insert_icon', {
    name: spec.icon,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(color !== undefined ? { color } : {}),
  });
  const node = requireNode(toolkit, createdId(result, 'insert_icon'), 'id');
  // insert_icon has no x/y arguments, so the created icon is positioned afterwards.
  placeNode(node, spec);
  return node;
}

async function createOne(context, spec, parentId, depth) {
  if (depth > MAX_DEPTH) {
    throw new SpecError('invalid_value', 'children', `children 嵌套最多 ${MAX_DEPTH} 层`);
  }
  let node;
  if (spec.svg !== undefined) node = await createSvg(context.toolkit, spec, parentId);
  else if (spec.icon !== undefined) node = await createIcon(context.toolkit, spec, parentId);
  else node = createWithFactory(context.toolkit, spec, parentId);

  // An icon already consumed legacy `fill` as its own colour, so it must not be painted over the
  // icon frame afterwards (that would colour the whole bounding box).
  const fieldSpec = spec.icon !== undefined && spec.fill !== undefined ? { ...spec, fill: undefined } : spec;
  // The size travels down: `applySizing` pins the axes the caller sized explicitly and then
  // re-applies the size, which is what keeps a `width: 300` frame from hugging its content.
  await writeFields({
    toolkit: context.toolkit,
    node,
    spec: fieldSpec,
    hooks: context.hooks,
    size: { width: spec.width, height: spec.height },
  });
  context.created.push({ id: node.id, name: node.name, type: node.type });

  if (spec.children) {
    for (const child of spec.children) await createOne(context, child, node.id, depth + 1);
  }
  return node.id;
}

/**
 * Create the layer described by `spec` (and its children) and return the flat list of layers the
 * operation produced, plus the root id.
 */
export async function createNode({ toolkit, spec, parentId, hooks }) {
  const normalized = validateNodeSpec(spec, { hooks });
  const created = [];
  const rootId = await createOne({ toolkit, hooks, created }, normalized, parentId || undefined, 0);
  return { created, rootId };
}

/** Apply a patch to an existing node and report the field names that were written. */
export async function updateNode({ toolkit, id, patch, hooks }) {
  const normalized = validateProps(patch, { hooks });
  const node = requireNode(toolkit, id, 'id');
  const changed = [];

  // Text fields cannot be validated against the layer type before the node is known, so the check
  // happens here instead of silently dropping them.
  if (normalized.text !== undefined && node.type !== 'TEXT') {
    throw new SpecError('unsupported', 'text', `text / fontSize / fontFamily 只适用于 TEXT，${id} 是 ${node.type}`);
  }

  if (normalized.x !== undefined) {
    node.x = normalized.x;
    changed.push('x');
  }
  if (normalized.y !== undefined) {
    node.y = normalized.y;
    changed.push('y');
  }
  if (normalized.width !== undefined || normalized.height !== undefined) {
    node.resize(normalized.width ?? node.width, normalized.height ?? node.height);
    if (normalized.width !== undefined) changed.push('width');
    if (normalized.height !== undefined) changed.push('height');
  }
  if (normalized.name !== undefined) {
    node.name = normalized.name;
    changed.push('name');
  }

  // The patch's own geometry goes down with the fields: `applySizing` pins an axis the patch sized
  // explicitly and re-applies the size, so `width` survives turning auto-layout on.
  changed.push(...await writeFields({
    toolkit,
    node,
    spec: normalized,
    hooks,
    size: { width: normalized.width, height: normalized.height },
  }));
  return { changed };
}
