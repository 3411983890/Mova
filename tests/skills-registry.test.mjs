// electron/skills/registry.mjs 的单元测试。
// 全部纯内存 fake：pack 是 { manifest, createHandlers }，deps 是普通对象，
// 不碰文件系统、不碰 electron、不起网络。
// 断言的是「模型/CLI 最终能看见什么」：裁剪后还剩下哪些工具、别名能不能解析、warnings 说清原因。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRegistry, filterDeprecated } from '../electron/skills/registry.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';

function tool(name, overrides = {}) {
  return {
    name,
    label: `${name} 展示名`,
    description: `Do ${name}.`,
    mcpSummary: `${name} 一行摘要。`,
    risk: 'read',
    approval: { mode: 'policy' },
    exposure: { piAi: true, mcp: 'on_demand' },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    examples: [{ title: '示例', arguments: {} }],
    ...overrides,
  };
}

function pack({
  id = 'demo', deps = [], tools = [tool('demo_one')], handlers, sessionPolicy, deprecation = null, version = '1.0.0',
} = {}) {
  return {
    manifest: {
      apiVersion: 1,
      id,
      version,
      title: `${id} 标题`,
      summary: `${id} 一句话摘要。`,
      capabilities: ['demo.read'],
      dependencies: deps,
      permissions: { fs: 'none', exec: false, net: false, desktop: false, browser: false, canvas: false, memory: 'none' },
      ...(sessionPolicy ? { sessionPolicy } : {}),
      deprecation,
      tools,
    },
    createHandlers: () => handlers ?? Object.fromEntries(tools.map(item => [item.name, async () => 'ok'])),
  };
}

test('依赖缺失时整个 pack 被跳过，并写清缺哪个键', () => {
  const registry = buildRegistry([pack({ id: 'browser-pack', deps: ['browser'], tools: [tool('browser_navigate')] })], {});
  assert.equal(registry.entries.size, 0, '依赖没注入时不应暴露任何工具');
  assert.equal(registry.skipped[0].reason, 'missing_dependencies');
  assert.deepEqual(registry.skipped[0].missing, ['browser'], 'skipped 里要写清缺的具体键');
  assert.match(registry.warnings.join('\n'), /缺少宿主依赖：browser/, 'warnings 要人能读懂');
});

test('只有 undefined / null / 空串 / NaN 算缺失；false 与 0 是「已注入」', () => {
  const only = pack({ deps: ['designRuntime'] });
  for (const deps of [{ designRuntime: null }, { designRuntime: '' }, {}]) {
    const registry = buildRegistry([only], deps);
    assert.equal(registry.entries.size, 0, `deps=${JSON.stringify(deps)} 时应跳过`);
  }
  assert.equal(buildRegistry([only], { designRuntime: NaN }).entries.size, 0, 'NaN 等于没注入');
  assert.equal(
    buildRegistry([only], { designRuntime: false }).entries.size,
    1,
    'false 是「这个能力关了」但宿主确实注入了，不能因此把整包裁掉',
  );
  assert.equal(buildRegistry([only], { designRuntime: 0 }).entries.size, 1, '0 是合法值（如 port:0）');
  assert.equal(buildRegistry([only], { designRuntime: {} }).entries.size, 1, '注入了真对象就应该加载');
});

test('sessionPolicy 的 temporary:false 不会被 hasDep 误判成「缺依赖」', () => {
  const plain = pack({ id: 'plain-pack', deps: ['temporary'] });
  const registry = buildRegistry([plain], { temporary: false });
  assert.equal(registry.entries.size, 1, 'temporary:false 是明确的值，不是缺失');
  assert.deepEqual(registry.skipped, []);
});

test('allowTemporary:false 的 pack 在临时会话里被跳过', () => {
  const frozen = pack({ id: 'design-canvas', sessionPolicy: { allowTemporary: false, allowBrowserOnly: true } });
  assert.equal(buildRegistry([frozen], { temporary: true }).entries.size, 0, '临时会话不应加载');
  assert.equal(buildRegistry([frozen], { temporary: false }).entries.size, 1, '普通会话应加载');
  const reasons = buildRegistry([frozen], { temporary: true }).skipped.map(item => item.reason);
  assert.deepEqual(reasons, ['session_temporary']);
});

test('allowBrowserOnly:false 的 pack 在浏览器专属会话里被跳过', () => {
  const fsPack = pack({ id: 'project-fs', sessionPolicy: { allowTemporary: true, allowBrowserOnly: false } });
  assert.equal(buildRegistry([fsPack], { browserOnly: true }).entries.size, 0, '浏览器专属会话不应加载');
  assert.equal(buildRegistry([fsPack], { browserOnly: false }).entries.size, 1);
});

test('缺 handler 的工具不暴露（实现了才暴露），其余工具照常', () => {
  const both = pack({
    tools: [tool('demo_one'), tool('demo_two')],
    handlers: { demo_one: async () => 'ok' },
  });
  const registry = buildRegistry([both], {});
  assert.deepEqual([...registry.entries.keys()], ['demo_one'], '只有实现了 handler 的才进表');
  assert.match(registry.warnings.join('\n'), /demo_two 没有 handler/, '要说明为什么少了一个工具');
});

test('两个 pack 出现同名工具时后到者让位并记 conflict 告警', () => {
  const first = pack({ id: 'pack-a', tools: [tool('shared_tool')] });
  const second = pack({ id: 'pack-b', tools: [tool('shared_tool')] });
  const registry = buildRegistry([first, second], {});
  assert.equal(registry.entries.size, 1, '同名工具只能留一个');
  assert.equal(registry.entries.get('shared_tool').pack.id, 'pack-a', '先注册的胜出');
  assert.match(registry.warnings.join('\n'), /conflict/, '必须留下冲突告警');
});

test('名字、mcpName、旧别名都能解析到同一个 canonical 工具', () => {
  const renamed = pack({
    id: 'goal-plan',
    tools: [tool('set_plan', { mcpName: 'mova_set_plan', aliases: ['mova_update_plan'] })],
  });
  const registry = buildRegistry([renamed], {});
  assert.equal(registry.aliases.get('set_plan'), 'set_plan');
  assert.equal(registry.aliases.get('mova_set_plan'), 'set_plan');
  assert.equal(registry.aliases.get('mova_update_plan'), 'set_plan', '旧名必须继续指向新工具');

  const runtime = buildSkillRuntime({ packs: [renamed], deps: {} });
  for (const name of ['set_plan', 'mova_set_plan', 'mova_update_plan']) {
    assert.equal(runtime.resolve(name)?.def?.name, 'set_plan', `${name} 应解析到 set_plan`);
  }
  assert.equal(runtime.resolve('mova_does_not_exist'), null, '未知名字返回 null 而不是抛错');
});

test('别名指向两个不同 canonical 时保留第一个并告警', () => {
  const first = pack({ id: 'pack-a', tools: [tool('plan_a', { mcpName: 'mova_plan_a', aliases: ['mova_plan'] })] });
  const second = pack({ id: 'pack-b', tools: [tool('plan_b', { mcpName: 'mova_plan_b', aliases: ['mova_plan'] })] });
  const registry = buildRegistry([first, second], {});
  assert.equal(registry.aliases.get('mova_plan'), 'plan_a', '冲突时保留第一个 canonical');
  assert.match(registry.warnings.join('\n'), /别名 mova_plan 同时指向/, '冲突要留告警');
});

test('A 的别名与 B 的 canonical 同名时，后到者整工具跳过并告警（否则会调用 B 执行 A）', () => {
  const first = pack({ id: 'pack-a', tools: [tool('plan_a', { mcpName: 'mova_plan_a', aliases: ['report_make'] })] });
  const second = pack({ id: 'pack-b', tools: [tool('report_make', { mcpName: 'mova_report_make' })] });
  const registry = buildRegistry([first, second], {});
  assert.deepEqual([...registry.entries.keys()], ['plan_a'], 'canonical 名已被别名占用：后到者不能悄悄顶掉');
  assert.match(registry.warnings.join('\n'), /已被别名占用/, '必须留下可诊断的告警');

  const runtime = buildSkillRuntime({ packs: [first, second], deps: {} });
  assert.equal(runtime.resolve('report_make')?.def?.name, 'plan_a', '别名仍指向先注册的那个工具');
});

test('pack id 重复时后到者整包跳过并告警', () => {
  const first = pack({ id: 'dupe', tools: [tool('dupe_one')] });
  const second = pack({ id: 'dupe', tools: [tool('dupe_two')] });
  const registry = buildRegistry([first, second], {});
  assert.deepEqual([...registry.entries.keys()], ['dupe_one'], '同 id 的第二个包一个工具都不能进表');
  assert.equal(registry.skipped[0].reason, 'duplicate_pack');
  assert.match(registry.warnings.join('\n'), /技能包 id 重复/);
});

test('一个坏 manifest 不影响其它 pack 加载', () => {
  const broken = { manifest: { apiVersion: 2 }, createHandlers: () => ({}) };
  const good = pack({ id: 'good-pack' });
  const registry = buildRegistry([broken, good], {});
  assert.deepEqual([...registry.entries.keys()], ['demo_one'], '好 pack 照常生效');
  assert.equal(registry.skipped[0].reason, 'invalid_manifest');
  assert.match(registry.warnings[0], /manifest 校验失败/, '坏 pack 要留下可诊断的原因');
});

test('createHandlers 抛错的 pack 被跳过而不是拖垮整张表', () => {
  const boom = {
    manifest: pack({ id: 'boom-pack' }).manifest,
    createHandlers: () => {
      throw new Error('宿主对象形状不对');
    },
  };
  const registry = buildRegistry([boom, pack({ id: 'ok-pack' })], {});
  assert.deepEqual([...registry.entries.keys()], ['demo_one']);
  assert.equal(registry.skipped[0].reason, 'create_handlers_failed');
  assert.match(registry.skipped[0].message, /宿主对象形状不对/, '原始错误信息要带出来');
});

test('pack 形状不对（缺 createHandlers）时跳过并告警', () => {
  const registry = buildRegistry([{ manifest: pack().manifest }], {});
  assert.equal(registry.entries.size, 0);
  assert.equal(registry.skipped[0].reason, 'pack_shape');
});

test('listMissingDependencies 只报依赖缺失的包，并带出缺失键', () => {
  const runtime = buildSkillRuntime({
    packs: [pack({ id: 'browser-pack', deps: ['browser', 'sender'] }), pack({ id: 'plain' })],
    deps: { sender: {} },
  });
  assert.deepEqual(runtime.listMissingDependencies(), [{ pack: 'browser-pack', missing: ['browser'] }]);
  assert.equal(runtime.listEntries().length, 1, '另一个包正常加载');
});

test('filterDeprecated 默认过滤已弃用条目，includeDeprecated 时保留', () => {
  const modern = pack({ id: 'modern', tools: [tool('modern_tool')] });
  const legacy = pack({
    id: 'legacy',
    deprecation: { deprecated: true, since: '1.4.0', removeIn: '2.0.0', replacedBy: 'modern_tool' },
    tools: [tool('legacy_tool')],
  });
  const registry = buildRegistry([modern, legacy], {});
  const kept = filterDeprecated(registry.entries);
  assert.deepEqual(kept.map(item => item.def.name), ['modern_tool'], '默认过滤弃用条目');
  const all = filterDeprecated(registry.entries, { includeDeprecated: true });
  assert.equal(all.length, 2, 'includeDeprecated 时两条都在');
  assert.equal(filterDeprecated([...registry.entries.values()]).length, 1, '接受数组与 Map 两种入参');
});

test('replacedBy 指向不存在的工具时留告警（跨包校验只有注册表能做）', () => {
  const legacy = pack({
    id: 'legacy',
    deprecation: { deprecated: true, since: '1.4.0', replacedBy: 'ghost_tool' },
  });
  const registry = buildRegistry([legacy], {});
  assert.match(registry.warnings.join('\n'), /replacedBy 指向不存在的工具：ghost_tool/);
});
