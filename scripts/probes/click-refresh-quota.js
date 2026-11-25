// 点 Gemini 卡片上的「立即读取」触发一次真实探针（不等待结果，返回是否点到了）。
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (document.querySelector('#settings-view').hidden) document.querySelector('#settings-button').click();
await sleep(400);
document.querySelector('[data-settings-item="cli-models"]').click();
await sleep(800);
const button = [...document.querySelectorAll('#settings-page-cli-models button')]
  .find(item => (item.textContent || '').trim() === '立即读取');
button?.click();
await sleep(300);
return { clicked: Boolean(button), empty: (document.querySelector('#settings-page-cli-models .cm-quota-empty')?.textContent || '').trim().slice(0, 60) };
