/* global require, AbortController, Buffer */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { createDesktopTools, DESKTOP_SYSTEM_PROMPT, DESKTOP_TOOL_NAMES } = require('../../electron/desktop/tools.cjs');

function parse(response) {
  return JSON.parse(response.content[0].text);
}

function createHarness({ settings = {}, procedures = null, overrides = {}, approve = null, vision = true } = {}) {
  const calls = [];
  const operations = {
    act: async input => {
      calls.push(['act', input]);
      return { ok: true, changed: true, tier: 't1', diff: '+1 -0' };
    },
    wait: async input => { calls.push(['wait', input]); return { ok: true, ms: 120 }; },
    snapshot: async input => { calls.push(['snapshot', input]); return { ok: true, appKey: 'excel.exe|16.0', text: '# w1 "Book1"', mode: input.mode }; },
    windows: async input => { calls.push(['windows', input]); return { ok: true, windows: [{ hwnd: 1, title: '微信', exe: 'Weixin.exe' }] }; },
    read: async input => { calls.push(['read', input]); return { ok: true, text: '正文' }; },
    screenshot: async input => { calls.push(['screenshot', input]); return { ok: true, mode: 'window', path: '', width: 800, height: 600 }; },
    app: async input => { calls.push(['app', input]); return { ok: true, action: input.action }; },
    status: () => ({ available: true, app: 'EXCEL.EXE', appKey: 'excel.exe|16.0', window: 'Book1 - Excel' }),
    settings: { get: () => ({ profile: 'standard', ...settings }) },
    ...overrides,
  };
  if (procedures) operations.procedures = procedures;
  const audit = { entries: [], async write(entry) { this.entries.push(entry); return true; } };
  const events = [];
  const tools = createDesktopTools(operations, {
    approve,
    emit: event => events.push(event),
    vision,
    audit,
  });
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  return { tools, byName, calls, events, audit, operations };
}

test('暴露 10 个工具，参数是合法 JSON Schema', () => {
  const { tools } = createHarness();
  assert.deepEqual(tools.map(tool => tool.name), DESKTOP_TOOL_NAMES);
  assert.equal(tools.length, 10);
  for (const tool of tools) {
    assert.equal(typeof tool.label, 'string');
    assert.ok(tool.description.length > 20, `${tool.name} 需要说明`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.parameters.properties, 'object');
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} 不该吞未知参数`);
    assert.equal(typeof tool.execute, 'function');
  }
  assert.match(DESKTOP_SYSTEM_PROMPT, /desktop_snapshot/);
  assert.match(DESKTOP_SYSTEM_PROMPT, /不可信数据/);
});

test('R0 读取直接执行，不需要审批', async () => {
  const { byName, calls, events } = createHarness();
  const response = await byName.desktop_snapshot.execute('t1', { mode: 'auto' }, new AbortController().signal);
  assert.equal(response.isError, undefined);
  assert.equal(parse(response).text, '# w1 "Book1"');
  assert.equal(calls[0][0], 'snapshot');
  assert.equal(events[0].status, 'running');
  assert.equal(events[1].status, 'done');
});

test('R3 走 approve：允许才执行，拒绝则 blocked-by-policy', async () => {
  const decisions = [];
  const harness = createHarness({
    approve: async request => { decisions.push(request); return 'once'; },
  });
  const response = await harness.byName.desktop_act.execute('t2', { action: 'key', keys: 'Ctrl+S' }, new AbortController().signal);
  assert.equal(response.isError, undefined);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].level, 'R3');
  assert.equal(decisions[0].allowSession, true);
  assert.equal(harness.calls.length, 1);

  const denied = createHarness({ approve: async () => 'deny' });
  const blocked = await denied.byName.desktop_act.execute('t3', { action: 'key', keys: 'Ctrl+S' }, new AbortController().signal);
  assert.equal(blocked.isError, true);
  assert.equal(parse(blocked).code, 'blocked-by-policy');
  assert.equal(denied.calls.length, 0, '被拒绝的动作绝不执行');
});

test('没有审批通道时 R3 失败而不是静默放行', async () => {
  const harness = createHarness();
  const response = await harness.byName.desktop_act.execute('t4', { action: 'invoke', target: '保存' }, new AbortController().signal);
  assert.equal(response.isError, true);
  const body = parse(response);
  assert.equal(body.code, 'approval-unavailable');
  assert.match(body.hint, /电脑操作/);
  assert.equal(harness.calls.length, 0);
});

test('R4 直接 requires-handoff，绝不执行', async () => {
  let asked = 0;
  const harness = createHarness({ approve: async () => { asked += 1; return 'once'; } });
  const response = await harness.byName.desktop_act.execute('t5', { action: 'click', target: '密码' }, new AbortController().signal);
  assert.equal(response.isError, true);
  const body = parse(response);
  assert.equal(body.code, 'requires-handoff');
  assert.equal(body.detail.level, 'R4');
  assert.match(body.hint, /desktop_handoff/);
  assert.equal(asked, 0, 'R4 不进入审批，直接交接');
  assert.equal(harness.calls.length, 0);
});

test('desktop_act 写审计但不写输入值', async () => {
  const { byName, audit } = createHarness();
  await byName.desktop_act.execute('t6', { action: 'type', target: 'w1.b3', value: '机密内容' }, new AbortController().signal);
  assert.equal(audit.entries.length, 1);
  const entry = audit.entries[0];
  assert.equal(entry.action, 'type');
  assert.equal(typeof entry.target, 'string');
  assert.equal(JSON.stringify(entry).includes('机密内容'), false, '审计不能出现输入值');
});

test('desktop_batch 逐步执行，失败即停', async () => {
  let actCalls = 0;
  const harness = createHarness({
    overrides: {
      act: async input => {
        actCalls += 1;
        if (input.target === 'w1.b2') return { ok: false, code: 'disabled', message: '控件不可用' };
        return { ok: true, tier: 't1' };
      },
    },
  });
  const response = await harness.byName.desktop_batch.execute('t7', {
    steps: [
      { op: 'click', target: 'w1.b1' },
      { op: 'click', target: 'w1.b2' },
      { op: 'click', target: 'w1.b3' },
    ],
  }, new AbortController().signal);
  const body = parse(response);
  assert.equal(body.ok, false);
  assert.equal(body.failedAt, 1);
  assert.equal(body.steps.length, 2);
  assert.equal(body.steps[1].code, 'disabled');
  assert.equal(actCalls, 2, '失败后不再继续第三步');
});

test('desktop_batch 重放技能：{{param}} 替换 + 统计回写', async () => {
  const reported = [];
  const procedures = {
    async get(id) {
      return {
        id,
        appKey: 'excel.exe|16.0',
        steps: [
          { op: 'invoke', target: { stableKey: 'aid:Tab6' } },
          { op: 'type', target: { stableKey: 'aid:Name' }, value: '{{p1}}' },
        ],
        params: [{ name: 'p1', default: '默认名.xlsx' }],
      };
    },
    async report(id, stats) { reported.push([id, stats]); return stats; },
  };
  const harness = createHarness({ procedures });
  const response = await harness.byName.desktop_batch.execute('t8', { recipe: 'dp_123', inputs: { p1: '报表.xlsx' } }, new AbortController().signal);
  const body = parse(response);
  assert.equal(body.ok, true);
  assert.equal(body.recipe, 'dp_123');
  // 重放时 target 会被解析成会话能吃的形状：拿得到活 ref 就用 ref，否则退化成 stable:<key>。
  // 两种都算对——重点是 stableKey 没丢（老实现会把对象整个塞给 session.act，报 [object Object]）。
  // 注意 calls 里可能先有一次 snapshot（重放前要重新取快照），所以按名字找 act。
  const acts = harness.calls.filter(call => call[0] === 'act');
  const firstTarget = acts[0][1].target;
  const targetKey = firstTarget && typeof firstTarget === 'object' ? firstTarget.stableKey : String(firstTarget || '');
  assert.match(String(targetKey), /aid:Tab6/);
  assert.equal(acts[1][1].value, '报表.xlsx');
  assert.equal(reported[0][0], 'dp_123');
});

test('desktop_batch 用默认参数补空、限制 30 步', async () => {
  const procedures = {
    async get() {
      return { id: 'dp_9', steps: [{ op: 'type', target: 'w1.b1', value: '{{p1}}' }], params: [{ name: 'p1', default: '默认' }] };
    },
  };
  const harness = createHarness({ procedures });
  await harness.byName.desktop_batch.execute('t9', { recipe: 'dp_9' }, new AbortController().signal);
  assert.equal(harness.calls[0][1].value, '默认');

  const tooMany = await harness.byName.desktop_batch.execute('t10', {
    steps: Array.from({ length: 31 }, () => ({ op: 'click', target: 'w1.b1' })),
  }, new AbortController().signal);
  assert.equal(parse(tooMany).code, 'invalid-argument');
});

test('desktop_skill: save / find / remove 都走技能库', async () => {
  const saved = [];
  const procedures = {
    async list() { return [{ id: 'dp_1', title: '导出' }]; },
    async find(input) { return [{ id: 'dp_1', title: '导出', intentScore: input.intent }]; },
    async save(input) { saved.push(input); return { id: 'dp_new', title: input.title, appKey: input.appKey, steps: input.steps, reused: false }; },
    async retire(id) { return id === 'dp_1'; },
  };
  const harness = createHarness({ procedures });
  assert.equal((await harness.byName.desktop_skill.execute('t11', { action: 'list' }, new AbortController().signal)).isError, undefined);
  const found = parse(await harness.byName.desktop_skill.execute('t12', { action: 'find', app: 'excel.exe|16.0', intent: ['透视表'] }, new AbortController().signal));
  assert.equal(found.skills.length, 1);

  const create = await harness.byName.desktop_skill.execute('t13', {
    action: 'save',
    app: 'excel.exe|16.0',
    title: '导出透视表',
    intent: ['透视表'],
    steps: [{ op: 'invoke', target: { stableKey: 'aid:Pivot' } }, { op: 'key', keys: 'Alt+F' }, { op: 'invoke', target: { stableKey: 'aid:Ok' } }],
  }, new AbortController().signal);
  assert.equal(create.isError, undefined);
  assert.equal(saved[0].appKey, 'excel.exe|16.0');
  assert.match(parse(create).hint, /desktop_batch/);

  const removed = parse(await harness.byName.desktop_skill.execute('t14', { action: 'remove', id: 'dp_1' }, new AbortController().signal));
  assert.equal(removed.ok, true);
});

test('desktop_skill save 少于 3 步会拒绝（避免垃圾技能）', async () => {
  const procedures = { async save(input) { return { id: 'x', ...input }; } };
  const harness = createHarness({ procedures });
  const response = await harness.byName.desktop_skill.execute('t15', {
    action: 'save',
    app: 'excel.exe|16.0',
    steps: [{ op: 'key', keys: 'Ctrl+S' }],
  }, new AbortController().signal);
  assert.equal(response.isError, true);
  assert.equal(parse(response).code, 'too-short');
});

test('截图默认只给 path；vision=false 时不附图片块', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mova-desktop-shot-'));
  const file = join(directory, 'shot.png');
  await writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  try {
    const shot = async () => ({ ok: true, mode: 'window', path: file, mimeType: 'image/png' });
    const wants = createHarness({ overrides: { screenshot: shot } });
    const withImage = await wants.byName.desktop_screenshot.execute('t16', { includeInResult: true }, new AbortController().signal);
    assert.equal(withImage.content.length, 2);
    assert.equal(withImage.content[1].type, 'image');

    const noImage = await wants.byName.desktop_screenshot.execute('t17', {}, new AbortController().signal);
    assert.equal(noImage.content.length, 1);

    const noVision = createHarness({ overrides: { screenshot: shot }, vision: false });
    const textOnly = await noVision.byName.desktop_screenshot.execute('t18', { includeInResult: true }, new AbortController().signal);
    assert.equal(textOnly.content.length, 1, '模型不支持图片时只透传 path');
    assert.equal(parse(textOnly).path, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('视觉关闭时截图直接失败', async () => {
  const harness = createHarness({ settings: { advanced: { vision: false } } });
  const response = await harness.byName.desktop_screenshot.execute('t19', {}, new AbortController().signal);
  assert.equal(parse(response).code, 'vision-disabled');
});

test('desktop_handoff 在引擎没有该能力时也不会崩', async () => {
  const harness = createHarness();
  const response = await harness.byName.desktop_handoff.execute('t20', { reason: 'uac', note: '请手动点“是”' }, new AbortController().signal);
  assert.equal(response.isError, undefined);
  const body = parse(response);
  assert.equal(body.ok, true);
  assert.equal(body.resumed, false);

  const withHandoff = createHarness({ overrides: { handoff: async input => ({ ok: true, resumed: true, reason: input.reason }) } });
  assert.equal(parse(await withHandoff.byName.desktop_handoff.execute('t21', { reason: 'password' }, new AbortController().signal)).resumed, true);
});

test('引擎缺能力时返回 not-implemented，而不是 TypeError', async () => {
  const harness = createHarness({ overrides: { snapshot: undefined } });
  const response = await harness.byName.desktop_snapshot.execute('t22', {}, new AbortController().signal);
  assert.equal(response.isError, true);
  assert.equal(parse(response).code, 'not-implemented');
});

test('desktop_windows 支持 displays / 过滤与上限', async () => {
  const harness = createHarness();
  await harness.byName.desktop_windows.execute('t23', { action: 'list', app: 'Weixin', limit: 999 }, new AbortController().signal);
  assert.equal(harness.calls[0][1].limit, 50);
  assert.equal(harness.calls[0][1].app, 'Weixin');

  const displays = createHarness({ overrides: { displays: async () => ({ ok: true, displays: [{ id: 1, primary: true }] }) } });
  const body = parse(await displays.byName.desktop_windows.execute('t24', { action: 'displays' }, new AbortController().signal));
  assert.equal(body.displays.length, 1);
});

test('desktop_snapshot 附上技能召回摘要', async () => {
  const procedures = { async find() { return [{ id: 'dp_1', title: '导出透视表', stepCount: 4 }]; } };
  const harness = createHarness({ procedures });
  const body = parse(await harness.byName.desktop_snapshot.execute('t25', {}, new AbortController().signal));
  assert.equal(body.skills[0].id, 'dp_1');
});
