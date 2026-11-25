function findSurface() {
  for (const el of document.querySelectorAll('*')) {
    const hit = el.shadowRoot?.querySelector('[data-message-composer-surface]');
    if (hit) return hit;
  }
  return document.querySelector('[data-message-composer-surface]');
}
const surface = findSurface();
const inner = surface.querySelector('.relative');
const area = surface.querySelector('textarea');
const snap = (tag) => {
  const cs = getComputedStyle(surface);
  const is_ = getComputedStyle(inner);
  const ta = getComputedStyle(area);
  return {
    tag,
    surfaceHeight: +surface.getBoundingClientRect().height.toFixed(2),
    radius: cs.borderRadius,
    radiusInline: surface.style.borderRadius || '(none)',
    padTop: is_.paddingTop, padBottom: is_.paddingBottom,
    taMin: ta.minHeight, taHeight: ta.height,
    rowHeight: +inner.getBoundingClientRect().height.toFixed(2),
  };
};
const after = snap('after');
surface.style.borderRadius = '24px';
inner.style.paddingTop = '2px';
inner.style.paddingBottom = '2px';
area.style.setProperty('min-height', '40px', 'important');
const before = snap('before');
return { before, after };
