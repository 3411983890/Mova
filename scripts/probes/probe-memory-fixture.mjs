import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8767/memory-fixture.html';
const browser = await launch({ width: 820, height: 1200, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(900);
  const info = await browser.evaluate(`(() => {
    const sections = [...document.querySelectorAll('.memory-settings > .settings-section')];
    const rows = [...document.querySelectorAll('.memory-entry')];
    const row = rows[0];
    const rowActions = row ? [...row.querySelectorAll('.memory-item-actions .memory-icon-button')] : [];
    const jobs = [...document.querySelectorAll('.memory-settings > .settings-section:nth-of-type(2) .memory-entry')];
    const showAll = document.querySelector('.memory-show-all');
    const vault = document.querySelector('.settings-subsection');
    const form = document.querySelector('.settings-card.memory-form');
    const cs = form ? getComputedStyle(form) : null;
    return {
      sectionCount: sections.length,
      sectionTitles: sections.map(s => s.querySelector('.settings-section-title')?.textContent),
      memoryRows: rows.length,
      rowIconButtons: rowActions.map(b => b.getAttribute('aria-label')),
      jobsVisible: jobs.length,
      showAllText: showAll?.textContent,
      vaultInStorage: Boolean(vault) && vault.closest('.settings-section') === sections[sections.length - 1],
      vaultTitle: vault?.querySelector('.memory-subtitle')?.textContent,
      vaultFormPadding: cs ? cs.padding : null,
      vaultFormGap: cs ? cs.rowGap : null,
      bodyText: document.body.innerText.slice(0, 120),
    };
  })()`);
  await browser.shot('qa/shots-main/memory-fixture-top.png');
  console.log(JSON.stringify({ info, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
