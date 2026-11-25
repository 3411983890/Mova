import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1280, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(600);
  const boot = await browser.evaluate(`(() => ({
    url: location.href,
    title: document.title,
    hasAim: Boolean(document.querySelector('#chat-aim')),
    hasAimPanel: Boolean(document.querySelector('#aim-panel')),
    hasUsage: Boolean(document.querySelector('#chat-usage')),
    aimHidden: document.querySelector('#chat-aim')?.hidden,
    chatMoreLabel: document.querySelector('#chat-more')?.getAttribute('aria-label'),
    errors: window.__probeErrors || null,
  }))()`);

  // Open the first sample chat, then exercise both header popovers.
  await browser.evaluate(`document.querySelector('.chat-row .chat-open')?.click()`);
  await browser.wait(500);
  const afterOpen = await browser.evaluate(`(() => ({
    header: !document.querySelector('#chat-header').hidden,
    aimHidden: document.querySelector('#chat-aim').hidden,
    aimText: document.querySelector('#chat-aim-text')?.textContent,
    aimState: document.querySelector('#chat-aim')?.dataset.state,
  }))()`);

  await browser.evaluate(`document.querySelector('#chat-more').click()`);
  await browser.wait(600);
  const usage = await browser.evaluate(`(() => {
    const panel = document.querySelector('#chat-usage');
    const r = panel.getBoundingClientRect();
    return {
      open: !panel.hidden,
      w: Math.round(r.width), h: Math.round(r.height),
      total: document.querySelector('#usage-total')?.textContent,
      totalSub: document.querySelector('#usage-total-sub')?.textContent,
      cacheRate: document.querySelector('#usage-cache-rate')?.textContent,
      cost: document.querySelector('#usage-cost')?.textContent,
      calls: document.querySelector('#usage-calls')?.textContent,
      model: document.querySelector('#chat-usage-model')?.textContent,
    };
  })()`);
  await browser.shot('qa/shots-main/usage-empty.png');

  await browser.evaluate(`document.querySelector('.chat-usage-close').click()`);
  await browser.wait(400);

  // Feed a real usage event through the same code path the agent uses.
  await browser.evaluate(`(() => {
    window.__MOVA_PROBE = true;
    return true;
  })()`);

  console.log(JSON.stringify({ boot, afterOpen, usage, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
