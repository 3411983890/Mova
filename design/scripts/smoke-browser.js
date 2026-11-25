const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

await document.fonts.ready;
await wait(400);
assert(document.querySelector('#composer')?.firstElementChild, 'Composer did not mount');
assert(document.querySelector('#window-controls button'), 'React window controls missing');
assert(window.movaCompanion, 'Emotion ball did not initialize');
assert(!window.movaDesktop, 'Unexpected desktop backend bridge');
assert([...document.styleSheets].some(sheet => sheet.href?.endsWith('project-dialog.css')), 'Project CSS missing');
assert(document.querySelector('.ph') || document.querySelector('#home-button i'), 'Icon stylesheet missing');

document.querySelector('#settings-button').click();
assert(!document.querySelector('#settings-view').hidden, 'Settings did not open');
document.querySelectorAll('[data-settings-item]').forEach(item => item.click());
assert(document.querySelector('#settings-page-models').hidden === false || document.querySelector('#settings-page-config'), 'Settings sections missing');
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(200);
assert(document.querySelector('#settings-view').hidden, 'Settings did not close');

document.querySelector('#messages-button').click();
await wait(200);
assert(!document.querySelector('#bot-sidebar').hidden, 'Bot list did not open');
document.querySelector('#forum-button').click();
await wait(300);
assert(!document.querySelector('#forum-view').hidden, 'Community did not open');
document.querySelector('#home-button').click();
await wait(300);

document.querySelector('#new-chat').click();
await wait(900);
assert(localStorage.getItem('mova-design.workspace.v1'), 'Design storage key was not written');
assert(!localStorage.getItem('mova.workspace.v1'), 'Main workspace storage was touched');

const editor = document.querySelector('#composer').firstElementChild.shadowRoot?.querySelector('textarea, [contenteditable="true"]');
assert(editor, 'Composer editor missing');
if (editor.matches('textarea')) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, '设计副本测试');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
} else {
  editor.textContent = '设计副本测试';
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '设计副本测试' }));
}
await wait(300);
editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
await wait(4500);
const replyText = document.querySelector('#conversation')?.textContent ?? '';
assert(replyText.includes('没有调用 AI 模型'), 'Mock chat did not complete: ' + replyText.slice(0, 120));
return {
  title: document.title,
  protocol: location.protocol,
  offline: location.protocol === 'file:',
  composer: true, settings: true, bots: true, community: true, mockChat: true, isolatedStorage: true,
};
