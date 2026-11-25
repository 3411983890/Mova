'use strict';
// 桌面操作的风险分级。与 browser/policy.cjs 同一个取向：纯函数、无 electron
// 依赖、可单测，默认保守 —— 认不出的动作按“有副作用”处理，命中危险词/危险键
// 只会往上升级，绝不因为调用方传了好看的参数而降级。
//
// 分级（见 Mova桌面操作开发方案.md §11.3）：
//   R0 读取        windows / snapshot / read / wait / screenshot / skill(list|find)
//   R1 轻交互      focus / activate / scroll / launch
//   R2 常规交互    click / type / key / drag / toggle / select / setValue
//   R3 提交副作用  save / send / submit / upload / download / export / install ...
//   R4 敏感        UAC / 安全桌面 / 密码框 / 登录窗口 / 支付 / 转账 / 卸载 / 格式化 / 危险键

const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3', 'R4'];

/** 一次性读取，永远不需要审批。 */
const READ_ACTIONS = new Set([
  'windows', 'snapshot', 'read', 'readtext', 'wait', 'screenshot', 'displays', 'active',
  'list', 'find', 'status', 'inspect', 'skill_list', 'skill_find', 'wait_for',
]);

/** 只改变前台/焦点/滚动位置：轻交互。 */
const LIGHT_ACTIONS = new Set(['focus', 'activate', 'scroll', 'launch', 'hover', 'switch']);

/** 常规交互：有副作用但可回退。 */
const INTERACT_ACTIONS = new Set([
  'click', 'type', 'key', 'keys', 'press', 'invoke', 'toggle', 'select', 'setvalue', 'set_value',
  'drag', 'drop', 'paste', 'copy', 'close', 'doubleclick', 'rightclick',
]);

/** 提交类：默认每次审批。 */
const COMMIT_ACTIONS = new Set([
  'save', 'saveas', 'save_as', 'send', 'submit', 'upload', 'download', 'export', 'install',
  'publish', 'commit', 'overwrite', 'clipboard_cross_app',
]);

/**
 * 危险词：命中后至少 R3。中文界面里按钮/菜单文本是最可靠的信号。
 * 排序无关，正则里用 \b 会漏中文，所以直接子串匹配但要避免误伤（“保存”在“保存的搜索”里
 * 仍然是保存，宁可多问一次）。
 */
const DANGER_WORDS = [
  '保存', '另存', '存盘', '发送', '发布', '提交', '上传', '下载', '导出', '覆盖',
  '删除', '卸载', '安装', '格式化', '支付', '付款', '转账', '汇款', '下单', '购买',
  '清空', '重置', '退出登录', '注销', '授权', '确认支付',
  'save', 'save as', 'send', 'submit', 'upload', 'download', 'export', 'overwrite',
  'delete', 'uninstall', 'install', 'format', 'pay', 'purchase', 'checkout', 'transfer',
  'remove account', 'sign out', 'reset',
];

/** 命中即 R4：不可逆或涉及凭据/系统权限。 */
const SEVERE_WORDS = [
  '卸载', '格式化', '支付', '付款', '转账', '汇款', '购买', '下单', '删除账户', '注销账户',
  '修改密码', '重置密码', '更改密码', '安装驱动', '系统设置', '授予权限', '提权',
  'uninstall', 'format', 'payment', 'purchase', 'transfer', 'remove account', 'delete account',
  'change password', 'reset password', 'elevate', 'grant permission',
];

/** 危险键：永远不注入（Win+L 锁屏、Win+R 运行框、Ctrl+Alt+Del 安全桌面）。 */
const DANGEROUS_KEYS = [
  'CTRL+ALT+DEL', 'CTRL+ALT+DELETE', 'CTRL+SHIFT+ESC', 'WIN+L', 'WIN+R', 'WIN+X',
  'ALT+CTRL+DEL', 'META+L', 'META+R',
];

/** 密码框/登录窗口。桌面不做代填（§11.4），命中即交接。 */
const PASSWORD_HINTS = /(password|passwd|passcode|密码|口令|pin\s*code)/i;
const LOGIN_WINDOW_HINTS = /(登录|登入|sign\s*in|log\s*in|logon|login|凭据|credentials?)/i;
const SECURE_DESKTOP_HINTS = /(用户帐户控制|用户账户控制|user\s*account\s*control|\buac\b|安全桌面|secure\s*desktop|凭据对话框)/i;
const SECURE_APP_HINTS = /(^|\\)(consent|logonui|winlogon|credentialui|useraccountcontrol)\.exe$/i;

/** 密码管理器：即使设置里没写，也不允许自动化（§11.1 应用黑名单）。 */
const BUILTIN_DENY_EXE = [
  '1password.exe', 'keepass.exe', 'keepassxc.exe', 'bitwarden.exe', 'lastpass.exe',
  'dashlane.exe', 'enpass.exe', 'roboform.exe', 'logonui.exe', 'consent.exe', 'winlogon.exe',
];

const PROFILES = ['read-only', 'standard', 'full'];
const APP_RULES = ['allow', 'ask', 'deny', 'route-to-browser'];

const BUDGET_DEFAULTS = Object.freeze({ maxMinutes: 10, maxActions: 60, maxVisionFrames: 20 });
const BUDGET_LIMITS = Object.freeze({
  maxMinutes: [1, 60],
  maxActions: [5, 300],
  maxVisionFrames: [0, 60],
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  profile: 'standard',
  apps: {},
  budget: { ...BUDGET_DEFAULTS },
  overlay: { glow: true, targetOutline: true, bubbles: true },
  memory: { auto: true },
  advanced: {
    maxDepth: 6,
    treeTimeoutMs: 1500,
    excludeProcesses: [],
    vision: true,
    groundingModel: '',
    auditPath: '',
  },
});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const int = (value, fallback, [min, max]) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 安全设置对象的完整默认值（设置页拿到的就是它）。 */
function settingsDefaults() {
  return clone(DEFAULT_SETTINGS);
}

/**
 * 把任意输入收敛成一份合法设置：未知字段忽略，类型不对的回到默认值。
 * @param {unknown} input
 * @param {object} [base] 已有设置（patch 时用）
 */
function normalizeSettings(input, base = settingsDefaults()) {
  const source = isPlainObject(input) ? input : {};
  const read = (section, key, fallback) => (isPlainObject(source[section]) && key in source[section]
    ? source[section][key]
    : fallback);
  const top = (key, fallback) => (key in source ? source[key] : fallback);
  const overlay = isPlainObject(base.overlay) ? base.overlay : DEFAULT_SETTINGS.overlay;
  const memory = isPlainObject(base.memory) ? base.memory : DEFAULT_SETTINGS.memory;
  const advanced = isPlainObject(base.advanced) ? base.advanced : DEFAULT_SETTINGS.advanced;
  const budget = isPlainObject(base.budget) ? base.budget : DEFAULT_SETTINGS.budget;

  const apps = {};
  const sourceApps = isPlainObject(source.apps) ? source.apps : (isPlainObject(base.apps) ? base.apps : {});
  for (const [key, value] of Object.entries(sourceApps).slice(0, 500)) {
    const appKey = String(key || '').trim().slice(0, 120);
    if (!appKey) continue;
    if (typeof value === 'string') {
      const allow = oneOf(value, APP_RULES, null);
      if (allow) apps[appKey] = allow;
      continue;
    }
    if (!isPlainObject(value)) continue;
    const allow = oneOf(value.allow, APP_RULES, null);
    if (!allow) continue;
    apps[appKey] = {
      allow,
      ...(typeof value.vision === 'boolean' ? { vision: value.vision } : {}),
      ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason.slice(0, 120) } : {}),
    };
  }

  return {
    enabled: bool(top('enabled', base.enabled), DEFAULT_SETTINGS.enabled),
    // “电脑操作”默认关闭：用户必须在设置里显式打开（§11 诚实声明）。
    profile: oneOf(top('profile', base.profile), PROFILES, DEFAULT_SETTINGS.profile),
    apps,
    budget: {
      maxMinutes: int(read('budget', 'maxMinutes', budget.maxMinutes), budget.maxMinutes, BUDGET_LIMITS.maxMinutes),
      maxActions: int(read('budget', 'maxActions', budget.maxActions), budget.maxActions, BUDGET_LIMITS.maxActions),
      maxVisionFrames: int(read('budget', 'maxVisionFrames', budget.maxVisionFrames), budget.maxVisionFrames, BUDGET_LIMITS.maxVisionFrames),
    },
    overlay: {
      glow: bool(read('overlay', 'glow', overlay.glow), overlay.glow),
      targetOutline: bool(read('overlay', 'targetOutline', overlay.targetOutline), overlay.targetOutline),
      bubbles: bool(read('overlay', 'bubbles', overlay.bubbles), overlay.bubbles),
    },
    memory: {
      auto: bool(read('memory', 'auto', memory.auto), memory.auto),
    },
    advanced: {
      maxDepth: int(read('advanced', 'maxDepth', advanced.maxDepth), advanced.maxDepth, [1, 12]),
      treeTimeoutMs: int(read('advanced', 'treeTimeoutMs', advanced.treeTimeoutMs), advanced.treeTimeoutMs, [200, 15000]),
      excludeProcesses: normalizeList(read('advanced', 'excludeProcesses', advanced.excludeProcesses)),
      vision: bool(read('advanced', 'vision', advanced.vision), advanced.vision),
      groundingModel: text(read('advanced', 'groundingModel', advanced.groundingModel), 120),
      auditPath: text(read('advanced', 'auditPath', advanced.auditPath), 400),
    },
  };
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter(item => typeof item === 'string')
    .map(item => item.trim().toLowerCase().slice(0, 64))
    .filter(Boolean))].slice(0, 64);
}

/** 'EXCEL.EXE|16.0' / 'C:\\...\\excel.exe' / 'excel.exe' → 'excel.exe' */
function exeOf(appKey) {
  const raw = String(appKey || '').trim();
  if (!raw) return '';
  const exe = raw.split('|')[0].split(/[\\/]/).pop();
  return exe.toLowerCase();
}

function appNameOf(appKey) {
  return String(appKey || '').split('|')[0].split(/[\\/]/).pop() || '';
}

function wildcardMatch(pattern, value) {
  const source = String(pattern || '').trim().toLowerCase();
  if (!source) return false;
  if (!source.includes('*')) return source === value;
  const regex = new RegExp(`^${source.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return regex.test(value);
}

/**
 * 应用规则：设置里的 allow / ask / deny（含通配符），叠加内置黑名单。
 * @param {string} appKey exe 或 'exe|版本'
 * @param {object} settings 桌面设置
 * @returns {{allow:'allow'|'ask'|'deny'|'route-to-browser', reason:string, vision:boolean|undefined}}
 */
function appRule(appKey, settings = DEFAULT_SETTINGS) {
  const exe = exeOf(appKey);
  const key = String(appKey || '').trim().toLowerCase();
  const apps = isPlainObject(settings?.apps) ? settings.apps : {};
  const configured = [];
  for (const [pattern, value] of Object.entries(apps)) {
    const target = String(pattern || '').trim().toLowerCase();
    if (!target) continue;
    if (target === key || target === exe || wildcardMatch(target, exe) || wildcardMatch(target, key)) {
      configured.push({ pattern, value });
    }
  }
  if (configured.length) {
    // 精确命中优先于通配，deny 优先于其它（安全侧）。
    configured.sort((a, b) => Number(a.pattern.includes('*')) - Number(b.pattern.includes('*')));
    const deny = configured.find(row => (typeof row.value === 'string' ? row.value : row.value?.allow) === 'deny');
    const chosen = deny || configured[0];
    const value = chosen.value;
    const allow = typeof value === 'string' ? value : value?.allow;
    return {
      allow: oneOf(allow, APP_RULES, 'ask'),
      reason: (typeof value === 'object' && value?.reason) || `rule:${chosen.pattern}`,
      vision: typeof value === 'object' ? value.vision : undefined,
    };
  }
  if (exe && BUILTIN_DENY_EXE.includes(exe)) {
    return { allow: 'deny', reason: 'builtin-deny', vision: false };
  }
  // Mova 自己：自动化 Mova 的窗口是 bug（§9.6），不是策略。
  if (exe === 'mova.exe' || exe === 'electron.exe') {
    return { allow: 'deny', reason: 'self-target', vision: false };
  }
  // 只读档不在“应用规则”这一层要求审批：那一层会把 R0 读取也拉成 R3，
  // 等于只读档什么都不能读。真正的拦截在 classifyDesktopAction 末尾按风险档做。
  if (settings?.profile === 'read-only') return { allow: 'allow', reason: 'profile:read-only', vision: false };
  return { allow: 'allow', reason: 'default', vision: undefined };
}

/** 'Ctrl+S' / ['Ctrl','S'] / 'ctrl + s' → ['CTRL+S']；数组视为一次组合键。 */
function normalizeKeys(keys) {
  const list = Array.isArray(keys)
    ? (keys.length ? [keys.join('+')] : [])
    : String(keys || '').split(/[,;]+/);
  return list
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .map(combo => combo
      .replace(/\s+/g, '')
      .replace(/[＋+]/g, '+')
      .split('+')
      .map(part => normalizeKeyName(part))
      .filter(Boolean)
      .join('+'))
    .filter(Boolean);
}

function normalizeKeyName(part) {
  const lower = part.toLowerCase();
  const alias = {
    ctrl: 'CTRL', control: 'CTRL', ctl: 'CTRL',
    alt: 'ALT', option: 'ALT',
    shift: 'SHIFT',
    win: 'WIN', meta: 'WIN', cmd: 'WIN', command: 'WIN', super: 'WIN',
    del: 'DEL', delete: 'DEL', esc: 'ESC', escape: 'ESC', enter: 'ENTER', return: 'ENTER',
    tab: 'TAB', space: 'SPACE', backspace: 'BACKSPACE',
  };
  if (alias[lower]) return alias[lower];
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  return part.length === 1 ? part.toUpperCase() : lower.toUpperCase();
}

/** 任意文本里是否含危险词（按命中级别返回）。 */
function scanWords(text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  const severe = SEVERE_WORDS.find(word => haystack.includes(word.toLowerCase()));
  if (severe) return { level: 4, reason: 'sensitive-word', word: severe };
  const danger = DANGER_WORDS.find(word => haystack.includes(word.toLowerCase()));
  if (danger) return { level: 3, reason: 'dangerous-word', word: danger };
  return null;
}

function isDangerousKeys(keys) {
  const combos = normalizeKeys(keys);
  for (const combo of combos) {
    if (DANGEROUS_KEYS.includes(combo)) return combo;
    // Alt+Ctrl+Del 之类顺序不同但等价：按集合比较一次。
    const sorted = combo.split('+').sort().join('+');
    const hit = DANGEROUS_KEYS.find(item => item.split('+').sort().join('+') === sorted);
    if (hit) return combo;
  }
  return null;
}

/**
 * @param {{action?:string,target?:string,app?:string,value?:string,keys?:string|string[],
 *          title?:string,window?:string,password?:boolean,submit?:boolean,tier?:string}} input
 * @param {object} [settings]
 * @returns {{level:string,risk:number,reasons:string[],requiresApproval:boolean,
 *           requiresHandoff:boolean,label:string,app:string,exe:string,appRule:object}}
 */
function classifyDesktopAction(input = {}, settings = DEFAULT_SETTINGS) {
  const reasons = [];
  const action = String(input.action || input.op || '').toLowerCase();
  const appKey = String(input.app || input.appKey || '');
  const exe = exeOf(appKey);
  const title = String(input.title || input.window || '');
  const target = String(input.target || '');
  const value = String(input.value ?? '');
  const keys = input.keys ?? (action === 'key' || action === 'press' ? input.value : '');
  const rule = appRule(appKey, settings);

  let risk;
  if (!action) { risk = 2; reasons.push('missing-action'); }
  else if (READ_ACTIONS.has(action)) risk = 0;
  else if (LIGHT_ACTIONS.has(action)) risk = 1;
  else if (INTERACT_ACTIONS.has(action)) risk = 2;
  else if (COMMIT_ACTIONS.has(action)) { risk = 3; reasons.push(`commit-action:${action}`); }
  else { risk = 2; reasons.push(`unknown-action:${action}`); }

  // 密钥类动作按“键”再判一次：Ctrl+S 是保存（R3），Ctrl+Alt+Del 是 R4。
  const combos = normalizeKeys(keys);
  if (combos.length) {
    const dangerous = isDangerousKeys(keys);
    if (dangerous) {
      risk = 4;
      reasons.push(`dangerous-key:${dangerous}`);
    } else if (combos.some(combo => /^(CTRL\+)?S$/.test(combo) || /^(CTRL\+)?SHIFT\+S$/.test(combo))) {
      risk = Math.max(risk, 3);
      reasons.push('save-shortcut');
    }
    if (combos.some(combo => /^ENTER$/.test(combo)) && input.modal !== false) {
      risk = Math.max(risk, 3);
      reasons.push('enter-may-submit');
    }
  }

  if (input.submit === true) {
    risk = Math.max(risk, 3);
    reasons.push('submit');
  }

  // 目标/值里的文本是模型能看到的界面文字：危险词只看界面文本，不看“刚输入的值”。
  const wordHit = scanWords(`${target} ${title} ${action === 'key' ? '' : value}`);
  if (wordHit) {
    risk = Math.max(risk, wordHit.level);
    reasons.push(`${wordHit.reason}:${wordHit.word}`);
  }

  if (input.password === true || PASSWORD_HINTS.test(target)) {
    risk = 4;
    reasons.push('password-field');
  }
  if (LOGIN_WINDOW_HINTS.test(title) && input.login !== false) {
    risk = 4;
    reasons.push('login-window');
  }
  if (SECURE_DESKTOP_HINTS.test(`${title} ${target}`) || SECURE_APP_HINTS.test(exe || appKey)) {
    risk = 4;
    reasons.push('secure-desktop');
  }
  if (rule.allow === 'deny') {
    risk = 4;
    reasons.push(`app-denied:${rule.reason}`);
  } else if (rule.allow === 'ask') {
    risk = Math.max(risk, 3);
    reasons.push(`app-ask:${rule.reason}`);
  } else if (rule.allow === 'route-to-browser') {
    reasons.push('route-to-browser');
  }

  // 只读档：R2 以上一律当"提交级"，必须人点头（以前只 push 了一个 reason，等于没拦）
  if (settings?.profile === 'read-only' && risk >= 2) {
    risk = 3;
    reasons.push('profile:read-only');
  }

  const level = RISK_LEVELS[Math.min(4, Math.max(0, risk))];
  return {
    level,
    risk: RISK_LEVELS.indexOf(level),
    reasons,
    requiresApproval: risk === 3,
    requiresHandoff: risk >= 4,
    label: labelOf({ level, risk }),
    app: appNameOf(appKey),
    exe,
    appRule: rule,
  };
}

function labelOf(risk) {
  const value = typeof risk === 'number' ? risk : (risk?.risk ?? RISK_LEVELS.indexOf(risk?.level));
  if (value <= 0) return '读取';
  if (value === 1) return '轻交互';
  if (value === 2) return '交互';
  if (value === 3) return '提交';
  return '敏感';
}

/** 预算归一：来自设置或本次调用，永远落在硬边界内。 */
function normalizeBudget(input = {}, fallback = BUDGET_DEFAULTS) {
  const source = isPlainObject(input) ? input : {};
  return {
    maxMinutes: int(source.maxMinutes, fallback.maxMinutes, BUDGET_LIMITS.maxMinutes),
    maxActions: int(source.maxActions, fallback.maxActions, BUDGET_LIMITS.maxActions),
    maxVisionFrames: int(source.maxVisionFrames, fallback.maxVisionFrames, BUDGET_LIMITS.maxVisionFrames),
  };
}

/** 是否允许在视觉通道上花一帧（预算 + 设置）。 */
function visionAllowed(settings, usedFrames = 0) {
  if (settings?.advanced?.vision === false) return false;
  const limit = Number(settings?.budget?.maxVisionFrames ?? BUDGET_DEFAULTS.maxVisionFrames);
  return usedFrames < limit;
}

module.exports = {
  RISK_LEVELS,
  PROFILES,
  APP_RULES,
  BUDGET_DEFAULTS,
  BUDGET_LIMITS,
  DEFAULT_SETTINGS,
  DANGER_WORDS,
  SEVERE_WORDS,
  DANGEROUS_KEYS,
  BUILTIN_DENY_EXE,
  classifyDesktopAction,
  classify: classifyDesktopAction,
  appRule,
  exeOf,
  appNameOf,
  normalizeKeys,
  isDangerousKeys,
  scanWords,
  labelOf,
  settingsDefaults,
  normalizeSettings,
  normalizeBudget,
  visionAllowed,
};
