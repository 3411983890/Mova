import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8769/qa/memory-fixture.html';
const browser = await launch({ width: 900, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(900);
  await browser.evaluate(`document.querySelectorAll('.memory-entry')[0]?.scrollIntoView({ block: 'start' })`);
  await browser.wait(400);
  await browser.evaluate(`document.querySelectorAll('.memory-entry')[0]?.querySelector('.memory-icon-button[aria-label="更多操作"]')?.click()`);
  await browser.wait(400);
  const pos = await browser.evaluate(`(() => { const m = document.querySelector('.memory-menu').getBoundingClientRect(); return { x: Math.round(m.x), y: Math.round(m.y), right: Math.round(m.right), bottom: Math.round(m.bottom) }; })()`);
  await browser.shot('qa/shots-main/menu-visible.png');
  console.log(JSON.stringify(pos));
} finally { await browser.close(); }
