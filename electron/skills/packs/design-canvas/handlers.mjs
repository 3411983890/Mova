/**
 * 负责：把 `electron/design-runtime.cjs` 的 `tools(sender, scope, signal, emit, options)` 返回的 6 个画板工具
 *   包成技能 handler——逐字段校验参数、写类先过 `ctx.authorize()`、转发工具事件、
 *   并把 `design_screenshot` 的 PNG 落盘成 chat-images 后用 `image` 元数据交给前端内联展示。
 * 不负责：画布操作语义与逐 op 校验（`src/features/design/design-node-spec.js`）、
 *   文档快照/乐观锁/超时（design-runtime 的 command/respond）、
 *   图片存储与体积上限（electron/chat-images.cjs 的 saveImage）、审批判定（approval-bridge.mjs）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-design-pack.test.mjs。
 *
 * 三条硬约束（改这个文件前先读）：
 * 1) 永不 throw：MCP 里一个异常就打断整轮。失败一律收敛成 `isError` 结果。
 * 2) 写类（design_apply / design_undo）必须在**任何**画布调用之前拿到授权：拒绝时零副作用。
 * 3) 截图不能发 `{type:'image'}` 事件（app.js 会把它当成用户附件写进 turn.imageIds）；
 *    像素只走 chat-images 落盘 + 返回值的 `image` 字段，由 events.mjs 挂到 tool 事件上。
 *
 * 为什么 `designRuntime.tools()` 每次调用都重建：`tools()` 把 `signal` 与 `emit` 闭包进去了，
 * 复用上一轮（或上一个 callId）的实例会让「停止」按钮和事件行都指向错误的一行。
 */

import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';
import { invalidArgumentsResult, validateInput } from '../../input-schema.mjs';

/** 事件 detail 只用于一行摘要，不转储日志。 */
const DETAIL_CHARS = 300;
/** 与 manifest 的 inputSchema 保持一致。 */
const MAX_OPERATIONS = 200;
const MAX_IDS = 40;
const MAX_STRING = 500;
/** 会让画布文档真正变化的工具：必须先过 ctx.authorize()。 */
const WRITE_TOOLS = new Set(['design_apply', 'design_undo']);

/**
 * 逐工具的参数规则。只声明「本 handler 负责校验」的字段：类型、必填、范围、枚举。
 * 方言与校验器都是 `electron/skills/input-schema.mjs` 那一份，本文件不再自带副本。
 * 不做 op 语义判断（action/type/字段名）——那是 design-node-spec.js 的单一事实源，
 * 抄一份必然漂移；那边会用 `failed[].code="unknown_field"` 把允许的键回给模型。
 */
const SPECS = Object.freeze({
  design_open: {},
  design_read: {
    nodeId: { type: 'string', maxLength: 200 },
    depth: { type: 'number', minimum: 1, maximum: 20 },
    query: { type: 'string', maxLength: MAX_STRING },
    limit: { type: 'number', minimum: 1, maximum: 1_000 },
    fonts: { type: 'boolean' },
  },
  design_apply: {
    operations: {
      type: 'array',
      required: true,
      minItems: 1,
      maxItems: MAX_OPERATIONS,
      items: { type: 'object' },
    },
    basedOnRevision: { type: 'integer', minimum: 0 },
  },
  design_undo: {},
  design_screenshot: {
    nodeId: { type: 'string', maxLength: 200 },
    ids: { type: 'array', maxItems: MAX_IDS, items: { type: 'string', minLength: 1, trim: true } },
    scale: { type: 'number', minimum: 0.1, maximum: 4 },
    maxEdge: { type: 'number', minimum: 64, maximum: 4096 },
    // 大小写宽容：模型常把 "png" 当格式名传，画布侧本来就统一按大写处理。
    format: { type: 'string', enum: ['PNG', 'JPG', 'WEBP'], normalize: 'upper' },
  },
  design_fonts: {
    family: { type: 'string', maxLength: 120 },
  },
});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 参数错误的唯一出口：错误码与形状由 input-schema.mjs 统一拼（技能层只有那一处写 invalid_arguments）。 */
function invalid(message) {
  return invalidArgumentsResult([{ path: '', message }]);
}

/** 事件通道：优先 per-call 的 ctx.emit（同一轮），其次 deps.emit（接线层注入）。 */
function emitOf(deps, ctx) {
  if (typeof ctx?.emit === 'function') return ctx.emit;
  if (typeof deps?.emit === 'function') return deps.emit;
  return null;
}

function callIdOf(ctx) {
  return typeof ctx?.callId === 'string' && ctx.callId ? ctx.callId : '';
}

/** 拒绝/降级时补一条旁白：handler 不抛错，旁白是唯一能说清原因的地方。 */
function notice(deps, ctx, text) {
  const emit = emitOf(deps, ctx);
  if (!emit) return;
  try {
    emit({ type: 'notice', tone: 'warn', text: String(text).slice(0, DETAIL_CHARS) });
  } catch { /* 旁白发不出去不影响结论 */ }
}

function logInfo(ctx, text) {
  try {
    ctx?.logger?.info?.(text);
  } catch { /* 日志失败不影响工具结果 */ }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null) ?? '';
  } catch {
    return '';
  }
}

/** 授权：没有通道一律拒绝（宁可要不到画板，也不要静默放行写操作）。 */
async function requestAuthorization(ctx, args) {
  if (typeof ctx?.authorize !== 'function') {
    return { allowed: false, code: 'permission_unavailable', reason: '缺少授权通道（ctx.authorize），写操作已拒绝' };
  }
  try {
    const verdict = await ctx.authorize(undefined, args);
    if (verdict === true) return { allowed: true };
    if (verdict && typeof verdict === 'object') {
      if (verdict.allowed === true || verdict.ok === true) return { allowed: true };
      return {
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

/**
 * 建这一次调用专属的画板工具集，并把 design-runtime 自己的 tool 事件转发到本行的 callId 上。
 * 转发时**故意不带 name / label**：前端的 mergeReplyEvent 是 Object.assign 原地覆盖，
 * 少给两个键，工具行的名字就还是 manifest 里的中文名，而不是 runtime 里那句泛化的「设计画板」。
 *
 * `images: true` 是**无条件**的：要落盘就必须先拿到 base64，而 design-runtime 只在 options.images
 * 为真时才把像素块放进返回值。能不能把图块交给模型是后面 settleScreenshot 的判断，
 * 不是这里的——否则「模型看不见图」和「截图存不下来」会被同一个开关捆在一起。
 */
function buildTools(deps, ctx) {
  const emit = emitOf(deps, ctx);
  const callId = callIdOf(ctx);
  const forward = event => {
    if (!emit || !isPlainObject(event)) return;
    const status = typeof event.status === 'string' ? event.status : '';
    if (!status) return;
    const row = {
      type: 'tool',
      ...(callId ? { id: callId } : {}),
      status,
      ...(typeof event.detail === 'string' && event.detail.trim()
        ? { detail: event.detail.trim().slice(0, DETAIL_CHARS) } : {}),
    };
    try {
      emit(row);
    } catch { /* 进度事件发不出去不影响工具结果 */ }
  };
  try {
    const list = deps.designRuntime.tools(deps.sender, deps.conversationId, ctx?.signal, forward, { images: true });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function findTool(tools, name) {
  return Array.isArray(tools)
    ? (tools.find(tool => tool?.name === name && typeof tool.execute === 'function') ?? null)
    : null;
}

/** 一行摘要：画布工具的结果是 JSON，摘要只挑对人有用的一两个数字。 */
function detailOf(name, details) {
  const d = isPlainObject(details) ? details : {};
  const revision = Number.isFinite(d.revision) ? `revision=${d.revision}` : '';
  if (name === 'design_apply') {
    const failed = Array.isArray(d.failed) ? d.failed.length : 0;
    const firstCode = failed && isPlainObject(d.failed[0]) && typeof d.failed[0].code === 'string' ? d.failed[0].code : '';
    return [
      revision,
      `新增 ${Array.isArray(d.created) ? d.created.length : 0}`,
      `更新 ${Array.isArray(d.applied) ? d.applied.length : 0}`,
      failed ? `失败 ${failed}${firstCode ? `（${firstCode}）` : ''}` : '失败 0',
    ].filter(Boolean).join(' · ').slice(0, DETAIL_CHARS);
  }
  if (name === 'design_open') return ['已切换到画板', revision].filter(Boolean).join(' · ');
  if (name === 'design_read') return ['已读取画板', revision].filter(Boolean).join(' · ');
  if (name === 'design_undo') return ['已撤销上一笔', revision].filter(Boolean).join(' · ');
  if (name === 'design_fonts') {
    return Number.isFinite(d.count) ? `${d.count} 个可用字体家族` : '已读取字体状态';
  }
  return '';
}

/** `{ content, details }` → MCP 结果 + detail；content 原样保留（文本由适配层按预算截断）。 */
function adopt(raw, name) {
  const detail = detailOf(name, raw?.details);
  if (isPlainObject(raw) && Array.isArray(raw.content) && raw.content.length) {
    return { content: raw.content, ...(detail ? { detail } : {}) };
  }
  const fallback = safeJson(raw?.details ?? raw);
  return { ...textResult(fallback || 'ok'), ...(detail ? { detail } : {}) };
}

function parseMeta(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

/** 截图尺寸文案：「1280×800」；拿不到宽高时返回空串（绝不编一个尺寸）。 */
function sizeLabel(meta) {
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
  return `${Math.round(width)}×${Math.round(height)}`;
}

function byteLabel(meta) {
  const bytes = Number(meta?.byteLength ?? meta?.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * `design_screenshot` 的收尾：像素落盘成 chat-images，正文只留元数据与降级说明。
 *
 * 两种情况都不许报错中断——
 *   a) `deps.chatImages` 缺失：不落盘，正文写尺寸，加一条 notice 说「截图无法保存」；
 *   b) `saveImage` 抛错（超过 4 MB、格式不符）：同上，把原因写进正文。
 * 通道不支持看图时（ACP 的默认值），即使落盘成功也只交文字：像素留在对话里给用户看，
 * 正文明确告诉模型「你只拿到了数字，别声称看过像素」。
 */
async function settleScreenshot(deps, ctx, raw) {
  const content = isPlainObject(raw) && Array.isArray(raw.content) ? raw.content : [];
  if (!content.length) return adopt(raw, 'design_screenshot');

  const textPart = content.find(item => item?.type === 'text');
  const text = typeof textPart?.text === 'string' && textPart.text ? textPart.text : safeJson(raw?.details);
  const block = content.find(item => item?.type === 'image') ?? null;
  const meta = parseMeta(text);
  const base64 = typeof block?.data === 'string' ? block.data.trim() : '';
  const mimeType = typeof block?.mimeType === 'string' && block.mimeType.startsWith('image/')
    ? block.mimeType
    : (typeof meta.mimeType === 'string' && meta.mimeType.startsWith('image/') ? meta.mimeType : 'image/png');
  const label = sizeLabel(meta);
  const caption = label ? `画板截图 · ${label}` : '画板截图';
  const canSee = ctx?.supportsImages === true;

  if (!base64) {
    // 没有像素（例如空页面）：只有元数据可交，别伪造一张图。
    return {
      ...textResult(text),
      detail: ['已导出', label, byteLabel(meta)].filter(Boolean).join(' · ').slice(0, DETAIL_CHARS),
    };
  }

  const images = deps?.chatImages ?? ctx?.chatImages ?? null;
  let imageMeta = null;
  let degrade = '';
  if (!images || typeof images.saveImage !== 'function') {
    degrade = '截图无法保存到对话（chat-images 不可用），只有尺寸与节点信息可用。';
    notice(deps, ctx, `画板截图无法保存：chat-images 未注入${label ? `（截图尺寸 ${label}）` : ''}`);
  } else {
    try {
      const saved = await images.saveImage({ dataUrl: `data:${mimeType};base64,${base64}`, name: caption });
      const id = typeof saved?.id === 'string' ? saved.id.trim() : '';
      if (!id) throw new Error('saveImage 没有返回图片 id');
      imageMeta = { id, name: caption, src: `./chat-images/${id}` };
      logInfo(ctx, `[skills] screenshot saved chat-images/${id}`);
    } catch (error) {
      degrade = `截图无法保存到对话（${messageOf(error)}），只有尺寸与节点信息可用。`;
      notice(deps, ctx, `画板截图无法保存：${messageOf(error)}`);
    }
  }

  const notes = [];
  if (degrade) notes.push(degrade);
  if (!canSee) {
    notes.push('（当前通道不支持看图：截图已内联显示在用户的对话里，'
      + '你只能依据上面的尺寸与元数据判断，不要声称看过像素。）');
  }
  return {
    content: [{ type: 'text', text: notes.length ? `${text}\n\n${notes.join('\n')}` : text },
      ...(canSee && block ? [block] : [])],
    ...(imageMeta ? { image: imageMeta } : {}),
    detail: [caption, byteLabel(meta)].filter(Boolean).join(' · ').slice(0, DETAIL_CHARS),
  };
}

/**
 * 包装一个画板工具。
 * @param {object} deps
 * @param {string} name 工具名（与 designRuntime.tools() 返回的 tool.name 一致）
 */
function wrapTool(deps, name) {
  const spec = SPECS[name];
  const needsApproval = WRITE_TOOLS.has(name);
  return async function handler(rawArgs, rawCtx) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const ctx = isPlainObject(rawCtx) ? rawCtx : {};
    // 入参校验走技能层唯一的入口（electron/skills/input-schema.mjs）：未声明的键一律丢弃。
    const checked = validateInput({ type: 'object', properties: spec, additionalProperties: false }, args);
    if (!checked.ok) return invalidArgumentsResult(checked.errors);

    // 授权在**任何**画布调用之前：拒绝时零副作用（不建工具、不发命令、不落快照）。
    if (needsApproval) {
      const verdict = await requestAuthorization(ctx, checked.value);
      if (verdict.allowed !== true) {
        notice(deps, ctx, `已拒绝 ${name}：${verdict.reason}`);
        return errorResult(verdict.code, verdict.reason);
      }
    }

    const tool = findTool(buildTools(deps, ctx), name);
    if (!tool) return errorResult('tool_unavailable', `当前会话没有可用的 ${name}（画板未启用或设计运行时不可用）`);

    let raw;
    try {
      raw = await tool.execute(callIdOf(ctx) || name, checked.value);
    } catch (error) {
      return errorResult(error?.code ?? 'tool_failed', messageOf(error));
    }
    if (name === 'design_apply') {
      const details = isPlainObject(raw?.details) ? raw.details : {};
      logInfo(ctx, `[skills] design_apply revision=${Number.isFinite(details.revision) ? details.revision : '?'}`
        + ` failed=${Array.isArray(details.failed) ? details.failed.length : 0}`);
    }
    if (name === 'design_screenshot') return settleScreenshot(deps, ctx, raw);
    return adopt(raw, name);
  };
}

/**
 * @param {{ designRuntime?: object|null, sender?: object|null, conversationId?: string,
 *   chatImages?: object|null, emit?: Function }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  const runtime = deps?.designRuntime;
  // 没有设计运行时就没有画板：整个包不暴露（manifest 的 dependencies 已在 registry 侧裁过一次，
  // 这里再判一次是为了让 handler 单独被调用时也不会造出一个「一调就报错」的工具）。
  if (!runtime || typeof runtime.tools !== 'function') return {};
  const sender = deps?.sender;
  const scope = typeof deps?.conversationId === 'string' ? deps.conversationId.trim() : '';
  if (!sender || !scope) return {};

  let available;
  try {
    // 探测一次「这一轮到底有哪几个工具」：模型不该看见一个一调就报 tool_unavailable 的工具。
    const probe = runtime.tools(sender, scope, undefined, () => {}, { images: false });
    available = (Array.isArray(probe) ? probe : [])
      .filter(tool => tool && typeof tool.name === 'string' && typeof tool.execute === 'function')
      .map(tool => tool.name);
  } catch {
    return {};
  }
  if (!available.length) return {};

  const handlers = {};
  // scope 只在这里归一一次：探测用了 trim 后的值，真正调用也必须用同一个，否则「探测到的工具」
  // 和「实际执行的 scope」会指向两份不同的画板文档。
  const bound = { ...deps, conversationId: scope };
  for (const name of Object.keys(SPECS)) {
    if (available.includes(name)) handlers[name] = wrapTool(bound, name);
  }
  return handlers;
}
