/* Reusable, buildless anchor-to-panel motion for Mova.
 * Spring values and response are reused from vendor/leibox/DeepAgentComposerEngine.js
 * (MorphingMenuShell / SHARE_MOTION); content blur/fade follows chat-usage.js.
 * No framework, GSAP runtime, or application state is required.
 */
(() => {
  'use strict';
  const MOTION = Object.freeze({
    open: { width: { stiffness: 306.25, damping: 28, duration: .7, delay: 0 }, height: { stiffness: 196, damping: 18.34, duration: .86, delay: .057 } },
    close: { width: { stiffness: 400, damping: 33, duration: .64, delay: .07 }, height: { stiffness: 600.25, damping: 40, duration: .62, delay: 0 } }
  });
  function spring(progress, { stiffness, damping, duration }) {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    const decay = damping / 2, frequency = Math.sqrt(stiffness - decay * decay), time = progress * duration;
    return 1 - Math.exp(-decay * time) * (Math.cos(frequency * time) + decay / frequency * Math.sin(frequency * time));
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  function create({ host, trigger, panel, closeButton, align = 'right', width = 224, onOpen, additionalTriggers = [] }) {
    if (!host || !trigger || !panel || !closeButton) throw new Error('MovaMorphPanel: missing host, trigger, panel or close button');
    const inner = panel.querySelector('.mova-morph-inner');
    if (!inner) throw new Error('MovaMorphPanel: .mova-morph-inner is required');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let open = false, busy = false, run = 0, animations = [], request = 0;
    const originalTabIndex = trigger.tabIndex;
    const cancel = () => { animations.forEach(a => a.cancel()); animations = []; };
    const rect = element => { const b = element.getBoundingClientRect(), h = host.getBoundingClientRect(); return { left: b.left - h.left, top: b.top - h.top, width: b.width, height: b.height }; };
    const apply = bounds => { for (const key of ['left', 'top', 'width', 'height']) panel.style[key] = `${bounds[key]}px`; };

    function geometry() {
      const h = host.getBoundingClientRect(), anchor = rect(trigger);
      const panelWidth = Math.max(120, Math.min(width, h.width - 16));
      const left = Math.max(8, Math.min(h.width - panelWidth - 8, align === 'right' ? anchor.left + anchor.width - panelWidth : anchor.left));
      const top = Math.max(7, anchor.top), limit = Math.max(80, h.height - top - 10);
      inner.style.width = `${panelWidth - 2}px`;
      inner.style.maxHeight = `${limit - 2}px`;
      inner.style.overflowY = 'auto';
      const height = Math.min(inner.scrollHeight + 2, limit);
      const final = { left, top, width: panelWidth, height };
      return { anchor, final };
    }

    function frames(from, to, opening) {
      const motion = MOTION[opening ? 'open' : 'close'];
      const duration = Math.max(motion.width.duration + motion.width.delay, motion.height.duration + motion.height.delay);
      const keyframes = [];
      for (let i = 0; i <= 72; i++) {
        const offset = i / 72, time = offset * duration;
        const x = spring((time - motion.width.delay) / motion.width.duration, motion.width);
        const y = spring((time - motion.height.delay) / motion.height.duration, motion.height);
        const corner = Math.min(1, time / .22);
        const frameWidth = Math.max(1, lerp(from.width, to.width, x));
        keyframes.push({ offset,
          left: `${align === 'right' ? lerp(from.left + from.width, to.left + to.width, x) - frameWidth : lerp(from.left, to.left, x)}px`,
          top: `${lerp(from.top, to.top, y)}px`, width: `${frameWidth}px`, height: `${Math.max(1, lerp(from.height, to.height, y))}px`,
          borderRadius: `${lerp(opening ? 6 : 16, opening ? 16 : 6, corner)}px`,
          opacity: lerp(opening ? .55 : 1, opening ? 1 : .55, corner)
        });
      }
      return { keyframes, duration: duration * 1000 };
    }

    function finish(opening, token, focus) {
      if (token !== run) return;
      cancel(); busy = false; panel.dataset.phase = opening ? 'open' : 'closed';
      if (opening) { apply(geometry().final); if (focus) panel.focus({ preventScroll: true }); }
      else {
        panel.hidden = true; panel.inert = false;
        trigger.classList.remove('is-morph-hidden'); trigger.tabIndex = originalTabIndex; trigger.removeAttribute('aria-hidden');
        for (const property of ['left', 'top', 'width', 'height', 'opacity', 'border-radius']) panel.style.removeProperty(property);
        if (focus) trigger.focus({ preventScroll: true });
      }
    }

    function setOpen(next, { focus = true } = {}) {
      if (next === open) return;
      const current = panel.hidden ? null : rect(panel);
      run += 1; const token = run;
      cancel(); open = next; busy = true;
      trigger.setAttribute('aria-expanded', String(open));
      if (open) {
        onOpen?.();
        panel.hidden = false; panel.inert = false;
        trigger.classList.add('is-morph-hidden'); trigger.tabIndex = -1; trigger.setAttribute('aria-hidden', 'true');
      } else panel.inert = true;
      panel.dataset.phase = open ? 'opening' : 'closing';
      const { anchor, final } = geometry();
      const from = current || anchor, to = open ? final : anchor;
      apply(to);
      if (reduced.matches || !panel.animate) { finish(open, token, focus); return; }
      const sequence = frames(from, to, open);
      const shell = panel.animate(sequence.keyframes, { duration: sequence.duration, easing: 'linear', fill: 'both' });
      const content = inner.animate(open ? [
        { opacity: 0, filter: 'blur(4px)', transform: 'translateY(3px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'none' }
      ] : [
        { opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(3px)' }
      ], { duration: open ? 200 : 130, delay: open ? 140 : 0, easing: 'cubic-bezier(.22,.9,.26,1)', fill: 'both' });
      animations.push(shell, content);
      if (!open) {
        trigger.classList.remove('is-morph-hidden');
        const compact = [];
        for (let i = 0; i <= 40; i++) {
          const offset = i / 40, value = spring(offset, { stiffness: 300, damping: 21, duration: .48 });
          compact.push({ offset, opacity: Math.min(1, offset * 4), transform: `scale(${lerp(.95, 1, value)})` });
        }
        animations.push(trigger.animate(compact, { duration: 480, delay: 200, easing: 'linear', fill: 'both' }));
      }
      shell.addEventListener('finish', () => finish(open, token, focus), { once: true });
    }

    function schedule() {
      if (request) return;
      request = requestAnimationFrame(() => { request = 0; if (open && !busy) apply(geometry().final); });
    }
    const dismiss = event => {
      if (!open || panel.contains(event.target) || trigger.contains(event.target) || additionalTriggers.some(el => el?.contains(event.target))) return;
      setOpen(false, { focus: false });
    };
    const escape = event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    const close = () => setOpen(false);
    const resize = new ResizeObserver(schedule); resize.observe(host);
    const mutation = new MutationObserver(schedule); mutation.observe(inner, { childList: true, subtree: true });
    closeButton.addEventListener('click', close);
    document.addEventListener('pointerdown', dismiss, true);
    panel.addEventListener('keydown', escape);
    reduced.addEventListener('change', schedule);
    return {
      setOpen, close: options => setOpen(false, options), toggle: () => setOpen(!open), get open() { return open; },
      destroy() { run += 1; cancel(); cancelAnimationFrame(request); resize.disconnect(); mutation.disconnect(); closeButton.removeEventListener('click', close); document.removeEventListener('pointerdown', dismiss, true); panel.removeEventListener('keydown', escape); reduced.removeEventListener('change', schedule); panel.hidden = true; trigger.classList.remove('is-morph-hidden'); trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-hidden'); trigger.tabIndex = originalTabIndex; }
    };
  }
  globalThis.MovaMorphPanel = Object.freeze({ create, motion: MOTION });
})();
