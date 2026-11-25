import React, { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const h = React.createElement;

/** Deliberately disallow relative, fragment, protocol-relative and non-web URLs. */
export function safeMarkdownUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function CodeBlock({ children }) {
  const element = React.Children.toArray(children).find(React.isValidElement);
  const code = element ? String(element.props.children ?? '') : '';
  const language = element?.props.className?.match(/language-([^\s]+)/)?.[1] || 'text';
  const [state, setState] = useState('idle');
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setState('idle'); }, [code]);
  async function copy() {
    clearTimeout(timer.current);
    try {
      const desktop = globalThis.window?.movaDesktop?.clipboard;
      if (desktop) {
        if (await desktop.writeText(code) !== true) throw new Error('Clipboard unavailable');
      } else {
        if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(code);
      }
      setState('copied');
    } catch {
      setState('error');
    }
    timer.current = setTimeout(() => setState('idle'), 2000);
  }
  return h('div', { className: 'markdown-code-block' },
    h('div', { className: 'markdown-code-header' },
      h('span', { className: 'markdown-code-language' }, language),
      h('button', { type: 'button', onClick: copy, 'aria-label': '复制代码' }, '复制'),
      h('span', { className: 'markdown-copy-status', role: 'status' },
        state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请手动选择代码' : '')),
    h('pre', null, children));
}

const components = {
  pre: CodeBlock,
  a({ href, children, title }) {
    const safe = safeMarkdownUrl(href);
    return safe ? h('a', { href: safe, title, target: '_blank', rel: 'noopener noreferrer' }, children)
      : h('span', { className: 'markdown-unsafe-link' }, children);
  },
  // Remote images can leak conversation contents/IPs. Render their alt text only.
  img({ alt }) { return h('span', { className: 'markdown-image-alt' }, alt || '[图片]'); },
  table({ children }) {
    return h('div', { className: 'markdown-table-scroll', tabIndex: 0, role: 'region', 'aria-label': '表格' }, h('table', null, children));
  },
};

/**
 * CommonMark accepts an unfinished fence at EOF, which is useful during streaming.
 * @param {{ text: string, className?: string }} props
 */
function MarkdownRenderer({ text, className = '' }) {
  return h('div', { className: `mova-markdown ${className}`.trim() },
    h(ReactMarkdown, { remarkPlugins: [remarkGfm], components, skipHtml: true,
      urlTransform: value => safeMarkdownUrl(value) ?? '' }, String(text ?? '')));
}

export const MarkdownContent = memo(MarkdownRenderer);
