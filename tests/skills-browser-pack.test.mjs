// electron/skills/packs/browser-automation 的包级测试：manifest 合法性、工具数量与
// createBrowserTools() 的真实导出一致、缺 deps.browser 整包不暴露、拒绝时零副作用、
// browser_batch 的分步进度是否「同一 id 原地更新」、截图落盘有/无 chatImages 两条路径，
// 以及参数非法一律 isError + invalid_arguments。
// 全部纯内存：fake operations 里没有 Electron、没有 CDP、没有网络；批量走真实 batch.cjs 的 runBatch。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBatch } from '../electron/browser/batch.cjs';
import { createBrowserTools } from '../electron/browser/tools.cjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { validateManifest } from '../electron/skills/manifest-schema.mjs';
import { createHandlers } from '../electron/skills/packs/browser-automation/handlers.mjs';
import { manifest } from '../electron/skills/packs/browser-automation/manifest.mjs';

const PACK = Object.freeze({ manifest, createHandlers });

/** 1×1 透明 PNG 的 base64：只用来验证「截图二进制 → dataUrl → chatImages」这条路。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** 假的页面目标：真实 batch.cjs 的 runBatch 需要的四个原语。 */
function fakeTarget() {
  const trace = [];
  return {
    trace,
    async navigate(url, options) {
      trace.push(['navigate', url, options]);
      return { url, title: 'Example' };
    },
    async act(input) {
      trace.push(['act', input]);
      return { ok: true, summary: `${input.action} ${input.target ?? ''}`.trim() };
    },
    async wait(input) {
      trace.push(['wait', input]);
      return { ok: true };
    },
    async snapshot(input) {
      trace.push(['snapshot', input]);
      return { mode: input?.mode === 'full' ? 'full' : 'auto', text: '- button "登录"' };
    },
  };
}

/**
 * 假的控制器操作表：形状与 electron/browser/controller.cjs 传给 createBrowserTools 的一致。
 * `calls` 记录每一次「真正落到浏览器」的调用，用来断言拒绝时零副作用。
 */
function fakeOperations({ pointer = true } = {}) {
  const calls = [];
  const target = fakeTarget();
  const record = name => async (...args) => {
    calls.push([name, ...args]);
    return { ok: true, url: 'https://example.com/a', mode: 'viewport', width: 800, height: 600 };
  };
  const operations = {
    calls,
    target,
    navigate: async (url, space, options) => {
      calls.push(['navigate', url]);
      return { ok: true, url, title: 'Example', observation: { text: '- heading "Hi"' } };
    },
    snapshot: async input => {
      calls.push(['snapshot', input]);
      return { ok: true, mode: 'auto', text: '- button "登录"' };
    },
    read: record('read'),
    wait: record('wait'),
    act: record('act'),
    dialog: record('dialog'),
    runJs: record('runJs'),
    storageExport: record('storageExport'),
    storageImport: record('storageImport'),
    upload: record('upload'),
    // 真实批处理：runBatch + 假目标，语义（逐条授权/末尾快照/超时部分结果）都是真的。
    batch: async (steps, options) => {
      calls.push(['batch', steps, options]);
      return runBatch(target, steps, options);
    },
    login: record('login'),
    handoff: async input => {
      calls.push(['handoff', input]);
      return { ok: true, resumed: true };
    },
    screenshot: async input => {
      calls.push(['screenshot', input]);
      return { data: PNG_BASE64, mimeType: 'image/png', path: 'C:\\tmp\\shot.png', mode: input?.mode || 'viewport', width: 800, height: 600 };
    },
    tabs: () => ({ ok: true, tabs: [{ tabId: 't1', active: true }] }),
    newTab: record('newTab'),
    selectTab: record('selectTab'),
    closeTab: record('closeTab'),
    skillList: async () => ({ ok: true, skills: [] }),
    skillSave: async input => {
      calls.push(['skillSave', input]);
      return { ok: true, saved: { id: 's1', title: input.title } };
    },
    skillRemove: async id => {
      calls.push(['skillRemove', id]);
      return { ok: true, removed: id };
    },
    emit: () => {},
    approve: async () => 'once',
    getUrl: () => 'https://example.com/a',
    getPrefs: () => ({ agent: { tier: 'interact', confirmPerSite: false } }),
  };
  if (pointer) operations.pointer = record('pointer');
  return operations;
}

/** 允许一切的授权通道（能力位通过 + 审批 once）。 */
function allowAll() {
  return {
    permissions: { check: async () => ({ ok: true }) },
    approvals: { ask: async () => 'once' },
  };
}

function makeRuntime({ operations = fakeOperations(), ...overrides } = {}) {
  const events = [];
  const runtime = buildSkillRuntime({
    packs: [PACK],
    deps: {
      browser: createBrowserTools(operations),
      emit: event => events.push(event),
      ...allowAll(),
      ...overrides,
    },
  });
  return { runtime, events, operations };
}

function textOf(result) {
  return Array.isArray(result?.content) ? result.content.find(part => part?.type === 'text')?.text ?? '' : '';
}

function jsonOf(result) {
  try {
    return JSON.parse(textOf(result));
  } catch {
    return null;
  }
}

test('manifest 全校验通过，且工具数量与 createBrowserTools() 的真实导出逐个对得上', () => {
  const verdict = validateManifest(manifest);
  assert.deepEqual(verdict.errors, [], 'manifest 不应有任何校验错误');
  assert.deepEqual(verdict.warnings, [], 'manifest 不应有未知字段告警');

  const declared = manifest.tools.map(def => def.name);
  const real = createBrowserTools(fakeOperations()).map(tool => tool.name);
  assert.equal(real.length, 16, '真实导出应当是 16 个（browser_pointer 由控制器注入）');
  assert.equal(declared.length, 16, '方案写 16，实际也必须是 16');
  assert.deepEqual([...declared].sort(), [...real].sort(), 'manifest 与真实工具集合必须完全相同');

  const handlers = createHandlers({ browser: createBrowserTools(fakeOperations()) });
  assert.deepEqual(Object.keys(handlers).sort(), [...real].sort(), 'handler 集合必须等于真实工具集合');

  // 没有 pointer 操作时真实导出是 15 个：manifest 仍然声明 16，但 handler 少一个（缺实现不暴露）。
  const withoutPointer = createBrowserTools(fakeOperations({ pointer: false })).map(tool => tool.name);
  assert.equal(withoutPointer.length, 15);
  assert.ok(!withoutPointer.includes('browser_pointer'));
  const thinner = createHandlers({ browser: createBrowserTools(fakeOperations({ pointer: false })) });
  assert.deepEqual(Object.keys(thinner).sort(), [...withoutPointer].sort());
});

test('写/执行类一律 approval:policy，浏览器工具全部 on_demand，只有 batch 支持进度、只有 screenshot 出图', () => {
  for (const def of manifest.tools) {
    assert.ok(!def.name.startsWith('mova_'), `${def.name} 的内部名不该带 mova_ 前缀`);
    assert.equal(def.mcpName, `mova_${def.name}`);
    assert.equal(def.exposure.piAi, true);
    assert.equal(def.exposure.mcp, 'on_demand', `${def.name} 不许进 core（浏览器工具不该占 tools/list）`);
    assert.ok(def.mcpSummary.split('\n').length === 1, `${def.name} 的 mcpSummary 必须是一行`);
    if (def.risk !== 'write' && def.risk !== 'exec') continue;
    assert.equal(def.approval?.mode, 'policy', `${def.name} 是 ${def.risk} 类，必须过审批闸门`);
    assert.equal(def.approval?.capability, def.risk);
    assert.equal(def.approval?.allowSession, true);
  }
  assert.deepEqual(manifest.tools.filter(def => def.supportsProgress).map(def => def.name), ['browser_batch']);
  assert.deepEqual(manifest.tools.filter(def => def.imageOutput).map(def => def.name), ['browser_screenshot']);
  assert.equal(manifest.tools.find(def => def.name === 'browser_batch').timeoutMs, 120_000);
  assert.deepEqual(manifest.dependencies, ['browser']);
  assert.deepEqual(manifest.permissions, {
    fs: 'read', exec: false, net: true, desktop: false, browser: true, canvas: false, memory: 'read',
  });
});

test('deps.browser 缺失时 createHandlers 返回 {}（整包不暴露，registry 也跳过）', () => {
  assert.deepEqual(createHandlers({}), {});
  assert.deepEqual(createHandlers({ browser: null }), {});
  assert.deepEqual(createHandlers({ browser: [] }), {});

  const registry = buildSkillRuntime({ packs: [PACK], deps: { emit: () => {} } }).registry;
  assert.equal(registry.packs.length, 0, '缺 browser 依赖时整包不进注册表');
  assert.deepEqual(registry.skipped.map(item => item.reason), ['missing_dependencies']);
  assert.deepEqual(registry.skipped[0].missing, ['browser']);
});

test('ctx.authorize 拒绝时 browser_batch 零副作用，且不产生任何 action 调用', async () => {
  const operations = fakeOperations();
  const { runtime } = makeRuntime({
    operations,
    permissions: { check: async () => ({ ok: false, reason: '没有浏览器能力位' }) },
  });
  const result = await runtime.invoke('mova_browser_batch', {
    steps: [{ op: 'click', target: '@e1' }, { op: 'click', target: '@e2' }],
  });
  assert.equal(result.isError, true, '被拒绝必须是 isError 结果');
  const body = jsonOf(result);
  assert.equal(body.error, 'permission_denied');
  assert.equal(operations.calls.length, 0, '拒绝后浏览器一次都不许被调用（零副作用）');
  assert.equal(operations.target.trace.length, 0, '页面也不许被碰');
});

test('browser_batch 成功时进度事件是同一条时间线行的多次更新（同一 id，不新增第二行）', async () => {
  const { runtime, events, operations } = makeRuntime();
  const steps = [
    { op: 'navigate', url: 'https://example.com/list' },
    { op: 'fill', target: '@e5', value: 'Electron 45' },
    { op: 'wait', for: 'settle', quietMs: 100 },
  ];
  const result = await runtime.invoke('mova_browser_batch', { steps, snapshot: 'end' }, { callId: 'call-7' });
  assert.equal(result.isError, undefined, `批量应当成功：${textOf(result)}`);
  const payload = jsonOf(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.steps.length, 3, '三步都要有结果');
  assert.deepEqual(payload.steps.map(row => row.i), [0, 1, 2], '绝对序号必须连续');
  assert.equal(payload.snapshot?.mode, 'auto', '末尾快照只取最后一次');
  assert.equal(operations.calls.filter(item => item[0] === 'batch').length, 3, '每步一次委托');

  // 进度：同一 callId 原地更新，前端只看到一行在滚动。
  const toolEvents = events.filter(event => event.type === 'tool');
  assert.ok(toolEvents.length >= 2);
  const ids = new Set(toolEvents.map(event => event.id));
  assert.deepEqual([...ids], ['call-7'], '所有工具事件必须共用同一个 id');
  const progress = events.filter(event => event.progress && event.status === 'running');
  assert.deepEqual(progress.map(event => event.progress.step), [1, 2, 3]);
  assert.deepEqual(progress.map(event => event.progress.total), [3, 3, 3]);
  assert.deepEqual(progress.map(event => event.detail), [
    '第 1/3 步：打开「https://example.com/list」',
    '第 2/3 步：填写「@e5」',
    '第 3/3 步：等待「settle」',
  ]);
  assert.ok(progress.every(event => event.id === 'call-7'), '每一帧进度都必须原地更新同一行');
  // 时间线合并语义（app.js 的 mergeReplyEvent：同 type+id 原地覆盖）下只会有一行。
  const rows = new Map();
  for (const event of toolEvents) rows.set(`${event.type}:${event.id}`, event);
  assert.equal(rows.size, 1, '不允许出现第二行');
  const done = [...rows.values()][0];
  assert.equal(done.status, 'done');
  assert.match(done.detail, /3 步全部完成/);
});

test('browser_batch 里某一步失败时把已完成的前缀交回去，并保留真实 failedAt', async () => {
  const operations = fakeOperations();
  // 第二步的 act 返回 ok:false → batch.cjs 抛 action-failed。
  operations.target.act = async input => (input.target === '@e9'
    ? { ok: false, status: 'stale-element', message: '元素已失效' }
    : { ok: true });
  const { runtime } = makeRuntime({ operations });
  const result = await runtime.invoke('mova_browser_batch', {
    steps: [{ op: 'click', target: '@e1' }, { op: 'click', target: '@e9' }, { op: 'click', target: '@e3' }],
  });
  const payload = jsonOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedAt, 1);
  assert.equal(payload.steps.length, 2, '失败前的步骤必须保留');
  assert.equal(payload.code, 'stale-element');
  assert.equal(operations.calls.filter(item => item[0] === 'batch').length, 2, '失败后不再继续');
});

test('browser_screenshot 有 chatImages 时落盘并返回 image 元信息', async () => {
  const saved = [];
  const chatImages = {
    async saveImage(attachment) {
      saved.push(attachment);
      return { id: `${'a'.repeat(64)}.png`, name: '页面截图' };
    },
  };
  const handlers = createHandlers({ browser: createBrowserTools(fakeOperations()), chatImages });
  const events = [];
  const result = await handlers.browser_screenshot({ mode: 'viewport' }, { callId: 'shot-1', emit: event => events.push(event) });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.image, {
    id: `${'a'.repeat(64)}.png`,
    name: '页面截图 · 800×600',
    src: `./chat-images/${'a'.repeat(64)}.png`,
  });
  assert.equal(saved.length, 1);
  assert.ok(saved[0].dataUrl.startsWith('data:image/png;base64,'), '必须转成 dataUrl 再交给 chat-images');
  assert.ok(saved[0].dataUrl.endsWith(PNG_BASE64));
  assert.equal(result.detail, '页面截图 · 800×600');
  const notice = events.find(event => event.type === 'notice');
  assert.equal(notice, undefined, '落盘成功时不该有降级旁白');
});

test('browser_screenshot 没有 chatImages 时降级：不落盘、正文给尺寸、只加一条 notice', async () => {
  const handlers = createHandlers({ browser: createBrowserTools(fakeOperations()) });
  const events = [];
  const result = await handlers.browser_screenshot({ mode: 'full' }, { callId: 'shot-2', emit: event => events.push(event) });
  assert.equal(result.isError, undefined, '缺通道不许变成报错');
  assert.equal(result.image, undefined, '没有 id 就不能给 image（否则前端出现裂图）');
  const payload = jsonOf(result);
  assert.equal(payload.width, 800);
  assert.equal(payload.height, 600);
  const notices = events.filter(event => event.type === 'notice');
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /未落盘/);
  assert.match(notices[0].text, /800×600/);
  assert.match(result.detail, /未落盘/);
});

test('参数非法一律 isError + invalid_arguments（必填、枚举、上限、batch 形状）', async () => {
  const handlers = createHandlers({ browser: createBrowserTools(fakeOperations()) });
  const ctx = { callId: 'bad', emit: () => {}, authorize: async () => ({ allowed: true }) };
  const cases = [
    ['browser_navigate', {}],
    ['browser_navigate', { url: 'https://example.com', observe: 'sometimes' }],
    ['browser_act', { action: 'destroy', target: '@e1' }],
    ['browser_batch', {}],
    ['browser_batch', { steps: [] }],
    ['browser_batch', { steps: Array.from({ length: 31 }, () => ({ op: 'wait', for: 'settle' })) }],
    ['browser_batch', { steps: [{ op: 'teleport' }] }],
    ['browser_batch', { recipe: 'saved-skill', steps: [{ op: 'wait' }] }],
    ['browser_upload', { target: '@e1', files: [] }],
    ['browser_tabs', { action: 'explode' }],
  ];
  for (const [name, args] of cases) {
    const result = await handlers[name](args, ctx);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} 应当被拒绝`);
    assert.equal(jsonOf(result).error, 'invalid_arguments', `${name} 的错误码必须是 invalid_arguments`);
  }
});

test('browser_skill 只有 save/remove 过授权闸门，list 直接放行', async () => {
  const operations = fakeOperations();
  const verdicts = [];
  const handlers = createHandlers({ browser: createBrowserTools(operations) });
  const ctx = {
    callId: 'skill-1',
    emit: () => {},
    authorize: async () => {
      verdicts.push('asked');
      return { allowed: false, code: 'approval_denied', reason: '用户拒绝了' };
    },
  };
  const listed = await handlers.browser_skill({ action: 'list' }, ctx);
  assert.equal(listed.isError, undefined, 'list 是只读，不该被闸门挡住');
  assert.deepEqual(verdicts, []);

  const saved = await handlers.browser_skill({ action: 'save', title: '查库存' }, ctx);
  assert.equal(saved.isError, true);
  assert.equal(jsonOf(saved).error, 'approval_denied');
  assert.deepEqual(verdicts, ['asked']);
  assert.equal(operations.calls.some(item => item[0] === 'skillSave'), false, '拒绝后不许写技能库');
});

test('deps.browser 给工厂形态时由 pack 接管 emit：子工具的 tool 事件不会翻动同一行', async () => {
  const operations = fakeOperations();
  const factory = ({ emit }) => createBrowserTools({ ...operations, emit });
  const handlers = createHandlers({ browser: factory });
  assert.ok(handlers.browser_batch, '工厂形态也必须探测出可用工具');
  const events = [];
  const progress = [];
  const result = await handlers.browser_batch(
    { steps: [{ op: 'click', target: '@e1' }, { op: 'click', target: '@e2' }] },
    { callId: 'factory-1', emit: event => events.push(event), progress: detail => progress.push(detail), authorize: async () => ({ allowed: true }) },
  );
  assert.equal(result.isError, undefined);
  assert.equal(events.filter(event => event.type === 'tool').length, 0, '子批的 announce/settle 必须被丢掉');
  assert.equal(progress.length, 2, '进度走 ctx.progress，不自己发事件');
  assert.equal(operations.calls.filter(item => item[0] === 'batch').length, 2);
});

// ── file:// 本地文件闸门 ────────────────────────────────────────────────────
// 两层：技能层（guardLocalFile，早失败 + 好文案：根外 / 类型不允许）与浏览器层
// （electron/browser/target.cjs 的 resolveLocalFileTarget，真正的强制点，见
// tests/browser-local-files.test.mjs）。这里钉住技能层这一层的三种结论。
test('file:// 本地文件：根内可展示类型放行，类型不允许/根外一律拒绝', async () => {
  const operations = fakeOperations();
  const ctx = { callId: 'file-1', emit: () => {}, authorize: async () => ({ allowed: true }) };
  const asked = [];
  const handlers = createHandlers({
    browser: createBrowserTools(operations),
    gate: {
      async resolveInRoots(target, label) {
        asked.push({ target, label });
        if (target.toLowerCase().startsWith('c:/proj')) return target;
        throw Object.assign(new Error('路径越界'), { code: 'request' });
      },
    },
  });

  // ① 根内 + .html：放行，继续走授权与执行（控制器被调用 1 次，且 url 原样传下去）。
  const inRoot = await handlers.browser_navigate({ url: 'file:///C:/proj/design/index.html' }, ctx);
  assert.equal(inRoot.isError, undefined, `根内 html 必须放行：${textOf(inRoot)}`);
  assert.equal(asked.at(-1).target, 'C:/proj/design/index.html', 'file:///C:/… 必须还原成绝对路径再过闸门');
  const navigated = operations.calls.filter(item => item[0] === 'navigate');
  assert.equal(navigated.length, 1, '放行后必须真的调用一次浏览器导航');
  assert.match(navigated[0][1], /^file:\/\/\/C:\/proj\/design\/index\.html$/i);

  // ② 根内 + .exe（不在可展示类型里）：可读错误 + 给出可用扩展名，零副作用。
  const refused = await handlers.browser_navigate({ url: 'file:///C:/proj/tools/setup.exe' }, ctx);
  assert.equal(refused.isError, true);
  assert.equal(jsonOf(refused).error, 'file_type_not_allowed');
  assert.match(textOf(refused), /\.html/);
  assert.match(textOf(refused), /\.pdf/);
  assert.equal(operations.calls.filter(item => item[0] === 'navigate').length, 1, '类型不允许时不许碰浏览器');

  // ③ 根外：闸门抛错 → 文案不变的 file_outside_roots。
  const outside = await handlers.browser_navigate({ url: 'file:///C:/Windows/win.ini' }, ctx);
  assert.equal(outside.isError, true);
  assert.equal(jsonOf(outside).error, 'file_outside_roots');
  assert.match(textOf(outside), /本地文件只能在项目目录内打开/);
  assert.equal(operations.calls.filter(item => item[0] === 'navigate').length, 1);

  // ④ 没有闸门通道：同样拒绝（绝不因为「拿不到判定」就放行根外路径）。
  const noGate = createHandlers({ browser: createBrowserTools(fakeOperations()) });
  const noGateResult = await noGate.browser_navigate({ url: 'file:///C:/secret.html' }, ctx);
  assert.equal(jsonOf(noGateResult).error, 'file_outside_roots');
  assert.match(textOf(noGateResult), /本地文件只能在项目目录内打开/);

  // ⑤ batch 的 navigate 步骤走同一个闸门（否则绕道就能跳过）。
  const batchOutside = await handlers.browser_batch({ steps: [{ op: 'navigate', url: 'file:///C:/Windows/win.ini' }] }, ctx);
  assert.equal(batchOutside.isError, true);
  assert.equal(jsonOf(batchOutside).error, 'file_outside_roots');
  const batchType = await handlers.browser_batch({ steps: [{ op: 'navigate', url: 'file:///C:/proj/tools/setup.js' }] }, ctx);
  assert.equal(batchType.isError, true);
  assert.equal(jsonOf(batchType).error, 'file_type_not_allowed');
  assert.equal(operations.calls.some(item => item[0] === 'batch'), false, '被挡住时一步都不许执行');

  // ⑥ http(s) 一律不受影响。
  const http = await handlers.browser_navigate({ url: 'https://example.com/a' }, ctx);
  assert.equal(http.isError, undefined, `http(s) 必须照常：${textOf(http)}`);
  assert.equal(operations.calls.filter(item => item[0] === 'navigate').length, 2);
});

test('技能层的可展示扩展名清单与浏览器层同源（同一个常量，不许各抄一份）', async () => {
  const { DEFAULT_LOCAL_FILE_EXTENSIONS } = await import('../electron/browser/target.cjs');
  const operations = fakeOperations();
  const ctx = { callId: 'file-2', emit: () => {}, authorize: async () => ({ allowed: true }) };
  const handlers = createHandlers({
    browser: createBrowserTools(operations),
    gate: { async resolveInRoots(target) { return target; } },
  });
  for (const extension of DEFAULT_LOCAL_FILE_EXTENSIONS) {
    const result = await handlers.browser_navigate({ url: `file:///C:/proj/page${extension}` }, ctx);
    assert.equal(result.isError, undefined, `${extension} 应当放行：${textOf(result)}`);
  }
});
