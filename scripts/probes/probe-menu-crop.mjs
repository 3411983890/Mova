import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8769/qa/memory-fixture.html';
const browser = await launch({ width: 900, height: 1400, scale: 2, url });
try {
  await browser.goto(url);
  await browser.wait(900);
  await browser.evaluate(`document.querySelector('.memory-entry')?.scrollIntoView({ block: 'center' })`);
  await browser.wait(300);
  await browser.evaluate(`document.querySelector('.memory-entry .memory-icon-button[aria-label="更多操作"]')?.click()`);
  await browser.wait(350);
  const clip = await browser.evaluate(`(() => {
    const row = document.querySelector('.memory-entry');
    const menu = row.querySelector('.memory-menu');
    const next = row.nextElementSibling;
    const r = menu.getBoundingClientRect();
    const n = next.getBoundingClientRect();
    const top = Math.min(r.top, n.top) - 60;
    const bottom = Math.max(r.bottom, n.top + 60);
    const left = Math.min(r.left, n.left) - 30;
    return { x: left, y: top, width: Math.min(760, r.right - left + 30), height: bottom - top };
  })()`);
  await browser.shot('qa/shots-main/menu-layer-crop.png', { clip });
  console.log(JSON.stringify(clip));
} finally { await browser.close(); }
