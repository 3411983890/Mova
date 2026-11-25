// Type a two-line draft to confirm auto-growth and rounded corners with content.
function findSurface() {
  for (const el of document.querySelectorAll('*')) {
    const hit = el.shadowRoot?.querySelector('[data-message-composer-surface]');
    if (hit) return hit;
  }
  return document.querySelector('[data-message-composer-surface]');
}
const surface = findSurface();
const area = surface.querySelector('textarea');
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
setter.call(area, '帮我把这个输入框的高度再调高一点点，\n并把圆角改成和发送键的四分之一圆一致的弧。');
area.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise(r => setTimeout(r, 500));
const rect = surface.getBoundingClientRect();
const send = surface.querySelector('.composer-send-btn');
return { height: +rect.height.toFixed(2), send: `${send.getBoundingClientRect().width}x${send.getBoundingClientRect().height}`, radius: getComputedStyle(surface).borderRadius };
