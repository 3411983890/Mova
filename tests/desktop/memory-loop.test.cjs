'use strict';
// 记忆闭环的“存下来”半程：rows → compile → procedures.save → get/find/report/retire
// 全部走真实 store（临时目录），不碰桌面。
const test = require('node:test');
const assert = require('node:assert');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { compile } = require('../../electron/desktop/compiler.cjs');
const { createProcedureStore } = require('../../electron/desktop/procedures.cjs');

const ROWS = [
  { op: 'click', stableKey: 'aid:Save', role: 'button', name: '保存', rect: [100, 200, 80, 28], ts: 1, ok: true },
  { op: 'click', stableKey: 'aid:Ok', role: 'button', name: '确定', rect: [300, 400, 80, 28], ts: 2, ok: true },
  { op: 'key', keys: 'enter', ts: 3, ok: true },
];

test('rows → compile → save → get/find/report/retire 全链路', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-proc-'));
  try {
    const store = createProcedureStore({ directory: dir });
    const candidate = await compile(ROWS, { appKey: 'notepad.exe', title: '保存文件' });
    assert.equal(candidate.ok, true);

    const saved = await store.save({
      ...candidate,
      appKey: 'notepad.exe',
      title: candidate.title || '保存文件',
      intent: candidate.intent || ['保存'],
    });
    assert.ok(saved && saved.id, 'save 应该返回带 id 的技能');
    const id = saved.id;

    const loaded = await store.get(id);
    assert.equal(loaded.steps.length, 3);
    assert.deepEqual(loaded.steps[0].target, { stableKey: 'aid:Save' });

    const found = await store.find({ appKey: 'notepad.exe', intent: '保存', limit: 3 });
    const list = Array.isArray(found) ? found : found.items || [];
    assert.ok(list.some((item) => item.id === id), 'find 应该能按 appKey+intent 召回刚存的技能');

    await store.report(id, { ok: true, ms: 1200 });
    const afterOk = await store.get(id);
    assert.equal(afterOk.stats.ok, 1);

    await store.retire(id, 'layout-changed');
    const afterRetire = await store.get(id);
    // retire() 的状态是 'retired'；'stale' 留给“连续失败自动降级”
    assert.equal(afterRetire.status, 'retired');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
