// 回到对话区（首页），让 composer 可见；返回 composer 里附件 chip 的文字。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const home = document.querySelector('#home-button, [data-area="home"], .rail-home, #area-home');
if (home instanceof HTMLElement) home.click();
await sleep(700);
const host = document.querySelector('#composer');
const root = host?.querySelector('div')?.shadowRoot ?? host?.shadowRoot ?? null;
const text = root ? (root.textContent || '') : '';
return {
  clickedHome: Boolean(home),
  composerVisible: Boolean(host && host.getBoundingClientRect().height > 0),
  attachmentText: text.includes('上传测试.md'),
  chips: root ? [...root.querySelectorAll('[aria-label^="移除"], [title="上传测试.md"]')].map(node => node.getAttribute('aria-label') || node.getAttribute('title')).slice(0, 6) : [],
};
