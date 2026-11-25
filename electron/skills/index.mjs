/**
 * 负责：技能运行时的对外总装配——建注册表、解析名字（含别名）、统一执行壳
 *   （running 事件 → handler → done/error/denied 事件 → MCP 形状结果），
 *   以及给两条链路适配器用的 listEntries / resolve / invoke / search。
 * 不负责：manifest 校验（manifest-schema.mjs）、注册表裁剪（registry.mjs）、
 *   审批算法（approval-bridge.mjs）、事件字段形状（events.mjs）、MCP/pi-ai 的瘦适配（adapters/*）、
 *   宿主签名适配（host-adapters.mjs，接线层负责把 broker/store/gate 包成三件套再塞进 deps）。
 * 被谁调用：electron/skills/adapters/pi-ai.mjs 与 adapters/mcp.mjs（生产接线是后续步骤），
 *   tests/skills-*.test.mjs。
 *
 * 硬约束：
 * - `invoke` 永不抛（MCP 里抛异常会中断会话）；未知工具返回 isError 结果。
 * - 结果一律经 `normalizeResult(raw, { maxTextChars: resultBudgetOf(def) })`：pi-ai 与 MCP 两条链路
 *   共用同一份预算，而且**按工具声明**取值——`browser_snapshot` 自己允许 24000 字符的页面快照，
 *   技能层就不能统一按 8192 砍掉（那会让工具自己的 `maxChars` 参数白费）。预算只从
 *   manifest-schema.mjs 的 `resultBudgetOf()` 读，这里不写第二份常量。
 * - 只有 `deps.emit` 存在时才发前端事件：纯单测（或无人观看的通道）不产生任何事件副作用。
 * - 不在模块顶层 import 任何 electron 相关模块：日志走 `deps.logger` 注入或惰性动态 import。
 */

import { errorResult, messageOf, normalizeResult } from '../mcp/normalize.mjs';
import { createApprovalCoordinator } from './approval-bridge.mjs';
import { searchSkills } from './discover.mjs';
import {
  createCallIdFactory, skillDeniedEvent, skillDoneEvent, skillErrorEvent, skillRunningEvent,
} from './events.mjs';
import { resolveSkillLogger, setSkillLogger } from './host-adapters.mjs';
import { resultBudgetOf } from './manifest-schema.mjs';
import { buildRegistry } from './registry.mjs';
import { firstPathOf } from './tool-path.mjs';

export { setSkillLogger };

/**
 * 这些错误码代表「被拒绝」而不是「失败」：时间线上要显示成 denied 而不是红色 error。
 * 名单必须覆盖 approval-bridge 会返回的**全部**拒绝码，漏一个就会把拒绝画成「完成/失败」。
 */
const DENIED_CODES = new Set([
  'denied',
  'approval_denied',
  'approval_unavailable',
  'approval_failed',
  'permission_denied',
  'permission_unavailable',
  'permission_failed',
  'capability_scope_missing',
  'path_denied',
  'path_gate_missing',
  'aborted',
]);

function loggerFor(deps) {
  return resolveSkillLogger(deps?.logger);
}

/** 从 handler 的原始返回值里取前端要的附加信息（diff / image / detail），再做归一。 */
function extractMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return {
    ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    ...(raw.diff && typeof raw.diff === 'object' ? { diff: raw.diff } : {}),
    ...(raw.image && typeof raw.image === 'object' ? { image: raw.image } : {}),
  };
}

/** 失败详情：优先 handler 自己给的 detail，否则用结果里的第一段文本（截到一行）。 */
function failureDetail(result, meta) {
  if (typeof meta.detail === 'string' && meta.detail.trim()) return meta.detail;
  const first = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text') : null;
  const text = typeof first?.text === 'string' ? first.text : '';
  return text ? text.replace(/\s+/g, ' ').slice(0, 200) : '执行失败';
}

/**
 * 同一 key 内串行：running / done / error 必须按发生顺序到达前端。
 * 用同步的 Promise 链而不是 setTimeout/microtask 竞速——顺序由链保证，不靠「通常先后」。
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function createSerializer() {
  const chains = new Map();
  return function serializeByKey(key, task) {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.then(() => task());
    const tail = run.then(() => undefined, () => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };
}

/**
 * @param {{
 *   packs?: Array<{ manifest: object, createHandlers: (deps: object) => Record<string, Function> }>,
 *   deps?: object,
 * }} [options] deps 键清单见 electron/skills/packs/README.md
 * @returns {{
 *   listEntries: () => Array<{ pack: object, def: object, handler: Function }>,
 *   resolve: (name: string) => ({ pack: object, def: object, handler: Function }|null),
 *   invoke: (name: string, args?: object, callCtx?: object) => Promise<{ content: object[], isError?: true }>,
 *   search: (input?: object) => object,
 *   resetApprovals: (senderId?: string) => void,
 *   listMissingDependencies: () => Array<{ pack: string, missing: string[] }>,
 *   warnings: string[],
 *   registry: object,
 *   packs: object[],
 *   logger: object,
 * }}
 */
export function buildSkillRuntime({ packs = [], deps = {} } = {}) {
  const logger = loggerFor(deps);
  const registry = buildRegistry(packs, deps);
  const nextCallId = createCallIdFactory('mcp');
  const serializeByKey = createSerializer();
  const emit = typeof deps.emit === 'function' ? deps.emit : null;

  const coordinator = createApprovalCoordinator({
    approvals: deps.approvals,
    permissions: deps.permissions,
    gate: deps.gate,
    audit: deps.audit,
    preset: deps.approvalPreset ?? deps.preset,
    sender: deps.sender,
    emit,
    resolvePath: deps.resolvePath,
    logger,
  });

  for (const warning of registry.warnings) logger.warn(warning);
  logger.info(`registry built packs=${registry.packs.length} tools=${registry.entries.size} skipped=${registry.skipped.length}`);

  function emitEvent(event) {
    if (!emit) return;
    try {
      emit(event);
    } catch (error) {
      logger.warn(`emit 事件失败：${messageOf(error)}`);
    }
  }

  function resolve(rawName) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) return null;
    // 依次尝试：原样、去掉 mova_ 前缀、补上 mova_ 前缀（兼容旧 prompt 与 CLI 的历史记忆）。
    const candidates = [name];
    if (name.startsWith('mova_')) candidates.push(name.slice('mova_'.length));
    else candidates.push(`mova_${name}`);
    for (const candidate of candidates) {
      // canonical 名优先：别名只是「指向」，一个别名若与别的工具 canonical 名撞了，
      // 直接查 canonical 才是调用方真正想要的那个工具（否则 B 包工具会执行 A 包 handler）。
      const direct = registry.entries.get(candidate);
      if (direct) return direct;
      const canonical = registry.aliases.get(candidate);
      if (!canonical) continue;
      const entry = registry.entries.get(canonical);
      if (entry) return entry;
    }
    return null;
  }

  function createExecutionContext(entry, callCtx, callId) {
    const def = entry.def;
    const signal = callCtx.signal;
    return {
      callId,
      transport: callCtx.transport ?? 'direct',
      signal,
      // 没有 emit 时显式是 undefined：handler 里 `ctx.emit?.()` 永远安全。
      emit: emit ?? undefined,
      chatImages: deps.chatImages,
      supportsImages: deps.supportsImages === true,
      logger,
      /** 长任务的分步进度：原地更新同一行（同一 callId）。 */
      progress(detail, progress) {
        if (typeof emit !== 'function') return;
        emitEvent(skillRunningEvent({ callId, def, detail, progress }));
      },
      /**
       * 写操作前的统一授权（路径闸门 → 能力位 → 人工审批 → 审计）。
       * `options.preview` 是**可选**的审批卡变更预览（值或 `({ path }) => 预览` 回调）：
       * 只有这里能把它交给协调器，因为真路径是闸门在 `authorize` 内部解析出来的。
       */
      authorize(targetDef, targetArgs, options = {}) {
        return coordinator.authorize({
          def: targetDef ?? def,
          args: targetArgs ?? {},
          roots: options.roots ?? deps.projectRoots,
          signal: options.signal ?? signal,
          // 审批卡上的 before/after（渲染层 request.preview）：让用户在点「允许」之前就能看见改什么。
          preview: options.preview,
          // 包级 permissions 只能在这里补：tool def 本身不带它，而「这个工具要不要项目根」
          // 只能由包声明（`permissions.fs === 'none'`）判定。漏了这一行，桌面/浏览器/画板在
          // 「用户没打开项目文件夹」时会被 root_not_registered 挡死（本轮修的 P0）。
          packPermissions: entry.pack?.permissions,
        });
      },
    };
  }

  async function execute(entry, args, callCtx, callId) {
    const def = entry.def;
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const ctx = createExecutionContext(entry, callCtx, callId);
    const startedAt = Date.now();
    // 这次调用动的是哪个文件：一套判定（tool-path.mjs），渲染层拿它把路径画成可点的链接。
    const toolPath = firstPathOf(input);
    emitEvent(skillRunningEvent({ callId, def, detail: callCtx.detail, progress: callCtx.progress, path: toolPath }));
    try {
      const raw = await entry.handler(input, ctx);
      const meta = extractMeta(raw);
      // 预算按工具声明取值（默认 8192，见 manifest-schema.mjs 的 resultBudgetOf）。
      const result = normalizeResult(raw, { maxTextChars: resultBudgetOf(def) });
      if (result.isError === true) {
        // handler 返回 `{ isError:true }` 等价于失败：事件必须是 error，
        // 否则前端把这一行画成「完成」而模型收到的是错误，两边对不上。
        const detail = failureDetail(result, meta);
        logger.warn(`[skills] ${def.name} returned isError: ${detail}`);
        emitEvent(skillErrorEvent({ callId, def, detail, path: toolPath }));
        return result;
      }
      emitEvent(skillDoneEvent({
        callId, def, detail: meta.detail ?? callCtx.detail, diff: meta.diff, image: meta.image,
        durationMs: Date.now() - startedAt, path: toolPath,
      }));
      return result;
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code ? error.code : 'tool_failed';
      const reason = messageOf(error);
      logger.warn(`[skills] ${def.name} ${code}: ${reason}`);
      if (DENIED_CODES.has(code)) {
        emitEvent(skillDeniedEvent({ callId, def, detail: reason, path: toolPath }));
        return errorResult(code, reason);
      }
      emitEvent(skillErrorEvent({ callId, def, detail: reason, path: toolPath }));
      return errorResult('tool_failed', `${def.name} 执行失败：${reason}`);
    }
  }

  /**
   * @param {string} name 工具名 / mcpName / 别名（可省 mova_ 前缀）
   * @param {object} [args]
   * @param {{ callId?: string, transport?: string, signal?: AbortSignal, detail?: string, progress?: object }} [callCtx]
   */
  function invoke(name, args, callCtx = {}) {
    const call = callCtx && typeof callCtx === 'object' ? callCtx : {};
    const entry = resolve(name);
    if (!entry) {
      logger.warn(`[skills] unknown_tool ${String(name).slice(0, 80)}`);
      return Promise.resolve(errorResult('unknown_tool', `未知或未启用的技能：${String(name)}；可用清单见 mova_skill_search。`));
    }
    const callId = typeof call.callId === 'string' && call.callId ? call.callId : nextCallId();
    // 同一 callId 的 running/done 串行，避免并发调用把同一行事件交错。
    return serializeByKey(callId, () => execute(entry, args, call, callId));
  }

  const runtime = {
    listEntries: () => [...registry.entries.values()],
    resolve,
    invoke,
    search: input => searchSkills(runtime, input),
    /** 接线层每轮（或取消/关窗）调用：清掉该窗口的 allowSession 授权。 */
    resetApprovals: senderId => coordinator.resetSender(senderId),
    listMissingDependencies: () => registry.skipped
      .filter(item => item.reason === 'missing_dependencies')
      .map(item => ({ pack: item.pack, missing: [...(item.missing ?? [])] })),
    warnings: registry.warnings,
    registry,
    packs: registry.packs,
    logger,
  };
  return runtime;
}
