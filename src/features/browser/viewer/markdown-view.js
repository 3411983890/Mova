// Markdown 渲染岛（方案 §3.5）：复用 `MarkdownContent`，通过 props 注入
// `resolveLink` / `resolveImage` / `onOpenLink`，不复制第二份渲染器。
// 面板不是 React，所以只挂一个 createRoot。

import React from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownContent } from '../../chat/markdown-renderer.js';

/**
 * @param {{
 *   container: HTMLElement,
 *   resolveLink?: (href: string) => ({ href?: string, onClick?: (event: any) => void } | null),
 *   resolveImage?: (src: string, alt: string) => ({ src: string, alt?: string } | null),
 *   onOpenLink?: (href: string) => void,
 * }} options
 */
export function createMarkdownView({ container, resolveLink, resolveImage, onOpenLink }) {
  const host = document.createElement('div');
  host.className = 'viewer-doc';
  container.append(host);
  const root = createRoot(host);
  let disposed = false;

  function paint(text) {
    if (disposed) return;
    root.render(React.createElement(MarkdownContent, {
      text: String(text ?? ''),
      className: 'markdown-doc',
      resolveLink,
      resolveImage,
      onOpenLink,
    }));
  }

  return {
    element: host,
    render(text) {
      paint(text);
    },
    dispose() {
      disposed = true;
      // createRoot 的 unmount 必须延后：React 不允许在渲染过程中卸载。
      queueMicrotask(() => {
        try { root.unmount(); } catch { /* 已经卸载 */ }
        host.remove();
      });
    },
  };
}
