// provider 与模型目录的唯一事实来源：读写 userData/providers.json、校验用户填的表单、
// 解析「某个 provider 的某个模型」。内置订阅 provider（chatgpt / gemini）只在这里出现，
// 永不落盘、不可增删改；它们的凭据由 electron/subscription/ 管，本模块只负责让
// model-ipc 能解析到它们（kind/subscriptionProvider）并拿到空 key。
// 不负责：真正的模型调用、订阅登录态、密钥加密（那是 model-credentials.cjs 的事）。
const { app } = require('electron');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { ModelError } = require('./local-model.cjs');
const credentials = require('./model-credentials.cjs');
const subscriptionModels = require('./subscription-models.cjs');

// 订阅 provider 的模型目录已挪到 subscription-models.cjs（可编辑、可持久化）。那个模块刻意不
// require('electron')，userData 目录必须由这里注入：既让存储层能在纯 node 测试里跑，也保证
// providers.cjs 仍是「谁能拿到 app.getPath 的唯一入口」。
subscriptionModels.configureUserDataDir(() => app.getPath('userData'));

const PROTOCOLS = ['openai', 'anthropic'];
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_PROVIDERS = 12;
const MAX_MODELS = 80;

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude-5.5 Opus', vision: true, efforts: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-5-5', name: 'Claude-5.5 Sonnet', vision: true, efforts: ['low', 'medium', 'high'] },
  { id: 'claude-haiku-5-5', name: 'Claude-5.5 Haiku', vision: true, efforts: ['low', 'medium', 'high'] },
];

const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vision: true, efforts: ['low', 'high', 'max'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', vision: false, efforts: ['high', 'max'] },
];

const OPENAI_MODELS = [
  { id: 'gpt-5.1', name: 'GPT-5.1', vision: true, efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-5.1-mini', name: 'GPT-5.1 mini', vision: true, efforts: ['low', 'medium', 'high'] },
];

const SEED = {
  id: 'local',
  name: '本地网关',
  baseUrl: 'http://127.0.0.1:8788/v1',
  protocol: 'openai',
  models: DEEPSEEK_MODELS.slice(0, 1),
};

// ── 内置订阅 provider ────────────────────────────────────────────────────
// 为什么仍然写死在这里：订阅通道的凭据不在 providers.json（在本机 CLI 自己的登录态里，见
// electron/subscription/），所以这两条永不落盘、也不参与用户增删改——一旦让用户删掉，
// model-ipc 里「订阅 Gemini 走 ACP」的判定就再没有 provider 能命中，整条链断掉。
// 但模型目录不再是常量：它由 subscription-models.cjs 持久化（用户可改名、改模型、「获取可用模型」），
// 所以这里只留骨架（id/kind/subscriptionProvider/protocol/baseUrl），目录与显示名一律现读存储层。
const SUBSCRIPTION_TARGETS = subscriptionModels.TARGETS;

const SUBSCRIPTION_PROVIDERS = [
  {
    id: 'subscription:chatgpt',
    kind: 'subscription',
    subscriptionProvider: 'chatgpt',
    name: subscriptionModels.DEFAULT_CATALOG.chatgpt.displayName,
    protocol: 'openai',
    // 订阅对话走 chatgpt.com/backend-api/codex/responses，不是 api.openai.com：
    // 这条 baseUrl 同时是 chat-agent 里 guardedFetch 的白名单前缀，写错会把请求拦下来。
    baseUrl: 'https://chatgpt.com/backend-api',
    models: cloneCatalogModels(subscriptionModels.DEFAULT_CATALOG.chatgpt.models),
  },
  {
    id: 'subscription:gemini',
    kind: 'subscription',
    subscriptionProvider: 'gemini',
    name: subscriptionModels.DEFAULT_CATALOG.gemini.displayName,
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: cloneCatalogModels(subscriptionModels.DEFAULT_CATALOG.gemini.models),
  },
];

/** 内置目录会走到多个调用方：谁读都得拿副本，否则一次修改就污染全局。 */
function cloneCatalogModel(model) {
  return {
    ...model,
    efforts: Array.isArray(model.efforts) ? [...model.efforts] : [],
    // variants 决定「选了某个档位之后到底发哪个 id」，必须一起带上，否则模型菜单能选、请求却发不出去。
    ...(model.variants && typeof model.variants === 'object' ? { variants: { ...model.variants } } : {}),
  };
}

function cloneCatalogModels(models) {
  return (models ?? []).map(cloneCatalogModel);
}

function builtinProvider(id) {
  return SUBSCRIPTION_PROVIDERS.find(provider => provider.id === id);
}

/** 存储层的 target（chatgpt/gemini）与内置 id（subscription:chatgpt）不同名，转换只在这里做一次。 */
function subscriptionTarget(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const target = raw.startsWith('subscription:') ? raw.slice('subscription:'.length) : raw;
  if (!SUBSCRIPTION_TARGETS.includes(target)) throw new ModelError('request');
  return target;
}

/**
 * 读存储层的订阅目录。存储层已经承诺不抛，这里再兜一层：目录读失败最多是「显示默认目录」，
 * 绝不能把 providers:list 整条打挂——那会让设置页连用户自建的 provider 都看不到。
 */
async function subscriptionCatalog() {
  try {
    return await subscriptionModels.readCatalog();
  } catch {
    return { providers: subscriptionModels.DEFAULT_CATALOG, recoveredFrom: 'corrupt' };
  }
}

/** 某个订阅通道当前的目录条目（存储层有就用存储层，没有就用默认值的一份副本）。 */
async function subscriptionEntry(target) {
  const catalog = await subscriptionCatalog();
  return catalog.providers?.[target] ?? subscriptionModels.DEFAULT_CATALOG[target];
}

/**
 * 内置订阅 provider 对外的统一视图。
 * 关键取舍：`configured === false` 时**不清空 models** —— 设置页要能显示目录让用户编辑，
 * 「未登录的不显示」是渲染层的过滤，不是数据的缺失。
 */
function builtinView(provider, entry, account) {
  const target = provider.subscriptionProvider;
  const fallback = subscriptionModels.DEFAULT_CATALOG[target];
  const count = Math.max(0, Math.floor(Number(account?.count) || 0));
  const email = typeof account?.email === 'string' && account.email ? account.email : null;
  return {
    ...provider,
    name: entry?.displayName || fallback.displayName,
    models: cloneCatalogModels(entry?.models ?? fallback.models),
    // 凭据在本机 CLI 的登录态里，不在 keyStore：谎报「已保存密钥」会误导用户去设置里翻 API Key。
    hasKey: false,
    editable: true,
    removable: false,
    configured: account?.configured === true,
    subscription: {
      provider: target,
      accounts: count,
      email,
      ...(typeof account?.error === 'string' && account.error ? { note: account.error } : {}),
    },
  };
}

/**
 * 只认契约里写明的订阅标记：`kind` 唯一合法值是 'subscription'，`subscriptionProvider`
 * 只有 chatgpt/gemini。其它值一律丢掉而不是报错——脏数据不该让整份配置保存失败，
 * 更不能因为一个拼错的字符串就把普通 provider 送进 ACP 支路。
 */
function subscriptionFields(input) {
  const fields = {};
  if (input?.kind === 'subscription') fields.kind = 'subscription';
  const target = typeof input?.subscriptionProvider === 'string' ? input.subscriptionProvider.trim().toLowerCase() : '';
  if (SUBSCRIPTION_TARGETS.includes(target)) fields.subscriptionProvider = target;
  return fields;
}

const keyStore = id => credentials.createCredentialStore(`provider-${id}.key.enc`);

function storePath() {
  return join(app.getPath('userData'), 'providers.json');
}

function limit(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function httpUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new ModelError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelError('invalid_url');
  }
  return url;
}

/** Base URLs must match what each SDK appends: OpenAI → `/chat/completions`, Anthropic → `/v1/messages`. */
function normalizeBaseUrl(value, protocol) {
  const url = httpUrl(value);
  let path = url.pathname.replace(/\/+$/, '');
  if (protocol === 'anthropic') path = path.replace(/\/v1$/, '');
  else if (!/\/v\d+$/.test(path)) path = `${path}/v1`;
  return `${url.origin}${path}`;
}

function normalizeModelId(value) {
  const id = limit(value, 128);
  if (!/^[\w.:/@+=-]{1,128}$/.test(id)) throw new ModelError('request');
  return id;
}

function normalizeEfforts(value) {
  if (!Array.isArray(value)) return [];
  return EFFORTS.filter(level => value.includes(level));
}

function normalizeModel(input) {
  if (!input || typeof input !== 'object') throw new ModelError('request');
  const id = normalizeModelId(input.id);
  const tokenLimit = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  };
  return {
    id,
    name: limit(input.name, 80) || id,
    vision: input.vision === true,
    efforts: normalizeEfforts(input.efforts),
    contextWindow: tokenLimit(input.contextWindow, 1_000_000, 1_000, 10_000_000),
    maxTokens: tokenLimit(input.maxTokens, 128_000, 256, 1_000_000),
  };
}

function normalizeProvider(input, existing) {
  if (!input || typeof input !== 'object') throw new ModelError('request');
  const name = limit(input.name, 60);
  if (!name) throw new ModelError('request');
  const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : 'openai';
  const models = Array.isArray(input.models) ? input.models.slice(0, MAX_MODELS).map(normalizeModel) : [];
  if (!models.length) throw new ModelError('no_models');
  if (new Set(models.map(model => model.id)).size !== models.length) throw new ModelError('request');
  return {
    id: existing?.id ?? null,
    ...subscriptionFields(input),
    name,
    protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl, protocol),
    models,
    updatedAt: Date.now(),
  };
}

async function readState() {
  try {
    const payload = JSON.parse(await readFile(storePath(), 'utf8'));
    if (payload?.version !== 1 || !Array.isArray(payload.providers)) return null;
    const providers = payload.providers.flatMap(provider => {
      if (!provider || typeof provider.id !== 'string' || !Array.isArray(provider.models)) return [];
      const models = provider.models.flatMap(model => {
        try { return [normalizeModel(model)]; } catch { return []; }
      });
      if (!models.length) return [];
      return [{
        id: provider.id,
        ...subscriptionFields(provider),
        name: limit(provider.name, 60) || provider.id,
        protocol: PROTOCOLS.includes(provider.protocol) ? provider.protocol : 'openai',
        baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
        models,
        updatedAt: Number(provider.updatedAt) || 0,
      }];
    });
    const active = payload.active ?? {};
    return {
      version: 1,
      providers,
      active: { providerId: String(active.providerId ?? ''), modelId: String(active.modelId ?? '') },
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ModelError('credential');
  }
}

async function writeState(state) {
  const file = storePath();
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => {});
    throw new ModelError('credential');
  }
}

async function migrateLegacyKey() {
  try {
    if (!await credentials.hasKey()) return;
    await keyStore(SEED.id).storeKey(await credentials.loadKey());
    await credentials.clearKey();
  } catch {
    // Keep the legacy credential in place; loadKey() still falls back to it.
  }
}

let initializing;
async function init() {
  initializing ??= (async () => {
    const state = await readState();
    if (state) return state;
    await migrateLegacyKey();
    const seeded = {
      version: 1,
      providers: [{ ...SEED, updatedAt: Date.now() }],
      active: { providerId: SEED.id, modelId: SEED.models[0].id },
    };
    await writeState(seeded);
    return seeded;
  })().finally(() => { initializing = undefined; });
  return initializing;
}

async function listProviders() {
  const state = await init();
  // 目录现读存储层：用户在设置页改过的显示名 / 模型顺序必须立刻反映到列表里。
  const [catalog, accounts] = await Promise.all([subscriptionCatalog(), subscriptionModels.accountState()]);
  // 内置订阅 provider 恒定排最前：渲染层按这个顺序渲染分组，用户自建的一律追加在后面。
  const providers = SUBSCRIPTION_PROVIDERS.map(provider => builtinView(
    provider,
    catalog.providers?.[provider.subscriptionProvider],
    accounts?.[provider.subscriptionProvider],
  ));
  for (const provider of state.providers) providers.push({ ...provider, hasKey: await providerHasKey(provider.id) });
  return {
    providers,
    active: resolveActiveIn(state),
    searchConfigured: await anySearchSourceConfigured(),
    // 目录文件损坏/不存在时给渲染层一个线索：设置页可以提示「已回落到默认目录」，
    // 而不是让用户以为自己的改动莫名其妙消失了。
    subscriptionRecoveredFrom: catalog.recoveredFrom ?? null,
  };
}

/**
 * Any usable search source counts: the chat search switch must not stay disabled
 * when only Tavily or a self-hosted SearXNG has credentials.
 */
async function anySearchSourceConfigured() {
  if (await credentials.searchCredentials.hasKey()) return true;
  if (await credentials.searchCredentialStore('tavily').hasKey()) return true;
  try {
    const config = await require('./search-config.cjs').searchConfig.read();
    const searxng = config?.providers?.searxng;
    return Boolean(searxng?.enabled && String(searxng.baseUrl ?? '').trim());
  } catch {
    return false;
  }
}

function resolveActiveIn(state) {
  const { providerId, modelId } = state.active ?? {};
  // 内置订阅 provider 不在 providers.json 的 providers 里，但 active 指针完全可能指向它：
  // 用户在右下角模型菜单里选了 ChatGPT，重启后如果这里认不出来，就会悄悄跳回自建 provider。
  const builtin = builtinProvider(providerId);
  if (builtin && typeof modelId === 'string' && modelId) return { providerId: builtin.id, modelId };
  const provider = state.providers.find(item => item.id === providerId);
  const model = provider?.models.find(item => item.id === modelId);
  if (provider && model) return { providerId, modelId };
  const first = state.providers[0];
  return first ? { providerId: first.id, modelId: first.models[0]?.id ?? '' } : { providerId: '', modelId: '' };
}

async function providerHasKey(id) {
  // 订阅 provider 没有 API Key：keyStore 的文件名里还带 `:`，在 Windows 上根本建不出来。
  if (builtinProvider(id)) return false;
  try {
    if (await keyStore(id).hasKey()) return true;
    return id === SEED.id && await credentials.hasKey();
  } catch {
    return false;
  }
}

async function loadProviderKey(id) {
  // 订阅 provider 的凭据在 subscription/ 那边（本机 CLI 登录态）：这里返回空串而不是抛
  // not_configured，否则调用方在进入 ACP 支路之前就被一句「未配置密钥」拦住。
  if (builtinProvider(id)) return '';
  try {
    if (await keyStore(id).hasKey()) return await keyStore(id).loadKey();
  } catch (error) {
    if (error.code !== 'not_configured') throw error;
  }
  if (id === SEED.id) return credentials.loadKey();
  throw new ModelError('not_configured');
}

function slug(name, providers) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider';
  let id = base;
  let counter = 2;
  while (providers.some(provider => provider.id === id)) id = `${base}-${counter++}`;
  return id;
}

async function saveProvider(input) {
  // 内置订阅 provider 不可写在 providers.json 里：命中即拒，避免「改名/覆盖」把内置通道抹掉。
  if (builtinProvider(input?.id)) throw new ModelError('request');
  const state = await init();
  const existing = input?.id ? state.providers.find(provider => provider.id === input.id) : undefined;
  if (input?.id && !existing) throw new ModelError('not_found');
  const provider = normalizeProvider(input, existing);
  const clash = state.providers.some(item => item.id !== existing?.id && item.name.toLowerCase() === provider.name.toLowerCase());
  if (clash) throw new ModelError('duplicate');
  if (!existing && state.providers.length >= MAX_PROVIDERS) throw new ModelError('provider_limit');
  if (!existing) provider.id = slug(provider.name, state.providers);
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  if (key) await keyStore(provider.id).storeKey(key);
  const next = existing
    ? state.providers.map(item => item.id === existing.id ? provider : item)
    : [...state.providers, provider];
  const resolved = resolveActiveIn({ providers: next, active: state.active });
  const active = resolved.providerId ? resolved : { providerId: provider.id, modelId: provider.models[0].id };
  const saved = { version: 1, providers: next, active };
  await writeState(saved);
  return { provider: { ...provider, hasKey: await providerHasKey(provider.id) }, active: saved.active };
}

async function removeProvider(id) {
  // 同上：内置订阅 provider 删不掉，删了 ACP 支路就再无 provider 可命中。
  if (builtinProvider(id)) throw new ModelError('request');
  const state = await init();
  const provider = state.providers.find(item => item.id === id);
  if (!provider) throw new ModelError('not_found');
  const providers = state.providers.filter(item => item.id !== id);
  await keyStore(id).clearKey().catch(() => {});
  const saved = { version: 1, providers, active: resolveActiveIn({ providers, active: state.active }) };
  await writeState(saved);
  return { providers, active: saved.active };
}

async function setActive(input) {
  const state = await init();
  const builtin = builtinProvider(input?.providerId);
  if (builtin) {
    // 订阅模型也必须能被选中：模型菜单里点一下 ChatGPT 就走到这里。
    // 只校验 id 形态、不校验「目录里有没有」——上游先发布新模型时不该把用户挡在门外
    // （与 resolveModel 的宽容度保持一致）。
    const modelId = normalizeModelId(input?.modelId);
    const active = { providerId: builtin.id, modelId };
    await writeState({ ...state, active });
    return active;
  }
  const provider = state.providers.find(item => item.id === input?.providerId);
  if (!provider) throw new ModelError('not_found');
  const model = provider.models.find(item => item.id === input?.modelId);
  if (!model) throw new ModelError('not_found');
  const active = { providerId: provider.id, modelId: model.id };
  await writeState({ ...state, active });
  return active;
}

function presetsFor(provider) {
  const hint = `${provider?.name ?? ''} ${provider?.baseUrl ?? ''}`.toLowerCase();
  if (hint.includes('claude') || hint.includes('anthropic')) return CLAUDE_MODELS.map(model => ({ ...model }));
  if (hint.includes('deepseek')) return DEEPSEEK_MODELS.map(model => ({ ...model }));
  if (hint.includes('openai') || hint.includes('gpt')) return OPENAI_MODELS.map(model => ({ ...model }));
  return (provider?.protocol === 'anthropic' ? CLAUDE_MODELS : DEEPSEEK_MODELS).map(model => ({ ...model }));
}

async function defaultModels(input) {
  let provider;
  if (typeof input === 'string') {
    const builtin = builtinProvider(input);
    if (builtin) {
      // 目录已可编辑：这里必须给「存储层当前目录」而不是默认常量，否则用户改完名字再点一次
      // 「恢复默认模型」，刚改的内容又会被旧常量覆盖回去。
      const entry = await subscriptionEntry(builtin.subscriptionProvider);
      return cloneCatalogModels(entry.models);
    }
    const state = await init();
    provider = state.providers.find(item => item.id === input);
    if (!provider) throw new ModelError('not_found');
  } else {
    if (!input || typeof input !== 'object') throw new ModelError('request');
    provider = {
      name: limit(input.name, 60),
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : '',
      protocol: PROTOCOLS.includes(input.protocol) ? input.protocol : 'openai',
    };
  }
  return presetsFor(provider);
}

function pickString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function readEfforts(entry) {
  const lists = [
    entry?.reasoning_efforts, entry?.reasoningEfforts,
    entry?.reasoning?.efforts, entry?.thinking?.efforts,
    entry?.capabilities?.reasoning?.efforts, entry?.capabilities?.thinking_efforts,
    entry?.capabilities?.reasoning_efforts,
  ];
  for (const list of lists) {
    if (Array.isArray(list) && list.length) {
      const efforts = normalizeEfforts(list);
      if (efforts.length) return efforts;
    }
  }
  return null;
}

function readModalities(entry) {
  const lists = [
    entry?.input_modalities, entry?.inputModalities,
    entry?.architecture?.input_modalities, entry?.capabilities?.input_modalities,
    entry?.modalities,
  ];
  for (const list of lists) if (Array.isArray(list)) return list.filter(item => typeof item === 'string');
  return [];
}

function inferEfforts(haystack) {
  if (/(claude)/i.test(haystack) && /(opus|sonnet|fable|haiku)/i.test(haystack)) return ['low', 'medium', 'high'];
  if (/(reasoner|thinking|deepseek-r1|-r1\b|^o[1-4]\b)/i.test(haystack)) return ['low', 'medium', 'high'];
  if (/(deepseek.*pro|gpt-5.*pro|-pro\b)/i.test(haystack)) return ['low', 'high', 'max'];
  return [];
}

/** Turns a `/models` entry from either protocol into the catalog shape stored in providers.json. */
function describeModel(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id || !/^[\w.:/@+=-]{1,128}$/.test(id)) return null;
  const name = limit(pickString(entry.display_name, entry.displayName, entry.name, id), 80);
  const modalities = readModalities(entry).map(item => item.toLowerCase());
  const haystack = `${id} ${name}`;
  const vision = modalities.includes('image')
    || modalities.includes('vision')
    || /(vision|vl\b|omni|claude|gpt-4o|gpt-4\.1|gpt-5|gemini|sonnet|opus|fable)/i.test(haystack);
  const efforts = readEfforts(entry) ?? inferEfforts(haystack);
  return { id, name, vision, efforts };
}

async function fetchModels(input) {
  const builtin = builtinProvider(input?.id);
  if (builtin) {
    // 订阅 provider 没有 API Key，以前用空 key 去打 api.openai.com/v1/models 必然 401；
    // 现在改走订阅侧的模型探针：拿到真实目录就返回它，拿不到就返回当前目录（且绝不抛）。
    // 返回值仍是数组，兼容老的「拿到列表直接填进表单」调用。
    return (await subscriptionModels.discoverModels(builtin.subscriptionProvider)).models;
  }
  const state = await init();
  const provider = input?.id ? state.providers.find(item => item.id === input.id) : undefined;
  if (input?.id && !provider) throw new ModelError('not_found');
  const protocol = PROTOCOLS.includes(input?.protocol) ? input.protocol : provider?.protocol ?? 'openai';
  const baseUrl = normalizeBaseUrl(input?.baseUrl || provider?.baseUrl, protocol);
  const key = typeof input?.key === 'string' && input.key.trim()
    ? credentials.validateKey(input.key)
    : await loadProviderKey(provider?.id);
  const endpoint = protocol === 'anthropic' ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
  const headers = protocol === 'anthropic'
    ? { 'x-api-key': key, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', accept: 'application/json' }
    : { Authorization: `Bearer ${key}`, accept: 'application/json' };
  let response;
  try {
    response = await fetch(endpoint, {
      headers, redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ModelError('network');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status)) throw new ModelError('auth');
    if (response.status === 404) throw new ModelError('not_found');
    if (response.status === 429) throw new ModelError('rate_limit');
    throw new ModelError(response.status >= 500 ? 'upstream' : 'request');
  }
  let payload;
  try { payload = await response.json(); } catch { throw new ModelError('protocol'); }
  const entries = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload) ? payload : [];
  const seen = new Set();
  const models = [];
  for (const entry of entries.slice(0, 400)) {
    const model = describeModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (!models.length) throw new ModelError('empty_catalog');
  models.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return models;
}

async function resolveModel(providerId, modelId) {
  const builtin = builtinProvider(providerId);
  if (builtin) {
    // 目录来自存储层：用户在设置页改过的显示名 / 思考档位必须在这里生效，否则聊天页显示的
    // 还是内置旧常量。目录外仍放行（只校验 id 形态），因为订阅上游随时可能先于 Mova 发布新模型。
    const entry = await subscriptionEntry(builtin.subscriptionProvider);
    const known = (entry.models ?? []).find(item => item.id === modelId);
    const model = known ? cloneCatalogModel(known) : normalizeModel({ id: modelId, name: modelId });
    return { provider: builtinView(builtin, entry, null), model };
  }
  const state = await init();
  const provider = state.providers.find(item => item.id === providerId);
  if (!provider) throw new ModelError('not_found');
  const model = provider.models.find(item => item.id === modelId);
  if (!model) throw new ModelError('not_found');
  return { provider, model };
}

/**
 * 保存订阅 provider 的目录（改名 / 改模型 / 删模型）。
 * 为什么与 saveProvider 分开：两者落盘位置不同（providers.json vs subscription-models.json）。
 * 合成一个函数会让「内置条目永远写不进 providers.json」这条约束出现漏洞。
 */
async function saveSubscription(input) {
  const target = subscriptionTarget(input?.target ?? input?.id);
  const patch = {};
  if (input && typeof input === 'object') {
    // 部分更新：只把调用方真正给过的字段往下传；没给的字段保持存储层里的原值。
    if (Object.hasOwn(input, 'displayName')) patch.displayName = input.displayName;
    if (Object.hasOwn(input, 'models')) patch.models = input.models;
  }
  const { provider: entry } = await subscriptionModels.saveProvider(target, patch);
  const accounts = await subscriptionModels.accountState();
  const builtin = SUBSCRIPTION_PROVIDERS.find(item => item.subscriptionProvider === target);
  return { provider: builtinView(builtin, entry, accounts?.[target]) };
}

/**
 * 「获取可用模型」：把 discoverModels 的完整结果（含 source/note）原样交给渲染层，
 * 界面才能区分「真的拉到了线上目录」和「只是本机当前目录」。
 */
async function fetchSubscriptionModels(input) {
  return subscriptionModels.discoverModels(subscriptionTarget(input?.target ?? input?.id));
}

async function resolveActive(providerId, modelId) {
  const state = await init();
  const active = resolveActiveIn(state);
  return resolveModel(providerId || active.providerId, modelId || active.modelId);
}

module.exports = {
  PROTOCOLS, EFFORTS, normalizeBaseUrl, normalizeProvider, describeModel, inferEfforts,
  init, listProviders, saveProvider, removeProvider, setActive, defaultModels, fetchModels,
  saveSubscription, fetchSubscriptionModels,
  resolveModel, resolveActive, loadProviderKey, providerHasKey, loadKey: loadProviderKey,
};
