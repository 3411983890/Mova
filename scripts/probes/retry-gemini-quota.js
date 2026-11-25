// 点 Gemini 卡片上的「立即读取」触发一次真实额度探针，等它跑完再读结果文案。
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (document.querySelector('#settings-view').hidden) document.querySelector('#settings-button').click();
await sleep(400);
document.querySelector('[data-settings-item="cli-models"]').click();
await sleep(900);
const before = (document.querySelector('#settings-page-cli-models .cm-quota-empty')?.textContent || '').trim();
const button = [...document.querySelectorAll('#settings-page-cli-models button')]
  .find(item => (item.textContent || '').trim() === '立即读取');
button?.click();
await sleep(14000);
return {
  hadButton: Boolean(button),
  before: before.slice(0, 80),
  afterEmpty: (document.querySelector('#settings-page-cli-models .cm-quota-empty')?.textContent || '').trim().slice(0, 100),
  values: [...document.querySelectorAll('#settings-page-cli-models .cm-quota-value')].map(el => el.textContent.trim()),
};
