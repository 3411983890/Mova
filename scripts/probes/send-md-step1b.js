// 用「文件选择器」那条路（input[type=file] + change）加一个 .md —— 和用户点「附件」完全一样。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = document.querySelector('#composer');
const root = host?.querySelector('div')?.shadowRoot ?? host?.shadowRoot ?? null;
if (!root) return { error: '找不到 composer shadow root' };

// 先清掉上一次探针留下的重复附件（点掉每个 chip 的移除按钮）。
let cleared = 0;
for (let i = 0; i < 30; i += 1) {
  const remove = root.querySelector('[aria-label^="移除附件"]');
  if (!remove) break;
  remove.click();
  cleared += 1;
  await sleep(60);
}
await sleep(300);

const before = document.querySelectorAll('.user-turn').length;
const input = root.querySelector('input[type="file"]');
if (!input) return { error: '找不到文件选择器', cleared };

const file = new File(['# Mova 附件测试\n\n结论：蓝色代表剩余额度。'], '附件测试.md', { type: 'text/markdown' });
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);
input.files = dataTransfer.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
await sleep(1500);
const chips = root.querySelectorAll('[aria-label^="移除附件"]').length;

const textarea = root.querySelector('textarea');
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
setter?.call(textarea, '用一句话概括附件内容');
textarea?.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(300);

root.querySelector('.composer-send-btn')?.click();
await sleep(1200);
return {
  cleared,
  before,
  chips,
  after: document.querySelectorAll('.user-turn').length,
  feedback: (document.querySelector('#chat-feedback')?.textContent || '').trim().slice(0, 120),
};
