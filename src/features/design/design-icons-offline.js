// Offline icon resolution for the design canvas (`design_apply` with `icon: "lucide:heart"`).
//
// Core's `insert_icon` asks Iconify over the network (api.iconify.design); when that host does not
// answer, every icon operation failed and the model had no way to draw one. The panel already
// ships 87 Lucide icons as plain geometry (`design-icons.js`), so the common names can be drawn
// without a round trip: this module turns that geometry into SVG markup that core's own
// `import_svg` accepts, and is tried before the network tool.
//
// Nothing here touches the document, the network or `eval`: it is pure data in, markup out, so it
// can be tested in Node exactly like the validators in design-node-spec.js.

import { DESIGN_ICONS } from './design-icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_BOX = '0 0 24 24';
const DEFAULT_SIZE = 24;
const DEFAULT_COLOR = '#000000';
const STROKE_WIDTH = 2;

/** Only the drawing primitives Lucide uses, so a malformed entry cannot smuggle in other markup. */
const ALLOWED_TAGS = new Set(['path', 'line', 'circle', 'rect', 'ellipse', 'polyline', 'polygon']);

/** An attribute name has to look like one before it is echoed into the markup. */
const ATTRIBUTE_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Icons the panel set does not carry but a model asks for constantly (`lucide:heart` is the
 * reported case). Same shape and same Lucide source as `design-icons.js`; copied rather than
 * imported because that file is generated and must stay untouched. A key that already exists in
 * `DESIGN_ICONS` is ignored, so this can never shadow the panel set.
 */
const EXTRA_ICONS = {
  'heart': [["path",{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}]],
  'home': [["path",{"d":"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"}],["path",{"d":"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}]],
  'user': [["path",{"d":"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"}],["circle",{"cx":"12","cy":"7","r":"4"}]],
  'users': [["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["path",{"d":"M16 3.128a4 4 0 0 1 0 7.744"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["circle",{"cx":"9","cy":"7","r":"4"}]],
  'mail': [["path",{"d":"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"}],["rect",{"x":"2","y":"4","width":"20","height":"16","rx":"2"}]],
  'bell': [["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"}]],
  'calendar': [["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}]],
  'clock': [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4 2"}]],
  'download': [["path",{"d":"M12 15V3"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["path",{"d":"m7 10 5 5 5-5"}]],
  'upload': [["path",{"d":"M12 3v12"}],["path",{"d":"m17 8-5-5-5 5"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}]],
  'settings': [["path",{"d":"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
  'trash': [["path",{"d":"M10 11v6"}],["path",{"d":"M14 11v6"}],["path",{"d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}],["path",{"d":"M3 6h18"}],["path",{"d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}]],
  'menu': [["path",{"d":"M4 5h16"}],["path",{"d":"M4 12h16"}],["path",{"d":"M4 19h16"}]],
  'info': [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 16v-4"}],["path",{"d":"M12 8h.01"}]],
  'map-pin': [["path",{"d":"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"}],["circle",{"cx":"12","cy":"10","r":"3"}]],
  'chevron-left': [["path",{"d":"m15 18-6-6 6-6"}]],
  'arrow-up': [["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]],
  'arrow-down': [["path",{"d":"M12 5v14"}],["path",{"d":"m19 12-7 7-7-7"}]],
  'circle-check': [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],
  'circle-alert': [["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],
  'edit': [["path",{"d":"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}],["path",{"d":"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"}]],
};

/** Every bundled icon, the panel set first so a supplement entry can never replace one of them. */
const ICONS = new Map();
for (const [name, parts] of [...Object.entries(DESIGN_ICONS), ...Object.entries(EXTRA_ICONS)]) {
  const key = String(name).trim();
  if (key !== '' && !ICONS.has(key) && Array.isArray(parts)) ICONS.set(key, parts);
}

/**
 * The bare icon name, or `null` when the name is not an icon this module can serve.
 * `'heart'` and `'lucide:heart'` both mean Lucide's heart; `'mdi:heart'` belongs to another set
 * and has to go to the network tool.
 */
function bareName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  if (trimmed.slice(0, colon).toLowerCase() !== 'lucide') return null;
  const rest = trimmed.slice(colon + 1).trim();
  return rest === '' ? null : rest;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => XML_ESCAPES[character]);
}

function positiveSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_SIZE;
}

/** `<path d="…"/>` for one `[tag, attributes]` pair, or `''` when the entry is not drawable. */
function renderElement(part) {
  if (!Array.isArray(part) || part.length < 1) return '';
  const [tag, attributes] = part;
  if (!ALLOWED_TAGS.has(tag)) return '';
  const pairs = [];
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (!ATTRIBUTE_NAME.test(name)) continue;
    if (value === null || value === undefined || value === '') continue;
    pairs.push(`${name}="${escapeXml(value)}"`);
  }
  return `<${tag}${pairs.length > 0 ? ` ${pairs.join(' ')}` : ''}/>`;
}

/** Whether `design_apply`'s `icon` can be drawn without the network. */
export function hasBundledIcon(name) {
  const bare = bareName(name);
  return bare !== null && ICONS.has(bare);
}

/** The bundled icon names, bare and sorted, for a prompt or a picker. */
export function listBundledIcons() {
  return [...ICONS.keys()].sort();
}

/**
 * A bounded slice of `listBundledIcons()`. Names only: the markup is what makes a prompt
 * expensive, and the model only needs the vocabulary.
 */
export function bundledIconCatalogue(limit = 80) {
  const names = listBundledIcons();
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : names.length;
  return names.slice(0, max);
}

/**
 * `import_svg`-ready markup for a bundled icon, or `null` when the name is not bundled.
 * Lucide draws on a 24×24 grid with a 2 px round stroke, which is why the outer `<svg>` carries
 * those attributes: `import_svg` then imports a correctly sized stroke icon.
 */
export function bundledIconSvg(name, options = {}) {
  const bare = bareName(name);
  const parts = bare === null ? undefined : ICONS.get(bare);
  if (!Array.isArray(parts)) return null;
  const size = positiveSize(options.size);
  const color = typeof options.color === 'string' && options.color.trim() !== ''
    ? options.color.trim()
    : DEFAULT_COLOR;
  const body = parts.map(renderElement).join('');
  return `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="${VIEW_BOX}"`
    + ` fill="none" stroke="${escapeXml(color)}" stroke-width="${STROKE_WIDTH}"`
    + ` stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
