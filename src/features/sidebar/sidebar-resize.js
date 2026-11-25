// Motion adapted from LeiBox Elastic Panel Resize. See THIRD_PARTY_NOTICES.md.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function bindSidebarResize(frame, sidebar, handle, options = {}) {
  // Pulling the divider far enough past the left limit collapses the sidebar.
  const collapseOvershoot = 24;
  // 视图可自定义注入的 CSS 变量，设置页复用同一套拖拽逻辑。
  const widthVariable = options.widthVariable ?? '--split-width';
  const defaultVariable = options.defaultVariable ?? '--sidebar-default';
  const widthLabel = options.widthLabel ?? '侧栏宽度';
  const ink = handle.querySelector('.sidebar-divider-ink');
  const outline = handle.querySelector('.sidebar-divider-outline');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = frame.clientWidth;
  let position = sidebar.getBoundingClientRect().width;
  let target = position;
  let preferredWidth = null;
  let drag = null;
  let frameId = 0;
  let lastTime = 0;
  let hovered = false;
  let focused = false;
  let reveal = 0;
  const edge = { value: position, velocity: 0 };
  const bend = { value: 0, velocity: 0 };
  const offset = { value: 0, velocity: 0 };

  const bounds = () => ({ min: 176, max: Math.max(176, Math.min(520, width - 360, width * 0.54)) });
  function legal(value) {
    const { min, max } = bounds();
    return clamp(value, min, max);
  }

  function defaultWidth() {
    const value = getComputedStyle(frame).getPropertyValue(defaultVariable).trim();
    // Resolve the CSS default through the sidebar itself, including its breakpoint.
    const custom = frame.style.getPropertyValue(widthVariable);
    if (value.endsWith('px') && Number.isFinite(Number.parseFloat(value))) return Number.parseFloat(value);
    frame.style.removeProperty(widthVariable);
    const base = sidebar.getBoundingClientRect().width;
    if (custom) frame.style.setProperty(widthVariable, custom);
    return base;
  }

  function draw(pull = 0, speed = 0) {
    frame.style.setProperty(widthVariable, `${position}px`);
    const x = 20 + offset.value;
    const length = 60 + 26 * Math.abs(speed) + 20 * pull;
    const d = `M${x} ${56 - length / 2} Q${x + bend.value * 2} 56 ${x} ${56 + length / 2}`;
    ink.setAttribute('d', d);
    outline.setAttribute('d', d);
    ink.style.strokeWidth = String(3 - Math.max(Math.abs(speed), pull));
    handle.style.setProperty('--grip-opacity', reveal.toFixed(3));
  }

  function updateAccessibility() {
    const { min, max } = bounds();
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuenow', String(Math.round(target)));
    handle.setAttribute('aria-valuetext', `${widthLabel} ${Math.round(target)} 像素`);
  }

  function spring(state, goal, stiffness, damping, dt) {
    state.velocity += ((goal - state.value) * stiffness - state.velocity * damping) * dt;
    state.value += state.velocity * dt;
  }

  function tick(now) {
    frameId = 0;
    const dt = Math.min((now - lastTime) / 1000 || 1 / 60, 1 / 30);
    lastTime = now;
    const excess = drag ? drag.raw - target : 0;
    const pull = clamp(Math.abs(excess) / 80, 0, 1);
    const speed = drag && now - drag.time < 70 ? clamp(drag.speed / 500, -1, 1) : 0;
    const bendGoal = speed * 4.5 * (1 - pull);
    const offsetGoal = speed * 8 * (1 - pull) + Math.sign(excess) * 6 * pull;
    const show = hovered || focused || drag ? 1 : 0;

    if (reducedMotion.matches) {
      edge.value = position = target;
      edge.velocity = bend.value = bend.velocity = offset.value = offset.velocity = 0;
      reveal = show;
      draw();
      return;
    }

    for (let step = 0; step < 4; step++) {
      if (!drag) spring(edge, target, 400, 26, dt / 4);
      spring(bend, bendGoal, 680, 34, dt / 4);
      spring(offset, offsetGoal, 680, 34, dt / 4);
    }
    if (!drag) position = edge.value;
    reveal += (show - reveal) * (1 - Math.exp(-32 * dt));
    const moving = !drag && (Math.abs(position - target) > .05 || Math.abs(edge.velocity) > .1);
    const shaping = Math.abs(bend.value - bendGoal) > .03 || Math.abs(offset.value - offsetGoal) > .03
      || Math.abs(bend.velocity) > .1 || Math.abs(offset.velocity) > .1;
    if (moving || shaping || Math.abs(show - reveal) > .003 || Math.abs(speed) > .01) {
      frameId = requestAnimationFrame(tick);
    } else {
      if (!drag) edge.value = position = target;
      edge.velocity = 0;
      bend.value = bendGoal;
      offset.value = offsetGoal;
      reveal = show;
    }
    draw(pull, speed);
  }

  function wake() {
    if (frameId) return;
    lastTime = performance.now();
    frameId = requestAnimationFrame(tick);
  }

  function refresh() {
    if (handle.getClientRects().length === 0) {
      if (drag) finish(true);
      return;
    }
    const nextWidth = frame.clientWidth;
    if (drag && nextWidth === width) return;
    width = nextWidth;
    if (drag) finish(true);
    target = legal(preferredWidth ?? defaultWidth());
    if (!position || position < bounds().min - 16 || position > bounds().max + 16) {
      edge.value = position = target;
      edge.velocity = 0;
    }
    updateAccessibility();
    wake();
  }

  function finish(cancelled = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancelled) {
      preferredWidth = previous.preferredWidth;
      target = legal(previous.start);
    } else {
      preferredWidth = target;
    }
    edge.value = position;
    edge.velocity = 0;
    hovered = previous.type !== 'touch' && Math.abs(previous.raw - position) < 12;
    frame.classList.remove('is-resizing');
    document.body.classList.remove('sidebar-resizing');
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    updateAccessibility();
    wake();
  }

  handle.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') { hovered = true; wake(); } });
  handle.addEventListener('pointerleave', () => { hovered = false; wake(); });
  handle.addEventListener('focus', () => { focused = true; wake(); });
  handle.addEventListener('blur', () => { focused = false; wake(); });

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { id: event.pointerId, type: event.pointerType, start: target, preferredWidth,
      pointerStart: event.clientX, edgeStart: position, raw: position, speed: 0, time: performance.now() };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured; dragging still works.
    }
    frame.classList.add('is-resizing');
    document.body.classList.add('sidebar-resizing');
    wake();
  });

  handle.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const raw = drag.edgeStart + event.clientX - drag.pointerStart;
    if (options.onCollapse && raw <= bounds().min - collapseOvershoot) {
      finish(true);
      options.onCollapse();
      return;
    }
    const now = performance.now();
    drag.speed = (raw - drag.raw) / Math.max((now - drag.time) / 1000, .008);
    drag.raw = raw;
    drag.time = now;
    target = legal(raw);
    // Keep the divider at the legal boundary; reverse immediately after hitting it.
    position = target;
    drag.edgeStart = target;
    drag.pointerStart = event.clientX;
    updateAccessibility();
    wake();
  });

  handle.addEventListener('pointerup', event => {
    if (drag?.id !== event.pointerId) return;
    const atLimit = target <= bounds().min + 2;
    finish();
    if (atLimit) options.onCollapse?.();
  });
  handle.addEventListener('pointercancel', event => { if (drag?.id === event.pointerId) finish(true); });
  handle.addEventListener('lostpointercapture', () => finish());
  window.addEventListener('blur', () => finish(true));
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); }
  });

  handle.addEventListener('dblclick', () => { preferredWidth = null; refresh(); });
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 48 : 16;
    const { min, max } = bounds();
    const widths = { ArrowLeft: target - step, ArrowRight: target + step, Home: min, End: max };
    if (!(event.key in widths) || drag) return;
    event.preventDefault();
    preferredWidth = legal(widths[event.key]);
    refresh();
  });

  new ResizeObserver(refresh).observe(frame);
  reducedMotion.addEventListener('change', wake);
  refresh();
  return refresh;
}
