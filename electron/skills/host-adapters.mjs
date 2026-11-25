/**
 * 负责：把宿主真实对象的签名差异收敛成技能层唯一依赖的三条语义契约——
 *   `approvals.ask(request, signal) => 'once'|'session'|'deny'`（sender 已绑定）、
 *   `permissions.check({ capability, path, approvalPreset }) => { ok, reason }`（path 已反查成 rootId）
 *   与 `permissions.checkRootless({ capability, approvalPreset }) => { ok, scope:'rootless' }`
 *   （非文件能力位不由 store 判，见该函数头）、
 *   `gate.resolveInRoots(path, label) => Promise<string>`（真实路径，越界抛错）。
 * 不负责：判定是否放行（approval-bridge.mjs）、弹条与超时（electron/approvals.cjs）、
 *   路径解析算法与 symlink 逐级校验（electron/acp/gate.mjs）、能力位存储（electron/permissions.cjs）。
 * 被谁调用：接线层（技能运行时装配时把 broker/store/gate 包成三件套塞进 deps）、
 *   tests/skills-approval-integration.test.mjs。
 *
 * 为什么需要这一层：真 `createApprovalBroker()` 是 `ask(sender, request = {}, signal)`，
 * 默认参数让它 `Function.length === 1`，任何「按元数猜签名」的代码都会把 sender 猜没；
 * 真 `permissions.check()` 只按 `input.rootId` 查根，传 path 进去恒 `not-registered`。
 * 猜测在这里结束：本文件是唯一知道宿主签名的地方。
 *
 * 零 electron import；依赖缺失时一致地「更保守」：拒绝 + `logger.warn` 一次，绝不静默放行。
 */

import { resolve as resolvePath, sep } from 'node:path';
import { messageOf } from '../mcp/normalize.mjs';

/** 真 permissions.cjs 只认这三个能力位；写错就是接线错误，不能静默放行。 */
const CAPABILITIES = Object.freeze(['read', 'write', 'exec']);
const PRESETS = Object.freeze(['default', 'auto', 'full']);
/**
 * 非文件能力位（manifest `permissions` 的 desktop / browser / canvas / memory）：
 * 它们**不由能力位 store 判**，见 createPermissionsAdapter 的 checkRootless 函数头。
 */
const DEFAULT_ROOTLESS_CAPABILITIES = Object.freeze(['desktop', 'browser', 'canvas', 'memory']);

const NOOP_LOGGER = Object.freeze({
  debug() {}, info() {}, warn() {}, error() {},
});

/** 进程级默认 logger（接线层可 setSkillLogger 注入，否则惰性解析 electron/logging）。 */
let hostLogger = null;
let hostLoggerRequested = false;

/**
 * 接线层显式注入宿主 logger（推荐：`setSkillLogger(getLogger('skills'))`）。
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} logger
 */
export function setSkillLogger(logger) {
  if (logger && typeof logger.warn === 'function') hostLogger = logger;
}

/**
 * logging/index.mjs 顶层不 import electron，纯 Node 也能加载；加载失败就永远用空实现。
 * 惰性而不是顶层 import：纯逻辑单测不该因为「没装日志」而多一条依赖。
 */
function requestHostLogger() {
  if (hostLogger || hostLoggerRequested) return;
  hostLoggerRequested = true;
  import('../logging/index.mjs')
    .then(module => {
      if (!hostLogger && typeof module?.getLogger === 'function') hostLogger = module.getLogger('skills');
    })
    .catch(() => { /* 纯 Node 测试环境：保持空实现 */ });
}

/**
 * @param {{ warn?: Function }|null|undefined} injected
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function resolveSkillLogger(injected) {
  if (injected && typeof injected.warn === 'function') return injected;
  requestHostLogger();
  return hostLogger ?? NOOP_LOGGER;
}

/** 平台折叠后的前缀判断（Windows 大小写不敏感）。 */
function inside(parent, child) {
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = fold(resolvePath(parent));
  const target = fold(resolvePath(child));
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** 审批答复只允许三词（与 approvals.cjs 的 DECISIONS 一致）；其他一律按拒绝。 */
function normalizeDecision(value) {
  if (value === 'session') return 'session';
  if (value === 'once') return 'once';
  if (value === true) return 'once';
  if (value && typeof value === 'object') {
    if (value.decision === 'session') return 'session';
    if (value.allowed === true || value.ok === true || value.decision === 'once') return 'once';
  }
  return 'deny';
}

/**
 * 审批适配器：把真 broker 的 `(sender, request, signal)` 收成技能层的 `(request, signal)`。
 * 没有 sender / sender 已销毁 / broker 抛错 → 一律 `'deny'`，并 warn 一次。
 * @param {{
 *   broker?: { ask: (sender: object, request?: object, signal?: AbortSignal) => Promise<string> },
 *   sender?: { id?: string, isDestroyed?: () => boolean },
 *   logger?: { warn?: Function },
 * }} [options]
 * @returns {{ ask: (request: object, signal?: AbortSignal) => Promise<'once'|'session'|'deny'> }}
 */
export function createApprovalsAdapter({ broker, sender, logger } = {}) {
  const log = resolveSkillLogger(logger);
  let warned = false;
  const warnOnce = reason => {
    if (warned) return;
    warned = true;
    log.warn(`skills/approvals：${reason}；没有审批通道时一切人工审批按拒绝处理（更保守）`);
  };

  async function ask(request, signal) {
    if (!broker || typeof broker.ask !== 'function') {
      warnOnce('审批 broker 未注入（broker.ask 缺失）');
      return 'deny';
    }
    if (!sender || typeof sender !== 'object') {
      warnOnce('缺少 sender（webContents），审批卡无法投递到窗口');
      return 'deny';
    }
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
      warnOnce('sender 已销毁（窗口已关闭）');
      return 'deny';
    }
    try {
      return normalizeDecision(await broker.ask(sender, request ?? {}, signal));
    } catch (error) {
      // 审批通道自己抛错绝不能变成「放行」：按拒绝处理并留证，而不是静默 catch。
      log.warn(`skills/approvals：broker.ask 抛错（${messageOf(error)}），按拒绝处理`);
      return 'deny';
    }
  }

  return { ask };
}

/**
 * 能力位适配器：真 `permissions.check()` 只认 `rootId`，所以「path → rootId」的反查放在这里。
 * 反查规则：按已注册 roots 里**最长**的包含前缀选根（多个根嵌套时取最具体的那个）；
 * 调用没有路径参数时按「当前项目」= 第一个根（与 gate.mjs `cwd ? resolveInRoots : roots[0]` 同义）。
 *
 * 同时提供 `checkRootless()`：桌面 / 浏览器 / 画板 / 记忆这类**不碰项目文件**的能力位，
 * 项目根白名单对它们没有发言权（口径写在 checkRootless 的函数头里）。
 *
 * @param {{
 *   store?: { list?: Function, check?: Function },
 *   roots?: string[],
 *   logger?: { warn?: Function, debug?: Function },
 *   rootlessCapabilities?: string[],
 * }} [options]
 * @returns {{
 *   check: (input: { capability: string, path?: string, approvalPreset?: string })
 *     => Promise<{ ok: boolean, reason?: string }>,
 *   checkRootless: (input: { capability?: string, approvalPreset?: string })
 *     => Promise<{ ok: boolean, scope: 'rootless', capability: string|null }>,
 * }}
 */
export function createPermissionsAdapter({
  store, roots, logger, rootlessCapabilities = DEFAULT_ROOTLESS_CAPABILITIES,
} = {}) {
  const log = resolveSkillLogger(logger);
  const rootlessList = Array.isArray(rootlessCapabilities) && rootlessCapabilities.length
    ? rootlessCapabilities.filter(item => typeof item === 'string' && item)
    : [...DEFAULT_ROOTLESS_CAPABILITIES];
  let warned = false;
  const warnOnce = reason => {
    if (warned) return;
    warned = true;
    log.warn(`skills/permissions：${reason}；能力位无法复查时按拒绝处理（更保守）`);
  };

  /**
   * 从 store 读「当前真实登记表」而不是信传入的 roots 字符串：id 是 store 自己算的
   * （sha256 of canonical path），外部拼不出来。roots 只在 store 不支持 list 时用于诊断。
   */
  async function registeredRoots() {
    if (!store || typeof store.list !== 'function') return [];
    let listed;
    try {
      listed = await store.list();
    } catch (error) {
      log.warn(`skills/permissions：读取项目根失败（${messageOf(error)}），按拒绝处理`);
      return [];
    }
    const rows = Array.isArray(listed?.roots) ? listed.roots : [];
    return rows.filter(row => row && typeof row.id === 'string' && row.id && typeof row.path === 'string' && row.path);
  }

  function hintRoots() {
    return Array.isArray(roots) ? roots.filter(item => typeof item === 'string' && item.trim()) : [];
  }

  async function check(input = {}) {
    const capability = typeof input.capability === 'string' ? input.capability : '';
    const target = typeof input.path === 'string' ? input.path.trim() : '';
    const approvalPreset = PRESETS.includes(input.approvalPreset) ? input.approvalPreset : undefined;

    if (!store || typeof store.check !== 'function') {
      warnOnce('能力位 store 未注入（store.check 缺失）');
      return { ok: false, reason: 'permission_unavailable' };
    }
    if (!CAPABILITIES.includes(capability)) return { ok: false, reason: 'unknown-capability' };

    const rows = await registeredRoots();
    if (!rows.length) {
      warnOnce(`没有已登记的项目根，无法复查 ${capability} 能力位`
        + (hintRoots().length ? `（deps.projectRoots=${hintRoots().join(',')} 尚未登记）` : ''));
      return { ok: false, reason: 'root_not_registered' };
    }

    let root = null;
    if (!target) {
      root = rows[0];
    } else {
      for (const row of rows) {
        if (!inside(row.path, target)) continue;
        if (!root || row.path.length > root.path.length) root = row;
      }
    }
    if (!root) {
      warnOnce(`路径反查不到已登记的项目根：${target}`);
      return { ok: false, reason: 'root_not_registered' };
    }

    let verdict;
    try {
      verdict = await store.check({ rootId: root.id, capability, approvalPreset });
    } catch (error) {
      // 抛错交给 approval-bridge 收敛成 permission_failed（它负责告诉模型/用户）。
      log.warn(`skills/permissions：store.check 抛错（${messageOf(error)}）`);
      throw error;
    }
    if (verdict && verdict.ok === true) return { ok: true };
    return { ok: false, reason: typeof verdict?.reason === 'string' && verdict.reason ? verdict.reason : 'not-granted' };
  }

  /**
   * 非文件能力位复查（desktop / browser / canvas / memory）。
   *
   * **口径（重要，别再改回 store 判定）**：rootless 能力位**不由能力位 store 判**。
   * store 是按 `rootId` 记账的（`permissions.cjs` 的 check 只认 rootId），而这类能力根本没有
   * 项目根可查；真正保证它的是「manifest 的 `permissions` 声明」+「人工审批」
   * （`desktop/policy.cjs` 的真人互锁、`browser/policy.cjs` 的站点分级、
   * `designRuntime` 的 `settings.aiEdit` 在各自宿主里逐次复查）。
   * 所以这里**永远**返回 `{ ok: true, scope: 'rootless' }`，并且**缺 store 时同样是 ok**——
   * 这不是放行文件能力，而是明确「store 对这类能力没有发言权」。
   * 只留一条 debug 日志「rootless capability accepted」，用来回答「它为什么没被项目根挡住」。
   *
   * @param {{ capability?: string, approvalPreset?: string }} [input]
   * @returns {Promise<{ ok: true, scope: 'rootless', capability: string|null }>}
   */
  async function checkRootless(input = {}) {
    const capability = typeof input.capability === 'string' ? input.capability.trim() : '';
    const approvalPreset = PRESETS.includes(input.approvalPreset) ? input.approvalPreset : undefined;
    const declared = rootlessList.includes(capability);
    const note = [
      `capability=${capability || 'unspecified'}`,
      declared ? 'declared' : 'not-in-rootless-list',
      `preset=${approvalPreset ?? 'default'}`,
      `store=${store ? 'injected' : 'absent'}`,
    ].join(' ');
    if (typeof log.debug === 'function') {
      log.debug(`skills/permissions：rootless capability accepted（${note}）`);
    }
    return { ok: true, scope: 'rootless', capability: capability || null };
  }

  return { check, checkRootless };
}

/**
 * 路径闸门适配器：只暴露 `resolveInRoots`（gate.mjs 的真实算法），不重写、不缓存。
 * gate 缺失或没有 resolveInRoots → 抛 `code:'path_gate_missing'`，由 approval-bridge 转成拒绝。
 * @param {{ gate?: object, logger?: { warn?: Function } }} [options]
 * @returns {{ resolveInRoots: (path: string, label?: string) => Promise<string> }}
 */
export function createGateAdapter({ gate, logger } = {}) {
  const log = resolveSkillLogger(logger);

  async function resolveInRoots(path, label = 'skill') {
    if (!gate || typeof gate.resolveInRoots !== 'function') {
      log.warn('skills/gate：路径闸门未注入（gate.resolveInRoots 缺失），一切需要路径校验的调用都将被拒绝');
      const error = new Error('路径闸门不可用（gate.resolveInRoots 缺失）');
      error.code = 'path_gate_missing';
      throw error;
    }
    return gate.resolveInRoots(path, label);
  }

  return { resolveInRoots, available: Boolean(gate && typeof gate.resolveInRoots === 'function') };
}
