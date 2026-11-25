// 技能授权链路的**真实现集成**测试（纯内存 + 临时目录，不需要 Electron）。
//
// 为什么单独一个文件：`tests/skills-approval.test.mjs` 用的是手写 fake，只能证明「桥自己自洽」；
// 审查实测出的三个 P0（审批卡永远发不出、能力位恒 not-registered、路径闸门被完全绕过）
// 恰恰都是「桥和真宿主对不上」这类问题，只有把真 broker / 真 store / 真 gate 接进来才能锁住。
//
// 真实现来源（一律不 mock 行为，只 mock「窗口」与「磁盘位置」）：
//   electron/approvals.cjs  createApprovalBroker()   ——ask(sender, request = {}, signal)
//   electron/permissions.cjs createPermissionStore() ——check({ rootId, capability, approvalPreset })
//   electron/acp/gate.mjs    createGate()            ——handle + resolveInRoots
//
// 覆盖：P0-1（审批卡真的能到前端）、P0-2（能力位按 rootId 复查）、P0-3（full 不免路径闸门）、
// P1-1（allowSession 跨工具不串 + resetApprovals 真的在 runtime 上）、
// P1-2（技能层的审批卡带 request.preview：真文件 + 真 agent-tools，且不重新引入双弹卡）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGate } from '../electron/acp/gate.mjs';
import { createProjectTools } from '../electron/agent-tools.cjs';
import { createApprovalBroker } from '../electron/approvals.cjs';
import { canonicalPath, createPermissionStore } from '../electron/permissions.cjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import {
  createApprovalsAdapter, createGateAdapter, createPermissionsAdapter,
} from '../electron/skills/host-adapters.mjs';
import { projectFsPack } from '../electron/skills/packs/index.mjs';

/** 一个临时项目根（真实的目录，因为 gate 要逐级 realpath）。 */
async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'mova-skills-approval-'));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root };
}

/**
 * 真 createPermissionStore：登记一个根，按需授予能力位。
 * 真 store 的 setCapability 会先问 confirm（原生对话框的位置），测试里一律 allow。
 * 权限文件放在根的同级（`<base>/permissions.json`），由 workspace 的 after 一起清掉。
 */
async function permissionStore(t, { root, capabilities = [] } = {}) {
  const store = createPermissionStore({
    filePath: join(root, '..', 'mova-permissions.json'),
    confirm: async () => 'allow',
  });
  await store.register([{ path: root }]);
  const rootId = canonicalPath(root).id;
  const wanted = new Set(capabilities);
  if (wanted.size) {
    // 真 store 的顺序要求：写之前必须先能读（read-required）。
    await store.setCapability({ rootId, capability: 'read', value: true });
    for (const capability of wanted) {
      if (capability === 'read') continue;
      await store.setCapability({ rootId, capability, value: true });
    }
  }
  return { store, rootId };
}

/** 假 webContents：真实的 broker 只碰 `id` / `isDestroyed()` / `send()` 三个成员。 */
function fakeSender({ onRequest } = {}) {
  const received = [];
  const sender = {
    id: 4242,
    isDestroyed: () => false,
    send(channel, payload) {
      received.push({ channel, payload });
      onRequest?.(channel, payload);
    },
  };
  return { sender, received };
}

function writeTool(name, { allowSession = false } = {}) {
  return {
    name,
    mcpName: `mova_${name}`,
    aliases: [],
    label: `${name} 展示名`,
    description: `Write via ${name}.`,
    mcpSummary: `${name} 一行摘要。`,
    risk: 'write',
    approval: { mode: 'policy', capability: 'write', allowSession },
    exposure: { piAi: true, mcp: 'on_demand' },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    examples: [{ title: '示例', arguments: { path: 'a.txt' } }],
  };
}

function packOf(tools, handlerFor) {
  return {
    manifest: {
      apiVersion: 1,
      id: 'integration-pack',
      version: '1.0.0',
      title: '集成测试包',
      summary: '真审批 / 真权限 / 真闸门的集成测试用技能包。',
      capabilities: ['fs.write'],
      dependencies: [],
      permissions: { fs: 'write', exec: false, net: false, desktop: false, browser: false, canvas: false, memory: 'none' },
      deprecation: null,
      tools,
    },
    createHandlers: () => Object.fromEntries(tools.map(def => [def.name, handlerFor(def)])),
  };
}

/** handler 必须先 authorize 再「落盘」（这里用返回值代替真实写入）。 */
function authorizingHandler(def) {
  return async (args, ctx) => {
    const verdict = await ctx.authorize(def, args);
    if (!verdict.allowed) {
      const error = new Error(verdict.reason ?? verdict.code);
      error.code = verdict.code;
      throw error;
    }
    return `wrote ${args.path}`;
  };
}

test('P0-1：真 broker + 真适配器下，写操作把 approval:request 真的发到窗口', async t => {
  const { root } = await workspace(t);
  const { store } = await permissionStore(t, { root, capabilities: ['write'] });
  const { sender, received } = fakeSender({
    onRequest: (channel, payload) => {
      if (channel === 'approval:request') broker.respond(payload.id, 'once', sender.id);
    },
  });
  const broker = createApprovalBroker({ timeoutMs: 2_000 });

  const tools = [writeTool('write_file')];
  const runtime = buildSkillRuntime({
    packs: [packOf(tools, authorizingHandler)],
    deps: {
      projectRoots: [root],
      sender,
      approvals: createApprovalsAdapter({ broker, sender }),
      permissions: createPermissionsAdapter({ store }),
      gate: createGateAdapter({ gate: createGate({ projectRoots: [root] }) }),
    },
  });

  const result = await runtime.invoke('write_file', { path: 'notes.txt' });
  assert.equal(result.isError, undefined, `应当被批准，实际：${result.content[0].text}`);

  assert.equal(received.length >= 1, true, '前端必须收到审批请求（旧实现按 Function.length 猜签名，这里恒为 0）');
  const request = received[0];
  assert.equal(request.channel, 'approval:request');
  assert.equal(request.payload.capability, 'write');
  assert.equal(typeof request.payload.id, 'string');
  assert.ok(request.payload.path && request.payload.path.toLowerCase().endsWith('notes.txt'), '审批卡带的是闸门解析后的路径');
});

test('P0-1：sender 缺失时适配器直接返回 deny 并 warn（不是崩，也不是放行）', async () => {
  const warns = [];
  const broker = createApprovalBroker({ timeoutMs: 100 });
  const adapter = createApprovalsAdapter({ broker, sender: null, logger: { warn: text => warns.push(String(text)) } });
  assert.equal(await adapter.ask({ capability: 'write' }, undefined), 'deny');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /sender/);
});

test('P0-2：真 permissions.check 只认 rootId —— 适配器把 path 反查成根后 read/write/exec 三档才可能通过', async t => {
  const { root } = await workspace(t);
  const { store } = await permissionStore(t, { root, capabilities: ['read', 'write'] });
  const adapter = createPermissionsAdapter({ store });
  const inside = join(root, 'a.txt');

  assert.deepEqual(
    await adapter.check({ capability: 'read', path: inside, approvalPreset: 'default' }),
    { ok: true },
    'read 已授权 → 通过',
  );
  assert.deepEqual(
    await adapter.check({ capability: 'write', path: inside, approvalPreset: 'default' }),
    { ok: true },
    'write 已授权 → 通过（旧实现把 path 直接丢给真 store，恒 not-registered）',
  );
  assert.deepEqual(
    await adapter.check({ capability: 'exec', path: inside, approvalPreset: 'default' }),
    { ok: false, reason: 'not-granted' },
    'exec 未授权 → not-granted',
  );
  assert.deepEqual(
    await adapter.check({ capability: 'exec', path: inside, approvalPreset: 'auto' }),
    { ok: false, reason: 'not-granted' },
    'auto 预设只放开 read/write，不放开 exec',
  );
  assert.deepEqual(
    await adapter.check({ capability: 'exec', path: inside, approvalPreset: 'full' }),
    { ok: true },
    'full 预设放开 exec（预设是 store 的语义，不是桥的）',
  );

  const outside = resolve(root, '..', 'outside.txt');
  assert.deepEqual(
    await adapter.check({ capability: 'write', path: outside, approvalPreset: 'full' }),
    { ok: false, reason: 'root_not_registered' },
    '根本不在任何已登记根里的路径：拒绝（不是「没有根就算过」）',
  );

  const orphan = createPermissionsAdapter({ store: null });
  assert.equal(
    (await orphan.check({ capability: 'read', path: inside })).reason,
    'permission_unavailable',
    '没有 store 时按最保守语义拒绝',
  );
});

test('P0-3：真 gate 的 resolveInRoots 可用，且 ../../Windows/System32/x.dll 被拒', async t => {
  const { root } = await workspace(t);
  const gate = createGate({ projectRoots: [root] });
  assert.equal(typeof gate.resolveInRoots, 'function', 'createGate 必须把 resolveInRoots 暴露出来');

  const realRoot = await realpath(root);
  const resolved = await gate.resolveInRoots('a.txt', 'skill');
  assert.equal(resolve(resolved).toLowerCase().startsWith(resolve(realRoot).toLowerCase()), true, '根内路径解析到真实路径');
  assert.match(resolved, /a\.txt$/i);

  await assert.rejects(
    gate.resolveInRoots('../../Windows/System32/x.dll', 'skill'),
    error => {
      assert.match(String(error.detail ?? error.message), /路径越界/);
      return true;
    },
  );

  const adapter = createGateAdapter({ gate });
  await assert.rejects(adapter.resolveInRoots('../../Windows/System32/x.dll', 'skill'), error => {
    assert.match(String(error.detail ?? error.message), /路径越界/);
    return true;
  });

  const missing = createGateAdapter({});
  await assert.rejects(missing.resolveInRoots('a.txt', 'skill'), error => error.code === 'path_gate_missing');
});

test('P0-3：没有 gate、没有 permissions、preset:full —— 越界写仍被拒（回归锁）', async () => {
  const events = [];
  const runtime = buildSkillRuntime({
    packs: [packOf([writeTool('write_file')], authorizingHandler)],
    deps: { approvalPreset: 'full', emit: event => events.push(event) },
  });

  const result = await runtime.invoke('write_file', { path: '../../Windows/System32/x.dll' });
  assert.equal(result.isError, true, 'full 不免路径闸门：必须失败');
  assert.match(result.content[0].text, /path_gate_missing/);
  const toolEvents = events.filter(event => event.type === 'tool');
  assert.deepEqual(toolEvents.map(event => event.status), ['running', 'denied'], '拒绝要显示成 denied 而不是「完成」');

  // 根内路径同样没有闸门可用：一样拒绝，不能因为「看起来安全」就放行。
  const inside = await runtime.invoke('write_file', { path: 'ok.txt' });
  assert.equal(inside.isError, true);
  assert.match(inside.content[0].text, /path_gate_missing/);
});

test('P0-2 + P0-3：preset:full 也不能让「能力位 store 里没登记的根」通过', async t => {
  // 两个真实目录：闸门认 rootA，能力位 store 只登记 rootB。
  // full 档在真 store 里会放开 read/write/exec 的有效能力，但仍然需要 rootId 存在——
  // 根对不上时必须拒绝（旧实现把 path 直接丢给 store，恒 not-registered，任何档位都过不去）。
  const { root: gateRoot } = await workspace(t);
  const { root: otherRoot } = await workspace(t);
  const { store } = await permissionStore(t, { root: otherRoot, capabilities: [] });
  const runtime = buildSkillRuntime({
    packs: [packOf([writeTool('write_file')], authorizingHandler)],
    deps: {
      approvalPreset: 'full',
      projectRoots: [gateRoot],
      permissions: createPermissionsAdapter({ store }),
      gate: createGateAdapter({ gate: createGate({ projectRoots: [gateRoot] }) }),
    },
  });
  const result = await runtime.invoke('write_file', { path: 'notes.txt' });
  assert.equal(result.isError, true, '根没登记在能力位 store 里：full 也不能放行');
  assert.match(result.content[0].text, /permission_denied/);
  assert.match(result.content[0].text, /root_not_registered/, '拒绝原因要能看出是「根没登记」而不是「用户没授权」');
});

test('P0-3 + 审批：preset:default 下有 gate/能力位时走真 broker，拒绝则 handler 不执行', async t => {
  const { root } = await workspace(t);
  const { store } = await permissionStore(t, { root, capabilities: ['write'] });
  const { sender, received } = fakeSender({
    onRequest: (channel, payload) => {
      if (channel === 'approval:request') broker.respond(payload.id, 'deny', sender.id);
    },
  });
  const broker = createApprovalBroker({ timeoutMs: 2_000 });
  const executed = [];
  const tools = [writeTool('write_file')];
  const pack = packOf(tools, def => async (args, ctx) => {
    const verdict = await ctx.authorize(def, args);
    if (!verdict.allowed) {
      const error = new Error(verdict.reason ?? verdict.code);
      error.code = verdict.code;
      throw error;
    }
    executed.push(args.path);
    return 'wrote';
  });

  const runtime = buildSkillRuntime({
    packs: [pack],
    deps: {
      projectRoots: [root],
      sender,
      approvals: createApprovalsAdapter({ broker, sender }),
      permissions: createPermissionsAdapter({ store }),
      gate: createGateAdapter({ gate: createGate({ projectRoots: [root] }) }),
    },
  });

  const result = await runtime.invoke('write_file', { path: 'notes.txt' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /approval_denied/);
  assert.equal(received.length, 1, '问了一次');
  assert.deepEqual(executed, [], '拒绝后 handler 不得继续执行（零落盘）');
});

test('P1-1：allowSession 跨工具不串；resetApprovals 之后重新要审批', async t => {
  const { root } = await workspace(t);
  const { store } = await permissionStore(t, { root, capabilities: ['write'] });
  const { sender, received } = fakeSender({
    onRequest: (channel, payload) => {
      if (channel === 'approval:request') broker.respond(payload.id, 'session', sender.id);
    },
  });
  const broker = createApprovalBroker({ timeoutMs: 2_000 });
  const tools = [writeTool('design_apply', { allowSession: true }), writeTool('write_file', { allowSession: true })];
  const runtime = buildSkillRuntime({
    packs: [packOf(tools, authorizingHandler)],
    deps: {
      projectRoots: [root],
      sender,
      approvals: createApprovalsAdapter({ broker, sender }),
      permissions: createPermissionsAdapter({ store }),
      gate: createGateAdapter({ gate: createGate({ projectRoots: [root] }) }),
    },
  });

  assert.equal((await runtime.invoke('design_apply', { path: 'a.txt' })).isError, undefined);
  assert.equal(received.length, 1);

  assert.equal((await runtime.invoke('design_apply', { path: 'b.txt' })).isError, undefined);
  assert.equal(received.length, 1, '同工具同能力：会话授权生效，不再问');

  assert.equal((await runtime.invoke('write_file', { path: 'c.txt' })).isError, undefined);
  assert.equal(received.length, 2, '换一个工具必须重新问：否则批准一次 design_apply 就能免审写任意根内文件');

  assert.equal(typeof runtime.resetApprovals, 'function', 'resetApprovals 必须暴露在 runtime 上，供接线层每轮清理');
  runtime.resetApprovals(sender.id);
  assert.equal((await runtime.invoke('design_apply', { path: 'd.txt' })).isError, undefined);
  assert.equal(received.length, 3, '清掉会话授权后必须重新问');
});

/* ── P1-2：审批卡的变更预览 ─────────────────────────────────────────────
 * 技能化之后曾经出现过的真回归：为了让「只弹一次卡」，agent-tools 拿 `approvalPreset:'full'`
 * 不再自己弹卡，但技能层的通用卡只有「技能 + 风险 + 路径」，用户在点「允许」之前看不到要改什么。
 * 下面这条链路把**真** agent-tools / 真 pack / 真 broker / 真 gate 全接起来，锁住三件事：
 *   1) 审批卡的 request 里带 `preview`（渲染层认的那个字段名）；
 *   2) before/after 是磁盘上的真实内容（新建按空串），不是空壳；
 *   3) 仍然只弹一次卡（agent-tools 不自己弹）。
 */

/**
 * 完整写入链路：真 `createProjectTools`（`approvalPreset:'full'`，即它自己不弹卡）
 * + 真 `project-fs` pack + 真 broker / gate / permission store。
 * @param {object} t 测试上下文（临时目录在结束时删掉）
 * @param {{ files?: Record<string, string>, answer?: 'once'|'deny' }} [options]
 */
async function writeChain(t, { files = {}, answer = 'once' } = {}) {
  const { root } = await workspace(t);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text, 'utf8');
  const { store, rootId } = await permissionStore(t, { root, capabilities: ['write'] });
  const broker = createApprovalBroker({ timeoutMs: 2_000 });
  const { sender, received } = fakeSender({
    onRequest: (channel, payload) => {
      if (channel === 'approval:request') broker.respond(payload.id, answer, sender.id);
    },
  });
  const debug = [];
  const projectRoots = [{ id: rootId, name: 'project', path: root, capabilities: { read: true, write: true, exec: false } }];
  const runtime = buildSkillRuntime({
    packs: [projectFsPack],
    deps: {
      projectRoots,
      roots: [root],
      sender,
      approvals: createApprovalsAdapter({ broker, sender }),
      permissions: createPermissionsAdapter({ store }),
      gate: createGateAdapter({ gate: createGate({ projectRoots: [root] }) }),
      // 真 agent-tools：`approvalPreset:'full'` 让它**不**自己弹卡（人工确认只在技能层这一次）。
      projectTools: ({ emit } = {}) => createProjectTools({
        permissions: store,
        roots: projectRoots,
        emit: typeof emit === 'function' ? emit : () => {},
        approvalPreset: 'full',
      }),
      logger: { debug(text) { debug.push(String(text)); }, info() {}, warn() {}, error() {} },
    },
  });
  return {
    root,
    runtime,
    received,
    debug,
    // getter：审批请求是在 invoke 过程中才发出来的，快照会在它之前取到空数组。
    get requests() { return received.filter(item => item.channel === 'approval:request'); },
  };
}

test('P1-2：write_file 的审批卡带 request.preview（真文件 before/after），且只弹一次卡', async t => {
  const chain = await writeChain(t, { files: { 'notes.txt': '旧内容\n' } });

  const result = await chain.runtime.invoke('write_file', { path: 'notes.txt', content: '新内容\n' });
  assert.equal(result.isError, undefined, `应当被批准，实际：${result.content?.[0]?.text}`);

  assert.equal(chain.requests.length, 1, '只弹一次卡：agent-tools 拿 approvalPreset:full 后不再自己弹第二次');
  assert.deepEqual(
    chain.requests[0].payload.preview,
    { kind: 'write', path: 'notes.txt', before: '旧内容\n', after: '新内容\n', truncated: false },
    '审批卡必须带渲染层认的 preview：字段名与 approval-bar.jsx 读的一致（kind/path/before/after/truncated）',
  );
  assert.equal(chain.requests[0].payload.capability, 'write', '徽标与按钮仍走原来的 capability 契约');
  assert.equal(await readFile(join(chain.root, 'notes.txt'), 'utf8'), '新内容\n', '允许后必须真的落盘');
});

test('P1-2：文件不存在（新建）时预览仍是合法结构（before 为空串）', async t => {
  const chain = await writeChain(t);

  const result = await chain.runtime.invoke('write_file', { path: 'created.txt', content: '新文件\n' });
  assert.equal(result.isError, undefined, `应当被批准，实际：${result.content?.[0]?.text}`);

  assert.equal(chain.requests.length, 1);
  assert.deepEqual(
    chain.requests[0].payload.preview,
    { kind: 'write', path: 'created.txt', before: '', after: '新文件\n', truncated: false },
    '新建文件没有 before，但结构必须完整（渲染层据此画「全新增」的 diff，而不是退回纯文本）',
  );
  assert.equal(await readFile(join(chain.root, 'created.txt'), 'utf8'), '新文件\n');
});

test('P1-2：预览过大（1MB 以上）时降级成不带预览的卡，授权照常成功', async t => {
  const chain = await writeChain(t, { files: { 'huge.txt': `${'x'.repeat(1_000_000)}\n` } });

  const result = await chain.runtime.invoke('write_file', { path: 'huge.txt', content: '短内容\n' });
  assert.equal(result.isError, undefined, `超限只是少一张 diff，绝不能挡住授权：${result.content?.[0]?.text}`);
  assert.equal(chain.requests.length, 1);
  assert.equal('preview' in chain.requests[0].payload, false, '降级的那张卡整个 preview 键都不该出现');
  assert.equal(await readFile(join(chain.root, 'huge.txt'), 'utf8'), '短内容\n');
});

test('P1-2：replace_in_file 的审批卡预览与被替换的片段一致（复用 agent-tools 的结构）', async t => {
  const chain = await writeChain(t, { files: { 'src.js': 'const a = 1;\n' } });

  const result = await chain.runtime.invoke('replace_in_file', {
    path: 'src.js', oldText: 'const a = 1;', newText: 'const a = 2;',
  });
  assert.equal(result.isError, undefined, `应当被批准，实际：${result.content?.[0]?.text}`);

  assert.equal(chain.requests.length, 1);
  assert.deepEqual(
    chain.requests[0].payload.preview,
    { kind: 'replace', path: 'src.js', before: 'const a = 1;', after: 'const a = 2;', truncated: false },
    'replace 的预览就是「被替换片段 → 新片段」（与 agent-tools 的 previewOf(replace) 同一份结构）',
  );
  assert.equal(await readFile(join(chain.root, 'src.js'), 'utf8'), 'const a = 2;\n');
});

test('P1-2：预览构造抛错时仍能授权成功，request 里没有 preview 字段，并留一条 debug', async t => {
  const { root } = await workspace(t);
  const { store } = await permissionStore(t, { root, capabilities: ['write'] });
  const broker = createApprovalBroker({ timeoutMs: 2_000 });
  const { sender, received } = fakeSender({
    onRequest: (channel, payload) => {
      if (channel === 'approval:request') broker.respond(payload.id, 'once', sender.id);
    },
  });
  const debug = [];
  const executed = [];
  const pack = packOf([writeTool('write_file')], def => async (args, ctx) => {
    const verdict = await ctx.authorize(def, args, {
      // 模拟「读盘炸了」：预览构造失败绝不能阻塞授权。
      preview: () => { throw Object.assign(new Error('EACCES: 文件读不出来'), { code: 'EACCES' }); },
    });
    if (!verdict.allowed) {
      const error = new Error(verdict.reason ?? verdict.code);
      error.code = verdict.code;
      throw error;
    }
    executed.push(args.path);
    return 'wrote';
  });
  const runtime = buildSkillRuntime({
    packs: [pack],
    deps: {
      projectRoots: [root],
      sender,
      approvals: createApprovalsAdapter({ broker, sender }),
      permissions: createPermissionsAdapter({ store }),
      gate: createGateAdapter({ gate: createGate({ projectRoots: [root] }) }),
      logger: { debug(text) { debug.push(String(text)); }, info() {}, warn() {}, error() {} },
    },
  });

  const result = await runtime.invoke('write_file', { path: 'notes.txt' });
  assert.equal(result.isError, undefined, `预览失败只降级，不得变成拒绝：${result.content?.[0]?.text}`);
  assert.deepEqual(executed, ['notes.txt'], '授权通过后 handler 照常执行');
  assert.equal(received.length, 1);
  assert.equal('preview' in received[0].payload, false, '卡片退化成「只有路径与风险」的通用卡');
  assert.ok(debug.some(line => /预览构造失败/.test(line)), `必须留一条 debug 说明为什么这张卡没有 diff：${debug.join('|')}`);
});
