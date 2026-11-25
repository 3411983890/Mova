// 打开「网络与线路」设置页，读引擎卡片上的按钮与内核状态。
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (document.querySelector('#settings-view').hidden) document.querySelector('#settings-button').click();
await sleep(500);
document.querySelector('[data-settings-item="network"]').click();
await sleep(1200);
const card = document.querySelector('#settings-page-network .vpn-engine-card') || document.querySelector('#settings-page-network');
const buttons = [...(card?.querySelectorAll('.vpn-engine-actions button') ?? [])].map(button => ({
  text: (button.textContent || '').trim(),
  role: button.getAttribute('role') || '',
  checked: button.getAttribute('aria-checked'),
  disabled: button.disabled === true,
}));
return {
  pageVisible: !document.querySelector('#settings-page-network').hidden,
  headline: (card?.querySelector('.vpn-engine-head strong')?.textContent || '').trim(),
  buttons,
};
