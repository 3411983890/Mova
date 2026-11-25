document.querySelector('#settings-button').click();
await new Promise(r => setTimeout(r, 300));
document.querySelector('[data-settings-item="permissions"]').click();
await new Promise(r => setTimeout(r, 600));
const page = document.querySelector('#settings-page-permissions');
return { visible: !page.hidden, text: page.innerText.slice(0, 400) };
