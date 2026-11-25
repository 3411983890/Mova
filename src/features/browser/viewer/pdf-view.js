// PDF 渲染：沿用旧面板的 blob iframe，sandbox 保持（不执行脚本）。
import { formatSize } from '../location.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createPdfView({ container }) {
  let objectUrl = null;

  const root = element('div', 'pdf-view');
  const iframe = document.createElement('iframe');
  iframe.className = 'pdf-view-frame';
  iframe.title = 'PDF 预览';
  // Chromium's built-in PDF viewer refuses blob URLs created on the custom
  // mova:// origin, so the PDF is handed over as a data URL instead. The frame
  // stays unsandboxed for the same reason (see CSP frame-src data:).
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  root.append(iframe);
  container.append(root);

  function release() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  return {
    element: root,
    render(input = {}) {
      release();
      iframe.removeAttribute('src');
      if (!input.rootId || !input.path) return;
      const encoded = String(input.path).split('/').map(encodeURIComponent).join('/');
      // Streamed by the main process (mova-pdf:), so large PDFs never turn into
      // a multi-megabyte data URL. The fragment hides Chromium's own toolbar and
      // fits the page width; pages stack vertically and scroll.
      iframe.src = `mova-pdf://pdf/${encodeURIComponent(input.rootId)}/${encoded}#toolbar=0&navpanes=0&view=FitH`;
      iframe.title = input.name ? `PDF 预览：${input.name}（${formatSize(input.bytes ?? 0)}）` : 'PDF 预览';
    },
    dispose() {
      release();
      iframe.removeAttribute('src');
      root.remove();
    },
  };
}
