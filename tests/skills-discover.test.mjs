// electron/skills/discover.mjs 的单元测试（mova_skill_search 的核心）。
// 全部纯内存：registry 由 buildSkillRuntime 现场搭建，handler 是 async () => 'ok'。
// 断言偏「模型真的能查到什么」：中文能不能命中、空 query 给几条、includeSchema 是否够调用、弃用是否被过滤。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { searchSkills } from '../electron/skills/discover.mjs';

function tool(name, { label = `${name} 展示名`, description = `Do ${name}.`, risk = 'read', mcpSummary, ...rest } = {}) {
  return {
    name,
    label,
    description,
    mcpSummary: mcpSummary ?? `${name} 一行摘要。`,
    risk,
    approval: { mode: risk === 'write' ? 'policy' : 'policy' },
    exposure: { piAi: true, mcp: 'on_demand' },
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    examples: [{ title: '最小示例', arguments: { text: 'hi' } }],
    ...rest,
  };
}

function pack({ id, title, summary, tools, deprecation = null }) {
  return {
    manifest: {
      apiVersion: 1,
      id,
      version: '1.0.0',
      title,
      summary,
      capabilities: ['demo.capability'],
      dependencies: [],
      permissions: { fs: 'none', exec: false, net: false, desktop: false, browser: false, canvas: true, memory: 'none' },
      deprecation,
      tools,
    },
    createHandlers: () => Object.fromEntries(tools.map(item => [item.name, async () => 'ok'])),
  };
}

const DESIGN = pack({
  id: 'design-canvas',
  title: '设计画布',
  summary: '设计画板：读写并渲染当前会话共享的 OpenPencil 画板（节点树、样式、字体、截图）。',
  tools: [
    tool('design_open', { label: '打开画板', description: 'Open the shared canvas panel.' }),
    tool('design_read', { label: '读取画板', description: 'Read the canvas node tree.' }),
    tool('design_apply', {
      label: '编辑设计',
      description: '在画板执行 1-200 条 create/update/delete 操作。',
      risk: 'write',
      mcpSummary: '在共享画板执行 1–200 条操作。',
    }),
    tool('design_undo', { label: '撤销设计', description: 'Undo the last canvas op.' }),
    tool('design_screenshot', { label: '画板截图', description: 'Screenshot the canvas.', imageOutput: true }),
  ],
});

const BROWSER = pack({
  id: 'browser-automation',
  title: '内置浏览器控制',
  summary: '控制 Mova 侧边浏览器：导航、结构化读取、交互、批量执行、站点技能复用与人工接管。',
  tools: [
    tool('browser_navigate', { label: '打开网页', description: 'Navigate the built-in browser.' }),
    tool('browser_read', { label: '读取网页', description: 'Read the structured page text.' }),
    tool('browser_batch', { label: '批量操作', description: 'Run up to 30 browser steps.', risk: 'exec' }),
    tool('browser_screenshot', { label: '网页截图', description: 'Screenshot the page.', imageOutput: true }),
    tool('browser_handoff', { label: '人工接管', description: 'Hand the browser to the user.' }),
  ],
});

const LEGACY = pack({
  id: 'legacy-canvas',
  title: '旧画板',
  summary: '已弃用的旧画板工具。',
  deprecation: { deprecated: true, since: '1.2.0', removeIn: '2.0.0', replacedBy: 'design_apply' },
  tools: [tool('legacy_canvas_paint', { label: '旧画板绘制', description: 'Old canvas painter.' })],
});

function makeRuntime() {
  return buildSkillRuntime({ packs: [DESIGN, BROWSER, LEGACY], deps: {} });
}

test('空 query 返回目录前 8 条，并说明还有更多', () => {
  const runtime = makeRuntime();
  const result = runtime.search({});
  assert.equal(result.matches.length, 8, '空 query 默认给 8 条');
  assert.equal(result.total, 10, 'total 报出真实命中数（弃用的那条已被过滤）');
  assert.equal(result.matches[0].name, 'design_open', '空 query 按注册顺序返回，顺序稳定');
  assert.match(result.note, /未提供 query/, '要提示可以怎么精确检索');
  assert.match(result.note, /共命中 10 条/, '条数超出时要说明被截断');
});

test('limit 可调，且不超过池子大小', () => {
  const runtime = makeRuntime();
  assert.equal(runtime.search({ limit: 3 }).matches.length, 3);
  assert.equal(runtime.search({ limit: 999 }).matches.length, 10, 'limit 大于可用工具数时按实际数量返回');
});

test('中文「画板」能命中设计画布的工具（不会因为整词不在描述里就全空）', () => {
  const runtime = makeRuntime();
  const names = runtime.search({ query: '画板', limit: 20 }).matches.map(match => match.name);
  assert.ok(names.includes('design_apply'), `应命中 design_apply，实际 ${names.join(',')}`);
  assert.ok(names.includes('design_screenshot'), '同一技能包里的工具都应可被发现');
  assert.ok(!names.includes('browser_navigate'), '不相关技能包不应混进来');
});

test('中文「浏览器」能命中内置浏览器工具', () => {
  const runtime = makeRuntime();
  const matches = runtime.search({ query: '浏览器', limit: 20 }).matches;
  const names = matches.map(match => match.name);
  assert.ok(names.includes('browser_navigate'), `应命中 browser_navigate，实际 ${names.join(',')}`);
  assert.ok(matches.every(match => match.pack === 'browser-automation'), '命中项都应属于浏览器技能包');
});

test('英文名精确命中排在前面，mcpName 形式也能查到', () => {
  const runtime = makeRuntime();
  assert.equal(runtime.search({ query: 'browser_navigate' }).matches[0].name, 'browser_navigate');
  const byMcp = runtime.search({ query: 'mova_design_apply' }).matches;
  assert.equal(byMcp[0].name, 'design_apply', 'mova_ 前缀名也应被识别');
});

test('includeSchema 时返回可直接调用的一切：schema / examples / dependencies / risk / permissions', () => {
  const runtime = makeRuntime();
  const match = runtime.search({ tool: 'design_apply', includeSchema: true }).matches[0];
  assert.equal(match.name, 'design_apply');
  assert.equal(match.mcpName, 'mova_design_apply');
  assert.equal(match.risk, 'write');
  assert.equal(match.inputSchema.type, 'object');
  assert.equal(match.inputSchema.additionalProperties, false);
  assert.equal(match.examples.length, 1);
  assert.deepEqual(match.examples[0].arguments, { text: 'hi' });
  assert.deepEqual(match.dependencies, []);
  assert.equal(match.permissions.canvas, true);
  assert.equal(match.pack, 'design-canvas');
});

test('不传 includeSchema 时不返回 schema（省 token）', () => {
  const runtime = makeRuntime();
  const match = runtime.search({ query: 'design_apply' }).matches[0];
  assert.equal('inputSchema' in match, false, '默认不要塞 schema');
  assert.equal('examples' in match, false);
  assert.equal(match.summary.length > 0, true, '摘要要有，否则模型不知道这工具干什么');
});

test('skillId 定位整包工具（并自动带 schema）', () => {
  const runtime = makeRuntime();
  const result = runtime.search({ skillId: 'browser-automation' });
  assert.equal(result.matches.length, 5, '该包 5 个工具全部返回');
  assert.ok(result.matches.every(match => match.pack === 'browser-automation'));
  assert.ok(result.matches.every(match => match.inputSchema?.type === 'object'), 'skillId 时自动带 schema');
});

test('未知 skillId 返回空集合并说明原因', () => {
  const runtime = makeRuntime();
  const result = runtime.search({ skillId: 'no-such-pack' });
  assert.deepEqual(result.matches, []);
  assert.match(result.note, /没有名为 no-such-pack/, '空结果要给可诊断的说明');
});

test('默认过滤已弃用技能包，includeDeprecated 时才出现并带迁移提示', () => {
  const runtime = makeRuntime();
  assert.equal(runtime.search({}).hiddenDeprecated, 1, '默认隐藏了 1 条弃用条目');
  assert.ok(
    !runtime.search({ query: 'legacy', limit: 20 }).matches.length,
    '弃用工具默认查不到',
  );

  const withDeprecated = runtime.search({ query: 'legacy', includeDeprecated: true });
  const match = withDeprecated.matches[0];
  assert.equal(match.name, 'legacy_canvas_paint');
  assert.equal(match.deprecated, true);
  assert.match(match.note, /已弃用/, '弃用条目要带 note');
  assert.match(match.note, /design_apply/, 'note 要指向 replacedBy');
  assert.match(runtime.search({}).note, /includeDeprecated:true/, '默认结果要说明怎么看到弃用条目');
});

test('searchSkills 直接吃 registry（Map 形态）也能用', () => {
  const runtime = makeRuntime();
  const entries = runtime.registry.entries;
  const fromMap = searchSkills({ entries }, { query: 'browser_batch' });
  assert.equal(fromMap.matches[0].name, 'browser_batch');
  const fromList = searchSkills(runtime.listEntries(), { query: 'browser_batch' });
  assert.equal(fromList.matches[0].name, 'browser_batch', '裸数组入参同样支持');
});

test('别名查询（mova_update_plan 这类旧名）能定位到 canonical 工具', () => {
  const renamed = pack({
    id: 'goal-plan',
    title: '目标与计划',
    summary: '设置会话目标卡与计划步骤。',
    tools: [tool('set_plan', { label: '更新计划', description: 'Replace the plan steps.', aliases: ['mova_update_plan'] })],
  });
  const runtime = buildSkillRuntime({ packs: [renamed], deps: {} });
  const result = runtime.search({ tool: 'mova_update_plan', includeSchema: true });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].name, 'set_plan');
});

// ── 默认结果里的精简签名（方案 §3.1 的 P0：把「两跳」压成「一跳」）────────────────
// 契约：默认结果带一行签名，照它就能发起调用；includeSchema:true 的输出格式保持原样。

test('默认结果带一行精简签名（必填带 *），includeSchema 时不带（那条路径维持原样）', () => {
  const runtime = makeRuntime();
  const plain = runtime.search({ query: 'browser_navigate' }).matches[0];
  assert.equal(plain.signature, 'mova_browser_navigate(text: string*) — browser_navigate 一行摘要。');
  assert.equal('inputSchema' in plain, false, '默认仍然不塞 schema');

  const withSchema = runtime.search({ tool: 'browser_navigate', includeSchema: true }).matches[0];
  assert.equal('signature' in withSchema, false, '有完整 schema 就不需要签名，输出格式不能变');
  assert.equal(withSchema.inputSchema.type, 'object');
});

test('签名的预算降级顺序：先丢可选字段 → 再丢描述 → 最后才只给名字', () => {
  const schemas = () => ({
    type: 'object',
    properties: {
      needed: { type: 'string' },
      alpha: { type: 'string' },
      beta: { type: 'string' },
      gamma: { type: 'string' },
      delta: { type: 'string' },
    },
    required: ['needed'],
    additionalProperties: false,
  });
  const tools = Array.from({ length: 8 }, (_, index) => tool(`sig_${index}`, {
    // 描述故意写长：预算是要「挤」出来的，不是天然就超。
    mcpSummary: `第 ${index} 个工具要做的事情写在这里，这句话会占掉一些字符用来触发预算收敛。`,
    inputSchema: schemas(),
  }));
  const runtime = buildSkillRuntime({
    packs: [pack({ id: 'signature-pack', title: '签名测试包', summary: '验证签名预算降级的包。', tools })],
    deps: {},
  });

  const snapshot = budget => {
    const payload = searchSkills(runtime, { limit: 8, maxChars: budget });
    const rows = payload.matches;
    return {
      budget,
      rows: rows.length,
      rowsWithSignature: rows.filter(row => typeof row.signature === 'string').length,
      rowsWithOptional: rows.filter(row => row.signature?.includes('alpha?:')).length,
      rowsWithDescription: rows.filter(row => row.signature?.includes(' — ')).length,
      stubs: rows.filter(row => row.signature === undefined).length,
      note: payload.note,
    };
  };

  const snapshots = [];
  for (let budget = 9_000; budget >= 300; budget -= 50) snapshots.push(snapshot(budget));

  // 单调性：预算越小，可选字段与描述只会更少，「只剩名字」的比例只会更高，
  // 条数只会更少（最后还是超预算就减少条数——与 includeSchema 分支同一套兜底）。
  for (let index = 1; index < snapshots.length; index += 1) {
    const high = snapshots[index - 1];
    const low = snapshots[index];
    assert.ok(low.rows <= high.rows, `预算变小时条数不应变多：${high.rows}→${low.rows}`);
    assert.ok(low.rowsWithOptional <= high.rowsWithOptional,
      `预算 ${high.budget}→${low.budget} 时可选字段不应变多：${high.rowsWithOptional}→${low.rowsWithOptional}`);
    assert.ok(low.rowsWithDescription <= high.rowsWithDescription,
      `预算 ${high.budget}→${low.budget} 时描述不应变多：${high.rowsWithDescription}→${low.rowsWithDescription}`);
    assert.ok(low.stubs / low.rows >= high.stubs / high.rows,
      `预算 ${high.budget}→${low.budget} 时「只给名字」的比例不应下降：${high.stubs}/${high.rows}→${low.stubs}/${low.rows}`);
  }

  // 档 1：已经丢了可选字段，但每条仍然带描述、且一条都没退化成「只给名字」。
  const optionalDropped = snapshots.find(item => item.rows === 8
    && item.stubs === 0 && item.rowsWithDescription === 8 && item.rowsWithOptional < 8);
  assert.ok(optionalDropped, `应当存在「只丢可选字段」的预算档，实际快照：${JSON.stringify(snapshots)}`);
  assert.match(optionalDropped.note, /参数签名已压缩/, '压缩要在 note 里说明怎么拿完整参数');
  assert.match(optionalDropped.note, /includeSchema|tool:"<名称>"/, 'note 要告诉模型怎么继续查');

  // 档 2：可选字段全丢、描述开始丢，但每条签名还在（还没到「只给名字」那一档）。
  const descriptionDropped = snapshots.find(item => item.stubs === 0
    && item.rowsWithOptional === 0 && item.rowsWithDescription < item.rows
    && item.rowsWithSignature === item.rows);
  assert.ok(descriptionDropped, '描述必须在「只给名字」之前先被丢掉');

  // 档 3：预算再紧才允许出现「只给名字」。
  const stubbed = snapshots.find(item => item.stubs > 0);
  assert.ok(stubbed, '预算极紧时最终降级成「只给名字」');
  assert.match(stubbed.note, /只给名字/, '这一档的 note 文案与 includeSchema 分支一致');

  // 无论哪一档，留下来的签名都还能直接定位工具。
  for (const item of snapshots) {
    const payload = searchSkills(runtime, { limit: 8, maxChars: item.budget });
    for (const row of payload.matches) {
      assert.equal(typeof row.mcpName, 'string', '降级后仍要能按名字再查一次');
      if (row.signature !== undefined) assert.match(row.signature, /^mova_sig_\d+\(/, '签名必须以工具名开头');
    }
  }
});

test('includeSchema 的降级路径不受签名影响：仍然只留名字，且不掺 signature 字段', () => {
  const bigSchema = () => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [
      `field_${index}`, { type: 'string', description: 'x'.repeat(80) },
    ])),
    required: [],
  });
  const tools = Array.from({ length: 8 }, (_, index) => tool(`bulk_${index}`, { inputSchema: bigSchema() }));
  const runtime = buildSkillRuntime({
    packs: [pack({ id: 'bulk-pack', title: '大 schema 包', summary: '演示超预算降级。', tools })],
    deps: {},
  });
  const payload = searchSkills(runtime, { limit: 8, includeSchema: true, maxChars: 8192 });
  assert.ok(payload.matches.some(row => row.inputSchema === undefined), '超预算的条目仍降级成「只给名字」');
  assert.ok(payload.matches.every(row => !('signature' in row)), 'includeSchema 分支不产出 signature');
  assert.match(payload.note, /降级/);
});

