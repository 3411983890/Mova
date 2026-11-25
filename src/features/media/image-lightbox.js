/**
 * 全屏图片查看器。
 *
 * 用户自己上传的图片（气泡上方的方形缩略图）和 AI 执行过程里的「读取图片」
 * 都通过它放大：一层纯图片弹窗，关闭按钮固定在底部中央。
 *
 * 只挂一个实例，容器直接放进 <body>，这样不会被聊天区的 overflow 裁掉。
 * 点击背景、按 Esc 或点关闭按钮都会关闭；关闭后焦点回到触发它的元素。
 */

const CLOSE_LABEL = '关闭图片';

const CLOSE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">'
  + '<path d="M4.1 4.1 11.9 11.9M11.9 4.1 4.1 11.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />'
  + '</svg>';

let overlay = null;
let returnFocusTo = null;

function onKeydown(event) {
  if (!overlay) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeImageLightbox();
  } else if (event.key === 'Tab') {
    // 弹窗里只有一个可聚焦控件：把 Tab 留在弹窗内，不要跳回背后的聊天记录。
    event.preventDefault();
    overlay.querySelector('.image-lightbox-close')?.focus({ preventScroll: true });
  }
}

/** 关闭当前图片查看器（没有打开时什么也不做）。 */
export function closeImageLightbox() {
  document.removeEventListener('keydown', onKeydown, true);
  document.documentElement.classList.remove('image-lightbox-open');
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  const target = returnFocusTo;
  returnFocusTo = null;
  if (target && target.isConnected) target.focus({ preventScroll: true });
}

/**
 * 打开图片查看器。
 * @param {string} src 图片地址（data URL 或 ./chat-images/<id>）
 * @param {string} [alt] 图片描述，用作 alt 与无障碍标签
 */
export function openImageLightbox(src, alt = '') {
  if (typeof src !== 'string' || !src || typeof document === 'undefined') return;
  closeImageLightbox();
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const label = alt ? `图片预览：${alt}` : '图片预览';
  const layer = document.createElement('div');
  layer.className = 'image-lightbox';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', label);

  const image = document.createElement('img');
  image.className = 'image-lightbox-image';
  image.src = src;
  image.alt = alt || '图片';
  image.decoding = 'async';
  image.draggable = false;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'image-lightbox-close';
  close.setAttribute('aria-label', CLOSE_LABEL);
  close.title = CLOSE_LABEL;
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('click', () => closeImageLightbox());

  layer.append(image, close);
  layer.addEventListener('click', event => {
    // 只有点图片以外的背景才关闭，点图片本身什么都不做。
    if (event.target === layer) closeImageLightbox();
  });

  document.addEventListener('keydown', onKeydown, true);
  document.documentElement.classList.add('image-lightbox-open');
  document.body.append(layer);
  overlay = layer;
  close.focus({ preventScroll: true });
}
