function findSurface() {
  for (const el of document.querySelectorAll('*')) {
    const hit = el.shadowRoot?.querySelector('[data-message-composer-surface]');
    if (hit) return hit;
  }
  return document.querySelector('[data-message-composer-surface]');
}

const surface = findSurface();
if (!surface) throw new Error('surface not found');
// Revert to the previous metrics so the "before" frame matches the old build.
surface.style.borderRadius = '24px';
surface.style.border = '1px solid #414443';
const inner = surface.querySelector('.relative');
inner.style.paddingTop = '2px';
inner.style.paddingBottom = '2px';
const area = surface.querySelector('textarea');
area.style.setProperty('min-height', '40px', 'important');
const rect = surface.getBoundingClientRect();
return { left: +rect.left.toFixed(2), right: +rect.right.toFixed(2), top: +rect.top.toFixed(2), bottom: +rect.bottom.toFixed(2), height: +rect.height.toFixed(2) };
