/**
 * 负责：锁住「无文件能力不该被项目根挡死」这条判据——`permissions.fs:'none'` 的工具，以及在
 *   **没有路径参数**时声明了桌面/浏览器/画板/记忆能力位的工具，在「用户没打开任何项目文件夹」
 *   （projectRoots 空 + 能力位 store 零登记）时也能通过授权，且人工审批一步不少；
 *   同时 fs:'read'|'write' 的文件闸门一条都不放宽（回归锁）。
 * 不负责：审批桥内部规则的全覆盖（tests/skills-approval.test.mjs）、真 broker/store/gate 的集成
 *   （tests/skills-approval-integration.test.mjs）。
 * 被谁调用：`node --test tests/skills-*.test.mjs`（无 Electron、无网络、真 store 落在临时目录）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionStore } from '../electron/permissions.cjs';
import { createApprovalCoordinator } from '../electron/skills/approval-bridge.mjs';
import {
  createApprovalsAdapter, createPermissionsAdapter,
} from '../electron/skills/host-adapters.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { createSkillRuntimeForTurn } from '../electron/skills/turn-runtime.mjs';
import { createHandlers as createDesktopHandlers } from '../electron/skills/packs/desktop-control/handlers.mjs';
import { manifest as desktopManifest } from '../electron/skills/packs/desktop-control/manifest.mjs';

/** 真 store + **零登记**：就是「用户没打开项目文件夹」这一种状态（roots: []）。 */
async function emptyStore(t) {
  const base = await mkdtemp(join(tmpdir(), 'mova-skills-rootless-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = createPermissionStore({ filePath: join(base, 'permissions.json'), confirm: async () => 'allow' });
  assert.deepEqual((await store.list()).roots, [], '前置条件：store 里零登记');
  return store;
}

/** 真适配器契约 ask(request, signal) → 'once'|'session'|'deny'，额外记下问了什么。 */
function askSpy(decision = 'once') {
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

/** 能力位适配器契约的双通道 spy：记录 check / checkRootless 各自被问了什么。 */
function permissionsSpy({ rootlessVerdict = { ok: true, scope: 'rootless' } } = {}) {
  const calls = { check: [], rootless: [] };
  return {
    calls,
    permissions: {
      async check(input) {
        calls.check.push(input);
        return { ok: false, reason: 'not-granted' };
      },
      async checkRootless(input) {
        calls.rootless.push(input);
        return rootlessVerdict;
      },
    },
  };
}

function auditSpy() {
  const entries = [];
  return { entries, audit: { record: async entry => entries.push(entry) } };
}

/** 包级 permissions 的七键形状（manifest-schema 要求齐全）。 */
function perms(overrides) {
  return {
    fs: 'none', exec: false, net: false, desktop: false, browser: false, canvas: false, memory: 'none',
    ...overrides,
  };
}

/** 模拟 desktop_act：fs:'none' 的 exec 工具（主判据）。 */
const ROOTLESS_EXEC = {
  name: 'desktop_act',
  label: '操作界面',
  risk: 'exec',
  approval: { mode: 'policy', capability: 'exec', allowSession: true },
  permissions: perms({ exec: true, desktop: true }),
};

/** 模拟 write_file：fs:'write' 的文件工具（行为必须完全不变）。 */
const FILE_WRITE = {
  name: 'write_file',
  label: '写入文件',
  risk: 'write',
  approval: { mode: 'policy', capability: 'write' },
  permissions: perms({ fs: 'write', exec: true }),
};

test("1：无项目根（roots 空 + store 零登记）+ preset:'default'，fs:'none' 的 exec 工具通过且必须问人", async t => {
  const store = await emptyStore(t);
  const { approvals, calls } = askSpy('once');
  const { entries, audit } = auditSpy();
  const coordinator = createApprovalCoordinator({
    approvals, permissions: createPermissionsAdapter({ store }), audit, sender: { id: 'win-1' },
  });

  const verdict = await coordinator.authorize({ def: ROOTLESS_EXEC, args: { target: 'w1.b7' } });
  assert.deepEqual(verdict, { allowed: true, code: 'ok' }, '没有项目根不该把桌面操作挡死');
  assert.equal(calls.length, 1, 'exec 能力必须问人一次（安全边界是人工确认，不是项目目录）');
  assert.equal(calls[0].request.capability, 'exec');
  assert.equal(calls[0].request.path, undefined, 'rootless 调用没有路径可展示');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].decision, 'approved');
  assert.equal(entries[0].scope, 'rootless', '审计必须能看出这次是无文件能力工具');
  assert.equal(entries[0].path, null);
});

test('2：无 gate 时 fs:none 的 exec 能过，fs:write 的写文件仍 path_gate_missing（同一装配对比）', async () => {
  const { approvals } = askSpy('once');
  const { permissions } = permissionsSpy();
  const coordinator = createApprovalCoordinator({ approvals, permissions });

  assert.deepEqual(
    await coordinator.authorize({ def: ROOTLESS_EXEC, args: { steps: [{ op: 'click' }] } }),
    { allowed: true, code: 'ok' },
    'rootless 工具没有路径可校验，不该因为「没有闸门」被拒',
  );

  const write = await coordinator.authorize({ def: FILE_WRITE, args: { path: 'notes.txt' } });
  assert.equal(write.allowed, false, '文件工具仍然必须过闸门');
  assert.equal(write.code, 'path_gate_missing');
  assert.equal(write.scope, undefined, '项目内拒绝不带 rootless 标记');
});

test("3：无项目根时 fs:'write' 的文件工具仍然被拒（root_not_registered 回归锁）", async t => {
  const store = await emptyStore(t);
  const { approvals, calls } = askSpy('once');
  const coordinator = createApprovalCoordinator({
    approvals,
    permissions: createPermissionsAdapter({ store }),
    // 闸门本身可用（能解析出路径），但能力位 store 里没有任何根 → 必须拒绝。
    gate: { resolveInRoots: async path => `C:\\proj\\${path}` },
  });

  const verdict = await coordinator.authorize({ def: FILE_WRITE, args: { path: 'notes.txt' } });
  assert.equal(verdict.allowed, false, '文件类一条都不许放宽');
  assert.equal(verdict.code, 'permission_denied');
  assert.match(verdict.reason, /root_not_registered/);
  assert.equal(calls.length, 0, '没到审批就该被拒，不浪费用户一次确认');
});

test("4：fs:'none' + approval.mode:'always' + preset:'full' 仍然问人（full 免不掉 always）", async () => {
  const def = { ...ROOTLESS_EXEC, approval: { mode: 'always', capability: 'exec' } };
  const { approvals, calls } = askSpy('once');
  const coordinator = createApprovalCoordinator({
    approvals, permissions: permissionsSpy().permissions, preset: 'full', sender: { id: 'win-1' },
  });
  assert.deepEqual(await coordinator.authorize({ def, args: {} }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 1, 'mode:always 必问，preset:full 救不回来');

  const denied = createApprovalCoordinator({
    approvals: askSpy('deny').approvals, permissions: permissionsSpy().permissions, preset: 'full',
  });
  const verdict = await denied.authorize({ def, args: {} });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'approval_denied');
  assert.equal(verdict.scope, 'rootless', 'rootless 的拒绝要能和项目内拒绝区分开');
});

test("5：fs:'none' + risk:'read' 不问人直接过，且不碰 store 的 check（只走 checkRootless）", async () => {
  const def = {
    name: 'desktop_screenshot',
    label: '屏幕截图',
    risk: 'read',
    approval: { mode: 'none' },
    permissions: perms({ desktop: true }),
  };
  const { approvals, calls } = askSpy('deny');
  const { permissions, calls: permissionCalls } = permissionsSpy();
  const { entries, audit } = auditSpy();
  const coordinator = createApprovalCoordinator({ approvals, permissions, audit, sender: { id: 'win-1' } });

  assert.deepEqual(await coordinator.authorize({ def, args: { mode: 'window' } }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 0, '读类无副作用：不问人');
  assert.deepEqual(permissionCalls.check, [], 'rootless 不查 rootId（store 里没有根可查）');
  assert.deepEqual(permissionCalls.rootless.map(input => input.capability), ['desktop'], '非文件能力位仍然复查');
  assert.equal(entries[0].decision, 'read');
  assert.equal(entries[0].scope, 'rootless');
});

test("6：fs:'read' 且带 path 的调用仍走路径闸门（browser_upload 这类读文件不放宽）", async t => {
  const store = await emptyStore(t);
  const def = {
    name: 'browser_upload',
    label: '上传文件',
    risk: 'exec',
    approval: { mode: 'policy', capability: 'exec' },
    // 浏览器包声明的是 fs:'read' + browser:true；带 path 参数时必须照旧走闸门。
    permissions: perms({ fs: 'read', browser: true, exec: true }),
  };
  const coordinator = createApprovalCoordinator({
    approvals: askSpy('once').approvals,
    permissions: createPermissionsAdapter({ store }),
    gate: { resolveInRoots: async path => `C:\\proj\\${path}` },
  });
  const verdict = await coordinator.authorize({ def, args: { path: 'C:\\Users\\x\\secret.pdf' } });
  assert.equal(verdict.allowed, false, '带路径的调用一律要根');
  assert.equal(verdict.code, 'permission_denied');
  assert.match(verdict.reason, /root_not_registered/);

  // 反例再收紧一层：fs:'write' 的包即使声明了浏览器能力位、即使没有路径参数，也必须被根挡住。
  const writePackBrowser = { ...def, name: 'browser_storage_state', permissions: perms({ fs: 'write', browser: true, exec: true }) };
  const blocked = await coordinator.authorize({ def: writePackBrowser, args: {} });
  assert.equal(blocked.allowed, false, 'fs:write 的包没有「零路径就免根」的例外');
  assert.equal(blocked.code, 'permission_denied');
  assert.match(blocked.reason, /root_not_registered/);
});

test('7：真 desktop-control 包 + 空 roots + 空 store：desktop_act 端到端通过，事件 running → done', async t => {
  const store = await emptyStore(t);
  const asked = [];
  const events = [];
  const { audit, entries } = auditSpy();
  const sender = { id: 7788, isDestroyed: () => false, send() {} };
  const broker = {
    async ask(target, request) {
      asked.push(request);
      return 'once';
    },
  };
  const desktopTool = {
    name: 'desktop_act',
    async execute(id, input) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: input.action }) }] };
    },
  };
  const runtime = buildSkillRuntime({
    packs: [{ manifest: desktopManifest, createHandlers: createDesktopHandlers }],
    deps: {
      // 用户没打开任何项目文件夹：三处都空。
      projectRoots: [],
      roots: [],
      approvalPreset: 'default',
      approvals: createApprovalsAdapter({ broker, sender }),
      permissions: createPermissionsAdapter({ store }),
      desktop: [desktopTool],
      sender,
      audit,
      emit: event => events.push(event),
    },
  });

  const result = await runtime.invoke('desktop_act', { action: 'click', target: 'w1.b7' });
  assert.equal(result.isError, undefined, `桌面操作不该被项目根挡死，实际：${result.content[0].text}`);
  assert.equal(asked.length, 1, '仍然要问人一次');
  assert.equal(asked[0].capability, 'exec');
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.status), ['running', 'done']);
  assert.equal(entries.at(-1).scope, 'rootless', '审计写明 scope:rootless');
  assert.equal(entries.at(-1).action, 'skill/desktop_act');
});

test('8：rootless 审批被拒时 handler 零副作用、审计里没有「已批准」痕迹', async t => {
  const store = await emptyStore(t);
  const events = [];
  const { audit, entries } = auditSpy();
  const sender = { id: 7788, isDestroyed: () => false, send() {} };
  const broker = { async ask() { return 'deny'; } };
  let executed = 0;
  const desktopTool = {
    name: 'desktop_act',
    async execute() {
      executed += 1;
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
  };
  const runtime = buildSkillRuntime({
    packs: [{ manifest: desktopManifest, createHandlers: createDesktopHandlers }],
    deps: {
      projectRoots: [],
      roots: [],
      approvals: createApprovalsAdapter({ broker, sender }),
      permissions: createPermissionsAdapter({ store }),
      desktop: [desktopTool],
      sender,
      audit,
      emit: event => events.push(event),
    },
  });

  const result = await runtime.invoke('desktop_act', { action: 'click', target: 'w1.b7' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /approval_denied/);
  assert.equal(executed, 0, '拒绝时零副作用');
  assert.deepEqual(entries, [], '拒绝不留「已批准」痕迹');
  // 桌面 handler 把拒绝收敛成 isError 结果（不是 throw），所以这一行的状态是 error 而不是 denied；
  // 「拒绝画成 denied」由 test 9 的抛错式 handler 覆盖（走 index.mjs 的 DENIED_CODES 映射）。
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.status), ['running', 'error']);
});

test('9：rootless 拒绝码在抛错式 handler 下映射成 denied 事件（capability_scope_missing 必须进 DENIED_CODES）', async () => {
  const events = [];
  const pack = {
    manifest: {
      apiVersion: 1,
      id: 'rootless-denied-pack',
      version: '1.0.0',
      title: '无文件能力拒绝用例',
      summary: 'handler 在授权未通过时抛带 code 的错误，用于验证事件状态。',
      capabilities: ['desktop.control'],
      dependencies: [],
      permissions: perms({ exec: true, desktop: true }),
      deprecation: null,
      tools: [{
        name: 'desktop_act',
        mcpName: 'mova_desktop_act',
        aliases: [],
        label: '操作界面',
        description: '按 ref 执行一次桌面动作。',
        mcpSummary: '执行一次桌面动作并返回变化 diff。',
        risk: 'exec',
        approval: { mode: 'policy', capability: 'exec' },
        exposure: { piAi: true, mcp: 'on_demand' },
        inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: [], additionalProperties: false },
        examples: [{ title: '点一下按钮', arguments: { target: 'w1.b7' } }],
      }],
    },
    createHandlers: () => ({
      async desktop_act(args, ctx) {
        const verdict = await ctx.authorize(undefined, args);
        if (!verdict.allowed) throw Object.assign(new Error(verdict.reason), { code: verdict.code });
        return 'acted';
      },
    }),
  };
  const runtime = buildSkillRuntime({
    packs: [pack],
    deps: {
      projectRoots: [],
      permissions: permissionsSpy({ rootlessVerdict: { ok: false, reason: 'policy-off' } }).permissions,
      approvals: askSpy('once').approvals,
      emit: event => events.push(event),
    },
  });

  const result = await runtime.invoke('desktop_act', { target: 'w1.b7' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /capability_scope_missing/);
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.status), ['running', 'denied']);
});

test("10：fs:'none' 的 rootless 能力位被适配器否定时收敛成 capability_scope_missing", async () => {
  const events = [];
  const coordinator = createApprovalCoordinator({
    approvals: askSpy('once').approvals,
    permissions: permissionsSpy({ rootlessVerdict: { ok: false, reason: 'policy-off' } }).permissions,
    emit: event => events.push(event),
  });
  const verdict = await coordinator.authorize({ def: ROOTLESS_EXEC, args: {} });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'capability_scope_missing');
  assert.match(verdict.reason, /scope: rootless/);
  assert.equal(verdict.scope, 'rootless');
  assert.equal(events.filter(event => event.type === 'notice').length, 1, '拒绝要有一条旁白');
});

test('11：适配器只有 check 一道通道时，rootless 退回 store 判定（缺通道一律更保守）', async () => {
  const browserBatch = {
    name: 'browser_batch',
    label: '批量浏览器操作',
    risk: 'exec',
    approval: { mode: 'policy', capability: 'exec' },
    permissions: perms({ fs: 'read', browser: true, exec: true }),
  };
  const denied = createApprovalCoordinator({
    approvals: askSpy('once').approvals,
    permissions: { check: async () => ({ ok: false, reason: '没有浏览器能力位' }) },
  });
  const verdict = await denied.authorize({ def: browserBatch, args: { steps: [{ op: 'click' }] } });
  assert.equal(verdict.allowed, false, '老接线（没有 checkRootless）时仍然听 store 的');
  assert.equal(verdict.code, 'permission_denied');
  assert.equal(verdict.scope, 'rootless');
  assert.match(verdict.reason, /没有浏览器能力位/);

  const accepted = createApprovalCoordinator({
    approvals: askSpy('once').approvals,
    permissions: { check: async () => ({ ok: true }) },
  });
  assert.deepEqual(
    await accepted.authorize({ def: browserBatch, args: { steps: [{ op: 'click' }] } }),
    { allowed: true, code: 'ok' },
  );
});

test('12：预设矩阵——fs:none 的 exec 工具在 default/auto 都问人，full 免问，三者都不需要项目根', async () => {
  for (const preset of ['default', 'auto']) {
    const { approvals, calls } = askSpy('once');
    const coordinator = createApprovalCoordinator({
      approvals, permissions: permissionsSpy().permissions, preset, sender: { id: 'win-1' },
    });
    assert.deepEqual(
      await coordinator.authorize({ def: ROOTLESS_EXEC, args: {} }),
      { allowed: true, code: 'ok' },
      `preset:${preset} 也要在没有项目根时可用`,
    );
    assert.equal(calls.length, 1, `preset:${preset} 下仍然问人一次`);
  }

  const { approvals, calls } = askSpy('deny');
  const { entries, audit } = auditSpy();
  const full = createApprovalCoordinator({
    approvals, permissions: permissionsSpy().permissions, preset: 'full', audit, sender: { id: 'win-1' },
  });
  assert.deepEqual(await full.authorize({ def: ROOTLESS_EXEC, args: {} }), { allowed: true, code: 'ok' });
  assert.equal(calls.length, 0, 'full 只免人工审批（且仅对 policy 模式生效）');
  assert.equal(entries.at(-1).decision, 'auto');
  assert.equal(entries.at(-1).scope, 'rootless');
});

test('13：turn-runtime 真装配 + 空 projectRoots：memory_write（fs:none + memory:write）通过且问人一次', async t => {
  const store = await emptyStore(t);
  const asked = [];
  const { entries, audit } = auditSpy();
  const { runtime } = createSkillRuntimeForTurn({
    // 用户没打开任何项目文件夹。
    projectRoots: [],
    roots: [],
    approvals: {
      async ask(sender, request) {
        asked.push({ sender, request });
        return 'once';
      },
    },
    permissions: store,
    sender: { id: 9091, isDestroyed: () => false, send() {} },
    memorySearch: async () => [],
    memoryRuntime: {
      async saveMemory(input) {
        return { id: 'mem-1', kind: input?.kind ?? 'fact' };
      },
    },
    audit,
    emit: () => {},
  });

  const result = await runtime.invoke('mova_memory_write', { text: '用户偏好浅色主题' });
  assert.equal(result.isError, undefined, `写记忆不该被项目根挡死，实际：${result.content[0].text}`);
  assert.equal(asked.length, 1, '写记忆是 write 类：必须问人一次');
  assert.equal(asked[0].request.capability, 'write');
  assert.equal(entries.at(-1).scope, 'rootless', '记忆写不需要项目根，审计里要能看出来');
});
