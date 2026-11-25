'use strict';
// UIA 树 -> 紧凑文本。纯函数，不碰 Electron/worker，方便单测。
// 规则照 Mova桌面操作开发方案.md §5.2：
// 1) 只留可交互角色、有文本的静态元素、有名字的容器；
// 2) 无名容器折叠成一行或直接丢掉；
// 3) 连续同名同角色的项合并成一行（×N）；
// 4) Grid/Table 只给摘要，默认不展开单元格；
// 5) 每行 [ref] Role "Name" + value= + state= +（可选）@rect；
// 6) 密码框永远 value=<secret>；
// 7) 预算 maxChars（默认 6000）超出时按“交互优先 -> 视口内优先 -> 层级浅优先”截断。

const { buildTree, rectIsEmpty, rectOf } = require('./tree.cjs');

const DEFAULT_MAX_CHARS = 6000;
const MAX_NAME = 60;
const MAX_VALUE = 40;

// 可交互角色：必须出现（text/document 不算“交互”，见 CONTENT_ROLES，避免挤掉按钮的预算优先级）
const INTERACTIVE_ROLES = new Set([
  'button', 'splitbutton', 'edit', 'combobox', 'checkbox', 'radiobutton',
  'tabitem', 'tab', 'listitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'treeitem', 'dataitem', 'slider', 'spinner', 'hyperlink', 'check',
]);
// 有内容但不可交互：只保留“有名字/有值”的
const CONTENT_ROLES = new Set(['text', 'document', 'edit', 'image', 'statusbar']);
// 有名字才输出的容器
const CONTAINER_ROLES = new Set([
  'window', 'pane', 'group', 'dialog', 'toolbar', 'menu', 'menubar', 'tab', 'tablist',
  'list', 'tree', 'table', 'grid', 'datagrid', 'custom', 'appbar', 'titlebar', 'document',
]);
// 表格类：只给摘要
const TABLE_ROLES = new Set(['table', 'grid', 'datagrid']);
// 连续项合并的角色
const MERGE_ROLES = new Set(['dataitem', 'listitem', 'treeitem', 'menuitem', 'tabitem', 'radiobutton', 'checkbox']);
// 完全不输出的噪声音角色
const NOISE_ROLES = new Set(['scrollbar', 'separator', 'titlebar', 'thumb', 'progressbar', 'caret']);
// 表格超过这个行数才折叠成摘要
const TABLE_COLLAPSE_ROWS = 12;

function clampText(value, max) {
  const raw = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, Math.max(0, max - 1))}…` : raw;
}

function roleLabel(role) {
  const raw = String(role || 'custom');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function stateFlags(states) {
  const flags = [];
  if (!states) return flags;
  if (states.password) flags.push('password');
  if (states.enabled === false) flags.push('disabled');
  if (states.offscreen === true) flags.push('offscreen');
  if (states.selected === true) flags.push('selected');
  if (states.expanded === true) flags.push('expanded');
  if (states.expanded === 'partial') flags.push('expanded=partial');
  if (states.expanded === false) flags.push('collapsed');
  if (states.toggled === true) flags.push('toggled');
  if (states.toggled === 'indeterminate') flags.push('toggled=mixed');
  if (states.focused === true) flags.push('focused');
  return flags;
}

function isInteractiveNode(node) {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  return node.patterns.some((p) => p === 'invoke' || p === 'selectionitem' || p === 'toggle' || p === 'expandcollapse');
}

function shouldRender(node) {
  if (!node) return false;
  if (NOISE_ROLES.has(node.role)) return false;
  if (node.role === 'window') return true;
  if (isInteractiveNode(node)) return true;
  if (CONTENT_ROLES.has(node.role) && (node.name || node.value)) return true;
  if (CONTAINER_ROLES.has(node.role) && node.name) return true;
  return false;
}

// 表格折叠成摘要（行数 + 是否 grid），名字已经在行首了就不再重复
function tableSummary(node, children) {
  if (!TABLE_ROLES.has(node.role)) return '';
  if (children.length < TABLE_COLLAPSE_ROWS) return '';
  const parts = [`rows=${children.length}`];
  if (node.patterns.includes('grid') || node.patterns.includes('griditem')) parts.push('grid');
  return parts.join(' ');
}

function lineFor(node, options) {
  const indent = '  '.repeat(Math.max(0, node.depth));
  const ref = node.ref ? `[${node.ref}] ` : '';
  const name = clampText(node.name, MAX_NAME);
  const quote = name ? ` "${name}"` : '';
  const flags = stateFlags(node.states);
  let line = `${indent}${ref}${roleLabel(node.role)}${quote}`;
  if (node.states && node.states.password) {
    line += ' value=<secret>';
  } else if (node.value !== null && node.value !== undefined && String(node.value) !== '') {
    line += ` value="${clampText(node.value, MAX_VALUE)}"`;
  }
  if (flags.length) line += ` ${flags.join(' ')}`;
  if (options.boxes && !rectIsEmpty(node.rect)) {
    line += ` @${node.rect.x},${node.rect.y} ${node.rect.w}x${node.rect.h}`;
  }
  return line;
}

function priorityOf(node) {
  let score = 0;
  if (isInteractiveNode(node)) score += 100;
  if (node.role === 'window') score += 80;
  if (node.role === 'dialog') score += 70;
  if (node.value !== null && node.value !== undefined && node.value !== '') score += 12;
  if (node.states && node.states.offscreen) score -= 40;
  if (node.name) score += 10;
  score -= node.depth * 2;
  return score;
}

function mergeRun(run) {
  // 连续同角色项的合并行： [w1.3–w1.9] Dataitem ×7 "1月"…"7月"
  const first = run[0];
  const last = run[run.length - 1];
  const indent = '  '.repeat(Math.max(0, first.depth));
  const sameName = run.every((node) => node.name === first.name);
  const refs = first.ref && last.ref && first.ref !== last.ref
    ? `[${first.ref}–${last.ref}] `
    : `[${first.ref}] `;
  let label = '';
  if (sameName) {
    const name = clampText(first.name, MAX_NAME);
    if (name) label = ` "${name}"`;
  } else {
    label = ` "${clampText(first.name, 20)}"…"${clampText(last.name, 20)}"`;
  }
  return `${indent}${refs}${roleLabel(first.role)} ×${run.length}${label}`;
}

function commonPrefix(values) {
  if (!values.length) return '';
  let prefix = values[0] || '';
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * @param {object[]} nodes worker tree 节点（也接受已 normalize 的节点）
 * @param {object} [options]
 * @param {number} [options.maxChars] 预算，默认 6000
 * @param {boolean} [options.boxes] 是否输出 @x,y wxh
 * @param {object} [options.window] 窗口记录（hwnd/title/exe/rect），用于首行
 * @param {boolean} [options.header] 是否输出首行，默认 true
 * @returns {{text:string, lines:string[], entries:object[], total:number, kept:number, chars:number, truncated:boolean}}
 */
function compact(nodes, options = {}) {
  const config = {
    maxChars: Number.isFinite(options.maxChars) ? Math.max(200, Math.round(options.maxChars)) : DEFAULT_MAX_CHARS,
    boxes: options.boxes === true,
    header: options.header !== false,
    window: options.window || null,
  };
  const tree = buildTree(nodes);
  const entries = [];
  const dropped = [];

  const pushEntry = (line, node, priority) => {
    entries.push({ line, node, priority, ref: node ? node.ref : '', role: node ? node.role : '' });
  };

  // depth 用“渲染层级”而不是原始 depth：被折叠的容器不占缩进，避免一行缩进十几格
  const walk = (node, depth) => {
    if (!node) return;
    const children = tree.childrenOf(node);
    node.depth = depth;
    const render = shouldRender(node);
    const summary = TABLE_ROLES.has(node.role) ? tableSummary(node, children) : '';
    const childDepth = depth + (render ? 1 : 0);

    if (render) {
      let line = lineFor(node, config);
      if (summary) line += `  ${summary}`;
      pushEntry(line, node, priorityOf(node));
    } else {
      dropped.push(node);
    }

    // 表格：给了摘要就不再展开单元格
    const expandChildren = !(summary && children.length > 0);
    if (!expandChildren) {
      for (const child of children) {
        child.depth = childDepth;
        dropped.push(child);
      }
      return;
    }

    // 连续项合并：先按角色分组连续 run
    let i = 0;
    while (i < children.length) {
      const child = children[i];
      if (MERGE_ROLES.has(child.role) && shouldRender(child)) {
        let j = i + 1;
        while (j < children.length && children[j].role === child.role && shouldRender(children[j])) j += 1;
        const run = children.slice(i, j);
        if (run.length >= 3) {
          for (const item of run) item.depth = childDepth;
          pushEntry(mergeRun(run), run[0], 60 + priorityOf(run[0]));
          i = j;
          continue;
        }
      }
      walk(child, childDepth);
      i += 1;
    }
  };

  for (const root of tree.roots) walk(root, 0);

  // 预算：先按优先级裁剪，再还原文档顺序
  let chars = entries.reduce((total, entry) => total + entry.line.length + 1, 0);
  let truncated = false;
  if (chars > config.maxChars) {
    truncated = true;
    const order = entries.map((entry, index) => ({ entry, index }));
    order.sort((a, b) => (b.entry.priority - a.entry.priority) || (a.index - b.index));
    let used = 0;
    const keep = new Set();
    for (const item of order) {
      const cost = item.entry.line.length + 1;
      if (used + cost > config.maxChars) continue;
      keep.add(item.index);
      used += cost;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (!keep.has(index)) entries.splice(index, 1);
    }
    chars = used;
  }

  const lines = entries.map((entry) => entry.line);
  if (truncated) {
    const note = `… truncated (${chars}/${config.maxChars} chars)`;
    if (chars + note.length + 1 <= config.maxChars) {
      lines.push(note);
      chars += note.length + 1;
    }
  }

  const header = [];
  if (config.header) {
    const win = config.window;
    const rootNode = tree.roots.find((node) => node.role === 'window') || tree.roots[0] || null;
    const title = clampText((win && (win.title || win.name)) || (rootNode ? rootNode.name : ''), 60);
    const rect = win ? rectOf(win.rect) : null;
    const size = rect && rect.w > 0 ? `, ${rect.w}x${rect.h} @${rect.x},${rect.y}` : '';
    const exe = win && win.exe ? `, ${win.exe}` : '';
    const ref = rootNode && rootNode.ref ? ` ${rootNode.ref}` : '';
    if (title || rootNode) {
      header.push(`# window${ref}${title ? ` "${title}"` : ''}${exe}${size}`);
    }
    header.push(`# nodes ${tree.stats.total} kept ${entries.length} chars ${chars}${truncated ? ' truncated' : ''}`);
  }

  const allLines = header.concat(lines);
  const text = allLines.join('\n');
  return {
    text,
    lines: allLines,
    entries,
    total: tree.stats.total,
    kept: entries.length,
    dropped: dropped.length,
    chars,
    truncated,
    stats: tree.stats,
    toString() { return text; },
  };
}

module.exports = {
  compact,
  DEFAULT_MAX_CHARS,
  INTERACTIVE_ROLES,
  CONTAINER_ROLES,
  TABLE_ROLES,
  MERGE_ROLES,
  shouldRender,
  stateFlags,
  tableSummary,
  commonPrefix,
};
