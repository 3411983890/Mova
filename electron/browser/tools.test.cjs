const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBrowserTools } = require('./tools.cjs');
const { createTimingLedger } = require('./timing.cjs');

function operations(overrides = {}) {
  const calls = [];
  const record = name => async (input, ...rest) => {
    calls.push([name, input, ...rest]);
    return { ok: true, url: 'https://shop.example.com/cart', mode: 'full', text: '- button "保存"' };
  };
  return {
    calls,
    navigate: record('navigate'),
    snapshot: record('snapshot'),
    read: record('read'),
    wait: record('wait'),
    act: record('act'),
    dialog: record('dialog'),
    runJs: record('runJs'),
    storageExport: record('storageExport'),
    storageImport: record('storageImport'),
    upload: record('upload'),
    batch: async (steps, options) => {
      calls.push(['batch', steps, options]);
      return { ok: true, steps: [], ms: 1 };
    },
    login: record('login'),
    handoff: record('handoff'),
    screenshot: async input => ({ path: 'C:\\tmp\\shot.jpg', mimeType: 'image/jpeg', mode: input.mode }),
    pointer: record('pointer'),
    tabs: () => ({ ok: true, tabs: [] }),
    newTab: record('newTab'),
    selectTab: record('selectTab'),
    closeTab: record('closeTab'),
    skillList: async () => ({ ok: true, skills: [] }),
    skillSave: record('skillSave'),
    skillRemove: record('skillRemove'),
    emit: () => {},
    approve: async () => 'once',
    getUrl: () => 'https://shop.example.com/cart',
    getPrefs: () => ({ agent: { tier: 'interact', confirmPerSite: false } }),
    timing: null,
    ...overrides,
  };
}

const byName = tools => Object.fromEntries(tools.map(tool => [tool.name, tool]));

function textOf(response) {
  return JSON.parse(response.content[0].text);
}

test('navigate forwards observe and returns the observation in one call', async () => {
  const ops = operations();
  const tools = byName(createBrowserTools(ops));
  const response = await tools.browser_navigate.execute('t1', { url: 'https://shop.example.com/cart' });
  const body = textOf(response);
  assert.equal(body.ok, true);
  assert.equal(body.text, '- button "保存"');
  const call = ops.calls.find(item => item[0] === 'navigate');
  assert.equal(call[1], 'https://shop.example.com/cart');
  assert.equal(call[3].observe, undefined, '默认 auto：由控制器决定，不是 none');
  await tools.browser_navigate.execute('t1b', { url: 'https://shop.example.com/cart', observe: 'none' });
  assert.equal(ops.calls.filter(item => item[0] === 'navigate').at(-1)[3].observe, 'none');
});

test('a timeout becomes an explicit unknown outcome with advice, not a silent failure', async () => {
  const ops = operations({
    act: async () => {
      const error = new Error('动作超时');
      error.code = 'action-timeout';
      error.indeterminate = true;
      throw error;
    },
  });
  const tools = byName(createBrowserTools(ops));
  const response = await tools.browser_act.execute('t2', { action: 'click', target: '#pay' });
  assert.equal(response.isError, true);
  const body = textOf(response);
  assert.equal(body.code, 'action-timeout');
  assert.equal(body.outcome, 'unknown');
  assert.equal(body.indeterminate, true);
  assert.match(body.suggestion, /不要重复提交/);
});

test('snapshot and wait forward the on-demand frame and conditional-wait options', async () => {
  const ops = operations();
  const tools = byName(createBrowserTools(ops));
  await tools.browser_snapshot.execute('t3', { frames: 'index', ref: '@e12' });
  await tools.browser_snapshot.execute('t4', { frame: 'f1' });
  await tools.browser_wait.execute('t5', { for: 'settle', quietMs: 200 });
  const snapshots = ops.calls.filter(item => item[0] === 'snapshot');
  assert.equal(snapshots[0][1].frames, 'index');
  assert.equal(snapshots[0][1].ref, '@e12');
  assert.equal(snapshots[1][1].frame, 'f1');
  assert.equal(ops.calls.find(item => item[0] === 'wait')[1].for, 'settle');
});

test('tool time lands in the run ledger, including failures', async () => {
  const timing = createTimingLedger({ now: () => 0 });
  const ops = operations({ timing });
  const tools = byName(createBrowserTools(ops));
  await tools.browser_snapshot.execute('t6', {});
  const failing = {
    ...operations(),
    act: async () => { const error = new Error('boom'); error.code = 'stale-element'; throw error; },
  };
  const failingTools = byName(createBrowserTools({ ...failing, timing }));
  await failingTools.browser_act.execute('t7', { action: 'click', target: '#x' });
  const rows = timing.rows().filter(row => row.category === 'tool');
  assert.deepEqual(rows.map(row => row.name), ['browser_snapshot', 'browser_act']);
  assert.equal(rows[1].ok, false);
  assert.equal(rows[1].code, 'stale-element');
});

test('batch forwards its steps and authorization hook, and a recipe is a single call', async () => {
  const ops = operations();
  const tools = byName(createBrowserTools(ops));
  await tools.browser_batch.execute('t8', { steps: [{ op: 'click', target: '#a' }, { op: 'wait', for: 'settle' }] });
  const [, steps, options] = ops.calls.find(item => item[0] === 'batch');
  assert.equal(steps.length, 2);
  assert.equal(options.snapshot, 'end');
  assert.equal(typeof options.authorize, 'function');
});

test('handoff time is recorded as human wait, not as tool work', async () => {
  const timing = createTimingLedger({ now: () => 0 });
  const ops = operations({ timing, handoff: async () => ({ ok: true, resumed: true }) });
  const tools = byName(createBrowserTools(ops));
  await tools.browser_handoff.execute('t9', { reason: 'captcha' });
  const human = timing.rows().filter(row => row.category === 'human');
  assert.deepEqual(human.map(row => row.name), ['handoff']);
  assert.equal(timing.summary().toolActiveMs >= 0, true);
});

test('buy now and checkout clicks run without a handoff or an extra prompt', async () => {
  const approvals = [];
  const ops = operations({ approve: async request => { approvals.push(request); return 'once'; } });
  const tools = byName(createBrowserTools(ops));
  for (const label of ['立即购买', '确认支付', '提交订单']) {
    const response = await tools.browser_act.execute(`buy-${label}`, { action: 'click', target: label });
    assert.equal(response.isError, undefined, `${label} 不应被拦下`);
    assert.ok(ops.calls.some(item => item[0] === 'act'), `${label} 应该真的执行`);
    assert.equal(approvals.length, 0, `${label} 在「每站点确认」关闭时不再询问`);
  }
});

test('bank-card, QR payment and password steps stop and point at browser_handoff', async () => {
  const ops = operations();
  const tools = byName(createBrowserTools(ops));
  for (const [action, target] of [['fill', 'css=#card-number'], ['click', '扫码支付'], ['fill', 'css=#password']]) {
    const response = await tools.browser_act.execute(`stop-${target}`, { action, target, value: '4242' });
    assert.equal(response.isError, true, `${target} 必须停下`);
    const body = textOf(response);
    assert.equal(body.code, 'requires-handoff');
    assert.equal(body.outcome, 'denied');
    assert.match(body.message, /本人/);
    assert.match(body.suggestion, /browser_handoff|用户确认/);
  }
  assert.equal(ops.calls.some(item => item[0] === 'act'), false, '被拦下时动作不能执行');
});

test('destructive actions still ask for confirmation even when per-site prompts are off', async () => {
  const approvals = [];
  const ops = operations({ approve: async request => { approvals.push(request); return 'once'; } });
  const tools = byName(createBrowserTools(ops));
  const response = await tools.browser_act.execute('del', { action: 'click', target: '删除账号' });
  assert.equal(response.isError, undefined);
  assert.equal(approvals.length, 1);
  assert.ok(approvals[0].reasons.includes('不可逆操作'));
  assert.equal(approvals[0].allowSession, false, '不可逆动作不能复用会话许可');
});
