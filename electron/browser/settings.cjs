'use strict';
// 内置浏览器的用户设置：单一权威存储 + 校验 + 原子写。
// 所有运行时模块（下载、快照、Diff、动作超时、技能）都从这里读，避免同一开关两套真相。

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

/** 动作风险等级：0 只读 / 1 可交互 / 2 可提交。敏感动作永远单独确认。 */
const AGENT_TIERS = ['read', 'interact', 'submit'];
const RECORD_SCOPES = ['conversation', 'all'];
/** 站点技能保存时机：model 由模型判断 / always 静默记录 / off 关闭。 */
const SKILL_MODES = ['model', 'always', 'off'];

const DEFAULT_NEW_TAB = 'https://www.google.com';

function defaults(downloadsDir) {
  return {
    basics: {
      enabled: true,
      newTabUrl: DEFAULT_NEW_TAB,
      restoreTabs: false,
      rememberWidth: true,
      autoCollapseSidebar: false,
    },
    agent: {
      tier: 'interact',
      confirmPerSite: true,
      // 本会话免确认：只对「当次运行」生效，不落盘到下次启动。
      sessionWaiver: false,
      // 敏感动作始终确认：锁定，不可关闭（写入时会被强制回到 true）。
      sensitiveAlwaysConfirm: true,
    },
    login: {
      savePasswords: true,
      saveStorage: true,
      askCookieLogin: true,
      recordScope: 'conversation',
    },
    transfer: {
      downloadDir: downloadsDir || '',
      openAfterDownload: false,
      blockExecutables: true,
      uploadMaxMb: 25,
      confirmUpload: true,
    },
    skills: {
      // 默认交给模型判断：批量成功后只给候选，模型决定要不要 browser_skill save。
      mode: 'model',
    },
    advanced: {
      jsBatch: false,
      actionTimeoutMs: 8000,
      waitTimeoutMs: 30000,
      snapshotBudget: 24000,
      diffThreshold: 0.6,
      iframeFallback: true,
    },
  };
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const int = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * 站点技能模式迁移：只有显式 `autoRecord:false` 才映射成 `off`。
 * `autoRecord` 原先默认就是 true，把它映射成 `always` 会让所有老用户退回静默记录，
 * 所以其余情况（含缺失、true、promptAtThreeSteps 任意值）一律落到 `model`。
 * `promptAtThreeSteps` 已删除：读到旧值直接忽略，不报错。
 */
function skillsModeOf(section, fallback = 'model') {
  const source = isPlainObject(section) ? section : {};
  if (SKILL_MODES.includes(source.mode)) return source.mode;
  if (source.autoRecord === false) return 'off';
  return SKILL_MODES.includes(fallback) ? fallback : 'model';
}

function normalizeHttpUrl(value, fallback) {
  const raw = String(value ?? '').trim();
  // 空白页用空串表示；about:blank 也归一成空串，避免两套「空白」。
  if (!raw || raw === 'about:blank') return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return fallback;
    return parsed.href;
  } catch {
    // 允许用户只写域名
    try {
      const parsed = new URL(`https://${raw}`);
      return parsed.href;
    } catch { return fallback; }
  }
}

/** 把任意输入收敛成合法设置；未知键丢弃，锁定项强制回默认。 */
function normalize(input, base) {
  const source = isPlainObject(input) ? input : {};
  const pick = (section, key, fallback) => (isPlainObject(source[section]) && key in source[section] ? source[section][key] : fallback);
  const b = base.basics;
  const a = base.agent;
  const l = base.login;
  const t = base.transfer;
  const s = base.skills;
  const v = base.advanced;
  return {
    basics: {
      enabled: bool(pick('basics', 'enabled', b.enabled), b.enabled),
      newTabUrl: normalizeHttpUrl(pick('basics', 'newTabUrl', b.newTabUrl), b.newTabUrl),
      restoreTabs: bool(pick('basics', 'restoreTabs', b.restoreTabs), b.restoreTabs),
      rememberWidth: bool(pick('basics', 'rememberWidth', b.rememberWidth), b.rememberWidth),
      autoCollapseSidebar: bool(pick('basics', 'autoCollapseSidebar', b.autoCollapseSidebar), b.autoCollapseSidebar),
    },
    agent: {
      tier: oneOf(pick('agent', 'tier', a.tier), AGENT_TIERS, a.tier),
      confirmPerSite: bool(pick('agent', 'confirmPerSite', a.confirmPerSite), a.confirmPerSite),
      sessionWaiver: bool(pick('agent', 'sessionWaiver', a.sessionWaiver), a.sessionWaiver),
      // 锁定：任何输入都回到 true，界面上也不提供关闭入口。
      sensitiveAlwaysConfirm: true,
    },
    login: {
      savePasswords: bool(pick('login', 'savePasswords', l.savePasswords), l.savePasswords),
      saveStorage: bool(pick('login', 'saveStorage', l.saveStorage), l.saveStorage),
      askCookieLogin: bool(pick('login', 'askCookieLogin', l.askCookieLogin), l.askCookieLogin),
      recordScope: oneOf(pick('login', 'recordScope', l.recordScope), RECORD_SCOPES, l.recordScope),
    },
    transfer: {
      downloadDir: String(pick('transfer', 'downloadDir', t.downloadDir) || t.downloadDir).trim() || t.downloadDir,
      openAfterDownload: bool(pick('transfer', 'openAfterDownload', t.openAfterDownload), t.openAfterDownload),
      blockExecutables: bool(pick('transfer', 'blockExecutables', t.blockExecutables), t.blockExecutables),
      uploadMaxMb: int(pick('transfer', 'uploadMaxMb', t.uploadMaxMb), t.uploadMaxMb, 1, 512),
      confirmUpload: bool(pick('transfer', 'confirmUpload', t.confirmUpload), t.confirmUpload),
    },
    skills: {
      // 迁移与校验都在 skillsModeOf 里；输出只保留 mode，旧键不再回写。
      mode: skillsModeOf(isPlainObject(source.skills) ? source.skills : null, s.mode),
    },
    advanced: {
      jsBatch: bool(pick('advanced', 'jsBatch', v.jsBatch), v.jsBatch),
      actionTimeoutMs: int(pick('advanced', 'actionTimeoutMs', v.actionTimeoutMs), v.actionTimeoutMs, 1000, 60000),
      waitTimeoutMs: int(pick('advanced', 'waitTimeoutMs', v.waitTimeoutMs), v.waitTimeoutMs, 1000, 120000),
      snapshotBudget: int(pick('advanced', 'snapshotBudget', v.snapshotBudget), v.snapshotBudget, 2000, 200000),
      diffThreshold: Math.min(1, Math.max(0.1, Number(pick('advanced', 'diffThreshold', v.diffThreshold)) || v.diffThreshold)),
      iframeFallback: bool(pick('advanced', 'iframeFallback', v.iframeFallback), v.iframeFallback),
    },
  };
}

function createBrowserSettings({ filePath, defaultDownloadsDir = '' } = {}) {
  const base = defaults(defaultDownloadsDir);
  let cached = null;

  const resolvePath = () => (typeof filePath === 'function' ? filePath() : filePath);

  function readFile() {
    const path = resolvePath();
    if (!path) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      return isPlainObject(raw) ? raw : null;
    } catch {
      // 缺失或损坏都回默认值；损坏的旧文件不阻止启动。
      return null;
    }
  }

  function read() {
    if (!cached) cached = normalize(readFile(), base);
    return cached;
  }

  function write(next) {
    const path = resolvePath();
    if (!path) return next;
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.settings-${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, path);   // 原子替换，避免半截文件
    return next;
  }

  /** 深合并一层：只改传进来的分节键，未提及的保持原值。 */
  function patch(partial) {
    const current = read();
    const merged = {};
    for (const section of Object.keys(current)) {
      merged[section] = isPlainObject(partial?.[section])
        ? { ...current[section], ...partial[section] }
        : current[section];
    }
    cached = normalize(merged, base);
    write(cached);
    return cached;
  }

  return { read, patch, defaults: () => normalize(null, base), normalize: input => normalize(input, base) };
}

module.exports = { createBrowserSettings, normalize, defaults, AGENT_TIERS, RECORD_SCOPES, SKILL_MODES, DEFAULT_NEW_TAB };
