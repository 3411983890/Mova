/* 输入框上方的引用 chip 行：渲染、删除、去重、上限。

   行插在 `.composer-area` 内、`#composer` 之前（动态创建，不改 index.html）。
   数据本身由 app.js 的草稿对象（drafts Map，按 draftKey 分会话）持有，这里只负责 DOM。 */

import {
  QUOTE_LIMIT,
  quoteGlyph,
  quoteKey,
  quoteSourceLabel,
  truncateQuoteText,
} from './quote-source.js';

/** chip `title` 的全文上限（§3.12）。 */
export const QUOTE_TITLE_LIMIT = 300;
/** 关闭 chip 的淡出时长，与 quote.css 的 transition 对齐。 */
const LEAVE_DELAY = 120;
const SUMMARY_TEXT_LIMIT = 28;

/** chip 文案：`助手回复 · 这段文字…`（元素来源的标签已含文本时不重复拼接）。 */
export function quoteSummary(quote) {
  const source = quote?.source ?? {};
  const label = quoteSourceLabel(source, quote?.text);
  const text = truncateQuoteText(quote?.text);
  if (!text) return label;
  if (source.kind === 'element' && label.includes(text.slice(0, 16))) return label;
  const snippet = text.length > SUMMARY_TEXT_LIMIT ? `${text.slice(0, SUMMARY_TEXT_LIMIT)}…` : text;
  return `${label} · ${snippet}`;
}

/** chip 与 `title` 用的全文：来源 + 正文，最多 300 字。 */
export function quoteTitle(quote) {
  const label = quoteSourceLabel(quote?.source ?? {}, quote?.text);
  const text = truncateQuoteText(quote?.text);
  const title = text ? `${label}：${text}` : label;
  return title.length > QUOTE_TITLE_LIMIT ? `${title.slice(0, QUOTE_TITLE_LIMIT - 1)}…` : title;
}

/**
 * 能不能再加一条：去重（text + kind + label）与上限 5。
 * @returns {{ ok: boolean, reason?: 'empty' | 'duplicate' | 'limit' }}
 */
export function canAddQuote(quotes, quote) {
  const list = Array.isArray(quotes) ? quotes.filter(Boolean) : [];
  if (!quote || !truncateQuoteText(quote.text)) return { ok: false, reason: 'empty' };
  const key = quoteKey(quote);
  if (list.some(item => quoteKey(item) === key)) return { ok: false, reason: 'duplicate' };
  if (list.length >= QUOTE_LIMIT) return { ok: false, reason: 'limit' };
  return { ok: true };
}

function chipNode(quote, onRemove) {
  const id = String(quote?.id ?? quoteKey(quote));
  const summary = quoteSummary(quote);
  const chip = document.createElement('div');
  chip.className = 'quote-chip';
  chip.dataset.quoteId = id;
  chip.tabIndex = 0;
  chip.setAttribute('role', 'listitem');
  chip.setAttribute('aria-label', `引用：${summary}`);
  chip.title = quoteTitle(quote);
  const icon = document.createElement('span');
  icon.className = 'quote-chip-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.append(quoteGlyph());
  const label = document.createElement('span');
  label.className = 'quote-chip-label';
  label.textContent = summary;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'quote-chip-close';
  close.setAttribute('aria-label', `移除引用：${summary}`);
  close.title = '移除引用';
  close.textContent = '×';
  close.addEventListener('click', event => { event.stopPropagation(); onRemove(id); });
  chip.addEventListener('keydown', event => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    onRemove(id);
  });
  chip.append(icon, label, close);
  return chip;
}

/**
 * 创建 chip 行并插到 `#composer` 之前。
 * @param {{ host?: Element | null, anchor?: Element | null,
 *   onRemove?: (id: string) => void }} options
 */
export function createQuoteChips({ host, anchor, onRemove } = {}) {
  if (!host) return { element: null, render() {}, destroy() {} };
  const element = document.createElement('div');
  element.id = 'quote-chip-row';
  element.className = 'quote-chip-row';
  element.setAttribute('role', 'list');
  element.setAttribute('aria-label', '引用');
  element.hidden = true;
  // 插在 #composer 之前：approval-host → composer-context → quote-chip-row → #composer。
  if (anchor?.parentElement) anchor.before(element);
  else host.append(element);
  const timers = new Set();

  function remove(id) {
    const chip = [...element.querySelectorAll('.quote-chip')]
      .find(node => node.dataset.quoteId === id);
    chip?.classList.add('is-leaving');
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (typeof onRemove === 'function') onRemove(id);
    }, LEAVE_DELAY);
    timers.add(timer);
  }

  function render(quotes) {
    const list = Array.isArray(quotes) ? quotes.filter(Boolean).slice(0, QUOTE_LIMIT) : [];
    element.replaceChildren(...list.map(quote => chipNode(quote, remove)));
    element.hidden = list.length === 0;
  }

  return {
    element,
    render,
    destroy() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      element.remove();
    },
  };
}
