'use strict';
// Secret and identity-number redaction for memory capture and prompt building.
//
// Pure and deterministic: no Electron, no network, no logging. The matched value
// is never returned, copied into a result field, or written to an error.
//
// Assumptions (contract):
// 1. Output is idempotent: redactSensitive(redactSensitive(x).text).text is
//    already masked, so a second pass reports `redacted: false`.
// 2. A label alone is not a secret. "密码管理器" / "密钥管理" / "password manager"
//    / "API key rotation" are left untouched: redaction requires a separator
//    (： = 是 为) or `:` / `=` followed by an actual value.
// 3. Kinds are stable identifiers, sorted for determinism. Callers may store
//    them; they never contain the value itself.
// 4. Bank cards are only detected without a label when the digits pass Luhn,
//    which keeps order numbers and timestamps out of the result.

const REDACTED = '[REDACTED]';

// Values that describe a credential field instead of holding one.
const NON_SECRET_VALUES = new Set([
  'required', 'optional', 'minimum', 'maximum', 'length', 'policy', 'rotation',
  'manager', 'management', 'reset', 'expired', 'expires', 'expiration', 'invalid',
  'valid', 'missing', 'hidden', 'masked', 'enabled', 'disabled', 'true', 'false',
  'null', 'none', 'n/a', 'unknown', 'unset', 'empty', 'not', 'set', 'changed',
  'rotated', 'stored', 'saved', '管理', '管理器', '策略', '长度', '重置', '已隐藏',
  '保密', '无', '未知', '必填', '选填', '未设置', '已设置',
]);

const PLACEHOLDER_VALUE = /^(?:\[?redacted\]?|\*{2,}|x{3,}|…+|\.{2,}|<[^<>]{0,40}>|\$\{[^}]{0,40}\}|(?:none|null|n\/a|unknown|hidden|omitted|tbd))$/i;

function cleanValue(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

function isNonSecretValue(value) {
  const text = cleanValue(value);
  if (!text) return true;
  if (PLACEHOLDER_VALUE.test(text)) return true;
  return NON_SECRET_VALUES.has(text.toLowerCase());
}

function assignmentKind(label) {
  const text = String(label).toLowerCase();
  if (/密码|密碼|口令|password|passwd|pwd/.test(text)) return 'password';
  if (/api[\s_-]?key|api\s*(?:密钥|密鑰)/.test(text)) return 'api-key';
  if (/token|令牌/.test(text)) return 'token';
  if (/验证码|驗證碼/.test(text)) return 'verification-code';
  return 'secret';
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;
    let digit = code;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// Values are matched greedily up to whitespace or a list/句 separator; quoted
// values keep their quotes out of the match.
const VALUE = String.raw`(?:"[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s,;，；。]{1,200})`;
const EN_LABEL = String.raw`\b(?:passwords?|passwd|pwd|secrets?|api[\s_-]?keys?|access[\s_-]?key|private[\s_-]?key|client[\s_-]?secret|access[\s_-]?token|auth[\s_-]?token|tokens?|credentials?)\b`;
const ZH_LABEL = String.raw`(?:api\s*)?(?:密码|密碼|口令|密钥|密鑰|私钥|私鑰|令牌|凭据|憑據|验证码|驗證碼)`;
const ID_LABEL = String.raw`(?:身份证(?:号码|号|號)?|身份證(?:號碼|號)?|id\s*card(?:\s*number)?)`;
const BANK_LABEL = String.raw`(?:银行卡(?:号码|号|卡號)?|銀行卡(?:號碼|號|卡號)?|信用卡(?:号码|号|卡號)?|卡号|卡號|bank\s*card(?:\s*number)?|credit\s*card(?:\s*number)?)`;

const EN_ASSIGNMENT = new RegExp(
  `(?<label>${EN_LABEL})(?<sep>\\s*(?::|=|\\bis\\b)\\s*)(?<value>${VALUE})`,
  'gi',
);
const ZH_ASSIGNMENT = new RegExp(
  `(?<label>${ZH_LABEL})(?<sep>\\s*(?:[:：=＝]|是|为|為)\\s*)(?<value>${VALUE})`,
  'gi',
);
const ID_LABEL_NUMBER = new RegExp(
  `(?<label>${ID_LABEL})(?<sep>\\s*(?:[:：=＝]|是|为|為)?\\s*)(?<value>[0-9Xx]{15,18})(?![0-9Xx])`,
  'gi',
);
const BANK_LABEL_NUMBER = new RegExp(
  `(?<label>${BANK_LABEL})(?<sep>\\s*(?:[:：=＝]|是|为|為)?\\s*)(?<value>\\d(?:[ -]?\\d){11,22})(?!\\d)`,
  'gi',
);

const RULES = [
  // Complete PEM block. Multiline, so it must run before anything line-based.
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    output: () => REDACTED,
  },
  // Truncated PEM (BEGIN without END): redact the remainder rather than leak it.
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g,
    output: () => REDACTED,
  },
  {
    kind: 'api-key',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    output: () => REDACTED,
  },
  {
    kind: 'api-key',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)[A-Z0-9]{16}\b/g,
    output: () => REDACTED,
  },
  {
    kind: 'api-key',
    pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
    output: () => REDACTED,
  },
  {
    kind: 'api-key',
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    output: () => REDACTED,
  },
  {
    kind: 'api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    output: () => REDACTED,
  },
  {
    kind: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    output: match => `${match.split(/\s+/, 1)[0]} ${REDACTED}`,
  },
  {
    kind: groups => assignmentKind(groups.label),
    pattern: EN_ASSIGNMENT,
    output: (match, groups) => (isNonSecretValue(groups.value)
      ? null
      : `${groups.label}${groups.sep}${REDACTED}`),
  },
  {
    kind: groups => assignmentKind(groups.label),
    pattern: ZH_ASSIGNMENT,
    output: (match, groups) => (isNonSecretValue(groups.value)
      ? null
      : `${groups.label}${groups.sep}${REDACTED}`),
  },
  {
    kind: 'id-card',
    pattern: ID_LABEL_NUMBER,
    output: (match, groups) => (isNonSecretValue(groups.value)
      ? null
      : `${groups.label}${groups.sep}${REDACTED}`),
  },
  {
    kind: 'id-card',
    // 18-digit PRC ID: area + birth date + sequence + check digit. The date
    // shape is validated so ordinary 18-digit numbers are not mislabelled.
    pattern: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])/g,
    output: () => REDACTED,
  },
  {
    kind: 'bank-card',
    pattern: BANK_LABEL_NUMBER,
    output: (match, groups) => (isNonSecretValue(groups.value)
      ? null
      : `${groups.label}${groups.sep}${REDACTED}`),
  },
  {
    kind: 'bank-card',
    pattern: /\b\d(?:[ -]?\d){11,18}\b/g,
    output: match => {
      const digits = match.replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19) return null;
      return luhnValid(digits) ? REDACTED : null;
    },
  },
];

function runRule(text, rule, kinds) {
  return text.replace(rule.pattern, (match, ...rest) => {
    const last = rest[rest.length - 1];
    const groups = last && typeof last === 'object' ? last : {};
    const output = rule.output(match, groups);
    if (typeof output !== 'string') return match;
    kinds.add(typeof rule.kind === 'function' ? rule.kind(groups) : rule.kind);
    return output;
  });
}

function redactSensitive(value) {
  let text = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
  if (!text) return { text, redacted: false, kinds: [] };
  const kinds = new Set();
  for (const rule of RULES) text = runRule(text, rule, kinds);
  return { text, redacted: kinds.size > 0, kinds: [...kinds].sort() };
}

module.exports = {
  redactSensitive,
  REDACTED,
};
