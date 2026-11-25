'use strict';
// 记忆闭环最后一段：desktop_batch {recipe} 重放。
// 用 stub 引擎（记录 act 调用），不碰真桌面。
const test = require('node:test');
const assert = require('node:assert');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { compile } = require('../../electron/desktop/compiler.cjs');
const { createProcedureStore } = require('../../electron/desktop/procedures.cjs');
const { createDesktopTools, createEngineOperations } = require('../../electron/desktop/tools.cjs');

const ROWS = [
  { op: 'click', stableKey: 'aid:Save', role: 'button', name: '保存', rect: [100, 200, 80, 28], ts: 1, ok: true },
  { op: 'click', stableKey: 'aid:Ok', role: 'button', name: '确定', rect: [300, 400, 80, 28], ts: 2, ok: true },
  { op: 'key', keys: 'enter', ts: 3, ok: true },
];

function stubEngine(store, calls) {
  return {
    windows: { list: async () => [] },
    session: {
      status: () => ({ state: 'running' }),
      act: async (action) => {
        calls.push(action);
        return { ok: true, via: 'pattern' };
      },
      verify: async () => ({ ok: true, changed: true }),
      snapshot: async () => ({ nodes: [] }),
    },
    actions: { click: async () => ({ ok: true }) },
    status: () => ({ available: true, reason: '', session: { state: 'running' } }),
    procedures: store,
    resolveMark: () => null,
  };
}

test('desktop_batch {recipe} 会把存下来的技能逐步重放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-replay-'));
  try {
    const store = createProcedureStore({ directory: dir });
    const candidate = await compile(ROWS, { appKey: 'notepad.exe', title: '保存文件', intent: ['保存'] });
    const saved = await store.save({ ...candidate, appKey: 'notepad.exe', title: '保存文件', intent: ['保存'] });

    const calls = [];
    const engine = stubEngine(store, calls);
    const ops = createEngineOperations(engine);
    const tools = createDesktopTools(ops, {
      emit: () => {},
      approve: async () => 'allow',
      settings: () => ({ apps: {}, budget: { maxActions: 60, maxVisionFrames: 20 }, advanced: { vision: true } }),
    });

    const batch = tools.find((tool) => tool.name === 'desktop_batch');
    assert.ok(batch, 'desktop_batch 工具应该存在');

    const result = await batch.execute('t1', { recipe: saved.id, inputs: {} }, new AbortController().signal);
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.ok, true, `重放应该成功：${result.content[0].text.slice(0, 300)}`);
    assert.ok(calls.length >= 3, `应该重放 3 个动作，实际 ${calls.length}`);
    assert.equal(payload.via || payload.recipe?.id || saved.id, payload.via || saved.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
