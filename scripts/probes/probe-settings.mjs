import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1440, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(600);
  await browser.evaluate(`document.querySelector('#settings-button')?.click()`);
  await browser.wait(700);
  const pages = ['config', 'usage', 'models', 'memory', 'mcp', 'archive', 'service'];
  const results = [];
  for (const page of pages) {
    await browser.evaluate(`document.querySelector('[data-settings-item="${page}"]')?.click()`);
    await browser.wait(900);
    const info = await browser.evaluate(`(() => {
      const active = document.querySelector('[data-settings-item].selected');
      const pageEl = [...document.querySelectorAll('.settings-page')].find(p => !p.hidden);
      const heading = document.querySelector('#settings-heading')?.textContent;
      const firstCard = pageEl?.querySelector('.settings-card');
      const cardStyle = firstCard ? getComputedStyle(firstCard) : null;
      const pageRect = pageEl?.getBoundingClientRect();
      return {
        nav: active?.textContent?.trim(),
        ariaCurrent: active?.getAttribute('aria-current'),
        heading,
        pageId: pageEl?.id,
        pageW: pageRect ? Math.round(pageRect.width) : null,
        pageX: pageRect ? Math.round(pageRect.x) : null,
        cardPadding: cardStyle ? cardStyle.padding : null,
        cardBg: cardStyle ? cardStyle.backgroundColor : null,
        emptyish: (pageEl?.innerText || '').trim().length < 40,
        text: (pageEl?.innerText || '').trim().slice(0, 60).replace(/\\s+/g, ' '),
      };
    })()`);
    results.push({ page, ...info });
    await browser.shot(`qa/shots-main/settings-${page}.png`);
  }
  console.log(JSON.stringify({ results, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
