// 在运行中的应用里读真实 DOM：CLI 模型页的额度文案 + 已归档聊天页的条目。
// 由 scripts/probes/shot-app.mjs --script=... 注入执行（CDP Runtime.evaluate）。
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = {};

const settingsOpen = document.querySelector('#settings-view') && !document.querySelector('#settings-view').hidden;
if (!settingsOpen) document.querySelector('#settings-button').click();
await sleep(600);

document.querySelector('[data-settings-item="cli-models"]').click();
await sleep(1500);
const quotaLabels = [...document.querySelectorAll('#settings-page-cli-models .cm-quota-label')].map(el => el.textContent.trim());
const quotaValues = [...document.querySelectorAll('#settings-page-cli-models .cm-quota-value')].map(el => el.textContent.trim());
const quotaBars = [...document.querySelectorAll('#settings-page-cli-models .cm-quota-window')].map(row => {
  const fill = row.querySelector('.cm-quota-bar span, .cm-quota-track span');
  return fill ? fill.style.width : null;
});
out.cliModels = {
  pageVisible: !document.querySelector('#settings-page-cli-models').hidden,
  emptyText: document.querySelector('#settings-page-cli-models .cm-quota-empty')?.textContent?.trim() ?? null,
  labels: quotaLabels,
  values: quotaValues,
  bars: quotaBars,
  accountCards: document.querySelectorAll('#settings-page-cli-models .cm-account').length,
};

document.querySelector('[data-settings-item="archive"]').click();
await sleep(900);
const archive = document.querySelector('#settings-page-archive');
out.archive = {
  pageVisible: !archive.hidden,
  heading: document.querySelector('#settings-heading')?.textContent?.trim() ?? null,
  text: (archive.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
  rows: [...archive.querySelectorAll('[data-archived-chat], .archive-row, li')].map(el => (el.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 12),
};

// 回到侧栏，顺便把项目名与聊天条数一起带出来
document.querySelector('[data-settings-item="cli-models"]').click();
await sleep(400);
out.projects = [...document.querySelectorAll('.project-row')].map(el => (el.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 10);
return out;
