import { launch } from '../../design/qa/cdp.mjs';
const url = 'http://127.0.0.1:8770/dist/index.html';
const browser = await launch({ width: 1440, height: 1000, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(700);
  await browser.evaluate(`document.querySelector('#settings-button')?.click()`);
  await browser.wait(500);
  await browser.evaluate(`document.querySelector('[data-settings-item="browser"]')?.click()`);
  await browser.wait(700);
  const info = await browser.evaluate(`(() => {
    const wrap = document.querySelector('.browser-setting-tiers');
    const choice = document.querySelector('.settings-choice');
    const input = document.querySelector('.browser-setting-input');
    const cs = el => el ? { display: getComputedStyle(el).display, dir: getComputedStyle(el).flexDirection, pad: getComputedStyle(el).padding, width: getComputedStyle(el).width } : null;
    return {
      wrap: cs(wrap),
      choice: cs(choice),
      inputWidth: input ? getComputedStyle(input).width : null,
      sheets: [...document.styleSheets].map(s => (s.href || 'inline').split('/').pop()).slice(0, 12),
      hasTiersRule: (() => { for (const s of document.styleSheets) { let rules; try { rules = s.cssRules; } catch { continue; } for (const r of rules) if (r.selectorText && r.selectorText.includes('.browser-setting-tiers')) return true; } return false; })(),
      hasChoiceRule: (() => { for (const s of document.styleSheets) { let rules; try { rules = s.cssRules; } catch { continue; } for (const r of rules) if (r.selectorText && r.selectorText.includes('.settings-choice')) return true; } return false; })(),
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
} finally { await browser.close(); }
