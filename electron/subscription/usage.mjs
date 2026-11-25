/**
 * 额度读取与归一（§8.1–8.4）。
 *
 * 负责：把 ChatGPT `wham/usage` 与 Gemini `retrieveUserQuotaSummary` 的返回拍平成
 * `UsageSnapshot`（§5.3），并把重置时间写成人话。
 * 不负责：调度（pool）、缓存与退避节奏（服务层）、UI 排序（页面按 session→weekly→其他）。
 * 被谁调用：subscription 服务层的额度刷新任务；pool 只借用 `describeReset` 拼错误提示。
 *
 * 关键决策：网络全部注入 `fetch`，探针**永不抛错**——读不到就返回带 `reason` 的空快照，
 * 让 UI 显示 unknown/stale 而不是把整个设置页拖崩。
 */

const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** 两个 host 都要问：老账号只在 cloudcode-pa 有数据，新账号只在 daily 有。 */
const GEMINI_HOSTS = Object.freeze([
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]);
/** 官方客户端 UA：不带它上游不会按订阅口径计量（§7.3）。 */
const GEMINI_USER_AGENT = 'antigravity/hub/1.18.0 (aidev_client; os_type=windows; arch=x64; cl=1)';
const DAY_MS = 86_400_000;

/** 免费/Go 档的主窗口是月窗口，付费档是 5 小时。 */
const FREE_PLANS = new Set(['free', 'go', 'free_go', 'go_free']);
const KNOWN_WINDOWS = new Map([
  [300, { id: 'session', label: '5 小时窗口' }],
  [10080, { id: 'weekly', label: '每周窗口' }],
  [43200, { id: 'monthly', label: '每月窗口' }],
]);
const WINDOW_RANK = new Map([['session', 0], ['weekly', 1], ['monthly', 2]]);

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 上游的时间既有秒级 epoch 也有 ISO 字符串，统一成 ms。 */
function toMillis(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return undefined;
}

function nameForDuration(mins) {
  const known = KNOWN_WINDOWS.get(mins);
  if (known) return known;
  if (mins % 1440 === 0) return { id: `window-${mins / 1440}d`, label: `${mins / 1440} 天窗口` };
  if (mins % 60 === 0) return { id: `window-${mins / 60}h`, label: `${mins / 60} 小时窗口` };
  return { id: `window-${mins}m`, label: `${mins} 分钟窗口` };
}

function rankOf(id) {
  return WINDOW_RANK.has(id) ? WINDOW_RANK.get(id) : 3;
}

function compareWindows(a, b) {
  const diff = rankOf(a.id) - rankOf(b.id);
  if (diff !== 0) return diff;
  const aReset = Number.isFinite(a.resetsAt) ? a.resetsAt : Number.MAX_SAFE_INTEGER;
  const bReset = Number.isFinite(b.resetsAt) ? b.resetsAt : Number.MAX_SAFE_INTEGER;
  return aReset - bReset || String(a.id).localeCompare(String(b.id));
}

function defaultDurationMins(plan, position) {
  if (FREE_PLANS.has(String(plan ?? '').toLowerCase())) return position === 'primary' ? 43200 : 10080;
  return position === 'primary' ? 300 : 10080;
}

function normalizeResetCredits(payload) {
  const source = payload?.rate_limit_reset_credits ?? payload?.reset_credits ?? payload?.credits;
  if (!source || typeof source !== 'object') return undefined;
  const list = Array.isArray(source) ? source : Array.isArray(source.credits) ? source.credits : null;
  if (!list) {
    const count = Number(source.available_count ?? source.availableCount);
    if (!Number.isFinite(count)) return undefined;
    const next = toMillis(source.next_expires_at ?? source.nextExpiresAt);
    return { availableCount: Math.max(0, Math.trunc(count)), ...(next ? { nextExpiresAt: next } : {}) };
  }
  const expiries = list.map(item => toMillis(item?.expires_at ?? item?.expiresAt)).filter(value => Number.isFinite(value));
  return {
    availableCount: list.length,
    ...(expiries.length > 0 ? { nextExpiresAt: Math.min(...expiries) } : {}),
  };
}

/** 单个 wham 窗口 → UsageSnapshot.windows 项；返回 null 表示这条不该进主列表。 */
function chatgptWindow(window, { plan, position, checkedAt }) {
  if (!window || typeof window !== 'object') return null;
  const limitId = window.limit_id ?? window.limitId;
  // 模型级限额（如 gpt-5-codex 之外的 lab 限额）不代表账号总额度，§8.1 要求不进主列表。
  if (limitId !== undefined && limitId !== null && limitId !== 'codex') return null;
  const rawSeconds = Number(window.limit_window_seconds ?? window.limitWindowSeconds ?? window.window_seconds);
  const hasSeconds = Number.isFinite(rawSeconds) && rawSeconds > 0;
  const usedPercent = clampPercent(Number(window.used_percent ?? window.usedPercent ?? window.usage_percent));
  if (usedPercent === null) return null;
  const durationMins = hasSeconds ? Math.round(rawSeconds / 60) : defaultDurationMins(plan, position);
  const named = nameForDuration(durationMins);
  const absolute = toMillis(window.reset_at ?? window.resets_at ?? window.resetsAt);
  const afterSeconds = Number(window.reset_after_seconds ?? window.resetAfterSeconds);
  const resetsAt = absolute ?? (Number.isFinite(afterSeconds) && afterSeconds > 0 ? checkedAt + afterSeconds * 1000 : undefined);
  return {
    id: named.id,
    label: named.label,
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    windowDurationMins: durationMins,
  };
}

/**
 * `/backend-api/wham/usage` → UsageSnapshot。
 * `primary/secondary` 只是位置，真实周期看 `limit_window_seconds`。
 */
export function normalizeChatgptUsage(payload) {
  const checkedAt = Number.isFinite(payload?.checkedAt) ? payload.checkedAt : Date.now();
  const plan = typeof payload?.plan_type === 'string' ? payload.plan_type : undefined;
  const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? null;
  const windows = [];
  if (rateLimit && typeof rateLimit === 'object') {
    const positions = [
      ['primary', rateLimit.primary_window ?? rateLimit.primaryWindow],
      ['secondary', rateLimit.secondary_window ?? rateLimit.secondaryWindow],
    ];
    for (const [position, window] of positions) {
      const normalized = chatgptWindow(window, { plan, position, checkedAt });
      if (normalized) windows.push(normalized);
    }
  }
  const resetCredits = normalizeResetCredits(payload);
  const extra = { ...(plan ? { plan } : {}), ...(resetCredits ? { resetCredits } : {}) };
  if (windows.length === 0) return { checkedAt, ...extra, windows: [], reason: 'unsupported' };
  windows.sort(compareWindows);
  return { checkedAt, ...extra, windows };
}

function extractBuckets(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const candidates = [payload.buckets, payload.quotaBuckets, payload.quota_buckets, payload.summary?.buckets, payload.summary];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate;
  return [];
}

function bucketIdOf(bucket) {
  return String(bucket?.bucketId ?? bucket?.bucket_id ?? bucket?.id ?? '');
}

function bucketWindowOf(bucket) {
  const raw = String(bucket?.window ?? bucket?.windowId ?? bucket?.period ?? '').toLowerCase();
  if (raw === '5h' || raw === '5_hour' || raw === 'session' || raw === 'five_hour') return 'session';
  if (raw === 'weekly' || raw === '7d' || raw === 'week') return 'weekly';
  return raw || '';
}

/** bucketId → 家族（§8.2 的四类归类；认不出的一律不进主列表）。 */
function classifyBucket(bucketId) {
  // `3p-*` 是上游在这个账号下额外报的第三方模型用量。它**不代表** Mova 里 ChatGPT 套餐
  // 与 Gemini 套餐共享额度（两者完全独立），所以标签只描述「这是第三方模型」，不做跨套餐暗示。
  if (bucketId.startsWith('3p-')) return { family: 'shared', base: '第三方模型额度' };
  if (bucketId.startsWith('gemini-argon-')) return { family: 'gemini-argon', base: 'Gemini Argon' };
  if (bucketId.startsWith('gemini-carbon-')) return { family: 'gemini-carbon', base: 'Gemini Carbon' };
  if (bucketId.startsWith('gemini-')) return { family: 'gemini', base: 'Gemini' };
  return null;
}

function geminiWindowId(family, window) {
  if (family === 'shared') return '3p-shared';
  const suffix = window === 'session' ? '5h' : window || 'other';
  if (family === 'gemini') return suffix === '5h' ? 'gemini-5h' : `gemini-${suffix}`;
  return `${family}-${suffix}`;
}

const WINDOW_LABEL = { session: '5 小时窗口', weekly: '每周窗口', monthly: '每月窗口' };

/**
 * `retrieveUserQuotaSummary`（两个 host 合并后）→ UsageSnapshot。
 * 合并规则：按 bucketId 去重，谁先给出有效 `usedPercent` 就用谁（daily 优先）。
 */
export function normalizeGeminiSummary(payload, requestedAt) {
  const checkedAt = Number.isFinite(requestedAt) ? requestedAt : Date.now();
  const merged = new Map();
  for (const bucket of extractBuckets(payload)) {
    const bucketId = bucketIdOf(bucket);
    if (!bucketId) continue;
    const family = classifyBucket(bucketId);
    if (!family) continue;
    const window = bucketWindowOf(bucket);
    // 同一个 bucket 会同时有 5h 与 weekly 两条；跨 host 的重复才要合并，窗口不同不能互相盖掉。
    const mergeKey = `${bucketId}|${window}`;
    if (merged.has(mergeKey)) continue;
    const usedPercent = clampPercent(Number(bucket?.usedPercent ?? bucket?.used_percent ?? bucket?.usage?.usedPercent));
    if (usedPercent === null) continue;
    const resetsAt = toMillis(bucket?.resetsAt ?? bucket?.resets_at ?? bucket?.resetTime ?? bucket?.reset_time);
    merged.set(mergeKey, {
      id: geminiWindowId(family.family, window),
      label: family.family === 'shared' ? family.base : `${family.base} · ${WINDOW_LABEL[window] ?? '额度'}`,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(window === 'session' ? { windowDurationMins: 300 } : window === 'weekly' ? { windowDurationMins: 10080 } : {}),
    });
  }
  const windows = [...merged.values()].sort(compareWindows);
  if (windows.length === 0) return { checkedAt, windows: [], reason: 'unsupported' };
  return { checkedAt, windows };
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * ChatGPT 额度探针。`accountId` 是本机稳定 id，不能直接当 `chatgpt-account-id`，
 * 只有传入的 id 本身是 uuid（即上游 account id）或显式给了 `chatgptAccountId` 才带这个头。
 */
export async function probeChatgpt({ fetch, accessToken, accountId, chatgptAccountId, now = Date.now } = {}) {
  const checkedAt = now();
  if (typeof fetch !== 'function' || typeof accessToken !== 'string' || accessToken.length === 0) {
    return { checkedAt, windows: [], reason: 'probeFailed', detail: 'no_token' };
  }
  const upstreamAccountId = chatgptAccountId ?? (isUuid(accountId) ? accountId : undefined);
  try {
    const response = await fetch(CHATGPT_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'openai-beta': 'codex-1',
        originator: 'Mova',
        accept: 'application/json',
        ...(upstreamAccountId ? { 'chatgpt-account-id': upstreamAccountId } : {}),
      },
    });
    // detail 只带状态码/分类，不带响应体：排查「上游读不到额度」时，401 和 404 的处理完全不同，
    // 而以前两者都收敛成一句 probeFailed，日志里什么也看不出来。
    if (!response) return { checkedAt, windows: [], reason: 'probeFailed', detail: 'no_response' };
    if (!response.ok) {
      void response.body?.cancel?.().catch?.(() => {});
      return { checkedAt, windows: [], reason: 'probeFailed', detail: `http_${response.status}` };
    }
    const payload = await response.json();
    return normalizeChatgptUsage({ ...payload, checkedAt });
  } catch (error) {
    return { checkedAt, windows: [], reason: 'probeFailed', detail: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function googleAccessToken({ fetch, refreshToken, clientId, clientSecret }) {
  if (!refreshToken || !clientId || !clientSecret) return null;
  try {
    const response = await fetch(GEMINI_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!response || !response.ok) return null;
    const payload = await response.json();
    return typeof payload?.access_token === 'string' && payload.access_token.length > 0 ? payload.access_token : null;
  } catch {
    return null;
  }
}

async function quotaSummary({ fetch, host, access, projectId }) {
  try {
    const response = await fetch(`${host}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        'user-agent': GEMINI_USER_AGENT,
        accept: 'application/json',
      },
      body: JSON.stringify({ project: projectId }),
    });
    if (!response || !response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Gemini 额度探针：两个 host 都问，按 bucketId 合并；缺 project 直接 `noProject`。 */
export async function probeGemini({ fetch, refreshToken, clientId, clientSecret, projectId, now = Date.now } = {}) {
  const checkedAt = now();
  if (!projectId) return { checkedAt, windows: [], reason: 'noProject' };
  if (typeof fetch !== 'function') return { checkedAt, windows: [], reason: 'probeFailed' };
  const access = await googleAccessToken({ fetch, refreshToken, clientId, clientSecret });
  if (!access) return { checkedAt, windows: [], reason: 'probeFailed' };
  const buckets = [];
  let answered = 0;
  for (const host of GEMINI_HOSTS) {
    const payload = await quotaSummary({ fetch, host, access, projectId });
    if (!payload) continue;
    answered += 1;
    buckets.push(...extractBuckets(payload));
  }
  if (answered === 0) return { checkedAt, windows: [], reason: 'probeFailed' };
  const snapshot = normalizeGeminiSummary({ buckets }, checkedAt);
  if (snapshot.windows.length === 0) return { ...snapshot, reason: 'unsupported' };
  return snapshot;
}

const WEEKDAYS_ZH = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
const WEEKDAYS_EN = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

/**
 * 「2 小时 10 分后重置」/「周日 09:00 重置」（§8.4）。
 * 24 小时外必须落到具体星期与时刻，否则用户无法判断什么时候能继续用。
 * 返回 '' 表示没有可展示的时间（缺失或已过去）。
 */
export function describeReset(resetsAt, now = Date.now(), locale = 'zh-CN') {
  const at = Number(resetsAt);
  const base = Number(now);
  if (!Number.isFinite(at) || !Number.isFinite(base)) return '';
  const delta = at - base;
  if (delta <= 0) return '';
  const english = String(locale).toLowerCase().startsWith('en');
  if (delta < DAY_MS) {
    // 分钟向上取整：还剩 20 秒也要说「1 分后」，不能显示「0 分」。
    const totalMinutes = Math.max(1, Math.ceil(delta / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (english) {
      if (hours > 0 && minutes > 0) return `resets in ${hours}h ${minutes}m`;
      if (hours > 0) return `resets in ${hours}h`;
      return `resets in ${minutes}m`;
    }
    if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分后重置`;
    if (hours > 0) return `${hours} 小时后重置`;
    return `${minutes} 分后重置`;
  }
  const date = new Date(at);
  const weekday = (english ? WEEKDAYS_EN : WEEKDAYS_ZH)[date.getDay()];
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return english ? `${weekday} ${time}` : `${weekday} ${time} 重置`;
}
