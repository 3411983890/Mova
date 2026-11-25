import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1280, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(500);
  const stored = await browser.evaluate(`(() => {
    const raw = localStorage.getItem('mova.workspace.v1');
    if (!raw) return 'no workspace';
    const d = JSON.parse(raw);
    return {
      version: d.version,
      projects: Array.isArray(d.projects) ? d.projects.length : 'missing',
      conversations: Array.isArray(d.conversations) ? d.conversations.length : 'missing',
      aims: Array.isArray(d.aims) ? d.aims.map(([k]) => k) : d.aims ?? 'missing',
      usage: Array.isArray(d.usage) ? d.usage.map(([k]) => k) : d.usage ?? 'missing',
    };
  })()`);

  // Which chat is first in the list, and which does the header show after clicking it?
  const first = await browser.evaluate(`(() => {
    const row = document.querySelector('.chat-row');
    const open = row?.querySelector('.chat-open');
    open?.click();
    return { rowText: row?.textContent?.trim().slice(0, 40) };
  })()`);
  await browser.wait(700);
  const state = await browser.evaluate(`(() => ({
    title: document.querySelector('#chat-header-title')?.textContent,
    header: !document.querySelector('#chat-header').hidden,
    aimHidden: document.querySelector('#chat-aim').hidden,
    storedAims: (() => { const d = JSON.parse(localStorage.getItem('mova.workspace.v1') || '{}'); return Array.isArray(d.aims) ? d.aims.map(([k]) => k) : d.aims ?? 'missing'; })(),
  }))()`);
  console.log(JSON.stringify({ stored, first, state, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
