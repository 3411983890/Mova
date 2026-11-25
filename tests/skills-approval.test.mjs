// electron/skills/approval-bridge.mjs 的单元测试。
// 依赖形状按**真实契约**写（见 electron/skills/host-adapters.mjs）：
//   approvals.ask(request, signal)                     ← sender 已由适配器绑定，桥里没有 sender 参数
//   permissions.check({ capability, path, approvalPreset }) ← path → rootId 的反查在适配器里
//   gate.resolveInRoots(path, label)                   ← 真 gate.mjs 的算法
// 断言的是「拒绝路径一定更保守」：缺通道就拒绝、full 只免审批、read 也过路径闸门、
// 拒绝时零审计写入、允许时审计留痕、会话授权按「工具 + 能力」隔离。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApprovalCoordinator } from '../electron/skills/approval-bridge.mjs';

const WRITE_TOOL = { name: 'write_file', label: '写入文件', risk: 'write' };
const OTHER_WRITE_TOOL = { name: 'design_apply', label: '编辑设计', risk: 'write' };
const READ_TOOL = { name: 'read_file', label: '读取文件', risk: 'read' };
const SAFE_TOOL = { name: 'set_goal', label: '设置目标', risk: 'none' };

/** 真适配器契约：ask(request, signal) → 'once'|'session'|'deny'。 */
function askRecorder(decision = 'once') {
  const calls = [];
  return {
    calls,
    approvals: {
      async ask(request, signal) {
        calls.push({ request, signal });
        return typeof decision === 'function' ? decision(request) : decision;
      },
    },
  };
}

/** 真 permissions 适配器契约：只吃 { capability, path, approvalPreset }。 */
function permissionRecorder(verdict = { ok: true }) {
  const calls = [];
  return {
    calls,
    permissions: {
      async check(input) {
        calls.push(input);
        return typeof verdict === 'function' ? verdict(input) : verdict;
      },
    },
  };
}

/** 真 gate.mjs 的 resolveInRoots：返回根内真实路径，越界/无根时抛错。 */
function gateRecorder(resolveImpl) {
  const calls = [];
  return {
    calls,
    gate: {
      async resolveInRoots(path, label) {
        calls.push({ path, label });
        if (typeof resolveImpl === 'function') return resolveImpl(path);
        return `C:\\proj\\${path}`;
      },
    },
  };
}

function auditRecorder() {
  const entries = [];
  return { entries, audit: { record: async entry => entries.push(entry) } };
}

test('risk:none 直接放行，不碰任何通道', async () => {
  const { calls, approvals } = askRecorder('deny');
  const { calls: permissionCalls, permissions } = permissionRecorder({ ok: true });
  const coordinator = createApprovalCoordinator({ approvals, permissions, sender: { id: 'win-1' } });
  assert.deepEqual(await coordinator.authorize({ def: SAFE_TOOL, args: {} }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 0, '零风险工具不应该弹审批');
  assert.equal(permissionCalls.length, 0, '零风险工具不需要能力位');
});

test('risk:read 过路径闸门 → 能力位复查，授权即放行', async () => {
  const { permissions, calls: permissionCalls } = permissionRecorder({ ok: true });
  const { gate, calls: gateCalls } = gateRecorder();
  const coordinator = createApprovalCoordinator({ permissions, gate, preset: 'default' });
  assert.deepEqual(
    await coordinator.authorize({ def: READ_TOOL, args: { path: 'a.txt' }, roots: ['C:\\proj'] }),
    { allowed: true, code: 'ok' },
  );
  assert.deepEqual(gateCalls, [{ path: 'a.txt', label: 'skill' }], '读操作也必须过路径闸门');
  assert.equal(permissionCalls[0].capability, 'read', '读工具复查的是 read 能力位');
  assert.equal(permissionCalls[0].path, 'C:\\proj\\a.txt', '能力位复查用的是闸门解析后的真实路径');
  assert.equal(permissionCalls[0].approvalPreset, 'default', '预设必须透传给能力位（真 store 用它算有效能力）');
  assert.equal('rootId' in permissionCalls[0], false, '桥不许假设 store 的入参形状（rootId 由适配器填）');
});

test('risk:read 能力位未授权时拒绝，并带出 store 给的原因', async () => {
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: false, reason: 'not-granted' }) },
    gate: gateRecorder().gate,
  });
  const verdict = await coordinator.authorize({ def: READ_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'permission_denied');
  assert.match(verdict.reason, /read/);
  assert.match(verdict.reason, /not-granted/, 'store 的原因要能带到时间线上');
});

test('没有 permissions 通道时 read 被拒绝（不能当成「允许」）', async () => {
  const notices = [];
  const coordinator = createApprovalCoordinator({ gate: gateRecorder().gate, emit: event => notices.push(event) });
  const verdict = await coordinator.authorize({ def: READ_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'permission_unavailable');
  assert.equal(notices.length, 1, '缺通道要发一条 notice，让用户知道为什么被拒');
  assert.equal(notices[0].type, 'notice');
  assert.equal(notices[0].tone, 'warn');
});

test('没有 permissions 通道时 preset:full 也拒绝（full 只免审批，不免能力位）', async () => {
  const coordinator = createApprovalCoordinator({ preset: 'full', gate: gateRecorder().gate });
  const read = await coordinator.authorize({ def: READ_TOOL, args: { path: 'a.txt' } });
  assert.equal(read.allowed, false);
  assert.equal(read.code, 'permission_unavailable', 'full 不能把「没有能力位通道」变成放行');
  const write = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(write.allowed, false);
  assert.equal(write.code, 'permission_unavailable');
});

test('写操作：路径闸门 → 能力位 → 审批 → 审计，全链路允许', async () => {
  const { approvals, calls } = askRecorder('once');
  const { audit, entries } = auditRecorder();
  const { gate, calls: gateCalls } = gateRecorder();
  const { permissions, calls: permissionCalls } = permissionRecorder({ ok: true });
  const coordinator = createApprovalCoordinator({
    permissions, gate, approvals, audit, sender: { id: 'win-1' },
  });
  assert.deepEqual(
    await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' }, roots: ['C:\\proj'] }),
    { allowed: true, code: 'ok' },
  );
  assert.deepEqual(gateCalls, [{ path: 'a.txt', label: 'skill' }], '路径必须经 gate 校验');
  assert.equal(permissionCalls[0].capability, 'write');
  assert.equal(calls.length, 1, '写操作必须问一次');
  assert.equal(calls[0].request.capability, 'write');
  assert.equal(calls[0].request.path, 'C:\\proj\\a.txt', '审批卡拿到的是闸门解析后的真实路径');
  assert.equal(entries.length, 1, '允许后必须审计留痕');
  assert.equal(entries[0].decision, 'approved');
});

test('用户拒绝写操作时零审计写入（拒绝不留「已批准」的痕迹）', async () => {
  const { approvals } = askRecorder('deny');
  const { audit, entries } = auditRecorder();
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals,
    audit,
    sender: { id: 'win-1' },
  });
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'approval_denied');
  assert.equal(entries.length, 0, '被拒绝的操作不应写 audit');
});

test('路径越界（gate 抛错）时直接拒绝，不会走到审批', async () => {
  const { approvals, calls } = askRecorder('once');
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder(() => {
      const error = new Error('路径越界（符号链接）：C:\\Windows\\system32');
      error.code = 'request';
      error.detail = 'skill: 路径越界（符号链接）：C:\\Windows\\system32';
      throw error;
    }).gate,
    approvals,
    sender: { id: 'win-1' },
  });
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: '../secret.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'path_denied');
  assert.match(verdict.reason, /路径越界/);
  assert.equal(calls.length, 0, '越界路径不该浪费用户一次审批');
});

test('没有 gate 也没有 resolvePath 时写操作被拒绝（path_gate_missing，不是放行）', async () => {
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    approvals: askRecorder('once').approvals,
    sender: { id: 'win-1' },
  });
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'path_gate_missing');
});

test('preset:full + 没有 gate 时越界路径仍被拒绝（P0：full 不能绕过路径闸门）', async () => {
  const notices = [];
  const coordinator = createApprovalCoordinator({ preset: 'full', emit: event => notices.push(event) });
  const verdict = await coordinator.authorize({
    def: WRITE_TOOL,
    args: { path: '../../Windows/System32/x.dll' },
    roots: ['C:\\proj'],
  });
  assert.equal(verdict.allowed, false, 'full 只免人工审批，路径闸门必须照做');
  assert.equal(verdict.code, 'path_gate_missing');
  assert.equal(notices.length, 1, '拒绝要发 notice，避免「点了没反应」');
});

test('preset:full + 没有 gate 时 exec 工具同样被拒绝', async () => {
  const coordinator = createApprovalCoordinator({ preset: 'full' });
  const verdict = await coordinator.authorize({
    def: { name: 'run_command', label: '运行命令', risk: 'exec' },
    args: { cwd: '..\\..\\Windows' },
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'path_gate_missing');
});

test('gate 适配器报 path_gate_missing 时映射成同一个拒绝码（而不是 path_denied）', async () => {
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: {
      async resolveInRoots() {
        const error = new Error('路径闸门不可用（gate.resolveInRoots 缺失）');
        error.code = 'path_gate_missing';
        throw error;
      },
    },
    approvals: askRecorder('once').approvals,
  });
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'path_gate_missing');
});

test('没有 gate 时退化到注入的 resolvePath；返回 null 视为越界', async () => {
  const okCoordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    resolvePath: (target, roots) => (roots.includes('C:\\proj') ? `C:\\proj\\${target}` : null),
    approvals: askRecorder('once').approvals,
    sender: { id: 'win-1' },
  });
  assert.deepEqual(
    await okCoordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' }, roots: ['C:\\proj'] }),
    { allowed: true, code: 'ok' },
  );

  const denied = await okCoordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' }, roots: [] });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'path_denied');
});

test('没有审批通道时写操作被拒绝并告警（不能默默写盘）', async () => {
  const notices = [];
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    emit: event => notices.push(event),
  });
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'approval_unavailable');
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /审批通道未就绪/);
});

test('preset:full 免人工审批但仍过路径/能力位并审计（用户显式选择的自动档）', async () => {
  const { approvals, calls } = askRecorder('once');
  const { audit, entries } = auditRecorder();
  const { gate, calls: gateCalls } = gateRecorder();
  const { permissions, calls: permissionCalls } = permissionRecorder({ ok: true });
  const coordinator = createApprovalCoordinator({
    permissions, gate, approvals, audit, preset: 'full', sender: { id: 'win-1' },
  });
  assert.deepEqual(await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 0, 'full 档位不弹条');
  assert.deepEqual(gateCalls, [{ path: 'a.txt', label: 'skill' }], 'full 档位仍要过路径闸门');
  assert.equal(permissionCalls.length, 1, 'full 档位仍要复查能力位');
  assert.equal(entries[0].decision, 'auto');
});

test('approval.mode:"always" 忽略 preset:full 仍然问人', async () => {
  const { approvals, calls } = askRecorder('once');
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals,
    preset: 'full',
    sender: { id: 'win-1' },
  });
  const def = { ...WRITE_TOOL, approval: { mode: 'always', capability: 'write' } };
  assert.deepEqual(await coordinator.authorize({ def, args: { path: 'a.txt' } }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 1, 'always 模式必须问人，哪怕预设是 full');
});

test('approval.mode:"always" 对 read 工具也要问人', async () => {
  const { approvals, calls } = askRecorder('deny');
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals,
    preset: 'full',
  });
  const def = { ...READ_TOOL, approval: { mode: 'always' } };
  const verdict = await coordinator.authorize({ def, args: { path: 'a.txt' } });
  assert.equal(calls.length, 1);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'approval_denied');
});

test('approval.mode:"none" 跳过人工审批但仍过路径闸门与能力位', async () => {
  const { approvals, calls } = askRecorder('deny');
  const { gate, calls: gateCalls } = gateRecorder();
  const { permissions, calls: permissionCalls } = permissionRecorder({ ok: true });
  const coordinator = createApprovalCoordinator({ permissions, gate, approvals });
  // 防御性：risk:write + mode:none 会被 manifest 校验拒绝，这里直接构造 def 验证桥的行为。
  const def = { ...WRITE_TOOL, approval: { mode: 'none', capability: 'write' } };
  assert.deepEqual(await coordinator.authorize({ def, args: { path: 'a.txt' } }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 0, 'mode:none 不问人');
  assert.equal(gateCalls.length, 1, 'mode:none 仍过路径闸门');
  assert.equal(permissionCalls.length, 1, 'mode:none 仍复查能力位');

  // 路径越界时 mode:none 一样要被闸门拦住。
  const escaping = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder(() => {
      throw Object.assign(new Error('路径越界'), { detail: 'skill: 路径越界：C:\\Windows' });
    }).gate,
    approvals,
  });
  const verdict = await escaping.authorize({ def, args: { path: '../../Windows/x.dll' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'path_denied', 'mode:none 不是「免路径校验」');
});

test('allowSession:true 时同工具只问一次，换工具必须重新问（跨工具不串）', async () => {
  const { approvals, calls } = askRecorder('session');
  const gate = gateRecorder().gate;
  const permissions = permissionRecorder({ ok: true }).permissions;
  const def = { ...WRITE_TOOL, approval: { mode: 'policy', capability: 'write', allowSession: true } };
  const coordinator = createApprovalCoordinator({ permissions, gate, approvals, sender: { id: 'win-1' } });
  assert.deepEqual(await coordinator.authorize({ def, args: { path: 'a.txt' } }), { allowed: true, code: 'ok' });
  assert.deepEqual(await coordinator.authorize({ def, args: { path: 'b.txt' } }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 1, '同工具同能力只问一次');

  // P1：批准 design_apply 不能顺带免掉 write_file 的审批。
  const other = { ...OTHER_WRITE_TOOL, approval: { mode: 'policy', capability: 'write', allowSession: true } };
  await coordinator.authorize({ def: other, args: { path: 'c.txt' } });
  assert.equal(calls.length, 2, '换一个工具必须重新问一次');

  coordinator.resetSender('win-1');
  await coordinator.authorize({ def, args: { path: 'd.txt' } });
  assert.equal(calls.length, 3, 'resetSender 之后必须重新问');
});

test('不同 sender 的会话授权互不影响', async () => {
  const { approvals, calls } = askRecorder('session');
  const def = { ...WRITE_TOOL, approval: { mode: 'policy', capability: 'write', allowSession: true } };
  const base = {
    permissions: permissionRecorder({ ok: true }).permissions,
    gate: gateRecorder().gate,
    approvals,
  };
  const winA = createApprovalCoordinator({ ...base, sender: { id: 'win-a' } });
  const winB = createApprovalCoordinator({ ...base, sender: { id: 'win-b' } });
  await winA.authorize({ def, args: { path: 'a.txt' } });
  await winA.authorize({ def, args: { path: 'b.txt' } });
  await winB.authorize({ def, args: { path: 'c.txt' } });
  assert.equal(calls.length, 2, '两个窗口各自问一次');
});

test('allowSession:false 时每次都问', async () => {
  const { approvals, calls } = askRecorder('once');
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals,
    sender: { id: 'win-1' },
  });
  await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'b.txt' } });
  assert.equal(calls.length, 2);
});

test('exec 工具复查 exec 能力位，且选择器类参数不会被当成路径', async () => {
  const { permissions, calls: permissionCalls } = permissionRecorder({ ok: true });
  const { gate, calls: gateCalls } = gateRecorder();
  const coordinator = createApprovalCoordinator({
    permissions, gate, approvals: askRecorder('once').approvals, sender: { id: 'win-1' },
  });
  const browserTool = { name: 'browser_batch', label: '批量操作', risk: 'exec' };
  assert.deepEqual(
    await coordinator.authorize({ def: browserTool, args: { steps: [{ op: 'click', target: '@e5' }] } }),
    { allowed: true, code: 'ok' },
  );
  assert.deepEqual(permissionCalls.map(item => item.capability), ['exec']);
  assert.deepEqual(gateCalls, [], 'target=@e5 是选择器，不是文件路径，不能被闸门误判');
});

test('审批请求带上 signal，取消时不再问（长任务要能取消）', async () => {
  const { approvals, calls } = askRecorder('once');
  const controller = new AbortController();
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals,
  });
  await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' }, signal: controller.signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, controller.signal, 'signal 必须透传给审批通道');

  controller.abort();
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'b.txt' }, signal: controller.signal });
  assert.equal(verdict.code, 'aborted');
  assert.equal(calls.length, 1, '已取消的调用不该再弹条');
});

test('审批通道抛错时收敛成 approval_failed（默认拒绝）', async () => {
  const coordinator = createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals: {
      async ask() {
        throw new Error('approval ipc 断了');
      },
    },
  });
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'approval_failed');
  assert.match(verdict.reason, /approval ipc 断了/);
});

test('能力位通道抛错时收敛成 permission_failed（不是放行）', async () => {
  const coordinator = createApprovalCoordinator({
    permissions: {
      async check() {
        throw new Error('permissions.json 读不了');
      },
    },
    gate: gateRecorder().gate,
    approvals: askRecorder('once').approvals,
  });
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'permission_failed');
  assert.match(verdict.reason, /permissions\.json/);
});

test('中文路径与拒答词表：deny / rejected / cancel 一律不放行', async () => {
  for (const decision of ['deny', 'rejected', 'cancel', { allowed: false }, false]) {
    const coordinator = createApprovalCoordinator({
      permissions: { check: async () => ({ ok: true }) },
      gate: gateRecorder().gate,
      approvals: { ask: async () => decision },
      sender: { id: 'win-1' },
    });
    const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: { path: '项目/说明.md' } });
    assert.equal(verdict.allowed, false, `${JSON.stringify(decision)} 必须视为拒绝`);
  }
});

test('审计或 notice 失败时不静默：留 logger.warn，且不影响授权结论', async () => {
  const warns = [];
  const logger = { warn: text => warns.push(String(text)) };
  const base = {
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals: askRecorder('once').approvals,
    logger,
    sender: { id: 'win-1' },
  };
  const auditBroken = createApprovalCoordinator({
    ...base,
    audit: {
      async record() {
        throw new Error('磁盘只读');
      },
    },
  });
  assert.deepEqual(
    await auditBroken.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } }),
    { allowed: true, code: 'ok' },
    '审计失败不能把已批准的操作变成失败',
  );
  assert.equal(warns.length, 1, '审计失败必须留一条 warn（旧实现是空 catch）');
  assert.match(warns[0], /审计写入失败/);

  // notice 通道自己抛错：拒绝结论不变，但必须留证。
  const noticeBroken = createApprovalCoordinator({
    gate: gateRecorder().gate,
    logger,
    emit() {
      throw new Error('窗口已关闭');
    },
  });
  const verdict = await noticeBroken.authorize({ def: WRITE_TOOL, args: { path: 'a.txt' } });
  assert.equal(verdict.code, 'permission_unavailable');
  assert.equal(warns.length, 2, 'notice 失败必须留一条 warn（旧实现是空 catch）');
  assert.match(warns[1], /notice 事件发送失败/);
});

test('缺少 def 或已被取消的调用直接拒绝', async () => {
  const coordinator = createApprovalCoordinator({});
  assert.equal((await coordinator.authorize({})).code, 'invalid_def');
  const controller = new AbortController();
  controller.abort();
  const verdict = await coordinator.authorize({ def: WRITE_TOOL, args: {}, signal: controller.signal });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'aborted');
});

/* ── 审批卡的变更预览（request.preview） ─────────────────────────────────
 * 字段名不是自创的：渲染层 `src/features/approvals/approval-bar.jsx` 读的是
 * `request.preview.{kind,path,before,after,truncated}`（`actionOf` 取 kind、`hasPreviewContent`
 * 看 before/after、`FileBody` 看 truncated），行级 diff 由 `diff.js` 在渲染层算。
 */

/** 一条「能力位 ok + 闸门 ok」的最小写链路，用来观察 approvals.ask 收到的 request。 */
function writeChainFor({ approvals, logger } = {}) {
  return createApprovalCoordinator({
    permissions: { check: async () => ({ ok: true }) },
    gate: gateRecorder().gate,
    approvals: approvals ?? askRecorder('once').approvals,
    sender: { id: 'win-1' },
    ...(logger ? { logger } : {}),
  });
}

test('预览：request.preview 用渲染层认的字段名与形状（kind/path/before/after/truncated）', async () => {
  const recorder = askRecorder('once');
  const coordinator = writeChainFor({ approvals: recorder.approvals });
  const verdict = await coordinator.authorize({
    def: WRITE_TOOL,
    args: { path: 'notes.md' },
    preview: { kind: 'write', path: 'notes.md', before: '旧\n', after: '新\n' },
  });
  assert.equal(verdict.allowed, true);
  assert.deepEqual(
    recorder.calls[0].request.preview,
    { kind: 'write', path: 'notes.md', before: '旧\n', after: '新\n', truncated: false },
    '形状必须与渲染层一致，且 truncated 恒为布尔（渲染层按 === true 判断）',
  );
});

test('预览：没有预览时 request 里根本没有 preview 键（不是 preview:null）', async () => {
  const recorder = askRecorder('once');
  const coordinator = writeChainFor({ approvals: recorder.approvals });
  await coordinator.authorize({ def: WRITE_TOOL, args: { path: 'a.md' } });
  assert.equal('preview' in recorder.calls[0].request, false);
});

test('预览：延迟构造器拿到的是路径闸门解析后的真实路径，而不是模型给的原始参数', async () => {
  const recorder = askRecorder('once');
  const seen = [];
  const coordinator = writeChainFor({ approvals: recorder.approvals });
  await coordinator.authorize({
    def: WRITE_TOOL,
    args: { path: 'a.md' },
    preview: ({ path }) => {
      seen.push(path);
      return { kind: 'write', path: 'a.md', before: '', after: 'x' };
    },
  });
  assert.deepEqual(seen, ['C:\\proj\\a.md'], '闸门解析（含 realpath 逐级校验）是唯一允许拼绝对路径的地方');
  assert.equal(recorder.calls[0].request.preview.before, '', '新建文件 before 是空串，仍是合法结构');
});

test('预览：超过 300 行或 100_000 字符就截断并标注 truncated', async () => {
  const recorder = askRecorder('once');
  const coordinator = writeChainFor({ approvals: recorder.approvals });

  const manyLines = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
  await coordinator.authorize({
    def: WRITE_TOOL,
    args: { path: 'a.md' },
    preview: { kind: 'write', path: 'a.md', before: manyLines, after: '' },
  });
  const clipped = recorder.calls[0].request.preview;
  assert.equal(clipped.before.split('\n').length, 300, '一次只发 300 行（渲染层默认就只画 300 行）');
  assert.equal(clipped.truncated, true, '截断必须标注，渲染层据此写明「只发送了预览片段」');

  const huge = 'x'.repeat(150_000);
  await coordinator.authorize({
    def: WRITE_TOOL,
    args: { path: 'a.md' },
    preview: { kind: 'write', path: 'a.md', before: huge, after: '' },
  });
  const byChars = recorder.calls[1].request.preview;
  assert.equal(byChars.before.length, 100_000, '单侧字符上限 100_000（小于渲染层的 DIFF_CHAR_LIMIT 200_000）');
  assert.equal(byChars.truncated, true);
});

test('预览：构造器抛错只降级成「没有预览的卡」，授权仍然通过，并留一条 debug', async () => {
  const recorder = askRecorder('once');
  const debug = [];
  const coordinator = writeChainFor({
    approvals: recorder.approvals,
    logger: { debug: text => debug.push(String(text)), warn() {} },
  });
  const verdict = await coordinator.authorize({
    def: WRITE_TOOL,
    args: { path: 'a.md' },
    preview: () => { throw new Error('EACCES'); },
  });
  assert.equal(verdict.allowed, true, '预览失败不是授权失败');
  assert.equal('preview' in recorder.calls[0].request, false);
  assert.ok(debug.some(line => /预览构造失败/.test(line)), `必须留 debug：${debug.join('|')}`);
});
