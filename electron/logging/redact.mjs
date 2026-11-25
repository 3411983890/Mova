/**
 * 日志脱敏：所有出站记录都必须先过这一层，凭据类信息一律不准落盘。
 *
 * 为什么放在唯一写入口，而不是让每个调用点自己注意：
 * 调用点太多（providers / subscription / model-ipc / browser / desktop…），靠自觉必然会漏；
 * 把 redact 挂在 logger 的 emit 上，以后新增日志代码就不可能绕过它。
 *
 * 设计取舍（都是有代价的选择，记在这里免得以后被「优化」掉）：
 * - 键名先归一化再比对（`x-api-key` → `xapikey`）：调用方写 Authorization / authorization /
 *   X-Api-Key 都能命中，不用维护大小写与连字符变体。
 * - `code` / `state` 只在 URL 查询串里脱敏，不做通用键名规则：
 *   `error.code` 是排查报错的关键（ECONNREFUSED、ENOENT…），吃掉它等于把日志废掉一半。
 * - number / boolean 一律原样通过：durationMs、status、statusCode、retry 这些是排查主力，
 *   脱敏不能顺手把数字变成 [redacted]。
 * - 邮箱保留域名，只截断本地部分：需要知道「是哪个账号」，但不需要完整地址。
 * - 整个函数不抛异常：日志系统本身绝不能成为新的故障点（getter 抛错就记 [unserializable]）。
 */

/** 没有可保留信息时的占位。 */
const FULLY_REDACTED = '[redacted]';

/** 递归深度上限：日志里的对象偶尔是整棵设置树，深挖只会拖慢 emit。 */
const DEFAULT_MAX_DEPTH = 6;

/**
 * 键名归一化：大小写、连字符、下划线都不敏感。
 * `set-cookie` / `setCookie` / `SET_COOKIE` 都收敛成 `setcookie`。
 */
export function normalizeKey(key) {
  return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 值一定是凭据的键：命中后整值替换，不看内容。
 * 这里只放「名字本身就说明它是秘密」的键；`code`/`state` 见文件头说明。
 */
const SECRET_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'apikey',
  'password',
  'passwd',
  'token',
  'secret',
]);

/**
 * 查询串里需要脱敏的参数名（login 回调的 code/state 也在这里，它们等价于一次性凭据）。
 */
const QUERY_SECRET_KEYS = new Set([
  'code',
  'state',
  'authcode',
  'sessioncode',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'apikey',
  'api_key',
  'password',
  'token',
  'secret',
]);

/** 文本里的 `Authorization: xxx` / `cookie=xxx` 这类头，值是整段凭据。 */
const HEADER_LINE = /(^|[\r\n])([ \t]*)(authorization|proxy-authorization|cookie|set-cookie|x-api-key)([ \t]*[:=][ \t]*)([^\r\n]*)/gi;

/** `Bearer x` / `Basic base64` / `Token x`：scheme 保留，凭据替换。 */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9\-._~+/=]{6,})/gi;

/** 常见服务商的密钥前缀。宁可多认几个，也别漏掉。 */
const KEY_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI / DeepSeek / Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
]);

/** 三段点分的 JWT。必须在「长 base64」之前跑，否则会被逐段切开。 */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/** 长 base64url（> 80）：JWT 段、随机 token、上传签名的常见长度。 */
const LONG_TOKEN = /[A-Za-z0-9_\-+/=]{81,}/g;

/** 字符串化后的 JSON 里 `"password":"xxx"` 也要挡。 */
const JSON_SECRET_PAIR = /("(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization|access_token|refresh_token|id_token|client_secret|api_key|apikey|password|token|secret)"\s*:\s*")([^"]*)(")/gi;

/** 查询串 `?code=xxx&state=yyy`（也兼容 `;` 分隔与裸 a=b&c=d 文本）。 */
const QUERY_PAIR = /(^|[?&;,]|\s)([A-Za-z0-9_.\-[\]]{1,64})=([^&#\s"'<>|]*)/g;

/** 邮箱：本地部分 + @ + 域名，用于截断展示。 */
const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/**
 * 邮箱截断展示：`alice@example.com` → `al***@example.com`。
 *
 * 单独导出：登录/订阅模块的界面提示也要用同一套规则，
 * 否则同一份账号在日志里和界面里长得不一样，用户会以为是两个人。
 */
export function maskEmail(email) {
  if (typeof email !== 'string' || email.length === 0) return email ?? '';
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  // 只有一个字符的本地部分也补到两位，避免出现 `a***@` 这种更短的怪样式。
  return `${local.slice(0, 2)}***@${domain}`;
}

function decodedLength(text) {
  try {
    return decodeURIComponent(text).length;
  } catch {
    return text.length;
  }
}

/** 已经是占位符的值不能再脱一次，否则 `[redacted:6]` 会被洗成 `[redacted:12]`。 */
function isMarked(text) {
  return /^\[redacted(?::\d+)?\]$/.test(String(text ?? ''));
}

/** `[redacted:<len>]`：长度信息对排查有用（「值是不是空」「是哪一类 token」）。 */
function secretMark(value) {
  const text = String(value ?? '');
  if (isMarked(text)) return text;
  const len = decodedLength(text);
  return `[redacted:${len > 0 ? len : text.length}]`;
}

/**
 * 对象键是否「整体脱敏」。
 *
 * 只认 SECRET_KEYS：查询串专用的 code/state 不进这里——`error.code` 必须留下。
 * `api_key` 归一化后就是 `apikey`，所以不必单独列。
 */
function firstSecretKey(name) {
  return SECRET_KEYS.has(normalizeKey(name));
}

/** 字符串脱敏：按「越具体越先跑」的顺序，避免后面的规则把已替换的占位再吃掉。 */
export function redactString(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let text = input;

  // 1. 头行整段替换（Authorization / Cookie …），后面就不用再猜值里哪部分是秘密。
  text = text.replace(HEADER_LINE, (match, lead, space, name, sep, value) => {
    if (!value) return match;
    return `${lead}${space}${name}${sep}${secretMark(value)}`;
  });

  // 2. 认证 scheme。
  text = text.replace(AUTH_SCHEME, (match, scheme, token) => `${scheme} ${secretMark(token)}`);

  // 3. 已知前缀的密钥。
  for (const pattern of KEY_PATTERNS) {
    text = text.replace(pattern, match => secretMark(match));
  }

  // 4. JWT 与长 base64url。
  text = text.replace(JWT, match => secretMark(match));
  text = text.replace(LONG_TOKEN, (match) => {
    // 纯小写字母的长串大概率是 hash/路径片段而不是 token；带数字或大写的才按凭据处理。
    return /\d/.test(match) || /[A-Z]/.test(match) ? secretMark(match) : match;
  });

  // 5. 字符串化 JSON 里的凭据字段。
  text = text.replace(JSON_SECRET_PAIR, (match, head, value, tail) => (value ? `${head}${secretMark(value)}${tail}` : match));

  // 6. 查询串。
  text = text.replace(QUERY_PAIR, (match, lead, name, value) => {
    if (!value || isMarked(value)) return match;
    if (!QUERY_SECRET_KEYS.has(normalizeKey(name))) return match;
    return `${lead}${name}=${secretMark(value)}`;
  });

  // 7. 邮箱截断（保留域名）。
  return text.replace(EMAIL, match => maskEmail(match));
}

function isErrorLike(value) {
  return value instanceof Error;
}

function walk(value, state) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary:${value.byteLength ?? 0}]`;
  }
  if (isErrorLike(value)) {
    // Error 的 stack 不进字段：span/ipc 的报错记录靠 message + code 定位，
    // 崩溃栈由安装层单独截断后写入（见 index.mjs），避免每条 error 都撑爆一份日志。
    const plain = { name: value.name || 'Error', message: redactString(String(value.message ?? '')) };
    if (value.code !== undefined) plain.code = walk(value.code, state);
    if (value.cause !== undefined) plain.cause = walk(value.cause, state);
    return plain;
  }

  if (state.depth >= state.maxDepth) return '[depth-limit]';

  const seen = state.seen;
  // 同一个对象在日志里出现两次很常见（settings 被多处引用），这里只截环，不去重。
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const next = { ...state, depth: state.depth + 1 };

  let out;
  if (Array.isArray(value)) {
    out = value.map(item => walk(item, next));
  } else if (value instanceof Map) {
    out = {};
    for (const [key, item] of value) out[String(key)] = walk(item, next);
  } else if (value instanceof Set) {
    out = [...value].map(item => walk(item, next));
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      let raw;
      try {
        raw = value[key];
      } catch {
        // 带 getter 的对象（lazy 字段）读一次可能抛错；脱敏不能因此把整条日志弄丢。
        out[key] = '[unserializable]';
        continue;
      }
      out[key] = firstSecretKey(key) ? walkSecret(raw, next) : walk(raw, next);
    }
  }
  seen.delete(value);
  return out;
}

/** 命中最敏感的键：值整体替换，只有数字/布尔这类「不像凭据」的保持原样。 */
function walkSecret(value, state) {
  if (typeof value === 'string') return value.length > 0 && !isMarked(value) ? secretMark(value) : value;
  if (value === null || typeof value === 'undefined') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? [] : FULLY_REDACTED;
  if (value instanceof Date) return walk(value, state);
  return FULLY_REDACTED;
}

/**
 * 递归脱敏任意值，返回同形状的「可安全 JSON 化」副本。
 *
 * 传进来的东西可能是 Error、循环引用、Buffer、带 getter 的对象；
 * 返回值保证能被 JSON.stringify 吞下去（这也是 logger 敢直接拼 JSONL 的前提）。
 */
export function redact(value) {
  return walk(value, { depth: 0, maxDepth: DEFAULT_MAX_DEPTH, seen: new WeakSet() });
}
