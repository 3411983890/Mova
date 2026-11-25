/**
 * 负责：技能调用前的统一授权协调——风险分级（none 直过 / read|write|exec 分两条路：
 *   **需要项目根**的工具先过路径闸门再过能力位复查，**无文件能力**的工具（桌面 / 浏览器 / 画板 /
 *   记忆写 / 目标计划）跳过根与闸门、只复查非文件能力位），最后按 `approval.mode` 与预设决定是否问人；
 *   同一轮内 `approval.allowSession` 的「同工具 + 同能力只问一次」缓存；
 *   以及**审批卡的变更预览**（可选 `preview` 入参 → `approvals.ask` request 上的 `preview` 字段，
 *   字段名以渲染层 `src/features/approvals/approval-bar.jsx` 真实读取的为准，见 normalizePreview）。
 * 不负责：路径解析算法（electron/acp/gate.mjs 的 resolveInRoots）、能力位存储与 rootId 反查
 *   （electron/skills/host-adapters.mjs）、弹条与超时（electron/approvals.cjs）；
 *   本模块只编排它们的调用顺序。
 * 被谁调用：electron/skills/index.mjs（组装 ctx.authorize）、tests/skills-approval.test.mjs、
 *   tests/skills-approval-integration.test.mjs、tests/skills-rootless.test.mjs、
 *   各 pack 的 handler（写操作前 `await ctx.authorize()`）。
 *
 * 依赖只有三件套（形状见 host-adapters.mjs，接线层必须用适配器，不要再把真 broker/store 直接塞进来）：
 *   - approvals:  { ask(request, signal) => 'once'|'session'|'deny' }   // sender 已绑定
 *   - permissions: { check({ capability, path, approvalPreset }) }        // path → rootId 已由适配器完成
 *   - gate:        { resolveInRoots(path, label) }                        // 真 gate.mjs 的算法
 * 缺任何一件都比「放行」更保守：拒绝 + logger.warn，绝不静默 catch。
 *
 * 唯一例外（本轮修的 P0）：**无文件能力**的工具连「项目根」这个前提都不成立（用户没打开项目文件夹时
 * 桌面/浏览器/画板照样该能用），所以它们的 rootless 分支不查 store 的 rootId（见 rootlessScopeOf /
 * authorizeRootless）。人工审批一步不少——那才是这类能力真实的安全边界。
 */

import { messageOf } from '../mcp/normalize.mjs';
import { resolveSkillLogger } from './host-adapters.mjs';
// 「哪些参数名算文件路径」只有一处定义：闸门与 tool 事件必须用同一份，否则会出现
// 「有的工具行能点、有的不能」这种查不出原因的差异。
import { firstPathOf } from './tool-path.mjs';

const PRESETS = ['default', 'auto', 'full'];
/** 审批模式（manifest 的 `approval.mode`）：none 免人工审批、policy 按预设、always 必问人。 */
const APPROVAL_MODES = ['none', 'policy', 'always'];
/** 允许的审批答复词（与 gate.mjs 同一套词表，避免同一句话在两个通道里结论不同）。 */
const ALLOW_WORDS = new Set(['once', 'session', 'allow', 'allowed', 'approve', 'approved', 'accept', 'yes', 'allow_once', 'allow_always']);
const RISK_LEVELS = ['none', 'read', 'write', 'exec'];
const CAPABILITIES = ['read', 'write', 'exec'];
/**
 * 非文件宿主能力位（manifest `permissions` 的键）：它们的安全边界是**人工确认 + 宿主自己的策略**
 * （`desktop/policy.cjs` 的真人互锁、`browser/policy.cjs` 的站点分级、`designRuntime` 的
 * `settings.aiEdit`），而不是项目目录白名单——这类能力没有「项目内路径」这个概念。
 */
const ROOTLESS_CAPABILITIES = ['desktop', 'browser', 'canvas', 'memory'];
const MESSAGE_CHARS = 300;
/**
 * 审批卡预览的上限（单侧）。取值不是自创的，是两条既有实现里更严的那一档：
 *   - 渲染层 `src/features/approvals/diff.js` 的 `DIFF_CHAR_LIMIT` = 200_000 字符，
 *     超过它连行级 diff 都不算、只画纯文本对照；
 *   - `electron/agent-tools.cjs` 的 `LIMITS.previewLines/previewChars` = 300 行 / 100_000 字符，
 *     旧（非技能化）审批卡发的就是这份预算。
 * 审批条是用来「看清改了什么」的，把整份大文件塞进 IPC 既慢又没人看得完。
 */
const PREVIEW_MAX_LINES = 300;
const PREVIEW_MAX_CHARS = 100_000;
/**
 * 渲染层按 `preview.kind` 选徽标与卡片样式（`approval-bar.jsx` 的 ACTION_LABELS）。
 * 不认识的值一律收敛成 `write`：卡片仍然正确，只是标签不精确。
 */
const PREVIEW_KINDS = new Set(['write', 'replace', 'delete', 'move', 'batch']);

/** 预览的一侧：先按行数、再按字符数截断；截断过就置 `truncated`（渲染层会写明「只发送了预览片段」）。 */
function clipPreviewSide(value) {
  if (value == null) return { text: null, truncated: false };
  const text = String(value);
  const lines = text.split('\n');
  let clipped = lines.length > PREVIEW_MAX_LINES ? lines.slice(0, PREVIEW_MAX_LINES).join('\n') : text;
  let truncated = lines.length > PREVIEW_MAX_LINES;
  if (clipped.length > PREVIEW_MAX_CHARS) {
    clipped = clipped.slice(0, PREVIEW_MAX_CHARS);
    truncated = true;
  }
  return { text: clipped, truncated };
}

/**
 * 审批卡预览的唯一契约出口。字段名照渲染层真实读取的那个形状写死：
 *   `request.preview = { kind, path, before, after, truncated }`
 * （`approval-bar.jsx` 读 `preview.kind` / `preview.before` / `preview.after` / `preview.truncated`，
 *   `diff.js` 的 `computeLineDiff(before, after)` 在渲染层算行级 diff，主进程不发 diff 行）。
 * 形状不认识就返回 null：宁可少一张 diff，也不要给渲染层一个会让它抛错的载荷。
 */
function normalizePreview(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const head = clipPreviewSide(raw.before);
  const tail = clipPreviewSide(raw.after);
  return {
    kind: PREVIEW_KINDS.has(raw.kind) ? raw.kind : 'write',
    path: typeof raw.path === 'string' ? raw.path : '',
    before: head.text,
    after: tail.text,
    truncated: head.truncated || tail.truncated,
  };
}

/** 包级 permissions：index.mjs 把 pack manifest 的 permissions 与本工具定义一起送进来。 */
function permissionsOf(def, packPermissions) {
  const direct = def?.permissions;
  if (direct && typeof direct === 'object') return direct;
  if (packPermissions && typeof packPermissions === 'object') return packPermissions;
  return null;
}

/**
 * 主判据（本轮的显式规则）：**`def.permissions.fs === 'none'` 的工具不需要项目根**。
 * 没有声明 permissions 的 def（老的调用方、单测里手工构造的工具）一律按「需要根」处理，
 * 与改造前完全一致。
 * @returns {boolean}
 */
function needsProjectRoot(def, packPermissions) {
  return permissionsOf(def, packPermissions)?.fs !== 'none';
}

/** 这个包声明了哪个非文件宿主能力位（按固定顺序取第一个）；都没声明就返回 ''。 */
function rootlessCapabilityOf(permissions) {
  if (!permissions || typeof permissions !== 'object') return '';
  for (const key of ROOTLESS_CAPABILITIES) {
    const value = permissions[key];
    if (value === true || value === 'read' || value === 'write') return key;
  }
  return '';
}

/**
 * rootless 判定的唯一入口：返回 `{ scope:'rootless', capability }` 表示这次调用不需要项目根，
 * 返回 `null` 表示走原来的「根反查 → 路径闸门 → 能力位」全链路。两条入口，其余一律 null：
 *
 * 1) **主判据**：`permissions.fs === 'none'`（见 needsProjectRoot）。画板 / 记忆 / 目标 / 上下文 /
 *    联网搜索这类包不碰项目文件，路径白名单没有校验对象，root 反查只会返回 root_not_registered。
 * 2) **实测缺口**：`desktop-control` 与 `browser-automation` 声明的是 `fs:'read'`（截图与上传要读盘，
 *    但它们不为项目文件服务）。这类包在**这次调用没有文件路径参数**时同样没有可校验对象。
 *    只要包声明了桌面/浏览器/画板/记忆能力位，就把这次调用判成 rootless；
 *    安全边界仍是人工审批 + 宿主策略。
 *
 * 刻意**不**放宽的两类（文件能力一条都不许松）：
 *   - `fs:'write'` 的包一律要根（写盘永远过路径闸门）；
 *   - 任何带 path / file / filePath / cwd / dir 参数的调用（`browser_upload` 读本地文件也一样）。
 * @returns {{ scope: 'rootless', capability: string }|null}
 */
function rootlessScopeOf(def, packPermissions, target) {
  const permissions = permissionsOf(def, packPermissions);
  const capability = rootlessCapabilityOf(permissions);
  if (!needsProjectRoot(def, packPermissions)) return { scope: 'rootless', capability };
  if (permissions?.fs === 'write') return null;
  if (target) return null;
  return capability ? { scope: 'rootless', capability } : null;
}

function verdictAllows(verdict) {
  if (verdict === true) return true;
  if (verdict && typeof verdict === 'object') return verdict.ok === true || verdict.allowed === true;
  return false;
}

/** approvals 的答复可能是 'once'|'session'、布尔、或 `{ allowed }` / `{ decision }` / `{ optionId }`。 */
function decisionAllows(value) {
  if (value === true) return true;
  if (typeof value === 'string') return ALLOW_WORDS.has(value.toLowerCase());
  if (value && typeof value === 'object') {
    if (value.allowed === true || value.ok === true) return true;
    if (typeof value.decision === 'string') return decisionAllows(value.decision);
    if (typeof value.optionId === 'string') return decisionAllows(value.optionId);
  }
  return false;
}

function reasonOf(error) {
  const text = error?.detail ?? error?.message ?? String(error ?? '');
  return String(text).slice(0, MESSAGE_CHARS);
}

/**
 * @param {{
 *   approvals?: { ask: (request: object, signal?: AbortSignal) => Promise<string> },
 *   permissions?: { check: (input: object) => Promise<{ ok: boolean, reason?: string }> },
 *   gate?: { resolveInRoots?: (path: string, label?: string) => Promise<string> },
 *   audit?: { record?: Function }|Function,
 *   preset?: 'default'|'auto'|'full',
 *   sender?: { id?: string, isDestroyed?: () => boolean },
 *   emit?: (event: object) => void,
 *   resolvePath?: (target: string, roots: string[]) => string|null|Promise<string|null>,
 *   logger?: { warn?: Function },
 *   now?: () => number,
 * }} [options]
 */
export function createApprovalCoordinator({
  approvals, permissions, gate, audit, preset, sender, emit, resolvePath, logger, now = Date.now,
} = {}) {
  // 未知 preset 一律当 default：宁可多问一次，也不要静默升级成免审批。
  const mode = PRESETS.includes(preset) ? preset : 'default';
  const log = resolveSkillLogger(logger);
  /** `${senderId}\0${tool}\0${capability}` -> true：allowSession 的「同类只问一次」缓存。 */
  const grants = new Map();

  /** Electron 的 webContents.id 是**数字**：只认字符串会让所有窗口共用同一个授权缓存。 */
  const senderId = () => {
    const id = sender?.id;
    if (typeof id === 'string' && id) return id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return '';
  };

  /**
   * 拒绝形状固定，额外带 `scope`（只有 rootless 的拒绝才带）：调用方与时间线要能分清
   * 「项目内路径被拒」和「无文件能力工具被拒」，两者的处置完全不同。
   */
  function deny(code, reason, scope) {
    return {
      allowed: false,
      code,
      reason: String(reason ?? code).slice(0, MESSAGE_CHARS),
      ...(scope ? { scope } : {}),
    };
  }

  /** 允许一律带 `code:'ok'`：调用方不必为「成功」分支写两种形状。 */
  function grant() {
    return { allowed: true, code: 'ok' };
  }

  function notice(text) {
    if (typeof emit !== 'function') return;
    try {
      emit({ type: 'notice', tone: 'warn', text: String(text).slice(0, MESSAGE_CHARS) });
    } catch (error) {
      // 旁白发不出去不影响授权结论，但必须留证（空 catch 会让「为什么用户没看到提示」无从查起）。
      log.warn(`skills/authorize：notice 事件发送失败（${messageOf(error)}），授权结论不受影响`);
    }
  }

  async function recordAudit(entry) {
    if (!audit) return;
    const write = typeof audit.record === 'function' ? audit.record : (typeof audit === 'function' ? audit : null);
    if (!write) return;
    try {
      await write({ at: now(), ...entry });
    } catch (error) {
      // 审计失败不影响已经允许的操作，但必须留证：否则「谁批准了这次写入」会永久缺失。
      log.warn(`skills/authorize：审计写入失败（${messageOf(error)}），操作已按授权结论继续`);
    }
  }

  /**
   * 能力位实时复查（不缓存旧的「允许」）。只认注入适配器的 `check({ capability, path, approvalPreset })`：
   * path → rootId 的转换是适配器的职责，桥里不假设 store 的入参形状。
   * @returns {Promise<{ state: 'allow' } | { state: 'deny', reason: string }
   *   | { state: 'unavailable' } | { state: 'failed', error: unknown }>}
   */
  async function checkCapability(capability, target) {
    const check = permissions?.check;
    if (typeof check !== 'function') return { state: 'unavailable' };
    try {
      const verdict = await check({ capability, path: target, approvalPreset: mode });
      if (verdictAllows(verdict)) return { state: 'allow' };
      return { state: 'deny', reason: typeof verdict?.reason === 'string' ? verdict.reason : '' };
    } catch (error) {
      return { state: 'failed', error };
    }
  }

  /**
   * 非文件能力位复查（rootless）。
   *
   * **口径（与 checkCapability 的唯一差别，别再改回去）**：rootless 能力位**不由能力位 store 判**。
   * store 是按 `rootId` 记账的，而这类能力根本没有项目根；真正兜底的是「manifest 的 permissions
   * 声明」+「人工审批」+「宿主自己的策略」。所以适配器提供了 `checkRootless` 时，它说 ok 就 ok
   * （`host-adapters.mjs` 的实现永远 ok）；它说不行才收敛成 `capability_scope_missing`。
   *
   * 适配器**只有** `check` 一道通道（老接线 / 单测里的 fake）时退回 store 判定——通道缺失一律更保守，
   * 这也是「浏览器能力位被 store 明确拒绝就拒绝」这条既有约定不走样。适配器一件都没注入时放行：
   * 这里没有「文件能力」可被静默放开，拒绝只会把「用户没打开项目文件夹」变成工具不可用（本轮修的 bug）。
   *
   * @returns {Promise<{ state: 'allow', via: string } | { state: 'unconfigured' }
   *   | { state: 'deny', via: string, reason: string } | { state: 'failed', via: string, error: unknown }>}
   */
  async function checkRootlessCapability(capability) {
    const checkRootless = permissions?.checkRootless;
    if (typeof checkRootless === 'function') {
      try {
        const verdict = await checkRootless({ capability, approvalPreset: mode });
        if (verdictAllows(verdict)) return { state: 'allow', via: 'rootless' };
        return { state: 'deny', via: 'rootless', reason: typeof verdict?.reason === 'string' ? verdict.reason : '' };
      } catch (error) {
        return { state: 'failed', via: 'rootless', error };
      }
    }
    const check = permissions?.check;
    if (typeof check !== 'function') return { state: 'unconfigured' };
    try {
      const verdict = await check({ capability, path: '', approvalPreset: mode });
      if (verdictAllows(verdict)) return { state: 'allow', via: 'store' };
      return { state: 'deny', via: 'store', reason: typeof verdict?.reason === 'string' ? verdict.reason : '' };
    } catch (error) {
      return { state: 'failed', via: 'store', error };
    }
  }

  /**
   * 路径闸门：有 gate 就用它的 resolveInRoots（逐级 realpath 祖先校验），否则退化到注入的 resolvePath；
   * 两者都没有一律拒绝（`path_gate_missing`），不再因为 preset:'full' 放行。
   */
  async function checkPath(target, roots) {
    if (gate && typeof gate.resolveInRoots === 'function') {
      try {
        const resolved = await gate.resolveInRoots(target, 'skill');
        if (typeof resolved === 'string' && resolved) return { ok: true, path: resolved };
        return { ok: false, path: '', reason: `路径闸门没有返回真实路径：${target}` };
      } catch (error) {
        // 适配器把「闸门本身缺失」也抛成 path_gate_missing：语义要和「路径越界」分开。
        if (error?.code === 'path_gate_missing') {
          return { ok: false, path: '', missing: true, reason: reasonOf(error) };
        }
        return { ok: false, path: '', reason: reasonOf(error) };
      }
    }
    if (typeof resolvePath === 'function') {
      try {
        const resolved = await resolvePath(target, Array.isArray(roots) ? roots : []);
        if (typeof resolved === 'string' && resolved) return { ok: true, path: resolved };
        return { ok: false, path: '', reason: `路径不在允许的项目根内：${target}` };
      } catch (error) {
        return { ok: false, path: '', reason: reasonOf(error) };
      }
    }
    return { ok: false, path: '', missing: true, reason: '没有路径闸门（gate.resolveInRoots）可供校验，拒绝执行' };
  }

  /**
   * 把 `authorize({ preview })` 的入参化成渲染层认的那份形状。
   *
   * `preview` 允许是**值**，也允许是**延迟构造的回调** `({ path }) => preview | null`：
   * 真路径只有路径闸门知道（`resolveInRoots` 是唯一实现，handler 不许自己拼绝对路径），
   * 所以 handler 交上来的只能是「拿到闸门解析后的路径再读盘」的闭包，由这里在闸门通过之后、
   * 弹卡之前调用一次。
   *
   * **构造失败绝不阻塞授权**（文件读不出来 / 是二进制 / 太大）：降级成不带预览的卡，
   * 并留一条 debug 说明「为什么这张卡没有 diff」。
   * @param {object|Function|null|undefined} preview
   * @param {string} [target] 路径闸门解析后的真实路径
   * @returns {Promise<{kind: string, path: string, before: string|null, after: string|null, truncated: boolean}|null>}
   */
  async function resolvePreview(preview, target) {
    if (preview == null) return null;
    let raw = preview;
    if (typeof preview === 'function') {
      try {
        raw = await preview({ path: target || '' });
      } catch (error) {
        if (typeof log.debug === 'function') {
          log.debug(`skills/authorize：审批卡预览构造失败（${messageOf(error)}），这次按不带预览的卡继续`);
        }
        return null;
      }
    }
    const normalized = normalizePreview(raw);
    if (!normalized && typeof log.debug === 'function') {
      // 两种都有：构造器主动放弃（文件过大 / 二进制 / 目标不是文件），或形状不认识。
      log.debug('skills/authorize：这次审批卡没有变更预览（构造器返回空或形状不认识），授权结论不受影响');
    }
    return normalized;
  }

  /** 人工审批：只调 `approvals.ask(request, signal)`——sender 由 host-adapters 绑定。 */
  async function askHuman(def, target, capability, signal, preview) {
    const ask = approvals?.ask;
    if (typeof ask !== 'function') {
      return { ok: false, code: 'approval_unavailable', reason: '审批通道未注入（approvals.ask）' };
    }
    // 预览必须在弹卡之前就绪：用户看到的就是这次请求要改的内容（失败只降级，见 resolvePreview）。
    const shownPreview = await resolvePreview(preview, target);
    const request = {
      capability,
      path: target || undefined,
      message: `允许${def?.label || def?.name || capability}？`,
      detail: `技能：${def?.name ?? 'unknown'}（风险 ${def?.risk ?? 'write'}）`,
      method: `skill/${def?.name ?? 'unknown'}`,
      // 字段名与渲染层一致（request.preview）。没有预览时整个键都不发：
      // 卡片因此退化成「只有路径与风险」的通用卡，而不是画一个空的 diff 框。
      ...(shownPreview ? { preview: shownPreview } : {}),
    };
    try {
      const decision = await ask(request, signal);
      return decisionAllows(decision) ? { ok: true } : { ok: false, code: 'approval_denied' };
    } catch (error) {
      return { ok: false, code: 'approval_failed', reason: reasonOf(error) };
    }
  }

  function capabilityOf(def, risk) {
    const declared = def?.approval?.capability;
    if (CAPABILITIES.includes(declared)) return declared;
    if (risk === 'write' || risk === 'exec') return risk;
    return 'read';
  }

  function approvalModeOf(def) {
    const declared = def?.approval?.mode;
    return APPROVAL_MODES.includes(declared) ? declared : 'policy';
  }

  /** 会话授权的缓存键带上工具名：否则批准一次 design_apply 就能免审 write_file 写任意根内文件。 */
  function grantKey(def, capability) {
    return `${senderId()}\0${def?.name ?? ''}\0${capability}`;
  }

  /**
   * 人工审批的最后一段——**项目内工具与无文件能力工具共用**（同一件事只能有一份实现：
   * 否则「rootless 该不该问人」会和「项目内该不该问人」慢慢漂移成两套规则）。
   *
   * 规则（与改造前逐条一致）：
   *   - `mode:'none'`（manifest 只允许出现在 risk:read|none 上）免问；
   *   - `mode:'policy'` + `preset:'full'` 免问（full 只免人工审批，不免路径与能力位）；
   *   - `mode:'always'` 必问，preset 救不回来；
   *   - `risk:'read'` 且不是 always：直接放行（读类无副作用）。
   * `scope` 只影响审计记录与拒绝原因，不改变任何判定。
   *
   * @param {{ def: object, risk: string, approvalMode: string, capability: string,
   *   path: string, scope: 'project'|'rootless', signal?: AbortSignal,
   *   preview?: object|Function }} input `preview` 只用于审批卡（见 resolvePreview），
   *   不参与任何放行判定。
   */
  async function approve({
    def, risk, approvalMode, capability, path, scope, signal, preview,
  }) {
    const entry = { action: `skill/${def.name}`, capability, path: path || null, preset: mode, scope };
    if (risk === 'read' && approvalMode !== 'always') {
      // 项目内只读历来不写审计（行为不变）；rootless 留一条，用来回答「它为什么没问人也没根」。
      if (scope === 'rootless') await recordAudit({ ...entry, decision: 'read' });
      return grant();
    }
    if (approvalMode === 'none') {
      await recordAudit({ ...entry, decision: 'none' });
      return grant();
    }
    // preset:'full' 只免人工审批（gate.mjs 同义）：路径与能力位已在调用方照做。
    if (approvalMode === 'policy' && mode === 'full') {
      await recordAudit({ ...entry, decision: 'auto' });
      return grant();
    }

    const key = grantKey(def, capability);
    const sessionAllowed = approvalMode === 'policy' && def.approval?.allowSession === true && grants.has(key);
    if (sessionAllowed) {
      await recordAudit({ ...entry, decision: 'session' });
      return grant();
    }

    const asked = await askHuman(def, path, capability, signal, preview);
    if (!asked.ok) {
      if (asked.code === 'approval_unavailable') {
        notice(`技能 ${def.name} 需要人工确认，但审批通道未就绪，已拒绝执行。`);
      }
      return deny(asked.code, asked.reason ?? `审批未通过：${asked.code}`, scope === 'rootless' ? 'rootless' : '');
    }
    if (approvalMode === 'policy' && def.approval?.allowSession === true) grants.set(key, true);
    await recordAudit({ ...entry, decision: 'approved' });
    return grant();
  }

  /**
   * 无文件能力工具的授权路径：**不查项目根、不过路径闸门**，但**人工审批一步不少**。
   * 与项目内路径的差别只有三处：不反查 rootId、拒绝原因/审计里写清 `scope:'rootless'`、
   * 非文件能力位走 checkRootlessCapability（见那里的口径）。
   * @returns {Promise<{ allowed: true, code: 'ok' } | { allowed: false, code: string, reason: string }>}
   */
  async function authorizeRootless({
    def, risk, approvalMode, capability, rootless, signal, preview,
  }) {
    const scopeCapability = rootless.capability || '';
    const via = await checkRootlessCapability(scopeCapability);
    if (via.state === 'deny') {
      const detail = via.reason ? `（${via.reason}）` : '';
      notice(`技能 ${def.name} 的非文件能力位未通过（${scopeCapability || capability}），已拒绝执行。`);
      // store 明确拒绝时沿用项目内的 permission_denied（调用方与时间线的既有语义不变）；
      // 只有 checkRootless 这一层自己的否定才是新的 capability_scope_missing。
      if (via.via === 'store') {
        return deny('permission_denied', `能力位未授权：${capability}${detail}（scope: rootless）`, 'rootless');
      }
      return deny('capability_scope_missing', `非文件能力位未授权：${scopeCapability || capability}${detail}（scope: rootless）`, 'rootless');
    }
    if (via.state === 'failed') {
      notice(`技能 ${def.name} 的非文件能力位检查失败（${scopeCapability || capability}），已拒绝执行。`);
      if (via.via === 'store') {
        return deny('permission_failed', `能力检查失败（${capability}）：${reasonOf(via.error)}（scope: rootless）`, 'rootless');
      }
      return deny('capability_scope_missing', `非文件能力位检查失败（${scopeCapability || capability}）：${reasonOf(via.error)}（scope: rootless）`, 'rootless');
    }
    return approve({
      def, risk, approvalMode, capability, path: '', scope: 'rootless', signal, preview,
    });
  }

  /**
   * 判定一次技能调用是否被允许。永不抛：拒绝走 `{ allowed:false, code, reason }`。
   * @param {{ def: object, args?: object, roots?: string[], signal?: AbortSignal,
   *   packPermissions?: object, preview?: object|Function }} input `packPermissions` 是包级
   *   manifest.permissions（工具定义本身不带它；没有它就无法判定「这个工具要不要项目根」）。
   *   `preview` 是**可选**的审批卡变更预览：可以是一份 `{ kind, path, before, after }`，
   *   也可以是 `({ path }) => 同形状` 的回调（真路径由路径闸门给出后再读盘）。
   *   它只影响卡片上「要改什么」的展示，不影响任何放行判定。
   * @returns {Promise<{ allowed: true, code: 'ok' } | { allowed: false, code: string, reason: string }>}
   */
  async function authorize({ def, args, roots, signal, packPermissions, preview } = {}) {
    if (!def || typeof def !== 'object') return deny('invalid_def', '缺少技能定义，无法判定风险');
    const risk = RISK_LEVELS.includes(def.risk) ? def.risk : 'write';
    if (risk === 'none') return grant();
    if (signal?.aborted) return deny('aborted', '请求已取消');

    const approvalMode = approvalModeOf(def);
    const capability = capabilityOf(def, risk);
    const target = firstPathOf(args);

    // 0) 分流：无文件能力的工具先判 scope（见 rootlessScopeOf 的两条入口）。
    const rootless = rootlessScopeOf(def, packPermissions, target);
    if (rootless) {
      return authorizeRootless({
        def, risk, approvalMode, capability, rootless, signal, preview,
      });
    }

    // 1) 路径闸门：read 也不例外（与 gate.mjs 的 resolveInRoots → assertCapability 顺序一致）。
    let gatedPath = '';
    if (target) {
      const gated = await checkPath(target, roots);
      if (!gated.ok) {
        if (gated.missing) {
          notice(`技能 ${def.name} 需要路径校验，但路径闸门未就绪，已拒绝执行。`);
          return deny('path_gate_missing', gated.reason);
        }
        return deny('path_denied', gated.reason);
      }
      gatedPath = gated.path;
    }

    // 2) 能力位实时复查（读也复查；没有通道就拒绝，full 预设救不回来）。
    const via = await checkCapability(capability, gatedPath);
    if (via.state === 'unavailable') {
      notice(`技能 ${def.name} 需要 ${capability} 能力，但权限通道未就绪，已按最保守策略拒绝。`);
      return deny('permission_unavailable', `没有可用的权限通道，拒绝 ${capability} 操作`);
    }
    if (via.state === 'deny') {
      const detail = via.reason ? `（${via.reason}）` : '';
      return deny('permission_denied', `能力位未授权：${capability}${detail}`);
    }
    if (via.state === 'failed') {
      return deny('permission_failed', `能力检查失败（${capability}）：${reasonOf(via.error)}`);
    }

    // 3) 人工审批（规则见 approve）。预览用闸门解析后的真实路径去构造（见 resolvePreview）。
    return approve({
      def, risk, approvalMode, capability, path: gatedPath, scope: 'project', signal, preview,
    });
  }

  /**
   * 清掉某个窗口的会话授权（换轮次 / 取消 / 窗口关闭时调用）。
   * @param {string} [id] 省略表示清空全部
   */
  function resetSender(id) {
    if (id === undefined) {
      grants.clear();
      return;
    }
    const prefix = `${String(id)}\0`;
    for (const key of [...grants.keys()]) if (key.startsWith(prefix)) grants.delete(key);
  }

  return { authorize, resetSender };
}
