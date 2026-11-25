// 端到端：确保内核在跑 → 拖一个 .md 进 composer → 输入一句话 → 发送 → 读回助手回复。
// 目的：证明「非图片附件」真的进了模型上下文，而不只是界面上多了个 chip。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = [];

const vpn = window.movaDesktop?.vpn;
if (vpn) {
  const status = await vpn.status().catch(() => null);
  if (status?.ok && status.value?.core?.running !== true) {
    await vpn.core.action({ action: 'start' }).catch(() => null);
    await sleep(3500);
    note.push('已启动内核');
  } else {
    note.push('内核已在运行');
  }
}

const host = document.querySelector('#composer');
const root = host?.querySelector('div')?.shadowRoot ?? host?.shadowRoot ?? null;
if (!root) return { error: '找不到 composer shadow root', note };

// 只往 host 拖一次：上一次探针把事件扇出到 23 个节点，同一个文件被加了 4 遍。
const file = new File(
  ['# Mova 附件测试\n\n这是一份用来验证「所有文件类型都能上传」的 Markdown。\n核心结论：蓝色代表剩余额度。'],
  '附件测试.md',
  { type: 'text/markdown' },
);
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);
root.host.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, cancelable: true, dataTransfer }));
await sleep(1200);

const textarea = root.querySelector('textarea');
if (!textarea) return { error: '找不到输入框', note };
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
setter?.call(textarea, '用一句话概括这份附件的内容');
textarea.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(400);

const send = root.querySelector('.composer-send-btn');
send?.click();
note.push(`send clicked=${Boolean(send)}`);

// 等回复落定（最多 75 秒）：transcript 里最后一条助手回复不再是「正在生成」。
for (let i = 0; i < 75; i += 1) {
  await sleep(1000);
  const busy = document.querySelector('.assistant-reply [aria-busy="true"], .assistant-reply-streaming');
  const rows = document.querySelectorAll('.user-turn');
  if (!busy && rows.length) break;
}

return {
  note,
  userTurns: [...document.querySelectorAll('.user-turn')].slice(-1).map(turn => ({
    files: [...turn.querySelectorAll('.user-file-name')].map(node => node.textContent),
    text: (turn.querySelector('.user-message')?.innerText || '').trim().slice(0, 80),
  })),
  assistant: (document.querySelectorAll('.assistant-reply')[document.querySelectorAll('.assistant-reply').length - 1]?.innerText || '')
    .replace(/\s+/g, ' ').trim().slice(0, 400),
};
