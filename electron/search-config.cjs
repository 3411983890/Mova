'use strict';

// 搜索设置的唯一读写入口：userData/search-config.json。
// 只保存「开关 / 深度 / 语言 / 额度」，密钥一律走 model-credentials.cjs 的加密文件，
// 任何路径都不会把密钥写进这个 JSON，也不会回传给渲染层。
const { app } = require('electron');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { ModelError } = require('./local-model.cjs');

const DEPTHS = ['fast', 'standard', 'deep'];
const ZONES = ['auto', 'cn', 'intl'];
const LANGUAGES = ['auto', 'zh-CN', 'en'];

// 顺序即 UI 顺序与默认优先级（与 electron/search/providers.cjs 的 ORDER 保持一致）。
const PROVIDERS = [
  { id: 'anysearch', label: 'AnySearch', enabled: true, hasExtract: true },
  { id: 'tavily', label: 'Tavily', enabled: false, hasExtract: false },
  { id: 'searxng', label: 'SearXNG', enabled: false, hasExtract: false },
];

const PROVIDER_IDS = PROVIDERS.map(provider => provider.id);

/** 额度范围：过小的值会让检索直接不可用，过大的值失去保护意义。 */
const LIMIT_RANGES = {
  queries: { min: 1, max: 30, fallback: 12 },
  reads: { min: 0, max: 12, fallback: 8 },
  chars: { min: 1000, max: 400_000, fallback: 120_000 },
  ms: { min: 5_000, max: 180_000, fallback: 60_000 },
};

const DEFAULT_LIMITS = Object.fromEntries(
  Object.entries(LIMIT_RANGES).map(([key, range]) => [key, range.fallback]),
);

const MAX_BASE_URL = 300;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * SearXNG 地址：只接受 http(s)、不带凭据/查询/哈希的地址，去掉结尾斜杠。
 * 空值表示「还没有配置」。非法地址必须报错，否则用户会以为已经生效。
 */
function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.length > MAX_BASE_URL) throw new ModelError('SearXNG 地址过长（最多 300 字）');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ModelError('SearXNG 地址不是合法链接');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelError('SearXNG 地址必须是不带账号与参数的 http(s) 链接');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function normalizeProviders(input) {
  const source = isRecord(input) ? input : {};
  const providers = {};
  for (const meta of PROVIDERS) {
    const row = isRecord(source[meta.id]) ? source[meta.id] : {};
    providers[meta.id] = {
      enabled: typeof row.enabled === 'boolean' ? row.enabled : meta.enabled,
      ...(meta.id === 'searxng' ? { baseUrl: normalizeBaseUrl(row.baseUrl) } : {}),
    };
  }
  return providers;
}

function normalizeLimits(input) {
  const source = isRecord(input) ? input : {};
  const limits = {};
  for (const [key, range] of Object.entries(LIMIT_RANGES)) {
    limits[key] = clampInt(source[key], range.min, range.max, range.fallback);
  }
  return limits;
}

/** 任何输入都能得到一份可用配置：坏字段回退默认值，未知字段直接丢弃。 */
function normalizeConfig(input) {
  const source = isRecord(input) ? input : {};
  return {
    depth: oneOf(source.depth, DEPTHS, 'standard'),
    zone: oneOf(source.zone, ZONES, 'auto'),
    language: oneOf(source.language, LANGUAGES, 'auto'),
    providers: normalizeProviders(source.providers),
    limits: normalizeLimits(source.limits),
  };
}

/** patch 只覆盖它带上的字段；providers / limits 按源、按项合并。 */
function mergeConfig(base, patch) {
  const current = normalizeConfig(base);
  if (!isRecord(patch)) return current;
  const next = { ...current };
  if (patch.depth !== undefined) next.depth = patch.depth;
  if (patch.zone !== undefined) next.zone = patch.zone;
  if (patch.language !== undefined) next.language = patch.language;
  if (isRecord(patch.providers)) {
    next.providers = {};
    for (const meta of PROVIDERS) {
      const row = isRecord(patch.providers[meta.id]) ? patch.providers[meta.id] : {};
      next.providers[meta.id] = { ...current.providers[meta.id], ...row };
    }
  }
  if (isRecord(patch.limits)) next.limits = { ...current.limits, ...patch.limits };
  return next;
}

async function writeAtomic(file, payload) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, payload, { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => {});
    throw new ModelError('无法保存搜索设置');
  }
}

/**
 * 配置仓库。filePath 可注入（测试用临时目录）；默认落在 userData 下。
 * 读取永不抛错：文件损坏时返回默认值，避免一个坏 JSON 让联网搜索整体不可用。
 * @param {{ filePath?: string }} [options]
 */
function createSearchConfigStore({ filePath } = {}) {
  const resolveFile = () => (typeof filePath === 'string' && filePath
    ? filePath
    : join(app.getPath('userData'), 'search-config.json'));
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  async function read() {
    let raw;
    try {
      raw = await readFile(resolveFile(), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeConfig(null);
      throw new ModelError('无法读取搜索设置');
    }
    try {
      return normalizeConfig(JSON.parse(raw));
    } catch {
      return normalizeConfig(null);
    }
  }

  function save(patch) {
    const work = queue.then(async () => {
      const base = await read();
      const config = normalizeConfig(mergeConfig(base, patch));
      await writeAtomic(resolveFile(), JSON.stringify(config, null, 2));
      return config;
    });
    queue = work.catch(() => {});
    return work;
  }

  return { read, save, filePath: resolveFile };
}

/**
 * 给渲染层的形状：配置 + 每个源的「是否已配置 / 是否启用 / 能否读正文」。
 * configured 由 IPC 用加密凭据算出来，这里只接收布尔值，永远不会碰到 key 本身。
 */
function configSnapshot(config, flags) {
  const current = normalizeConfig(config);
  const source = isRecord(flags) ? flags : {};
  const providers = PROVIDERS.map(meta => ({
    id: meta.id,
    label: meta.label,
    configured: source[meta.id] === true,
    enabled: current.providers[meta.id].enabled === true,
    hasExtract: meta.hasExtract,
    ...(meta.id === 'searxng' ? { baseUrl: current.providers.searxng.baseUrl } : {}),
  }));
  return {
    depth: current.depth,
    zone: current.zone,
    language: current.language,
    providers,
    limits: current.limits,
  };
}

const searchConfig = createSearchConfigStore();

module.exports = {
  DEPTHS,
  ZONES,
  LANGUAGES,
  PROVIDERS,
  PROVIDER_IDS,
  DEFAULT_LIMITS,
  normalizeConfig,
  normalizeBaseUrl,
  mergeConfig,
  createSearchConfigStore,
  configSnapshot,
  searchConfig,
};
