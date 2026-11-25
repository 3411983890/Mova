import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8768/qa/memory-fixture.html';
const browser = await launch({ width: 820, height: 1100, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(800);

  // 1) Expand the job list: 3 → all.
  const before = await browser.evaluate(`document.querySelectorAll('.memory-show-all').length && [...document.querySelectorAll('.memory-list')].at(-1).querySelectorAll('.memory-entry').length`);
  await browser.evaluate(`document.querySelector('.memory-show-all')?.click()`);
  await browser.wait(400);
  const after = await browser.evaluate(`[...document.querySelectorAll('.memory-list')].at(-1).querySelectorAll('.memory-entry').length`);

  // 2) Open the row "more" menu.
  await browser.evaluate(`(() => {
    const row = document.querySelector('.memory-entry');
    row?.querySelector('.memory-icon-button[aria-label="更多操作"]')?.click();
    return true;
  })()`);
  await browser.wait(350);
  const menu = await browser.evaluate(`(() => {
    const el = document.querySelector('.memory-menu');
    return el ? { items: [...el.querySelectorAll('button')].map(b => b.textContent), expanded: document.querySelector('.memory-icon-button[aria-label="更多操作"]')?.getAttribute('aria-expanded') } : null;
  })()`);

  // 3) Scroll to the storage + vault area.
  await browser.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await browser.wait(500);
  const storage = await browser.evaluate(`(() => {
    const sections = [...document.querySelectorAll('.memory-settings > .settings-section')];
    const storage = sections.at(-1);
    const vault = storage.querySelector('.settings-subsection');
    return {
      storageTitle: storage.querySelector('.settings-section-title')?.textContent,
      rows: storage.querySelectorAll('.settings-row').length,
      vaultTitle: vault?.querySelector('.memory-subtitle')?.textContent,
      vaultInputs: vault?.querySelectorAll('input, textarea, select').length,
      vaultFormPadding: (() => { const f = vault?.querySelector('.settings-card.memory-form'); return f ? getComputedStyle(f).padding : null; })(),
    };
  })()`);
  await browser.shot('qa/shots-main/memory-fixture-bottom.png');

  console.log(JSON.stringify({ jobsBefore: before, jobsAfter: after, menu, storage, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
