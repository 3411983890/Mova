// electron/skills/packs/design-canvas 的清单与行为测试：manifest 合法性、依赖裁剪、
// 写类授权被拒时零副作用、截图落盘 / 降级、参数非法、以及 image 元数据经 buildSkillRuntime
// 真正进到 tool 事件上（这条是「截图内联」的唯一证据链）。
// 全部纯内存 fake：没有真实 Electron、没有真实 fs、没有真实画板。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { assertValidManifest, validateManifest } from '../electron/skills/manifest-schema.mjs';
import { buildRegistry } from '../electron/skills/registry.mjs';
import { DEFAULT_PACKS } from '../electron/skills/packs/index.mjs';
import { createHandlers } from '../electron/skills/packs/design-canvas/handlers.mjs';
import { manifest } from '../electron/skills/packs/design-canvas/manifest.mjs';

const PACK = Object.freeze({ manifest, createHandlers });
const TOOL_NAMES = ['design_apply', 'design_fonts', 'design_open', 'design_read', 'design_screenshot', 'design_undo'];
/** 与 chat-images.cjs 的内容寻址 id 同形（sha256 + 扩展名），测试里不需要真算哈希。 */
const IMAGE_ID = `${'a'.repeat(64)}.png`;
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* ── 共用 fake ─────────────────────────────────────────────────────── */

function textOf(result) {
  const part = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text') : null;
  return typeof part?.text === 'string' ? part.text : '';
}

/** 错误结果的唯一形状：`{ "error": code, "message": ... }`（与 mcp/normalize.mjs 一致）。 */
function errorOf(result) {
  try {
    const payload = JSON.parse(textOf(result));
    return payload && typeof payload.error === 'string' ? payload : null;
  } catch {
    return null;
  }
}

function collector() {
  const events = [];
  return { events, emit: event => events.push(event) };
}

function allowAuthorize() {
  const calls = [];
  return { calls, authorize: async (def, args) => { calls.push(args); return { allowed: true }; } };
}

function denyAuthorize(code = 'approval_denied') {
  const calls = [];
  return {
    calls,
    authorize: async (def, args) => {
      calls.push(args);
      return { allowed: false, code, reason: '用户拒绝了这次操作' };
    },
  };
}

/**
 * 假的 designRuntime：只实现 handler 真正用到的那一个方法 `tools(sender, scope, signal, emit, options)`，
 * 返回 6 个与真运行时同形的工具（`execute(id, input)`）。每次 execute 都记进 calls，
 * 用来证明「授权被拒 = 一次画布调用都没有」。
 */
function fakeDesignRuntime({ calls = [] } = {}) {
  const build = name => ({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(id, input) {
      calls.push({ name, id, input });
      if (name === 'design_screenshot') return screenshotToolResult();
      if (name === 'design_apply') {
        const details = { created: [{ id: 'n1' }, { id: 'n2' }], applied: [{ id: 'n3' }], failed: [], revision: 3 };
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
      const details = { revision: 2 };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
  return { calls, tools: () => TOOL_NAMES.map(build) };
}

/**
 * 真运行时 `shapeScreenshot` 的形状：base64 被从 meta 里摘出来放进 `content[1]` 的 image 块，
 * 文本块只剩元数据。这里如实还原——handler 的落盘逻辑必须能从 image 块里拿到像素。
 */
function screenshotToolResult() {
  const meta = { width: 1280, height: 800, scale: 1, byteLength: 4096, mimeType: 'image/png', revision: 4 };
  return {
    content: [
      { type: 'text', text: JSON.stringify(meta) },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ],
    details: meta,
  };
}

/** 只有一个截图工具的运行时：用来证明「handler 按名字取实现」而不是无条件造 6 个。 */
function screenshotOnlyRuntime({ calls = [] } = {}) {
  return {
    calls,
    tools: () => [{
      name: 'design_screenshot',
      label: 'design_screenshot',
      description: 'design_screenshot',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(id, input) {
        calls.push({ name: 'design_screenshot', id, input });
        return screenshotToolResult();
      },
    }],
  };
}

function fakeChatImages() {
  const saved = [];
  return {
    saved,
    saveImage: async (attachment, options) => {
      saved.push({ attachment, options });
      return { id: IMAGE_ID, name: attachment?.name ?? '图片', mimeType: 'image/png', base64: PNG_BASE64 };
    },
  };
}

function depsWith(overrides = {}) {
  return {
    designRuntime: fakeDesignRuntime(),
    sender: { id: 7, send() {} },
    conversationId: 'conv-1',
    ...overrides,
  };
}

/* ── 1. manifest ───────────────────────────────────────────────────── */

test('design-canvas 的 manifest 通过 validateManifest，且没有任何未知字段告警', () => {
  assert.doesNotThrow(() => assertValidManifest(manifest));
  const result = validateManifest(manifest);
  assert.deepEqual(result.errors, [], 'manifest 不应有校验错误');
  assert.deepEqual(result.warnings, [], `manifest 不应有告警：${JSON.stringify(result.warnings)}`);
  assert.equal(manifest.id, 'design-canvas');
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.dependencies, ['designRuntime', 'sender', 'conversationId']);
  assert.equal(manifest.permissions.canvas, true);
  assert.equal(manifest.permissions.fs, 'none');
  assert.equal(manifest.permissions.net, false);
});

test('6 个工具名与 designRuntime 一致，全部 on_demand + piAi，写类走审批闸门', () => {
  assert.deepEqual(manifest.tools.map(def => def.name).sort(), TOOL_NAMES);
  for (const def of manifest.tools) {
    assert.equal(def.mcpName, `mova_${def.name}`, `${def.name} 的 mcpName 必须是 mova_ 前缀`);
    assert.deepEqual(def.exposure, { piAi: true, mcp: 'on_demand' }, `${def.name} 不该占用 core`);
    assert.ok(!def.name.startsWith('mova_'));
  }
  const write = manifest.tools.filter(def => def.risk === 'write').map(def => def.name).sort();
  assert.deepEqual(write, ['design_apply', 'design_undo'], '只有 apply / undo 会改动画布文档');
  for (const def of manifest.tools.filter(item => item.risk === 'write')) {
    assert.equal(def.approval.mode, 'policy');
    assert.equal(def.approval.capability, 'write');
    assert.equal(def.approval.allowSession, true);
  }
  const apply = manifest.tools.find(def => def.name === 'design_apply');
  assert.equal(apply.timeoutMs, 45_000);
  assert.equal(apply.inputSchema.properties.operations.maxItems, 200);
  assert.equal(apply.inputSchema.properties.operations.minItems, 1);
  assert.deepEqual(apply.inputSchema.required, ['operations']);
  assert.equal(manifest.tools.find(def => def.name === 'design_screenshot').imageOutput, true);
});

test('DEFAULT_PACKS 里没有重复登记，工具暴露名也不与既有 pack 冲突', () => {
  const registered = DEFAULT_PACKS.filter(pack => pack.manifest.id === 'design-canvas');
  assert.equal(registered.length, 1, 'design-canvas 必须已在 DEFAULT_PACKS 里登记一次');
  // 冲突检查要排除自己：注册生效后 design-canvas 本身也在 DEFAULT_PACKS 里。
  const others = DEFAULT_PACKS.filter(pack => pack.manifest.id !== 'design-canvas');
  const existing = new Set(others.flatMap(pack => pack.manifest.tools
    .flatMap(def => [def.name, def.mcpName, ...(def.aliases ?? [])])));
  for (const def of manifest.tools) {
    for (const name of [def.name, def.mcpName, ...(def.aliases ?? [])]) {
      assert.ok(!existing.has(name), `暴露名 ${name} 与其他 pack 的工具冲突`);
    }
  }
});

test('缺 provider 依赖时整包被裁（missing_dependencies），依赖齐全时 6 个工具全部注册且都不进 core', () => {
  const skipped = buildRegistry([PACK], { sender: { id: 1 }, conversationId: 'c' });
  assert.deepEqual(skipped.packs, []);
  assert.equal(skipped.skipped[0].reason, 'missing_dependencies');
  assert.deepEqual(skipped.skipped[0].missing, ['designRuntime']);

  const loaded = buildRegistry([PACK], depsWith());
  assert.deepEqual(loaded.skipped, []);
  assert.deepEqual([...loaded.entries.keys()].sort(), TOOL_NAMES);
  assert.ok([...loaded.entries.values()].every(entry => entry.def.exposure.mcp !== 'core'));
});

/* ── 2. handler 装配 ───────────────────────────────────────────────── */

test('依赖齐全时 6 个 handler 都在；designRuntime 缺失时一个都不暴露', () => {
  const handlers = createHandlers(depsWith());
  assert.deepEqual(Object.keys(handlers).sort(), TOOL_NAMES);
  for (const name of TOOL_NAMES) assert.equal(typeof handlers[name], 'function', `${name} 必须是函数`);

  for (const broken of [{}, { designRuntime: null }, { designRuntime: {} }, { designRuntime: { tools: 1 } }]) {
    assert.deepEqual(createHandlers(broken), {}, `${JSON.stringify(Object.keys(broken))} 时应返回 {}`);
  }
  // sender / conversationId 是 manifest 里的硬依赖：单独调用时也不能造出「一调就报错」的工具。
  assert.deepEqual(createHandlers({ designRuntime: fakeDesignRuntime(), sender: { id: 1 } }), {});
  assert.deepEqual(createHandlers({ designRuntime: fakeDesignRuntime(), conversationId: 'c' }), {});
  // 运行时探测抛错 → 不暴露（宁可少工具，也不要假工具）。
  assert.deepEqual(createHandlers({ ...depsWith(), designRuntime: { tools() { throw new Error('boom'); } } }), {});
});

/* ── 3. 写类授权 ───────────────────────────────────────────────────── */

test('design_apply 在 ctx.authorize() 拒绝时零副作用，并把拒绝码透传成 isError', async () => {
  const design = fakeDesignRuntime();
  const handlers = createHandlers(depsWith({ designRuntime: design }));
  const denied = denyAuthorize();
  const { events, emit } = collector();

  const result = await handlers.design_apply({ operations: [{ action: 'delete', id: 'n1' }] }, {
    callId: 'mcp-1', emit, authorize: denied.authorize,
  });

  assert.equal(result.isError, true);
  assert.equal(errorOf(result)?.error, 'approval_denied');
  assert.equal(denied.calls.length, 1, '必须真的走过授权闸门');
  assert.deepEqual(design.calls, [], '被拒后不允许发生任何画布调用');
  assert.ok(events.some(event => event.type === 'notice'), '拒绝要有一条旁白说明原因');
});

test('design_apply 缺少 ctx.authorize 时按最保守策略拒绝，design_undo 同理', async () => {
  const design = fakeDesignRuntime();
  const handlers = createHandlers(depsWith({ designRuntime: design }));
  for (const name of ['design_apply', 'design_undo']) {
    const args = name === 'design_apply' ? { operations: [{ action: 'create', type: 'FRAME' }] } : {};
    const result = await handlers[name](args, { callId: 'mcp-2' });
    assert.equal(result.isError, true, `${name} 没有授权通道时必须拒绝`);
    assert.equal(errorOf(result)?.error, 'permission_unavailable');
  }
  assert.deepEqual(design.calls, []);
});

test('design_apply 授权通过后调用一次画布工具，返回 revision 摘要与 created/failed 计数', async () => {
  const design = fakeDesignRuntime();
  const handlers = createHandlers(depsWith({ designRuntime: design }));
  const allowed = allowAuthorize();
  const { events, emit } = collector();
  const operations = [{ action: 'create', type: 'FRAME', name: 'Card' }];

  const result = await handlers.design_apply({ operations, basedOnRevision: 2 }, {
    callId: 'mcp-3', emit, authorize: allowed.authorize,
  });

  assert.equal(result.isError, undefined);
  assert.equal(design.calls.length, 1);
  assert.equal(design.calls[0].id, 'mcp-3', '画布调用必须复用本行的 callId');
  assert.deepEqual(design.calls[0].input, { operations, basedOnRevision: 2 });
  assert.match(result.detail, /revision=3/);
  assert.match(result.detail, /新增 2/);
  assert.match(result.detail, /失败 0/);
  assert.equal(allowed.calls.length, 1);
  assert.ok(!events.some(event => event.type === 'notice'), '放行时不该有拒绝旁白');
});

test('design_undo 授权通过后只调一次画布工具；design_open 是只读，不请求授权', async () => {
  const design = fakeDesignRuntime();
  const handlers = createHandlers(depsWith({ designRuntime: design }));
  const allowed = allowAuthorize();

  const undone = await handlers.design_undo({}, { callId: 'mcp-4', authorize: allowed.authorize });
  assert.equal(undone.isError, undefined);
  assert.equal(design.calls.length, 1);
  assert.equal(design.calls[0].name, 'design_undo');

  const opened = await handlers.design_open({}, { callId: 'mcp-5', authorize: denyAuthorize().authorize });
  assert.equal(opened.isError, undefined, 'design_open 只读，不该被写授权拦住');
  assert.equal(design.calls.length, 2);
  assert.equal(design.calls[1].name, 'design_open');
});

/* ── 4. 截图落盘 / 降级 ────────────────────────────────────────────── */

test('design_screenshot 落盘后返回 image.id / image.src，正文只给尺寸', async () => {
  const design = screenshotOnlyRuntime();
  const chatImages = fakeChatImages();
  const handlers = createHandlers(depsWith({ designRuntime: design, chatImages }));

  const result = await handlers.design_screenshot({}, { callId: 'mcp-6', supportsImages: false });

  assert.equal(result.isError, undefined);
  assert.equal(chatImages.saved.length, 1, '必须调一次 chatImages.saveImage');
  const { attachment } = chatImages.saved[0];
  assert.equal(attachment.dataUrl, `data:image/png;base64,${PNG_BASE64}`);
  assert.match(attachment.name, /^画板截图 · 1280×800$/);

  assert.equal(result.image?.id, IMAGE_ID);
  assert.equal(result.image?.name, '画板截图 · 1280×800');
  assert.equal(result.image?.src, `./chat-images/${IMAGE_ID}`);
  assert.match(textOf(result), /1280/);
  assert.equal(result.content.filter(item => item.type === 'image').length, 0, '不支持看图的通道不给 image 块');
  assert.match(textOf(result), /不支持看图/, '要明确告诉模型它只拿到了数字');
  assert.match(result.detail, /1280×800/);
});

test('supportsImages 为 true 时保留 image 块（像素与 image 元数据同时给）', async () => {
  const chatImages = fakeChatImages();
  const handlers = createHandlers(depsWith({ designRuntime: screenshotOnlyRuntime(), chatImages }));
  const result = await handlers.design_screenshot({ nodeId: 'n1', maxEdge: 1024 }, {
    callId: 'mcp-7', supportsImages: true,
  });
  assert.equal(result.image?.id, IMAGE_ID);
  const block = result.content.find(item => item.type === 'image');
  assert.ok(block, '支持看图的通道必须收到 image 块');
  assert.equal(block.data, PNG_BASE64);
  assert.equal(block.mimeType, 'image/png');
});

test('chatImages 缺失时降级：不落盘、正文说明尺寸、加一条 notice、绝不抛', async () => {
  const handlers = createHandlers(depsWith({ designRuntime: screenshotOnlyRuntime() }));
  const { events, emit } = collector();

  const result = await handlers.design_screenshot({}, { callId: 'mcp-8', emit });

  assert.equal(result.isError, undefined, 'chatImages 缺失不许报错中断');
  assert.equal(result.image, undefined, '没落盘就不该有 image 元数据（否则前端会出现裂图）');
  const text = textOf(result);
  assert.match(text, /1280/);
  assert.match(text, /无法保存/);
  const notice = events.find(event => event.type === 'notice');
  assert.ok(notice, '必须有一条「截图无法保存」的旁白');
  assert.match(notice.text, /无法保存/);
});

test('saveImage 抛错（例如超过 4 MB）时同样降级，不抛也不回裂图', async () => {
  const chatImages = {
    saveImage: async () => { throw new Error('image_size'); },
  };
  const handlers = createHandlers(depsWith({ designRuntime: screenshotOnlyRuntime(), chatImages }));
  const { events, emit } = collector();

  const result = await handlers.design_screenshot({}, { callId: 'mcp-9', emit });

  assert.equal(result.isError, undefined);
  assert.equal(result.image, undefined);
  assert.match(textOf(result), /image_size/);
  assert.ok(events.some(event => event.type === 'notice'));
});

/* ── 5. 参数非法 ───────────────────────────────────────────────────── */

test('参数非法一律 isError + invalid_arguments，且一次画布调用都不发生', async () => {
  const design = fakeDesignRuntime();
  const handlers = createHandlers(depsWith({ designRuntime: design }));
  const ctx = { callId: 'mcp-10', authorize: allowAuthorize().authorize };
  const many = Array.from({ length: 201 }, () => ({ action: 'delete', id: 'n1' }));

  const cases = [
    ['design_apply', {}],
    ['design_apply', { operations: 'create' }],
    ['design_apply', { operations: [] }],
    ['design_apply', { operations: many }],
    ['design_apply', { operations: [null] }],
    ['design_apply', { operations: [{ action: 'create' }], basedOnRevision: 1.5 }],
    ['design_read', { depth: 0 }],
    ['design_read', { query: 'x'.repeat(501) }],
    ['design_read', { fonts: 'yes' }],
    ['design_screenshot', { format: 'GIF' }],
    ['design_screenshot', { ids: 'n1' }],
    ['design_screenshot', { ids: ['n1', 2] }],
    ['design_screenshot', { scale: 99 }],
    ['design_fonts', { family: 42 }],
  ];
  for (const [name, args] of cases) {
    const result = await handlers[name](args, ctx);
    assert.equal(result.isError, true, `${name}(${JSON.stringify(args).slice(0, 40)}) 应当被拒绝`);
    assert.equal(errorOf(result)?.error, 'invalid_arguments', `${name} 的错误码必须是 invalid_arguments`);
  }
  assert.deepEqual(design.calls, [], '参数非法时不该发生任何画布调用');
});

/* ── 6. 事件链路（extractMeta 的 image 透传）────────────────────────── */

test('经 buildSkillRuntime 调用 design_screenshot：done 事件带 image，running/done 共用同一个 id', async () => {
  const chatImages = fakeChatImages();
  const { events, emit } = collector();
  const runtime = buildSkillRuntime({
    packs: [PACK],
    deps: {
      designRuntime: screenshotOnlyRuntime(),
      sender: { id: 7, send() {} },
      conversationId: 'conv-1',
      chatImages,
      emit,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  });

  const result = await runtime.invoke('mova_design_screenshot', {}, { callId: 'mcp-11' });
  assert.equal(result?.isError, undefined);

  const done = events.find(event => event.type === 'tool' && event.status === 'done');
  assert.ok(done, '必须发出 done 事件');
  assert.equal(done.id, 'mcp-11');
  assert.equal(done.image?.id, IMAGE_ID);
  assert.equal(done.image?.src, `./chat-images/${IMAGE_ID}`);
  assert.ok(events.every(event => event.type !== 'image'), '截图绝不能发 {type:"image"} 事件（会污染用户附件）');
  assert.equal(chatImages.saved.length, 1);
});
