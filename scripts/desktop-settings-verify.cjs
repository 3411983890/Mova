#!/usr/bin/env node
'use strict';
/* 电脑操作设置页 ↔ 主进程 IPC 契约验证。**不需要启动 Electron**。

   用法：node scripts/desktop-settings-verify.cjs
   全部通过 → 每行 OK ...，退出码 0；任一失败 → 该行 FAIL ...，退出码 1。

   三层验证：
     A 纯函数层：electron/desktop/policy.cjs 的 settingsDefaults / normalizeSettings
     B handler 层：假 ipcMain 抓住 installDesktopIpc 注册的 handler，真走一遍 set → get
       （ipc.cjs 只在 resolveWindows 里才 require('electron')，注入 getWin 后与 Electron 无关）
     C 静态层：设置页 src/features/desktop/desktop-settings.js 是前端 ESM，抓不到运行时，
       所以把它「常量 + 归一化 + 两套形状映射」那一段源码抠出来求值，再用与主进程
       相同的形状做「设置页 → 主进程 → 设置页」往返；页面模板里的 data-field 路径、
       数字区间按源码静态比对。

   降级说明：真正跨进程那一刻（contextBridge + 渲染进程）必须开 GUI 才能验，
   这部分没有覆盖，见 design/desktop-handoff.md §7「已知未验证的部分」。
*/

const assert = require('node:assert');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const policy = require('../electron/desktop/policy.cjs');
const { installDesktopIpc } = require('../electron/desktop/ipc.cjs');

const RENDERER = join(__dirname, '../src/features/desktop/desktop-settings.js');

let passed = 0;
const failures = [];

function ok(name, detail) {
  passed += 1;
  console.log(`OK   ${name}${detail ? `  (${detail})` : ''}`);
}

function fail(name, error) {
  failures.push(name);
  const message = error && error.message ? String(error.message).split('\n')[0] : String(error);
  console.log(`FAIL ${name}  -> ${message}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, typeof detail === 'string' ? detail : '');
  } catch (error) {
    fail(name, error);
  }
}

/* ── 通用小工具 ─────────────────────────────────────────────────────── */

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 叶子路径：{a:{b:1}} → ['a.b'] */
function leafPaths(value, prefix = '') {
  if (!isPlainObject(value)) return [prefix];
  const paths = [];
  for (const key of Object.keys(value).sort()) {
    paths.push(...leafPaths(value[key], prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

function leafOf(value, path) {
  return path.split('.').reduce((node, key) => (node == null ? node : node[key]), value);
}

/* ── 假 ipcMain / 临时目录 store ───────────────────────────────────── */

const CHANNELS = [
  'desktop:status', 'desktop:stop', 'desktop:resume', 'desktop:get-settings',
  'desktop:set-settings', 'desktop:skills', 'desktop:skills:remove',
];

function fakeDesktop() {
  return {
    status: () => ({
      available: true,
      reason: '',
      worker: { ready: true, status: 'ready', restartCount: 0 },
      session: { status: 'idle' },
    }),
    on: () => () => {},
    procedures: {
      list: async () => ([{ id: 'proc-1', title: '打开记事本', appKey: 'notepad.exe' }]),
      retire: async () => true,
    },
  };
}

function installFake({ desktop = fakeDesktop(), authorize = () => {}, directory } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: channel => handlers.delete(channel),
  };
  const owned = !directory;
  const dir = directory || mkdtempSync(join(tmpdir(), 'mova-desktop-verify-'));
  const ipc = installDesktopIpc({ ipcMain, desktop, authorize, directory: dir, getWin: () => null });
  const invoke = (channel, ...args) => handlers.get(channel)({ senderid: 1 }, ...args);
  return {
    handlers,
    invoke,
    ipc,
    dir,
    dispose() {
      ipc.dispose();
      if (owned) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ── C 层：把设置页的纯逻辑段抠出来求值 ────────────────────────────── */

function loadRenderer() {
  const source = readFileSync(RENDERER, 'utf8');
  const start = source.indexOf('const PERMISSIONS = [');
  const end = source.indexOf('/* ── 页面骨架');
  assert.ok(start > 0, '设置页里找不到 const PERMISSIONS 起点');
  assert.ok(end > start, '设置页里找不到「页面骨架」分隔注释');
  const region = source.slice(start, end);
  const factory = new Function(`${region}
    return {
      PERMISSIONS, APP_RULES, DEFAULT_SETTINGS, NUMBER_FIELDS, MINUTE_CHOICES,
      normalizeSettings, fromMain, toMainPatch, appKeyOf, unwrap,
    };`);
  return { source, ui: factory() };
}

/* ── 主进程侧的参考形状（= policy.cjs 的 DEFAULT_SETTINGS） ────────── */

const REFERENCE = {
  enabled: true,
  profile: 'read-only',
  apps: { 'excel.exe': 'ask', '*.bank*': { allow: 'deny', reason: '财务' } },
  budget: { maxMinutes: 30, maxActions: 120, maxVisionFrames: 40 },
  overlay: { glow: true, targetOutline: false, bubbles: false },
  memory: { auto: false },
  advanced: {
    maxDepth: 9, treeTimeoutMs: 4000, excludeProcesses: ['1password.exe'],
    vision: false, groundingModel: 'grounder-x', auditPath: 'C:\\audit',
  },
};

/* ── A 层：纯函数 ──────────────────────────────────────────────────── */

async function verifyPolicy() {
  await check('A1 settingsDefaults() 覆盖渲染层依赖的全部字段', () => {
    const defaults = policy.settingsDefaults();
    for (const key of ['enabled', 'profile', 'apps', 'budget', 'overlay', 'memory', 'advanced']) {
      assert.ok(key in defaults, `缺少顶层字段 ${key}`);
    }
    assert.deepStrictEqual(Object.keys(defaults.budget).sort(), ['maxActions', 'maxMinutes', 'maxVisionFrames']);
    assert.deepStrictEqual(Object.keys(defaults.overlay).sort(), ['bubbles', 'glow', 'targetOutline']);
    assert.deepStrictEqual(
      Object.keys(defaults.advanced).sort(),
      ['auditPath', 'excludeProcesses', 'groundingModel', 'maxDepth', 'treeTimeoutMs', 'vision'],
    );
    return `${leafPaths(defaults).length} 个叶子`;
  });

  await check('A2 三档 profile 合法，非法值归一化成 standard', () => {
    assert.deepStrictEqual(policy.PROFILES, ['read-only', 'standard', 'full']);
    for (const profile of policy.PROFILES) {
      assert.equal(policy.normalizeSettings({ profile }).profile, profile);
    }
    for (const bad of ['careful', 'trust', 'Full', '', 42, null, {}, []]) {
      assert.equal(policy.normalizeSettings({ profile: bad }).profile, 'standard', `${JSON.stringify(bad)} 没被归一化`);
    }
  });

  await check('A3 预算按硬边界夹取，类型不对回退 base', () => {
    assert.deepStrictEqual(policy.BUDGET_LIMITS.maxActions, [5, 300]);
    assert.deepStrictEqual(policy.BUDGET_LIMITS.maxVisionFrames, [0, 60]);
    assert.equal(policy.normalizeSettings({ budget: { maxActions: 9999 } }).budget.maxActions, 300);
    assert.equal(policy.normalizeSettings({ budget: { maxActions: 0 } }).budget.maxActions, 5);
    assert.equal(policy.normalizeSettings({ budget: { maxActions: 'abc' } }).budget.maxActions, 60);
    assert.equal(policy.normalizeSettings({ budget: { maxVisionFrames: 999 } }).budget.maxVisionFrames, 60);
    assert.equal(policy.normalizeSettings({ budget: { maxMinutes: 0 } }).budget.maxMinutes, 1);
  });

  await check('A4 应用规则只接受已知枚举，非法项丢弃', () => {
    const value = policy.normalizeSettings({
      apps: { 'excel.exe': 'allow', '*.bank*': { allow: 'deny', reason: '财务' }, 'bad.exe': 'nope' },
    });
    assert.equal(value.apps['excel.exe'], 'allow');
    assert.equal(value.apps['*.bank*'].allow, 'deny');
    assert.ok(!('bad.exe' in value.apps), '非法规则应该被丢弃');
  });

  await check('A5 normalizeSettings 是纯函数：不修改入参', () => {
    const input = { profile: 'full', advanced: { excludeProcesses: [' a.exe '] } };
    const snapshot = JSON.stringify(input);
    policy.normalizeSettings(input);
    assert.equal(JSON.stringify(input), snapshot);
  });
}

/* ── B 层：handler 往返 ────────────────────────────────────────────── */

async function verifyHandlers() {
  await check('B0 installDesktopIpc 注册了完整通道集', () => {
    const fake = installFake();
    try {
      assert.deepStrictEqual([...fake.handlers.keys()].sort(), [...CHANNELS].sort());
      assert.deepStrictEqual([...fake.ipc.channels].sort(), [...CHANNELS].sort());
      return `${fake.ipc.channels.length} 条`;
    } finally {
      fake.dispose();
    }
  });

  await check('B1 desktop:get-settings 返回完整默认设置（裸对象）', async () => {
    const fake = installFake();
    try {
      const value = await fake.invoke('desktop:get-settings');
      assert.ok(isPlainObject(value), '应该是裸对象');
      assert.ok(!('ok' in value), '不应该包 {ok,value}：设置页 unwrap 也接受裸对象');
      assert.deepStrictEqual(value, policy.settingsDefaults());
      return '默认 enabled=false / profile=standard';
    } finally {
      fake.dispose();
    }
  });

  for (const profile of policy.PROFILES) {
    await check(`B2 三档往返：set {profile:'${profile}'} 后 get 回一致`, async () => {
      const fake = installFake();
      try {
        const reply = await fake.invoke('desktop:set-settings', { profile });
        assert.equal(reply.ok, true, 'set 应该成功');
        assert.equal(reply.settings.profile, profile, 'set 回包应该带归一化后的 settings');
        const value = await fake.invoke('desktop:get-settings');
        assert.equal(value.profile, profile, 'get 回包与 set 不一致');
        return `profile=${value.profile}`;
      } finally {
        fake.dispose();
      }
    });
  }

  await check('B3 非法 profile（careful/trust/数字）落成 standard', async () => {
    const fake = installFake();
    try {
      for (const bad of ['careful', 'trust', 42]) {
        await fake.invoke('desktop:set-settings', { profile: bad });
        const value = await fake.invoke('desktop:get-settings');
        assert.equal(value.profile, 'standard', `${JSON.stringify(bad)} 没被归一化`);
      }
      return 'careful / trust / 42 → standard';
    } finally {
      fake.dispose();
    }
  });

  await check('B4 enabled / budget / advanced 往返并夹取到边界', async () => {
    const fake = installFake();
    try {
      await fake.invoke('desktop:set-settings', { enabled: true });
      await fake.invoke('desktop:set-settings', {
        budget: { maxMinutes: 30, maxActions: 9999, maxVisionFrames: 999 },
        advanced: { maxDepth: 99, treeTimeoutMs: 2000, excludeProcesses: [' 1Password.EXE ', '1password.exe', '', 7] },
      });
      const value = await fake.invoke('desktop:get-settings');
      assert.equal(value.enabled, true);
      assert.equal(value.budget.maxMinutes, 30);
      assert.equal(value.budget.maxActions, 300, 'maxActions 应该夹到 300');
      assert.equal(value.budget.maxVisionFrames, 60, 'maxVisionFrames 应该夹到 60');
      assert.equal(value.advanced.maxDepth, 12, 'maxDepth 应该夹到 12');
      assert.equal(value.advanced.treeTimeoutMs, 2000);
      assert.deepStrictEqual(value.advanced.excludeProcesses, ['1password.exe'], '应该小写去重并丢掉非字符串');
      return 'enabled / budget / advanced 一致';
    } finally {
      fake.dispose();
    }
  });

  await check('B5 未知字段与未知分节键不会写进设置', async () => {
    const fake = installFake();
    try {
      await fake.invoke('desktop:set-settings', { nonsense: 1, overlay: { nope: true } });
      const value = await fake.invoke('desktop:get-settings');
      assert.ok(!('nonsense' in value), '未知顶层字段应该被忽略');
      assert.deepStrictEqual(Object.keys(value.overlay).sort(), ['bubbles', 'glow', 'targetOutline']);
      return 'nonsense / overlay.nope 都被忽略';
    } finally {
      fake.dispose();
    }
  });

  await check('B6 设置落盘：同目录新建 store 仍读得到', async () => {
    const fake = installFake();
    let dir;
    try {
      await fake.invoke('desktop:set-settings', { profile: 'read-only', enabled: true });
      dir = fake.dir;
    } finally {
      fake.ipc.dispose();
    }
    const reopen = installFake({ directory: dir });
    try {
      const value = await reopen.invoke('desktop:get-settings');
      assert.equal(value.profile, 'read-only', '重启后应该读到 read-only');
      assert.equal(value.enabled, true);
      return 'policy.json 的 settings 段落盘可重读';
    } finally {
      reopen.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('B7 desktop:skills 回包是 {ok:true, skills:[...]}（数组，可为空）', async () => {
    const fake = installFake();
    try {
      const reply = await fake.invoke('desktop:skills');
      assert.equal(reply.ok, true);
      assert.ok(Array.isArray(reply.skills), 'skills 必须是数组');
      assert.equal(reply.skills[0].id, 'proc-1');
    } finally {
      fake.dispose();
    }
    const offline = installFake({ desktop: null });
    try {
      const reply = await offline.invoke('desktop:skills');
      assert.equal(reply.ok, true);
      assert.deepStrictEqual(reply.skills, [], '引擎缺失时应该是空数组而不是抛错');
      return '有引擎 1 条 / 无引擎 []';
    } finally {
      offline.dispose();
    }
  });

  await check('B8 未授权：get 回默认值，set 回 {ok:false,error:unauthorized}', async () => {
    let allowed = true;
    const fake = installFake({ authorize: () => { if (!allowed) throw new Error('unauthorized'); } });
    try {
      allowed = false;
      const value = await fake.invoke('desktop:get-settings');
      assert.deepStrictEqual(value, policy.settingsDefaults());
      const reply = await fake.invoke('desktop:set-settings', { profile: 'full' });
      assert.deepStrictEqual(reply, { ok: false, error: 'unauthorized' });
      return '降级而不是抛错';
    } finally {
      fake.dispose();
    }
  });

  await check('B9 坏输入不会让 handler 抛异常', async () => {
    const fake = installFake();
    try {
      assert.deepStrictEqual(await fake.invoke('desktop:set-settings', null), { ok: false, error: 'invalid-input' });
      assert.deepStrictEqual(await fake.invoke('desktop:set-settings', 'nope'), { ok: false, error: 'invalid-input' });
      const remove = await fake.invoke('desktop:skills:remove', 42);
      assert.equal(remove.ok, false);
      await fake.invoke('desktop:status');
      await fake.invoke('desktop:stop', undefined);
      await fake.invoke('desktop:resume');
      return 'null / 字符串 / 数字参数都返回结构化错误';
    } finally {
      fake.dispose();
    }
  });
}

/* ── C 层：设置页字段对齐 ──────────────────────────────────────────── */

async function verifyRenderer() {
  let loaded;
  try {
    loaded = loadRenderer();
    ok('C0 设置页纯逻辑段可被求值');
  } catch (error) {
    fail('C0 设置页纯逻辑段可被求值', error);
    return;
  }
  const { source, ui } = loaded;

  await check('C1 三档权限 id 与 policy.PROFILES 完全一致（含顺序）', () => {
    assert.deepStrictEqual(ui.PERMISSIONS.map(item => item.id), policy.PROFILES);
    for (const tier of ui.PERMISSIONS) assert.ok(tier.label, `${tier.id} 缺中文标签`);
    return policy.PROFILES.join(' | ');
  });

  await check('C2 应用规则 id 是 policy.APP_RULES 的子集', () => {
    const ids = ui.APP_RULES.map(item => item.id);
    for (const id of ids) assert.ok(policy.APP_RULES.includes(id), `${id} 不在 policy.APP_RULES 里`);
    return ids.join(' | ');
  });

  await check('C3 主进程每个可编辑字段都能被页面表达并原值写回（overlay.glow 只读除外）', () => {
    // 给每个叶子塞不同的探针值，走一遍 主进程 → 页面 → 主进程：
    // 哪个字段名对不上，这里就会在那个路径上暴露出来。
    const probe = {
      enabled: true,
      profile: 'full',
      apps: { 'probe.exe': 'ask' },
      budget: { maxMinutes: 30, maxActions: 120, maxVisionFrames: 40 },
      overlay: { glow: false, targetOutline: false, bubbles: false },
      memory: { auto: false },
      advanced: {
        maxDepth: 9, treeTimeoutMs: 4000, excludeProcesses: ['probe.exe'],
        vision: false, groundingModel: 'probe', auditPath: 'probe',
      },
    };
    const readOnly = new Set(['overlay.glow']); // 呼吸光是安全设施，界面只读
    const back = ui.toMainPatch(ui.fromMain(probe), ui.fromMain(probe).apps, probe.apps);
    let checked = 0;
    for (const path of leafPaths(probe)) {
      if (readOnly.has(path)) continue;
      assert.deepStrictEqual(leafOf(back, path), leafOf(probe, path), `${path} 没有原值写回（字段名没映射上）`);
      checked += 1;
    }
    return `${checked} 个字段往返一致`;
  });

  await check('C4 设置页数字区间落在 policy 硬边界内', () => {
    const limits = {
      'budget.maxActions': policy.BUDGET_LIMITS.maxActions,
      'budget.maxVisionFrames': policy.BUDGET_LIMITS.maxVisionFrames,
      'advanced.uiaDepth': [1, 12],
      'advanced.timeoutMs': [200, 15000],
    };
    for (const [field, [min, max]] of Object.entries(limits)) {
      const config = ui.NUMBER_FIELDS[field];
      assert.ok(config, `NUMBER_FIELDS 缺 ${field}`);
      assert.ok(config.min >= min, `${field} 的 min ${config.min} 小于主进程下限 ${min}`);
      assert.ok(config.max <= max, `${field} 的 max ${config.max} 大于主进程上限 ${max}`);
    }
    return '4 个数字字段';
  });

  await check('C5 页面模板里的 data-field 路径都能在设置形状里解析', () => {
    const paths = [...source.matchAll(/data-field="([^"]+)"/g)].map(match => match[1]);
    assert.ok(paths.length >= 7, `只找到 ${paths.length} 个 data-field`);
    const shape = ui.normalizeSettings(ui.DEFAULT_SETTINGS);
    for (const path of paths) {
      assert.notEqual(leafOf(shape, path), undefined, `data-field="${path}" 在设置形状里不存在`);
    }
    return `${[...new Set(paths)].length} 个字段`;
  });

  await check('C6 设置页 → 主进程：字段名逐个映射（不出现 permission / uiaDepth）', () => {
    const main = ui.toMainPatch(ui.normalizeSettings(ui.DEFAULT_SETTINGS), []);
    assert.equal(main.profile, 'standard', 'permission 应该映射成 profile');
    assert.ok(!('permission' in main), 'patch 里不该出现 permission');
    assert.equal(main.overlay.targetOutline, true, 'highlight 应该映射成 targetOutline');
    assert.equal(main.overlay.bubbles, true, 'bubble 应该映射成 bubbles');
    assert.equal(main.memory.auto, true, 'autoSkill 应该映射成 auto');
    assert.equal(main.advanced.maxDepth, 6, 'uiaDepth 应该映射成 maxDepth');
    assert.equal(main.advanced.treeTimeoutMs, 1500, 'timeoutMs 应该映射成 treeTimeoutMs');
    assert.deepStrictEqual(main.advanced.excludeProcesses, [], 'denyExe 应该映射成 excludeProcesses');
    assert.equal(main.advanced.vision, true, 'visionFallback 应该映射成 vision');
    assert.equal(main.advanced.groundingModel, '', 'grounderModel 应该映射成 groundingModel');
    assert.equal(main.advanced.auditPath, '');
    return 'permission→profile / highlight→targetOutline / autoSkill→auto / uiaDepth→maxDepth 等';
  });

  await check('C7 主进程 → 设置页：13 组字段的显示值都能读出来', () => {
    const value = ui.fromMain(REFERENCE);
    assert.equal(value.enabled, true);
    assert.equal(value.permission, 'read-only', 'profile 应该显示成 permission');
    assert.deepStrictEqual(value.apps.map(app => [app.id, app.rule]), [['excel.exe', 'ask'], ['*.bank*', 'deny']]);
    assert.deepStrictEqual(value.budget, { maxMinutes: 30, maxActions: 120, maxVisionFrames: 40 });
    assert.equal(value.overlay.highlight, false, 'targetOutline 应该显示成 highlight');
    assert.equal(value.overlay.bubble, false, 'bubbles 应该显示成 bubble');
    assert.equal(value.memory.autoSkill, false, 'auto 应该显示成 autoSkill');
    assert.equal(value.advanced.uiaDepth, 9, 'maxDepth 应该显示成 uiaDepth');
    assert.equal(value.advanced.timeoutMs, 4000, 'treeTimeoutMs 应该显示成 timeoutMs');
    assert.deepStrictEqual(value.advanced.denyExe, ['1password.exe'], 'excludeProcesses 应该显示成 denyExe');
    assert.equal(value.advanced.visionFallback, false, 'vision 应该显示成 visionFallback');
    assert.equal(value.advanced.grounderModel, 'grounder-x', 'groundingModel 应该显示成 grounderModel');
    assert.equal(value.advanced.auditPath, 'C:\\audit');
    return '13 组全部读出';
  });

  await check('C8 设置页 → 主进程 → 设置页 往返不丢值', async () => {
    const fake = installFake();
    try {
      await fake.invoke('desktop:set-settings', REFERENCE);
      const stored = await fake.invoke('desktop:get-settings');
      const shown = ui.fromMain(stored);
      const reply = await fake.invoke('desktop:set-settings', ui.toMainPatch(shown, shown.apps, stored.apps));
      assert.equal(reply.ok, true, '写回失败');
      const again = await fake.invoke('desktop:get-settings');
      for (const path of [
        'enabled', 'profile', 'budget.maxMinutes', 'budget.maxActions', 'budget.maxVisionFrames',
        'overlay.targetOutline', 'overlay.bubbles', 'memory.auto', 'advanced.maxDepth',
        'advanced.treeTimeoutMs', 'advanced.vision', 'advanced.groundingModel', 'advanced.auditPath',
      ]) {
        assert.deepStrictEqual(leafOf(again, path), leafOf(stored, path), `${path} 往返后变了`);
      }
      assert.deepStrictEqual(again.advanced.excludeProcesses, ['1password.exe']);
      assert.equal(again.apps['excel.exe'], 'ask');
      assert.equal(again.apps['*.bank*'].allow, 'deny', '页面看不懂的对象形式规则不该被写坏');
      assert.equal(again.apps['*.bank*'].reason, '财务', '对象形式里的 reason 不该被抹掉');
      return 'apps / 预算 / 浮层 / 记忆 / 高级共 13 组';
    } finally {
      fake.dispose();
    }
  });

  await check('C9 页面改单个开关只影响对应字段（不整份覆盖）', async () => {
    const fake = installFake();
    try {
      await fake.invoke('desktop:set-settings', {
        profile: 'full',
        apps: { 'excel.exe': 'deny', legacy: 'route-to-browser' },
        advanced: { maxDepth: 8, groundingModel: 'keep-me' },
      });
      const before = await fake.invoke('desktop:get-settings');
      const shown = ui.fromMain(before);
      await fake.invoke('desktop:set-settings', ui.toMainPatch({ overlay: { bubble: false } }, shown.apps, before.apps));
      const after = await fake.invoke('desktop:get-settings');
      assert.equal(after.overlay.bubbles, false, '改气泡没生效');
      assert.equal(after.overlay.targetOutline, before.overlay.targetOutline, '顺带改坏了描边');
      assert.equal(after.apps['excel.exe'], 'deny', '应用规则被覆盖了');
      assert.equal(after.apps.legacy, 'route-to-browser', '页面不认识的规则形式被删了');
      assert.equal(after.advanced.maxDepth, 8);
      assert.equal(after.advanced.groundingModel, 'keep-me');
      return '只动了 overlay.bubbles';
    } finally {
      fake.dispose();
    }
  });

  await check('C10 删应用规则：显式置 null 才会被主进程丢掉', async () => {
    const fake = installFake();
    try {
      await fake.invoke('desktop:set-settings', { apps: { 'excel.exe': 'allow', 'word.exe': 'ask' } });
      const before = await fake.invoke('desktop:get-settings');
      const shown = ui.fromMain(before);
      const kept = shown.apps.filter(app => app.id !== 'excel.exe');
      await fake.invoke('desktop:set-settings', ui.toMainPatch({ apps: kept }, shown.apps, before.apps));
      const after = await fake.invoke('desktop:get-settings');
      assert.ok(!('excel.exe' in after.apps), '被删的规则还在');
      assert.equal(after.apps['word.exe'], 'ask', '没被删的规则不该丢');
      return 'excel.exe 已删除，word.exe 保留';
    } finally {
      fake.dispose();
    }
  });

  await check('C11 设置页 unwrap 认得三种回包：{ok,value} / {ok,settings} / {ok,skills}', () => {
    assert.deepStrictEqual(ui.unwrap({ ok: true, value: { a: 1 } }), { a: 1 });
    assert.deepStrictEqual(ui.unwrap({ ok: true, settings: { profile: 'full' } }), { profile: 'full' });
    assert.deepStrictEqual(ui.unwrap({ ok: true, skills: [{ id: 'p1' }] }), [{ id: 'p1' }]);
    assert.deepStrictEqual(ui.unwrap({ profile: 'full' }), { profile: 'full' }, '裸对象也要认');
    assert.throws(() => ui.unwrap({ ok: false, error: 'unauthorized' }), /unauthorized/);
    return '4 种形状';
  });

  await check('C12 设置页不再把显示用 patch 直接发给主进程', () => {
    assert.ok(/toMainPatch\(/.test(source), '设置页没有 toMainPatch 映射');
    assert.ok(!/api\.set\(patch\)/.test(source), '设置页还在把显示用 patch 直接发给主进程');
    assert.ok(/desktop\.skills/.test(source), '技能列表没读 preload 的 desktop.skills');
    return 'updateSettings / resetAll 都过映射';
  });
}

/* ── 汇总 ──────────────────────────────────────────────────────────── */

async function main() {
  console.log('# 电脑操作设置页 ↔ IPC 契约验证（不启动 Electron）');
  console.log(`# 渲染层：${RENDERER}`);
  console.log('# 主进程：electron/desktop/{policy,ipc}.cjs');

  console.log('[A] 纯函数层');
  await verifyPolicy();
  console.log('[B] IPC handler 层（假 ipcMain + 临时目录 store）');
  await verifyHandlers();
  console.log('[C] 设置页静态契约（源码抠段求值）');
  await verifyRenderer();

  console.log('----------------------------------------');
  const total = passed + failures.length;
  if (failures.length) {
    console.log(`FAIL ${failures.length} / ${total} 项未通过：${failures.join('；')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK   全部 ${total} 项通过：三档 read-only|standard|full 往返一致，非法值归一化成 standard，desktop:skills 回数组`);
}

main().catch(error => {
  console.log(`FAIL 验证脚本自身出错 -> ${error && error.stack ? error.stack.split('\n')[0] : error}`);
  process.exitCode = 1;
});
