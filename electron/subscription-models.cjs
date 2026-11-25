// 内置订阅 provider（chatgpt / gemini）的模型目录：唯一事实来源 + 用户可编辑的持久化层。
//
// 为什么单独一个模块：这两条 provider 的**凭据**不在 providers.json（在本机 CLI 的 OAuth 登录态里，
// 见 electron/subscription/），所以 providers.json 永远拒绝写它们；但用户又必须能改显示名、配
// 思考档位、手动增删模型——于是给它们一份独立的、可写的落盘文件，跟 providers.cjs 的写入路径
// 分开，才不会把「内置条目不可写 providers.json」这条约束破坏掉。
//
// 为什么不在顶层 require('electron')：providers.cjs 顶层就有 `const { app } = require('electron')`，
// 这让它无法在纯 node --test 里加载。本模块改成「目录由外部注入」（configureUserDataDir），
// 于是存储层可以脱离 Electron 单测；生产环境由 providers.cjs 注入 app.getPath('userData')。
//
// 不负责：模型调用、订阅登录态、OAuth 令牌（那是 electron/subscription/ 的事）。
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { ModelError } = require('./local-model.cjs');

// 只认这两个订阅通道。取值与 providers.cjs 的 subscriptionProvider 完全一致（chatgpt / gemini），
// 这样「内置 provider id ↔ 本文件的 target」只差一个 `subscription:` 前缀。
const TARGETS = Object.freeze(['chatgpt', 'gemini']);

// 与 providers.cjs 同一套思考档位与顺序：顺序即界面上按钮的排列顺序，也是落盘时的规范顺序。
const EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const MAX_MODELS = 80;
const FILE_NAME = 'subscription-models.json';
const VERSION = 1;
// 目录内容的版本（不是文件格式的版本）。默认模型清单换过一版就必须 +1：
// 旧文件里的模型 id 是上一版猜的，留着只会让用户点下去 404。
const CATALOG_VERSION = 2;

// 探针拿不到目录时的统一说明：这句话会显示在设置页上，所以必须说清「这是本地目录，不是线上真实目录」，
// 否则用户会以为订阅通道真的只有这几个模型。
const BUILTIN_NOTE = '订阅通道暂时无法枚举模型，已列出当前目录；可以手动添加模型。';

// 探针结果的缓存时长：账号状态在一次设置页打开里会被问很多次（列表 + 每个分组），
// 5 秒足够合并这些重复请求，又不会让「刚登录完」的用户等太久才看到绿色状态。
const ACCOUNT_CACHE_MS = 5_000;

/** 默认目录：唯一的默认值来源。providers.cjs 从这里取，不许再存一份常量。 */
const DEFAULT_CATALOG = deepFreeze({
  // 显示名刻意不带「订阅」两字：模型列表里要显示成 ChatGPT / Gemini（用户明确要求的称呼）。
  chatgpt: {
    displayName: 'ChatGPT',
    // 真实清单：与 @earendil-works/pi-ai 的 openai-codex 目录（chatgpt.com/backend-api）逐条对齐。
    // 思考强度不是「另一个模型」，而是同一模型上的档位，所以只列 8 个 id。
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 500_000, maxTokens: 128_000 },
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 500_000, maxTokens: 128_000 },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 272_000, maxTokens: 128_000 },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 272_000, maxTokens: 128_000 },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 272_000, maxTokens: 128_000 },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 272_000, maxTokens: 128_000 },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 272_000, maxTokens: 128_000 },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vision: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 272_000, maxTokens: 128_000 },
    ],
  },
  gemini: {
    displayName: 'Gemini',
    models: [
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', vision: true, efforts: ['low', 'medium', 'high'], contextWindow: 1_000_000, maxTokens: 65_536 },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', vision: true, efforts: ['low', 'medium', 'high'], contextWindow: 1_000_000, maxTokens: 65_536 },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', vision: true, efforts: [], contextWindow: 1_000_000, maxTokens: 65_536 },
    ],
  },
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function cloneModel(model) {
  return {
    ...model,
    efforts: Array.isArray(model.efforts) ? [...model.efforts] : [],
    ...(model.variants && typeof model.variants === 'object' ? { variants: { ...model.variants } } : {}),
  };
}

/** 目录条目读出去一律给副本：默认值是冻结的，但调用方拿到的必须是自己的对象（可改可扔）。 */
function cloneEntry(entry) {
  return {
    displayName: entry?.displayName ?? '',
    models: Array.isArray(entry?.models) ? entry.models.map(cloneModel) : [],
  };
}

function cloneAccounts(value) {
  const out = {};
  for (const target of TARGETS) out[target] = { ...emptyAccount(), ...(value?.[target] ?? {}) };
  return out;
}

function emptyAccount() {
  return { configured: false, count: 0, email: null };
}

function emptyAccounts() {
  const out = {};
  for (const target of TARGETS) out[target] = emptyAccount();
  return out;
}

// ── 校验（与 providers.cjs 同一套规则，只收紧不放宽）────────────────────────
function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function requireTarget(value) {
  const target = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!TARGETS.includes(target)) throw new ModelError('request');
  return target;
}

function normalizeModelId(value) {
  const id = text(value, 128);
  if (!/^[\w.:/@+=-]{1,128}$/.test(id)) throw new ModelError('request');
  return id;
}

function normalizeEfforts(value) {
  // 非法档位直接丢掉而不是报错：界面上勾错一个值，不该让整份目录保存失败。
  if (!Array.isArray(value)) return [];
  return EFFORTS.filter(level => value.includes(level));
}

/**
 * 显示名：1..40 字符，且不许控制字符/换行（它会被渲染进模型下拉框，换行会把布局撑坏）。
 * 不做 `|| 默认名` 的兜底：空名字说明调用方给错了，静默改成默认名会让用户以为保存成功了。
 */
function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw new ModelError('request');
  const name = value.trim();
  if (name.length < 1 || name.length > 40) throw new ModelError('request');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ModelError('request');
  return name;
}

/**
 * `variants` 是「思考档位 → CLI 真实模型 id」的映射。
 *
 * 为什么目录里要存它：agy 把每个档位当成独立模型列（`gemini-4-argon-high`），
 * 而界面要给用户看「Gemini 4 Argon + 档位选择」。合并后的条目只有家族 id，
 * 发请求时靠这张表换回真实 id——没有它，选哪个档位都会被 CLI 忽略。
 */
function normalizeVariants(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelError('request');
  const out = {};
  for (const [level, id] of Object.entries(value)) {
    const key = String(level).toLowerCase();
    if (!EFFORTS.includes(key)) throw new ModelError('request');
    const variant = normalizeModelId(id);
    if (variant) out[key] = variant;
  }
  return out;
}

/** 单个模型的严格校验：vision 必须是真 boolean（不像 providers.cjs 那样把脏值当 false 吞掉）。 */
function normalizeModel(input) {
  if (!input || typeof input !== 'object') throw new ModelError('request');
  const id = normalizeModelId(input.id);
  if (input.vision !== undefined && typeof input.vision !== 'boolean') throw new ModelError('request');
  const tokenLimit = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  };
  const variants = normalizeVariants(input.variants);
  // tactics: 有 variants 时 efforts 以 variants 的键为准（它们才是真的能发出去的档位）。
  const declared = normalizeEfforts(input.efforts);
  const efforts = Object.keys(variants).length
    ? EFFORTS.filter(level => variants[level])
    : declared;
  return {
    id,
    name: text(input.name, 80) || id,
    vision: input.vision === true,
    efforts,
    ...(Object.keys(variants).length ? { variants } : {}),
    contextWindow: tokenLimit(input.contextWindow, 1_000_000, 1_000, 10_000_000),
    maxTokens: tokenLimit(input.maxTokens, 128_000, 256, 1_000_000),
  };
}

/** 纯函数：整份模型列表的校验与规范化。保存路径与测试都走这一个入口。 */
function normalizeModels(list) {
  if (!Array.isArray(list)) throw new ModelError('request');
  if (list.length > MAX_MODELS) throw new ModelError('request');
  const seen = new Set();
  const models = list.map(item => {
    const model = normalizeModel(item);
    if (seen.has(model.id)) throw new ModelError('request');
    seen.add(model.id);
    return model;
  });
  return models;
}

/**
 * 读盘时的「抢救式」解析：单条坏数据丢掉，不让整份文件作废；但如果一条都救不回来
 * （说明这段数据根本不是模型数组），返回 null 让调用方回落到默认目录。
 */
function salvageModels(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const models = [];
  for (const item of list.slice(0, MAX_MODELS)) {
    try {
      const model = normalizeModel(item);
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    } catch {
      // 单条脏数据跳过即可，剩余条目仍然可用。
    }
  }
  if (list.length && !models.length) return null;
  return models;
}

function salvageDisplayName(value) {
  try { return normalizeDisplayName(value); } catch { return null; }
}

function summarize(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error ?? '');
  return (message || '探针失败').slice(0, 200);
}

// ── 存储层 ────────────────────────────────────────────────────────────────
/**
 * 注入 dir 与 fs 才能测：dir 可以是字符串（固定目录）也可以是函数（每次现算，
 * 因为 app.getPath 由外部注入，测试里每个用例换一个临时目录）。
 */
function createStore({ dir, fs } = {}) {
  const io = fs ?? { mkdir, readFile, rename, rm, writeFile };
  const resolveDir = typeof dir === 'function' ? dir : () => dir;

  function filePath() {
    const base = String(resolveDir() ?? '').trim();
    return base ? join(base, FILE_NAME) : '';
  }

  /** 读盘 → { state, recoveredFrom }。任何读不懂的情况都回落，且不抛：脏文件不该让整页打不开。 */
  async function readState() {
    const file = filePath();
    if (!file) return { state: null, recoveredFrom: 'missing' };
    let raw;
    try {
      raw = await io.readFile(file, 'utf8');
    } catch {
      // ENOENT 是首次使用；权限/占用等其它读失败也只能当「没有文件」处理，否则设置页直接白屏。
      return { state: null, recoveredFrom: 'missing' };
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { state: null, recoveredFrom: 'corrupt' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.version !== VERSION
      || !payload.providers || typeof payload.providers !== 'object' || Array.isArray(payload.providers)) {
      return { state: null, recoveredFrom: 'corrupt' };
    }
    // 目录内容升级：上一版写下的模型 id 已经不对了（比如占位用的 gpt-5.1-mini），
    // 整份换回新默认值。用户自己改过的显示名会一并回到默认——宁可在发版前纠正目录，
    // 也不能让用户点到一个必定 404 的模型 id。
    if (payload.catalogVersion !== CATALOG_VERSION) {
      return { state: null, recoveredFrom: 'catalog-upgrade' };
    }
    return { state: payload.providers, recoveredFrom: null };
  }

  /**
   * 旧目录迁移：上一版把 ACP 的每个档位当成独立模型存了进来
   * （`gemini-4-argon-low/medium/high` 三行）。新版按「家族 + variants」存，
   * 读盘时就地合并，**不重置用户改过的名字**（只合并 id 带档位后缀、且没有 variants 的条目）。
   */
  async function regroupStoredModels(target, models) {
    if (target !== 'gemini' || !Array.isArray(models) || models.length === 0) return models;
    const flat = models.some(model => !model.variants && /[-_](minimal|low|mid|medium|high|xhigh)$/i.test(model.id));
    if (!flat) return models;
    try {
      const { groupModels } = await import('./subscription/cli-models.mjs');
      const merged = groupModels(models.map(model => ({
        id: model.id,
        label: model.name,
        vision: model.vision,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })));
      // 合并后条数变少才有意义；否则原样返回，避免把用户自建的条目搅乱。
      return merged.length && merged.length < models.length ? merged : models;
    } catch {
      return models;
    }
  }

  /** 读目录：文件里缺哪一项就补默认值，所以「只存了 chatgpt」也能读出一份完整目录。 */
  async function readCatalog() {
    const { state, recoveredFrom } = await readState();
    const providers = {};
    for (const target of TARGETS) {
      const fallback = DEFAULT_CATALOG[target];
      const stored = state?.[target];
      if (!stored || typeof stored !== 'object') {
        providers[target] = cloneEntry(fallback);
        continue;
      }
      const models = salvageModels(stored.models) ?? fallback.models.map(cloneModel);
      providers[target] = {
        displayName: salvageDisplayName(stored.displayName) ?? fallback.displayName,
        models: await regroupStoredModels(target, models),
      };
    }
    return { providers, recoveredFrom: recoveredFrom ?? null };
  }

  async function readProvider(target) {
    const { providers } = await readCatalog();
    return cloneEntry(providers[requireTarget(target)]);
  }

  /**
   * 写盘前先留一份上一版。
   *
   * 为什么值得多一次拷贝：模型目录是**用户数据**，一次错误的整体覆盖（例如界面拿到了半份
   * 草稿就保存）会把 18 条目录直接缩成 3 条，而这份文件没有 git、没有回收站。
   * 备份失败不阻断写入——目录写不进去比没有备份更严重。
   */
  async function backupPrevious(file) {
    try {
      const previous = await io.readFile(file, 'utf8');
      if (typeof previous === 'string' && previous.trim()) {
        await io.writeFile(`${file}.bak`, previous, 'utf8');
      }
    } catch {
      // 首次使用没有文件，或者目录不可写：都不影响这次写入。
    }
  }

  /** 原子写：临时文件 + rename，mode 0o600，与 providers.cjs 的 writeState 同款。 */
  async function writeCatalog(providers) {
    const file = filePath();
    if (!file) throw new ModelError('credential');
    const temp = `${file}.${randomUUID()}.tmp`;
    // 只落 TARGETS 里有的键：files 里多出来的野键不该被带进正式文件。
    const payload = { version: VERSION, catalogVersion: CATALOG_VERSION, providers: {} };
    for (const target of TARGETS) payload.providers[target] = cloneEntry(providers?.[target] ?? DEFAULT_CATALOG[target]);
    try {
      await io.mkdir(dirname(file), { recursive: true });
      await backupPrevious(file);
      await io.writeFile(temp, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
      await io.rename(temp, file);
    } catch {
      // 写失败要把临时文件清掉，否则 userData 里会越攒越多半成品；对外统一报 credential
      // （沿用 providers.cjs 的错误约定，渲染层只认这几个 code）。
      await Promise.resolve().then(() => io.rm(temp, { force: true })).catch(() => {});
      throw new ModelError('credential');
    }
  }

  /** 部分更新：没给的字段保持存储层里的原值（用户只改名字时不能把模型列表清空）。 */
  async function saveProvider(target, patch = {}) {
    const key = requireTarget(target);
    if (!patch || typeof patch !== 'object') throw new ModelError('request');
    if (!Object.hasOwn(patch, 'displayName') && !Object.hasOwn(patch, 'models')) throw new ModelError('request');
    const { providers } = await readCatalog();
    const current = providers[key] ?? DEFAULT_CATALOG[key];
    const displayName = Object.hasOwn(patch, 'displayName')
      ? normalizeDisplayName(patch.displayName)
      : current.displayName;
    const models = Object.hasOwn(patch, 'models') ? normalizeModels(patch.models) : current.models;
    const next = { displayName, models };
    // 先校验完再落盘：任何一步抛错都不会留下半份文件（校验失败 = 磁盘保持原样）。
    await writeCatalog({ ...providers, [key]: next });
    return { provider: cloneEntry(next) };
  }

  async function resetProvider(target) {
    const key = requireTarget(target);
    const { providers } = await readCatalog();
    const next = cloneEntry(DEFAULT_CATALOG[key]);
    await writeCatalog({ ...providers, [key]: next });
    return { provider: next };
  }

  return { readCatalog, readProvider, saveProvider, resetProvider, filePath };
}

// ── 默认实例：目录由 configureUserDataDir 注入 ─────────────────────────────
let userDataDirResolver = null;
let defaultStore = null;

/** () => string：providers.cjs 在这里塞 app.getPath('userData')。 */
function configureUserDataDir(resolver) {
  userDataDirResolver = typeof resolver === 'function' ? resolver : null;
  // 目录换了就重建实例：文件路径每次现算，但实例留着也只是多一层无用缓存。
  defaultStore = null;
}

function store() {
  defaultStore ??= createStore({
    dir: () => (typeof userDataDirResolver === 'function' ? userDataDirResolver() : ''),
  });
  return defaultStore;
}

function readCatalog() {
  return store().readCatalog();
}

function readProvider(target) {
  return store().readProvider(target);
}

function saveProvider(target, patch) {
  return store().saveProvider(target, patch);
}

function resetProvider(target) {
  return store().resetProvider(target);
}

// ── 账号探针（登录态）─────────────────────────────────────────────────────
let accountProbe = null;
let accountCache = null; // { at, value }

/**
 * fn() => Promise<{ chatgpt: {configured,count,email}, gemini: {...} }>
 * 未注入时视为「全未配置」：没有探针不等于有账号，谎报已登录会让用户以为能直接聊天。
 */
function setAccountProbe(fn) {
  accountProbe = typeof fn === 'function' ? fn : null;
  accountCache = null; // 探针换了，旧结果立刻作废
}

function accountState() {
  if (accountCache && Date.now() - accountCache.at < ACCOUNT_CACHE_MS) {
    return Promise.resolve(cloneAccounts(accountCache.value));
  }
  return (async () => {
    const value = await runAccountProbe();
    accountCache = { at: Date.now(), value };
    return cloneAccounts(value);
  })();
}

async function runAccountProbe() {
  const fresh = emptyAccounts();
  if (typeof accountProbe !== 'function') return fresh;
  try {
    const raw = await accountProbe();
    for (const target of TARGETS) {
      const row = raw?.[target];
      if (!row || typeof row !== 'object') continue;
      const count = Math.max(0, Math.floor(Number(row.count) || 0));
      fresh[target] = {
        // 只要有一个可用的登录账号就算已配置；数量或显式标记任一成立即可。
        configured: row.configured === true || count > 0,
        count,
        email: typeof row.email === 'string' && row.email.trim() ? row.email.trim() : null,
      };
    }
    return fresh;
  } catch (error) {
    // 探针抛错 = 读不到登录态，不是「已登录」。记下原因给上层提示（设置页要能说清为什么是灰的），
    // 但绝不让异常冒上去把整个 providers:list 打挂。
    const note = summarize(error);
    const failed = emptyAccounts();
    for (const target of TARGETS) failed[target].error = note;
    return failed;
  }
}

// ── 模型探针（「获取可用模型」）─────────────────────────────────────────────
let modelProbe = null;

/** fn(target) => Promise<{ models, source?, note? }>；未注入时为 null（等于「没有可用的枚举通道」）。 */
function setModelProbe(fn) {
  modelProbe = typeof fn === 'function' ? fn : null;
}

/**
 * 「获取可用模型」：**绝不抛**。
 * 订阅通道的枚举能力随时可能缺失（CLI 没装、版本过旧、网络断），设置页不该因此整块报错——
 * 拿不到就退回「当前目录 + 一句说明」，用户至少还能手动加模型。
 */
async function discoverModels(value) {
  let target;
  try {
    target = requireTarget(value);
  } catch {
    return { models: [], source: 'builtin', note: '未知的订阅通道，无法枚举模型。' };
  }
  const stored = async () => {
    try {
      return (await readProvider(target)).models;
    } catch {
      return cloneEntry(DEFAULT_CATALOG[target]).models;
    }
  };
  if (typeof modelProbe === 'function') {
    try {
      const result = await modelProbe(target);
      const models = Array.isArray(result?.models)
        ? result.models.filter(model => model && typeof model === 'object' && typeof model.id === 'string' && model.id.trim())
        : [];
      if (models.length) {
        return {
          models: models.map(model => ({ ...model, efforts: Array.isArray(model.efforts) ? [...model.efforts] : [] })),
          source: 'probe',
          note: typeof result?.note === 'string' ? result.note.trim() : '',
        };
      }
    } catch (error) {
      // 探针报错：目录兜底 + 把原因（截断 200 字）带进 note，方便用户/日志定位。
      return { models: await stored(), source: 'builtin', note: `${BUILTIN_NOTE}（枚举失败：${summarize(error)}）` };
    }
  }
  return { models: await stored(), source: 'builtin', note: BUILTIN_NOTE };
}

module.exports = {
  TARGETS, EFFORTS, DEFAULT_CATALOG, CATALOG_VERSION,
  createStore,
  configureUserDataDir,
  readCatalog,
  readProvider,
  saveProvider,
  resetProvider,
  normalizeModels,
  setAccountProbe,
  accountState,
  setModelProbe,
  discoverModels,
};
