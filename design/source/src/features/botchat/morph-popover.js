/* 「⋯」→ Bot / 群聊信息浮层。
 *
 * 动效与右上角 Token 用量弹窗完全一致：触发器原位形变成卡片，触发器本身淡出；
 * 关闭时卡片收回触发器、触发器再淡入。尺寸、位置、圆角一起过渡，内容延迟 140ms
 * 淡入并轻微模糊收边，避免文字在缩放时抖动。
 */

const MORPH_MS = 340;
const FADE_MS = 260;

export function bindMorphPopover({ trigger, panel, host, width = 336, gap = 8, edge = 12, onOpen, onClose, canOpen }) {
  if (!trigger || !panel || !host) return null;
  const inner = panel.firstElementChild;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let open = false;
  let animating = false;
  let morph = null;
  let content = null;
  let triggerIn = null;
  let frameRequest = 0;

  const box = element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };

  /** 卡片与「⋯」同高、右缘对齐按钮；越界时收进主面板。 */
  function geometry() {
    const hostRect = host.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const panelWidth = Math.max(196, Math.min(width, hostRect.width - edge * 2));
    const top = triggerRect.top - hostRect.top;
    const wantedRight = triggerRect.right - hostRect.left;
    const right = Math.min(hostRect.width - edge, Math.max(edge + panelWidth, wantedRight));
    return {
      width: panelWidth,
      top,
      left: right - panelWidth,
      maxHeight: Math.max(180, hostRect.height - top - edge),
      triggerRect,
      hostRect,
    };
  }

  /** 把卡片摆到最终位置并返回实际高度（含 1px 边框）。 */
  function settle() {
    const area = geometry();
    const gutter = 2;
    panel.style.width = `${area.width}px`;
    panel.style.left = `${area.left}px`;
    panel.style.top = `${area.top}px`;
    panel.style.height = '0px';
    inner.style.width = `${panel.clientWidth}px`;
    inner.style.maxHeight = '';
    inner.style.overflowY = '';
    const natural = inner.offsetHeight;
    const limit = Math.max(120, area.maxHeight - gutter);
    const contentHeight = Math.min(natural, limit);
    panel.style.height = `${contentHeight + gutter}px`;
    inner.style.maxHeight = `${contentHeight}px`;
    inner.style.overflowY = natural > limit ? 'auto' : '';
    return { area, height: contentHeight + gutter };
  }

  function clearInline() {
    for (const property of ['width', 'height', 'left', 'top']) panel.style.removeProperty(property);
    inner.style.removeProperty('width');
    inner.style.removeProperty('max-height');
    inner.style.removeProperty('overflow-y');
  }

  function show() {
    if (open) return;
    if (!trigger.getClientRects().length) return;
    if (canOpen && !canOpen()) return;
    onOpen?.();
    open = true;
    animating = true;
    triggerIn?.cancel();
    triggerIn = null;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-info-hidden');
    trigger.tabIndex = -1;
    panel.hidden = false;

    const { area, height } = settle();
    const start = {
      left: area.triggerRect.left - area.hostRect.left,
      top: area.triggerRect.top - area.hostRect.top,
      width: area.triggerRect.width,
      height: area.triggerRect.height,
    };
    const radius = getComputedStyle(trigger).borderTopLeftRadius || '7px';
    content?.cancel();
    content = null;

    if (!reduced.matches) {
      morph?.cancel();
      const opening = panel.animate([
        {
          left: `${start.left}px`,
          top: `${start.top}px`,
          width: `${start.width}px`,
          height: `${start.height}px`,
          borderRadius: radius,
          opacity: 0.55,
        },
        {
          left: `${area.left}px`,
          top: `${area.top}px`,
          width: `${area.width}px`,
          height: `${height}px`,
          borderRadius: '16px',
          opacity: 1,
        },
      ], { duration: MORPH_MS, easing: 'cubic-bezier(.22, .9, .26, 1)', fill: 'both' });
      morph = opening;

      content = inner.animate([
        { opacity: 0, filter: 'blur(4px)', transform: 'translateY(3px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'none' },
      ], { duration: 200, delay: 140, easing: 'cubic-bezier(.22, .9, .26, 1)', fill: 'both' });

      opening.addEventListener('finish', () => {
        opening.cancel();
        morph = null;
        content?.cancel();
        content = null;
        animating = false;
        settle();
        panel.focus({ preventScroll: true });
      }, { once: true });
      return;
    }

    animating = false;
    panel.focus({ preventScroll: true });
  }

  function hide(options = {}) {
    if (!open) return;
    open = false;
    animating = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.tabIndex = 0;

    const current = box(panel);
    const area = geometry();
    const start = {
      left: current.left - area.hostRect.left,
      top: current.top - area.hostRect.top,
      width: current.width,
      height: current.height,
    };
    const target = {
      left: area.triggerRect.left - area.hostRect.left,
      top: area.triggerRect.top - area.hostRect.top,
      width: area.triggerRect.width,
      height: area.triggerRect.height,
    };
    const radius = getComputedStyle(trigger).borderTopLeftRadius || '7px';

    if (reduced.matches) {
      morph?.cancel();
      morph = null;
      content?.cancel();
      content = null;
      panel.hidden = true;
      clearInline();
      trigger.classList.remove('is-info-hidden');
      animating = false;
      onClose?.();
      if (options.focus) trigger.focus({ preventScroll: true });
      return;
    }

    morph?.cancel();
    content?.cancel();
    const closing = panel.animate([
      {
        left: `${start.left}px`,
        top: `${start.top}px`,
        width: `${start.width}px`,
        height: `${start.height}px`,
        borderRadius: '16px',
        opacity: 1,
      },
      {
        left: `${target.left}px`,
        top: `${target.top}px`,
        width: `${target.width}px`,
        height: `${target.height}px`,
        borderRadius: radius,
        opacity: 0.55,
      },
    ], { duration: FADE_MS, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'both' });
    morph = closing;
    content = inner.animate([
      { opacity: 1, filter: 'blur(0px)' },
      { opacity: 0, filter: 'blur(3px)' },
    ], { duration: 130, easing: 'ease-out', fill: 'both' });

    trigger.classList.remove('is-info-hidden');
    triggerIn?.cancel();
    triggerIn = trigger.animate([
      { opacity: 0, transform: 'scale(.94)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 160, delay: 110, easing: 'cubic-bezier(.22, .9, .26, 1)', fill: 'both' });

    closing.addEventListener('finish', () => {
      closing.cancel();
      morph = null;
      content?.cancel();
      content = null;
      triggerIn?.cancel();
      triggerIn = null;
      panel.hidden = true;
      clearInline();
      trigger.style.removeProperty('opacity');
      trigger.style.removeProperty('transform');
      animating = false;
      onClose?.();
      if (options.focus) trigger.focus({ preventScroll: true });
    }, { once: true });
  }

  function reposition() {
    if (!open || animating) return;
    settle();
  }

  function schedule() {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (open && !animating) reposition();
    });
  }

  trigger.addEventListener('click', () => {
    if (canOpen && !canOpen()) return;
    if (open) hide({ focus: true });
    else show();
  });

  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      hide({ focus: true });
    }
  });

  document.addEventListener('pointerdown', event => {
    if (!open) return;
    if (panel.contains(event.target) || trigger.contains(event.target)) return;
    hide();
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !open) return;
    hide({ focus: true });
  });

  window.addEventListener('resize', schedule);
  if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(host);

  const header = document.getElementById('chat-header');
  if (header) {
    new MutationObserver(() => { if (header.hidden && open) hide(); })
      .observe(header, { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    show,
    hide,
    resize: () => { if (open && !animating) settle(); },
    close: () => hide(),
    get open() { return open; },
  };
}
