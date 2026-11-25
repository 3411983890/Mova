import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8773/dist/index.html';
const browser = await launch({ width: 1440, height: 1000, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(800);
  await browser.evaluate(`document.querySelector('#settings-button')?.click()`);
  await browser.wait(600);
  await browser.evaluate(`document.querySelector('[data-settings-item="browser"]')?.click()`);
  await browser.wait(750);
  const browserPage = await browser.evaluate(`(() => {
    const page = document.querySelector('#settings-page-browser');
    return {
      heading: document.querySelector('#settings-heading')?.textContent,
      visible: page ? !page.hidden : false,
      rows: page ? page.querySelectorAll('.settings-row').length : 0,
      switches: page ? page.querySelectorAll('.settings-switch').length : 0,
      advancedCollapsed: page ? page.querySelector('.settings-advanced')?.open === false : null,
      textLen: page ? page.innerText.trim().length : 0,
    };
  })()`);
  await browser.shot('qa/shots-main/settings-browser-restored.png');
  // 主页对话：目标/用量入口是否还在
  await browser.evaluate(`document.querySelector('#home-button')?.click()`);
  await browser.wait(500);
  await browser.evaluate(`document.querySelector('.chat-row .chat-open')?.click()`);
  await browser.wait(600);
  const home = await browser.evaluate(`(() => ({
    header: !document.querySelector('#chat-header').hidden,
    aim: Boolean(document.querySelector('#chat-aim')),
    usage: Boolean(document.querySelector('#chat-usage')),
    moreLabel: document.querySelector('#chat-more')?.getAttribute('aria-label'),
  }))()`);
  console.log(JSON.stringify({ browserPage, home, errors: browser.errors }, null, 2));
} finally { await browser.close(); }
