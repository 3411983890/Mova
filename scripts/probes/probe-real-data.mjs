import { launch } from '../../design/qa/cdp.mjs';

const url = process.env.URL || 'http://127.0.0.1:8766/';
const browser = await launch({ width: 1280, height: 900, scale: 1, url });
try {
  await browser.goto(url);
  await browser.wait(500);
  await browser.evaluate(`(() => {
    const key = JSON.stringify(['ChatMova', 'Mova', '开发 Mova 界面 HTML 原型']);
    const data = {
      version: 1,
      projects: [{ name: 'Mova', chats: [{ title: '开发 Mova 界面 HTML 原型', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now() - 8.64e7, updatedAt: Date.now() }] }],
      conversations: [[key, [{ id: 'msg-1', text: '你好', at: Date.now() - 3.6e6, reply: { source: 'model', status: 'done', text: '你好。' } }]]],
      aims: [[key, { goal: { title: '合并设计稿到主程序', detail: '设置页按规范重排，目标与用量接入真实数据。', status: 'active' }, plan: { steps: [
        { label: '审计设置页与规范差异', status: 'done' },
        { label: '移植设计稿独有模块', status: 'done' },
        { label: '接入目标与计划工具', status: 'active', meta: '正在收尾' },
        { label: '回归构建与浏览器验证', status: 'pending' },
      ] } }]],
      usage: [[key, { input: 184320, output: 9240, cacheRead: 261120, cacheWrite: 4096, totalTokens: 198656, cost: 0.0413, calls: 7, lastCall: { input: 41200, output: 1180 }, elapsedMs: 102000 }]],
    };
    localStorage.setItem('mova.workspace.v1', JSON.stringify(data));
    return true;
  })()`);
  await browser.goto(url);
  await browser.wait(600);
  await browser.evaluate(`document.querySelector('.chat-row .chat-open')?.click()`);
  await browser.wait(700);

  await browser.evaluate(`document.querySelector('#chat-aim').click()`);
  await browser.wait(650);
  const aim = await browser.evaluate(`(() => {
    const panel = document.querySelector('#aim-panel');
    const r = panel.getBoundingClientRect();
    return {
      open: !panel.hidden,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      title: document.querySelector('#aim-panel-title').textContent,
      goalTitle: document.querySelector('#aim-goal-title').textContent,
      goalDetail: document.querySelector('#aim-goal-detail').textContent,
      goalState: document.querySelector('#aim-goal-state').textContent,
      progress: document.querySelector('#aim-progress-text').textContent,
      fill: document.querySelector('#aim-progress-fill').style.width,
      planMeta: document.querySelector('#aim-plan-meta').textContent,
      steps: [...document.querySelectorAll('.aim-step')].map(s => ({ st: s.dataset.status, label: s.querySelector('.aim-step-label').textContent })),
    };
  })()`);
  await browser.shot('qa/shots-main/aim-real.png');

  await browser.evaluate(`document.querySelector('#chat-aim').click()`);
  await browser.wait(500);
  await browser.evaluate(`document.querySelector('#chat-more').click()`);
  await browser.wait(650);
  const usage = await browser.evaluate(`(() => ({
    total: document.querySelector('#usage-total').textContent,
    totalSub: document.querySelector('#usage-total-sub').textContent,
    cacheRate: document.querySelector('#usage-cache-rate').textContent,
    cacheSub: document.querySelector('#usage-cache-sub').textContent,
    breakdown: document.querySelector('#usage-breakdown-meta').textContent,
    inOut: document.querySelector('#usage-in-out').textContent,
    lastCall: document.querySelector('#usage-last-call').textContent,
    elapsed: document.querySelector('#usage-elapsed').textContent,
    calls: document.querySelector('#usage-calls').textContent,
    cost: document.querySelector('#usage-cost').textContent,
    segs: [...document.querySelectorAll('[data-usage-seg]')].map(s => ({ k: s.dataset.usageSeg, basis: s.style.flexBasis })),
  }))()`);
  await browser.shot('qa/shots-main/usage-real.png');

  console.log(JSON.stringify({ aim, usage, errors: browser.errors }, null, 2));
} finally {
  await browser.close();
}
