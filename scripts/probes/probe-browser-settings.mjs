import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8770/dist/index.html';
const browser = await launch({ width: 1440, height: 1000, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(800);
  await browser.evaluate(`document.querySelector('#settings-button')?.click()`);
  await browser.wait(700);
  const nav = await browser.evaluate(`(() => {
    const groups = [...document.querySelectorAll('.settings-group-label')].map(el => el.textContent);
    const items = [...document.querySelectorAll('[data-settings-item]')].map(el => el.textContent.trim());
    return { groups, items };
  })()`);
  await browser.evaluate(`document.querySelector('[data-settings-item="browser"]')?.click()`);
  await browser.wait(800);
  const page = await browser.evaluate(`(() => {
    const el = document.querySelector('#settings-page-browser');
    const sections = [...el.querySelectorAll('.settings-section')].map(s => s.querySelector('.settings-section-title, .browser-setting-summary')?.textContent);
    const advanced = el.querySelector('.settings-advanced');
    const rows = el.querySelectorAll('.settings-row').length;
    const switches = el.querySelectorAll('.settings-switch').length;
    const locked = el.querySelectorAll('.browser-setting-locked').length;
    return {
      heading: document.querySelector('#settings-heading')?.textContent,
      navCurrent: document.querySelector('[data-settings-item="browser"]')?.getAttribute('aria-current'),
      sections, rows, switches, locked,
      advancedOpen: advanced?.open === true,
      pageW: Math.round(el.getBoundingClientRect().width),
      banner: Boolean(el.querySelector('.memory-banner')),
    };
  })()`);
  await browser.shot('qa/shots-main/browser-settings-top.png');
  await browser.evaluate(`document.querySelector('.browser-setting-summary')?.click()`);
  await browser.wait(400);
  const opened = await browser.evaluate(`(() => ({ open: document.querySelector('.settings-advanced')?.open, rows: document.querySelectorAll('.settings-advanced .settings-row').length }))()`);
  await browser.evaluate(`document.querySelector('.settings-advanced')?.scrollIntoView()`);
  await browser.wait(300);
  await browser.shot('qa/shots-main/browser-settings-advanced.png');
  console.log(JSON.stringify({ nav, page, opened, errors: browser.errors }, null, 2));
} finally { await browser.close(); }
