/**
 * 订阅账号凭据存储（单文件加密 JSON）。
 *
 * 负责：`subscriptions.enc` 的读取/解密、原子替换写入、进程内串行化、对外脱敏视图。
 * 不负责：加解密算法（safeStorage 由调用方注入）、额度、调度、OAuth 流程。
 * 被谁调用：subscription 服务层（登录落盘、刷新写回、登出删除、设置页列表）。
 *
 * 关键决策：
 * - 读到的 envelope 在内存里缓存，只有**落盘成功**才替换缓存，否则上层看到的一直是磁盘上的旧值。
 * - 所有写走同一条 promise 链：并发 read-modify-write 会丢更新，串行是最省心的正确做法。
 * - 解密失败/JSON 损坏一律抛 `credential`，绝不静默清空文件（否则用户要重新登录且无法诊断）。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PROVIDERS, SubscriptionError } from './contract.mjs';

const FILE_NAME = 'subscriptions.enc';
const VERSION = 1;

/** 绝不允许出现在对外视图里的字段（`key` 是旧 api_key 记录的令牌）。 */
export const SECRET_FIELDS = Object.freeze(['access', 'refresh', 'idToken', 'key']);

/** 对外账号视图字段（§5.2 的 AccountView 去掉 active/usage，后两者由 pool/usage 补）。 */
export const VIEW_FIELDS = Object.freeze([
  'provider', 'accountId', 'email', 'plan', 'state',
  'limitedUntil', 'expiresAt', 'createdAt', 'lastUsedAt', 'lastError',
]);

function emptyEnvelope() {
  return { version: VERSION, accounts: {} };
}

function keyOf(provider, accountId) {
  return `${provider}:${accountId}`;
}

/** safeStorage 的异步 API 返回 `{ result }`，同步接口直接返回原始值，这里统一拆包。 */
function unwrap(value) {
  if (value && typeof value === 'object' && 'result' in value) return value.result;
  return value;
}

/**
 * 单条记录的对外视图：白名单取字段，令牌字段根本不会出现。
 * 导出是给 pool 复用（它也要对外吐账号视图），纯函数、无副作用。
 */
export function maskAccount(record) {
  const view = {};
  if (!record || typeof record !== 'object') return view;
  for (const field of VIEW_FIELDS) {
    if (record[field] !== undefined) view[field] = record[field];
  }
  return view;
}

function requireProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new SubscriptionError('request', { detail: 'provider' });
  }
  return provider;
}

/**
 * @param {{
 *   dir: string,
 *   encrypt: (text: string) => Promise<unknown> | unknown,
 *   decrypt: (data: unknown) => Promise<unknown> | unknown,
 *   readFile: (path: string) => Promise<any>,
 *   writeFile: (path: string, data: any, options?: any) => Promise<any>,
 *   rename: (from: string, to: string) => Promise<any>,
 *   mkdir: (path: string, options?: any) => Promise<any>,
 *   rm: (path: string, options?: any) => Promise<any>,
 *   now?: () => number,
 * }} options
 */
export function createAccountStore({ dir, encrypt, decrypt, readFile, writeFile, rename, mkdir, rm, now } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new SubscriptionError('request', { detail: 'dir' });
  for (const [name, fn] of Object.entries({ encrypt, decrypt, readFile, writeFile, rename, mkdir, rm })) {
    if (typeof fn !== 'function') throw new SubscriptionError('request', { detail: name });
  }
  const clock = typeof now === 'function' ? now : Date.now;
  const path = join(dir, FILE_NAME);

  /** 解密后的 envelope 缓存；null 表示还没读过。 */
  let cache = null;
  /** 写链：保证 modify/upsert/remove 之间不会交错。 */
  let chain = Promise.resolve();

  async function load() {
    if (cache) return cache;
    let raw;
    try {
      raw = await readFile(path);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        cache = emptyEnvelope();
        return cache;
      }
      throw new SubscriptionError('credential', { detail: 'read', cause: error });
    }
    let text;
    try {
      text = unwrap(await decrypt(raw));
    } catch (error) {
      throw new SubscriptionError('credential', { detail: 'decrypt', cause: error });
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new SubscriptionError('credential', { detail: 'decrypt' });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SubscriptionError('credential', { detail: 'corrupt', cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.accounts
      || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
      throw new SubscriptionError('credential', { detail: 'corrupt' });
    }
    cache = { version: VERSION, accounts: { ...parsed.accounts } };
    return cache;
  }

  async function save(accounts) {
    const envelope = { version: VERSION, accounts };
    let payload;
    try {
      payload = unwrap(await encrypt(JSON.stringify(envelope)));
    } catch (error) {
      throw new SubscriptionError('credential', { detail: 'encrypt', cause: error });
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(temp, payload, { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      // 写/替换失败：清掉临时文件，缓存保持旧值，磁盘上仍是上一份完整数据。
      await Promise.resolve()
        .then(() => rm(temp, { force: true }))
        .catch(() => {});
      throw new SubscriptionError('credential', { detail: 'write', cause: error });
    }
    cache = envelope;
    return envelope;
  }

  /** 串行执行写任务；前一个任务失败不阻塞后续（否则一次写失败会永久卡住队列）。 */
  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function list(provider) {
    const id = requireProvider(provider);
    const envelope = await load();
    return Object.values(envelope.accounts)
      .filter(record => record && record.provider === id)
      .map(maskAccount)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
        || String(a.accountId).localeCompare(String(b.accountId)));
  }

  /** 内部用：返回**含令牌**的记录副本，只允许主进程消费；对外一律走 list()。 */
  async function read(provider, accountId) {
    const id = requireProvider(provider);
    const envelope = await load();
    const record = envelope.accounts[keyOf(id, accountId)];
    return record ? { ...record } : null;
  }

  async function upsert(provider, record) {
    const id = requireProvider(provider);
    if (!record || typeof record !== 'object' || typeof record.accountId !== 'string' || record.accountId.length === 0) {
      throw new SubscriptionError('request', { detail: 'accountId' });
    }
    return enqueue(async () => {
      const envelope = await load();
      const key = keyOf(id, record.accountId);
      const next = { ...(envelope.accounts[key] ?? {}), ...record, provider: id, accountId: record.accountId };
      if (typeof next.createdAt !== 'number') next.createdAt = clock();
      await save({ ...envelope.accounts, [key]: next });
      return { ...next };
    });
  }

  async function remove(provider, accountId) {
    const id = requireProvider(provider);
    return enqueue(async () => {
      const envelope = await load();
      const key = keyOf(id, accountId);
      if (!envelope.accounts[key]) return false;
      const accounts = { ...envelope.accounts };
      delete accounts[key];
      await save(accounts);
      return true;
    });
  }

  /**
   * 串行的读-改-写。`fn(record|null)` 返回值语义：
   * 对象 → 合并写回；`null` → 删除该账号；`undefined` → 不改不写（用于跳过）。
   */
  async function modify(provider, accountId, fn) {
    const id = requireProvider(provider);
    if (typeof fn !== 'function') throw new SubscriptionError('request', { detail: 'fn' });
    return enqueue(async () => {
      const envelope = await load();
      const key = keyOf(id, accountId);
      const current = envelope.accounts[key] ? { ...envelope.accounts[key] } : null;
      const next = await fn(current);
      if (next === undefined) return current;
      const accounts = { ...envelope.accounts };
      if (next === null) {
        if (!current) return null;
        delete accounts[key];
        await save(accounts);
        return null;
      }
      if (typeof next !== 'object') throw new SubscriptionError('request', { detail: 'modify' });
      // accountId/provider 由调用参数钉住：记录身份不可被 fn 改走，否则会留下孤儿键。
      const merged = { ...(current ?? {}), ...next, provider: id, accountId };
      if (typeof merged.createdAt !== 'number') merged.createdAt = clock();
      accounts[key] = merged;
      await save(accounts);
      return { ...merged };
    });
  }

  return {
    list,
    read,
    upsert,
    remove,
    modify,
    __testing: Object.freeze({ path, FILE_NAME, VERSION, VIEW_FIELDS, SECRET_FIELDS, maskAccount, keyOf, clearCache: () => { cache = null; } }),
  };
}
