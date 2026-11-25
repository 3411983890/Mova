import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1280, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(500);
  // Seed a workspace with an aim + usage for a key we control, then reload once.
  const seeded = await browser.evaluate(`(() => {
    const key = JSON.stringify(['ChatMova', 'Mova', '开发 Mova 界面 HTML 原型']);
    const data = {
      version: 1,
      projects: [{ name: 'Mova', chats: [{ title: '开发 Mova 界面 HTML 原型', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now() - 8.64e7, updatedAt: Date.now() }] }],
      conversations: [[key, [{ id: 'msg-1', text: '你好', at: Date.now() - 3.6e6, reply: { source: 'mock', status: 'done', text: '你好。' } }]]],
      aims: [[key, { goal: { title: '合并设计稿到主程序', detail: '设置页按规范重排。', status: 'active' }, plan: { steps: [
        { label: '审计设置页', status: 'done' },
        { label: '移植模块', status: 'done' },
        { label: '接入目标工具', status: 'active', meta: '收尾中' },
        { label: '回归验证', status: 'pending' },
      ] } }]],
      usage: [[key, { input: 184320, output: 9240, cacheRead: 261120, cacheWrite: 4096, totalTokens: 198656, cost: 0.0413, calls: 7, lastCall: { input: 41200, output: 1180 }, elapsedMs: 102000 }]],
    };
    localStorage.setItem('mova.workspace.v1', JSON.stringify(data));
    return { key, aims: data.aims.length };
  })()`);

  await browser.goto(url);
  await browser.wait(300);
  const rightAfterLoad = await browser.evaluate(`(() => {
    const d = JSON.parse(localStorage.getItem('mova.workspace.v1') || '{}');
    return { aims: Array.isArray(d.aims) ? d.aims.length : d.aims ?? 'missing', usage: Array.isArray(d.usage) ? d.usage.length : d.usage ?? 'missing' };
  })()`);

  await browser.wait(1200);
  const afterIdle = await browser.evaluate(`(() => {
    const d = JSON.parse(localStorage.getItem('mova.workspace.v1') || '{}');
    return { aims: Array.isArray(d.aims) ? d.aims.length : d.aims ?? 'missing', usage: Array.isArray(d.usage) ? d.usage.length : d.usage ?? 'missing' };
  })()`);

  await browser.evaluate(`document.querySelector('.chat-row .chat-open')?.click()`);
  await browser.wait(700);
  const shown = await browser.evaluate(`(() => ({
    title: document.querySelector('#chat-header-title')?.textContent,
    aimHidden: document.querySelector('#chat-aim').hidden,
    aimText: document.querySelector('#chat-aim-text')?.textContent,
  }))()`);

  console.log(JSON.stringify({ seeded, rightAfterLoad, afterIdle, shown, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
