import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8769/qa/memory-fixture.html';
const browser = await launch({ width: 900, height: 1400, scale: 2, url });
try {
  await browser.goto(url);
  await browser.wait(900);

  // 1) 「更多」菜单层级：把第一行滚到视口内再打开，做真实命中测试。
  await browser.evaluate(`document.querySelector('.memory-entry')?.scrollIntoView({ block: 'center' })`);
  await browser.wait(300);
  await browser.evaluate(`document.querySelector('.memory-entry .memory-icon-button[aria-label="更多操作"]')?.click()`);
  await browser.wait(350);
  const menu = await browser.evaluate(`(() => {
    const row = document.querySelector('.memory-entry');
    const el = row?.querySelector('.memory-menu');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const next = row.nextElementSibling?.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const hitLast = document.elementFromPoint(r.left + r.width / 2, r.bottom - 8);
    return {
      found: true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      nextCardTop: next ? Math.round(next.y) : null,
      overlapsNextCard: next ? r.bottom > next.y : null,
      middleHit: hit ? hit.tagName + '.' + String(hit.className || '').split(' ')[0] : null,
      bottomHit: hitLast ? hitLast.tagName + '.' + String(hitLast.className || '').split(' ')[0] : null,
      menuWinsMiddle: Boolean(hit && el.contains(hit)),
      menuWinsBottom: Boolean(hitLast && el.contains(hitLast)),
      items: [...el.querySelectorAll('button')].map(b => b.textContent),
    };
  })()`);

  const clip = await browser.evaluate(`(() => {
    const el = document.querySelector('.memory-menu');
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - 330), y: Math.max(0, r.y - 90), width: 470, height: r.height + 170 };
  })()`);
  await browser.shot('qa/shots-main/menu-above-card.png', { clip });

  // 2) 清空确认弹窗
  await browser.evaluate(`document.querySelector('.memory-menu')?.click()`);
  await browser.evaluate(`[...document.querySelectorAll('.settings-button.danger')].find(b => b.textContent.includes('清空记忆'))?.click()`);
  await browser.wait(500);
  const dialog = await browser.evaluate(`(() => {
    const d = [...document.querySelectorAll('dialog.settings-dialog')].find(d => d.open);
    if (!d) return { open: false };
    return {
      open: true,
      isModal: d.matches(':modal'),
      title: d.querySelector('h2')?.textContent,
      label: d.querySelector('label')?.textContent,
      hasInput: Boolean(d.querySelector('input')),
      footer: [...d.querySelectorAll('.settings-dialog-actions button')].map(b => ({ text: b.textContent, disabled: b.disabled })),
      inlineFormGone: !document.querySelector('.memory-confirm'),
    };
  })()`);
  await browser.shot('qa/shots-main/clear-dialog.png');

  console.log(JSON.stringify({ menu, dialog, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
