// 只做三件事：拖文件、写一句话、点发送。不等待（等待交给外部的轮询）。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = document.querySelector('#composer');
const root = host?.querySelector('div')?.shadowRoot ?? host?.shadowRoot ?? null;
if (!root) return { error: '找不到 composer shadow root' };
const before = document.querySelectorAll('.user-turn').length;

const file = new File(['# Mova 附件测试\n\n结论：蓝色代表剩余额度。'], '附件测试.md', { type: 'text/markdown' });
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);
for (const node of [...root.querySelectorAll('div')].slice(0, 40)) {
  try { node.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, cancelable: true, dataTransfer })); } catch { /* 忽略 */ }
}
await sleep(1200);
const chips = root.querySelectorAll('[aria-label^="移除附件"]').length;

const textarea = root.querySelector('textarea');
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
setter?.call(textarea, '用一句话概括附件内容');
textarea?.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(300);
const draft = textarea?.value ?? '';

root.querySelector('.composer-send-btn')?.click();
await sleep(600);
return { before, chips, draft, after: document.querySelectorAll('.user-turn').length };
