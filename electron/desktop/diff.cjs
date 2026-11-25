'use strict';
// ΔTree：两次快照按 stableKey 对齐，只输出变化（纯函数，可单测）。
// 设计见 Mova桌面操作开发方案.md §6：
// 1) 按 stableKey 对齐，得到 added / removed / changed；
// 2) changed 只看有意义的东西：name / value / enabled / selected / expanded / offscreen / focused / rect 位移 > 8px；
// 3) 输出 + / - / ~ 行，新增顶层窗口（对话框最重要）单独置顶；
// 4) 变化超过 60% 时给 fallback:true，让上层退回“只回前台窗口的浅层树”。

const { normalizeNodes, rectOf } = require('./tree.cjs');

const CHANGE_THRESHOLD = 0.6;
const MIN_NODES_FOR_THRESHOLD = 8;
const RECT_DELTA = 8;

function pickNodes(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.nodes)) return input.nodes;
  return [];
}

function rectMoved(a, b) {
  const before = rectOf(a);
  const after = rectOf(b);
  return Math.abs(before.x - after.x) > RECT_DELTA
    || Math.abs(before.y - after.y) > RECT_DELTA
    || Math.abs(before.w - after.w) > RECT_DELTA
    || Math.abs(before.h - after.h) > RECT_DELTA;
}

function overlapScore(a, b) {
  const r1 = rectOf(a);
  const r2 = rectOf(b);
  if (r1.w <= 0 || r1.h <= 0 || r2.w <= 0 || r2.h <= 0) return 0;
  const left = Math.max(r1.x, r2.x);
  const top = Math.max(r1.y, r2.y);
  const right = Math.min(r1.x + r1.w, r2.x + r2.w);
  const bottom = Math.min(r1.y + r1.h, r2.y + r2.h);
  if (right <= left || bottom <= top) return 0;
  const inter = (right - left) * (bottom - top);
  return inter / Math.min(r1.w * r1.h, r2.w * r2.h);
}

function roleLabel(role) {
  const raw = String(role || 'custom');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function quote(name, max = 60) {
  const raw = String(name === undefined || name === null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return ` "${raw.length > max ? `${raw.slice(0, max - 1)}…` : raw}"`;
}

// 变化明细里用的紧凑引号（不带行内空格）
function q(name, max = 40) {
  return quote(name, max).trim() || '""';
}

function flagsOf(node) {
  const flags = [];
  const states = node.states || {};
  if (states.password) flags.push('password');
  if (states.enabled === false) flags.push('disabled');
  if (states.offscreen === true) flags.push('offscreen');
  if (states.selected === true) flags.push('selected');
  if (states.expanded === true) flags.push('expanded');
  if (states.expanded === false) flags.push('collapsed');
  if (states.expanded === 'partial') flags.push('expanded=partial');
  if (states.toggled === true) flags.push('toggled');
  if (states.toggled === 'indeterminate') flags.push('toggled=mixed');
  if (states.focused === true) flags.push('focused');
  return flags;
}

// 单行描述：`[w1.3] Button "确定" disabled`
function toLine(node) {
  const indent = node.depth > 0 ? '  '.repeat(Math.min(4, node.depth)) : '';
  const ref = node.ref ? `[${node.ref}] ` : '';
  const value = node.states && node.states.password
    ? ' value=<secret>'
    : (node.value ? ` value="${String(node.value).slice(0, 40)}"` : '');
  const flags = flagsOf(node);
  return `${indent}${ref}${roleLabel(node.role)}${quote(node.name)}${value}${flags.length ? ` ${flags.join(' ')}` : ''}`;
}

function describeChange(before, after) {
  const parts = [];
  if (before.name !== after.name) parts.push(`name:${q(before.name)}→${q(after.name)}`);
  if (before.value !== after.value) {
    const secret = (before.states && before.states.password) || (after.states && after.states.password);
    parts.push(secret ? 'value:<secret>' : `value:${q(before.value || '', 24)}→${q(after.value || '', 24)}`);
  }
  const beforeFlags = new Set(flagsOf(before));
  const afterFlags = new Set(flagsOf(after));
  for (const flag of afterFlags) if (!beforeFlags.has(flag)) parts.push(`+${flag}`);
  for (const flag of beforeFlags) if (!afterFlags.has(flag)) parts.push(`-${flag}`);
  if (rectMoved(before.rect, after.rect)) {
    const r1 = rectOf(before.rect);
    const r2 = rectOf(after.rect);
    parts.push(`@${r1.x},${r1.y}→${r2.x},${r2.y}`);
  }
  return parts;
}

function isWindowNode(node) {
  return node.depth === 0 && (node.role === 'window' || node.role === 'dialog');
}

/**
 * @param {object[]|{nodes:object[]}|null} previous
 * @param {object[]|{nodes:object[]}} next
 * @param {object} [options] {window, time, threshold}
 * @returns {{changed:boolean, fallback:boolean, text:string, lines:string[],
 *            added:object[], removed:object[], changedCount:number, stats:object, modal:string|null}}
 */
function diffTrees(previous, next, options = {}) {
  const prevNodes = normalizeNodes(pickNodes(previous));
  const nextNodes = normalizeNodes(pickNodes(next));
  const label = options.window ? ` ${String(options.window).slice(0, 60)}` : '';
  const empty = {
    changed: false,
    fallback: false,
    text: '',
    lines: [],
    added: [],
    removed: [],
    changedCount: 0,
    stats: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    modal: null,
  };

  if (prevNodes.length === 0) {
    return {
      ...empty,
      fallback: true,
      reason: 'first-snapshot',
      text: `# diff${label}  (first snapshot: ${nextNodes.length} nodes, render full tree)`,
    };
  }

  const byKey = new Map();
  for (const node of prevNodes) byKey.set(node.key, node);
  const nextKeys = new Set();
  for (const node of nextNodes) nextKeys.add(node.key);

  const rawAdded = [];
  const changed = [];
  let unchanged = 0;
  for (const node of nextNodes) {
    const before = byKey.get(node.key);
    if (!before) { rawAdded.push(node); continue; }
    const parts = describeChange(before, node);
    if (parts.length === 0) { unchanged += 1; continue; }
    changed.push({ before, after: node, detail: parts });
  }
  const rawRemoved = prevNodes.filter((node) => !nextKeys.has(node.key));

  // 同名同角色的“改名”会表现成一删一增：位置重叠且角色/类名一致时视为同一个控件的变化
  const usedRemoved = new Set();
  const added = [];
  const renamed = [];
  for (const node of rawAdded) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < rawRemoved.length; i += 1) {
      if (usedRemoved.has(i)) continue;
      const before = rawRemoved[i];
      if (before.role !== node.role || before.className !== node.className) continue;
      const score = overlapScore(before.rect, node.rect);
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    if (bestIndex >= 0 && bestScore >= 0.6) {
      usedRemoved.add(bestIndex);
      renamed.push({ before: rawRemoved[bestIndex], after: node, detail: describeChange(rawRemoved[bestIndex], node) });
      continue;
    }
    added.push(node);
  }
  const removed = rawRemoved.filter((_node, index) => !usedRemoved.has(index));

  const changeCount = added.length + removed.length + changed.length + renamed.length;
  const base = Math.max(prevNodes.length, nextNodes.length);
  const threshold = Number.isFinite(options.threshold) ? options.threshold : CHANGE_THRESHOLD;
  const tooMany = base >= MIN_NODES_FOR_THRESHOLD && changeCount > base * threshold;

  // 新增顶层窗口（对话框/弹窗）是最高优先信号，置顶
  const newWindows = added.filter(isWindowNode);
  const modal = newWindows.length ? (newWindows[0].name || newWindows[0].role) : null;
  const lines = [];
  if (newWindows.length) {
    for (const node of newWindows) {
      lines.push(`+ ${node.role === 'window' ? 'window' : 'dialog'}${quote(node.name)} modal`);
    }
  }
  const body = [
    ...changed.map((item) => `~ ${toLine(item.after)}${item.detail.length ? `  (${item.detail.join('; ')})` : ''}`),
    ...renamed.map((item) => `~ ${toLine(item.after)}  (${item.detail.join('; ') || 'renamed'})`),
    ...added.filter((node) => !newWindows.includes(node)).map((node) => `+ ${toLine(node)}`),
    ...removed.map((node) => `- ${toLine(node)}`),
  ];
  lines.push(...body);

  const stats = { added: added.length, removed: removed.length, changed: changed.length + renamed.length, unchanged };
  const header = `# diff${label}  +${stats.added} -${stats.removed} ~${stats.changed}${modal ? `  (modal:${quote(modal)})` : ''}`;
  const text = lines.length ? [header, ...lines].join('\n') : `${header}\n没有变化`;

  const allChanged = [...changed, ...renamed];
  return {
    changed: changeCount > 0,
    fallback: tooMany,
    reason: tooMany ? 'too-many-changes' : (changeCount > 0 ? 'changed' : 'no-change'),
    text,
    lines,
    added,
    removed,
    changedCount: changeCount,
    details: allChanged.map((item) => ({
      key: item.after.key,
      ref: item.after.ref,
      role: item.after.role,
      name: item.after.name,
      before: item.before.ref,
      parts: item.detail,
    })),
    stats,
    modal,
  };
}

module.exports = {
  diffTrees,
  describeChange,
  toLine,
  overlapScore,
  rectMoved,
  CHANGE_THRESHOLD,
  MIN_NODES_FOR_THRESHOLD,
  RECT_DELTA,
};
