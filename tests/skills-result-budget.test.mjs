// 技能结果预算（maxResultChars）的端到端测试：一个工具声明了 24000，另一个没声明。
// 同一个 20k 文本必须出现两种结果：声明过的**原样交出**（工具自己的 maxChars 预算不被技能层砍掉），
// 没声明的按 MAX_TEXT_CHARS(8192) 截断；两条适配器（MCP / pi-ai）拿到的结果必须逐字一致。
// 全部纯内存：假 pack + 假 handler，不起 HTTP、不碰 electron。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMcpToolTable } from '../electron/skills/adapters/mcp.mjs';
import { toPiAiTools } from '../electron/skills/adapters/pi-ai.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { MAX_TEXT_CHARS } from '../electron/mcp/normalize.mjs';
import { manifest as browserManifest } from '../electron/skills/packs/browser-automation/manifest.mjs';
import { manifest as desktopManifest } from '../electron/skills/packs/desktop-control/manifest.mjs';
import { manifest as designManifest } from '../electron/skills/packs/design-canvas/manifest.mjs';
import { manifest as projectFsManifest } from '../electron/skills/packs/project-fs/manifest.mjs';

/** 20k 的正文：比默认预算小、比 24000 也小，所以它只在「默认预算」那条路上被砍。 */
const BIG_TEXT = 'x'.repeat(20_000);

function tool(name, overrides = {}) {
  return {
    name,
    label: `${name} 展示名`,
    description: `Do ${name}.`,
    mcpSummary: `${name} 一行摘要。`,
    risk: 'read',
    approval: { mode: 'policy' },
    exposure: { piAi: true, mcp: 'on_demand' },
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    examples: [{ title: '示例', arguments: {} }],
    ...overrides,
  };
}

const PACK = {
  manifest: {
    apiVersion: 1,
    id: 'budget-demo',
    version: '1.0.0',
    title: '结果预算演示包',
    summary: '两个都吐 20k 正文的工具：一个声明了预算，一个没声明。',
    capabilities: ['demo.read'],
    dependencies: [],
    permissions: { fs: 'read', exec: false, net: false, desktop: false, browser: false, canvas: false, memory: 'none' },
    deprecation: null,
    tools: [
      // 对照 browser_snapshot：工具自己允许 24000 字符的页面快照。
      tool('big_snapshot', { exposure: { piAi: true, mcp: 'core' }, maxResultChars: 24_000 }),
      tool('small_dump'),
    ],
  },
  createHandlers: () => ({
    big_snapshot: async () => BIG_TEXT,
    small_dump: async () => BIG_TEXT,
  }),
};

function makeRuntime() {
  return buildSkillRuntime({ packs: [PACK], deps: {} });
}

const textOf = result => result.content.find(part => part.type === 'text')?.text ?? '';

test('声明 maxResultChars:24000 的工具，20k 正文不被截断（工具自己的预算生效）', async () => {
  const table = toMcpToolTable(makeRuntime(), { maxTextChars: MAX_TEXT_CHARS });
  const text = textOf(await table.call('big_snapshot', {}));
  assert.equal(text.length, 20_000, `声明了 24000 的工具不该再被砍，实际 ${text.length}`);
  assert.doesNotMatch(text, /已截断/);
});

test('没声明预算的工具仍按 MAX_TEXT_CHARS(8192) 截断并说明原文长度', async () => {
  const table = toMcpToolTable(makeRuntime(), { maxTextChars: MAX_TEXT_CHARS });
  const text = textOf(await table.call('small_dump', {}));
  assert.equal(text.length, 8192, `默认预算必须还是 8192，实际 ${text.length}`);
  assert.match(text, /已截断/);
  assert.match(text, /20000/, '说明里要留下原文长度，模型才知道还有更多');
});

test('MCP 与 pi-ai 两条链路对同一工具给出逐字一致的结果', async () => {
  const runtime = makeRuntime();
  const table = toMcpToolTable(runtime, { maxTextChars: MAX_TEXT_CHARS });
  const tools = toPiAiTools(runtime);
  for (const name of ['big_snapshot', 'small_dump']) {
    const viaMcp = textOf(await table.call(name, {}));
    const viaPiAi = textOf(await tools.find(item => item.name === name).execute('pi-1', {}, undefined));
    assert.equal(viaMcp, viaPiAi, `${name} 在两条链路上的结果必须一致`);
  }
});

test('适配器的全局上限（maxTextChars）只对「没声明预算」的工具生效', async () => {
  const table = toMcpToolTable(makeRuntime(), { maxTextChars: 4_000 });
  const declared = textOf(await table.call('big_snapshot', {}));
  assert.equal(declared.length, 20_000, '声明过预算的工具不能被适配器的全局上限砍回去');
  const fallback = textOf(await table.call('small_dump', {}));
  assert.equal(fallback.length, 4_000, '没声明的工具才吃全局上限');
});

test('mova_skill_call 转发时用的也是目标工具自己声明的预算', async () => {
  const table = toMcpToolTable(makeRuntime(), { maxTextChars: MAX_TEXT_CHARS });
  const text = textOf(await table.call('mova_skill_call', { name: 'big_snapshot', arguments: {} }));
  assert.equal(text.length, 20_000, '按名字转发不能绕回默认预算');
});

test('真实 pack：只有真的产出大文本的工具声明预算，数字与工具自己的上限对齐', () => {
  const budgetsOf = manifest => Object.fromEntries(
    manifest.tools.filter(def => def.maxResultChars !== undefined).map(def => [def.name, def.maxResultChars]),
  );

  // 数字的依据（改这些数字前先回读代码）：
  // browser_snapshot → electron/browser/snapshot.cjs 的 maxChars 默认 24000；
  // browser_read → electron/browser/read.cjs 默认 20000（传了也只夹到 40000）；
  // browser_batch → 末尾那份快照走 settings.cjs 的 snapshotBudget 默认 24000；
  // desktop_snapshot / desktop_read → electron/desktop/tools.cjs 的 maxChars 默认 24000 / 20000；
  // design_read → electron/design-runtime.cjs 对非截图结果超过 60000 直接报「设计结果过大」。
  assert.deepEqual(budgetsOf(browserManifest), {
    browser_snapshot: 24_000,
    browser_read: 20_000,
    browser_batch: 24_000,
  });
  assert.deepEqual(budgetsOf(desktopManifest), {
    desktop_snapshot: 24_000,
    desktop_read: 20_000,
  });
  assert.deepEqual(budgetsOf(designManifest), { design_read: 60_000 });
  assert.deepEqual(budgetsOf(projectFsManifest), {}, '项目文件工具按默认 8192 就够，不许顺手放大');

  for (const manifest of [browserManifest, desktopManifest, designManifest]) {
    for (const def of manifest.tools) {
      if (def.maxResultChars === undefined) continue;
      assert.ok(def.maxResultChars > MAX_TEXT_CHARS, `${def.name} 的预算不比默认大就没有声明的意义`);
      assert.ok(def.maxResultChars <= 60_000, `${def.name} 的预算必须落在 manifest-schema 的上限内`);
    }
  }
});
