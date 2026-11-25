import React, { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { expandFileRefs, isFilePath, parseFileRefHref, splitFileAnchor, withFileAnchor } from './file-reference.js';
import { decideTarget, openFileExternally, openUrlExternally } from './open-target.mjs';

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

/** 站内相对路径（`src/app.js`、`./docs/x.md`）——绝对路径与 `..` 一律拒绝。 */
function isRelativeFileLink(href) {
  return typeof href === 'string' && href.length > 0 &&
    !/^(?:[a-z]+:|\/|\\)/i.test(href) &&
    !href.split(/[\\/]/).includes('..') &&
    !/[\u0000-\u001f]/.test(href);
}

function openInPanel(detail) {
  globalThis.window?.dispatchEvent(new CustomEvent('mova:open-reference', { detail }));
}

/** 文件引用按钮的悬停提示：把「左键 / Ctrl+左键」一次说清，别让用户去试。 */
const FILE_TITLE = '在右侧查看（Ctrl+点击用系统默认程序打开）';

/**
 * 点了文件引用：左键进右侧面板，Ctrl / ⌘ 交给系统默认程序。
 * 用修饰键判定与外部开放在 open-target.mjs 里各只有一处实现（同一份行为，四处调用点共用）。
 */
function activateFile(event, pathWithLine) {
  event.preventDefault();
  if (decideTarget(event) === 'external') {
    void openFileExternally({ raw: pathWithLine });
    return;
  }
  openInPanel({ kind: 'file', path: pathWithLine });
}

/**
 * 默认组件表：聊天区与右侧面板共用同一份排版。
 * `resolveLink` / `resolveImage` / `onOpenLink` 是**可选**注入，用于右侧面板
 * 把相对链接解析到当前 root、把根内图片换成 blob URL；不传时行为与以前一致。
 */
function buildComponents({ resolveLink, resolveImage, onOpenLink } = {}) {
  return {
    pre: CodeBlock,
    /**
     * Inline code that is unmistakably a project path (`src/app.tsx:12`) becomes
     * a link to the right panel. Commands and prose never match.
     */
    code({ className, children }) {
      const text = String(children ?? '');
      if (!className && isFilePath(text)) {
        const { path, line } = splitFileAnchor(text);
        return h('button', {
          type: 'button',
          className: 'markdown-file-ref',
          title: FILE_TITLE,
          onClick(event) {
            activateFile(event, withFileAnchor(path, line));
          },
        }, children);
      }
      return h('code', { className }, children);
    },
    a({ href, children, title }) {
      const fileRef = parseFileRefHref(href);
      if (fileRef) {
        return h('a', {
          href: '#',
          title: title || FILE_TITLE,
          className: 'markdown-file-ref',
          onClick(event) {
            activateFile(event, withFileAnchor(fileRef.path, fileRef.line));
          },
        }, children);
      }
      if (typeof href === 'string' && href && resolveLink) {
        const resolved = resolveLink(href);
        if (resolved) {
          return h('a', { href: resolved.href || '#', title, onClick: resolved.onClick }, children);
        }
      }
      const safe = safeMarkdownUrl(href);
      if (safe && /^https?:/i.test(safe)) {
        // 桌面版：点击进右侧面板；Ctrl/⌘+点击交给系统默认浏览器。浏览器预览保留原生 target=_blank。
        return h('a', {
          href: safe,
          title: title || '在右侧打开（Ctrl+点击用默认浏览器打开）',
          target: '_blank',
          rel: 'noopener noreferrer',
          onClick(event) {
            if (!globalThis.window?.movaDesktop) return;
            event.preventDefault();
            if (decideTarget(event) === 'external') { void openUrlExternally(safe); return; }
            openInPanel({ kind: 'url', url: safe });
          },
        }, children);
      }
      if (safe) return h('a', { href: safe, title, target: '_blank', rel: 'noopener noreferrer' }, children);
      if (isRelativeFileLink(href)) {
        return h('a', { href: '#', title: title || FILE_TITLE, onClick: event => {
          event.preventDefault();
          if (decideTarget(event) === 'external') { void openFileExternally({ raw: href }); return; }
          if (onOpenLink) { onOpenLink(href); return; }
          openInPanel({ kind: 'file', path: href });
        } }, children);
      }
      return h('span', { className: 'markdown-unsafe-link' }, children);
    },
    // Remote images can leak conversation contents/IPs. Render their alt text only,
    // unless the host resolved the source to an allowed local file.
    img({ src, alt }) {
      const resolved = resolveImage && typeof src === 'string' && src ? resolveImage(src, alt || '') : null;
      if (resolved?.src) return h('img', { src: resolved.src, alt: resolved.alt ?? alt ?? '', loading: 'lazy' });
      return h('span', { className: 'markdown-image-alt' }, alt || '[图片]');
    },
    table({ children }) {
      return h('div', { className: 'markdown-table-scroll', tabIndex: 0, role: 'region', 'aria-label': '表格' }, h('table', null, children));
    },
  };
}

const components = buildComponents();

/**
 * CommonMark accepts an unfinished fence at EOF, which is useful during streaming.
 * @param {{
 *   text: string,
 *   className?: string,
 *   components?: Record<string, any>,
 *   resolveLink?: (href: string) => ({ href?: string, onClick?: (event: any) => void } | null),
 *   resolveImage?: (src: string, alt: string) => ({ src: string, alt?: string } | null),
 *   onOpenLink?: (href: string) => void,
 * }} props
 */
function MarkdownRenderer({ text, className = '', components: overrides, resolveLink, resolveImage, onOpenLink }) {
  const merged = (resolveLink || resolveImage || onOpenLink || overrides)
    ? { ...buildComponents({ resolveLink, resolveImage, onOpenLink }), ...(overrides || {}) }
    : components;
  return h('div', { className: `mova-markdown ${className}`.trim() },
    h(ReactMarkdown, { remarkPlugins: [remarkGfm], components: merged, skipHtml: true,
      urlTransform: value => safeMarkdownUrl(value)
        ?? (typeof value === 'string' && value.startsWith('mova-file:') ? value : (/^[^:/\\][^:]*$/.test(value) ? value : '')),
      }, expandFileRefs(String(text ?? ''))));
}

export const MarkdownContent = memo(MarkdownRenderer);
