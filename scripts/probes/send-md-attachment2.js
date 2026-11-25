// 端到端 v2：明确数出「发送前 / 发送后」的轮次，确认这一轮真的发出去了。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = document.querySelector('#composer');
const root = host?.querySelector('div')?.shadowRoot ?? host?.shadowRoot ?? null;
if (!root) return { error: '找不到 composer shadow root' };

const before = {
  user: document.querySelectorAll('.user-turn').length,
  assistant: document.querySelectorAll('.assistant-reply').length,
  chips: root.querySelectorAll('[aria-label^="移除附件"]').length,
};

// 上一版把事件扇出到整棵子树才成功，这里照做（同一个文件被加多份没关系，验证的是通路）。
const file = new File(
  ['# Mova 附件测试\n\n结论：蓝色代表剩余额度。'],
  '附件测试.md',
  { type: 'text/markdown' },
);
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);
const targets = [...root.querySelectorAll('div')].slice(0, 40);
for (const node of targets) {
  try { node.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, cancelable: true, dataTransfer })); } catch { /* 忽略 */ }
}
await sleep(1500);
const chipsAfterDrop = root.querySelectorAll('[aria-label^="移除附件"]').length;

// React 受控输入：必须用原型上的 setter，再派发 input，React 才会更新 state。
const textarea = root.querySelector('textarea');
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
setter?.call(textarea, '用一句话概括附件内容');
textarea?.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(300);
const draftLength = textarea?.value?.length ?? 0;

root.querySelector('.composer-send-btn')?.click();

let sent = false;
for (let i = 0; i < 70; i += 1) {
  await sleep(1000);
  if (document.querySelectorAll('.user-turn').length > before.user) { sent = true; break; }
}

const turns = [...document.querySelectorAll('.user-turn')];
const last = turns[turns.length - 1];
return {
  before,
  chipsAfterDrop,
  draftLength,
  sent,
  lastTurn: last ? {
    files: [...last.querySelectorAll('.user-file-name')].map(node => node.textContent),
    text: (last.querySelector('.user-message')?.innerText || '').trim().slice(0, 120),
  } : null,
  feedback: (document.querySelector('#chat-feedback, .chat-feedback')?.textContent || '').trim().slice(0, 120),
};
