/* 聊天区选区引用：来源识别、文本规范化、引用行格式化、解析与浮层交互。

   纯函数（normalizeQuote / formatQuoteLine / renderQuotes / mergeUserText /
   parseUserText）不碰 DOM，tests/quote.test.mjs 在 Node 里直接 import。
   选区浮层（bindChatQuoteSource）才用 DOM，且延迟到调用时才取 document。 */

/** 单段引用正文上限（§3.12）。 */
export const QUOTE_TEXT_LIMIT = 1000;
/** 单条消息最多引用几段（chip 上限与解析行数上限共用）。 */
export const QUOTE_LIMIT = 5;
/** 引用行里来源标签的长度上限，保证 `[引用 · 标签]` 能被解析回去。 */
const QUOTE_LABEL_LIMIT = 40;
/** 用户消息（含引用行）的字符安全预算。 */
export const USER_TEXT_BUDGET = 60_000;
/** 选区至少 2 个字符才显示浮层。 */
export const QUOTE_MIN_SELECTION = 2;
/** 选区变化去抖。 */
export const QUOTE_SELECTION_DEBOUNCE = 120;

const QUOTE_LINE_RE = /^\[引用 · ([^\]]{1,40})\] ?(.+)$/;
const TRUNCATED_RE = /……（已截断，原 \d+ 字）$/;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 空白压缩：引用始终是单行，多行选区也会被压成一行。 */
export function normalizeQuoteText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 超长正文截断到 QUOTE_TEXT_LIMIT，并附上「已截断」说明；重复截断保持不变。 */
export function truncateQuoteText(value, limit = QUOTE_TEXT_LIMIT) {
  const text = normalizeQuoteText(value);
  if (text.length <= limit || TRUNCATED_RE.test(text)) return text;
  return `${text.slice(0, limit)}……（已截断，原 ${text.length} 字）`;
}

function clampLabel(value) {
  const label = normalizeQuoteText(value);
  if (!label) return '助手回复';
  return label.length <= QUOTE_LABEL_LIMIT ? label : `${label.slice(0, QUOTE_LABEL_LIMIT - 1)}…`;
}

function domainOf(url) {
  const raw = normalizeQuoteText(url);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./i, '');
  }
}

/** 外部来源的 kind 可能乱写/缺失：一律收敛到四种之一，绝不抛错。 */
export function normalizeQuoteKind(kind) {
  const value = normalizeQuoteText(kind).toLowerCase();
  if (['file', 'path', 'code', 'line'].includes(value)) return 'file';
  if (['web', 'url', 'page', 'site', 'browser'].includes(value)) return 'web';
  if (['element', 'node', 'selector', 'dom'].includes(value)) return 'element';
  return 'chat';
}

function elementLabel(source, text) {
  const tag = normalizeQuoteText(source.tag);
  const snippet = normalizeQuoteText(text).slice(0, 16);
  const head = tag || '元素';
  return snippet ? `${head} · ${snippet}` : head;
}

/** 来源标签：显式 label 优先，缺失时按 kind 生成（聊天=助手回复、文件=path、网页=域名、元素=tag+文本）。 */
export function quoteSourceLabel(source = {}, text = '') {  const explicit = normalizeQuoteText(source?.label);
  if (explicit) return explicit;
  const kind = normalizeQuoteKind(source?.kind);
  if (kind === 'file') {
    const path = normalizeQuoteText(source?.path);
    if (!path) return '文件';
    const line = Number(source?.line);
    return `文件 ${path}${Number.isFinite(line) && line > 0 ? `:${Math.trunc(line)}` : ''}`;
  }
  if (kind === 'web') {
    const domain = domainOf(source?.url) || normalizeQuoteText(source?.url);
    return domain ? `网页 ${domain}` : '网页';
  }
  if (kind === 'element') return elementLabel(source ?? {}, text);
  return '助手回复';
}

/**
 * A file quote's label is `文件 src/app.tsx:12`; turn it back into a linkable
 * reference so the citation in a sent message opens the right panel.
 */
export function fileRefOfLabel(label) {
  const match = /^文件\s+(.+?)(?::(\d{1,7}))?$/.exec(String(label ?? '').trim());
  if (!match) return null;
  const path = match[1].trim();
  if (!path) return null;
  return { path, line: Number(match[2]) || 0 };
}

/**
 * 规范化外部引用：兼容缺字段（只有 text 也能用），返回 `{ text, source }` 或 null。
 * source: { kind, label, rootId?, path?, url?, line?, tag?, selector? }
 */
export function normalizeQuote(detail) {
  const raw = detail && typeof detail === 'object' ? detail : {};
  const text = truncateQuoteText(raw.text);
  if (!text) return null;
  const origin = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const kind = normalizeQuoteKind(origin.kind);
  const source = { kind };
  source.label = clampLabel(quoteSourceLabel({ ...origin, kind }, text));
  const rootId = normalizeQuoteText(origin.rootId);
  if (rootId) source.rootId = rootId;
  const path = normalizeQuoteText(origin.path);
  if (path) source.path = path;
  const url = normalizeQuoteText(origin.url);
  if (url) source.url = url;
  const line = Number(origin.line);
  if (Number.isFinite(line) && line > 0) source.line = Math.trunc(line);
  const tag = normalizeQuoteText(origin.tag);
  if (tag) source.tag = tag;
  const selector = normalizeQuoteText(origin.selector);
  if (selector) source.selector = selector.slice(0, 200);
  return { text, source };
}

/** 去重键：text + source.kind + label 相同即视为同一段引用。 */
export function quoteKey(quote) {
  const source = quote?.source ?? {};
  return [normalizeQuoteText(quote?.text), normalizeQuoteKind(source.kind), normalizeQuoteText(source.label)].join('\u0000');
}

/** 单条引用行：`[引用 · 来源] 内容`（纯文本，不用 Markdown 引用块）。 */
export function formatQuoteLine(quote) {
  const text = truncateQuoteText(quote?.text);
  if (!text) return '';
  const label = clampLabel(quoteSourceLabel(quote?.source ?? {}, text));
  return `[引用 · ${label}] ${text}`;
}

/** 多条引用各占一行，行间不空行。 */
export function renderQuotes(quotes) {
  return (Array.isArray(quotes) ? quotes : [])
    .slice(0, QUOTE_LIMIT)
    .map(formatQuoteLine)
    .filter(Boolean)
    .join('\n');
}

/**
 * 发送用的合并正文：引用行 + 空行 + 用户原文。
 * 已合并过的文本（重试路径）原样返回，不重复插入。
 */
export function mergeUserText(quotes, content = '') {
  const text = String(content ?? '');
  const rendered = renderQuotes(quotes);
  if (!rendered) return text;
  if (text.startsWith(rendered)) return text;
  return text.trim() ? `${rendered}\n\n${text}` : rendered;
}

/** 合并后的正文是否还在 60,000 字符预算内。 */
export function withinUserBudget(text) {
  return String(text ?? '').length <= USER_TEXT_BUDGET;
}

/**
 * 解析用户消息开头的连续引用行（最多 QUOTE_LIMIT 行）。
 * 返回 { quotes: [{ label, text }], body, matched }；不匹配时 body 是原文。
 */
export function parseUserText(value) {
  const text = String(value ?? '');
  const lines = text.split('\n');
  const quotes = [];
  let index = 0;
  while (index < lines.length && quotes.length < QUOTE_LIMIT) {
    const match = QUOTE_LINE_RE.exec(lines[index].trimEnd());
    if (!match) break;
    quotes.push({ label: match[1], text: match[2].trim() });
    index += 1;
  }
  if (!quotes.length) return { quotes, body: text, matched: false };
  while (index < lines.length && !lines[index].trim()) index += 1;
  return { quotes, body: lines.slice(index).join('\n'), matched: true };
}

/* ── 浮层（DOM） ─────────────────────────────────────────────── */

const POPOVER_MARGIN = 10;
const POPOVER_GAP = 2;

/** 引用图标（内联 SVG，避免依赖图标字体是否加载）。 */
export function quoteGlyph(className = 'quote-glyph', doc = document) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M3.4 3.9h3.3v4.6c0 1.9-1 3.3-2.9 4.1l-.7-1.2c1.1-.5 1.7-1.1 1.8-2H3.4V3.9Zm5.9 0h3.3v4.6c0 1.9-1 3.3-2.9 4.1l-.7-1.2c1.1-.5 1.7-1.1 1.8-2H9.3V3.9Z');
  svg.append(path);
  return svg;
}

/** 浮层定位（§4.6）：默认在锚点上方 6px，不够翻下方，左右夹在视口 10px 内。 */
export function placeQuotePopover(popover, anchorRect, viewport) {
  if (!popover || !anchorRect) return;
  const width = viewport?.innerWidth ?? popover.ownerDocument?.defaultView?.innerWidth ?? 0;
  const height = viewport?.innerHeight ?? popover.ownerDocument?.defaultView?.innerHeight ?? 0;
  const box = popover.getBoundingClientRect();
  const popoverWidth = box.width || Math.min(300, Math.max(0, width - 2 * POPOVER_MARGIN));
  const popoverHeight = box.height || 34;
  let top = anchorRect.top - POPOVER_GAP - popoverHeight;
  if (top < POPOVER_MARGIN) top = anchorRect.bottom + POPOVER_GAP;
  if (top + popoverHeight > height - POPOVER_MARGIN) {
    top = Math.max(POPOVER_MARGIN, height - POPOVER_MARGIN - popoverHeight);
  }
  const maxLeft = Math.max(POPOVER_MARGIN, width - POPOVER_MARGIN - popoverWidth);
  const left = Math.min(Math.max(POPOVER_MARGIN, anchorRect.left), maxLeft);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

const IGNORED_SELECTOR = 'input, textarea, select, [contenteditable="true"], button, [data-quote-ignore]';

/** 读取对话区里的有效选区；不满足条件返回 null。 */
function readChatSelection(doc, scope) {
  if (!scope) return null;
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = normalizeQuoteText(selection.toString());
  if (text.length < QUOTE_MIN_SELECTION) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element || !scope.contains(element)) return null;
  if (element.closest(IGNORED_SELECTOR)) return null;
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 || rect.height > 0);
  // Anchor on the first line: the popover sits above the selection, so moving the
  // mouse straight up from the text lands on the button.
  const rect = rects[0] ?? range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return { text, rect };
}

function createPopover(doc) {
  const popover = doc.createElement('button');
  popover.type = 'button';
  popover.id = 'quote-popover';
  popover.className = 'quote-popover';
  popover.setAttribute('aria-label', '引用文本');
  popover.textContent = '引用文本';
  popover.hidden = true;
  doc.body.append(popover);
  return { popover };
}

/**
 * 聊天区选区采集：mouseup + selectionchange 去抖 120ms，浮层固定在选区末行上方。
 * 滚动 / resize / 点外部 / Esc 关闭；按钮可 Tab 到达且不抢焦点。
 * @param {{ isEnabled?: () => boolean, onQuote?: (detail: { text: string, source: object }) => void,
 *   container?: Element | (() => Element | null), document?: Document }} options
 */
export function bindChatQuoteSource(options = {}) {
  const doc = options.document ?? (typeof document === 'undefined' ? null : document);
  if (!doc) return { element: null, hide() {}, destroy() {} };
  const win = doc.defaultView ?? (typeof window === 'undefined' ? null : window);
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true;
  const onQuote = typeof options.onQuote === 'function' ? options.onQuote : () => {};
  const scopeOf = () => {
    if (typeof options.container === 'function') return options.container();
    if (options.container) return options.container;
    return doc.querySelector('#conversation');
  };
  const { popover } = createPopover(doc);
  let open = false;
  let timer = 0;
  let payload = null;

  function hide() {
    if (!open) return;
    open = false;
    payload = null;
    popover.classList.remove('is-open');
    popover.hidden = true;
  }

  function show(next) {
    payload = next;
    popover.hidden = false;
    open = true;
    placeQuotePopover(popover, next.rect, win);
    win?.requestAnimationFrame(() => { if (open) popover.classList.add('is-open'); });
  }

  function evaluate() {
    if (!isEnabled()) { hide(); return; }
    const next = readChatSelection(doc, scopeOf());
    if (!next) { hide(); return; }
    show(next);
  }

  function queue() {
    clearTimeout(timer);
    timer = setTimeout(evaluate, QUOTE_SELECTION_DEBOUNCE);
  }

  const onMouseUp = event => { if (!popover.contains(event.target)) queue(); };
  const onSelectionChange = () => queue();
  const onScroll = () => hide();
  const onResize = () => hide();
  const onPointerDown = event => { if (!popover.contains(event.target)) hide(); };
  const onKeyDown = event => { if (event.key === 'Escape') hide(); };
  // 按下浮层时不要清掉选区：引用同一段可以连点几次。
  const keepSelection = event => event.preventDefault();
  const onAction = () => {
    if (!payload) return;
    onQuote({ text: payload.text, source: { kind: 'chat', label: '助手回复' } });
    hide();
  };

  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('selectionchange', onSelectionChange);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  win?.addEventListener('scroll', onScroll, true);
  win?.addEventListener('resize', onResize);
  popover.addEventListener('mousedown', keepSelection);
  popover.addEventListener('click', onAction);

  return {
    element: popover,
    hide,
    destroy() {
      clearTimeout(timer);
      doc.removeEventListener('mouseup', onMouseUp, true);
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      win?.removeEventListener('scroll', onScroll, true);
      win?.removeEventListener('resize', onResize);
      popover.remove();
    },
  };
}
