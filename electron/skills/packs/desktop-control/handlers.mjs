/**
 * 负责：把 `electron/desktop/tools.cjs`（`createDesktopTools()` 的 10 个桌面工具）包成技能 handler——
 *   逐字段校验参数、写/执行前先过技能层授权闸门、把调用原样委托给真实 `execute(id, input, signal)`、
 *   截图成功后经 `deps.chatImages.saveImage()` 落盘并挂 `image` 元数据。
 * 不负责：输入注入与窗口操作本身（desktop/actions.cjs、session.cjs、capture.cjs）、桌面风险分级与
 *   R3/R4 判定（desktop/policy.cjs 的 classifyDesktopAction）、人工接管的等待与 humanWait 登记
 *   （desktop/index.cjs 的 handoff 已经包好，这里绝不重复登记）、图片落盘规则（electron/chat-images.cjs）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-desktop-pack.test.mjs。
 *
 * 硬约束：
 * - **永不 throw**（MCP 里一个异常就打断整轮），失败一律收敛成 `isError` 结果。
 * - 写/执行类（点按输入、批量、应用、技能库写入）在 `ctx.authorize()` 未放行时**零副作用**直接返回拒绝结果。
 * - `desktop_handoff` 刻意**不**过 `ctx.authorize()`：它是安全出口，被审批条拦住只会把模型逼回
 *   「自己动手填密码/点支付」。它的风险在 manifest 里声明为 exec，交给桌面引擎自己的 policy 判。
 * - 不重新实现任何输入注入，也不把 `deps` 之外的宿主对象塞进 handler。
 *
 * `deps.desktop` 三种形态（由接线层决定，都只是「拿到这一轮的工具数组」的不同写法）：
 *   1) 数组：`createDesktopTools(operations, { emit, approve })` 的返回值。工具事件走接线层自己的 emit。
 *      approve 已经在闭包里，本包包不进去（见 openTools 的头注释）。
 *   2) 工厂：`({ emit, callId, signal }) => DesktopTool[]`，每次调用新建一份并把事件转给同一个 callId。
 *      **推荐**：这样 done/error 与技能行是同一行原地更新。
 *   3) 引擎对象：`{ tools(callOptions) }`（desktop/index.cjs 的 `api`）。本包把 approve 包一层再交进去：
 *      技能层已授权就直接回允许，不再弹第二次；未授权才转给 `deps.desktopApprove`，
 *      缺它时按引擎自己的语义报 `approval-unavailable`。
 */

import { readFileSync } from 'node:fs';
import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';
import { invalidArgumentsResult, validateInput } from '../../input-schema.mjs';

/** 事件 detail / 错误摘要只占一行，不转储整个结果。 */
const DETAIL_CHARS = 300;
/** 截图文件名到 mime 的映射：chat-images 的白名单只认这四种。 */
const MIME_BY_EXT = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });
/** 走人工审批的工具：真的会动鼠标键盘、启动进程或写本地技能库。 */
const GATED_TOOLS = new Set(['desktop_act', 'desktop_batch', 'desktop_app', 'desktop_skill']);
/**
 * 技能层已经授权时交给桌面引擎的 approve 回执（引擎把非 'deny' 的字符串当成批准回执，
 * 并写进 audit 的 approvalId）。用固定文案而不是编一个 id，日志里一眼能看出这次没有弹第二遍。
 */
const SKILL_LAYER_GRANT = 'skill-layer-granted';

/**
 * 逐工具的参数规则。只声明本 handler 负责的校验：类型、必填、长度/范围/枚举。
 * 业务判断（这个 ref 是否存在、这次按键是不是 R4）留给 desktop/policy.cjs 与桌面引擎。
 * 方言与校验器都是 `electron/skills/input-schema.mjs` 那一份，本文件不再自带副本。
 */
const SPECS = Object.freeze({
  desktop_windows: {
    action: { type: 'string', enum: ['list', 'active', 'displays'] },
    app: { type: 'string', maxLength: 120 },
    includeMinimized: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  desktop_snapshot: {
    mode: { type: 'string', enum: ['auto', 'full', 'diff'] },
    window: { type: 'string', maxLength: 200 },
    scope: { type: 'string', enum: ['focus', 'window', 'dialog'] },
    depth: { type: 'integer', minimum: 1, maximum: 12 },
    maxChars: { type: 'integer', minimum: 1_000, maximum: 60_000 },
    boxes: { type: 'boolean' },
    skills: { type: 'boolean' },
  },
  desktop_act: {
    action: {
      type: 'string',
      required: true,
      enum: ['invoke', 'click', 'type', 'key', 'scroll', 'drag', 'focus', 'toggle', 'select', 'setValue'],
    },
    target: { type: 'string', maxLength: 300 },
    value: { type: 'string', maxLength: 4_000, allowEmpty: true },
    keys: { type: 'string', maxLength: 120 },
    to: { type: 'string', maxLength: 200 },
    expect: { type: 'object' },
    pixels: { type: 'boolean' },
    tier: { type: 'string', enum: ['auto', 't1', 't2', 't3'] },
    timeout: { type: 'integer', minimum: 500, maximum: 60_000 },
    snapshot: { type: 'boolean' },
  },
  desktop_wait: {
    for: { type: 'string', required: true, enum: ['window', 'element', 'text', 'idle', 'stable', 'time'] },
    title: { type: 'string', maxLength: 200 },
    ref: { type: 'string', maxLength: 200 },
    text: { type: 'string', maxLength: 300 },
    ms: { type: 'integer', minimum: 0, maximum: 5_000 },
    timeout: { type: 'integer', minimum: 500, maximum: 60_000 },
  },
  desktop_screenshot: {
    mode: { type: 'string', enum: ['auto', 'thumb', 'window', 'region'] },
    window: { type: 'string', maxLength: 200 },
    region: { type: 'object' },
    maxLongEdge: { type: 'integer', minimum: 320, maximum: 2_560 },
    ocr: { type: 'boolean' },
    annotate: { type: 'string', enum: ['som', 'none'] },
    zoom: { type: 'number', minimum: 1, maximum: 4 },
    includeInResult: { type: 'boolean' },
    reason: { type: 'string', maxLength: 60 },
  },
  desktop_read: {
    window: { type: 'string', maxLength: 200 },
    scope: { type: 'string', enum: ['focus', 'window', 'dialog', 'selection'] },
    format: { type: 'string', enum: ['text', 'table'] },
    maxChars: { type: 'integer', minimum: 500, maximum: 60_000 },
  },
  desktop_batch: {
    recipe: { type: 'string', maxLength: 120 },
    inputs: { type: 'object' },
    steps: { type: 'array', maxItems: 30, items: { type: 'object' } },
    stopOnError: { type: 'boolean' },
    snapshot: { type: 'string', enum: ['end', 'diff', 'none'] },
    timeout: { type: 'integer', minimum: 5_000, maximum: 300_000 },
  },
  desktop_app: {
    action: { type: 'string', required: true, enum: ['launch', 'activate', 'close'] },
    app: { type: 'string', required: true, maxLength: 200 },
    args: { type: 'array', maxItems: 20, items: { type: 'string' } },
    cwd: { type: 'string', maxLength: 400 },
  },
  desktop_skill: {
    action: { type: 'string', required: true, enum: ['list', 'find', 'save', 'remove'] },
    id: { type: 'string', maxLength: 120 },
    app: { type: 'string', maxLength: 120 },
    intent: { type: 'array', maxItems: 20, items: { type: 'string' } },
    title: { type: 'string', maxLength: 200 },
    steps: { type: 'array', maxItems: 30, items: { type: 'object' } },
    params: { type: 'array', maxItems: 20, items: { type: 'object' } },
    verify: { type: 'object' },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  },
  desktop_handoff: {
    reason: {
      type: 'string',
      required: true,
      enum: ['login', 'password', 'uac', 'captcha', '2fa', 'payment', 'consent', 'choice', 'other'],
    },
    note: { type: 'string', maxLength: 200 },
  },
});

/** 参数错误的唯一出口：错误码与形状由 input-schema.mjs 统一拼（技能层只有那一处写 invalid_arguments）。 */
function invalid(message) {
  return invalidArgumentsResult([{ path: '', message }]);
}

function isTool(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.name === 'string' && typeof value.execute === 'function';
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 事件通道：优先 per-call 的 ctx.emit（同一轮），其次 deps.emit（接线层注入）。 */
function emitOf(deps, ctx) {
  if (typeof ctx?.emit === 'function') return ctx.emit;
  if (typeof deps?.emit === 'function') return deps.emit;
  return null;
}

/** 降级/拒绝时补一条旁白：handler 不抛错，工具行不会变红，旁白是唯一能说清原因的地方。 */
function notice(deps, ctx, text) {
  const emit = emitOf(deps, ctx);
  if (!emit) return;
  try {
    emit({ type: 'notice', tone: 'warn', text: String(text).slice(0, DETAIL_CHARS) });
  } catch { /* 旁白发不出去不影响结论 */ }
}

/** schema 表达不了的互斥约束在入口判一次（宁可先给 invalid_arguments，也不要让引擎报天书）。 */
function crossCheck(name, args) {
  if (name === 'desktop_act') {
    const hasValue = typeof args.value === 'string' && args.value.length > 0;
    const hasKeys = typeof args.keys === 'string' && args.keys.trim().length > 0;
    if ((args.action === 'key' || args.action === 'press') && !hasKeys && !hasValue) {
      return { ok: false, message: 'action=key 时必须给 keys（例如 Ctrl+S）' };
    }
    if ((args.action === 'type' || args.action === 'setValue') && !hasValue) {
      return { ok: false, message: `action=${args.action} 时必须给 value` };
    }
    if (args.action === 'drag' && !(typeof args.to === 'string' && args.to.trim())) {
      return { ok: false, message: 'action=drag 时必须给 to（目标 ref 或 x,y）' };
    }
  }
  if (name === 'desktop_batch') {
    const hasSteps = Array.isArray(args.steps) && args.steps.length > 0;
    const hasRecipe = typeof args.recipe === 'string' && args.recipe.trim().length > 0;
    if (!hasSteps && !hasRecipe) return { ok: false, message: 'steps 与 recipe 至少要给一个' };
  }
  if (name === 'desktop_skill' && args.action === 'remove'
    && !(typeof args.id === 'string' && args.id.trim())) {
    return { ok: false, message: 'action=remove 时必须给 id' };
  }
  return { ok: true };
}

/**
 * 交给 `ctx.authorize()` 的参数：只带「这次要操作什么」，**刻意不带** cwd / path。
 * approval-bridge 的 firstPathOf() 认 path/file/filePath/cwd/dir，而 desktop_app 的 cwd 是应用的
 * 工作目录、不是项目内路径——原样传进去会被路径闸门判成越界，等于把所有启动都挡死。
 */
function approvalArgsOf(args) {
  const target = typeof args.app === 'string' ? args.app
    : (typeof args.target === 'string' ? args.target : '');
  return target ? { target } : {};
}

/** 授权：没有通道一律拒绝（宁可要不到工具，也不要静默放行输入注入）。 */
async function requestAuthorization(ctx, args) {
  if (typeof ctx?.authorize !== 'function') {
    return { allowed: false, code: 'permission_unavailable', reason: '缺少授权通道（ctx.authorize），桌面操作已拒绝' };
  }
  try {
    const verdict = await ctx.authorize(undefined, approvalArgsOf(args));
    if (verdict === true) return { allowed: true };
    if (verdict && typeof verdict === 'object') {
      const allowed = verdict.allowed === true || verdict.ok === true;
      return allowed ? { allowed: true } : {
        allowed: false,
        code: typeof verdict.code === 'string' && verdict.code ? verdict.code : 'approval_denied',
        reason: typeof verdict.reason === 'string' && verdict.reason ? verdict.reason : '未获授权',
      };
    }
    return { allowed: false, code: 'approval_denied', reason: '授权通道没有给出明确结论' };
  } catch (error) {
    return { allowed: false, code: 'approval_failed', reason: messageOf(error) };
  }
}

/** 桌面工具自己的返回值已经是 MCP 形状；这里只补 detail，并把 isError 原样透传。 */
function adoptResult(raw, meta = {}) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
    return { content: raw.content, ...(raw.isError === true ? { isError: true } : {}), ...meta };
  }
  if (typeof raw === 'string') return { ...textResult(raw), ...meta };
  try {
    return { ...textResult(JSON.stringify(raw ?? null)), ...meta };
  } catch {
    return { ...textResult(String(raw)), ...meta };
  }
}

/** 结果里的第一段文本（桌面工具把 JSON 放在这里）。 */
function textOf(raw) {
  return Array.isArray(raw?.content)
    ? (raw.content.find(part => part?.type === 'text')?.text ?? '')
    : '';
}

/** 把桌面工具的 JSON 文本解析回对象；解析不出来就是 null（截图降级要靠它）。 */
function payloadOf(raw) {
  const text = textOf(raw);
  if (typeof text !== 'string' || !text) return null;
  try {
    const payload = JSON.parse(text);
    return plainObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** 失败原因：桌面工具用 `{ok:false, code, message}` 表达失败，给时间线一行摘要。 */
function failureReason(raw) {
  const payload = payloadOf(raw);
  if (!payload) return '操作失败';
  const message = typeof payload.message === 'string' ? payload.message : '';
  const code = typeof payload.code === 'string' ? payload.code : '';
  return (message || code || '操作失败').slice(0, DETAIL_CHARS);
}

/** 截图文件 → data URL（chat-images 的 saveImage 只吃 `data:image/(png|jpeg|webp|gif);base64,`）。 */
function dataUrlOf(path) {
  const bytes = readFileSync(path);
  const ext = String(path).split('.').pop()?.toLowerCase() ?? '';
  const mimeType = MIME_BY_EXT[ext] ?? 'image/png';
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/**
 * 截图落盘 + 内联展示。返回 `{ image }` 或 `{ degraded: 原因 }`：任何一步失败都只降级，绝不报错
 * （截图本身已经成功，用户仍然应该拿到尺寸与路径）。
 *
 * chatImages 优先取 per-call 的 `ctx.chatImages`（技能运行时逐调用注入），其次 `deps.chatImages`。
 */
async function saveScreenshot(deps, ctx, payload) {
  const path = typeof payload?.path === 'string' ? payload.path : '';
  const width = Number(payload?.width) || 0;
  const height = Number(payload?.height) || 0;
  const save = typeof ctx?.chatImages?.saveImage === 'function'
    ? ctx.chatImages.saveImage.bind(ctx.chatImages)
    : deps?.chatImages?.saveImage;
  if (!path) return { degraded: '截图没有返回文件路径' };
  if (typeof save !== 'function') return { degraded: '聊天图片通道未接线（chatImages.saveImage）' };
  let dataUrl;
  try {
    dataUrl = dataUrlOf(path);
  } catch (error) {
    return { degraded: `截图文件读不出来：${messageOf(error)}` };
  }
  try {
    const saved = await save({ dataUrl, name: '桌面截图' });
    const id = typeof saved?.id === 'string' ? saved.id : '';
    if (!id) return { degraded: '聊天图片通道没有返回图片 id' };
    return {
      image: {
        id,
        name: `桌面截图 · ${width}×${height}`,
        src: `./chat-images/${id}`,
      },
    };
  } catch (error) {
    return { degraded: `截图落盘失败：${messageOf(error)}` };
  }
}

/**
 * 拿到这一次调用可用的桌面工具。
 * 工厂/引擎形态下顺带把桌面工具自己的 tool 事件转给同一个 callId：前端同一行原地更新。
 *
 * `grant` 是**这一次调用**的授权结论（`{ authorized: boolean }`，由 wrapTool 在 ctx.authorize()
 * 放行后置 true）。引擎形态下我们把自己的 approve 交给 `createDesktopTools`：
 *
 *   **技能层是这个工具唯一的审批入口，引擎层不得再弹第二次。**
 *
 * `ctx.authorize()`（exec 能力位）已经问过人了，引擎的 `authorize()` 再调 approve 就是同一个决定
 * 问两遍——用户会被弹两次，第二次还可能因为「本会话已允许」的缓存被跳过而给出不一致的结论。
 * 所以 approve 在这里被包一层：本次调用已获授权就直接回「允许」，未获授权才把请求转给接线层的
 * `deps.desktopApprove`（没有它时按引擎自己的语义报 approval-unavailable，不静默放行）。
 *
 * 数组形态（接线层已经 `createDesktopTools(..., { approve })` 建好）包不进去：approve 在闭包里，
 * 技能层拿不到，只能由接线层按同一原则处理（chat-agent 侧属于另一处改动，不在本包内）。
 */
function openTools(deps, ctx, grant) {
  const source = deps?.desktop;
  if (Array.isArray(source)) return { tools: source.filter(isTool) };
  const emit = emitOf(deps, ctx);
  const forward = (event) => {
    if (!emit || !event || typeof event !== 'object') return;
    try {
      emit(event);
    } catch { /* 事件发不出去不影响工具结果 */ }
  };
  if (typeof source === 'function') {
    try {
      const list = source({ callId: ctx.callId, signal: ctx.signal, emit: forward });
      return { tools: (Array.isArray(list) ? list : []).filter(isTool) };
    } catch {
      return { tools: [] };
    }
  }
  if (source && typeof source.tools === 'function') {
    try {
      const delegate = typeof deps.desktopApprove === 'function' ? deps.desktopApprove : null;
      const approve = async (request, signal) => {
        if (grant?.authorized === true) return SKILL_LAYER_GRANT;
        if (delegate) return delegate(request, signal);
        // 与 electron/desktop/tools.cjs 里「没有 approve 通道」的失败保持同一 code/文案。
        const error = new Error('桌面操作需要审批，但当前没有可用的审批通道');
        error.code = 'approval-unavailable';
        throw error;
      };
      const list = source.tools({ emit: forward, approve });
      return { tools: (Array.isArray(list) ? list : []).filter(isTool) };
    } catch {
      return { tools: [] };
    }
  }
  return { tools: [] };
}

/** 包装一个桌面工具：校验 →（写类）授权 → 委托真实 execute → 归一结果。 */
function wrapTool(deps, name) {
  const spec = SPECS[name];
  const gated = GATED_TOOLS.has(name);
  return async function handler(rawArgs, rawCtx) {
    try {
      const args = plainObject(rawArgs) ? rawArgs : {};
      const ctx = plainObject(rawCtx) ? rawCtx : {};
      // 入参校验走技能层唯一的入口（electron/skills/input-schema.mjs）：未声明的键一律丢弃。
      const checked = validateInput({ type: 'object', properties: spec, additionalProperties: false }, args);
      if (!checked.ok) return invalidArgumentsResult(checked.errors);
      const cross = crossCheck(name, checked.value);
      if (!cross.ok) return invalid(cross.message);

      // 本次调用的授权结论：openTools 拿它决定引擎层的 approve 要不要再问人（见 openTools 的头注释）。
      const grant = { authorized: false };
      const { tools } = openTools(deps, ctx, grant);
      const tool = tools.find(item => item.name === name);
      if (!tool) return errorResult('tool_unavailable', `当前会话没有可用的 ${name}（桌面引擎未启动或电脑操作已关闭）`);

      if (gated) {
        const verdict = await requestAuthorization(ctx, checked.value);
        if (verdict.allowed !== true) {
          notice(deps, ctx, `已拒绝 ${name}：${verdict.reason}`);
          return errorResult(verdict.code, verdict.reason);
        }
        // 复用同一次调用的授权结论，不另建缓存：只对这一条调用生效，跨调用一律重新问。
        grant.authorized = true;
      }

      let raw;
      try {
        raw = await tool.execute(ctx.callId ?? name, checked.value, ctx.signal);
      } catch (error) {
        return errorResult(error?.code ?? 'tool_failed', messageOf(error));
      }

      if (raw?.isError === true) {
        const reason = failureReason(raw);
        // 原因挂在工具行自己的 detail 上即可；再发 notice 会在时间线底部多一条重复提示。
        return { ...adoptResult(raw), detail: reason };
      }
      if (name !== 'desktop_screenshot') return adoptResult(raw);

      // 截图：先把结果挂上 image（落盘失败只降级），正文里本来就有尺寸与路径。
      const payload = payloadOf(raw);
      const width = Number(payload?.width) || 0;
      const height = Number(payload?.height) || 0;
      const settled = await saveScreenshot(deps, ctx, payload);
      if (settled.image) return adoptResult(raw, { image: settled.image, detail: `${width}×${height}` });
      notice(deps, ctx, `截图已生成（${width}×${height}），但没有内联展示：${settled.degraded}`);
      return adoptResult(raw, { detail: `${width}×${height}` });
    } catch (error) {
      // 兜底：handler 永不 throw（MCP 里一个异常就打断整轮）。
      return errorResult(error?.code ?? 'tool_failed', messageOf(error));
    }
  };
}

/**
 * @param {{ desktop?: object[]|Function|{ tools: Function }, desktopApprove?: Function,
 *   chatImages?: { saveImage?: Function }, emit?: Function }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  const source = deps?.desktop;
  if (source === undefined || source === null || source === false) return {};

  let available = null;
  if (Array.isArray(source)) {
    available = source.filter(isTool).map(tool => tool.name);
  } else if (typeof source === 'function') {
    // 探测一次「这一轮到底有哪些工具」：模型不该看见一个一调就报 tool_unavailable 的工具。
    try {
      const probe = source({ emit() {}, callId: undefined, signal: undefined });
      available = (Array.isArray(probe) ? probe : []).filter(isTool).map(tool => tool.name);
    } catch {
      return {};
    }
  } else if (typeof source?.tools === 'function') {
    try {
      const probe = source.tools({});
      available = (Array.isArray(probe) ? probe : []).filter(isTool).map(tool => tool.name);
    } catch {
      return {};
    }
  }
  if (!available || !available.length) return {};

  const handlers = {};
  for (const name of available) {
    if (!SPECS[name]) continue; // tools.cjs 将来新增的工具：先在这里补 schema，再自动生效
    handlers[name] = wrapTool(deps, name);
  }
  return handlers;
}
