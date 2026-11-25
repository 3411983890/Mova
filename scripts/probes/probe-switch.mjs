import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1280, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(500);
  // Two chats: only the first has a goal + usage. Switching must swap the header state.
  await browser.evaluate(`(() => {
    const a = JSON.stringify(['ChatMova', 'Mova', '有目标的会话']);
    const b = JSON.stringify(['ChatMova', 'Mova', '没有目标的会话']);
    localStorage.setItem('mova.workspace.v1', JSON.stringify({
      version: 1,
      projects: [{ name: 'Mova', chats: [
        { title: '有目标的会话', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now(), updatedAt: Date.now() },
        { title: '没有目标的会话', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now() - 1e6, updatedAt: Date.now() - 1e6 },
      ] }],
      conversations: [
        [a, [{ id: 'm1', text: '一', at: Date.now(), reply: { source: 'model', status: 'done', text: '一' } }]],
        [b, [{ id: 'm2', text: '二', at: Date.now(), reply: { source: 'model', status: 'done', text: '二' } }]],
      ],
      aims: [[a, { goal: { title: '只有这条会话有目标', detail: '', status: 'active' }, plan: null }]],
      usage: [[a, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: 0, calls: 2, lastCall: { input: 600, output: 200 }, elapsedMs: 30000 }]],
    }));
    return true;
  })()`);
  await browser.goto(url);
  await browser.wait(700);

  const read = async () => browser.evaluate(`(() => ({
    title: document.querySelector('#chat-header-title')?.textContent,
    aimHidden: document.querySelector('#chat-aim')?.hidden,
    aimText: document.querySelector('#chat-aim-text')?.textContent,
  }))()`);

  const openByTitle = async title => {
    await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('.chat-row')].find(node => node.textContent.includes(${JSON.stringify(title)}));
      row?.querySelector('.chat-open')?.click();
      return Boolean(row);
    })()`);
    await browser.wait(600);
  };

  await openByTitle('有目标的会话');
  const withAim = await read();
  await browser.evaluate(`document.querySelector('#chat-more').click()`);
  await browser.wait(500);
  const usageA = await browser.evaluate(`document.querySelector('#usage-total').textContent`);
  await browser.evaluate(`document.querySelector('.chat-usage-close').click()`);
  await browser.wait(400);

  await openByTitle('没有目标的会话');
  const withoutAim = await read();
  await browser.evaluate(`document.querySelector('#chat-more').click()`);
  await browser.wait(500);
  const usageB = await browser.evaluate(`document.querySelector('#usage-total').textContent`);

  console.log(JSON.stringify({ withAim, usageA, withoutAim, usageB, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
