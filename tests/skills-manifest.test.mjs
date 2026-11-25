// electron/skills/manifest-schema.mjs 的单元测试。
// 全部纯内存：manifest 是朴素对象，不碰文件系统、不碰 electron。
// 每个用例只破坏一个字段，断言报错落在**那个字段的路径**上——路径错了，作者就找不到自己写错哪。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_RESULT_CHARS, MAX_RESULT_CHARS, MIN_RESULT_CHARS,
  SKILL_API_VERSION, assertValidManifest, normalizeManifest, resultBudgetOf, validateManifest,
} from '../electron/skills/manifest-schema.mjs';
import { MAX_TEXT_CHARS } from '../electron/mcp/normalize.mjs';

function tool(overrides = {}) {
  return {
    name: 'design_apply',
    mcpName: 'mova_design_apply',
    aliases: [],
    label: '编辑设计',
    description: 'Edit the shared canvas with ordered ops.',
    mcpSummary: '在共享画布执行 1–200 条操作。',
    risk: 'write',
    approval: { mode: 'policy', capability: 'write', allowSession: true },
    exposure: { piAi: true, mcp: 'on_demand' },
    timeoutMs: 45_000,
    supportsProgress: false,
    imageOutput: false,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    examples: [{ title: '创建卡片', arguments: { operations: [] } }],
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    apiVersion: 1,
    id: 'design-canvas',
    version: '1.0.0',
    title: '设计画布',
    summary: '读写与渲染当前会话共享的 OpenPencil 设计画布。',
    capabilities: ['canvas.read', 'canvas.write'],
    dependencies: ['designRuntime'],
    permissions: {
      fs: 'none', exec: false, net: false, desktop: false, browser: false, canvas: true, memory: 'none',
    },
    sessionPolicy: { allowTemporary: false, allowBrowserOnly: false },
    deprecation: null,
    tools: [tool()],
    ...overrides,
  };
}

/** 断言不合法且报错路径命中 pathFragment。 */
function expectInvalid(candidate, pathFragment) {
  const result = validateManifest(candidate);
  assert.equal(result.ok, false, `应当判定为不合法（期望 ${pathFragment} 报错）`);
  assert.ok(
    result.errors.some(error => error.path === pathFragment),
    `应当有 path=${pathFragment} 的错误，实际：${JSON.stringify(result.errors)}`,
  );
  return result;
}

test('合法的 design-canvas manifest 通过校验且没有告警', () => {
  const result = validateManifest(manifest());
  assert.deepEqual(result.errors, [], '合法 manifest 不应有错误');
  assert.deepEqual(result.warnings, [], '字段齐全时不应有告警');
  assert.equal(result.ok, true);
  assert.equal(SKILL_API_VERSION, 1, 'API 主版本必须是 1');
});

test('manifest 不是对象时直接报根路径错误', () => {
  expectInvalid(null, '');
  expectInvalid([], '');
});

test('缺 summary 时错误落在 summary 上', () => {
  const candidate = manifest();
  delete candidate.summary;
  expectInvalid(candidate, 'summary');
});

test('apiVersion=2 的旧规范被明确拒绝（不是静默忽略）', () => {
  expectInvalid(manifest({ apiVersion: 2 }), 'apiVersion');
});

test('version 不是 semver 时被拒绝', () => {
  expectInvalid(manifest({ version: '1.0' }), 'version');
  expectInvalid(manifest({ version: 'v1.0.0' }), 'version');
});

test('id 不符合 kebab-case 时被拒绝', () => {
  expectInvalid(manifest({ id: 'Design_Canvas' }), 'id');
  expectInvalid(manifest({ id: 'design--canvas' }), 'id');
  expectInvalid(manifest({ id: 'design canvas' }), 'id');
});

test('id 超过 40 字符时被拒绝', () => {
  expectInvalid(manifest({ id: 'a'.repeat(41) }), 'id');
  assert.equal(validateManifest(manifest({ id: 'a'.repeat(40) })).ok, true, '正好 40 字符应当通过');
});

test('capabilities 为空数组或含空串时被拒绝', () => {
  expectInvalid(manifest({ capabilities: [] }), 'capabilities');
  expectInvalid(manifest({ capabilities: ['canvas.read', ''] }), 'capabilities');
});

test('dependencies 可以为空数组，但不能不是数组', () => {
  assert.equal(validateManifest(manifest({ dependencies: [] })).ok, true, '空依赖是合法的');
  expectInvalid(manifest({ dependencies: 'designRuntime' }), 'dependencies');
});

test('permissions 少一个键就报错：漏声明等于运行时只能猜', () => {
  const permissions = { ...manifest().permissions };
  delete permissions.canvas;
  expectInvalid(manifest({ permissions }), 'permissions.canvas');
});

test('permissions 的枚举值写错时报错', () => {
  const permissions = { ...manifest().permissions, fs: 'rw' };
  expectInvalid(manifest({ permissions }), 'permissions.fs');
  const memory = { ...manifest().permissions, memory: true };
  expectInvalid(manifest({ permissions: memory }), 'permissions.memory');
  const browser = { ...manifest().permissions, browser: 'yes' };
  expectInvalid(manifest({ permissions: browser }), 'permissions.browser');
});

test('tools 为空数组时被拒绝', () => {
  expectInvalid(manifest({ tools: [] }), 'tools');
});

test('mcpSummary 超过 2 行被拒绝（MCP tools/list 的 token 预算）', () => {
  expectInvalid(manifest({ tools: [tool({ mcpSummary: '第一行\n第二行\n第三行' })] }), 'tools[0].mcpSummary');
  assert.equal(
    validateManifest(manifest({ tools: [tool({ mcpSummary: '第一行\n第二行' })] })).ok,
    true,
    '两行是上限内的合法值',
  );
});

test('inputSchema 缺 additionalProperties:false 被拒绝', () => {
  const inputSchema = { type: 'object', properties: {} };
  expectInvalid(manifest({ tools: [tool({ inputSchema })] }), 'tools[0].inputSchema');
});

test('inputSchema.type 不是 object 被拒绝', () => {
  const inputSchema = { type: 'string', additionalProperties: false };
  expectInvalid(manifest({ tools: [tool({ inputSchema })] }), 'tools[0].inputSchema');
});

test('examples 为空、超过 2 条、缺 title 或 arguments 都报错', () => {
  expectInvalid(manifest({ tools: [tool({ examples: [] })] }), 'tools[0].examples');
  const three = [{ title: 'a', arguments: {} }, { title: 'b', arguments: {} }, { title: 'c', arguments: {} }];
  expectInvalid(manifest({ tools: [tool({ examples: three })] }), 'tools[0].examples');
  expectInvalid(manifest({ tools: [tool({ examples: [{ arguments: {} }] })] }), 'tools[0].examples[0].title');
  expectInvalid(manifest({ tools: [tool({ examples: [{ title: 'a', arguments: [] }] })] }), 'tools[0].examples[0].arguments');
});

test('risk / approval.mode / exposure 的枚举值写错时报错', () => {
  expectInvalid(manifest({ tools: [tool({ risk: 'dangerous' })] }), 'tools[0].risk');
  expectInvalid(manifest({ tools: [tool({ approval: { mode: 'maybe' } })] }), 'tools[0].approval.mode');
  expectInvalid(manifest({ tools: [tool({ exposure: { piAi: true, mcp: 'sometimes' } })] }), 'tools[0].exposure.mcp');
  expectInvalid(manifest({ tools: [tool({ exposure: { piAi: 'yes', mcp: 'core' } })] }), 'tools[0].exposure.piAi');
});

test('risk:write 的工具不允许 approval.mode:none（写操作必须过闸门）', () => {
  expectInvalid(manifest({ tools: [tool({ approval: { mode: 'none' } })] }), 'tools[0].approval.mode');
  assert.equal(
    validateManifest(manifest({ tools: [tool({ risk: 'none', approval: { mode: 'none' } })] })).ok,
    true,
    'risk:none 的工具可以免审批',
  );
});

test('同一工具名重复出现时报错', () => {
  expectInvalid(manifest({ tools: [tool(), tool({ mcpName: 'mova_design_apply_2' })] }), 'tools[1].name');
});

test('别名与其它工具名冲突时报错（name / mcpName / aliases 共用一个命名空间）', () => {
  const second = tool({ name: 'design_read', mcpName: 'mova_design_read', aliases: ['design_apply'], risk: 'read', approval: { mode: 'policy' } });
  expectInvalid(manifest({ tools: [tool(), second] }), 'tools[1].aliases[0]');

  const clashMcp = tool({ name: 'design_read', mcpName: 'mova_design_apply', aliases: [], risk: 'read', approval: { mode: 'policy' } });
  expectInvalid(manifest({ tools: [tool(), clashMcp] }), 'tools[1].mcpName');
});

test('弃用语义：deprecated:true 时 since 必填，removeIn 必须是 semver', () => {
  expectInvalid(manifest({ deprecation: { deprecated: true } }), 'deprecation.since');
  expectInvalid(manifest({ deprecation: { deprecated: true, since: '1.2.0', removeIn: '2' } }), 'deprecation.removeIn');
  expectInvalid(manifest({ deprecation: { deprecated: true, since: '1.2.0', replacedBy: '' } }), 'deprecation.replacedBy');
  assert.equal(
    validateManifest(manifest({ deprecation: { deprecated: true, since: '1.2.0', removeIn: '2.0.0', replacedBy: 'design_apply' } })).ok,
    true,
    '字段齐全的弃用声明应当通过（replacedBy 指向是否存在由 registry 判）',
  );
  assert.equal(
    validateManifest(manifest({ deprecation: { deprecated: false } })).ok,
    true,
    'deprecated:false 不需要 since',
  );
});

test('未知字段只告警不报错（拼错字段名会被发现但不阻断加载）', () => {
  const result = validateManifest(manifest({ dependancies: [] }));
  assert.equal(result.ok, true, '未知字段不阻断');
  assert.ok(result.warnings.some(item => item.path === 'dependancies'), '应给出未知字段告警');
});

test('tool 级未知字段也告警（与顶层 MANIFEST_KEYS 同策）', () => {
  const result = validateManifest(manifest({ tools: [tool({ inputShema: { type: 'object' } })] }));
  assert.equal(result.ok, true, 'tool 级未知字段不阻断加载');
  assert.ok(
    result.warnings.some(item => item.path === 'tools[0].inputShema'),
    `应给出 tools[0].inputShema 的告警，实际：${JSON.stringify(result.warnings)}`,
  );
});

test('permissions 出现未知键时报错（多写的键不会生效，只会让人以为它生效了）', () => {
  const permissions = { ...manifest().permissions, shell: true };
  expectInvalid(manifest({ permissions }), 'permissions.shell');
});

test('mcpSummary 单行超过 160 字符被拒绝', () => {
  expectInvalid(manifest({ tools: [tool({ mcpSummary: '一'.repeat(161) })] }), 'tools[0].mcpSummary');
  assert.equal(
    validateManifest(manifest({ tools: [tool({ mcpSummary: '一'.repeat(160) })] })).ok,
    true,
    '正好 160 字符应当通过',
  );
});

test('required 必须是 properties 的子集', () => {
  const inputSchema = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: false,
  };
  expectInvalid(manifest({ tools: [tool({ inputSchema })] }), 'tools[0].inputSchema.required');
  assert.equal(
    validateManifest(manifest({
      tools: [tool({ inputSchema: { ...inputSchema, required: ['path'] } })],
    })).ok,
    true,
    'required ⊆ properties 时合法',
  );
});

test('MCP 元工具保留名：显式 mcpName 或 mova_<name> 默认推导值都拒绝', () => {
  expectInvalid(manifest({ tools: [tool({ mcpName: 'mova_skill_search' })] }), 'tools[0].mcpName');
  expectInvalid(manifest({ tools: [tool({ name: 'skill_call', mcpName: undefined, aliases: [] })] }), 'tools[0].mcpName');
  expectInvalid(manifest({ tools: [tool({ name: 'tools_search', mcpName: undefined, aliases: [] })] }), 'tools[0].mcpName');
  assert.equal(
    validateManifest(manifest({ tools: [tool({ name: 'skill_search_deep', mcpName: undefined, aliases: [] })] })).ok,
    true,
    '只是名字里含 skill_search 不算保留名',
  );
});

test('assertValidManifest 抛出的 Error 带 code 与首个错误路径', () => {
  assert.doesNotThrow(() => assertValidManifest(manifest()));
  const candidate = manifest({ version: 'abc' });
  try {
    assertValidManifest(candidate);
    assert.fail('不合法的 manifest 必须抛错');
  } catch (error) {
    assert.equal(error.code, 'invalid_manifest', '错误码必须是 invalid_manifest');
    assert.equal(error.path, 'version', 'err.path 指向第一个错误');
    assert.match(error.message, /version/, 'message 里必须带出第一个错误路径');
    assert.ok(Array.isArray(error.errors) && error.errors.length > 0, 'err.errors 保留完整错误列表');
  }
});

test('normalizeManifest 补齐 mcpName / timeoutMs / aliases / deprecation 默认值', () => {
  const candidate = manifest();
  candidate.tools = [tool({ mcpName: undefined, aliases: undefined, timeoutMs: undefined, approval: undefined })];
  candidate.deprecation = undefined;
  candidate.sessionPolicy = undefined;
  const normalized = normalizeManifest(candidate);
  const def = normalized.tools[0];
  assert.equal(def.mcpName, 'mova_design_apply', 'mcpName 默认 mova_<name>');
  assert.equal(def.timeoutMs, 30_000, 'timeoutMs 默认 30 秒');
  assert.deepEqual(def.aliases, [], 'aliases 默认空数组');
  assert.equal(normalized.deprecation, null, 'deprecation 默认 null');
  assert.deepEqual(def.approval, { mode: 'policy', capability: 'write', allowSession: false }, 'write 工具默认走 policy 审批');
  assert.equal(normalized.sessionPolicy.allowTemporary, true, 'sessionPolicy 缺省时允许临时会话');
});

test('normalizeManifest 不修改入参（manifest 通常是 Object.freeze 的纯数据）', () => {
  const candidate = manifest();
  candidate.tools = [tool({ mcpName: undefined })];
  Object.freeze(candidate.tools[0]);
  const normalized = normalizeManifest(candidate);
  assert.equal(candidate.tools[0].mcpName, undefined, '原始 manifest 不能被写入默认值');
  assert.equal(normalized.tools[0].mcpName, 'mova_design_apply');
});

test('maxResultChars 合法值通过校验，且是 tool 级白名单字段（不报未知字段）', () => {
  for (const value of [MIN_RESULT_CHARS, 24_000, 60_000]) {
    const result = validateManifest(manifest({ tools: [tool({ maxResultChars: value })] }));
    assert.deepEqual(result.errors, [], `${value} 应当是合法预算`);
    assert.deepEqual(result.warnings, [], 'maxResultChars 必须在 TOOL_KEYS 白名单里，否则会被当成拼错的字段');
  }
  assert.equal(MIN_RESULT_CHARS, 1_024);
  assert.equal(MAX_RESULT_CHARS, 60_000);
});

test('maxResultChars 越界是 error 而不是 warning（拒绝加载，不是照常加载）', () => {
  for (const value of [MIN_RESULT_CHARS - 1, MAX_RESULT_CHARS + 1, 0, -1]) {
    const result = expectInvalid(manifest({ tools: [tool({ maxResultChars: value })] }), 'tools[0].maxResultChars');
    assert.equal(result.warnings.some(item => item.path === 'tools[0].maxResultChars'), false,
      '越界必须只报 error，不能再叠一条「未知字段」告警');
  }
});

test('maxResultChars 非整数被拒绝（小数 / 字符串 / 布尔都不行）', () => {
  for (const value of [24_000.5, '24000', true]) {
    expectInvalid(manifest({ tools: [tool({ maxResultChars: value })] }), 'tools[0].maxResultChars');
  }
});

test('默认预算只有一处来源：DEFAULT_MAX_RESULT_CHARS === MAX_TEXT_CHARS，未声明时 resultBudgetOf 给默认值', () => {
  assert.equal(DEFAULT_MAX_RESULT_CHARS, MAX_TEXT_CHARS, '默认预算必须直接来自 mcp/normalize.mjs，不许另写一个 8192');
  assert.equal(DEFAULT_MAX_RESULT_CHARS, 8_192);
  assert.equal(resultBudgetOf({}), 8_192);
  assert.equal(resultBudgetOf(undefined), 8_192);
  assert.equal(resultBudgetOf({ maxResultChars: 24_000 }), 24_000, '声明了就用声明');
  assert.equal(resultBudgetOf({ maxResultChars: 24_000 }, 500), 24_000, '声明优先于适配器的兜底上限');
  assert.equal(resultBudgetOf({}, 500), 500, '没声明时才用兜底上限');
  assert.equal(resultBudgetOf({ maxResultChars: 1 }), 8_192, '越界值退到默认，绝不能变成 0 把结果砍光');
});
