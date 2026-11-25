// 在「已归档的聊天」页点永久删除 → 确认 → 等落盘 → 读回结果。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = {};

if (document.querySelector('#settings-view').hidden) document.querySelector('#settings-button').click();
await sleep(500);
document.querySelector('[data-settings-item="archive"]').click();
await sleep(800);

out.before = (document.querySelector('#settings-page-archive')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
const del = document.querySelector('#settings-page-archive [data-action="delete"]');
out.hadDeleteButton = Boolean(del);
del?.click();
await sleep(700);
out.dialogTitle = document.querySelector('.settings-dialog h2')?.textContent?.trim() ?? null;
out.dialogBody = document.querySelector('.settings-dialog-body')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 220) ?? null;
const confirm = document.querySelector('.settings-dialog-actions .settings-button.danger-solid');
out.hadConfirm = Boolean(confirm);
confirm?.click();
await sleep(3500);
out.after = (document.querySelector('#settings-page-archive')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
out.announcement = document.querySelector('#sidebar-announcement')?.textContent?.trim() ?? null;
return out;
