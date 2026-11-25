/* 右侧面板的引用浮层（方案 §3.9 / §3.10 / §3.11 / §4.6）。

   选区（文件、Markdown、代码、网页）与元素选择共用同一个宿主浮层：
   浮层是 `.browser-stage` 里的绝对定位节点（z-index 24），坐标相对面板计算，
   因此不会被 `.browser-stage{overflow:hidden}` 裁掉。

   与 side-browser 解耦：只接收 stage 元素 + 三个回调，可单独挂载 / 销毁。
   定位算子在 quote-position.js（纯函数，有单测）。

   事件约定：
   - 点「引用到对话」→ 默认调用 `window.movaQuotes.add({ text, source })`；
     没有该桥时派发 `mova:quote-to-chat`（detail 同 { text, source }）；
     传了 `onQuote` 则由宿主接管（模块不再自动转发，避免重复入列）。
   - 关闭时机：Esc、面板内任何滚动、窗口 resize、side-browser 的
     `mova:location-change`，以及（宿主主动调用）`syncLocation()`。
*/

import './quote.css';
import { placePopover } from './quote-position.js';

/** 引用事件名（与 app.js 的 addQuote 对齐）。 */
export const QUOTE_EVENT = 'mova:quote-to-chat';
/** 浮层摘要的单行长度上限。 */
const SUMMARY_LIMIT = 80;
/** 元素首行的文本长度上限。 */
const ELEMENT_SNIPPET_LIMIT = 40;
/** 传出去的正文上限（chips 还会按 1000 字截断并标注）。 */
const QUOTE_RAW_LIMIT = 4000;
/** 选区至少 2 个字符才值得引用（与聊天区一致）。 */
const MIN_SELECTION = 2;

/* ── 纯文本辅助（不碰 DOM，便于复用 / 单测） ───────────────────── */

function squeeze(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

/** `https://www.example.com/a/b` → `example.com`。 */
export function domainOf(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./i, '');
  }
}

/** 元素上的可见文本；密码框一律不显示（后端已过滤，这里是兜底）。 */
export function elementText(element) {
  if (!element || typeof element !== 'object') return '';
  const type = String(element.type ?? element.inputType ?? '').toLowerCase();
  if (element.password === true || type === 'password') return '';
  return String(element.text ?? '').replace(/\s+/g, ' ').trim();
}

/** 元素态首行：`<button> · 立即购买`。 */
export function elementHeadline(element) {
  const tag = String(element?.tag ?? '').trim().toLowerCase();
  if (!tag) return '';
  const snippet = elementText(element);
  const short = snippet.length > ELEMENT_SNIPPET_LIMIT
    ? `${snippet.slice(0, ELEMENT_SNIPPET_LIMIT - 1)}…`
    : snippet;
  return short ? `${tag} · ${short}` : tag;
}

/** 元素态第二行：稳定选择器（没有就退回 id / tag）。 */
export function elementSelector(element) {
  const selector = String(element?.selector ?? '').trim();
  if (selector) return selector;
  const id = String(element?.id ?? '').trim();
  if (id) return `#${id}`;
  return String(element?.tag ?? '').trim().toLowerCase();
}

/** 元素态第三行：来源（域名 + 路径 / 文件路径 / 显式 label）。 */
export function sourceLineOf(source = {}) {
  const url = String(source?.url ?? '').trim();
  if (url) {
    const short = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return short || domainOf(url);
  }
  const path = String(source?.path ?? '').trim();
  if (path) {
    const line = Number(source?.line);
    return Number.isFinite(line) && line > 0 ? `${path}:${Math.trunc(line)}` : path;
  }
  return String(source?.label ?? '').trim();
}

/**
 * 选区态摘要：网页来源带域名、文件来源带行号（§3.9「第 N 行」），
 * 其余直接用选中的文字。
 */
export function summaryOf(text, source = {}) {
  const value = squeeze(text, SUMMARY_LIMIT);
  if (!value) return '';
  const kind = String(source?.kind ?? '').toLowerCase();
  const line = Number(source?.line);
  const prefix = kind === 'web' || kind === 'element'
    ? domainOf(source?.url)
    : kind === 'file' && Number.isFinite(line) && line > 0 ? `第 ${Math.trunc(line)} 行` : '';
  return prefix ? `${prefix} · ${value}` : value;
}

/** 引用正文：元素用可见文本，没有文本时退回 aria-label / 选择器 / 标签名。 */
export function quoteTextOfElement(element) {
  const text = elementText(element);
  if (text) return text.slice(0, QUOTE_RAW_LIMIT);
  const aria = String(element?.ariaLabel ?? '').replace(/\s+/g, ' ').trim();
  if (aria) return aria.slice(0, QUOTE_RAW_LIMIT);
  const selector = elementSelector(element);
  if (selector) return selector;
  return String(element?.tag ?? '').trim().toLowerCase();
}

/* ── DOM ───────────────────────────────────────────────────────── */

function inert() {
  return {
    element: null,
    showSelection() {},
    showElement() {},
    hide() {},
    syncLocation() {},
    destroy() {},
    get isOpen() { return false; },
  };
}

/**
 * 挂载引用浮层。
 * @param {{
 *   stage: Element,
 *   getLocation?: () => object|null,
 *   onQuote?: (detail: { text: string, source: object }) => void,
 * }} options
 * @returns {{
 *   element: HTMLElement,
 *   showSelection: (rectInViewport: object|null, text: string, source?: object) => void,
 *   showElement: (rectInViewport: object|null, element: object, source?: object) => void,
 *   hide: () => void,
 *   syncLocation: () => void,
 *   destroy: () => void,
 *   readonly isOpen: boolean,
 * }}
 */
export function mountQuotePopover(options = {}) {
  const stage = options.stage ?? null;
  const getLocation = typeof options.getLocation === 'function' ? options.getLocation : () => null;
  const onQuote = typeof options.onQuote === 'function' ? options.onQuote : null;
  const doc = stage?.ownerDocument ?? (typeof document === 'undefined' ? null : document);
  const win = doc?.defaultView ?? null;
  if (!stage || !doc || !win || typeof stage.appendChild !== 'function') return inert();

  const root = doc.createElement('div');
  root.className = 'browser-quote';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '引用');
  root.hidden = true;

  // 选区态：只有「引用文本」四个字的小胶囊（34px 高）
  const selectionRow = doc.createElement('div');
  selectionRow.className = 'browser-quote-selection';
  const selectionAction = doc.createElement('button');
  selectionAction.type = 'button';
  selectionAction.className = 'browser-quote-action';
  selectionAction.textContent = '引用文本';
  selectionAction.setAttribute('aria-label', '引用文本');
  selectionRow.append(selectionAction);

  // 元素态：三行信息 + 主次按钮
  const elementRow = doc.createElement('div');
  elementRow.className = 'browser-quote-element';
  const headline = doc.createElement('p');
  headline.className = 'browser-quote-headline';
  const selectorLine = doc.createElement('p');
  selectorLine.className = 'browser-quote-selector';
  const sourceLine = doc.createElement('p');
  sourceLine.className = 'browser-quote-source';
  const actions = doc.createElement('div');
  actions.className = 'browser-quote-actions';
  const cancelAction = doc.createElement('button');
  cancelAction.type = 'button';
  cancelAction.className = 'browser-quote-cancel';
  cancelAction.textContent = '取消';
  const elementAction = doc.createElement('button');
  elementAction.type = 'button';
  elementAction.className = 'browser-quote-action';
  elementAction.textContent = '引用到对话';
  actions.append(cancelAction, elementAction);
  elementRow.append(headline, selectorLine, sourceLine, actions);

  root.append(selectionRow, elementRow);
  stage.append(root);

  let open = false;
  let payload = null;
  let anchorRect = null;
  let locationKey = '';

  function locationKeyOf() {
    try {
      return JSON.stringify(getLocation() ?? null);
    } catch {
      return '';
    }
  }

  function stageBounds() {
    const rect = stage.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  /** 拿不到锚点时退到面板中心，宁可在中间显示也不要抛错。 */
  function centerAnchor(bounds) {
    return {
      left: bounds.left + bounds.width / 2,
      top: bounds.top + bounds.height / 2,
      width: 0,
      height: 0,
    };
  }

  function place() {
    const bounds = stageBounds();
    const anchor = anchorRect ?? centerAnchor(bounds);
    const size = { width: root.offsetWidth, height: root.offsetHeight };
    // 选区胶囊贴着选区上沿，鼠标往上一滑就能点到；元素态留 6px。
    const gap = root.classList.contains('is-element') ? 6 : 2;
    const { left, top, placement } = placePopover(anchor, size, bounds, gap);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.classList.toggle('is-above', placement === 'top');
    root.classList.toggle('is-below', placement === 'bottom');
  }

  function hide() {
    if (!open && root.hidden) return;
    open = false;
    payload = null;
    anchorRect = null;
    locationKey = '';
    root.classList.remove('is-open');
    root.hidden = true;
  }

  /** 位置变化（导航 / 切到别的文件）→ 立即隐藏，避免浮层挂在旧内容上。 */
  function syncLocation() {
    if (!open) return;
    if (locationKeyOf() !== locationKey) hide();
  }

  function openWith(mode, anchor, nextPayload) {
    if (!stage.isConnected) {
      hide();
      return;
    }
    payload = nextPayload;
    anchorRect = anchor && typeof anchor === 'object' ? anchor : null;
    locationKey = locationKeyOf();
    root.classList.toggle('is-element', mode === 'element');
    root.classList.remove('is-open');
    // 先可见再量尺寸：隐藏节点 offsetWidth/offsetHeight 是 0，定位会算错。
    root.hidden = false;
    open = true;
    place();
    win.requestAnimationFrame(() => {
      if (!open) return;
      place();
      root.classList.add('is-open');
    });
  }

  function showSelection(rectInViewport, text, source = {}) {
    const value = squeeze(text, QUOTE_RAW_LIMIT);
    if (value.length < MIN_SELECTION) {
      hide();
      return;
    }
    const origin = source && typeof source === 'object' ? source : {};
    selectionAction.title = value.length > 300 ? value.slice(0, 300) : value;
    openWith('selection', rectInViewport, { text: value, source: origin });
  }

  function showElement(rectInViewport, element, source = {}) {
    const tag = String(element?.tag ?? '').trim().toLowerCase();
    if (!tag) {
      hide();
      return;
    }
    const origin = source && typeof source === 'object' ? source : {};
    const head = elementHeadline(element);
    const selector = elementSelector(element);
    const sourceText = sourceLineOf(origin);

    headline.textContent = head;
    headline.title = head;
    selectorLine.textContent = selector;
    selectorLine.title = selector;
    sourceLine.textContent = sourceText;
    sourceLine.hidden = !sourceText;
    elementAction.setAttribute('aria-label', `引用到对话：${head}`);

    openWith('element', rectInViewport, {
      text: quoteTextOfElement(element),
      source: { ...origin, kind: origin.kind || 'element', tag, selector, label: head },
    });
  }

  function forwardQuote(detail) {
    const bridge = win.movaQuotes;
    if (bridge && typeof bridge.add === 'function') {
      try {
        bridge.add(detail);
        return;
      } catch (error) {
        console.error('[quote] movaQuotes.add 失败，改用事件派发', error);
      }
    }
    win.dispatchEvent(new win.CustomEvent(QUOTE_EVENT, { detail }));
  }

  function deliver() {
    if (!payload) return;
    const detail = payload;
    payload = null;
    if (onQuote) {
      try {
        onQuote(detail);
      } catch (error) {
        console.error('[quote] onQuote 回调失败', error);
      }
      return;
    }
    forwardQuote(detail);
  }

  function onActionClick() {
    deliver();
    hide();
  }

  const onKeyDown = event => {
    if (!open) return;
    if (event.key === 'Escape' || event.key === 'Esc') hide();
  };
  // 滚动（含面板内文件滚动）/ resize：位置立刻失效，直接隐藏。
  const onScroll = () => hide();
  const onResize = () => hide();
  // side-browser 每次换位置都会派发这个事件（详情见 §4.3），浮层不能挂在旧内容上。
  const onLocationChange = () => hide();
  const onPointerDown = event => {
    if (!open) return;
    if (!root.contains(event.target)) hide();
  };
  // 按浮层时不要清掉文档选区：同一段可以连点几次。
  const keepSelection = event => event.preventDefault();

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  win.addEventListener('scroll', onScroll, true);
  win.addEventListener('resize', onResize);
  win.addEventListener('mova:location-change', onLocationChange);
  root.addEventListener('mousedown', keepSelection);
  selectionAction.addEventListener('click', onActionClick);
  elementAction.addEventListener('click', onActionClick);
  cancelAction.addEventListener('click', hide);

  return {
    element: root,
    showSelection,
    showElement,
    hide,
    syncLocation,
    destroy() {
      hide();
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      win.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('mova:location-change', onLocationChange);
      root.removeEventListener('mousedown', keepSelection);
      selectionAction.removeEventListener('click', onActionClick);
      elementAction.removeEventListener('click', onActionClick);
      cancelAction.removeEventListener('click', hide);
      root.remove();
    },
    get isOpen() {
      return open;
    },
  };
}
