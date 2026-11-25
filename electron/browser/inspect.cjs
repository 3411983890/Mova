'use strict';
// 网页内注入：选区上报 + 元素选择（设计文档 §3.10、§3.11、§4.5）。
//
// webview 不能挂 preload，所以网页里的信息只能靠 CDP 注入 + Runtime binding 回传。
// 主进程这一侧只做三件事：
//   1. 把页内脚本挂到每个新文档（Page.addScriptToEvaluateOnNewDocument）；
//   2. 注册回传 binding（Runtime.addBinding）并校验 nonce / 类型；
//   3. 截断长度、丢弃敏感字段，再交给调用方。
// 页内脚本只读 DOM 属性，绝不读 input.value，也不碰跨域 iframe 内部。

const BINDING_NAME = '__movaInspect';

/** 上报长度上限：任何字段超长都截断，避免恶意页面把宿主撑爆。 */
const MAX_TEXT = 1000;
const MAX_NAME = 280;
const MAX_SELECTOR = 200;
const MAX_URL = 2048;
const MAX_ID = 120;
const MAX_CLASS = 200;

const TYPES = new Set(['selection', 'element', 'exit']);
const TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function clip(value, limit) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/** selector / url 不能压缩空白（属性选择器里可能有空格），只裁剪首尾。 */
function clipRaw(value, limit) {
  const text = String(value == null ? '' : value).trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rectOf(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    x: Math.round(finite(source.x)),
    y: Math.round(finite(source.y)),
    w: Math.max(0, Math.round(finite(source.w))),
    h: Math.max(0, Math.round(finite(source.h))),
  };
}

function urlOf(value) {
  const raw = clipRaw(value, MAX_URL + 1);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  } catch {
    return '';
  }
  return raw.length > MAX_URL ? raw.slice(0, MAX_URL) : raw;
}

/**
 * 元素摘要：只保留白名单字段，`value` 之类永不透传。
 * 密码框保留 tag/selector（用来画浮层），但丢掉一切文本。
 */
function sanitizeElement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const tag = clipRaw(input.tag, 32).toLowerCase();
  if (!TAG_PATTERN.test(tag)) return null;
  const type = clipRaw(input.type, 32).toLowerCase();
  const password = tag === 'input' && type === 'password';
  const element = { tag };
  const id = clipRaw(input.id, MAX_ID);
  if (id) element.id = id;
  const className = clip(input.className, MAX_CLASS);
  if (className) element.className = className;
  const role = clipRaw(input.role, 60);
  if (role) element.role = role;
  const ariaLabel = clip(input.ariaLabel, MAX_NAME);
  if (ariaLabel) element.ariaLabel = ariaLabel;
  const text = password ? '' : clip(input.text, MAX_NAME);
  if (text) element.text = text;
  const selector = clipRaw(input.selector, MAX_SELECTOR);
  if (selector) element.selector = selector;
  return element;
}

/**
 * 回传数据归一化。非法（类型不认识、没有 nonce、元素不可用）一律返回 null，
 * 调用方据此丢弃，不做「尽力修补」。
 */
function sanitizeInspectPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (!TYPES.has(type)) return null;
  const nonce = typeof payload.nonce === 'string' ? payload.nonce.trim().slice(0, 64) : '';
  if (!nonce) return null;
  if (type === 'exit') return { type, nonce };

  const url = urlOf(payload.url);
  const title = clip(payload.title, MAX_NAME);
  const rect = rectOf(payload.rect);

  if (type === 'selection') {
    const text = clip(payload.text, MAX_TEXT);
    // 少于 2 个字符的选区没有引用价值，还会被页面自己的 focus 变化刷屏。
    if (text.length < 2) return null;
    return {
      type,
      nonce,
      text,
      rect,
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
    };
  }

  const element = sanitizeElement(payload.element);
  if (!element) return null;
  return {
    type,
    nonce,
    element,
    rect,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

/**
 * 页内脚本：IIFE、幂等，只做三件事——监听选区变化、维护元素高亮层、选择模式下捕获点击。
 * 所有上报都走 `window.__movaInspectSend(JSON.stringify({...payload, nonce}))`。
 *
 * 注意：Runtime.addBinding('__movaInspect') 会在页面装一个同名全局函数，
 * 所以脚本先把那个函数另存为 `__movaInspectSend`，再用 API 对象覆盖
 * `window.__movaInspect`，两者互不打架。
 */
const INJECT_SOURCE = String.raw`
(function () {
  'use strict';
  var existing = window.__movaInspect;
  if (existing && typeof existing === 'object' && existing.movaVersion) return;

  var api = {};
  var nonce = '';
  var selectionTimer = 0;
  var picker = { active: false, host: null, root: null, box: null, label: null, hovered: null, cursor: null };

  // 覆盖前先记住 binding 注入的原始函数；之后所有上报都用它。
  if (typeof window.__movaInspect === 'function') window.__movaInspectSend = window.__movaInspect;
  var sendFn = typeof window.__movaInspectSend === 'function' ? window.__movaInspectSend : null;

  function collapse(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function clip(value, limit) {
    var text = collapse(value);
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function send(payload) {
    try {
      if (!sendFn) return;
      if (nonce) payload.nonce = nonce;
      sendFn(JSON.stringify(payload));
    } catch (error) { /* binding 已被移除，或页面正在卸载 */ }
  }

  function rectOf(rect) {
    if (!rect) return { x: 0, y: 0, w: 0, h: 0 };
    return {
      x: Math.round(rect.left || 0),
      y: Math.round(rect.top || 0),
      w: Math.max(0, Math.round(rect.width || 0)),
      h: Math.max(0, Math.round(rect.height || 0))
    };
  }

  function elementOf(node) {
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return null;
    return node;
  }

  // 只读属性，绝不读 input.value（可能是密码或一次性验证码）。
  function textOf(el) {
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return clip(
        el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '',
        280
      );
    }
    return clip(el.innerText || el.textContent || '', 280);
  }

  function cssEscape(value) {
    var text = String(value == null ? '' : value);
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
    return text.replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch; });
  }

  // 优先 #id；否则 tag:nth-of-type(n) 向上收敛，最多 6 层 / 200 字符。
  function selectorOf(el) {
    try {
      if (el.id) {
        var byId = '#' + cssEscape(el.id);
        if (document.querySelectorAll(byId).length === 1) return byId.slice(0, 200);
      }
    } catch (error) { /* id 不合法就退回结构选择器 */ }

    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var tag = String(node.tagName || '').toLowerCase();
      if (!tag) break;
      if (depth > 0 && node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var part = tag;
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        var children = parent.children || [];
        for (var i = 0; i < children.length; i += 1) {
          if (children[i].tagName === node.tagName) same.push(children[i]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (parts.join(' > ').length > 200) break;
      node = parent;
      depth += 1;
    }
    var selector = parts.join(' > ');
    return selector.length > 200 ? selector.slice(selector.length - 200) : selector;
  }

  function describe(el) {
    var className = typeof el.className === 'string' ? el.className : '';
    var readAttr = function (name) {
      try { return el.getAttribute ? el.getAttribute(name) || '' : ''; } catch (error) { return ''; }
    };
    return {
      tag: String(el.tagName || '').toLowerCase(),
      id: el.id ? String(el.id).slice(0, 120) : '',
      className: collapse(className).slice(0, 200),
      role: collapse(readAttr('role')).slice(0, 60),
      ariaLabel: collapse(readAttr('aria-label')).slice(0, 280),
      text: textOf(el),
      selector: selectorOf(el)
    };
  }

  function labelOf(el) {
    var tag = String(el.tagName || '').toLowerCase();
    var text = textOf(el).slice(0, 24);
    return text ? tag + ' \u00b7 ' + text : tag;
  }

  function reportSelection() {
    selectionTimer = 0;
    try {
      var selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      var range = selection.getRangeAt(selection.rangeCount - 1);
      var text = clip(selection.toString(), 1000);
      if (text.length < 2) return;
      var rects = range.getClientRects ? range.getClientRects() : null;
      var box = rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      send({
        type: 'selection',
        text: text,
        rect: rectOf(box),
        url: String(location.href || ''),
        title: String(document.title || '')
      });
    } catch (error) { /* 选区在跨域 iframe 内时读不到，直接跳过 */ }
  }

  function onSelectionChange() {
    if (selectionTimer) window.clearTimeout(selectionTimer);
    // 去抖 120ms：拖选过程中只上报一次，且不碰页面默认行为与选区本身。
    selectionTimer = window.setTimeout(reportSelection, 120);
  }

  function ensureOverlay() {
    if (picker.host && picker.host.isConnected) return;
    var host = document.createElement('div');
    host.setAttribute('data-mova-inspect', 'overlay');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    var root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;border:2px solid #5b9bf0;border-radius:2px;background:rgba(91,155,240,0.08);pointer-events:none;display:none;';
    var label = document.createElement('div');
    label.style.cssText = 'position:fixed;left:0;top:0;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#1b1b1b;color:#ffffff;font:11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:2px 6px;border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,0.35);pointer-events:none;display:none;';
    root.appendChild(box);
    root.appendChild(label);
    (document.body || document.documentElement).appendChild(host);
    picker.host = host;
    picker.root = root;
    picker.box = box;
    picker.label = label;
  }

  function hideOverlay() {
    if (picker.box) picker.box.style.display = 'none';
    if (picker.label) picker.label.style.display = 'none';
  }

  function paint(el) {
    if (!picker.active || !el || !el.isConnected) { hideOverlay(); return; }
    ensureOverlay();
    var rect = el.getBoundingClientRect();
    picker.box.style.display = 'block';
    picker.box.style.left = Math.round(rect.left) + 'px';
    picker.box.style.top = Math.round(rect.top) + 'px';
    picker.box.style.width = Math.max(0, Math.round(rect.width)) + 'px';
    picker.box.style.height = Math.max(0, Math.round(rect.height)) + 'px';
    var text = labelOf(el);
    picker.label.textContent = text;
    picker.label.style.display = 'block';
    var top = Math.round(rect.top) - 22;
    if (top < 4) top = Math.round(rect.top) + 4;
    var width = Math.min(320, text.length * 7 + 16);
    var left = Math.round(rect.left);
    if (left + width > window.innerWidth - 12) left = Math.max(4, window.innerWidth - 12 - width);
    picker.label.style.top = top + 'px';
    picker.label.style.left = left + 'px';
  }

  function onPointerMove(event) {
    if (!picker.active) return;
    var el = elementOf(event.target);
    if (!el) return;
    picker.hovered = el;
    paint(el);
  }

  function onScroll() {
    if (!picker.active) return;
    if (picker.hovered && picker.hovered.isConnected) paint(picker.hovered);
    else hideOverlay();
  }

  function onClick(event) {
    if (!picker.active) return;
    // 选择期间吞掉这次点击：不跳转、不提交、不触发页面自己的处理。
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    var el = elementOf(event.target) || picker.hovered;
    var payload = null;
    if (el && el.isConnected) {
      payload = {
        type: 'element',
        element: describe(el),
        rect: rectOf(el.getBoundingClientRect()),
        url: String(location.href || ''),
        title: String(document.title || '')
      };
    }
    stopPicker();
    send(payload || { type: 'exit' });
  }

  function onKeyDown(event) {
    if (!picker.active) return;
    var key = event.key || '';
    if (key !== 'Escape' && key !== 'Esc') return;
    event.preventDefault();
    event.stopPropagation();
    stopPicker();
    send({ type: 'exit' });
  }

  function listen(add) {
    var method = add ? 'addEventListener' : 'removeEventListener';
    window[method]('mousemove', onPointerMove, true);
    window[method]('scroll', onScroll, true);
    window[method]('click', onClick, true);
    window[method]('keydown', onKeyDown, true);
  }

  function startPicker() {
    if (picker.active) return true;
    picker.active = true;
    var html = document.documentElement;
    picker.cursor = html.style.cursor;
    html.style.cursor = 'crosshair';
    ensureOverlay();
    picker.hovered = null;
    listen(true);
    return true;
  }

  function stopPicker() {
    if (!picker.active) return false;
    picker.active = false;
    listen(false);
    try { document.documentElement.style.cursor = picker.cursor || ''; } catch (error) { /* ignore */ }
    if (picker.host && picker.host.parentNode) picker.host.parentNode.removeChild(picker.host);
    picker.host = null;
    picker.root = null;
    picker.box = null;
    picker.label = null;
    picker.hovered = null;
    return true;
  }

  api.movaVersion = 1;
  api.setNonce = function (value) {
    nonce = String(value == null ? '' : value).slice(0, 64);
    return nonce;
  };
  api.startPicker = startPicker;
  api.stopPicker = stopPicker;
  api.isPicking = function () { return picker.active; };
  window.__movaInspect = api;

  document.addEventListener('selectionchange', onSelectionChange, true);
  window.addEventListener('pagehide', function () { stopPicker(); }, true);
})();
`;

function assertCdp(cdp) {
  if (!cdp || typeof cdp.send !== 'function' || typeof cdp.on !== 'function') {
    throw new TypeError('createInspectSession needs a cdp client');
  }
}

/**
 * 一次注入会话：一个 target + 一个 nonce。
 * start() 幂等（重复调用只重新下发 nonce，用于导航后的新文档）；
 * stop()/dispose() 会撤掉脚本与 binding，之后不再收到任何上报。
 */
function createInspectSession({ cdp, nonce, emit, scriptSource = INJECT_SOURCE, bindingName = BINDING_NAME, logger = console } = {}) {
  assertCdp(cdp);
  const sessionNonce = typeof nonce === 'string' ? nonce.trim().slice(0, 64) : '';
  let started = false;
  let disposed = false;
  let unsubscribe = null;
  let scriptId = null;

  function log(message, error) {
    try { logger?.warn?.(`[inspect] ${message}`, error?.message || error || ''); } catch { /* logging is best effort */ }
  }

  function handleEvent(method, params) {
    if (method !== 'Runtime.bindingCalled') return;
    if (!params || params.name !== bindingName) return;
    let parsed;
    try { parsed = JSON.parse(String(params.payload || '')); } catch { return; }
    const clean = sanitizeInspectPayload(parsed);
    if (!clean || clean.nonce !== sessionNonce) return;
    try { emit?.(clean); } catch { /* 监听方异常不能影响 CDP */ }
  }

  /** 把本轮 nonce 写进页内脚本；导航后新文档需要重新下发一次。 */
  async function syncNonce() {
    if (!sessionNonce) return false;
    try {
      const value = await cdp.send('Runtime.evaluate', {
        expression: `window.__movaInspect && window.__movaInspect.setNonce && window.__movaInspect.setNonce(${JSON.stringify(sessionNonce)})`,
        returnByValue: true,
      }, 5000);
      return Boolean(value?.result?.value);
    } catch {
      return false;   // 页面还在加载/已卸载：下一次 start() 会再同步。
    }
  }

  async function start() {
    if (disposed) throw new Error('inspect session disposed');
    if (started) {
      await syncNonce();
      return { ok: true, nonce: sessionNonce, scriptId };
    }
    if (!unsubscribe) unsubscribe = cdp.on(handleEvent);
    try {
      await cdp.send('Runtime.addBinding', { name: bindingName });
    } catch (error) {
      // 同一个 context 重复注册同名 binding 会报错；这不是失败。
      if (!/already|exist/i.test(String(error?.message || ''))) {
        try { unsubscribe?.(); } catch { /* ignore */ }
        unsubscribe = null;
        throw error;
      }
    }
    try {
      const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: scriptSource,
        runImmediately: true,
      });
      scriptId = added?.identifier ?? null;
    } catch (error) {
      // 老版本 CDP 没有 runImmediately：退回「只注册 + 立刻手动执行一次」。
      try {
        const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: scriptSource });
        scriptId = added?.identifier ?? null;
        await cdp.send('Runtime.evaluate', { expression: scriptSource, returnByValue: false }, 5000).catch(() => {});
      } catch (retry) {
        try { unsubscribe?.(); } catch { /* ignore */ }
        unsubscribe = null;
        log('inject failed', retry || error);
        throw retry;
      }
    }
    started = true;
    await syncNonce();
    return { ok: true, nonce: sessionNonce, scriptId };
  }

  async function cleanup() {
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* ignore */ }
      unsubscribe = null;
    }
    if (scriptId) {
      const identifier = scriptId;
      scriptId = null;
      try {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, 5000);
      } catch { /* 文档可能已经换了 */ }
    }
    try {
      await cdp.send('Runtime.removeBinding', { name: bindingName }, 5000);
    } catch { /* 已经没了 */ }
  }

  async function stop() {
    const wasStarted = started;
    started = false;
    if (wasStarted || unsubscribe) await cleanup();
    return { ok: true };
  }

  async function dispose() {
    if (disposed) return { ok: true };
    disposed = true;
    await stop();
    return { ok: true };
  }

  return {
    get nonce() { return sessionNonce; },
    get started() { return started; },
    get disposed() { return disposed; },
    start,
    stop,
    dispose,
    syncNonce,
  };
}

module.exports = {
  INJECT_SOURCE,
  createInspectSession,
  sanitizeInspectPayload,
  BINDING_NAME,
  MAX_TEXT,
  MAX_NAME,
  MAX_SELECTOR,
  MAX_URL,
};
