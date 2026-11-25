// CodeMova new-chat state, forced back to the previous metrics (24px radius, +8px shorter).
const modeButton = [...document.querySelectorAll('[data-mode]')].find(b => b.dataset.mode === 'CodeMova');
modeButton?.click();
document.querySelector('#new-chat')?.click();
await new Promise(r => setTimeout(r, 300));

function findSurface() {
  for (const el of document.querySelectorAll('*')) {
    const hit = el.shadowRoot?.querySelector('[data-message-composer-surface]');
    if (hit) return hit;
  }
  return document.querySelector('[data-message-composer-surface]');
}
const surface = findSurface();
const root = surface.getRootNode();
const style = document.createElement('style');
style.textContent = `
  [data-message-composer-surface] { border-radius: 24px !important; }
  [data-message-composer-surface] > .relative { padding-top: 2px !important; padding-bottom: 2px !important; }
  [data-message-composer-surface] textarea { min-height: 40px !important; }
`;
root.append(style);
await new Promise(r => setTimeout(r, 400));
return { height: +surface.getBoundingClientRect().height.toFixed(2), radius: getComputedStyle(surface).borderRadius };
