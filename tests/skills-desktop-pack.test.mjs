// electron/skills/packs/desktop-control 的技能包测试：manifest 与真实工具一一对齐、授权拒绝时零副作用、
// 截图两条链路（有/无 chatImages）、handoff 超时预算与真实上限的关系、畸形参数收敛。
// 全部纯内存 fake：不启动 Electron、不注入真实鼠标键盘、不截真实屏幕（截图链路用的是临时目录里的一张
// 1×1 PNG 夹具文件，只为验证 data URL 的拼装与降级分支）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import desktopToolsModule from '../electron/desktop/tools.cjs';
import { assertValidManifest, validateManifest } from '../electron/skills/manifest-schema.mjs';
import { createHandlers } from '../electron/skills/packs/desktop-control/handlers.mjs';
import { HANDOFF_TIMEOUT_MS, manifest } from '../electron/skills/packs/desktop-control/manifest.mjs';

const { DESKTOP_TOOL_NAMES, createDesktopTools } = desktopToolsModule;

/** 真实的工具定义（schema / label / description / 参数），execute 在下面换成 fake。 */
const REAL_TOOLS = createDesktopTools({});

/**
 * 真实环境里 desktop_handoff 的等待上限：`electron/desktop/index.cjs` 的
 * `Math.min(Math.max(Number(input.timeoutMs) || 600000, 5000), 1800000)`。
 * 技能层的 timeoutMs 必须 ≥ 它，否则会出现「用户还在操作、技能层先放弃」。
 */
const HANDOFF_MAX_WAIT_MS = 1_800_000;

/** 1×1 透明 PNG：只为让截图链路读到一段真实的图片字节。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 用真实定义 + fake execute 拼一份桌面工具数组，并记录每次调用。 */
function fakeDesktop(replies = {}) {
  const calls = [];
  const tools = REAL_TOOLS.map(real => ({
    name: real.name,
    label: real.label,
    description: real.description,
    parameters: real.parameters,
    execute: async (id, input, signal) => {
      calls.push({ name: real.name, id, input, signal });
      const reply = typeof replies[real.name] === 'function'
        ? replies[real.name](input)
        : (replies[real.name] ?? { ok: true });
      return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
    },
  }));
  return { tools, calls, callsOf: name => calls.filter(call => call.name === name) };
}

function makeCtx({ authorize } = {}) {
  const events = [];
  return {
    events,
    ctx: {
      callId: 'mcp-1',
      signal: undefined,
      emit: event => events.push(event),
      authorize: authorize ?? (async () => ({ allowed: true, code: 'ok' })),
    },
  };
}

function codeOf(result) {
  const text = result?.content?.find(part => part.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text)?.error ?? '';
  } catch {
    return '';
  }
}

test('manifest 全校验通过，且工具集合 / label / description / 参数与 createDesktopTools() 真实导出一致', () => {
  const validation = validateManifest(manifest);
  assert.deepEqual(validation.errors, [], 'manifest 不应有任何校验错误');
  assert.deepEqual(validation.warnings, [], 'manifest 不应有未知字段告警');
  assert.doesNotThrow(() => assertValidManifest(manifest));

  // 方案里写的「桌面 10 个」必须与真实导出对得上：多了要补文档，少了就是漏迁。
  assert.deepEqual(manifest.tools.map(def => def.name), [...DESKTOP_TOOL_NAMES]);
  assert.deepEqual(manifest.tools.map(def => def.name), REAL_TOOLS.map(tool => tool.name));
  assert.equal(manifest.tools.length, 10);

  for (const def of manifest.tools) {
    const real = REAL_TOOLS.find(tool => tool.name === def.name);
    assert.ok(real, `${def.name} 在 createDesktopTools() 里不存在`);
    assert.equal(def.label, real.label, `${def.name} 的 label 必须与真实工具一致`);
    assert.equal(def.description, real.description, `${def.name} 的 description 必须原样沿用真实英文`);
    assert.deepEqual(def.inputSchema.properties, real.parameters.properties, `${def.name} 的 parameters 必须与真实工具一致`);
    assert.deepEqual(def.inputSchema.required ?? [], real.parameters.required ?? [], `${def.name} 的 required 必须一致`);
    assert.equal(def.inputSchema.additionalProperties, false, `${def.name} 必须禁止多余参数`);
    assert.equal(def.exposure.mcp, 'on_demand', `${def.name} 不许进 core`);
    assert.equal(def.exposure.piAi, true);
    assert.equal(def.imageOutput, def.name === 'desktop_screenshot', '只有截图工具是 imageOutput');
    assert.ok(def.mcpSummary.length <= 160 && !def.mcpSummary.includes('\n'), `${def.name} 的 mcpSummary 必须一行 ≤160`);
    if (def.risk === 'write' || def.risk === 'exec') {
      assert.notEqual(def.approval.mode, 'none', `${def.name} 是 ${def.risk}，必须过审批闸门`);
    }
    // 只读工具按真实副作用判定：窗口/结构/等待/截图/读文本都不改变系统状态。
    if (['desktop_windows', 'desktop_snapshot', 'desktop_wait', 'desktop_screenshot', 'desktop_read'].includes(def.name)) {
      assert.equal(def.risk, 'read', `${def.name} 应当只读`);
    }
    if (['desktop_act', 'desktop_batch', 'desktop_app', 'desktop_handoff'].includes(def.name)) {
      assert.equal(def.risk, 'exec', `${def.name} 会真的操作界面，风险必须是 exec`);
      assert.deepEqual(def.approval, { mode: 'policy', capability: 'exec', allowSession: true });
    }
  }

  assert.equal(manifest.permissions.desktop, true);
  assert.equal(manifest.permissions.fs, 'read', '截图要落盘再读回来，fs 至少是 read');
  assert.deepEqual(manifest.dependencies, ['desktop']);
  assert.equal(manifest.sessionPolicy.allowBrowserOnly, false, '浏览器专属会话不加载桌面操控');
});

test('deps.desktop 缺失 → createHandlers 返回 {}（整包不生效而不是半残）', () => {
  assert.deepEqual(createHandlers(), {});
  assert.deepEqual(createHandlers({}), {});
  assert.deepEqual(createHandlers({ desktop: null }), {});
  assert.deepEqual(createHandlers({ desktop: [] }), {});
  assert.deepEqual(createHandlers({ desktop: () => [] }), {});
});

test('desktop_act 在 ctx.authorize() 拒绝时零副作用（真实 click 一次都没跑）', async () => {
  const desktop = fakeDesktop();
  const handlers = createHandlers({ desktop: desktop.tools });
  const { ctx, events } = makeCtx({
    authorize: async () => ({ allowed: false, code: 'approval_denied', reason: '用户拒绝了这次桌面操作' }),
  });

  const result = await handlers.desktop_act({ action: 'click', target: 'w1.b7' }, ctx);

  assert.equal(result.isError, true);
  assert.equal(codeOf(result), 'approval_denied');
  assert.equal(desktop.calls.length, 0, '被拒绝的输入注入必须一次都不执行');
  assert.ok(events.some(event => event.type === 'notice' && event.text.includes('已拒绝')), '拒绝必须留下旁白');
});

test('desktop_act 授权通过后委托给真实 execute（同一个 callId，参数原样过去）', async () => {
  const desktop = fakeDesktop({ desktop_act: { ok: true, tier: 't1' } });
  const handlers = createHandlers({ desktop: desktop.tools });
  const { ctx } = makeCtx();

  const result = await handlers.desktop_act({ action: 'type', target: 'w1.b3', value: '季度报表', junk: 'x' }, ctx);

  assert.equal(result.isError, undefined);
  assert.equal(desktop.callsOf('desktop_act').length, 1);
  assert.equal(desktop.callsOf('desktop_act')[0].id, 'mcp-1');
  assert.deepEqual(desktop.callsOf('desktop_act')[0].input, { action: 'type', target: 'w1.b3', value: '季度报表' });
});

test('desktop_screenshot 有 chatImages：落盘并挂 image（尺寸进 name）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mova-desktop-shot-'));
  try {
    const path = join(dir, 'shot.png');
    writeFileSync(path, PNG_1X1);
    const desktop = fakeDesktop({
      desktop_screenshot: { ok: true, path, width: 1280, height: 800, mode: 'window' },
    });
    const saved = [];
    const chatImages = {
      saveImage: async attachment => {
        saved.push(attachment);
        return { id: 'a'.repeat(64) + '.png', name: attachment.name };
      },
    };
    const handlers = createHandlers({ desktop: desktop.tools, chatImages });
    const { ctx } = makeCtx();

    const result = await handlers.desktop_screenshot({ mode: 'window' }, ctx);

    assert.equal(result.isError, undefined);
    assert.equal(saved.length, 1, '截图成功后必须调用一次 chatImages.saveImage');
    assert.ok(saved[0].dataUrl.startsWith('data:image/png;base64,'), 'dataUrl 必须带正确的 mime 前缀');
    assert.deepEqual(result.image, {
      id: 'a'.repeat(64) + '.png',
      name: '桌面截图 · 1280×800',
      src: `./chat-images/${'a'.repeat(64)}.png`,
    });
    assert.equal(result.detail, '1280×800');

    // 技能运行时是逐调用把 chatImages 放进 ctx 的：那条路径也必须认。
    const fromCtx = {
      saveImage: async attachment => ({ id: 'from-ctx.png', name: attachment.name }),
    };
    const second = await handlers.desktop_screenshot({}, { ...ctx, chatImages: fromCtx });
    assert.equal(second.image.id, 'from-ctx.png');
    assert.equal(second.image.name, '桌面截图 · 1280×800');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop_screenshot 无 chatImages：不落盘、正文仍有尺寸、发一条 warn 旁白且不报错', async () => {
  const desktop = fakeDesktop({
    desktop_screenshot: { ok: true, path: join(tmpdir(), 'not-used.png'), width: 640, height: 480 },
  });
  const handlers = createHandlers({ desktop: desktop.tools });
  const { ctx, events } = makeCtx();

  const result = await handlers.desktop_screenshot({ mode: 'thumb' }, ctx);

  assert.equal(result.isError, undefined, '缺 chatImages 只能降级，不许失败');
  assert.equal(result.image, undefined);
  assert.match(result.content[0].text, /"width":640/, '正文里要能看到尺寸');
  assert.match(result.content[0].text, /"height":480/);
  const notices = events.filter(event => event.type === 'notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tone, 'warn');
  assert.match(notices[0].text, /640×480/);
});

test('desktop_screenshot 的 chatImages 抛错也只降级（截图本身已经成功）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mova-desktop-shot-'));
  try {
    const path = join(dir, 'shot.png');
    writeFileSync(path, PNG_1X1);
    const desktop = fakeDesktop({ desktop_screenshot: { ok: true, path, width: 100, height: 50 } });
    const handlers = createHandlers({
      desktop: desktop.tools,
      chatImages: { saveImage: async () => { throw new Error('quota-exceeded'); } },
    });
    const { ctx, events } = makeCtx();

    const result = await handlers.desktop_screenshot({}, ctx);

    assert.equal(result.isError, undefined);
    assert.equal(result.image, undefined);
    assert.ok(events.some(event => event.type === 'notice' && event.text.includes('quota-exceeded')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop_handoff 的 timeoutMs ≥ handoff() 的真实上限（1_800_000ms）', () => {
  const def = manifest.tools.find(tool => tool.name === 'desktop_handoff');
  assert.ok(def, 'desktop_handoff 必须在这个包里');
  assert.ok(def.timeoutMs >= HANDOFF_MAX_WAIT_MS,
    `技能层 ${def.timeoutMs}ms 比桌面引擎的 ${HANDOFF_MAX_WAIT_MS}ms 上限还短，用户还在操作技能层就会先放弃`);
  assert.equal(def.timeoutMs, HANDOFF_TIMEOUT_MS);
  // 不能只比 handoff 自己：包里任何工具的超时都必须比它短，否则「最长等待」就没有意义。
  for (const tool of manifest.tools) {
    if (tool.name === 'desktop_handoff') continue;
    assert.ok(tool.timeoutMs < HANDOFF_TIMEOUT_MS, `${tool.name} 的超时不该超过 handoff`);
  }
});

test('参数非法 → isError + invalid_arguments，且真实工具一次都没被调用', async () => {
  const desktop = fakeDesktop();
  const handlers = createHandlers({ desktop: desktop.tools });
  const { ctx } = makeCtx();

  const cases = [
    ['desktop_act', {}, '缺 action'],
    ['desktop_act', { action: 'key' }, 'key 缺 keys'],
    ['desktop_act', { action: 'teleport' }, 'action 不在枚举里'],
    ['desktop_wait', { for: 'nope' }, 'for 不在枚举里'],
    ['desktop_screenshot', { maxLongEdge: 5 }, 'maxLongEdge 越界'],
    ['desktop_app', { action: 'launch' }, '缺 app'],
    ['desktop_batch', {}, 'steps 与 recipe 都没有'],
    ['desktop_skill', { action: 'remove' }, 'remove 缺 id'],
    ['desktop_handoff', {}, '缺 reason'],
    ['desktop_windows', { limit: 'abc' }, 'limit 不是数字'],
  ];

  for (const [name, args, why] of cases) {
    const result = await handlers[name](args, ctx);
    assert.equal(result.isError, true, `${name} ${why} 必须返回 isError`);
    assert.equal(codeOf(result), 'invalid_arguments', `${name} ${why} 的错误码必须是 invalid_arguments`);
  }
  assert.equal(desktop.calls.length, 0, '参数非法时不许调到真实桌面工具');
});

test('只读工具免审批（ctx.authorize 一次都没被调用），执行工具必然过闸门', async () => {
  const desktop = fakeDesktop();
  const seen = [];
  const handlers = createHandlers({ desktop: desktop.tools });
  const { ctx } = makeCtx({
    authorize: async () => {
      seen.push('authorize');
      return { allowed: true, code: 'ok' };
    },
  });

  await handlers.desktop_windows({ action: 'list' }, ctx);
  await handlers.desktop_snapshot({}, ctx);
  assert.equal(seen.length, 0, '只读工具不该弹审批');

  await handlers.desktop_act({ action: 'click', target: 'w1.b1' }, ctx);
  await handlers.desktop_handoff({ reason: 'login' }, ctx);
  assert.equal(seen.length, 1, 'handoff 是安全出口，刻意不过技能层审批；只有 act 进来了');
});

/**
 * 引擎形态（`{ tools(callOptions) }`）的假实现：把 createDesktopTools 收到的 approve 记下来，
 * 并让每个 execute 真的去调它一次——模拟 electron/desktop/tools.cjs 里 desktop_act 的 R3 审批。
 */
function fakeEngine({ approveInside = true } = {}) {
  const calls = [];
  const seen = { approve: null, approveCalls: [] };
  const engine = {
    tools(callOptions = {}) {
      seen.approve = typeof callOptions.approve === 'function' ? callOptions.approve : null;
      return REAL_TOOLS.map(real => ({
        name: real.name,
        label: real.label,
        description: real.description,
        parameters: real.parameters,
        execute: async (id, input) => {
          calls.push({ name: real.name, id, input });
          if (approveInside && typeof callOptions.approve === 'function') {
            // 引擎自己的 R3 闸门：真的实现里是 `await approve({...risk, tool: name}, signal)`
            const decision = await callOptions.approve({ action: 'click', target: input?.target ?? '', label: '点击' });
            if (decision === 'deny') {
              const error = new Error('用户拒绝了这次桌面操作');
              error.code = 'blocked-by-policy';
              throw error;
            }
          }
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tier: 't1' }) }] };
        },
      }));
    },
  };
  return { engine, calls, seen };
}

test('desktop_act 在技能层已授权时，交给引擎的 approve 一次都不被调用（不再弹第二次）', async () => {
  const { engine, calls, seen } = fakeEngine();
  const approveCalls = [];
  const handlers = createHandlers({
    desktop: engine,
    // 接线层的 approve（真正会弹审批条的那个）：本次调用一次都不该被调到。
    desktopApprove: async request => {
      approveCalls.push(request);
      return 'once';
    },
  });
  const { ctx } = makeCtx();

  const result = await handlers.desktop_act({ action: 'click', target: 'w1.b7' }, ctx);

  assert.equal(result.isError, undefined, '已授权的动作必须真的执行');
  assert.equal(calls.length, 1, '真实 execute 只跑一次');
  assert.equal(typeof seen.approve, 'function', '包必须把 approve 交给引擎（否则引擎的 R3 会直接报 approval-unavailable）');
  assert.equal(approveCalls.length, 0, '技能层已经问过人了：引擎层再问一次就是双弹审批');
});

test('desktop_act 在技能层拒绝时零副作用：真实 execute 与引擎的 approve 都不被调用', async () => {
  const { engine, calls, seen } = fakeEngine({ approveInside: false });
  const approveCalls = [];
  const handlers = createHandlers({
    desktop: engine,
    desktopApprove: async request => {
      approveCalls.push(request);
      return 'once';
    },
  });
  const { ctx } = makeCtx({
    authorize: async () => ({ allowed: false, code: 'approval_denied', reason: '用户拒绝了这次桌面操作' }),
  });

  const result = await handlers.desktop_act({ action: 'click', target: 'w1.b7' }, ctx);

  assert.equal(result.isError, true);
  assert.equal(codeOf(result), 'approval_denied');
  assert.equal(calls.length, 0, '被拒绝就不许碰真实工具');
  assert.equal(approveCalls.length, 0, '拒绝路径也不该走到引擎的审批');
  assert.equal(typeof seen.approve, 'function');
});

test('没过技能层闸门的工具（只读）仍把引擎的 approve 请求转给接线层（包装不是「一律放行」）', async () => {
  const { engine } = fakeEngine();
  const approveCalls = [];
  const handlers = createHandlers({
    desktop: engine,
    desktopApprove: async request => {
      approveCalls.push(request);
      return 'once';
    },
  });
  const { ctx } = makeCtx();

  const result = await handlers.desktop_windows({ action: 'list' }, ctx);

  assert.equal(result.isError, undefined);
  assert.equal(approveCalls.length, 1, '没有技能层授权时必须真的转给接线层的审批');
});

test('引擎形态缺 deps.desktopApprove 且未授权时，按引擎自己的语义报 approval-unavailable（不静默放行）', async () => {
  const { engine } = fakeEngine();
  const handlers = createHandlers({ desktop: engine });
  const { ctx } = makeCtx();

  const result = await handlers.desktop_windows({ action: 'list' }, ctx);

  assert.equal(result.isError, true, '没有审批通道的 R3 动作必须失败');
  assert.match(result.content[0].text, /approval-unavailable/);
});
