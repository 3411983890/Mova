'use strict';
// Pure AXTree -> compact text tree. No Electron, no DOM: the snapshot layer
// feeds it the raw `Accessibility.getFullAXTree` result and the diff layer
// consumes the returned entries.
//
// Goals:
// - keep controls, landmarks, headings and readable text;
// - drop presentational wrappers, hidden subtrees and empty containers;
// - give every actionable node a stable ref derived from backendDOMNodeId;
// - stay inside a hard character budget so one page cannot flood the model.

const KEEP_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'treeitem', 'gridcell', 'cell', 'columnheader', 'rowheader',
  'heading', 'img', 'table', 'row', 'list', 'listitem', 'dialog', 'alertdialog',
  'navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'status', 'alert',
  'progressbar', 'separator', 'article', 'region', 'paragraph', 'blockquote', 'code',
  'figure', 'toolbar', 'tablist', 'menu', 'menubar', 'tree', 'treegrid', 'grid', 'radiogroup',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'treeitem', 'gridcell',
]);

const TEXT_ROLES = new Set(['StaticText', 'InlineTextBox']);
// Refs are for things the agent can act on or scope to. Giving every cell and
// paragraph a ref doubles the snapshot size without adding capability.
const REF_ROLES = new Set([
  ...INTERACTIVE_ROLES, 'dialog', 'alertdialog', 'table', 'list', 'tablist',
  'toolbar', 'navigation', 'main', 'form', 'region',
]);
// Input-like roles render their value as the line body; their AX children just
// repeat the value, so do not descend.
const LEAF_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'progressbar']);
const DROP_SUBTREE_REASONS = new Set(['notVisible', 'ariaHiddenSubtree', 'inertSubtree', 'hiddenRoot']);
const STATE_PROPERTIES = new Set([
  'disabled', 'checked', 'expanded', 'selected', 'pressed', 'required', 'readonly',
  'invalid', 'level', 'valuetext', 'hasPopup', 'modal', 'multiselectable', 'orientation',
]);
const SENSITIVE_QUERY = /^(token|access_token|refresh_token|code|key|apikey|api_key|session|sessionid|auth|password|secret|signature|sig)$/i;

const DEFAULTS = Object.freeze({
  maxNodes: 1200,
  maxChars: 24000,
  maxDepth: 30,
  maxName: 120,
  maxText: 160,
});

function valueOf(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

function normalize(value, limit) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function propsOf(node) {
  const map = new Map();
  for (const property of Array.isArray(node.properties) ? node.properties : []) {
    if (property && typeof property.name === 'string') map.set(property.name, valueOf(property.value));
  }
  return map;
}

function isHardHidden(node) {
  if (!node.ignored) return false;
  const reasons = Array.isArray(node.ignoredReasons) ? node.ignoredReasons : [];
  return reasons.some(reason => DROP_SUBTREE_REASONS.has(reason?.name));
}

function isPassword(node, props) {
  if (node.__password === true) return true;
  if (props.get('protected') === true) return true;
  if (props.get('password') === true) return true;
  return false;
}

function sanitizeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let text = raw;
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, 'redacted');
    }
    text = `${url.pathname}${url.search}`;
  } catch {
    text = text.replace(/([?&])(token|code|key|session|auth|password|secret)=([^&#]*)/gi, '$1$2=redacted');
  }
  return normalize(text, 160);
}

function refOf(node, prefix) {
  if (!node.backendDOMNodeId) return '';
  return `[ref=${prefix || ''}e${Number(node.backendDOMNodeId).toString(36)}]`;
}

function stateFlags(props) {
  const flags = [];
  for (const name of STATE_PROPERTIES) {
    if (!props.has(name)) continue;
    const value = props.get(name);
    if (name === 'disabled' || name === 'required' || name === 'readonly' || name === 'modal' || name === 'multiselectable') {
      if (value === true) flags.push(name);
      continue;
    }
    if (name === 'checked' || name === 'expanded' || name === 'selected' || name === 'pressed') {
      if (value === true) flags.push(name);
      else if (value === 'mixed') flags.push(`${name}=mixed`);
      else if (value === false && (name === 'checked' || name === 'expanded')) flags.push(`${name}=false`);
      continue;
    }
    if (name === 'invalid') {
      if (value && value !== 'false') flags.push('invalid');
      continue;
    }
    if (name === 'level' || name === 'orientation' || name === 'hasPopup') {
      if (value !== undefined && value !== '') flags.push(`${name}=${normalize(value, 24)}`);
      continue;
    }
    if (name === 'valuetext') {
      const text = normalize(value, 40);
      if (text) flags.push(`valuetext="${text}"`);
    }
  }
  return flags.length ? ` [${flags.join(' ')}]` : '';
}

function shouldKeep(role, name) {
  if (KEEP_ROLES.has(role)) return true;
  if ((role === 'group' || role === 'section') && name) return true;
  return false;
}

function buildIndex(nodes) {
  const byId = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node && typeof node.nodeId === 'string') byId.set(node.nodeId, node);
  }
  const childrenOf = node => (Array.isArray(node.childIds) ? node.childIds : [])
    .map(id => byId.get(id)).filter(Boolean);
  const roots = [...byId.values()].filter(node => !node.parentId || !byId.has(node.parentId));
  return { byId, childrenOf, roots };
}

/** 从上一份快照里的 `[ref=e12]` 解析出 backendDOMNodeId（36 进制）。 */
function parseRef(ref) {
  const text = String(ref || '').trim().replace(/^@/, '').replace(/^ref=/, '');
  if (!/^e[0-9a-z]+$/i.test(text)) return 0;
  const value = Number.parseInt(text.slice(1), 36);
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {object[]} nodes raw AXNode array from Accessibility.getFullAXTree
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {string} [options.title]
 * @param {string} [options.scope]
 * @param {string} [options.framePrefix] e.g. "f1:" for iframe-local refs
 * @param {string|number} [options.rootRef] 只采集这个引用对应的子树（按需页面树）
 * @param {number} [options.maxNodes]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxDepth]
 * @returns {{text:string, lines:string[], entries:object[], total:number, kept:number, truncated:boolean, chars:number, rooted:boolean}}
 */
function compactAxTree(nodes, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const { byId, childrenOf, roots } = buildIndex(nodes);
  const rootBackendId = config.rootBackendId || parseRef(config.rootRef);
  const startNodes = rootBackendId
    ? [...byId.values()].filter(node => node.backendDOMNodeId === rootBackendId)
    : roots;
  const rooted = Boolean(rootBackendId && startNodes.length);
  const baseIndent = '  '.repeat(Math.max(0, Math.min(4, Number(config.baseIndent) || 0)));
  const entries = [];
  let visited = 0;
  let chars = 0;
  let truncated = false;

  const childText = node => {
    const texts = [];
    for (const child of childrenOf(node)) {
      if (!TEXT_ROLES.has(child.role?.value)) continue;
      if (isHardHidden(child)) continue;
      const text = normalize(child.name?.value, config.maxText);
      if (text) texts.push(text);
    }
    return texts.join(' ');
  };

  const emit = (line, entry) => {
    if (entries.length >= config.maxNodes || chars + line.length + 1 > config.maxChars) {
      truncated = true;
      return false;
    }
    entries.push({ ...entry, line });
    chars += line.length + 1;
    return true;
  };

  const walk = (node, depth, stack) => {
    if (entries.length >= config.maxNodes) { truncated = true; return false; }
    visited += 1;
    if (isHardHidden(node)) return false;
    const role = node.role?.value || '';
    if (!role) return false;
    if (depth > config.maxDepth) { truncated = true; return false; }

    if (TEXT_ROLES.has(role)) return false;

    const props = propsOf(node);
    const rawName = normalize(node.name?.value, config.maxName);
    const text = childText(node);
    const keep = shouldKeep(role, rawName) && !node.ignored;
    const indent = '  '.repeat(depth);
    const path = stack.slice(-3).map(item => item.name ? `${item.role} "${item.name}"` : item.role).join(' > ');

    if (keep) {
      const value = isPassword(node, props) ? '••••' : normalize(node.value?.value, config.maxText);
      const href = role === 'link' ? sanitizeUrl(props.get('url')) : '';
      const ref = REF_ROLES.has(role) || props.get('focusable') === true ? refOf(node, config.framePrefix) : '';
      const flags = stateFlags(props);
      const suffix = [];
      if (rawName) suffix.push(`"${rawName}"`);
      if (ref) suffix.push(ref);
      if (href) suffix.push(`href="${href}"`);

      let line = `${baseIndent}${indent}- ${role}${suffix.length ? ` ${suffix.join(' ')}` : ''}${flags}`;
      if (value) line += ` value="${value}"`;
      const body = text && text !== rawName ? text : '';
      if (body) line += `: ${body}`;

      const fingerprint = [role, rawName, value, flags, body].join('\u0000');
      const key = node.backendDOMNodeId ? `e:${node.backendDOMNodeId}` : `n:${node.nodeId}`;
      emit(line, { key, role, name: rawName, value, text: body, flags, fingerprint, ref, path, depth: depth + (Number(config.baseIndent) || 0) });

      if (LEAF_ROLES.has(role)) return true;
      for (const child of childrenOf(node)) {
        if (TEXT_ROLES.has(child.role?.value)) continue;
        walk(child, depth + 1, [...stack, { role, name: rawName }]);
      }
      return true;
    }

    // Dropped container: walk children in order, flushing interleaved text so
    // the rendered order still reads like the page.
    let emitted = false;
    let pending = '';
    const flush = () => {
      if (!pending) return;
      // A <label> usually repeats the accessible name of the control next to
      // it; emitting both doubles the line without adding information.
      const duplicate = childrenOf(node).some(child => {
        const childRole = child.role?.value || '';
        return shouldKeep(childRole, normalize(child.name?.value, config.maxName))
          && normalize(child.name?.value, config.maxName) === pending;
      });
      if (!duplicate) {
        const line = `${baseIndent}${indent}- text: ${pending}`;
        const fingerprint = ['text', pending].join('\u0000');
        const key = `t:${node.nodeId}:${pending}`;
        emit(line, { key, role: 'text', name: pending, value: '', text: pending, flags: '', fingerprint, ref: '', path, depth });
        emitted = true;
      }
      pending = '';
    };
    for (const child of childrenOf(node)) {
      if (TEXT_ROLES.has(child.role?.value)) {
        if (isHardHidden(child)) continue;
        const childValue = normalize(child.name?.value, config.maxText);
        if (childValue) pending = pending ? `${pending} ${childValue}` : childValue;
        continue;
      }
      flush();
      if (walk(child, depth, stack)) emitted = true;
    }
    flush();
    return emitted;
  };

  for (const root of startNodes) walk(root, 0, []);

  if (truncated) {
    const line = `…（快照已截断，共访问 ${visited} 个节点；可用 scope/selector 缩小范围）`;
    if (chars + line.length + 1 <= config.maxChars) {
      entries.push({ key: 'truncated', role: 'note', name: '', value: '', text: '', flags: '', fingerprint: line, line, ref: '', path: '', depth: 0 });
      chars += line.length + 1;
    }
  }

  const header = [];
  if (config.header !== false) {
    if (config.url) header.push(`# page ${config.url}${config.title ? `  "${normalize(config.title, 120)}"` : ''}`);
    header.push(`# scope ${config.scope || 'page'}  kept ${entries.length}/${visited}  chars ${chars}${truncated ? '  truncated' : ''}${rootBackendId ? `  root=@e${Number(rootBackendId).toString(36)}${rooted ? '' : ' (not-found)'}` : ''}`);
  }
  const lines = header.concat(entries.map(entry => entry.line));
  return {
    text: lines.join('\n'),
    lines,
    entries,
    total: visited,
    kept: entries.length,
    truncated,
    rooted,
    chars,
  };
}

module.exports = {
  compactAxTree,
  refOf,
  parseRef,
  sanitizeUrl,
  stateFlags,
  KEEP_ROLES,
  INTERACTIVE_ROLES,
  TEXT_ROLES,
};
