/**
 * 服务版订阅数据层 + 凭据服务（多租户）。
 *
 * 负责：`subscription_credentials` / `subscription_events` / `subscription_flows` 的读写、
 *       AAD 绑定、对外脱敏视图、审计与过期清理。加解密走注入的 `cipher`（密钥来自
 *       `MOVA_SUBSCRIPTION_KEY`，见 §5.5），存储走注入的 `db.query`。
 * 不负责：OAuth 协议本身（授权 URL、换 token、验签、登录编排在 `subscription-login.mjs`，
 *       本模块只提供它要的一次性 flow 存取）、额度探针、调度选号、密钥读取。
 *       **不 import `electron`、不 import `pg`、不读 `process.env`**，所以主进程、worker、
 *       纯 `node --test` 都能直接跑（测试注入假 db / 假 cipher）。
 * 被谁调用：服务版登录回调（落库 / 删除）、请求构造方（取 token）、设置页列表（脱敏视图）、
 *       定时审计清理任务。
 *
 * 为什么 AAD 绑定租户与账号：数据库是共享的，能写 SQL 的人就能把 A 行密文换到 B 行。
 * AAD 参与 GCM 认证，换行即解不开——这是越权读的最后一道闸，比应用层 if 判断可靠。
 */
import { randomUUID } from 'node:crypto';

/**
 * flow 的默认存活时间 5 分钟（§4.3 / §6：`flowId` 一次性、5 分钟过期）。
 * 上限 15 分钟：再长就成了一次「免登录通行证」，回调地址一泄露就能被抢用。
 */
const DEFAULT_FLOW_TTL_MS = 300_000;
const MAX_FLOW_TTL_MS = 900_000;

/** AAD 分隔符。字段本身允许出现 `|` 属于已知限制：AAD 只做完整性绑定，不做解析。 */
const AAD_SEPARATOR = '|';
const DAY_MS = 86_400_000;
const MAX_ID_LENGTH = 200;
const MAX_DETAIL_DEPTH = 4;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;
const DEFAULT_RETENTION_DAYS = 30;

/** 审计 detail 里一律拒收的键（小写比较）：令牌与密钥不得进审计表。 */
const SECRET_KEYS = new Set([
  'access', 'accesstoken', 'access_token',
  'refresh', 'refreshtoken', 'refresh_token',
  'idtoken', 'id_token', 'token', 'secret', 'key', 'password',
  'verifier', 'code_verifier', 'ciphertext', 'clientsecret', 'client_secret',
]);

/** 对外视图的字段白名单：`listCredentials` / `putCredential` 只吐这些键。 */
export const VIEW_FIELDS = Object.freeze([
  'provider', 'accountId', 'email', 'plan', 'expiresAt', 'createdAt', 'lastUsedAt',
]);

/**
 * 全部 SQL 都写死在这里，便于审计：除了两个「按时间清理」的 delete（`pruneEvents` /
 * `pruneFlows`，只删不读），每条语句的 where 子句都同时带 `tenant_id` 与 `user_id`，
 * 不存在「只按 account_id / flow_id 查」的路径（§4.3、§17.2）。
 */
export const SQL = Object.freeze({
  upsertCredential: `insert into subscription_credentials (
  tenant_id, user_id, provider, account_id, ciphertext, email, plan, expires_at, created_at
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
on conflict (tenant_id, user_id, provider, account_id) do update set
  ciphertext = excluded.ciphertext,
  email = excluded.email,
  plan = excluded.plan,
  expires_at = excluded.expires_at
returning tenant_id, user_id, provider, account_id, email, plan, expires_at, created_at, last_used_at`,

  selectCredential: `select ciphertext, email, plan, expires_at, created_at, last_used_at
from subscription_credentials
where tenant_id = $1 and user_id = $2 and provider = $3 and account_id = $4`,

  // 故意不 select ciphertext：列表页永远不需要令牌，少读一次就少一次泄露面。
  listCredentials: `select provider, account_id, email, plan, expires_at, created_at, last_used_at
from subscription_credentials
where tenant_id = $1 and user_id = $2
order by created_at asc, provider asc, account_id asc`,

  deleteCredential: `delete from subscription_credentials
where tenant_id = $1 and user_id = $2 and provider = $3 and account_id = $4`,

  touchCredential: `update subscription_credentials
set last_used_at = $5
where tenant_id = $1 and user_id = $2 and provider = $3 and account_id = $4`,

  insertEvent: `insert into subscription_events (tenant_id, user_id, at, kind, provider, account_id, detail)
values ($1, $2, $3, $4, $5, $6, $7)
returning id, at, kind, provider, account_id, detail`,

  listEvents: `select id, at, kind, provider, account_id, detail
from subscription_events
where tenant_id = $1 and user_id = $2
order by at desc, id desc
limit $3`,

  // 唯一的全租户语句：保留期清理按时间扫，不按用户。它只删、不读、不返回内容。
  pruneEvents: 'delete from subscription_events where at < $1',

  // ---- subscription_flows（一次性登录流程，见 §4.3 / §5.5）----------------
  // 默认值（flow_id、created_at）由本模块显式写入而不是依赖 default：boundary 与 flowId
  // 都要能用注入的 now / newFlowId 钉死，测试才能断言过期边界。
  insertFlow: `insert into subscription_flows (
  flow_id, tenant_id, user_id, provider, state, verifier, created_at, expires_at
) values ($1, $2, $3, $4, $5, $6, $7, $8)`,

  selectFlow: `select flow_id, tenant_id, user_id, provider, state, verifier, created_at, expires_at
from subscription_flows
where tenant_id = $1 and user_id = $2 and flow_id = $3`,

  // 一次性语义靠 `delete ... returning`：读与删在同一条语句里完成，
  // 两个并发回调只可能有一个拿到行（另一个 rowCount=0），因此重放拿不到 verifier。
  consumeFlow: `delete from subscription_flows
where tenant_id = $1 and user_id = $2 and flow_id = $3
returning flow_id, tenant_id, user_id, provider, state, verifier, created_at, expires_at`,

  // 第二个全租户语句：过期 flow 由运维任务按时间删。与 pruneEvents 同理，只删不读。
  pruneFlows: 'delete from subscription_flows where expires_at <= $1',
});

/** 普通 Error + code：`request`（调用方参数错）/ `credential`（存储或解密失败）/ `forbidden`（越权迹象）。 */
function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function requireText(value, label) {
  if (typeof value !== 'string') throw coded('request', `${label} 必须是字符串`);
  const text = value.trim();
  if (text.length === 0) throw coded('request', `${label} 不能为空`);
  if (text.length > MAX_ID_LENGTH) throw coded('request', `${label} 过长`);
  return text;
}

function optionalText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw coded('request', `${label} 必须是字符串`);
  const text = value.trim();
  return text.length === 0 ? null : text;
}

/** 任意 ms / Date / ISO 串 → ISO 串；无法解析返回 null（用于读回的行，脏值不该让列表炸掉）。 */
function isoOf(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;
  if (typeof value === 'string' && value.length > 0) {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  return null;
}

/** 写入方向的时间参数：非法值必须报错，不能静默变成 null（否则过期判定会永久失效）。 */
function timestampParam(value, label) {
  if (value === undefined || value === null) return null;
  const iso = isoOf(value);
  if (iso === null) throw coded('request', `${label} 不是有效时间`);
  return iso;
}

/** 读取方向的时间参数：只用于「现在几点了」这类入参，非法值同样报错。 */
function timestampMs(value, label) {
  const iso = isoOf(value);
  if (iso === null) throw coded('request', `${label} 不是有效时间`);
  return Date.parse(iso);
}

/**
 * flow 行 → 对外的驼峰形状。`verifier` 会一起返回：调用方（登录编排）换 token 时必须用它，
 * 但它只在本模块内部流转，不要写日志、不要放进错误对象（§6 日志要求）。
 */
function flowFromRow(row) {
  return {
    flowId: row?.flow_id ?? null,
    tenantId: row?.tenant_id ?? null,
    userId: row?.user_id ?? null,
    provider: row?.provider ?? null,
    state: row?.state ?? null,
    verifier: row?.verifier ?? null,
    createdAt: isoOf(row?.created_at),
    expiresAt: isoOf(row?.expires_at),
  };
}

/**
 * 租户 + 用户：**唯一**的取参入口（列表、审计这类只按人查的语句用它）。
 * 归一化（trim）在这里做一次，AAD 与 where 子句都用归一化后的值——否则调用方多打一个
 * 空格就会出现「写进去的密文解不开」这种最难查的故障。
 */
function scopedOwner(input) {
  if (!isObject(input)) throw coded('request', '参数必须是对象');
  return {
    tenantId: requireText(input.tenantId, 'tenantId'),
    userId: requireText(input.userId, 'userId'),
  };
}

/** 身份四元组：凭据行与 AAD 都用它，少一个字段就立即抛 request。 */
function scopedIdentity(input) {
  const owner = scopedOwner(input);
  return {
    ...owner,
    provider: requireText(input.provider, 'provider'),
    accountId: requireText(input.accountId, 'accountId'),
  };
}

/**
 * AAD 构造（导出是契约的一部分：加密方在登录服务里，解密方在本模块，两边必须同式）。
 * 顺序固定，改顺序等于改 AAD，会让所有存量密文解不开。
 */
export function aadFor(identity) {
  const { tenantId, userId, provider, accountId } = scopedIdentity(identity);
  return [tenantId, userId, provider, accountId].join(AAD_SEPARATOR);
}

/** 密文必须是二进制：真实 cipher 返回 Buffer，假 cipher 可能给 Uint8Array。 */
function toCiphertext(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  throw coded('credential', 'cipher.encrypt 必须返回 Buffer');
}

/** 脱敏视图：白名单取值，令牌字段根本不存在，所以不存在「忘记删字段」的漏洞。 */
function viewFromRow(row) {
  return {
    provider: row?.provider ?? null,
    accountId: row?.account_id ?? null,
    email: row?.email ?? null,
    plan: row?.plan ?? null,
    expiresAt: isoOf(row?.expires_at),
    createdAt: isoOf(row?.created_at),
    lastUsedAt: isoOf(row?.last_used_at),
  };
}

function viewFromInput(identity, input) {
  return {
    provider: identity.provider,
    accountId: identity.accountId,
    email: optionalText(input.email, 'email'),
    plan: optionalText(input.plan, 'plan'),
    expiresAt: timestampParam(input.expiresAt, 'expiresAt'),
    createdAt: null,
    lastUsedAt: null,
  };
}

/**
 * 审计 detail 的清洗：只收纯 JSON 值，且拒收任何令牌键名。
 * 宁可让调用方报错，也不要把 access/refresh 写进审计表——那是长期明文留存。
 */
function sanitizeDetail(detail) {
  if (detail === undefined || detail === null) return {};
  if (!isObject(detail)) throw coded('request', 'detail 必须是对象');
  const seen = new Set();
  const walk = (value, depth, path) => {
    if (value === undefined || value === null) return null;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return value;
    if (type !== 'object') throw coded('request', `detail 含不可序列化的值：${path}`);
    if (depth >= MAX_DETAIL_DEPTH) throw coded('request', `detail 嵌套过深：${path}`);
    if (Array.isArray(value)) return value.map((item, index) => walk(item, depth + 1, `${path}[${index}]`));
    if (seen.has(value)) throw coded('request', `detail 含循环引用：${path}`);
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) throw coded('request', `detail.${key} 不允许写入审计`);
      out[key] = walk(item, depth + 1, `${path}.${key}`);
    }
    seen.delete(value);
    return out;
  };
  return walk(detail, 0, 'detail');
}

function affected(result) {
  const rowCount = Number(result?.rowCount);
  if (Number.isFinite(rowCount)) return rowCount;
  return Array.isArray(result?.rows) ? result.rows.length : 0;
}

/**
 * @param {object} options
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{rows?: object[], rowCount?: number}> }} options.db
 * @param {{ encrypt: (plaintext: string, aad: string) => Buffer | Promise<Buffer>,
 *           decrypt: (payload: Buffer, aad: string) => string | Promise<string> }} options.cipher
 * @param {() => number | Date} [options.now]
 */
export function createSubscriptionService({ db, cipher, now = Date.now, newFlowId = () => randomUUID() } = {}) {
  if (!isObject(db) || typeof db.query !== 'function') throw coded('request', 'db.query 必须是函数');
  if (!isObject(cipher) || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
    throw coded('request', 'cipher.encrypt/decrypt 必须是函数');
  }
  if (typeof now !== 'function') throw coded('request', 'now 必须是函数');
  if (typeof newFlowId !== 'function') throw coded('request', 'newFlowId 必须是函数');

  const query = db.query.bind(db);

  function nowMs() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(ms)) throw coded('request', 'now 返回值不是有效时间');
    return ms;
  }

  /** 服务端时间统一由注入的 now 决定：才能像测试那样把「30 天边界」钉死。 */
  const isoNow = () => new Date(nowMs()).toISOString();

  /** 存储失败一律收敛成 code:'credential'（detail 标明是 storage），上层只需认 code。 */
  async function run(sql, params) {
    try {
      const result = await query(sql, params);
      return result || {};
    } catch (error) {
      const failure = coded('credential', '订阅数据访问失败');
      failure.detail = 'storage';
      failure.cause = error;
      throw failure;
    }
  }

  function requireRecord(record) {
    if (!isObject(record)) throw coded('request', 'record 必须是对象');
    if (Object.keys(record).length === 0) throw coded('request', 'record 不能是空对象');
    return record;
  }

  /**
   * 落库：记录整体进密文，只有展示用的 email/plan/expiresAt 留在明文列。
   * 重新登录走 upsert：created_at 保持首次连接时间，last_used_at 不被登录动作刷新。
   */
  async function putCredential(input = {}) {
    const identity = scopedIdentity(input);
    const record = requireRecord(input.record);
    const aad = aadFor(identity);

    let plaintext;
    try {
      plaintext = JSON.stringify(record);
    } catch {
      throw coded('request', 'record 必须可 JSON 序列化');
    }

    let sealed;
    try {
      sealed = toCiphertext(await cipher.encrypt(plaintext, aad));
    } catch (error) {
      if (error?.code === 'credential') throw error;
      const failure = coded('credential', '凭据加密失败');
      failure.detail = 'encrypt';
      failure.cause = error;
      throw failure;
    }

    const params = [
      identity.tenantId,
      identity.userId,
      identity.provider,
      identity.accountId,
      sealed,
      optionalText(input.email, 'email'),
      optionalText(input.plan, 'plan'),
      timestampParam(input.expiresAt, 'expiresAt'),
      isoNow(),
    ];
    const result = await run(SQL.upsertCredential, params);
    const row = Array.isArray(result.rows) ? result.rows[0] : null;
    return row ? viewFromRow(row) : viewFromInput(identity, input);
  }

  /**
   * 取回**含令牌**的记录，只允许可信的请求构造方调用（不要直接转发给渲染层）。
   * 未登录该账号返回 null；AAD 不匹配 / 密文损坏 / 记录身份与行键不符一律抛错。
   */
  async function getCredential(input = {}) {
    const identity = scopedIdentity(input);
    const aad = aadFor(identity);
    const result = await run(SQL.selectCredential, [
      identity.tenantId, identity.userId, identity.provider, identity.accountId,
    ]);
    const row = Array.isArray(result.rows) ? result.rows[0] : null;
    if (!row) return null;

    let record;
    try {
      const plain = await cipher.decrypt(row.ciphertext, aad);
      if (typeof plain !== 'string' || plain.length === 0) {
        throw coded('credential', '凭据解密结果不是字符串');
      }
      record = JSON.parse(plain);
    } catch (error) {
      const failure = error?.code === 'credential' ? error : coded('credential', '凭据解密失败');
      if (failure.detail === undefined) failure.detail = 'decrypt';
      if (failure.cause === undefined) failure.cause = error;
      throw failure;
    }
    if (!isObject(record)) throw coded('credential', '凭据记录不是对象');

    // 纵深防御：AAD 已经保证密文没被换行，这里再核对记录自带的身份字段。
    // 命中说明有代码在跨账号搬运记录，属于越权迹象，用 forbidden 而不是 credential。
    if (typeof record.accountId === 'string' && record.accountId !== identity.accountId) {
      throw coded('forbidden', '凭据记录的 accountId 与请求不符');
    }
    if (typeof record.provider === 'string' && record.provider !== identity.provider) {
      throw coded('forbidden', '凭据记录的 provider 与请求不符');
    }

    return { record, ...viewFromRow(row) };
  }

  /** 脱敏列表：不含任何令牌字段，也不会 select ciphertext。 */
  async function listCredentials(input = {}) {
    const owner = scopedOwner(input);
    const result = await run(SQL.listCredentials, [owner.tenantId, owner.userId]);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return rows.map(viewFromRow);
  }

  /** 删除只删自己这一行：四个参数缺一不可。 */
  async function deleteCredential(input = {}) {
    const identity = scopedIdentity(input);
    const result = await run(SQL.deleteCredential, [
      identity.tenantId, identity.userId, identity.provider, identity.accountId,
    ]);
    return affected(result) > 0;
  }

  /** 记录「用过了」：调度与额度轮询都靠它判断活跃度。 */
  async function touchCredential(input = {}) {
    const identity = scopedIdentity(input);
    const result = await run(SQL.touchCredential, [
      identity.tenantId, identity.userId, identity.provider, identity.accountId, isoNow(),
    ]);
    return affected(result) > 0;
  }

  /** 审计写入。detail 已脱敏是调用方的责任，这里再做一次键名清洗兜底。 */
  async function recordEvent(input = {}) {
    const owner = scopedOwner(input);
    const kind = requireText(input.kind, 'kind');
    const provider = optionalText(input.provider, 'provider');
    const accountId = optionalText(input.accountId, 'accountId');
    const at = isoNow();
    const detail = sanitizeDetail(input.detail);

    const result = await run(SQL.insertEvent, [
      owner.tenantId, owner.userId, at, kind, provider, accountId, JSON.stringify(detail),
    ]);
    const row = Array.isArray(result.rows) ? result.rows[0] : null;
    return {
      id: row?.id === undefined || row?.id === null ? null : Number(row.id),
      at: isoOf(row?.at) ?? at,
      kind: row?.kind ?? kind,
      provider: row?.provider ?? provider,
      accountId: row?.account_id ?? accountId,
      detail: row?.detail ?? detail,
    };
  }

  /** 审计回放：按时间倒序，limit 硬上限 500，防止一次把整年日志拉进内存。 */
  async function listEvents(input = {}) {
    const owner = scopedOwner(input);
    let limit = DEFAULT_EVENT_LIMIT;
    if (input.limit !== undefined && input.limit !== null) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw coded('request', 'limit 必须是正整数');
      limit = Math.min(input.limit, MAX_EVENT_LIMIT);
    }
    const result = await run(SQL.listEvents, [owner.tenantId, owner.userId, limit]);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return rows.map(row => ({
      id: row.id === undefined || row.id === null ? null : Number(row.id),
      at: isoOf(row.at),
      kind: row.kind ?? null,
      provider: row.provider ?? null,
      accountId: row.account_id ?? null,
      detail: row.detail ?? null,
    }));
  }

  /**
   * 保留期清理：边界 = now - olderThanDays*86400000，用注入的 now 计算，所以测试能精确断言。
   * 跨租户语句之一（运维任务按时间删），只删不读；另一条是 pruneFlows。
   */
  async function pruneEvents({ olderThanDays = DEFAULT_RETENTION_DAYS } = {}) {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw coded('request', 'olderThanDays 必须是非负数');
    }
    const before = new Date(nowMs() - olderThanDays * DAY_MS).toISOString();
    const result = await run(SQL.pruneEvents, [before]);
    return { olderThanDays, before, deleted: affected(result) };
  }

  // -------------------------------------------------------------------------
  // subscription_flows：一次性 OAuth 登录流程（§4.3 / §5.5）
  // -------------------------------------------------------------------------

  /**
   * 落一条 flow。`verifier` 只在服务端内存/库里出现，绝不进 URL 或日志（§6）。
   * `expires_at` 由注入的 now 算，所以「5 分钟过期」在测试里是确定的边界而不是概率。
   */
  async function createFlow(input = {}) {
    const owner = scopedOwner(input);
    const provider = requireText(input.provider, 'provider');
    const state = requireText(input.state, 'state');
    const verifier = optionalText(input.verifier, 'verifier');
    const ttlMs = input.ttlMs === undefined || input.ttlMs === null ? DEFAULT_FLOW_TTL_MS : input.ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_FLOW_TTL_MS) {
      throw coded('request', `ttlMs 必须是 1..${MAX_FLOW_TTL_MS} 的整数`);
    }

    const flowId = newFlowId();
    if (typeof flowId !== 'string' || flowId.trim().length === 0) {
      throw coded('request', 'newFlowId 必须返回非空字符串');
    }
    const createdAt = isoNow();
    const expiresAt = new Date(nowMs() + ttlMs).toISOString();
    await run(SQL.insertFlow, [
      flowId.trim(), owner.tenantId, owner.userId, provider, state, verifier, createdAt, expiresAt,
    ]);
    return { flowId: flowId.trim() };
  }

  /**
   * 读一条 flow：过期即返回 null（不返回「已过期但还能用」的行，避免调用方忘记判过期）。
   * 必须同时带 tenant 与 user：光有 flowId 的调用方拿不到别人的 flow。
   */
  async function getFlow(input = {}) {
    const owner = scopedOwner(input);
    const flowId = requireText(input.flowId, 'flowId');
    const result = await run(SQL.selectFlow, [owner.tenantId, owner.userId, flowId]);
    const row = Array.isArray(result.rows) ? result.rows[0] : null;
    if (!row) return null;
    const expiresAt = isoOf(row.expires_at);
    // 过期判定用注入的 now；脏时间按过期处理（fail closed）。
    if (expiresAt === null || Date.parse(expiresAt) <= nowMs()) return null;
    return flowFromRow(row);
  }

  /**
   * 一次性取走：`delete ... returning` 让「读」和「删」在同一个语句里完成，
   * 并发/重放的第二方只会拿到空结果（rowCount=0 → null），拿不到 verifier。
   * 拿到行但已过期时同样返回 null——行已经删掉，等于顺手清了一次过期数据。
   */
  async function consumeFlow(input = {}) {
    const owner = scopedOwner(input);
    const flowId = requireText(input.flowId, 'flowId');
    const result = await run(SQL.consumeFlow, [owner.tenantId, owner.userId, flowId]);

    // 假 db / 某些驱动只回 rowCount 不回 rows 时，不能把「删掉了但没告诉我内容」当成成功。
    const row = Array.isArray(result.rows) ? result.rows[0] : null;
    if (!row) return null;
    const expiresAt = isoOf(row.expires_at);
    if (expiresAt === null || Date.parse(expiresAt) <= nowMs()) return null;
    return flowFromRow(row);
  }

  /**
   * 清理过期 flow：边界 = 注入的 now（或显式传入的 now），`expires_at <= 边界` 全删。
   * 第二个（也是最后一个）跨租户语句，只删不读。
   */
  async function pruneFlows(input = {}) {
    const at = input.now === undefined || input.now === null ? nowMs() : timestampMs(input.now, 'now');
    const before = new Date(at).toISOString();
    const result = await run(SQL.pruneFlows, [before]);
    return { before, deleted: affected(result) };
  }

  return {
    putCredential,
    getCredential,
    listCredentials,
    deleteCredential,
    touchCredential,
    recordEvent,
    listEvents,
    pruneEvents,
    createFlow,
    getFlow,
    consumeFlow,
    pruneFlows,
  };
}
