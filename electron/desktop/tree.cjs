'use strict';
// 把 worker 返回的原始节点列表整理成统一的树模型（纯函数，可单测）。
// worker 已经按 DFS 先序给出节点，并带 depth/parent；这里补 stableKey、path、唯一 key，
// 供 compact（渲染）和 diff（对齐）共用，避免两处各自猜结构。

const NAME_MAX = 120;
const VALUE_MAX = 200;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function text(value, max) {
  if (value === undefined || value === null) return '';
  const raw = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > max ? raw.slice(0, max) : raw;
}

// [x,y,w,h] | {x,y,width,height} | {x,y,w,h} -> {x,y,w,h}
function rectOf(raw) {
  if (!raw) return { x: 0, y: 0, w: 0, h: 0 };
  if (Array.isArray(raw)) {
    return { x: num(raw[0]), y: num(raw[1]), w: Math.max(0, num(raw[2])), h: Math.max(0, num(raw[3])) };
  }
  if (typeof raw === 'object') {
    const w = raw.w !== undefined ? raw.w : raw.width;
    const h = raw.h !== undefined ? raw.h : raw.height;
    return {
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(0, num(w)),
      h: Math.max(0, num(h)),
    };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function rectIsEmpty(rect) {
  return !rect || rect.w <= 0 || rect.h <= 0;
}

function rectCenter(rect) {
  const r = rectOf(rect);
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
}

function normalizeStates(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const bool = (value) => (value === true ? true : value === false ? false : null);
  return {
    enabled: src.enabled !== false,
    focusable: src.focusable === true,
    offscreen: src.offscreen === true,
    password: src.password === true,
    selected: bool(src.selected),
    expanded: src.expanded === 'partial' ? 'partial' : bool(src.expanded),
    toggled: src.toggled === 'indeterminate' ? 'indeterminate' : bool(src.toggled),
    focused: src.focused === true,
  };
}

function normalizePatterns(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

// 只整理单个节点（不做 path/key，那需要整棵树）。
function normalizeNode(raw) {
  const node = raw && typeof raw === 'object' ? raw : {};
  const states = normalizeStates(node.states);
  return {
    ref: typeof node.ref === 'string' ? node.ref : '',
    role: text(node.role, 40).toLowerCase() || 'custom',
    name: text(node.name, NAME_MAX),
    automationId: text(node.automationId, 200),
    className: text(node.className, NAME_MAX),
    rect: rectOf(node.rect),
    depth: Math.max(0, Math.min(40, num(node.depth, 0))),
    parentRef: typeof node.parent === 'string' ? node.parent : (typeof node.parentRef === 'string' ? node.parentRef : ''),
    states,
    // 密码框永远不回值
    value: states.password ? null : (node.value === undefined || node.value === null ? null : text(node.value, VALUE_MAX)),
    patterns: normalizePatterns(node.patterns),
    stableKey: '',
    key: '',
    path: '',
    weak: false,
    index: 0,
  };
}

function pathSegment(node, siblingIndex) {
  const name = node.name ? `"${node.name}"` : '';
  return `${node.role}${name}#${siblingIndex}`;
}

// 兜底键：没有 automationId 也没有 name 时用路径指纹（易碎，标 weak）。
function stableKeyOf(node) {
  if (node.automationId) return `aid:${node.automationId}`;
  if (node.name) return `${node.role}|${node.name}|${node.className || ''}`;
  return `path:${node.path || node.role}`;
}

function shortPath(path) {
  const parts = String(path || '').split('/');
  const tail = parts.slice(-4).join('/');
  return tail.length > 240 ? tail.slice(-240) : tail;
}

/**
 * @param {object[]} rawNodes worker 返回的节点（DFS 先序、带 depth）
 * @returns {object[]} 规范化节点，附 path/stableKey/key/index
 */
function normalizeNodes(rawNodes) {
  const list = Array.isArray(rawNodes) ? rawNodes : [];
  const nodes = [];
  const stack = [];
  const childCounts = new Map();
  for (const raw of list) {
    const node = normalizeNode(raw);
    while (stack.length > node.depth) stack.pop();
    const parent = node.depth > 0 ? stack[node.depth - 1] : null;
    if (node.depth > 0 && !parent) node.depth = stack.length;
    const ownerKey = parent ? parent.key || `d${parent.depth}` : '__root__';
    const siblingIndex = childCounts.get(ownerKey) || 0;
    childCounts.set(ownerKey, siblingIndex + 1);
    node.path = shortPath(parent ? `${parent.path}/${pathSegment(node, siblingIndex)}` : pathSegment(node, 0));
    node.stableKey = stableKeyOf(node);
    node.weak = node.stableKey.startsWith('path:');
    node.index = nodes.length;
    stack[node.depth] = node;
    stack.length = node.depth + 1;
    nodes.push(node);
  }
  // key 在同一份快照里唯一：同一个 stableKey 出现多次时补 #n
  const seen = new Map();
  for (const node of nodes) {
    const count = seen.get(node.stableKey) || 0;
    seen.set(node.stableKey, count + 1);
    node.key = count === 0 ? node.stableKey : `${node.stableKey}#${count}`;
  }
  return nodes;
}

/**
 * @param {object[]} rawNodes
 * @returns {{nodes:object[], byRef:Map<string,object>, byKey:Map<string,object>, roots:object[], childrenOf:Function, stats:object}}
 */
function buildTree(rawNodes) {
  const nodes = normalizeNodes(rawNodes);
  const byRef = new Map();
  const byKey = new Map();
  const children = new Map();
  const roots = [];
  const stack = [];
  for (const node of nodes) {
    if (node.ref) byRef.set(node.ref, node);
    byKey.set(node.key, node);
    let parent = node.parentRef ? byRef.get(node.parentRef) || null : null;
    // 没有可用的 parent（例如手工构造的节点）时按 depth 兜底
    if (!parent && node.depth > 0) parent = stack[node.depth - 1] || null;
    if (parent && parent !== node) {
      const parentKey = parent.ref || parent.key;
      if (!children.has(parentKey)) children.set(parentKey, []);
      children.get(parentKey).push(node);
      node.parentKey = parentKey;
    } else {
      roots.push(node);
      node.parentKey = '';
    }
    stack[node.depth] = node;
    stack.length = node.depth + 1;
  }
  const byRole = {};
  for (const node of nodes) byRole[node.role] = (byRole[node.role] || 0) + 1;
  return {
    nodes,
    byRef,
    byKey,
    roots,
    childrenOf: (node) => {
      if (!node) return [];
      return children.get(node.ref || node.key) || [];
    },
    stats: { total: nodes.length, roots: roots.length, byRole },
  };
}

// 结构稳定判据：ref 不参与（每次快照都变），用 key+属性组合。
function fingerprintOf(rawNodes) {
  const nodes = Array.isArray(rawNodes) && rawNodes[0] && rawNodes[0].key !== undefined
    ? rawNodes
    : normalizeNodes(rawNodes);
  return nodes.map((node) => [
    node.key,
    node.name,
    node.value === null ? '' : node.value,
    node.states.enabled ? '1' : '0',
    node.states.selected === true ? '1' : '0',
    node.states.expanded === true ? '1' : '0',
    node.states.toggled === true ? '1' : '0',
    node.rect.x,
    node.rect.y,
    node.rect.w,
    node.rect.h,
  ].join('|')).join('\n');
}

function findByRef(rawNodes, ref) {
  const nodes = Array.isArray(rawNodes) && rawNodes[0] && rawNodes[0].key !== undefined
    ? rawNodes
    : normalizeNodes(rawNodes);
  return nodes.find((node) => node.ref === ref) || null;
}

function isInteractive(node) {
  return Boolean(node) && Array.isArray(node.patterns) && node.patterns.some((p) => (
    p === 'invoke' || p === 'value' || p === 'selectionitem' || p === 'toggle' || p === 'expandcollapse'
  ));
}

module.exports = {
  NAME_MAX,
  VALUE_MAX,
  rectOf,
  rectCenter,
  rectIsEmpty,
  normalizeNode,
  normalizeNodes,
  normalizeStates,
  normalizePatterns,
  buildTree,
  stableKeyOf,
  fingerprintOf,
  findByRef,
  isInteractive,
  num,
  text,
};
