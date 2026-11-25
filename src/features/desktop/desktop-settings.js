/* 电脑操作设置页（设置 → 集成 → 电脑操作）。

   主进程是唯一数据源：这里只渲染、只写回增量 patch，不在渲染层另存一份真相。
   契约（由主进程 agent 实现；任何一项缺失都只降级，不抛错）：
     window.movaDesktop.desktop.getSettings()       -> { ok, value } | settings
     window.movaDesktop.desktop.setSettings(patch)  -> { ok, value } | settings
     window.movaDesktop.desktop.stop()              -> { ok }
   可选（没有就说明「当前版本不支持」）：
     getStatus() / status()、resetSettings()、
     skills.list() / listSkills()、skills.remove() / removeSkill()、
     clearElements() / elements.clear()、openAuditFolder() / revealAudit()。

   两套形状，只有一个换算点（改字段名只改那一处）：
     · 主进程形状（唯一权威）：electron/desktop/policy.cjs 的 DEFAULT_SETTINGS ——
       profile / apps:{appKey:rule} / overlay:{glow,targetOutline,bubbles} / memory:{auto} /
       advanced:{maxDepth,treeTimeoutMs,excludeProcesses,vision,groundingModel,auditPath}
     · 页面形状（只服务界面）：permission / apps:[{id,name,exe,rule}] / overlay:{highlight,bubble} /
       memory:{autoSkill} / advanced:{uiaDepth,timeoutMs,denyExe,visionFallback,grounderModel,auditPath}
   换算函数是 fromMain() / toMainPatch()；两边字段对不齐会静默存不进去（历史事故见 §7）。

   视觉只复用 .settings-section / .settings-card / .settings-row / .settings-switch /
   .settings-button 等现成结构，新加的局部件在 desktop-settings.css 里。 */

import { replaceStaticIcons } from '../../shared/icons.js';
import { confirmAction } from '../ui/confirm.js';
import { notify } from '../ui/toast.js';
import './desktop-settings.css';

/* 三档权限：id 必须与 electron/desktop/policy.cjs 的 PROFILES 完全一致
   （read-only | standard | full）。中文只是标签，别让 id 和标签跑偏。 */
const PERMISSIONS = [
  { id: 'read-only', label: '只读', note: '只读结构、截图、OCR，不执行任何写操作（点击、输入、快捷键一律拒绝）。' },
  { id: 'standard', label: '标准', note: '同一个应用在本会话首次操作时问一次，之后按规则放行。' },
  { id: 'full', label: '信任', note: '写操作不再询问；支付、删除账户、改密码、UAC 等敏感动作仍强制交给你。' },
];

const APP_RULES = [
  { id: 'allow', label: '允许' },
  { id: 'ask', label: '询问' },
  { id: 'deny', label: '禁止' },
];

const MINUTE_CHOICES = [5, 10, 30];

/* 主进程没装好时页面就按这份默认值渲染（只读），保证永远能打开。
   值必须与 policy.cjs 的 DEFAULT_SETTINGS 对齐（字段名见文件头，换算见 fromMain/toMainPatch）。 */
const DEFAULT_SETTINGS = {
  enabled: false,
  permission: 'standard',
  apps: [],
  budget: { maxMinutes: 10, maxActions: 60, maxVisionFrames: 20 },
  overlay: { edgeGlow: true, highlight: true, bubble: true },
  memory: { autoSkill: true },
  advanced: { uiaDepth: 6, timeoutMs: 1500, denyExe: [], visionFallback: true, grounderModel: '', auditPath: '' },
};

/* 数字输入的夹取区间必须落在 policy.cjs 的硬边界内：
   maxActions 5–300、maxVisionFrames 0–60、maxDepth 1–12、treeTimeoutMs 200–15000。 */
const NUMBER_FIELDS = {
  'budget.maxActions': { min: 5, max: 300, integer: true },
  'budget.maxVisionFrames': { min: 0, max: 60, integer: true },
  'advanced.uiaDepth': { min: 1, max: 12, integer: true },
  'advanced.timeoutMs': { min: 200, max: 15000, integer: false },
};

const SESSION_LABELS = {
  idle: '空闲', running: '正在操作这台电脑', paused: '已暂停（等你接手或审批）',
  finishing: '正在收尾', done: '空闲', aborted: '已终止', error: '出错了',
};
const RUNNING_SESSIONS = new Set(['running', 'paused', 'finishing']);

const STATUS_POLL_MS = 3000;

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, char => map[char]);
}

function readPath(source, path) {
  return path.split('.').reduce((value, key) => (value == null ? value : value[key]), source);
}

function patchFor(field, value) {
  const parts = field.split('.');
  if (parts.length === 1) return { [parts[0]]: value };
  return { [parts[0]]: { [parts[1]]: value } };
}

function clampNumber(value, config) {
  if (!Number.isFinite(value)) return config.min ?? 0;
  const min = config.min ?? 0;
  const max = config.max ?? Number.MAX_SAFE_INTEGER;
  const next = Math.min(Math.max(value, min), max);
  return config.integer ? Math.round(next) : next;
}

/* 主进程回包有三种写法，三种都认，别只认一种（只认 value 时会静默拿到 undefined）：
     { ok, value }    通用 handler（stop / skills:remove）
     { ok, settings } desktop:set-settings
     { ok, skills }   desktop:skills
   也接受裸对象（desktop:get-settings 成功时直接返回设置对象）。 */
function unwrap(result) {
  if (result && typeof result === 'object' && 'ok' in result) {
    if (!result.ok) throw new Error(result.error || result.reason || '主进程拒绝了这次操作');
    if ('value' in result) return result.value;
    if ('settings' in result) return result.settings;
    if ('skills' in result) return result.skills;
    return undefined;
  }
  return result;
}

function mergePatch(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key];
    const mergeable = value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current);
    next[key] = mergeable ? mergePatch(current, value) : value;
  }
  return next;
}

function normalizeApp(entry, index) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    if (!name) return null;
    return { id: `app-${index}`, name, exe: /\.exe$/i.test(name) ? name : '', rule: 'ask' };
  }
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name ?? entry.title ?? entry.exe ?? '').trim();
  if (!name) return null;
  const exe = String(entry.exe ?? '').trim();
  const rule = APP_RULES.some(item => item.id === entry.rule) ? entry.rule : 'ask';
  return { id: String(entry.id ?? `app-${index}`), name, exe, rule };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 页面的默认设置收敛成显示形状：字段缺、类型不对都回默认值，永远能画出来。 */
function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const budget = source.budget && typeof source.budget === 'object' ? source.budget : {};
  const overlay = source.overlay && typeof source.overlay === 'object' ? source.overlay : {};
  const memory = source.memory && typeof source.memory === 'object' ? source.memory : {};
  const advanced = source.advanced && typeof source.advanced === 'object' ? source.advanced : {};
  const denyExe = Array.isArray(advanced.denyExe)
    ? advanced.denyExe.map(item => String(item).trim()).filter(Boolean)
    : String(advanced.denyExe ?? '').split(/[\n,;，；]/).map(item => item.trim()).filter(Boolean);
  return {
    enabled: Boolean(source.enabled),
    permission: PERMISSIONS.some(item => item.id === source.permission) ? source.permission : DEFAULT_SETTINGS.permission,
    apps: Array.isArray(source.apps) ? source.apps.map(normalizeApp).filter(Boolean) : [],
    budget: {
      maxMinutes: MINUTE_CHOICES.includes(Number(budget.maxMinutes)) ? Number(budget.maxMinutes) : DEFAULT_SETTINGS.budget.maxMinutes,
      maxActions: clampNumber(Number(budget.maxActions ?? DEFAULT_SETTINGS.budget.maxActions), NUMBER_FIELDS['budget.maxActions']),
      maxVisionFrames: clampNumber(Number(budget.maxVisionFrames ?? DEFAULT_SETTINGS.budget.maxVisionFrames), NUMBER_FIELDS['budget.maxVisionFrames']),
    },
    overlay: {
      edgeGlow: true, // 安全设施：按 §12.7 固定开启，界面不提供关闭。
      highlight: overlay.highlight !== false,
      bubble: overlay.bubble !== false,
    },
    memory: { autoSkill: memory.autoSkill !== false },
    advanced: {
      uiaDepth: clampNumber(Number(advanced.uiaDepth ?? DEFAULT_SETTINGS.advanced.uiaDepth), NUMBER_FIELDS['advanced.uiaDepth']),
      timeoutMs: clampNumber(Number(advanced.timeoutMs ?? DEFAULT_SETTINGS.advanced.timeoutMs), NUMBER_FIELDS['advanced.timeoutMs']),
      denyExe,
      visionFallback: advanced.visionFallback !== false,
      grounderModel: String(advanced.grounderModel ?? ''),
      auditPath: String(advanced.auditPath ?? ''),
    },
  };
}

/* ── 两套形状的唯一换算点 ───────────────────────────────────────────── */

/** 页面里的应用规则 → policy.cjs 的 appKey（小写 exe）。
    没有扩展名时按 Windows 习惯补 .exe：appRule() 是拿 exe 比对规则的，裸名字永远命不中。 */
function appKeyOf(app) {
  const raw = String((app && (app.id || app.exe || app.name)) || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.includes('.') ? raw : `${raw}.exe`;
}

/** 主进程的 apps 映射（appKey → rule 或 {allow,vision,reason}）→ 页面数组。
    页面只显示得下 allow/ask/deny，其它形式（route-to-browser）先不列出来，写回时由调用方原样保留。 */
function appsFromMain(raw) {
  if (!isPlainObject(raw)) return [];
  const list = [];
  for (const [key, value] of Object.entries(raw)) {
    if (list.length >= 500) break;
    const rule = typeof value === 'string' ? value : value?.allow;
    if (!APP_RULES.some(item => item.id === rule)) continue;
    const name = String(key).trim();
    if (!name) continue;
    list.push({ id: name, name, exe: /\.exe$/i.test(name) ? name : '', rule });
  }
  return list;
}

/** 主进程形状（policy.cjs 的 DEFAULT_SETTINGS）→ 页面显示形状。 */
function fromMain(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const overlay = isPlainObject(source.overlay) ? source.overlay : {};
  const memory = isPlainObject(source.memory) ? source.memory : {};
  const advanced = isPlainObject(source.advanced) ? source.advanced : {};
  return normalizeSettings({
    enabled: source.enabled,
    permission: source.profile,
    apps: appsFromMain(source.apps),
    budget: source.budget,
    overlay: { highlight: overlay.targetOutline, bubble: overlay.bubbles },
    memory: { autoSkill: memory.auto },
    advanced: {
      uiaDepth: advanced.maxDepth,
      timeoutMs: advanced.treeTimeoutMs,
      denyExe: advanced.excludeProcesses,
      visionFallback: advanced.vision,
      grounderModel: advanced.groundingModel,
      auditPath: advanced.auditPath,
    },
  });
}

/**
 * 页面 patch → 主进程 patch。只发送 patch 里出现的分节，主进程按分节一层合并。
 *
 * apps 必须整份发：主进程只按 key 合并、删不掉键，所以「删掉的规则」显式写 null
 * （policy.normalizeSettings 会丢弃非法值，等于删除）。
 * baseApps 是主进程最近一次回包里的原始 apps，用来保住页面看不懂的规则形式，
 * 避免用户改一个开关就把 route-to-browser / {allow,vision,reason} 写坏。
 */
function toMainPatch(patch, prevApps, baseApps) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const main = {};
  if ('enabled' in source) main.enabled = Boolean(source.enabled);
  if ('permission' in source) main.profile = source.permission;

  if ('apps' in source) {
    const next = isPlainObject(baseApps) ? { ...baseApps } : {};
    const apps = Array.isArray(source.apps) ? source.apps : [];
    for (const app of apps) {
      const key = appKeyOf(app);
      if (!key) continue;
      const rule = APP_RULES.some(item => item.id === app.rule) ? app.rule : 'ask';
      const base = next[key];
      // 对象形式（{allow,vision,reason}）只改 allow，别把页面显示不了的 vision/reason 丢掉
      next[key] = isPlainObject(base) ? { ...base, allow: rule } : rule;
    }
    const kept = new Set(apps.map(appKeyOf));
    for (const app of Array.isArray(prevApps) ? prevApps : []) {
      const key = appKeyOf(app);
      if (key && !kept.has(key)) next[key] = null;
    }
    main.apps = next;
  }

  if ('budget' in source) {
    const budget = isPlainObject(source.budget) ? source.budget : {};
    main.budget = {};
    for (const key of ['maxMinutes', 'maxActions', 'maxVisionFrames']) {
      if (key in budget) main.budget[key] = budget[key];
    }
  }

  if ('overlay' in source) {
    const overlay = isPlainObject(source.overlay) ? source.overlay : {};
    main.overlay = {};
    if ('highlight' in overlay) main.overlay.targetOutline = overlay.highlight;
    if ('bubble' in overlay) main.overlay.bubbles = overlay.bubble;
    // edgeGlow 是安全设施，界面只读，不回写
  }

  if ('memory' in source) {
    const memory = isPlainObject(source.memory) ? source.memory : {};
    main.memory = {};
    if ('autoSkill' in memory) main.memory.auto = memory.autoSkill;
  }

  if ('advanced' in source) {
    const advanced = isPlainObject(source.advanced) ? source.advanced : {};
    const names = {
      uiaDepth: 'maxDepth',
      timeoutMs: 'treeTimeoutMs',
      denyExe: 'excludeProcesses',
      visionFallback: 'vision',
      grounderModel: 'groundingModel',
      auditPath: 'auditPath',
    };
    main.advanced = {};
    for (const [pageKey, mainKey] of Object.entries(names)) {
      if (pageKey in advanced) main.advanced[mainKey] = advanced[pageKey];
    }
  }

  return main;
}

/* desktop.status() 的字段在主进程可能还没定稿，这里按已知的几种写法归并。 */
function readStatus(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const engine = state.engine && typeof state.engine === 'object' ? state.engine : {};
  const available = Boolean(state.available ?? engine.available);
  const reason = String(state.reason ?? engine.reason ?? '').trim();

  const worker = state.worker;
  let workerReady = false;
  let workerNote = '';
  if (typeof worker === 'boolean') workerReady = worker;
  else if (typeof worker === 'string') workerReady = worker === 'ready';
  else if (worker && typeof worker === 'object') {
    workerReady = Boolean(worker.ready) || worker.status === 'ready';
    if (worker.status === 'starting') workerNote = '正在启动';
    if (Number(worker.restartCount) > 0) workerNote = `重启 ${Number(worker.restartCount)} 次`;
  }
  let workerText;
  if (!available) workerText = '不可用（引擎未就绪）';
  else if (workerReady) workerText = workerNote ? `常驻 worker 就绪（${workerNote}）` : '常驻 worker 就绪';
  else workerText = workerNote ? `常驻 worker ${workerNote}` : '常驻 worker 未就绪，只能走视觉兜底';

  const session = state.session;
  let sessionActive = false;
  let sessionText = '空闲';
  if (typeof session === 'string') {
    sessionActive = RUNNING_SESSIONS.has(session);
    sessionText = SESSION_LABELS[session] ?? (sessionActive ? '正在操作这台电脑' : '空闲');
  } else if (session && typeof session === 'object') {
    const key = String(session.status ?? session.state ?? '');
    sessionActive = Boolean(session.active ?? session.running) || RUNNING_SESSIONS.has(key);
    sessionText = SESSION_LABELS[key] ?? (sessionActive ? '正在操作这台电脑' : '空闲');
  } else if (typeof state.active === 'boolean') {
    sessionActive = state.active;
    sessionText = sessionActive ? '正在操作这台电脑' : '空闲';
  }

  return {
    available,
    reason,
    engineText: available ? '可用' : (reason ? `不可用：${reason}` : '不可用'),
    workerReady,
    workerText,
    sessionActive,
    sessionText,
  };
}

function formatRate(skill) {
  const rate = Number(skill.successRate ?? skill.rate);
  if (Number.isFinite(rate)) return `成功率 ${Math.round(rate <= 1 ? rate * 100 : rate)}%`;
  const hits = Number(skill.hits ?? skill.success);
  const total = Number(skill.attempts ?? skill.total);
  if (Number.isFinite(hits) && Number.isFinite(total) && total > 0) return `成功率 ${Math.round((hits / total) * 100)}%`;
  return '成功率未知';
}

function formatLastUsed(skill) {
  const raw = skill.lastUsedAt ?? skill.lastUsed ?? skill.updatedAt;
  if (!raw) return '最近使用未知';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return `最近使用 ${String(raw)}`;
  return `最近使用 ${date.toLocaleDateString('zh-CN')}`;
}

/* ── 页面骨架 ───────────────────────────────────────────────────────── */

function renderShell() {
  return `
  <div class="desktop-settings" data-desktop-root>
    <p class="memory-banner" data-slot="channel" role="status" hidden>桌面操作通道不可用：这里显示的是本地默认值，改动不会保存；桌面工具在调用时会直接返回「未授权」。</p>
    <p class="memory-error" data-slot="error" role="alert" hidden></p>

    <section class="settings-section" aria-labelledby="desktop-status-title">
      <h3 class="settings-section-title" id="desktop-status-title">状态</h3>
      <div class="settings-card desktop-settings-status">
        <dl class="desktop-settings-status-list">
          <div class="desktop-settings-status-item">
            <dt>引擎</dt>
            <dd><i class="desktop-settings-dot" data-slot="dot-engine" data-state="off" aria-hidden="true"></i><span data-slot="engine">读取中…</span></dd>
          </div>
          <div class="desktop-settings-status-item">
            <dt>UIA 通道</dt>
            <dd><i class="desktop-settings-dot" data-slot="dot-worker" data-state="off" aria-hidden="true"></i><span data-slot="worker">读取中…</span></dd>
          </div>
          <div class="desktop-settings-status-item">
            <dt>当前操作</dt>
            <dd><i class="desktop-settings-dot" data-slot="dot-session" data-state="off" aria-hidden="true"></i><span data-slot="session">读取中…</span></dd>
          </div>
        </dl>
        <div class="desktop-settings-status-action">
          <button type="button" class="settings-button desktop-settings-stop" data-action="stop" aria-label="立即停止桌面操作" disabled>
            <i class="ph ph-square" aria-hidden="true"></i><span>立即停止</span>
          </button>
        </div>
      </div>
      <p class="memory-muted">长按 Ctrl+Shift 约 0.6 秒也能终止；停止后会立即释放按键与鼠标，屏幕上的浮层同时消失。</p>
    </section>

    <section class="settings-section" aria-labelledby="desktop-permission-title">
      <h3 class="settings-section-title" id="desktop-permission-title">权限</h3>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text">
            <strong>允许 Mova 操作这台电脑</strong>
            <p id="desktop-allow-note" data-slot="allow-note">关闭时桌面工具直接返回「未授权」：不读窗口、不截图、不注入任何输入。</p>
          </div>
          <button type="button" class="settings-switch" role="switch" aria-checked="false" aria-label="允许 Mova 操作这台电脑"
            aria-describedby="desktop-allow-note" data-action="toggle-allow" data-needs-channel><span></span></button>
        </div>
      </div>
      <div class="settings-card">
        <div class="desktop-settings-tier-head">
          <div class="settings-row-text">
            <strong>默认权限级别</strong>
            <p>只决定「哪些动作不用每次问你」；敏感操作永远强制交给你。</p>
          </div>
        </div>
        <div class="desktop-settings-tiers" role="radiogroup" aria-label="默认权限级别">
          ${PERMISSIONS.map(tier => `<button type="button" role="radio" class="settings-choice" aria-checked="false"
            data-action="permission" data-permission="${tier.id}" data-needs-channel>
            <span class="settings-choice-dot" aria-hidden="true"></span>
            <span class="settings-choice-text"><strong>${tier.label}</strong><span>${tier.note}</span></span>
          </button>`).join('')}
        </div>
      </div>
      <p class="memory-muted">按风险分级：R0 读取默认允许；R1 轻交互、R2 常规交互按级别放行；R3 提交类每次审批；R4 敏感动作（支付、删除账户、改密码、UAC）不允许自动执行。</p>
    </section>

    <section class="settings-section" aria-labelledby="desktop-apps-title">
      <div class="desktop-settings-section-head">
        <h3 class="settings-section-title" id="desktop-apps-title">应用规则</h3>
        <span class="settings-section-note">未列出的应用按默认权限级别处理</span>
      </div>
      <div class="settings-card desktop-settings-apps">
        <div data-slot="apps"></div>
        <form class="desktop-settings-app-form" data-slot="app-form" hidden>
          <input class="desktop-settings-input" type="text" name="app" autocomplete="off" spellcheck="false"
            aria-label="应用名或进程名" placeholder="应用名或进程名，例如 Excel 或 EXCEL.EXE" data-needs-channel>
          <button type="submit" class="settings-button primary">添加</button>
          <button type="button" class="settings-button" data-action="cancel-app">取消</button>
        </form>
        <button type="button" class="settings-add" data-action="add-app" aria-expanded="false" data-needs-channel>
          <i class="ph ph-plus" aria-hidden="true"></i><span>添加应用</span>
        </button>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="desktop-budget-title">
      <h3 class="settings-section-title" id="desktop-budget-title">会话预算</h3>
      <p class="memory-muted">任一上限用尽，会话就结束并如实报告；不会悄悄续期。</p>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text"><strong>单次最长时长</strong><p>到点即停，正在执行的单个动作允许跑完再收尾。</p></div>
          <select class="settings-select" data-field="budget.maxMinutes" aria-label="单次最长时长（分钟）" data-needs-channel>
            ${MINUTE_CHOICES.map(minutes => `<option value="${minutes}">${minutes} 分钟</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><strong>最多动作数</strong><p>点击、输入、快捷键、滚动都算一次动作。</p></div>
          <div class="settings-inline-control">
            <input class="desktop-settings-number" type="number" min="5" max="300" step="1"
              data-field="budget.maxActions" aria-label="最多动作数" data-needs-channel>
            <span class="settings-section-note">次</span>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><strong>最多视觉帧数</strong><p>结构化通道失效时才截图，超过这个数直接交给你。</p></div>
          <div class="settings-inline-control">
            <input class="desktop-settings-number" type="number" min="0" max="60" step="1"
              data-field="budget.maxVisionFrames" aria-label="最多视觉帧数" data-needs-channel>
            <span class="settings-section-note">帧</span>
          </div>
        </div>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="desktop-overlay-title">
      <h3 class="settings-section-title" id="desktop-overlay-title">浮层</h3>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text">
            <strong>显示边缘呼吸光</strong>
            <p id="desktop-glow-note">屏幕左下角「Mova 正在操作」的安全设施，按设计固定开启，不提供关闭。</p>
          </div>
          <button type="button" class="settings-switch" role="switch" aria-checked="true" aria-label="显示边缘呼吸光"
            aria-describedby="desktop-glow-note" disabled><span></span></button>
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <strong>显示目标控件描边</strong>
            <p>真实点击或输入前给目标控件套一圈描边，让你看清它点的是哪一块；后台 Pattern 调用不画。</p>
          </div>
          <button type="button" class="settings-switch" role="switch" aria-checked="true" aria-label="显示目标控件描边"
            data-action="toggle-highlight" data-needs-channel><span></span></button>
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <strong>显示气泡</strong>
            <p>用一句话说明正在做什么，最多三条，旧的自动淡出。</p>
          </div>
          <button type="button" class="settings-switch" role="switch" aria-checked="true" aria-label="显示气泡"
            data-action="toggle-bubble" data-needs-channel><span></span></button>
        </div>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="desktop-memory-title">
      <h3 class="settings-section-title" id="desktop-memory-title">记忆</h3>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text"><strong>自动记住桌面技能</strong><p>只保存通过验证的成功轨迹；失败轨迹不留档。</p></div>
          <button type="button" class="settings-switch" role="switch" aria-checked="true" aria-label="自动记住桌面技能"
            data-action="toggle-auto-skill" data-needs-channel><span></span></button>
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <strong>桌面技能</strong>
            <p data-slot="skills-summary">查看已记住的流程、成功率与最近使用时间。</p>
          </div>
          <div class="settings-inline-control">
            <button type="button" class="settings-button" data-action="toggle-skills" aria-expanded="false"
              aria-controls="desktop-skills" data-needs-channel>查看技能</button>
            <button type="button" class="settings-button danger" data-action="clear-elements" data-needs-channel>清空元素记忆</button>
          </div>
        </div>
      </div>
      <div class="settings-card desktop-settings-skills" id="desktop-skills" data-slot="skills" aria-label="桌面技能列表" hidden></div>
    </section>

    <details class="settings-section settings-advanced">
      <summary class="desktop-settings-summary" aria-expanded="false">高级</summary>
      <p class="memory-muted">默认折叠。这些值直接决定运行时行为，改动对下一次操作生效，没有单独的保存按钮。</p>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text"><strong>UIA 树深度</strong><p>越深越完整也越慢；默认 6 层，深树应用建议配合进程排除名单。</p></div>
          <div class="settings-inline-control">
            <input class="desktop-settings-number" type="number" min="1" max="12" step="1"
              data-field="advanced.uiaDepth" aria-label="UIA 树深度" data-needs-channel>
            <span class="settings-section-note">层</span>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><strong>单动作超时</strong><p>一次点击或输入的最长等待时间，超时中止该动作并释放按键。</p></div>
          <div class="settings-inline-control">
            <input class="desktop-settings-number" type="number" min="200" max="15000" step="500"
              data-field="advanced.timeoutMs" aria-label="单动作超时（毫秒）" data-needs-channel>
            <span class="settings-section-note">毫秒</span>
          </div>
        </div>
        <div class="settings-row desktop-settings-row-stack">
          <div class="settings-row-text">
            <strong>进程排除名单</strong>
            <p>每行一个 exe，命中后不读取、不操作（密码管理器、银行客户端等）。</p>
          </div>
          <textarea class="desktop-settings-textarea" rows="3" spellcheck="false"
            data-field="advanced.denyExe" aria-label="进程排除名单，每行一个 exe"
            placeholder="1password.exe&#10;keepass.exe" data-needs-channel></textarea>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><strong>视觉兜底</strong><p>结构化通道认不出控件时，允许截图交给接地模型定位。</p></div>
          <button type="button" class="settings-switch" role="switch" aria-checked="true" aria-label="视觉兜底"
            data-action="toggle-vision" data-needs-channel><span></span></button>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><strong>接地模型名</strong><p>留给「看图找坐标」的模型；留空则用当前对话的模型。</p></div>
          <input class="desktop-settings-input desktop-settings-input-narrow" type="text" autocomplete="off" spellcheck="false"
            data-field="advanced.grounderModel" aria-label="接地模型名" placeholder="留空使用当前模型" data-needs-channel>
        </div>
        <div class="settings-row desktop-settings-row-stack">
          <div class="settings-row-text"><strong>审计日志</strong><p>每次桌面动作的只读记录，由主进程写入，路径不可修改。</p></div>
          <div class="desktop-settings-audit">
            <span class="settings-path desktop-settings-path" data-slot="audit-path">主进程尚未提供日志路径</span>
            <button type="button" class="settings-button" data-action="open-audit">打开所在文件夹</button>
          </div>
        </div>
      </div>
    </details>

    <section class="settings-section desktop-settings-danger" aria-labelledby="desktop-reset-title">
      <h3 class="settings-section-title" id="desktop-reset-title">重置</h3>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text">
            <strong>重置所有桌面操作设置</strong>
            <p>授权回到关闭、权限回到「标准」，应用规则、预算、浮层与高级项恢复默认；正在进行的操作不会被顺带停止，请先点「立即停止」。已记住的技能与元素记忆不受影响。</p>
          </div>
          <button type="button" class="settings-button danger" data-action="reset" data-needs-channel>重置…</button>
        </div>
      </div>
    </section>
  </div>`;
}

/* ── 控制器 ─────────────────────────────────────────────────────────── */

function createController(panel) {
  const state = {
    settings: clone(DEFAULT_SETTINGS),
    error: '',
    status: null,
    statusError: '',
    statusLoaded: false,
    skills: [],
    skillsState: 'idle',
    skillsOpen: false,
  };
  let root = null;
  let timer = 0;
  // 主进程最近一次回包的原始 apps 映射：写回时用它保住页面显示不了的规则形式。
  let serverApps = null;
  // 列表只在数据真的变了时重建，避免每次开关/状态刷新都把焦点和 hover 甩掉。
  let paintedAppsKey = '';
  let paintedSkillsKey = '';

  function bridge() {
    return window.movaDesktop?.desktop ?? null;
  }

  /* 两种契约写法都认：desktop.getSettings/setSettings，或 desktop.settings.get/set。
     两者都缺失就返回 null —— 页面转成只读并显示「通道不可用」，不抛错。 */
  function settingsApi() {
    const desktop = bridge();
    if (!desktop) return null;
    if (typeof desktop.getSettings === 'function' && typeof desktop.setSettings === 'function') {
      return {
        get: () => desktop.getSettings(),
        set: patch => desktop.setSettings(patch),
        reset: typeof desktop.resetSettings === 'function' ? () => desktop.resetSettings() : null,
      };
    }
    const nested = desktop.settings;
    if (typeof nested?.get === 'function' && typeof nested?.set === 'function') {
      return {
        get: () => nested.get(),
        set: patch => nested.set(patch),
        reset: typeof nested?.reset === 'function' ? () => nested.reset() : null,
      };
    }
    return null;
  }

  /* 读写设置都有的才叫「通道可用」；只有 stop 的桥不算。 */
  function channel() {
    return settingsApi();
  }

  function canStop() {
    return typeof bridge()?.stop === 'function';
  }

  function slot(name) {
    return root?.querySelector(`[data-slot="${name}"]`) ?? null;
  }

  function setStatusRow(name, text, dotState) {
    const textNode = slot(name);
    if (textNode) textNode.textContent = text;
    const dot = slot(`dot-${name}`);
    if (dot) dot.dataset.state = dotState;
  }

  function setInput(selector, value) {
    const node = root?.querySelector(selector);
    if (!node || document.activeElement === node) return;
    node.value = value === undefined || value === null ? '' : String(value);
  }

  function setSwitch(action, checked) {
    root?.querySelector(`[data-action="${action}"]`)?.setAttribute('aria-checked', String(Boolean(checked)));
  }

  /* 通道不可用（没有 Electron 桥）时，所有会写主进程的控件统一禁用，只留说明与折叠。 */
  function applyChannelDisabled() {
    if (!root) return;
    const disabled = !channel();
    for (const node of root.querySelectorAll('[data-needs-channel]')) node.disabled = disabled;
  }

  function sw(action) {
    return root?.querySelector(`[data-action="${action}"]`) ?? null;
  }

  /* ── 状态 ── */

  function paintStatus() {
    if (!root) return;
    const connected = Boolean(bridge());
    const status = state.status;
    if (!connected) {
      setStatusRow('engine', '不可用 · 当前没有桌面操作通道', 'off');
      setStatusRow('worker', '不可用', 'off');
      setStatusRow('session', '未在操作', 'off');
    } else if (!state.statusLoaded) {
      setStatusRow('engine', '读取中…', 'off');
      setStatusRow('worker', '读取中…', 'off');
      setStatusRow('session', '读取中…', 'off');
    } else if (!status) {
      setStatusRow('engine', state.statusError ? `未知：${state.statusError}` : '未知（主进程未提供状态接口）', 'off');
      setStatusRow('worker', '未知', 'off');
      setStatusRow('session', '未知', 'off');
    } else {
      setStatusRow('engine', status.engineText, status.available ? 'ok' : 'error');
      setStatusRow('worker', status.workerText, status.workerReady ? 'ok' : 'off');
      setStatusRow('session', status.sessionText, status.sessionActive ? 'busy' : 'off');
    }
    const stop = sw('stop');
    if (stop) stop.disabled = !canStop();
  }

  /* ── 应用规则 ── */

  function appRow(app) {
    const name = escapeHtml(app.name);
    const rules = APP_RULES.map(rule => `<button type="button" data-action="app-rule" data-app-id="${escapeHtml(app.id)}"
      data-rule="${rule.id}" aria-pressed="${app.rule === rule.id}" aria-label="${name}：${rule.label}" data-needs-channel>${rule.label}</button>`).join('');
    return `<div class="desktop-settings-app">
      <div class="desktop-settings-app-main">
        <strong>${name}</strong>${app.exe ? `<small>${escapeHtml(app.exe)}</small>` : ''}
      </div>
      <div class="desktop-settings-segment" role="group" aria-label="${name} 的规则">${rules}</div>
      <button type="button" class="settings-button danger" data-action="remove-app" data-app-id="${escapeHtml(app.id)}"
        aria-label="删除 ${name} 的规则" data-needs-channel>删除</button>
    </div>`;
  }

  function paintApps() {
    const host = slot('apps');
    if (!host) return;
    const apps = state.settings.apps;
    const key = JSON.stringify(apps);
    if (key !== paintedAppsKey) {
      paintedAppsKey = key;
      host.innerHTML = apps.length
        ? apps.map(appRow).join('')
        : `<div class="memory-empty"><p>还没有应用规则，未列出的应用按默认权限级别处理。</p></div>`;
    }
    applyChannelDisabled();
  }

  function openAppForm() {
    const form = root?.querySelector('[data-slot="app-form"]');
    if (!form) return;
    form.hidden = false;
    sw('add-app')?.setAttribute('aria-expanded', 'true');
    const input = form.querySelector('input[name="app"]');
    if (input) { input.value = ''; input.focus(); }
  }

  function closeAppForm() {
    const form = root?.querySelector('[data-slot="app-form"]');
    if (!form) return;
    form.hidden = true;
    sw('add-app')?.setAttribute('aria-expanded', 'false');
    sw('add-app')?.focus();
  }

  /* ── 技能 ── */

  function skillApi() {
    const desktop = bridge();
    // preload 暴露的是 desktop.skills()（函数）+ desktop.removeSkill()；
    // 老写法 skills.list() / listSkills() 也留着，两种都认。
    if (typeof desktop?.skills === 'function') {
      return {
        list: () => desktop.skills(),
        remove: typeof desktop.removeSkill === 'function' ? id => desktop.removeSkill(id) : null,
      };
    }
    if (typeof desktop?.skills?.list === 'function') {
      return {
        list: () => desktop.skills.list(),
        remove: typeof desktop.skills.remove === 'function' ? id => desktop.skills.remove(id) : null,
      };
    }
    if (typeof desktop?.listSkills === 'function') {
      return {
        list: () => desktop.listSkills(),
        remove: typeof desktop.removeSkill === 'function' ? id => desktop.removeSkill(id) : null,
      };
    }
    return null;
  }

  function skillRow(skill) {
    const title = String(skill.title ?? skill.name ?? '未命名技能');
    const meta = [String(skill.app ?? skill.appKey ?? '未知应用'), formatRate(skill), formatLastUsed(skill)].join(' · ');
    return `<div class="desktop-settings-skill">
      <div class="desktop-settings-skill-main">
        <strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta)}</small>
      </div>
      <button type="button" class="settings-button danger" data-action="remove-skill" data-skill-id="${escapeHtml(skill.id)}"
        aria-label="删除技能 ${escapeHtml(title)}" data-needs-channel>删除</button>
    </div>`;
  }

  function paintSkills() {
    const host = slot('skills');
    const toggle = sw('toggle-skills');
    if (!host) return;
    host.hidden = !state.skillsOpen;
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(state.skillsOpen));
      toggle.textContent = state.skillsOpen ? '收起技能' : '查看技能';
    }
    const summary = slot('skills-summary');
    if (summary) {
      summary.textContent = state.skillsState === 'ready' && state.skills.length
        ? `已记住 ${state.skills.length} 个技能，可以查看或删除。`
        : '查看已记住的流程、成功率与最近使用时间。';
    }
    const key = JSON.stringify([state.skillsOpen, state.skillsState, state.skills]);
    if (key !== paintedSkillsKey) {
      paintedSkillsKey = key;
      if (!state.skillsOpen) host.innerHTML = '';
      else if (state.skillsState === 'loading') host.innerHTML = '<div class="memory-empty"><p>正在读取桌面技能…</p></div>';
      else if (state.skillsState === 'error') host.innerHTML = '<div class="memory-empty"><p>技能列表读取失败，稍后再打开一次试试。</p></div>';
      else if (!state.skills.length) {
        const text = skillApi()
          ? '还没有记住的桌面技能。完成一次操作后可保存为技能，下次一步重放。'
          : '桌面操作通道不可用，读不到技能列表。';
        host.innerHTML = `<div class="memory-empty"><p>${text}</p></div>`;
      } else {
        host.innerHTML = state.skills.map(skillRow).join('');
      }
    }
    applyChannelDisabled();
  }

  async function loadSkills() {
    const api = skillApi();
    state.skillsState = 'loading';
    paintSkills();
    if (!api) {
      state.skills = [];
      state.skillsState = 'ready';
      paintSkills();
      return;
    }
    try {
      const raw = unwrap(await api.list());
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.skills) ? raw.skills : [];
      state.skills = list.map((skill, index) => ({ ...skill, id: skill?.id ?? `skill-${index}` }));
      state.skillsState = 'ready';
    } catch (reason) {
      state.skills = [];
      state.skillsState = 'error';
      notify(reason?.message || '技能列表读取失败', { tone: 'error' });
    }
    paintSkills();
  }

  async function toggleSkills() {
    state.skillsOpen = !state.skillsOpen;
    paintSkills();
    if (state.skillsOpen && (state.skillsState === 'idle' || state.skillsState === 'error')) await loadSkills();
  }

  async function removeSkill(id) {
    const api = skillApi();
    if (!api?.remove) { notify('当前版本的主进程还不支持删除技能', { tone: 'error' }); return; }
    try {
      unwrap(await api.remove(id));
      state.skills = state.skills.filter(skill => String(skill.id) !== String(id));
      paintSkills();
      notify('技能已删除');
    } catch (reason) {
      notify(reason?.message || '删除技能失败', { tone: 'error' });
    }
  }

  /* ── 设置读写 ── */

  async function updateSettings(patch, successMessage) {
    const api = channel();
    const previous = clone(state.settings);
    state.settings = normalizeSettings(mergePatch(state.settings, patch));
    paint();
    if (!api) {
      notify('桌面操作通道不可用，改动没有保存', { tone: 'error' });
      return false;
    }
    try {
      // 显示用字段名 → 主进程字段名；回包是主进程归一化后的真相，拿回来重新画。
      const raw = unwrap(await api.set(toMainPatch(patch, previous.apps, serverApps)));
      if (raw) {
        state.settings = fromMain(raw);
        serverApps = isPlainObject(raw.apps) ? raw.apps : serverApps;
      }
      state.error = '';
      paint();
      if (successMessage) notify(successMessage);
      return true;
    } catch (reason) {
      state.settings = previous;
      state.error = reason?.message || '保存桌面操作设置失败';
      paint();
      notify(state.error, { tone: 'error' });
      return false;
    }
  }

  async function addApp(rawName) {
    const name = String(rawName ?? '').trim();
    if (!name) return;
    const exists = state.settings.apps.some(app => app.name.toLowerCase() === name.toLowerCase());
    if (exists) { notify(`已经有「${name}」的规则`, { tone: 'error' }); return; }
    const key = appKeyOf(name);
    const app = {
      id: key, // 主进程的 appKey：小写 exe，规则按它比对
      name,
      exe: /\.exe$/i.test(name) ? name : key,
      rule: 'ask',
    };
    await updateSettings({ apps: [...state.settings.apps, app].map(toSavableApp) }, `已添加应用规则：${name}`);
  }

  async function setAppRule(id, rule) {
    if (!APP_RULES.some(item => item.id === rule)) return;
    const apps = state.settings.apps.map(app => (app.id === id ? { ...app, rule } : app));
    await updateSettings({ apps: apps.map(toSavableApp) });
  }

  async function removeApp(id) {
    const apps = state.settings.apps.filter(app => app.id !== id);
    await updateSettings({ apps: apps.map(toSavableApp) }, '已删除应用规则');
  }

  /* ── 危险 / 维护动作 ── */

  async function stopNow() {
    const desktop = bridge();
    if (typeof desktop?.stop !== 'function') { notify('当前版本还不支持「立即停止」', { tone: 'error' }); return; }
    const stop = sw('stop');
    if (stop) stop.disabled = true;
    try {
      unwrap(await desktop.stop());
      notify('已请求停止：按键与鼠标会立即释放');
    } catch (reason) {
      notify(reason?.message || '停止失败', { tone: 'error' });
    }
    state.statusLoaded = false;
    await refreshStatus();
  }

  async function clearElements() {
    const desktop = bridge();
    const clear = typeof desktop?.clearElements === 'function'
      ? () => desktop.clearElements()
      : typeof desktop?.elements?.clear === 'function' ? () => desktop.elements.clear() : null;
    const confirmed = await confirmAction({
      title: '清空元素记忆？',
      body: 'Mova 会忘掉控件的稳定定位线索，下次操作同样的界面要重新识别。',
      detail: '桌面技能与审计日志不受影响；这个操作不可撤销。',
      confirmLabel: '清空',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (!clear) { notify('当前版本的主进程还不支持清空元素记忆', { tone: 'error' }); return; }
    try {
      unwrap(await clear());
      notify('元素记忆已清空');
    } catch (reason) {
      notify(reason?.message || '清空元素记忆失败', { tone: 'error' });
    }
  }

  async function openAudit() {
    const desktop = bridge();
    const open = typeof desktop?.openAuditFolder === 'function'
      ? () => desktop.openAuditFolder()
      : typeof desktop?.revealAudit === 'function' ? () => desktop.revealAudit() : null;
    if (!open) { notify('当前版本的主进程还不支持打开审计目录', { tone: 'error' }); return; }
    try {
      unwrap(await open());
    } catch (reason) {
      notify(reason?.message || '无法打开审计目录', { tone: 'error' });
    }
  }

  async function resetAll() {
    const api = channel();
    const confirmed = await confirmAction({
      title: '重置所有桌面操作设置？',
      body: '授权会关闭，权限回到「标准」，应用规则、会话预算、浮层与高级项恢复默认。',
      detail: '正在进行的操作不会被顺带停止，请先点「立即停止」。已记住的技能与元素记忆不受影响。',
      confirmLabel: '重置',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (!api) { notify('桌面操作通道不可用，无法重置', { tone: 'error' }); return; }
    try {
      // 没有 resetSettings 通道就用默认值整份写一遍：apps 传空数组，
      // 映射时会把旧规则逐个置 null（主进程一层合并删不掉键）。
      const raw = api.reset
        ? await api.reset()
        : await api.set(toMainPatch(clone(DEFAULT_SETTINGS), state.settings.apps, serverApps));
      const next = unwrap(raw);
      state.settings = next ? fromMain(next) : normalizeSettings(DEFAULT_SETTINGS);
      serverApps = isPlainObject(next?.apps) ? next.apps : null;
      state.error = '';
      paint();
      notify('已重置桌面操作设置');
    } catch (reason) {
      state.error = reason?.message || '重置失败';
      paint();
      notify(state.error, { tone: 'error' });
    }
  }

  /* ── 读状态 ── */

  async function refreshStatus() {
    const desktop = bridge();
    if (!desktop) {
      state.status = null;
      state.statusError = '';
      state.statusLoaded = true;
      paintStatus();
      return;
    }
    const read = typeof desktop.getStatus === 'function'
      ? () => desktop.getStatus()
      : typeof desktop.status === 'function' ? () => desktop.status() : null;
    if (!read) {
      state.status = null;
      state.statusError = '';
      state.statusLoaded = true;
      paintStatus();
      return;
    }
    try {
      state.status = readStatus(unwrap(await read()));
      state.statusError = '';
    } catch (reason) {
      state.status = null;
      state.statusError = reason?.message || '读取状态失败';
    }
    state.statusLoaded = true;
    paintStatus();
  }

  async function loadSettings() {
    const api = channel();
    if (!api) {
      state.settings = normalizeSettings(DEFAULT_SETTINGS);
      paint();
      return;
    }
    try {
      const raw = unwrap(await api.get());
      state.settings = fromMain(raw);   // 主进程形状 → 页面形状（唯一换算点）
      serverApps = isPlainObject(raw?.apps) ? raw.apps : null;
      state.error = '';
    } catch (reason) {
      state.settings = normalizeSettings(DEFAULT_SETTINGS);
      state.error = reason?.message || '读取桌面操作设置失败';
    }
    paint();
  }

  /* ── 渲染 ── */

  function paint() {
    if (!root) return;
    const settings = state.settings;
    const desktop = channel();

    const banner = slot('channel');
    if (banner) banner.hidden = Boolean(desktop);
    const errorNode = slot('error');
    if (errorNode) {
      errorNode.hidden = !state.error;
      errorNode.textContent = state.error;
    }

    setSwitch('toggle-allow', settings.enabled);
    setSwitch('toggle-highlight', settings.overlay.highlight);
    setSwitch('toggle-bubble', settings.overlay.bubble);
    setSwitch('toggle-auto-skill', settings.memory.autoSkill);
    setSwitch('toggle-vision', settings.advanced.visionFallback);

    const allowNote = slot('allow-note');
    if (allowNote) {
      allowNote.textContent = settings.enabled
        ? '已允许：Mova 可以读取窗口并注入操作；审批、审计和随时停止照常生效。'
        : '关闭时桌面工具直接返回「未授权」：不读窗口、不截图、不注入任何输入。';
    }

    for (const button of root.querySelectorAll('[data-action="permission"]')) {
      const active = button.dataset.permission === settings.permission;
      button.setAttribute('aria-checked', String(active));
      button.querySelector('.settings-choice-dot')?.setAttribute('data-checked', String(active));
    }

    setInput('[data-field="budget.maxMinutes"]', settings.budget.maxMinutes);
    setInput('[data-field="budget.maxActions"]', settings.budget.maxActions);
    setInput('[data-field="budget.maxVisionFrames"]', settings.budget.maxVisionFrames);
    setInput('[data-field="advanced.uiaDepth"]', settings.advanced.uiaDepth);
    setInput('[data-field="advanced.timeoutMs"]', settings.advanced.timeoutMs);
    setInput('[data-field="advanced.denyExe"]', settings.advanced.denyExe.join('\n'));
    setInput('[data-field="advanced.grounderModel"]', settings.advanced.grounderModel);

    const path = slot('audit-path');
    if (path) {
      path.textContent = settings.advanced.auditPath || '主进程尚未提供日志路径';
      path.title = settings.advanced.auditPath || '';
    }

    paintApps();
    paintSkills();
    paintStatus();
    applyChannelDisabled();
  }

  /* ── 事件 ── */

  function onClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || !root?.contains(target)) return;
    const action = target.dataset.action;
    switch (action) {
      case 'stop': void stopNow(); break;
      case 'toggle-allow': void updateSettings({ enabled: target.getAttribute('aria-checked') !== 'true' }); break;
      // 页面 patch 用显示名 permission，由 toMainPatch 换成主进程的 profile
      case 'permission': void updateSettings({ permission: target.dataset.permission }); break;
      case 'add-app': openAppForm(); break;
      case 'cancel-app': closeAppForm(); break;
      case 'app-rule': void setAppRule(target.dataset.appId, target.dataset.rule); break;
      case 'remove-app': void removeApp(target.dataset.appId); break;
      case 'toggle-skills': void toggleSkills(); break;
      case 'remove-skill': void removeSkill(target.dataset.skillId); break;
      case 'toggle-highlight': void updateSettings({ overlay: { highlight: target.getAttribute('aria-checked') !== 'true' } }); break;
      case 'toggle-bubble': void updateSettings({ overlay: { bubble: target.getAttribute('aria-checked') !== 'true' } }); break;
      case 'toggle-auto-skill': void updateSettings({ memory: { autoSkill: target.getAttribute('aria-checked') !== 'true' } }); break;
      case 'toggle-vision': void updateSettings({ advanced: { visionFallback: target.getAttribute('aria-checked') !== 'true' } }); break;
      case 'clear-elements': void clearElements(); break;
      case 'open-audit': void openAudit(); break;
      case 'reset': void resetAll(); break;
      default: break;
    }
  }

  function onSubmit(event) {
    const form = event.target instanceof Element ? event.target.closest('[data-slot="app-form"]') : null;
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('input[name="app"]');
    const name = input ? input.value.trim() : '';
    if (!name) { input?.focus(); return; }
    closeAppForm();
    void addApp(name);
  }

  function onChange(event) {
    const node = event.target;
    const field = node?.dataset?.field;
    if (!field) return;
    if (node.tagName === 'SELECT') {
      void updateSettings(patchFor(field, Number(node.value)));
      return;
    }
    if (node.type === 'number') {
      const config = NUMBER_FIELDS[field] ?? { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true };
      const parsed = Number(node.value);
      const fallback = Number(readPath(state.settings, field));
      const value = clampNumber(Number.isFinite(parsed) && node.value !== '' ? parsed : fallback, config);
      node.value = String(value);
      void updateSettings(patchFor(field, value));
      return;
    }
    if (field === 'advanced.denyExe') {
      const list = node.value.split(/[\n,;，；]/).map(item => item.trim()).filter(Boolean);
      void updateSettings(patchFor(field, Array.from(new Set(list))));
      return;
    }
    void updateSettings(patchFor(field, node.value.trim()));
  }

  function onKeydown(event) {
    const target = event.target instanceof Element ? event.target : null;
    // 单选组按方向键移动：三选一是 radiogroup，键盘用户不该被迫多次 Tab。
    if (target?.dataset?.action === 'permission' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const buttons = [...root.querySelectorAll('[data-action="permission"]')];
      const index = buttons.indexOf(target);
      if (index >= 0) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
        const next = buttons[(index + step + buttons.length) % buttons.length];
        next.focus();
        void updateSettings({ permission: next.dataset.permission });
      }
      return;
    }
    if (event.key !== 'Escape') return;
    const form = root?.querySelector('[data-slot="app-form"]');
    if (!form || form.hidden) return;
    event.stopPropagation();
    closeAppForm();
  }

  function tick() {
    if (!root?.isConnected || panel.hidden || document.hidden) return;
    void refreshStatus();
  }

  return {
    panel,
    start() {
      panel.innerHTML = renderShell();
      // 图标是运行时插入的，启动时那次静态替换不会覆盖它。
      replaceStaticIcons(panel);
      root = panel.querySelector('[data-desktop-root]');
      if (!root) return;
      root.addEventListener('click', onClick);
      root.addEventListener('submit', onSubmit);
      root.addEventListener('change', onChange);
      root.addEventListener('keydown', onKeydown);
      const details = root.querySelector('details.settings-advanced');
      const summary = details?.querySelector('summary');
      details?.addEventListener('toggle', () => summary?.setAttribute('aria-expanded', String(details.open)));
      paint();
      void loadSettings();
      void refreshStatus();
      timer = window.setInterval(tick, STATUS_POLL_MS);
    },
    async refresh() {
      await loadSettings();
      await refreshStatus();
    },
    dispose() {
      window.clearInterval(timer);
      timer = 0;
    },
  };
}

/* 归一化后的应用对象只把契约字段写回主进程，界面自造的 id 也一并带上（主进程可忽略）。 */
function toSavableApp(app) {
  return { id: app.id, name: app.name, exe: app.exe, rule: app.rule };
}

const controllers = new WeakMap();

/** 懒挂载入口：同一个容器重复调用不会重建，也不会丢状态。 */
export function mountDesktopSettings(panel) {
  if (!panel) return null;
  const existing = controllers.get(panel);
  if (existing) return existing;
  const controller = createController(panel);
  controllers.set(panel, controller);
  controller.start();
  return controller;
}

export default mountDesktopSettings;
