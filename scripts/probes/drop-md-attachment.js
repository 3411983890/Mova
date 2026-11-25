// 往 composer 里拖一个 .md 文件，验证「非图片附件」能进得了输入栏。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = document.querySelector('#composer');
const root = host?.querySelector('div')?.shadowRoot ?? host?.shadowRoot ?? null;
if (!host) return { error: '找不到 #composer' };

// 找到接收 drop 的节点：vendor 把 onDrop 挂在输入区容器上。
const dropTargets = root ? [root.host, ...root.querySelectorAll('[data-message-composer-surface], form, div')].slice(0, 40) : [host];
const file = new File(['# 测试文档\n\n这是从 Mova 上传的 Markdown 文件。'], '上传测试.md', { type: 'text/markdown' });
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);

let delivered = 0;
for (const node of dropTargets) {
  try {
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, cancelable: true, dataTransfer }));
    delivered += 1;
  } catch { /* 该节点不接受 */ }
}
await sleep(1200);

const text = root ? (root.textContent || '') : (host.textContent || '');
return {
  delivered,
  hasAttachmentText: text.includes('上传测试.md'),
  hasFileKind: /文本|文件/.test(text),
  sendDisabled: (() => {
    const button = root?.querySelector('.composer-send-btn');
    return button ? button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' : null;
  })(),
  surfaceText: text.replace(/\s+/g, ' ').trim().slice(0, 220),
};
