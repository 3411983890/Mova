import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1440, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(600);

  // 1) Contacts page from the activity rail.
  await browser.evaluate(`document.querySelector('#contacts-button')?.click()`);
  await browser.wait(800);
  const contacts = await browser.evaluate(`(() => {
    const view = document.querySelector('#contacts-view');
    const rows = document.querySelectorAll('#contacts-view .contacts-row, #contacts-view .contacts-list-item, #contacts-view [data-contact-id]');
    return {
      visible: !view.hidden,
      frameMode: document.querySelector('.content-frame')?.classList.contains('contacts-mode'),
      railSelected: document.querySelector('#contacts-button')?.classList.contains('selected'),
      ariaCurrent: document.querySelector('#contacts-button')?.getAttribute('aria-current'),
      rowCount: rows.length,
      header: view.innerText.trim().slice(0, 40).replace(/\\s+/g, ' '),
    };
  })()`);
  await browser.shot('qa/shots-main/contacts.png');

  // 2) Back home, then messages view for bot popover.
  await browser.evaluate(`document.querySelector('#home-button')?.click()`);
  await browser.wait(500);
  await browser.evaluate(`document.querySelector('#messages-button')?.click()`);
  await browser.wait(700);
  const beforePopover = await browser.evaluate(`(() => ({
    moreLabel: document.querySelector('#chat-more')?.getAttribute('aria-label'),
    moreControls: document.querySelector('#chat-more')?.getAttribute('aria-controls'),
    popoverHidden: document.querySelector('#bot-popover')?.hidden,
  }))()`);
  await browser.evaluate(`document.querySelector('#chat-more')?.click()`);
  await browser.wait(700);
  const popover = await browser.evaluate(`(() => {
    const el = document.querySelector('#bot-popover');
    const r = el.getBoundingClientRect();
    return {
      hidden: el.hidden,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: el.innerText.trim().slice(0, 60).replace(/\\s+/g, ' '),
    };
  })()`);
  await browser.shot('qa/shots-main/bot-popover.png');

  // 3) New group dialog.
  await browser.evaluate(`document.querySelector('#bot-popover')?.click()`);
  await browser.wait(300);
  await browser.evaluate(`document.querySelector('#chat-more')?.click()`);
  await browser.wait(400);
  await browser.evaluate(`document.querySelector('#bot-add')?.click()`);
  await browser.wait(800);
  const group = await browser.evaluate(`(() => {
    const dialog = document.querySelector('#group-dialog');
    const root = document.querySelector('#group-dialog-root');
    return {
      open: Boolean(dialog?.open),
      hasForm: Boolean(root?.querySelector('.group-dialog-form')),
      fields: [...(root?.querySelectorAll('input, textarea, [role="checkbox"], button') || [])].length,
      text: root?.innerText.trim().slice(0, 70).replace(/\\s+/g, ' '),
    };
  })()`);
  await browser.shot('qa/shots-main/group-dialog.png');

  console.log(JSON.stringify({ contacts, beforePopover, popover, group, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
