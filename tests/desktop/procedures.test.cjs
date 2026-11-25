/* global require, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { createProcedureStore, fingerprintOf, normalizeStep } = require('../../electron/desktop/procedures.cjs');

async function withStore(options, run) {
  const directory = await mkdtemp(join(tmpdir(), 'mova-desktop-proc-'));
  try {
    return await run(createProcedureStore({ directory, ...options }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const STEPS = [
  { op: 'invoke', target: { stableKey: 'aid:PivotTableButton' } },
  { op: 'type', target: { stableKey: 'aid:FileName' }, value: '{{p1}}' },
  { op: 'invoke', target: { path: 'dialog/Button[保存]' } },
];

test('保存 / 列出 / 读取技能', async () => {
  await withStore({}, async store => {
    const saved = await store.save({
      appKey: 'excel.exe|16.0',
      title: 'Excel 导出透视表',
      intent: ['透视表', '导出'],
      steps: STEPS,
      params: [{ name: 'p1', default: '报表.xlsx' }],
    });
    assert.equal(saved.appKey, 'excel.exe|16.0');
    assert.equal(saved.version, 1);
    assert.equal(saved.status, 'active');
    assert.equal(saved.steps.length, 3);

    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].stepCount, 3);
    assert.equal(list[0].steps, undefined, '列表不带 steps，省 token');

    const loaded = await store.get(saved.id);
    assert.deepEqual(loaded.steps, STEPS);
    assert.equal(loaded.params[0].default, '报表.xlsx');
  });
});

test('指纹去重：同样的步骤只保留一条，版本号 +1', async () => {
  await withStore({}, async store => {
    const first = await store.save({ appKey: 'excel.exe|16.0', title: '导出', steps: STEPS });
    const second = await store.save({ appKey: 'excel.exe|16.0', title: '导出', steps: STEPS.map(step => ({ ...step })) });
    assert.equal(second.id, first.id);
    assert.equal(second.reused, true);
    assert.equal(second.version, 2);
    assert.equal((await store.list()).length, 1);
  });
});

test('appKey 是硬门槛；intent 决定召回顺序', async () => {
  await withStore({}, async store => {
    await store.save({ appKey: 'excel.exe|16.0', title: '导出透视表', intent: ['透视表'], steps: STEPS });
    await store.save({ appKey: 'excel.exe|16.0', title: '打印工资条', intent: ['打印'], steps: [{ op: 'key', keys: 'Ctrl+P' }, { op: 'invoke', target: { stableKey: 'aid:Ok' } }] });
    await store.save({ appKey: 'notepad.exe|11.0', title: '另存为', intent: ['保存'], steps: [{ op: 'key', keys: 'Ctrl+S' }, { op: 'type', value: '{{p1}}' }] });

    const found = await store.find({ appKey: 'excel.exe|16.0', intent: '透视表' });
    assert.equal(found.length, 1);
    assert.match(found[0].title, /透视表/);

    const none = await store.find({ appKey: 'notepad.exe|11.0', intent: '透视表' });
    assert.equal(none.length, 0);

    const byExe = await store.find({ appKey: 'excel.exe|99.0', intent: '打印' });
    assert.equal(byExe.length, 1, 'exe 相同、版本变化仍可召回（但重放会走 T1 修复）');
  });
});

test('report 记录成功/失败与耗时', async () => {
  await withStore({}, async store => {
    const saved = await store.save({ appKey: 'excel.exe|16.0', title: '导出', steps: STEPS });
    await store.report(saved.id, { ok: true, ms: 2000 });
    const stats = await store.report(saved.id, { ok: false, ms: 4000 });
    assert.equal(stats.ok, 1);
    assert.equal(stats.fail, 1);
    assert.ok(stats.avgMs > 0);
    assert.ok(stats.lastUsedAt);
  });
});

test('retire 是软删除：列表与召回都不再返回', async () => {
  await withStore({}, async store => {
    const saved = await store.save({ appKey: 'excel.exe|16.0', title: '导出', steps: STEPS });
    assert.equal(await store.retire(saved.id), true);
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.list({ includeRetired: true })).length, 1);
    assert.equal((await store.find({ appKey: 'excel.exe|16.0' })).length, 0);
    assert.equal(await store.remove(saved.id), true);
    assert.equal((await store.list({ includeRetired: true })).length, 0);
  });
});

test('上限裁剪到最近的 N 条', async () => {
  await withStore({ max: 2 }, async store => {
    const base = Date.now();
    for (let index = 0; index < 4; index += 1) {
      await store.save({
        appKey: 'excel.exe|16.0',
        title: `流程 ${index}`,
        steps: [{ op: 'invoke', target: { stableKey: `aid:Btn${index}` } }, { op: 'key', keys: `Ctrl+${index}` }],
        source: { at: base + index },
      });
      // 让 recency 有序，否则同一毫秒内排序不稳定
      await store.list();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await store.list()).length, 2);
  });
});

test('非法步骤被丢弃，风格保持一致', async () => {
  await withStore({}, async store => {
    const saved = await store.save({
      appKey: 'weixin.exe|4.0',
      title: '发消息',
      steps: [null, { nope: true }, { op: 'INVOKE', target: { stableKey: 'aid:Send' } }, { op: 'type', value: 'x'.repeat(999) }],
    });
    assert.equal(saved.steps.length, 2);
    assert.equal(saved.steps[0].op, 'invoke');
    assert.ok(saved.steps[1].value.length <= 400);
  });
  assert.equal(normalizeStep({ bad: 1 }), null);
  assert.equal(fingerprintOf(STEPS), fingerprintOf(STEPS.map(step => ({ ...step }))));
});

test('并发保存不丢记录（mutate 队列）', async () => {
  await withStore({}, async store => {
    await Promise.all([1, 2, 3].map(index => store.save({
      appKey: 'excel.exe|16.0',
      title: `并发 ${index}`,
      steps: [{ op: 'invoke', target: { stableKey: `aid:B${index}` } }],
    })));
    assert.equal((await store.list()).length, 3);
  });
});
