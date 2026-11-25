// CodeMova new-chat state for composer screenshots.
const modeButton = [...document.querySelectorAll('[data-mode]')].find(b => b.dataset.mode === 'CodeMova');
modeButton?.click();
document.querySelector('#new-chat')?.click();
await new Promise(r => setTimeout(r, 400));
function findSurface() {
  for (const el of document.querySelectorAll('*')) {
    const hit = el.shadowRoot?.querySelector('[data-message-composer-surface]');
    if (hit) return hit;
  }
  return document.querySelector('[data-message-composer-surface]');
}
const surface = findSurface();
const r = surface.getBoundingClientRect();
return { height: +r.height.toFixed(2), radius: getComputedStyle(surface).borderRadius, send: getComputedStyle(surface.querySelector('.composer-send-btn')).borderRadius };
