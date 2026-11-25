/* 对话页右上角「⋯」→ Token 用量弹窗。
 *
 * 动效沿用输入栏用量环（composer 里的 MorphingMenuShell）：触发器原位形变成卡片，
 * 触发器同时淡出；关闭时卡片收回成触发器，触发器再淡入。尺寸、位置与圆角一起过渡，
 * 内容延迟 140ms 淡入并轻微模糊收边，避免文字在缩放时抖动。
 */

const PANEL_WIDTH = 243;
const VIEWPORT_EDGE = 12;
const MORPH_MS = 340;
const FADE_MS = 260;

export function bindChatUsage({ onOpen, enabled } = {}) {
  const host = document.querySelector('.main-panel');
  const trigger = document.getElementById('chat-more');
  const panel = document.getElementById('chat-usage');
  if (!host || !trigger || !panel) return null;

  const inner = panel.firstElementChild;
  const closeButton = panel.querySelector('.chat-usage-close');
  const header = document.getElementById('chat-header');
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

  /** 卡片与「⋯」同高、贴住其右缘；越界时收进主面板。 */
  function geometry() {
    const hostRect = host.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const width = Math.max(216, Math.min(PANEL_WIDTH, hostRect.width - VIEWPORT_EDGE * 2));
    const top = triggerRect.top - hostRect.top;
    const wantedRight = triggerRect.right - hostRect.left;
    const right = Math.min(
      hostRect.width - VIEWPORT_EDGE,
      Math.max(VIEWPORT_EDGE + width, wantedRight),
    );
    return {
      width,
      top,
      left: right - width,
      maxHeight: Math.max(180, hostRect.height - top - VIEWPORT_EDGE),
      triggerRect,
      hostRect,
    };
  }

  /* ── 真实用量渲染 ──────────────────────────────────────────────────
     `usage` 全部来自提供商返回的 usage，没有任何估算值；
     拿不到的字段（例如未配置价格时的花费）显示为明确的“未…”，不填假数。 */
  let usage = null;

  const EMPTY = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, calls: 0, elapsedMs: 0 });
  const num = value => (Number.isFinite(value) && value > 0 ? value : 0);
  const compact = value => {
    const n = num(value);
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  };
  const percent = (part, whole) => (whole > 0 ? `${Math.round(part / whole * 100)}%` : '—');
  const elapsed = ms => {
    const total = Math.round(num(ms) / 1000);
    if (!total) return '—';
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${total % 60}s`;
  };
  const setText = (id, value) => {
    const element = panel.querySelector(`#${id}`);
    if (element) element.textContent = value;
  };

  function renderUsage() {
    const data = { ...EMPTY, ...(usage ?? {}) };
    const total = num(data.totalTokens) || num(data.input) + num(data.output);
    const cache = num(data.cacheRead) + num(data.cacheWrite);
    const reported = total > 0 || cache > 0;

    setText('usage-total', compact(total));
    setText('usage-total-sub', reported ? `共 ${num(data.calls)} 次模型调用` : '还没有真实用量');
    setText('usage-cache-rate', percent(num(data.cacheRead), num(data.input) + num(data.cacheRead)));
    setText('usage-cache-sub', cache > 0 ? `读取 ${compact(data.cacheRead)} · 写入 ${compact(data.cacheWrite)}` : '未上报缓存');
    setText('usage-breakdown-meta', reported ? `输入 ${compact(data.input)} · 输出 ${compact(data.output)}` : '—');
    setText('usage-in-out', `${compact(data.input)} / ${compact(data.output)}`);
    setText('usage-last-call', data.lastCall ? `${compact(data.lastCall.input)} / ${compact(data.lastCall.output)}` : '—');
    setText('usage-elapsed', elapsed(data.elapsedMs));
    setText('usage-calls', String(num(data.calls)));
    setText('usage-cost', num(data.cost) > 0 ? `¥ ${num(data.cost).toFixed(4)}` : '未配置价格');

    for (const [key, value] of [['input', num(data.input)], ['output', num(data.output)], ['cache', cache]]) {
      const label = panel.querySelector(`[data-usage-value="${key}"]`);
      if (label) label.textContent = value > 0 ? compact(value) : '';
    }
    const parts = [num(data.input), num(data.output), cache];
    const sum = parts.reduce((total, value) => total + value, 0);
    for (const [index, key] of ['input', 'output', 'cache'].entries()) {
      const segment = panel.querySelector(`[data-usage-seg="${key}"]`);
      if (!segment) continue;
      const share = sum > 0 ? parts[index] / sum : 0;
      segment.hidden = share === 0;
      segment.style.flexBasis = `${(share * 100).toFixed(2)}%`;
    }

    const track = panel.querySelector('#usage-track');
    if (track) {
      track.setAttribute('aria-label', `输入 ${compact(data.input)}，输出 ${compact(data.output)}，缓存 ${compact(cache)}`);
    }
  }

  /** 由会话的用量记录驱动；传入全零即显示空态。 */
  function setUsage(next) {
    usage = next ?? null;
    renderUsage();
    if (open && !animating) settle();
  }

  renderUsage();

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
    onOpen?.();
    open = true;
    animating = true;
    triggerIn?.cancel();
    triggerIn = null;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-usage-hidden');
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
      trigger.classList.remove('is-usage-hidden');
      animating = false;
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

    trigger.classList.remove('is-usage-hidden');
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
    // Bot 对话里同一个「⋯」用来打开 Bot / 群聊信息，这里让位。
    if (enabled && !enabled()) return;
    if (open) hide({ focus: true });
    else show();
  });

  closeButton?.addEventListener('click', () => hide({ focus: true }));

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

  if (header) {
    new MutationObserver(() => { if (header.hidden && open) hide(); })
      .observe(header, { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    setUsage,
    close: () => hide(),
    get open() { return open; },
  };
}
