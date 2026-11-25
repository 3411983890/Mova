import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8768/qa/memory-fixture.html';
const browser = await launch({ width: 820, height: 1100, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(800);
  const count = `(() => { const head = document.querySelector('.memory-jobs-head'); let n = 0; let el = head?.parentElement; const kids = [...(el?.children || [])]; const start = kids.indexOf(head); for (let i = start; i < kids.length; i++) { if (kids[i].classList?.contains('memory-list')) n += kids[i].querySelectorAll('.memory-entry').length; } return n; })()`;
  const before = await browser.evaluate(count);
  const labelBefore = await browser.evaluate(`document.querySelector('.memory-show-all')?.textContent`);
  await browser.evaluate(`document.querySelector('.memory-show-all')?.click()`);
  await browser.wait(400);
  const after = await browser.evaluate(count);
  const labelAfter = await browser.evaluate(`document.querySelector('.memory-show-all')?.textContent`);
  console.log(JSON.stringify({ before, labelBefore, after, labelAfter, errors: browser.errors }, null, 2));
} finally { await browser.close(); }
