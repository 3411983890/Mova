// 内置订阅 provider（subscription:chatgpt / subscription:gemini）的契约测试。
// 覆盖：listProviders 顺序、resolveModel 目录命中与目录外放行、loadProviderKey 返回空串、
// normalizeProvider 对 kind/subscriptionProvider 的白名单、以及内置条目不可增删改。
// 这里只跑纯 Node：用 require.cache 顶替 electron 模块，让 app.getPath('userData') 落到临时目录。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

// providers.cjs / model-credentials.cjs 顶层就 `const { app } = require('electron')`。
// 在 node --test 下 require('electron') 只会拿到一个可执行文件路径字符串（没有 app），
// 所以先把 electron 塞进 require 缓存再加载被测模块：app.getPath 由每个用例的临时目录决定。
const electronEntry = require.resolve('electron');
const electronState = { dir: '' };
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: { getPath: () => electronState.dir },
    safeStorage: {
      available: false,
      isAsyncEncryptionAvailable: () => false,
      encryptStringAsync: async () => { throw new Error('测试环境没有 DPAPI'); },
      decryptStringAsync: async () => { throw new Error('测试环境没有 DPAPI'); },
    },
  },
};

const providers = require('../electron/providers.cjs');

const BUILTIN_IDS = ['subscription:chatgpt', 'subscription:gemini'];

/** 每个用例一份干净的用户目录：providers.json 会按需重新播种，用例之间互不串味。 */
async function openStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mova-providers-sub-'));
  electronState.dir = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function draft(overrides = {}) {
  return {
    name: '自建通道',
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    models: [
      { id: 'custom-model-1', name: 'Custom Model', vision: true, efforts: ['low', 'high'], contextWindow: 200_000, maxTokens: 64_000 },
    ],
    ...overrides,
  };
}

test('lists both built-in subscription providers before user providers', async t => {
  await openStore(t);
  const { providers: list } = await providers.listProviders();

  assert.deepEqual(list.slice(0, 2).map(row => row.id), BUILTIN_IDS, '两个内置订阅 provider 必须排在最前');
  assert.equal(list[0].kind, 'subscription', '内置 chatgpt 条目要自报订阅通道');
  assert.equal(list[0].subscriptionProvider, 'chatgpt', '内置 chatgpt 条目的订阅目标要对');
  assert.equal(list[1].subscriptionProvider, 'gemini', '内置 gemini 条目的订阅目标要对');
  assert.equal(list[0].baseUrl, 'https://chatgpt.com/backend-api', '订阅对话走 chatgpt.com/backend-api，不是 api.openai.com');
  assert.equal(list[2].id, 'local', '用户自建 provider 应当追加在内置之后');
  assert.equal(list[0].hasKey, false, '订阅 provider 不该谎报「已保存密钥」');
});

test('keeps listProviders ordering stable across calls', async t => {
  await openStore(t);
  const first = (await providers.listProviders()).providers.map(row => row.id);
  const second = (await providers.listProviders()).providers.map(row => row.id);

  assert.deepEqual(second, first, '连续两次 listProviders 的 provider 顺序必须一致');
  assert.deepEqual(first.slice(0, 2), BUILTIN_IDS, '稳定顺序里内置条目仍应领先');
});

test('resolveModel hits the built-in gemini catalog', async t => {
  await openStore(t);
  const { provider, model } = await providers.resolveModel('subscription:gemini', 'gemini-3.1-pro');

  assert.equal(provider.id, 'subscription:gemini', '应当解析到内置 gemini 订阅 provider');
  assert.equal(provider.kind, 'subscription', '解析结果要保留 kind，ACP 判定靠它');
  assert.equal(provider.subscriptionProvider, 'gemini', '解析结果要保留 subscriptionProvider');
  assert.equal(model.id, 'gemini-3.1-pro');
  assert.equal(model.contextWindow, 1_000_000, 'gemini-3.1-pro 是 1M 上下文');
  assert.deepEqual(model.efforts, ['low', 'medium', 'high'], 'gemini-3.1-pro 只开放三档思考');
});

test('resolveModel passes through unknown but well-formed subscription model ids', async t => {
  await openStore(t);
  const { model } = await providers.resolveModel('subscription:chatgpt', 'gpt-9-preview');

  assert.equal(model.id, 'gpt-9-preview', '目录外的新模型要按格式放行');
  assert.equal(model.name, 'gpt-9-preview', '没有目录信息时 name 回落成 id');
});

test('resolveModel rejects malformed subscription model ids', async t => {
  await openStore(t);
  await assert.rejects(
    providers.resolveModel('subscription:chatgpt', 'not a model id'),
    error => error.code === 'request',
    '模型 id 形态非法时要报 request',
  );
});

test('loadProviderKey returns an empty string for subscription providers', async t => {
  await openStore(t);
  for (const id of BUILTIN_IDS) {
    const key = await providers.loadProviderKey(id);
    assert.equal(key, '', `${id} 没有 API Key，应当返回空串`);
  }
  assert.equal(await providers.loadKey('subscription:gemini'), '', 'loadKey 别名行为一致');
});

test('loadProviderKey still reports not_configured for user providers without a key', async t => {
  await openStore(t);
  const saved = await providers.saveProvider(draft());
  await assert.rejects(
    providers.loadProviderKey(saved.provider.id),
    error => error.code === 'not_configured',
    '普通 provider 没存密钥时仍应报 not_configured（订阅特例不能扩散）',
  );
});

test('defaultModels returns the built-in chatgpt catalog', async t => {
  await openStore(t);
  const models = await providers.defaultModels('subscription:chatgpt');
  const luna = models.find(model => model.id === 'gpt-5.6-luna');

  assert.deepEqual(
    models.map(model => model.id),
    ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    'chatgpt 内置目录按约定顺序（与 Codex 订阅真实目录一致）',
  );
  assert.ok(luna, '目录里必须有 gpt-5.6-luna');
  assert.equal(luna.name, 'GPT-5.6 Luna');
  assert.equal(luna.contextWindow, 272_000, 'gpt-5.6-luna 上下文 272k');
  assert.equal(luna.maxTokens, 128_000, 'gpt-5.6-luna 输出上限 128k');
  assert.equal(luna.vision, true, 'gpt-5.6-luna 支持图像输入');
  assert.deepEqual(luna.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'gpt-5.6-luna 思考档位要对齐');
});

test('defaultModels returns the built-in gemini catalog', async t => {
  await openStore(t);
  const models = await providers.defaultModels('subscription:gemini');

  assert.deepEqual(models.map(model => model.id), ['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'], 'gemini 内置目录按约定顺序');
  assert.equal(models[0].contextWindow, 1_000_000, 'gemini-3.1-pro 是 1M 上下文');
});

test('defaultModels hands out copies so callers cannot mutate the catalog', async t => {
  await openStore(t);
  const models = await providers.defaultModels('subscription:chatgpt');
  models[0].name = '被改坏的名字';
  models[0].efforts.push('minimal');

  const again = await providers.defaultModels('subscription:chatgpt');
  assert.equal(again[0].name, 'GPT-6.1 Sol', '内置目录不能被调用方改到');
  assert.equal(again[0].efforts.length, 6, 'efforts 数组同样要复制，push 不能渗回默认值');
});

test('saveProvider keeps kind and subscriptionProvider for a user-created subscription entry', async t => {
  await openStore(t);
  const saved = await providers.saveProvider(draft({ kind: 'subscription', subscriptionProvider: 'gemini' }));

  assert.equal(saved.provider.kind, 'subscription', '用户自建条目上的 kind 必须保留');
  assert.equal(saved.provider.subscriptionProvider, 'gemini', '合法 subscriptionProvider 必须保留');

  const { providers: list } = await providers.listProviders();
  const reloaded = list.find(row => row.id === saved.provider.id);
  assert.ok(reloaded, '自建订阅 provider 应当出现在列表里');
  assert.equal(reloaded.kind, 'subscription', '落盘再读回后 kind 不能丢');
  assert.equal(reloaded.subscriptionProvider, 'gemini', '落盘再读回后 subscriptionProvider 不能丢');
});

test('saveProvider drops an unknown kind and an unknown subscriptionProvider', async t => {
  await openStore(t);
  const saved = await providers.saveProvider(draft({
    name: '脏数据通道',
    kind: 'enterprise',
    subscriptionProvider: 'anthropic',
  }));

  assert.equal('kind' in saved.provider, false, '非法 kind 要丢弃，让条目退回普通 provider');
  assert.equal('subscriptionProvider' in saved.provider, false, '非法 subscriptionProvider 要丢弃而不是报错');

  const row = (await providers.listProviders()).providers.find(item => item.id === saved.provider.id);
  assert.equal(row?.kind, undefined, '读回后仍是普通 provider');
  const { provider } = await providers.resolveModel(saved.provider.id, 'custom-model-1');
  assert.equal(provider.kind, undefined, 'resolveModel 也不该把脏数据当订阅通道');
});

test('normalizes subscriptionProvider casing and ignores non-string values', async t => {
  await openStore(t);
  const upper = await providers.saveProvider(draft({ name: '大写通道', subscriptionProvider: 'Gemini' }));
  assert.equal(upper.provider.subscriptionProvider, 'gemini', 'subscriptionProvider 大小写归一');

  const weird = await providers.saveProvider(draft({ name: '怪值通道', subscriptionProvider: 42 }));
  assert.equal('subscriptionProvider' in weird.provider, false, '非字符串 subscriptionProvider 直接丢弃');
});

test('saveProvider refuses to modify a built-in subscription provider', async t => {
  await openStore(t);
  await assert.rejects(
    providers.saveProvider(draft({ id: 'subscription:gemini', kind: 'subscription', subscriptionProvider: 'gemini' })),
    error => error.code === 'request',
    '内置订阅 provider 不允许改名或覆盖',
  );

  const { providers: list } = await providers.listProviders();
  assert.equal(list[0].id, 'subscription:chatgpt', '拒绝后内置条目仍在原位');
  // 名字来自订阅模型目录的 displayName（默认就是 'Gemini'）：这里要断言的是
  // 「saveProvider 没能把它改名」，不是某个具体文案。
  assert.equal(list.find(row => row.id === 'subscription:gemini')?.name, 'Gemini', '内置条目名字没被改写');
});

test('removeProvider refuses to delete a built-in subscription provider', async t => {
  await openStore(t);
  await assert.rejects(
    providers.removeProvider('subscription:chatgpt'),
    error => error.code === 'request',
    '内置订阅 provider 删不掉',
  );

  const { providers: list } = await providers.listProviders();
  assert.deepEqual(list.slice(0, 2).map(row => row.id), BUILTIN_IDS, '拒绝删除后整条链仍然完整');
});

test('resolveModel keeps working for user providers and unknown ids', async t => {
  await openStore(t);
  const saved = await providers.saveProvider(draft());

  const hit = await providers.resolveModel(saved.provider.id, 'custom-model-1');
  assert.equal(hit.model.id, 'custom-model-1', '普通 provider 的解析路径不受影响');

  await assert.rejects(
    providers.resolveModel('subscription:unknown', 'custom-model-1'),
    error => error.code === 'not_found',
    '非内置且不存在的 provider 仍报 not_found',
  );
});

// 订阅模型必须能被「选中」：右下角模型菜单点一下就走到 setActive。
// 以前这里只查 providers.json，内置订阅 provider 永远 not_found，于是菜单里选中的
// ChatGPT 会被回滚，聊天仍然走自建 provider——这正是「登录了却还是用不上」的一半原因。
test('setActive accepts a built-in subscription model and survives a reload', async t => {
  await openStore(t);
  const active = await providers.setActive({ providerId: 'subscription:chatgpt', modelId: 'gpt-5.6-luna' });
  assert.deepEqual(active, { providerId: 'subscription:chatgpt', modelId: 'gpt-5.6-luna' });

  // listProviders 是「重启后」的唯一真相：它必须还认得这个指针，不能悄悄跳回自建 provider。
  const { active: reloaded } = await providers.listProviders();
  assert.equal(reloaded.providerId, 'subscription:chatgpt', '重启后仍指向订阅通道');
  assert.equal(reloaded.modelId, 'gpt-5.6-luna');

  // 目录外的模型也要放行：上游先发布新模型时不该把用户挡在门外。
  const unknown = await providers.setActive({ providerId: 'subscription:gemini', modelId: 'gemini-unreleased-x' });
  assert.equal(unknown.modelId, 'gemini-unreleased-x');
});

test('setActive still rejects a provider that does not exist', async t => {
  await openStore(t);
  await assert.rejects(
    providers.setActive({ providerId: 'nope', modelId: 'x' }),
    error => error.code === 'not_found',
    '未知 provider 不能被设为当前模型',
  );
});
