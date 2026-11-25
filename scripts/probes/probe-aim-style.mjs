import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1280, height: 900, scale: 2, url });
try {
  await browser.goto(url);
  await browser.wait(500);
  await browser.evaluate(`(() => {
    const key = JSON.stringify(['ChatMova', 'Mova', '开发 Mova 界面 HTML 原型']);
    localStorage.setItem('mova.workspace.v1', JSON.stringify({
      version: 1,
      projects: [{ name: 'Mova', chats: [{ title: '开发 Mova 界面 HTML 原型', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now() - 8.64e7, updatedAt: Date.now() }] }],
      conversations: [[key, [{ id: 'm1', text: '你好', at: Date.now(), reply: { source: 'model', status: 'done', text: '你好。' } }]]],
      aims: [[key, { goal: { title: '合并设计稿到主程序', detail: '设置页按规范重排。', status: 'active' }, plan: { steps: [
        { label: '审计设置页', status: 'done' }, { label: '接入工具', status: 'active' }, { label: '回归', status: 'pending' },
      ] } }]],
      usage: [],
    }));
    return true;
  })()`);
  await browser.goto(url);
  await browser.wait(600);
  await browser.evaluate(`document.querySelector('.chat-row .chat-open')?.click()`);
  await browser.wait(600);
  await browser.evaluate(`document.querySelector('#chat-aim').click()`);
  await browser.wait(600);
  const style = await browser.evaluate(`(() => {
    const el = document.querySelector('#aim-goal-title');
    const cs = getComputedStyle(el);
    const done = document.querySelector('.aim-step[data-status="done"] .aim-step-label');
    const dcs = done ? getComputedStyle(done) : null;
    return {
      goal: { color: cs.color, decoration: cs.textDecorationLine, bgImage: cs.backgroundImage.slice(0, 60), fillColor: cs.webkitTextFillColor, font: cs.fontSize + ' ' + cs.fontWeight },
      doneLabel: dcs ? { color: dcs.color, decoration: dcs.textDecorationLine } : null,
    };
  })()`);
  const box = await browser.evaluate(`(() => { const r = document.querySelector('#aim-panel').getBoundingClientRect(); return { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 }; })()`);
  await browser.shot('qa/shots-main/aim-zoom.png', { clip: box });
  console.log(JSON.stringify({ style, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
