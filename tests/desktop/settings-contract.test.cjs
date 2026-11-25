'use strict';
// 设置契约：渲染层（src/features/desktop/desktop-settings.js）与主进程共用这一份形状。
// 这里锁住默认值、patch 合并、落盘持久化、未知字段过滤。
const test = require('node:test');
const assert = require('node:assert');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { createDesktopSettingsStore } = require('../../electron/desktop/ipc.cjs');

test('默认设置包含渲染层依赖的全部字段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-set-'));
  try {
    const store = createDesktopSettingsStore({ directory: dir });
    const value = store.read();
    for (const key of ['enabled', 'profile', 'apps', 'budget', 'overlay', 'memory', 'advanced']) {
      assert.ok(key in value, `缺少字段 ${key}`);
    }
    assert.equal(value.enabled, false, '默认必须是关的（允许 Mova 操作这台电脑 = 关）');
    assert.equal(value.profile, 'standard');
    assert.equal(value.overlay.glow, true, '呼吸光是安全设施，默认开');
    assert.equal(value.budget.maxActions, 60);
    assert.equal(value.advanced.vision, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('patch 会合并、会落盘，未知字段不会写进去', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-set-'));
  try {
    const store = createDesktopSettingsStore({ directory: dir });
    store.patch({ enabled: true, profile: 'full' });
    store.patch({ budget: { maxActions: 120 } });
    store.patch({ nonsense: 'should-be-ignored' });

    const fresh = createDesktopSettingsStore({ directory: dir });
    const value = fresh.read();
    assert.equal(value.enabled, true, 'patch 应该持久化');
    assert.equal(value.profile, 'full', '合法权限级别只有 read-only | standard | full');
    assert.equal(value.budget.maxActions, 120, '嵌套对象应该合并而不是整体替换丢失其他键');
    assert.equal(value.budget.maxMinutes, 10, '未 patch 的同级键要保持默认值');
    assert.ok(!('nonsense' in value), '未知字段不应该被写进设置');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
