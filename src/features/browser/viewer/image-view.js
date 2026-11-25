// 图片渲染（方案 §3.4）：blob URL + object-fit contain，点击切换「适应 / 1:1」。
// SVG 也用 <img>，脚本不会执行。

import { formatSize } from '../location.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createImageView({ container }) {
  let blobUrl = null;

  const root = element('div', 'image-view');
  const scroll = element('div', 'image-view-scroll');
  const image = element('img', 'image-view-image');
  image.alt = '';
  image.decoding = 'async';
  scroll.append(image);
  const foot = element('div', 'image-view-meta');
  root.append(scroll, foot);
  container.append(root);

  scroll.addEventListener('click', () => {
    const actual = root.classList.toggle('is-actual');
    root.title = actual ? '点击恢复为适应窗口' : '点击查看原始大小';
  });

  function release() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }

  return {
    element: root,
    render(input = {}) {
      release();
      image.removeAttribute('src');
      if (!input.base64) {
        foot.textContent = '无法解码这张图片';
        return;
      }
      const bytes = base64ToBytes(input.base64);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: input.mime || 'application/octet-stream' }));
      image.src = blobUrl;
      image.alt = input.name || '图片';
      root.classList.remove('is-actual');
      image.onload = () => {
        foot.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${formatSize(input.bytes ?? bytes.length)}`;
      };
      image.onerror = () => { foot.textContent = '图片解码失败，可能已损坏'; };
      foot.textContent = formatSize(input.bytes ?? bytes.length);
    },
    dispose() {
      release();
      root.remove();
    },
  };
}
