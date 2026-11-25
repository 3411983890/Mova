import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8771/dist/index.html';
const browser = await launch({ width: 1440, height: 1000, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(800);
  // 主页 → 打开分屏浏览器（另一 agent 的 tabs/allowpopups 区域）
  await browser.evaluate(`document.querySelector('#browser-toggle')?.click()`);
  await browser.wait(900);
  const panel = await browser.evaluate(`(() => {
    const el = document.querySelector('#browser-panel');
    return { visible: el ? !el.hidden : null, hasWebview: Boolean(document.querySelector('webview')), tabs: document.querySelectorAll('.browser-tab, [data-tab-id]').length };
  })()`);
  // 设置 → 浏览器页
  await browser.evaluate(`document.querySelector('#settings-button')?.click()`);
  await browser.wait(600);
  await browser.evaluate(`document.querySelector('[data-settings-item="browser"]')?.click()`);
  await browser.wait(700);
  const page = await browser.evaluate(`(() => ({
    heading: document.querySelector('#settings-heading')?.textContent,
    rows: document.querySelectorAll('#settings-page-browser .settings-row').length,
    advanced: document.querySelector('.settings-advanced')?.open === false,
  }))()`);
  console.log(JSON.stringify({ panel, page, errors: browser.errors }, null, 2));
} finally { await browser.close(); }
