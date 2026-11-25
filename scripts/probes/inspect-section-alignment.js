// 追「ChatGPT 订阅」这个标题为什么居中：逐级打印 text-align / align-items / width。
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (document.querySelector('#settings-view').hidden) document.querySelector('#settings-button').click();
await sleep(400);
document.querySelector('[data-settings-item="cli-models"]').click();
await sleep(900);
const heading = [...document.querySelectorAll('#settings-page-cli-models .settings-section-title')]
  .find(el => (el.textContent || '').includes('ChatGPT'));
if (!heading) return { error: '找不到标题' };
const chain = [];
let node = heading;
while (node && node !== document.body) {
  const style = getComputedStyle(node);
  chain.push({
    tag: node.tagName.toLowerCase(),
    cls: node.className || '',
    textAlign: style.textAlign,
    alignItems: style.alignItems,
    display: style.display,
    width: Math.round(node.getBoundingClientRect().width),
    left: Math.round(node.getBoundingClientRect().left),
  });
  node = node.parentElement;
}
const rect = heading.getBoundingClientRect();
return {
  heading: (heading.textContent || '').trim(),
  headingRect: { left: Math.round(rect.left), width: Math.round(rect.width) },
  chain,
};
