// 订阅 provider 模型目录存储层的契约测试。
//
// 关键前提：这个模块刻意不 require('electron')，userData 目录与 fs 全部由调用方注入，
// 所以这里可以只测存储层（不加载 providers.cjs，也就不需要伪造 electron 模块）。
// 每个用例用一份独立的临时目录，避免用例之间串味。
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import subscriptionModels from '../electron/subscription-models.cjs';

const { createStore } = subscriptionModels;
// 默认目录里有几款模型：目录换代时这个数字跟着变，断言不该写死 3。
const DEFAULT_CHATGPT_COUNT = subscriptionModels.DEFAULT_CATALOG.chatgpt.models.length;
const DEFAULT_GEMINI_COUNT = subscriptionModels.DEFAULT_CATALOG.gemini.models.length;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mova-sub-models-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function openStore(t, { fs } = {}) {
  const dir = await tempDir(t);
  return { dir, store: createStore({ dir, ...(fs ? { fs } : {}) }) };
}

function model(overrides = {}) {
  return { id: 'custom-model-1', name: 'Custom Model', vision: true, efforts: ['low', 'high'], contextWindow: 200_000, maxTokens: 64_000, ...overrides };
}

test('default catalog has the agreed shape and is immutable', () => {
  const { DEFAULT_CATALOG, TARGETS, EFFORTS } = subscriptionModels;

  assert.deepEqual([...TARGETS], ['chatgpt', 'gemini'], '只允许两个订阅通道，顺序固定');
  assert.deepEqual([...EFFORTS], ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '思考档位顺序是规范顺序');
  assert.equal(DEFAULT_CATALOG.chatgpt.displayName, 'ChatGPT', '模型列表里显示 ChatGPT，不带「订阅」');
  assert.equal(DEFAULT_CATALOG.gemini.displayName, 'Gemini');
  assert.deepEqual(
    DEFAULT_CATALOG.chatgpt.models.map(item => item.id),
    ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    'chatgpt 默认目录就是 Codex 订阅真实可用的 8 个模型（思考强度是档位，不是模型）',
  );
  assert.deepEqual(
    DEFAULT_CATALOG.gemini.models.map(item => item.id),
    ['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    'gemini 默认三款模型',
  );
  const flagship = DEFAULT_CATALOG.chatgpt.models[0];
  assert.deepEqual(flagship.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(flagship.contextWindow, 500_000);
  assert.equal(flagship.maxTokens, 128_000);
  assert.equal(DEFAULT_CATALOG.gemini.models[0].contextWindow, 1_000_000);
  assert.equal(DEFAULT_CATALOG.gemini.models[0].maxTokens, 65_536);
  assert.equal(Object.isFrozen(DEFAULT_CATALOG.chatgpt), true, '默认目录必须冻结，防止被就地改写');
  assert.equal(Object.isFrozen(DEFAULT_CATALOG.chatgpt.models[0].efforts), true, '深冻结到 efforts 数组');
});

test('readCatalog falls back to defaults when the file is missing', async t => {
  const { dir, store } = await openStore(t);
  const catalog = await store.readCatalog();

  assert.equal(catalog.recoveredFrom, 'missing', '首次使用要能报出「文件不存在」');
  assert.deepEqual(Object.keys(catalog.providers), ['chatgpt', 'gemini']);
  assert.equal(catalog.providers.chatgpt.displayName, 'ChatGPT');
  assert.equal(catalog.providers.gemini.models.length, 3);
  // 回落的目录必须是副本：改它不能污染 DEFAULT_CATALOG。
  catalog.providers.chatgpt.models[0].name = '被改坏的名字';
  const again = await store.readCatalog();
  assert.equal(again.providers.chatgpt.models[0].name, subscriptionModels.DEFAULT_CATALOG.chatgpt.models[0].name, '读出去的目录不能被就地改到默认值');
  assert.deepEqual(await readdir(dir), [], '纯读取不该落盘');
});

test('readCatalog reports corrupt files without throwing', async t => {
  const { dir, store } = await openStore(t);
  await writeFile(join(dir, 'subscription-models.json'), '{ 这不是 JSON', 'utf8');

  const catalog = await store.readCatalog();
  assert.equal(catalog.recoveredFrom, 'corrupt', '坏 JSON 要报 corrupt 给上层提示');
  assert.equal(catalog.providers.chatgpt.models.length, DEFAULT_CHATGPT_COUNT, '坏文件也要有可编辑的默认目录');
  assert.equal(catalog.providers.gemini.displayName, 'Gemini');
});

test('readCatalog rejects a wrong version or a malformed envelope', async t => {
  const { dir, store } = await openStore(t);
  const file = join(dir, 'subscription-models.json');

  await writeFile(file, JSON.stringify({ version: 99, providers: { chatgpt: { displayName: 'X', models: [] } } }), 'utf8');
  assert.equal((await store.readCatalog()).recoveredFrom, 'corrupt', '版本不对就要回落，不能猜着读');

  await writeFile(file, JSON.stringify({ version: 1, providers: [] }), 'utf8');
  assert.equal((await store.readCatalog()).recoveredFrom, 'corrupt', 'providers 不是对象也算坏文件');
});

test('readCatalog salvages bad models one by one but falls back when nothing is usable', async t => {
  const { dir, store } = await openStore(t);
  const file = join(dir, 'subscription-models.json');

  await writeFile(file, JSON.stringify({
    version: 1,
    catalogVersion: subscriptionModels.CATALOG_VERSION,
    providers: {
      chatgpt: { displayName: '我的 GPT', models: [model(), { id: 'bad id' }, model({ id: 'custom-model-2' })] },
      gemini: { displayName: '我的 Gemini', models: [{ id: 'bad id' }] },
    },
  }), 'utf8');

  const catalog = await store.readCatalog();
  assert.equal(catalog.recoveredFrom, null, '文件本身结构正常，不算 corrupt');
  assert.deepEqual(catalog.providers.chatgpt.models.map(item => item.id), ['custom-model-1', 'custom-model-2'], '坏条目跳过，好条目保留');
  assert.equal(catalog.providers.chatgpt.displayName, '我的 GPT');
  assert.equal(catalog.providers.gemini.models.length, 3, '整段都不可用时回落默认目录');
  assert.equal(catalog.providers.gemini.displayName, '我的 Gemini', '显示名仍然可用就保留');
});

test('saveProvider partially updates the display name and keeps models', async t => {
  const { store } = await openStore(t);
  const before = await store.readProvider('chatgpt');

  const saved = await store.saveProvider('chatgpt', { displayName: '我的GPT' });
  assert.equal(saved.provider.displayName, '我的GPT');

  const after = await store.readProvider('chatgpt');
  assert.equal(after.displayName, '我的GPT', '改过的显示名要能读回');
  assert.deepEqual(after.models.map(item => item.id), before.models.map(item => item.id), '只改名字不能动模型列表');
  assert.equal(after.models[0].name, subscriptionModels.DEFAULT_CATALOG.chatgpt.models[0].name, '模型自身的名字不受 provider 显示名影响');
  assert.equal((await store.readProvider('gemini')).displayName, 'Gemini', '另一个通道不该被顺手改掉');
});

test('saveProvider persists custom models with normalized efforts', async t => {
  const { store } = await openStore(t);
  await store.saveProvider('chatgpt', {
    models: [
      { id: 'gpt-5.6-luna', name: '  我的 Luna  ', vision: true, efforts: ['max', 'bogus', 'low', 'low'], contextWindow: 300_000, maxTokens: 90_000 },
      { id: 'my-model', efforts: ['high'], vision: false },
    ],
  });

  const { models } = await store.readProvider('chatgpt');
  assert.equal(models.length, 2);
  assert.equal(models[0].name, '我的 Luna', 'name 要 trim');
  assert.deepEqual(models[0].efforts, ['low', 'max'], 'efforts 去重、剔除非法值、按 EFFORTS 顺序排');
  assert.equal(models[0].contextWindow, 300_000);
  assert.equal(models[0].maxTokens, 90_000);
  assert.equal(models[1].name, 'my-model', '空 name 回落成 id');
  assert.deepEqual(models[1].efforts, ['high']);
  assert.equal(models[1].vision, false);
  assert.equal(models[1].contextWindow, 1_000_000, '没给的上下文用默认值');
  assert.equal(models[1].maxTokens, 128_000, '没给的输出上限用默认值');
});

test('saveProvider clamps out-of-range token limits like providers.cjs', async t => {
  const { store } = await openStore(t);
  await store.saveProvider('gemini', {
    models: [
      model({ id: 'tiny', contextWindow: 10, maxTokens: 1 }),
      model({ id: 'huge', contextWindow: 99_000_000, maxTokens: 9_000_000 }),
    ],
  });

  const { models } = await store.readProvider('gemini');
  assert.equal(models[0].contextWindow, 1_000, '上下文下限 1000');
  assert.equal(models[0].maxTokens, 256, '输出上限下限 256');
  assert.equal(models[1].contextWindow, 10_000_000, '上下文上限 10M');
  assert.equal(models[1].maxTokens, 1_000_000, '输出上限上限 1M');
});

test('saveProvider keeps an intentionally emptied catalog', async t => {
  const { store } = await openStore(t);
  await store.saveProvider('gemini', { models: [] });

  const after = await store.readProvider('gemini');
  assert.deepEqual(after.models, [], '用户主动清空要尊重，不能又塞回默认值');
  assert.equal(after.displayName, 'Gemini');
});

test('invalid input is rejected and never damages the stored file', async t => {
  const { dir, store } = await openStore(t);
  await store.saveProvider('chatgpt', { displayName: '稳定名字' });
  const file = join(dir, 'subscription-models.json');
  const before = await readFile(file, 'utf8');

  const failures = [
    ['bad model id', () => store.saveProvider('chatgpt', { models: [model({ id: 'bad id' })] })],
    ['too many models', () => store.saveProvider('chatgpt', { models: Array.from({ length: 81 }, (_, index) => model({ id: `model-${index}` })) })],
    ['duplicate ids', () => store.saveProvider('chatgpt', { models: [model(), model()] })],
    ['empty display name', () => store.saveProvider('chatgpt', { displayName: '   ' })],
    ['too long display name', () => store.saveProvider('chatgpt', { displayName: 'x'.repeat(41) })],
    ['newline in display name', () => store.saveProvider('chatgpt', { displayName: '第一行\n第二行' })],
    ['non-string display name', () => store.saveProvider('chatgpt', { displayName: 42 })],
    ['models not an array', () => store.saveProvider('chatgpt', { models: 'nope' })],
    ['non-boolean vision', () => store.saveProvider('chatgpt', { models: [model({ vision: 'true' })] })],
    ['empty patch', () => store.saveProvider('chatgpt', {})],
  ];
  for (const [label, run] of failures) {
    await assert.rejects(run(), error => error.code === 'request', `${label} 应当抛 ModelError('request')`);
  }
  await assert.rejects(
    store.saveProvider('antigravity', { displayName: 'X' }),
    error => error.code === 'request',
    'target 只允许 chatgpt/gemini',
  );

  assert.equal(await readFile(file, 'utf8'), before, '校验失败后磁盘内容必须一字不改');
  assert.equal((await store.readProvider('chatgpt')).displayName, '稳定名字', '旧值仍然完好');
});

test('80 models is the accepted boundary', async t => {
  const { store } = await openStore(t);
  const models = Array.from({ length: 80 }, (_, index) => model({ id: `model-${index}` }));
  const saved = await store.saveProvider('chatgpt', { models });
  assert.equal(saved.provider.models.length, 80);
  assert.equal((await store.readProvider('chatgpt')).models.length, 80);

  const extra = [...models, model({ id: 'model-80' })];
  await assert.rejects(
    store.saveProvider('chatgpt', { models: extra }),
    error => error.code === 'request',
    '第 81 个模型直接拒绝而不是悄悄截断',
  );
});

test('resetProvider restores the default entry', async t => {
  const { store } = await openStore(t);
  await store.saveProvider('gemini', { displayName: '我的 Gemini', models: [model()] });

  const { provider } = await store.resetProvider('gemini');
  assert.equal(provider.displayName, 'Gemini');
  assert.deepEqual(provider.models.map(item => item.id), ['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);

  const after = await store.readProvider('gemini');
  assert.deepEqual(after, provider, '恢复默认要落盘，不能只改内存');
  assert.equal((await store.readProvider('chatgpt')).displayName, 'ChatGPT', '恢复一个通道不影响另一个');
});

test('atomic write leaves no temp file behind', async t => {
  const { dir, store } = await openStore(t);
  await store.saveProvider('chatgpt', { displayName: '原子写' });

  const entries = await readdir(dir);
  assert.deepEqual(entries, ['subscription-models.json'], `目录里只该有正式文件，实际：${entries.join(', ')}`);
  const payload = JSON.parse(await readFile(join(dir, 'subscription-models.json'), 'utf8'));
  assert.equal(payload.version, 1);
  assert.equal(payload.providers.chatgpt.displayName, '原子写');
  assert.equal(payload.providers.gemini.displayName, 'Gemini', '整份文件两个通道都在');
});

test('write failures surface as credential errors and clean up the temp file', async t => {
  const calls = [];
  const failingFs = {
    mkdir: async () => {},
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    writeFile: async (path, data, options) => { calls.push({ wrote: path, options }); },
    rename: async () => { throw new Error('磁盘满了'); },
    rm: async path => { calls.push({ removed: path }); },
  };
  const dir = await tempDir(t);
  const store = createStore({ dir, fs: failingFs });

  await assert.rejects(store.saveProvider('chatgpt', { displayName: '写不进去' }), error => error.code === 'credential');
  const wrote = calls.find(entry => typeof entry.wrote === 'string');
  assert.equal(wrote.wrote.endsWith('.tmp'), true, '先写临时文件');
  assert.equal(wrote.options.mode, 0o600, '临时文件必须是 0600');
  assert.equal(wrote.options.flag, 'wx', '临时文件用 wx，避免覆盖别人的同名文件');
  assert.equal(calls.some(entry => typeof entry.removed === 'string' && entry.removed.endsWith('.tmp')), true, '失败后清理临时文件');
});

test('readCatalog returns defaults when no directory is configured', async () => {
  const store = createStore({ dir: '' });
  const catalog = await store.readCatalog();
  assert.equal(catalog.recoveredFrom, 'missing');
  assert.equal(catalog.providers.chatgpt.models.length, DEFAULT_CHATGPT_COUNT);
  await assert.rejects(
    store.saveProvider('chatgpt', { displayName: 'X' }),
    error => error.code === 'credential',
    '没目录就没法落盘',
  );
});

// ── 账号探针 ────────────────────────────────────────────────────────────────
test('accountState reports everything unconfigured without a probe', async () => {
  subscriptionModels.setAccountProbe(null);
  const state = await subscriptionModels.accountState();

  assert.deepEqual(state, {
    chatgpt: { configured: false, count: 0, email: null },
    gemini: { configured: false, count: 0, email: null },
  }, '没有探针时不能谎报已登录');
});

test('accountState reads count and email from a working probe', async () => {
  subscriptionModels.setAccountProbe(async () => ({
    chatgpt: { configured: true, count: 2, email: 'me@example.com' },
    gemini: { configured: false, count: 0, email: null },
  }));
  const state = await subscriptionModels.accountState();

  assert.deepEqual(state.chatgpt, { configured: true, count: 2, email: 'me@example.com' });
  assert.deepEqual(state.gemini, { configured: false, count: 0, email: null });
  // 改返回值不应该影响缓存里的快照（说明读出去的是副本）。
  state.chatgpt.count = 99;
  assert.equal((await subscriptionModels.accountState()).chatgpt.count, 2, '读出去的是副本');
});

test('accountState degrades to all-false when the probe throws', async () => {
  subscriptionModels.setAccountProbe(async () => { throw new Error('CLI 未安装'); });
  const state = await subscriptionModels.accountState();

  assert.equal(state.chatgpt.configured, false, '探针失败不等于已登录');
  assert.equal(state.gemini.configured, false);
  assert.equal(state.chatgpt.count, 0);
  assert.equal(state.chatgpt.email, null);
  assert.match(state.chatgpt.error, /CLI 未安装/, '要把失败原因带出去，设置页才能解释为什么是灰的');
});

test('accountState caches within five seconds and refreshes when the probe changes', async () => {
  let calls = 0;
  subscriptionModels.setAccountProbe(async () => {
    calls += 1;
    return { chatgpt: { configured: true, count: calls, email: null }, gemini: { configured: false, count: 0, email: null } };
  });

  await subscriptionModels.accountState();
  const second = await subscriptionModels.accountState();
  assert.equal(calls, 1, '5 秒内的第二次调用必须走缓存（探针只该被调一次）');
  assert.equal(second.chatgpt.count, 1);

  // 换探针立刻作废缓存：否则设置页新增账号后 5 秒内看到的还是旧数据。
  subscriptionModels.setAccountProbe(async () => ({
    chatgpt: { configured: true, count: 7, email: null },
    gemini: { configured: false, count: 0, email: null },
  }));
  assert.equal((await subscriptionModels.accountState()).chatgpt.count, 7);

  subscriptionModels.setAccountProbe(null);
});

// ── 模型探针（「获取可用模型」）─────────────────────────────────────────────
// discoverModels 走的是模块级默认实例，所以这些用例用 configureUserDataDir 把默认实例
// 指向本用例的临时目录；用完在 t.after 里摘掉，避免污染后续用例。
async function useDefaultStore(t) {
  const dir = await tempDir(t);
  subscriptionModels.configureUserDataDir(() => dir);
  t.after(() => subscriptionModels.configureUserDataDir(null));
  t.after(() => subscriptionModels.setModelProbe(null));
  return dir;
}

test('discoverModels falls back to the stored catalog without a probe', async t => {
  await useDefaultStore(t);
  subscriptionModels.setModelProbe(null);
  // 先把「当前目录」改掉，证明兜底给的是存储层里的目录，而不是默认常量。
  await subscriptionModels.saveProvider('chatgpt', { models: [model({ id: 'my-gpt' })] });

  const result = await subscriptionModels.discoverModels('chatgpt');
  assert.equal(result.source, 'builtin');
  assert.match(result.note, /手动添加模型/, '拿不到线上目录时要提示用户还能手动加');
  assert.deepEqual(result.models.map(item => item.id), ['my-gpt'], '兜底目录 = 用户当前保存的目录');

  const untouched = await subscriptionModels.discoverModels('gemini');
  assert.equal(untouched.models.length, DEFAULT_GEMINI_COUNT, '没改过的通道仍是默认目录');
});

test('discoverModels prefers the probe result', async t => {
  await useDefaultStore(t);
  let asked = null;
  subscriptionModels.setModelProbe(async target => {
    asked = target;
    return { models: [model({ id: 'gpt-5.9-live', name: 'GPT-5.9 Live' })], note: ' 来自订阅账号 ' };
  });

  const result = await subscriptionModels.discoverModels('chatgpt');
  assert.equal(asked, 'chatgpt', '探针要收到存储层的 target');
  assert.equal(result.source, 'probe');
  assert.equal(result.note, '来自订阅账号', 'note 要 trim');
  assert.deepEqual(result.models.map(item => item.id), ['gpt-5.9-live']);
});

test('discoverModels never throws when the probe explodes', async t => {
  await useDefaultStore(t);
  subscriptionModels.setModelProbe(async () => { throw new Error('agy 版本过旧：需要 ≥ 2.0.0'); });

  const result = await subscriptionModels.discoverModels('gemini');
  assert.equal(result.source, 'builtin', '探针失败要退回本机目录');
  assert.match(result.note, /agy 版本过旧/, '失败原因要进 note');
  assert.equal(result.models.length, DEFAULT_GEMINI_COUNT, '目录仍然可用，用户还能编辑');
});

test('discoverModels truncates a very long probe error', async t => {
  await useDefaultStore(t);
  subscriptionModels.setModelProbe(async () => { throw new Error('x'.repeat(500)); });

  const result = await subscriptionModels.discoverModels('chatgpt');
  assert.equal(result.source, 'builtin');
  const summary = result.note.replace(/^.*枚举失败：/, '').replace(/）$/, '');
  assert.equal(summary.length <= 200, true, '错误摘要要截断到 200 字以内');
  assert.equal(summary.length > 0, true, '截断后仍要有内容');
});

test('discoverModels ignores a probe that returns nothing usable', async t => {
  await useDefaultStore(t);
  subscriptionModels.setModelProbe(async () => ({ models: [], note: '空' }));

  const result = await subscriptionModels.discoverModels('chatgpt');
  assert.equal(result.source, 'builtin', '探针返回空列表等于没拿到，要走兜底');
  assert.equal(result.models.length, DEFAULT_CHATGPT_COUNT);
});

test('discoverModels tolerates an unknown target', async t => {
  await useDefaultStore(t);
  const result = await subscriptionModels.discoverModels('antigravity');
  assert.equal(result.source, 'builtin');
  assert.deepEqual(result.models, []);
});

test('normalizeModels is a pure validator', () => {
  const models = subscriptionModels.normalizeModels([model({ efforts: ['high', 'minimal'] })]);
  assert.deepEqual(models[0].efforts, ['minimal', 'high']);
  assert.throws(() => subscriptionModels.normalizeModels(null), { code: 'request' });
  assert.throws(() => subscriptionModels.normalizeModels([{ id: '' }]), { code: 'request' });
  assert.throws(() => subscriptionModels.normalizeModels([model(), model()]), { code: 'request' });
});
