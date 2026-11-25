import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8772/dist/index.html';
const browser = await launch({ width: 1440, height: 1000, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(800);
  await browser.evaluate(`document.querySelector('#settings-button')?.click()`);
  await browser.wait(600);

  const pages = ['browser', 'memory', 'mcp', 'config'];
  const results = [];
  for (const id of pages) {
    await browser.evaluate(`document.querySelector('[data-settings-item="${id}"]')?.click()`);
    await browser.wait(650);
    results.push(await browser.evaluate(`(() => {
      const page = document.querySelector('#settings-page-${id}');
      return {
        id: '${id}',
        heading: document.querySelector('#settings-heading')?.textContent,
        pageHidden: page ? page.hidden : 'missing',
        children: page ? page.children.length : 0,
        textLen: page ? page.innerText.trim().length : 0,
      };
    })()`));
  }
  await browser.shot('qa/shots-main/settings-restored.png');
  console.log(JSON.stringify({ results, errors: browser.errors }, null, 2));
} finally { await browser.close(); }
