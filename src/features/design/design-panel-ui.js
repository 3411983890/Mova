import { h } from 'vue';
import { BLEND_MODES } from '@open-pencil/core';

import { DESIGN_ICONS } from './design-icons.js';

/* ------------------------------------------------------------------ icons */

/**
 * Panel-only glyphs the generated set does not carry. `cursor-click` is copied verbatim from
 * `@keyline-icons/react` (`CursorClick`), which is what the browser toolbar's picker renders after
 * `replaceStaticIcons`, so both pick buttons look identical. The design bundle cannot import that
 * package — it is a separate build without React — hence the literal geometry.
 */
const PANEL_EXTRA_ICONS = {
  'cursor-click': [['path', { d: 'M12.1748 5.76261L13.9549 3.98724M7.88236 4.69633L6.98121 2M4.70404 7.86707L2 6.96809M5.77258 12.14803L3.99248 13.9234M9.26992 9.88622L13.0143 21.6534C13.1515 22.0847 13.7482 22.1234 13.9403 21.7136L16.4099 16.4449C16.4625 16.3328 16.5551 16.2442 16.6697 16.1967L21.6933 14.1113C22.1184 13.9348 22.0964 13.3269 21.6597 13.1814L9.90251 9.26472C9.51618 9.13602 9.14671 9.49902 9.26992 9.88622Z' }]],
};

const icon = (name, extra) => {
  const geometry = DESIGN_ICONS[name] ?? PANEL_EXTRA_ICONS[name];
  if (!geometry) throw new Error(`unknown design icon: ${name}`);
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      // An explicit default keeps an unstyled icon from falling back to 300 × 150.
      width: 12,
      height: 12,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      ...extra,
    },
    geometry.map(([tag, attributes]) => h(tag, attributes)),
  );
};

/** The undo/redo arrows keep the browser toolbar's back/forward reading. */
const arrow = direction =>
  h('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2.1,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, [h('path', { d: direction === 'back' ? 'M19 12H5m6-6-6 6 6 6' : 'M5 12h14m-6-6 6 6-6 6' })]);

const pagesGlyph = () =>
  h('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, [h('rect', { x: '3', y: '4', width: '18', height: '16', rx: '2.5' }), h('path', { d: 'M9 4v16' })]);

export const BLEND_LABELS = {
  PASS_THROUGH: '穿透',
  NORMAL: '正常',
  DARKEN: '变暗',
  MULTIPLY: '正片叠底',
  COLOR_BURN: '颜色加深',
  LIGHTEN: '变亮',
  SCREEN: '滤色',
  COLOR_DODGE: '颜色减淡',
  OVERLAY: '叠加',
  SOFT_LIGHT: '柔光',
  HARD_LIGHT: '强光',
  DIFFERENCE: '差值',
  EXCLUSION: '排除',
  HUE: '色相',
  SATURATION: '饱和度',
  COLOR: '颜色',
  LUMINOSITY: '明度',
};

const EFFECT_LABELS = {
  DROP_SHADOW: '投影',
  INNER_SHADOW: '内阴影',
  LAYER_BLUR: '图层模糊',
  BACKGROUND_BLUR: '背景模糊',
};

/* ------------------------------------------------------------------ tools */

const TOOL_GROUPS = [
  { key: 'SELECT', label: '移动', keycap: 'V', glyph: 'mouse-pointer' },
  {
    key: 'FRAME',
    label: '画板',
    keycap: 'F',
    glyph: 'frame',
    flyout: [
      { key: 'FRAME', label: '画板', keycap: 'F', glyph: 'frame' },
      { key: 'SECTION', label: '分区', keycap: 'Shift+S', glyph: 'layout-grid' },
    ],
  },
  {
    key: 'RECTANGLE',
    label: '矩形',
    keycap: 'R',
    glyph: 'square',
    flyout: [
      { key: 'RECTANGLE', label: '矩形', keycap: 'R', glyph: 'square' },
      { key: 'LINE', label: '直线', keycap: 'L', glyph: 'minus' },
      { key: 'ELLIPSE', label: '椭圆', keycap: 'O', glyph: 'circle' },
      { key: 'POLYGON', label: '多边形', keycap: '', glyph: 'triangle' },
      { key: 'STAR', label: '星形', keycap: '', glyph: 'star' },
    ],
  },
  { key: 'PEN', label: '钢笔', keycap: 'P', glyph: 'pen-tool' },
  { key: 'TEXT', label: '文字', keycap: 'T', glyph: 'type' },
  { key: 'HAND', label: '抓手', keycap: 'H', glyph: 'hand' },
  { key: 'COMMENT', label: '评论', keycap: 'C', glyph: 'message-circle' },
  { key: 'insert-icon', label: '插入图标', keycap: '', glyph: 'smile-plus', action: true },
];

/* --------------------------------------------------------------- helpers */

const clampValue = (value, min, max) => {
  let next = value;
  if (typeof min === 'number') next = Math.max(min, next);
  if (typeof max === 'number') next = Math.min(max, next);
  return next;
};

const numberText = value => (Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '');

const toggleInSet = (set, id) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export function hexToColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255, a: 1 };
}

export function colorToHex(color) {
  if (!color) return 'ffffff';
  const channel = value => Math.round(Math.max(0, Math.min(1, value ?? 0)) * 255).toString(16).padStart(2, '0');
  return `${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** The glyph a layer row and the object header show for a node, as OpenPencil maps it. */
export function layerGlyph(node) {
  if (node.type === 'FRAME') {
    if (node.icon) return 'smile';
    if (node.layoutMode === 'VERTICAL') return 'rows-2';
    if (node.layoutMode === 'HORIZONTAL') return 'columns-2';
    if (node.layoutMode === 'GRID') return 'layout-grid';
    return 'frame';
  }
  if (node.isMask) return 'squares-intersect';
  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE' || node.type === 'FRAME') {
    if ((node.fills || []).some(fill => fill.type === 'IMAGE')) return 'image';
  }
  const glyphs = {
    TEXT: 'type',
    RECTANGLE: 'square',
    ELLIPSE: 'circle',
    GROUP: 'group',
    SECTION: 'layout-grid',
    VECTOR: 'pen-tool',
    LINE: 'minus',
    POLYGON: 'triangle',
    STAR: 'star',
    COMPONENT: 'diamond',
    COMPONENT_SET: 'component',
    INSTANCE: 'diamond',
    CANVAS: 'layers',
    SLICE: 'scan',
  };
  return glyphs[node.type] || 'square';
}

/** Every panel section is a title row, optional actions, then its rows. */
const section = (title, actions, children) =>
  h('section', { class: 'dp-section' }, [
    h('div', { class: 'dp-section-head' }, [
      h('h4', title),
      actions?.length ? h('div', { class: 'dp-section-actions' }, actions) : null,
    ]),
    ...children.filter(Boolean),
  ]);

const iconButton = (glyph, label, onClick, { active = false, disabled = false } = {}) =>
  h('button', {
    type: 'button',
    class: ['dp-icon-button', active ? 'is-active' : ''],
    title: label,
    'aria-label': label,
    'aria-pressed': active ? 'true' : undefined,
    disabled,
    onClick,
  }, [icon(glyph)]);

/* --------------------------------------------------------------------- UI */

export function createDesignUI(ctx) {
  const { editor, model, changed } = ctx;

  const apply = (id, patch) => {
    editor.updateNodeWithUndo(id, patch);
    editor.runLayoutForNode?.(id);
    editor.requestRender?.();
    changed();
  };

  const selectedNode = () => editor.getNode([...editor.state.selectedIds][0]);

  /* ------------------------------------------------------------- fields */

  const numberField = ({ node, key, leading, glyph, suffix, min, max, label }) => {
    const raw = node[key];
    return h('div', { class: 'dp-field' }, [
      leading ? h('span', { class: 'dp-field-leading' }, leading) : null,
      glyph ? h('span', { class: 'dp-field-leading' }, [icon(glyph)]) : null,
      h('input', {
        class: 'dp-field-input',
        type: 'number',
        inputmode: 'decimal',
        value: numberText(raw),
        min,
        max,
        'aria-label': label || key,
        onChange: event => {
          const typed = Number(event.target.value);
          if (!Number.isFinite(typed)) {
            event.target.value = numberText(raw);
            return;
          }
          const next = Math.round(clampValue(typed, min, max) * 100) / 100;
          if (next !== raw) apply(node.id, { [key]: next });
        },
        onKeydown: event => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.currentTarget.value = numberText(raw);
            event.currentTarget.blur();
          }
        },
      }),
      suffix ? h('span', { class: 'dp-field-suffix' }, suffix) : null,
    ]);
  };

  /** A field plus a dropdown menu, matching OpenPencil's select fields. */
  const selectField = ({ menuKey, value, options, label, width, onChange }) => {
    const open = model.menu === menuKey;
    const current = options.find(option => option.value === value);
    return h('div', { class: 'dp-menu-host', style: width ? { width } : null }, [
      h('button', {
        type: 'button',
        class: 'dp-select',
        'aria-haspopup': 'menu',
        'aria-expanded': String(open),
        'aria-label': label,
        onClick: () => {
          model.menu = open ? '' : menuKey;
          ctx.refresh();
        },
      }, [
        h('span', current ? current.label : value || label),
        icon('chevron-down'),
      ]),
      open
        ? h('div', { class: 'dp-menu', role: 'menu', style: { top: '28px', left: '0' } }, options.map(option =>
          h('button', {
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': String(option.value === value),
            'data-active': option.value === value ? 'true' : undefined,
            onClick: () => {
              model.menu = '';
              onChange(option.value);
            },
          }, [
            icon('check', { style: { opacity: option.value === value ? 1 : 0 } }),
            option.label,
          ]),
        ))
        : null,
    ]);
  };

  const labelled = (label, control) => h('div', null, [h('span', { class: 'dp-label' }, label), control]);

  const row = (children, columns = 2) =>
    h('div', { class: 'dp-row' }, [h('div', { class: `dp-fields dp-fields-${columns}` }, children)]);

  const checkbox = (label, checked, onChange) =>
    h('label', { class: 'dp-check' }, [
      h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }),
      h('span', label),
    ]);

  /* -------------------------------------------------------------- header */

  const inspectorHeader = node => h('div', { class: 'dp-header' }, [
    h('span', { class: 'dp-header-icon' }, [icon(layerGlyph(node))]),
    h('span', { class: 'dp-header-title', title: node.name }, node.name),
    h('div', { class: 'dp-header-actions' }, [
      iconButton('x', '关闭属性面板', () => {
        editor.clearSelection();
        ctx.refresh();
      }),
    ]),
  ]);

  /* ------------------------------------------------------------ sections */

  const FRAME_PRESETS = [
    { label: '自定义', width: null, height: null },
    { label: '桌面 1440 × 1024', width: 1440, height: 1024 },
    { label: '笔记本 1280 × 800', width: 1280, height: 800 },
    { label: '平板 834 × 1194', width: 834, height: 1194 },
    { label: '手机 393 × 852', width: 393, height: 852 },
    { label: '幻灯片 1920 × 1080', width: 1920, height: 1080 },
  ];

  const frameSection = node => {
    if (node.type !== 'FRAME') return null;
    const current = FRAME_PRESETS.find(item => item.width === Math.round(node.width) && item.height === Math.round(node.height));
    return section('画板', [], [
      selectField({
        menuKey: 'frame-preset',
        value: current?.label || '自定义',
        options: FRAME_PRESETS.map(item => ({ value: item.label, label: item.label })),
        label: '画板尺寸预设',
        onChange: label => {
          const preset = FRAME_PRESETS.find(item => item.label === label);
          if (!preset?.width) return;
          apply(node.id, { width: preset.width, height: preset.height });
        },
      }),
    ]);
  };

  const positionSection = node => {
    const parent = node.parentId ? editor.getNode(node.parentId) : null;
    const container = parent && parent.type !== 'CANVAS' && parent.type !== 'FRAME'
      ? parent
      : parent && parent.type === 'FRAME' ? parent : null;
    const align = (axis, place) => {
      if (!container) {
        ctx.notice?.('顶层画板没有可对齐的容器');
        return;
      }
      const span = axis === 'horizontal' ? container.width - node.width : container.height - node.height;
      if (!(span > 0)) return;
      const offset = place === 'min' ? 0 : place === 'center' ? span / 2 : span;
      const origin = axis === 'horizontal' ? container.x || 0 : container.y || 0;
      apply(node.id, axis === 'horizontal'
        ? { x: Math.round(origin + offset) }
        : { y: Math.round(origin + offset) });
    };
    return section('位置', [], [
      h('div', { class: 'dp-icon-row', role: 'toolbar', 'aria-label': '对齐' }, [
        h('div', null, [
          iconButton('align-start-vertical', '左对齐', () => align('horizontal', 'min')),
          iconButton('align-center-vertical', '水平居中', () => align('horizontal', 'center')),
          iconButton('align-end-vertical', '右对齐', () => align('horizontal', 'max')),
        ]),
        h('div', null, [
          iconButton('align-start-horizontal', '顶部对齐', () => align('vertical', 'min')),
          iconButton('align-center-horizontal', '垂直居中', () => align('vertical', 'center')),
          iconButton('align-end-horizontal', '底部对齐', () => align('vertical', 'max')),
        ]),
      ]),
      row([
        numberField({ node, key: 'x', leading: 'X', label: 'X 坐标' }),
        numberField({ node, key: 'y', leading: 'Y', label: 'Y 坐标' }),
      ]),
      h('div', { class: 'dp-row', style: { marginTop: '6px' } }, [
        h('div', { class: 'dp-fields dp-fields-2' }, [
          numberField({ node, key: 'rotation', glyph: 'rotate-cw', suffix: '°', min: -360, max: 360, label: '旋转' }),
          h('div', { class: 'dp-inline-actions' }, [
            iconButton('flip-horizontal-2', '水平翻转（暂未接入）', () => {}, { disabled: true }),
            iconButton('flip-vertical-2', '垂直翻转（暂未接入）', () => {}, { disabled: true }),
            iconButton('rotate-cw-square', '旋转 90°', () => apply(node.id, { rotation: Math.round(((node.rotation || 0) + 90) % 360) })),
          ]),
        ]),
      ]),
    ]);
  };

  const layoutSection = node => {
    const mode = node.layoutMode || 'NONE';
    const on = mode !== 'NONE';
    const flex = mode === 'VERTICAL' || mode === 'HORIZONTAL';
    const flows = [
      { value: 'NONE', label: '自由布局', glyph: 'move' },
      { value: 'VERTICAL', label: '纵向', glyph: 'rows-2' },
      { value: 'HORIZONTAL', label: '横向', glyph: 'columns-2' },
      { value: 'GRID', label: '网格', glyph: 'layout-grid' },
    ];
    const sizingOptions = [
      { value: 'FIXED', label: '固定' },
      { value: 'HUG', label: '适应内容' },
      { value: 'FILL', label: '填充容器' },
    ];
    const widthAxis = flex && mode === 'HORIZONTAL' ? 'primaryAxisSizing' : 'counterAxisSizing';
    const heightAxis = flex && mode === 'HORIZONTAL' ? 'counterAxisSizing' : 'primaryAxisSizing';
    const ratioLocked = Boolean(node.targetAspectRatio);
    const anchorIndex = (primary, counter) => {
      const rows = { MIN: 0, CENTER: 1, MAX: 2, SPACE_BETWEEN: 1 };
      const cols = { MIN: 0, CENTER: 1, MAX: 2 };
      return (rows[counter] ?? 1) * 3 + (cols[primary] ?? 1);
    };

    /** A width or height field whose trailing chevron picks Fixed / Hug / Fill. */
    const sizeField = (leading, label, dimension, axis) => {
      const menuKey = `${dimension}-sizing`;
      const open = model.menu === menuKey;
      return h('div', { class: 'dp-menu-host' }, [
        h('div', { class: 'dp-field' }, [
          h('span', { class: 'dp-field-leading' }, leading),
          h('input', {
            class: 'dp-field-input',
            type: 'number',
            value: numberText(node[dimension]),
            'aria-label': label,
            onChange: event => {
              const typed = Number(event.target.value);
              if (Number.isFinite(typed) && typed >= 0) apply(node.id, { [dimension]: Math.round(typed) });
            },
          }),
          on
            ? h('button', {
              type: 'button',
              class: 'dp-field-menu',
              title: `${label}模式`,
              'aria-label': `${label}模式`,
              'aria-haspopup': 'menu',
              'aria-expanded': String(open),
              onClick: () => { model.menu = open ? '' : menuKey; ctx.refresh(); },
            }, [icon('chevron-down')])
            : null,
        ]),
        open
          ? h('div', { class: 'dp-menu', role: 'menu', style: { top: '28px', right: '0', left: 'auto' } }, sizingOptions.map(option =>
            h('button', {
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': String(node[axis] === option.value),
              'data-active': node[axis] === option.value ? 'true' : undefined,
              onClick: () => { model.menu = ''; apply(node.id, { [axis]: option.value }); },
            }, [option.label]),
          ))
          : null,
      ]);
    };

    return section(on ? '自动布局' : '布局', [
      iconButton('layout-panel-top', on ? '移除自动布局' : '添加自动布局', () => {
        apply(node.id, { layoutMode: on ? 'NONE' : 'VERTICAL' });
      }, { active: on }),
    ], [
      labelled('流', h('div', { class: 'dp-row' }, [
        h('div', { class: 'dp-segment', role: 'group', 'aria-label': '流' }, flows.map(flow =>
          h('button', {
            type: 'button',
            title: flow.label,
            'aria-label': flow.label,
            'aria-pressed': String(flow.value === mode),
            onClick: () => apply(node.id, { layoutMode: flow.value }),
          }, [icon(flow.glyph)]),
        )),
        flex
          ? iconButton('wrap-text', '换行', () => apply(node.id, { layoutWrap: node.layoutWrap === 'WRAP' ? 'NO_WRAP' : 'WRAP' }), { active: node.layoutWrap === 'WRAP' })
          : null,
      ])),
      h('span', { class: 'dp-caption' }, '尺寸'),
      h('div', { class: 'dp-row' }, [
        h('div', { class: 'dp-fields dp-fields-1' }, [
          sizeField('W', '宽', 'width', widthAxis),
          sizeField('H', '高', 'height', heightAxis),
        ]),
        h('div', { class: 'dp-rail' }, [
          iconButton('square-dashed', ratioLocked ? '解锁宽高比' : '锁定宽高比', () => apply(node.id, {
            targetAspectRatio: ratioLocked ? null : { x: node.width, y: node.height },
          }), { active: ratioLocked }),
        ]),
      ]),
      flex
        ? labelled('方向', selectField({
          menuKey: 'layout-direction',
          value: node.layoutDirection || 'AUTO',
          options: [
            { value: 'AUTO', label: '自动' },
            { value: 'LTR', label: '从左到右' },
            { value: 'RTL', label: '从右到左' },
          ],
          label: '方向',
          onChange: value => apply(node.id, { layoutDirection: value }),
        }))
        : null,
      on
        ? h('div', { class: 'dp-row', style: { marginTop: '6px', alignItems: 'flex-start' } }, [
          h('div', { class: 'dp-fields dp-fields-2' }, [
            h('div', { class: 'dp-anchor', role: 'group', 'aria-label': '对齐方式' }, Array.from({ length: 9 }, (_, index) =>
              h('button', {
                type: 'button',
                'aria-label': `对齐位置 ${index + 1}`,
                'aria-pressed': String(anchorIndex(node.primaryAxisAlign, node.counterAxisAlign) === index),
                onClick: () => {
                  const primary = ['MIN', 'CENTER', 'MAX'][index % 3];
                  const counter = ['MIN', 'CENTER', 'MAX'][Math.floor(index / 3)];
                  apply(node.id, { primaryAxisAlign: primary, counterAxisAlign: counter });
                },
              }),
            )),
            numberField({ node, key: 'itemSpacing', glyph: 'move-horizontal', min: 0, label: '间距' }),
          ]),
        ])
        : null,
      on
        ? h('div', { class: 'dp-row', style: { marginTop: '6px' } }, [
          h('div', { class: 'dp-fields dp-fields-2' }, [
            numberField({ node, key: 'paddingLeft', glyph: 'move-horizontal', min: 0, label: '水平内边距' }),
            numberField({ node, key: 'paddingTop', glyph: 'move-vertical', min: 0, label: '垂直内边距' }),
          ]),
          h('div', { class: 'dp-inline-actions' }, [
            iconButton('scan', '独立内边距（暂未接入）', () => {}, { disabled: true }),
          ]),
        ])
        : null,
      h('div', { style: { marginTop: '8px' } }, [
        checkbox('裁剪内容', node.clipsContent, value => apply(node.id, { clipsContent: value })),
      ]),
    ]);
  };

  const appearanceSection = node => {
    // `BLEND_MODES` is a registry keyed by mode, not a list.
    const modes = Array.isArray(BLEND_MODES) ? BLEND_MODES : Object.keys(BLEND_MODES || {});
    const blendOptions = (modes.length ? modes : Object.keys(BLEND_LABELS)).map(mode => ({
      value: mode,
      label: BLEND_LABELS[mode] || mode,
    }));
    return section('外观', [
      iconButton(node.visible ? 'eye' : 'eye-off', node.visible ? '隐藏' : '显示', () => apply(node.id, { visible: !node.visible }), { active: !node.visible }),
    ], [
      h('div', { class: 'dp-fields', style: { gridTemplateColumns: 'minmax(0,7fr) minmax(0,5fr)' } }, [
        labelled('混合模式', selectField({
          menuKey: 'blend-mode',
          value: node.blendMode || 'PASS_THROUGH',
          options: blendOptions,
          label: '混合模式',
          onChange: value => apply(node.id, { blendMode: value }),
        })),
        labelled('不透明度', h('div', { class: 'dp-field' }, [
          h('span', { class: 'dp-field-leading' }, [icon('blend')]),
          h('input', {
            class: 'dp-field-input',
            type: 'number',
            min: 0,
            max: 100,
            value: numberText(Math.round((node.opacity ?? 1) * 100)),
            'aria-label': '不透明度',
            onChange: event => {
              const typed = Number(event.target.value);
              if (Number.isFinite(typed)) apply(node.id, { opacity: clampValue(typed, 0, 100) / 100 });
            },
          }),
          h('span', { class: 'dp-field-suffix' }, '%'),
        ])),
      ]),
      h('div', { class: 'dp-row', style: { marginTop: '6px' } }, [
        h('div', { class: 'dp-fields dp-fields-2' }, [
          labelled('圆角', numberField({ node, key: 'cornerRadius', glyph: 'square-round-corner', min: 0, label: '圆角' })),
          labelled('圆角平滑', numberField({ node, key: 'cornerSmoothing', glyph: 'circle-dashed', suffix: '%', min: 0, max: 100, label: '圆角平滑' })),
        ]),
        h('div', { class: 'dp-rail' }, [
          iconButton('square-round-corner', '独立圆角', () => apply(node.id, { independentCorners: !node.independentCorners }), { active: Boolean(node.independentCorners) }),
        ]),
      ]),
    ]);
  };

  const solidFill = color => ({ type: 'SOLID', color, opacity: 1, visible: true });

  const paintRow = (node, paint, index, kind) => {
    const key = kind === 'fill' ? 'fills' : 'strokes';
    const list = node[key] || [];
    const update = patch => apply(node.id, { [key]: list.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) });
    const remove = () => apply(node.id, { [key]: list.filter((_, itemIndex) => itemIndex !== index) });
    const hex = colorToHex(paint.color);
    return h('div', { class: 'dp-swatch-row' }, [
      h('label', { class: 'dp-swatch', title: '颜色' }, [
        h('i', { style: { background: `#${hex}` } }),
        h('input', {
          type: 'color',
          value: `#${hex}`,
          'aria-label': '颜色',
          style: { position: 'absolute', inset: '0', width: '100%', height: '100%', padding: '0', border: '0', opacity: '0', cursor: 'pointer' },
          onInput: event => {
            const parsed = hexToColor(event.target.value);
            if (parsed) update({ color: parsed });
            const swatch = event.target.previousElementSibling;
            if (swatch) swatch.style.background = event.target.value;
          },
        }),
      ]),
      h('span', { class: 'dp-swatch-value' }, `#${hex.toUpperCase()}`),
      h('div', { class: 'dp-field', style: { width: '62px', flex: 'none' } }, [
        h('input', {
          class: 'dp-field-input',
          type: 'number',
          min: 0,
          max: 100,
          value: numberText(Math.round((paint.opacity ?? 1) * 100)),
          'aria-label': '不透明度',
          onChange: event => {
            const typed = Number(event.target.value);
            if (Number.isFinite(typed)) update({ opacity: clampValue(typed, 0, 100) / 100 });
          },
        }),
        h('span', { class: 'dp-field-suffix' }, '%'),
      ]),
      iconButton(paint.visible === false ? 'eye-off' : 'eye', paint.visible === false ? '显示' : '隐藏', () => update({ visible: paint.visible === false }), { active: paint.visible === false }),
      iconButton('minus', kind === 'fill' ? '移除填充' : '移除描边', remove),
    ]);
  };

  const fillSection = node => section('填充', [
    iconButton('plus', '添加填充', () => apply(node.id, { fills: [...(node.fills || []), solidFill({ r: 0.6, g: 0.6, b: 0.6, a: 1 })] })),
  ], (node.fills || []).map((paint, index) => paintRow(node, paint, index, 'fill')));

  const strokeSection = node => {
    const strokes = node.strokes || [];
    return section('描边', [
      iconButton('plus', '添加描边', () => apply(node.id, {
        strokes: [...strokes, { ...solidFill({ r: 0, g: 0, b: 0, a: 1 }), weight: 1, align: 'INSIDE' }],
      })),
    ], [
      ...strokes.map((paint, index) => paintRow(node, paint, index, 'stroke')),
      strokes.length
        ? h('div', { class: 'dp-row', style: { marginTop: '6px' } }, [
          selectField({
            menuKey: 'stroke-align',
            value: strokes[0].align || 'INSIDE',
            options: [
              { value: 'INSIDE', label: '内部' },
              { value: 'CENTER', label: '居中' },
              { value: 'OUTSIDE', label: '外部' },
            ],
            label: '描边位置',
            width: '88px',
            onChange: value => apply(node.id, { strokes: strokes.map(stroke => ({ ...stroke, align: value })) }),
          }),
          h('div', { class: 'dp-field', style: { flex: '1' } }, [
            h('span', { class: 'dp-field-leading' }, 'W'),
            h('input', {
              class: 'dp-field-input',
              type: 'number',
              min: 0,
              value: numberText(strokes[0].weight ?? 1),
              'aria-label': '描边粗细',
              onChange: event => {
                const typed = Number(event.target.value);
                if (Number.isFinite(typed)) apply(node.id, { strokes: strokes.map(stroke => ({ ...stroke, weight: Math.max(0, typed) })) });
              },
            }),
          ]),
        ])
        : null,
    ]);
  };

  const effectsSection = node => {
    const effects = node.effects || [];
    return section('效果', [
      iconButton('plus', '添加效果', () => apply(node.id, {
        effects: [...effects, { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0 }],
      })),
    ], effects.map((effect, index) => {
      const update = patch => apply(node.id, {
        effects: effects.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
      });
      return h('div', { class: 'dp-swatch-row' }, [
        selectField({
          menuKey: `effect-type-${index}`,
          value: effect.type,
          options: Object.entries(EFFECT_LABELS).map(([value, label]) => ({ value, label })),
          label: '效果类型',
          onChange: value => update({ type: value }),
        }),
        iconButton(effect.visible === false ? 'eye-off' : 'eye', effect.visible === false ? '显示' : '隐藏', () => update({ visible: effect.visible === false }), { active: effect.visible === false }),
        iconButton('minus', '移除效果', () => apply(node.id, { effects: effects.filter((_, itemIndex) => itemIndex !== index) })),
      ]);
    }));
  };

  const layoutGridSection = node => {
    const guides = node.layoutGrids || [];
    return section('布局参考线', [
      iconButton('plus', '添加布局参考线', () => apply(node.id, {
        layoutGrids: [...guides, { visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 }, pattern: 'GRID', alignment: 'STRETCH', count: 5, gutter: 20, offset: 0, sectionSize: 10 }],
      })),
    ], guides.map((guide, index) => h('div', { class: 'dp-swatch-row' }, [
      selectField({
        menuKey: `grid-pattern-${index}`,
        value: guide.pattern || 'GRID',
        options: [
          { value: 'GRID', label: '网格' },
          { value: 'COLUMNS', label: '列' },
          { value: 'ROWS', label: '行' },
        ],
        label: '参考线样式',
        onChange: value => apply(node.id, {
          layoutGrids: guides.map((item, itemIndex) => (itemIndex === index ? { ...item, pattern: value } : item)),
        }),
      }),
      iconButton(guide.visible === false ? 'eye-off' : 'eye', guide.visible === false ? '显示' : '隐藏', () => apply(node.id, {
        layoutGrids: guides.map((item, itemIndex) => (itemIndex === index ? { ...item, visible: item.visible === false } : item)),
      }), { active: guide.visible === false }),
      iconButton('minus', '移除布局参考线', () => apply(node.id, {
        layoutGrids: guides.filter((_, itemIndex) => itemIndex !== index),
      })),
    ])));
  };

  const exportSection = () => section('导出', [
    iconButton('plus', '添加导出设置', () => ctx.notice?.('导出设置已记录；导出管线尚未接入')),
  ], []);

  /* ---------------------------------------------------------- inspector */

  const inspector = () => {
    const node = selectedNode();
    if (!node) {
      return h('div', { class: 'dp-inspector-scroll' }, [
        h('p', { class: 'dp-empty', style: { padding: '12px' } }, '选中画板或对象以查看属性'),
      ]);
    }
    const lays = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP'].includes(node.type);
    return h('div', { class: 'dp-inspector-scroll' }, [
      inspectorHeader(node),
      frameSection(node),
      positionSection(node),
      lays ? layoutSection(node) : null,
      appearanceSection(node),
      fillSection(node),
      strokeSection(node),
      effectsSection(node),
      ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(node.type) ? layoutGridSection(node) : null,
      exportSection(),
    ]);
  };

  /* -------------------------------------------------------------- pages */

  const pageRow = page => {
    const active = page.id === editor.state.currentPageId;
    if (model.renamingPage === page.id) {
      return h('div', { class: 'dp-page-row is-active' }, [
        icon('file'),
        h('input', {
          class: 'dp-page-input',
          value: page.name,
          onVnodeMounted: vnode => { vnode.el.focus(); vnode.el.select(); },
          onBlur: event => {
            const name = event.target.value.trim();
            model.renamingPage = '';
            if (name && name !== page.name) apply(page.id, { name });
            else ctx.refresh();
          },
          onKeydown: event => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') { model.renamingPage = ''; ctx.refresh(); }
          },
        }),
      ]);
    }
    return h('button', {
      type: 'button',
      class: ['dp-page-row', active ? 'is-active' : ''],
      'aria-current': active ? 'page' : undefined,
      onClick: async () => {
        await editor.switchPage(page.id);
        ctx.refresh();
      },
      onDblclick: () => { model.renamingPage = page.id; ctx.refresh(); },
    }, [icon('file'), h('span', page.name)]);
  };

  const layerRow = (node, depth) => {
    const children = editor.getChildren(node.id);
    const expanded = model.expanded.has(node.id);
    const selected = editor.state.selectedIds.has(node.id);
    const rows = [h('div', {
      class: [
        'dp-layer-row',
        selected ? 'is-selected' : '',
        node.visible === false ? 'is-hidden' : '',
        ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(node.type) ? 'is-component' : '',
      ],
      style: { paddingInlineStart: `${depth * 16}px` },
      onClick: () => { editor.select([node.id]); ctx.refresh(); },
      onDblclick: () => ctx.beginRename?.(node),
    }, [
      h('span', {
        class: ['dp-layer-disclosure', children.length ? '' : 'is-empty'],
        'data-expanded': String(expanded),
        onClick: event => {
          event.stopPropagation();
          if (!children.length) return;
          model.expanded = toggleInSet(model.expanded, node.id);
          ctx.refresh();
        },
      }, [children.length ? icon('chevron-right') : null]),
      icon(layerGlyph(node), { class: 'dp-layer-icon' }),
      h('span', { title: node.name }, node.name),
      h('span', { class: ['dp-layer-actions', node.locked || node.visible === false ? 'is-visible' : ''] }, [
        h('button', {
          type: 'button',
          class: ['dp-layer-action', node.locked ? 'is-off' : ''],
          title: node.locked ? '解锁' : '锁定',
          'aria-label': node.locked ? '解锁' : '锁定',
          onClick: event => { event.stopPropagation(); apply(node.id, { locked: !node.locked }); },
        }, [icon(node.locked ? 'lock' : 'lock-open')]),
        h('button', {
          type: 'button',
          class: ['dp-layer-action', node.visible === false ? 'is-off' : ''],
          title: node.visible === false ? '显示' : '隐藏',
          'aria-label': node.visible === false ? '显示' : '隐藏',
          onClick: event => { event.stopPropagation(); apply(node.id, { visible: node.visible === false }); },
        }, [icon(node.visible === false ? 'eye-off' : 'eye')]),
      ]),
    ])];
    if (expanded) for (const child of children) rows.push(layerRow(child, depth + 1));
    return rows;
  };

  const pages = () => h('aside', {
    class: 'mova-design-pages',
    hidden: !model.pagesOpen,
    'aria-label': '页面与图层',
  }, [
    h('div', { class: 'dp-pages-block' }, [
      h('div', { class: 'dp-block-head' }, [
        h('strong', '页面'),
        h('button', {
          type: 'button',
          class: 'dp-block-add',
          title: '添加页面',
          'aria-label': '添加页面',
          onClick: () => { editor.addPage(); changed(); },
        }, [icon('plus')]),
      ]),
      h('div', { class: 'dp-pages-viewport' }, editor.getPages().map(pageRow)),
    ]),
    h('div', { class: 'dp-pages-block is-layers' }, [
      h('div', { class: 'dp-block-head' }, [h('strong', '图层')]),
      h('div', { class: 'dp-layer-viewport' },
        editor.getChildren(editor.state.currentPageId).flatMap(node => layerRow(node, 0))),
    ]),
  ]);

  /* ------------------------------------------------------------ toolbar */

  const toolbar = () => {
    const active = editor.state.activeTool;
    return h('div', { class: 'mova-design-tools', role: 'toolbar', 'aria-label': '画布工具' }, TOOL_GROUPS.map(group => {
      if (group.action) {
        return h('div', { class: 'dt-item' }, [
          h('button', {
            type: 'button',
            class: 'dt-tool',
            title: group.label,
            'aria-label': group.label,
            onClick: () => ctx.insertIcon?.(),
          }, [icon(group.glyph)]),
        ]);
      }
      const flyoutOpen = model.flyout === group.key;
      const chosen = (model.flyoutChoice || {})[group.key] || group.key;
      const selected = group.flyout?.find(item => item.key === chosen) || group;
      return h('div', { class: 'dt-item' }, [
        h('button', {
          type: 'button',
          class: 'dt-tool',
          title: `${group.label}${group.keycap ? ` ${group.keycap}` : ''}`,
          'aria-label': group.label,
          'aria-pressed': String(group.flyout ? group.flyout.some(item => item.key === active) : active === group.key),
          onClick: () => {
            editor.setTool(selected.key);
            ctx.refresh();
          },
        }, [icon(selected.glyph)]),
        group.flyout
          ? h('button', {
            type: 'button',
            class: 'dt-flyout-trigger',
            title: `${group.label}选项`,
            'aria-label': `${group.label}选项`,
            'aria-haspopup': 'menu',
            'aria-expanded': String(flyoutOpen),
            onClick: () => { model.flyout = flyoutOpen ? '' : group.key; ctx.refresh(); },
          }, [icon('chevron-down')])
          : null,
        flyoutOpen
          ? h('div', { class: 'dt-menu', role: 'menu' }, group.flyout.map(item =>
            h('button', {
              type: 'button',
              role: 'menuitemradio',
              class: 'dt-menu-item',
              'data-active': String(item.key === chosen),
              'aria-checked': String(item.key === chosen),
              onClick: () => {
                model.flyoutChoice = { ...(model.flyoutChoice || {}), [group.key]: item.key };
                model.flyout = '';
                editor.setTool(item.key);
                ctx.refresh();
              },
            }, [
              icon('check', { class: 'dt-menu-check' }),
              icon(item.glyph, { class: 'dt-menu-icon' }),
              h('span', { class: 'dt-menu-label' }, item.label),
              item.keycap ? h('span', { class: 'dt-menu-key' }, item.keycap) : null,
            ]),
          ))
          : null,
      ]);
    }));
  };

  /* ---------------------------------------------------------- canvas dots */

  /**
   * The infinite canvas' dot matrix. It is a CSS layer under the canvas so the dots stay
   * crisp and follow the viewport's zoom and pan instead of the document's content.
   */
  const canvasDots = () => {
    const zoom = editor.state.zoom || 1;
    const panX = editor.state.panX || 0;
    const panY = editor.state.panY || 0;
    let step = 16 * zoom;
    while (step < 8) step *= 2;
    while (step > 40) step /= 2;
    return h('div', {
      class: 'dp-canvas-dots',
      'aria-hidden': 'true',
      style: {
        backgroundImage: 'radial-gradient(circle, #3f3f3f 1px, transparent 1.15px)',
        backgroundSize: `${step}px ${step}px`,
        backgroundPosition: `${panX}px ${panY}px`,
      },
    });
  };

  /* --------------------------------------------------------------- head */

  const head = () => h('header', { class: 'mova-design-head browser-toolbar' }, [
    h('div', { class: 'browser-nav-group' }, [
      h('button', {
        type: 'button',
        class: 'browser-icon-button',
        title: '撤销',
        'aria-label': '撤销',
        onClick: () => { editor.undoAction(); ctx.refresh(); },
      }, [arrow('back')]),
      h('button', {
        type: 'button',
        class: 'browser-icon-button',
        title: '重做',
        'aria-label': '重做',
        onClick: () => { editor.redoAction(); ctx.refresh(); },
      }, [arrow('forward')]),
      h('button', {
        type: 'button',
        class: 'browser-icon-button',
        title: '页面与图层',
        'aria-label': '页面与图层',
        'aria-pressed': String(model.pagesOpen),
        onClick: () => { model.pagesOpen = !model.pagesOpen; ctx.refresh(); },
      }, [pagesGlyph()]),
      // Pick a layer and it lands in the chat composer as a quote, so the user can ask about what
      // they are looking at. It belongs with the other view actions in the left pill, and uses the
      // same glyph as the browser toolbar's picker.
      h('button', {
        type: 'button',
        class: 'browser-icon-button mova-design-pick',
        title: model.picking ? '取消选取图层' : '选取图层并引用到对话',
        'aria-label': model.picking ? '取消选取图层' : '选取图层并引用到对话',
        'aria-pressed': String(!!model.picking),
        onClick: () => ctx.pickElement?.(),
      }, [icon('cursor-click')]),
    ]),
    h('div', { class: 'browser-address' }, [
      h('span', { class: 'mova-design-address-title' }, '设计画板'),
    ]),
    // Play keeps its own round button: it is a mode switch for the canvas, not part of the address.
    h('button', {
      type: 'button',
      class: 'browser-icon-button mova-design-play',
      title: model.playing ? '暂停' : '播放',
      'aria-label': model.playing ? '暂停' : '播放',
      'aria-pressed': String(model.playing),
      onClick: () => {
        if (model.playing) editor.stopPlay();
        else editor.startPlay();
        model.playing = !model.playing;
        ctx.refresh();
      },
    }, [icon(model.playing ? 'pause' : 'play')]),
  ]);

  return { head, pages, inspector, toolbar, canvasDots };
}
