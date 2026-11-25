import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8768/dist/index.html';
const browser = await launch({ width: 1440, height: 980, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(700);
  await browser.evaluate(`document.querySelector('#contacts-button')?.click()`);
  await browser.wait(700);
  const opened = await browser.evaluate(`(() => {
    const add = [...document.querySelectorAll('#contacts-view button')].find(b => b.getAttribute('aria-label')?.includes('创建') || b.className.includes('contacts-add'));
    add?.click();
    return add ? add.getAttribute('aria-label') : 'no add button';
  })()`);
  await browser.wait(800);
  const info = await browser.evaluate(`(() => {
    const dialog = document.querySelector('#bot-builder-dialog');
    const cards = [...document.querySelectorAll('.bot-model-option')];
    const effort = document.querySelector('.bot-effort');
    return {
      open: Boolean(dialog?.open),
      modelCards: cards.map(c => c.querySelector('strong')?.textContent),
      checked: cards.find(c => c.getAttribute('aria-checked') === 'true')?.querySelector('strong')?.textContent,
      effortButtons: effort ? [...effort.querySelectorAll('button')].map(b => b.textContent) : null,
      effortOff: effort?.classList.contains('is-off'),
    };
  })()`);
  await browser.shot('qa/shots-main/bot-builder-model.png');
  console.log(JSON.stringify({ opened, info, errors: browser.errors }, null, 2));
} finally { await browser.close(); }
