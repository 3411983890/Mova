/**
 * 负责：把 `electron/browser/tools.cjs`（`createBrowserTools()` 导出的浏览器工具）包成技能 handler——
 *   逐字段校验参数、写/执行类先申请授权、调用既有 execute、抽出 detail 与截图 image 元信息，
 *   并把 `browser_batch` 的每一步通过 `ctx.progress()` 原地刷新到前端同一行；
 *   外加 `file://` 的本地文件闸门（只允许已登记项目根内的可展示类型，见 `guardLocalFile()`；
 *   真正的强制点在 `electron/browser/target.cjs` 的 `PageTarget.navigate()`，这里是早失败 + 好文案）。
 * 不负责：任何 CDP/页面操作实现（全部留在 electron/browser/**）、站点风险分级（policy.cjs）、
 *   审批弹条与能力位（approval-bridge.mjs）、截图落盘的具体写法（electron/chat-images.cjs）、
 *   结果截断（electron/skills/adapters/mcp.mjs）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-browser-pack.test.mjs。
 *
 * `deps.browser` 两种形态（由接线层决定）：
 *   1) 数组：`createBrowserTools(operations)` 的返回值（推荐，`controller.tools({ emit, approve, timing })`）。
 *      工具自己的 running/done 事件走接线层注入的 emit，会与分步进度落在**同一行**（同一 callId），
 *      只是状态会在 running/done 之间翻动。
 *   2) 工厂：`({ emit, callId, signal }) => 工具数组`。每次调用新建一份工具，本 handler 接管 emit 并
 *      丢掉子工具的 `tool` 事件（时间线那一行由 SkillRuntime 与分步进度负责），不会翻状态。
 *
 * 两个刻意的取舍，改之前先读：
 * - **分步进度靠「一步一批」**：`electron/browser/batch.cjs` 的 `runBatch()` 没有 onStep 回调，
 *   `tools.cjs` 把 `options.authorize` 关在自己的闭包里（`electron/browser/**` 本轮不可改），
 *   所以技能层拿不到真实步进信号。唯一诚实的做法是按步委托同一个 `browser_batch` execute，
 *   每步前发 `第 N/M 步：<动作>`。代价见 `runStepsWithProgress()` 的头注释。
 * - **拒绝不抛错**：返回 `isError` 结果 + 一条 warn 旁白（与 project-fs/handlers.mjs 一致），
 *   这样 MCP 通道永远拿到结构化结果，前端也不会出现「红行但没有原因」。
 */

import { extname } from 'node:path';

import browserTarget from '../../../browser/target.cjs';
import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';
import { invalidArgumentsResult, validateInput } from '../../input-schema.mjs';

/**
 * 可展示的本地文件类型：与浏览器层**同源**（`electron/browser/target.cjs` 的
 * `DEFAULT_LOCAL_FILE_EXTENSIONS`），这里只做大小写归一，绝不另抄一份清单。
 */
const DISPLAYABLE_EXTENSIONS = Object.freeze(
  (browserTarget.DEFAULT_LOCAL_FILE_EXTENSIONS || []).map(extension => String(extension).toLowerCase()),
);

/** 事件 detail 只做一行摘要，不转储日志。 */
const DETAIL_CHARS = 300;
/** 工具参数里的选择器/URL 上限：与 manifest 的 schema 对齐。 */
const MAX_TARGET_CHARS = 1_000;
const MAX_URL_CHARS = 4_000;
/** 批量：步数上限与默认总预算（与 batch.cjs 的 MAX_STEPS / DEFAULT_TIMEOUT 一致）。 */
const MAX_BATCH_STEPS = 30;
const BATCH_DEFAULT_TIMEOUT_MS = 90_000;
const BATCH_MAX_TIMEOUT_MS = 180_000;
/** 自己的总预算先用完时给建议：不要与 batch.cjs 的 timeout 文案重复。 */
const OWN_TIMEOUT_SUGGESTION = '批处理总预算已用完：已完成的步骤真的做过了，只补做剩下的步骤，不要从头重放。';

/**
 * 每次调用都必须先过授权闸门的工具（会改页面状态：导航/点击/填表/对话框/上传/跑脚本/导入导出/批量/登录/接管/鼠标）。
 * 只读类（snapshot/read/wait/tabs/screenshot）不弹人工确认，只走能力位复查（approval-bridge 自己做）。
 */
const GATED_TOOLS = new Set([
  'browser_navigate',
  'browser_act',
  'browser_dialog',
  'browser_upload',
  'browser_run_js',
  'browser_storage_state',
  'browser_batch',
  'browser_login',
  'browser_handoff',
  'browser_pointer',
]);

/** 只有一部分 action 会写盘的工具：list 不该被迫过 write 闸门。 */
const ACTION_GATES = Object.freeze({
  browser_skill: ['save', 'remove'],
});

/**
 * 逐工具的参数规则。只声明「本 handler 负责校验」的部分：类型、必填、长度/范围、枚举，
 * 方言是 `electron/skills/input-schema.mjs` 那一份（JSON Schema 子集 + 字段级 required 简写）。
 * 本文件不再自带校验器：同一件事只允许一处实现。
 * 不做业务判断（站点风险、页面状态）——那属于 electron/browser/**，抄一份必然漂移。
 */
const SPECS = Object.freeze({
  browser_navigate: {
    url: { type: 'string', required: true, maxLength: MAX_URL_CHARS },
    timeout: { type: 'integer', minimum: 1_000, maximum: 120_000 },
    observe: { type: 'string', enum: ['auto', 'full', 'none'] },
    space: { type: 'string', maxLength: 200 },
  },
  browser_snapshot: {
    mode: { type: 'string', enum: ['auto', 'full', 'diff'] },
    maxChars: { type: 'integer', minimum: 500, maximum: 60_000 },
    scope: { type: 'string', enum: ['page', 'main'] },
    frames: { type: 'string', enum: ['none', 'index', 'all'] },
    frame: { type: 'string', maxLength: 20 },
    ref: { type: 'string', maxLength: 40 },
    space: { type: 'string', maxLength: 200 },
  },
  browser_read: {
    maxChars: { type: 'integer', minimum: 500, maximum: 60_000 },
    includeLinks: { type: 'boolean' },
    space: { type: 'string', maxLength: 200 },
  },
  browser_wait: {
    for: {
      type: 'string',
      required: true,
      enum: ['selector', 'text', 'text-change', 'url', 'load', 'settle', 'idle', 'animation', 'frame', 'download', 'time'],
    },
    selector: { type: 'string', maxLength: MAX_TARGET_CHARS },
    frame: { type: 'string', maxLength: 20 },
    state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
    text: { type: 'string', maxLength: 2_000 },
    url: { type: 'string', maxLength: MAX_URL_CHARS },
    quietMs: { type: 'integer', minimum: 0, maximum: 10_000 },
    ms: { type: 'integer', minimum: 0, maximum: 2_000 },
    timeout: { type: 'integer', minimum: 100, maximum: 30_000 },
    space: { type: 'string', maxLength: 200 },
  },
  browser_act: {
    action: { type: 'string', required: true, enum: ['click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll'] },
    target: { type: 'string', maxLength: MAX_TARGET_CHARS },
    value: { type: 'string', maxLength: 8_000 },
    clickCount: { type: 'integer', minimum: 1, maximum: 3 },
    submit: { type: 'boolean' },
    expect: { type: 'object' },
    snapshot: { type: 'boolean' },
    space: { type: 'string', maxLength: 200 },
  },
  browser_dialog: {
    action: { type: 'string', required: true, enum: ['accept', 'dismiss', 'arm'] },
    policy: { type: 'string', enum: ['accept', 'dismiss'] },
    promptText: { type: 'string', maxLength: 2_000 },
    space: { type: 'string', maxLength: 200 },
  },
  browser_upload: {
    target: { type: 'string', required: true, maxLength: MAX_TARGET_CHARS },
    files: {
      type: 'array',
      required: true,
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: MAX_TARGET_CHARS },
    },
    space: { type: 'string', maxLength: 200 },
  },
  browser_run_js: {
    script: { type: 'string', required: true, maxLength: 40_000 },
    timeout: { type: 'integer', minimum: 1_000, maximum: 60_000 },
    space: { type: 'string', maxLength: 200 },
  },
  browser_storage_state: {
    action: { type: 'string', required: true, enum: ['export', 'import'] },
    space: { type: 'string', maxLength: 200 },
  },
  browser_batch: {
    recipe: { type: 'string', maxLength: 120 },
    inputs: { type: 'object' },
    steps: { type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS },
    continueOnError: { type: 'boolean' },
    snapshot: { type: 'string', enum: ['end', 'full', 'none'] },
    timeout: { type: 'integer', minimum: 1_000, maximum: BATCH_MAX_TIMEOUT_MS },
    space: { type: 'string', maxLength: 200 },
  },
  browser_login: {
    submit: { type: 'boolean' },
    space: { type: 'string', maxLength: 200 },
  },
  browser_skill: {
    action: { type: 'string', required: true, enum: ['list', 'save', 'remove'] },
    id: { type: 'string', maxLength: 120 },
    title: { type: 'string', maxLength: 80 },
    intent: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
    verify: { type: 'object' },
  },
  browser_handoff: {
    reason: {
      type: 'string',
      required: true,
      enum: ['login', 'captcha', '2fa', 'payment', 'consent', 'choice'],
    },
    note: { type: 'string', maxLength: 300 },
    space: { type: 'string', maxLength: 200 },
  },
  browser_screenshot: {
    mode: { type: 'string', enum: ['none', 'thumb', 'viewport', 'full'] },
    includeInResult: { type: 'boolean' },
    reason: { type: 'string', maxLength: 80 },
    fullPage: { type: 'boolean' },
    space: { type: 'string', maxLength: 200 },
  },
  browser_pointer: {
    action: { type: 'string', required: true, enum: ['click', 'drag'] },
    viewId: { type: 'string', required: true, maxLength: 120 },
    x: { type: 'number', required: true, minimum: 0, maximum: 0.999_999 },
    y: { type: 'number', required: true, minimum: 0, maximum: 0.999_999 },
    endX: { type: 'number', minimum: 0, maximum: 0.999_999 },
    endY: { type: 'number', minimum: 0, maximum: 0.999_999 },
    space: { type: 'string', maxLength: 200 },
  },
  browser_tabs: {
    action: { type: 'string', required: true, enum: ['list', 'new', 'select', 'close'] },
    tabId: { type: 'string', maxLength: 120 },
    url: { type: 'string', maxLength: MAX_URL_CHARS },
    space: { type: 'string', maxLength: 200 },
    background: { type: 'boolean' },
  },
});

/** 批量步骤的 op → 中文动作词（只用于「第 N/M 步：…」这一行摘要，不是策略判定）。 */
const OP_LABELS = Object.freeze({
  navigate: '打开',
  click: '点击',
  fill: '填写',
  type: '输入',
  press: '按键',
  select: '选择',
  check: '勾选',
  hover: '悬停',
  scroll: '滚动',
  wait: '等待',
});

const BATCH_OPS = Object.freeze(Object.keys(OP_LABELS));

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

/** 降级/拒绝时补一条旁白：handler 不抛错，旁白是唯一能说清「为什么没做」的地方。 */
function notice(deps, ctx, text, tone = 'warn') {
  const emit = emitOf(deps, ctx);
  if (!emit) return;
  try {
    emit({ type: 'notice', tone, text: String(text).slice(0, DETAIL_CHARS) });
  } catch { /* 旁白发不出去不影响结论 */ }
}

/** browser_batch 的「steps 与 recipe 二选一」在 schema 里表达不了，只能在入口判一次。 */
function checkBatchShape(args) {
  const hasRecipe = typeof args.recipe === 'string' && args.recipe.trim().length > 0;
  const steps = Array.isArray(args.steps) ? args.steps : null;
  if (hasRecipe && steps && steps.length) return { ok: false, message: 'recipe 与 steps 只能二选一' };
  if (!hasRecipe && (!steps || !steps.length)) return { ok: false, message: '必须给 steps（最多 30 步）或已保存的 recipe' };
  if (!steps) return { ok: true, args };
  const bad = steps.findIndex(step => !step || typeof step !== 'object' || Array.isArray(step));
  if (bad >= 0) return { ok: false, message: `steps[${bad}] 必须是对象` };
  const unknown = steps.findIndex(step => !BATCH_OPS.includes(String(step.op ?? step.action ?? '').toLowerCase()));
  if (unknown >= 0) {
    return { ok: false, message: `steps[${unknown}].op 只能是 ${BATCH_OPS.join(' / ')}` };
  }
  return { ok: true, args };
}

/** handler 返回值上的附加信息：detail 一句话摘要 + 截图 image 元信息。 */
function adopt(raw, meta = {}) {
  const base = raw && typeof raw === 'object' && Array.isArray(raw.content)
    ? { content: raw.content, ...(raw.isError === true ? { isError: true } : {}) }
    : textResult(typeof raw === 'string' ? raw : JSON.stringify(raw ?? null));
  const detail = typeof meta.detail === 'string' && meta.detail.trim()
    ? meta.detail.trim().slice(0, DETAIL_CHARS)
    : undefined;
  return {
    ...base,
    ...(detail ? { detail } : {}),
    ...(meta.image && typeof meta.image === 'object' ? { image: meta.image } : {}),
  };
}

/** 浏览器工具的 text 内容永远是 JSON（tools.cjs 的 result/failure 都这么写）。 */
function payloadOf(raw) {
  const text = Array.isArray(raw?.content) ? raw.content.find(part => part?.type === 'text')?.text : '';
  if (typeof text !== 'string' || !text) return null;
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** 失败详情：优先 code + message，保持一行。 */
function failureDetail(payload) {
  if (!payload) return '浏览器操作失败';
  const code = typeof payload.code === 'string' && payload.code ? payload.code : '';
  const message = typeof payload.message === 'string' && payload.message ? payload.message : '';
  return `${code ? `${code}: ` : ''}${message || '浏览器操作失败'}`.slice(0, DETAIL_CHARS);
}

/**
 * `file:` 地址 → 本地绝对路径；不是 file: 或无法解析返回 null（只解析字符串，不碰磁盘）。
 * `file:///C:/Users/x` 的 pathname 是 `/C:/Users/x`：Windows 盘符前的那个 `/` 要去掉。
 */
function localFileOf(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^file:/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'file:') return null;
    const decoded = decodeURIComponent(url.pathname || '');
    const pathname = /^\/[a-zA-Z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
    return pathname || null;
  } catch {
    return null;
  }
}

/**
 * 本地文件（`file://`）的闸门——**只允许项目根内的可展示类型**。
 *
 * 两层职责，改之前先读（这是安全边界，不是文案）：
 * 1) **技能层（这里）= 早失败 + 好文案**：根外 → `file_outside_roots`（文案不变）；
 *    根内但扩展名不允许 → `file_type_not_allowed` 并列出可用扩展名；根内 + 类型允许 → 放行，
 *    继续走 authorize 与 execute（本函数返回 null）。
 * 2) **浏览器层（`electron/browser/target.cjs` 的 `PageTarget.navigate`）= 真正的强制点**：
 *    `browser_navigate`、`browser_batch` 的 navigate 步骤、`browser_tabs new`、以及渲染层地址栏，
 *    最终都在那里过 `resolveLocalFileTarget()`（fileURLToPath → realpath → 根归属 → 类型 → 存在性）。
 *    技能层绕不过去，反过来技能层也不是唯一入口——所以两层都要有。
 * 3) 路径复用 `deps.gate.resolveInRoots`（与文件类工具同一套 realpath/符号链接校验），
 *    根外一律拒绝；没有闸门通道时同样拒绝（绝不因为「拿不到判定」就放行）。
 *
 * @returns {Promise<object|null>} null = 不是本地文件，或根内允许打开（照常调工具）；否则是可直接交给模型的错误结果
 */
async function guardLocalFile(deps, ctx, url, toolName) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!/^file:/i.test(raw)) return null;
  const local = localFileOf(raw);
  if (!local) {
    return errorResult('file_outside_roots', '本地文件只能在项目目录内打开：这个 file:// 地址无法解析成本地路径。');
  }
  const gate = deps?.gate;
  if (!gate || typeof gate.resolveInRoots !== 'function') {
    notice(deps, ctx, '本地文件只能在项目目录内打开：本轮没有可用的路径闸门。');
    return errorResult('file_outside_roots', '本地文件只能在项目目录内打开（本轮没有可用的路径闸门）。');
  }
  let resolved;
  try {
    resolved = await gate.resolveInRoots(local, toolName);
  } catch {
    notice(deps, ctx, `已拒绝打开本地文件：${shortText(local, 120)}（不在项目目录内）`);
    return errorResult('file_outside_roots', `本地文件只能在项目目录内打开：${shortText(local, 200)}`);
  }
  const extension = extname(typeof resolved === 'string' ? resolved : local).toLowerCase();
  if (!extension || !DISPLAYABLE_EXTENSIONS.includes(extension)) {
    notice(deps, ctx, `已拒绝打开本地文件：${shortText(resolved, 120)}（类型不允许）`);
    return errorResult(
      'file_type_not_allowed',
      `这种本地文件不能在浏览器里打开：${shortText(resolved, 160)}。`
      + `允许的扩展名：${DISPLAYABLE_EXTENSIONS.join(' ')}。`,
    );
  }
  // 根内 + 类型允许：放行。是否真的能打开由浏览器层再判一次（那里是强制点）。
  return null;
}

/** 授权：没有通道一律拒绝（宁可要不到能力，也不要静默放行会改页面的操作）。 */
async function requestAuthorization(ctx, args) {
  if (typeof ctx?.authorize !== 'function') {
    return { allowed: false, code: 'permission_unavailable', reason: '缺少授权通道（ctx.authorize），浏览器写操作已拒绝' };
  }
  try {
    const verdict = await ctx.authorize(undefined, args);
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

/**
 * 取这一次调用可用的浏览器工具。
 * 工厂形态下顺带把 emit 接管：子工具的 `tool` 事件会被丢掉（时间线那一行由 SkillRuntime 与
 * 分步进度负责），否则一步一批的 announce/settle 会在同一行里把状态翻来翻去。
 */
function openTools(deps, ctx) {
  const source = deps?.browser;
  if (typeof source === 'function') {
    const outer = emitOf(deps, ctx);
    const callId = typeof ctx?.callId === 'string' && ctx.callId ? ctx.callId : undefined;
    const list = source({
      callId,
      signal: ctx.signal,
      emit(event) {
        if (!outer) return;
        try {
          if (!event || event.type === 'tool') return;
          outer(event);
        } catch { /* 事件发不出去不影响工具结果 */ }
      },
    });
    return Array.isArray(list) ? list : [];
  }
  return Array.isArray(source) ? source : [];
}

function findTool(tools, name) {
  return tools.find(tool => tool?.name === name && typeof tool.execute === 'function') ?? null;
}

/** 统一执行：工具自己已经把错误收敛成 isError 结果，这里只兜住真正抛出来的异常。 */
async function runTool(tool, ctx, input) {
  try {
    const raw = await tool.execute(ctx.callId, input, ctx.signal);
    return raw && typeof raw === 'object' ? raw : { content: [{ type: 'text', text: String(raw ?? '') }] };
  } catch (error) {
    return errorResult(error?.code ?? 'tool_failed', messageOf(error));
  }
}

function shortText(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 「第 3/10 步：点击「登录」」里的动作名与目标。 */
function stepLabel(step) {
  const op = String(step?.op ?? step?.action ?? '').toLowerCase();
  const label = OP_LABELS[op] ?? (op || '未知操作');
  let target = '';
  if (op === 'navigate') target = shortText(step?.url, 60);
  else if (op === 'wait') target = shortText(step?.for || step?.selector || step?.text, 40);
  else target = shortText(step?.target || step?.selector || step?.text, 40);
  return target ? `${label}「${target}」` : label;
}

/** 分步进度：同一 callId 原地更新同一行（events.mjs 的 skillRunningEvent 语义）。 */
function progressStep(ctx, index, total, step) {
  if (typeof ctx?.progress !== 'function') return;
  try {
    ctx.progress(`第 ${index + 1}/${total} 步：${stepLabel(step)}`, { step: index + 1, total });
  } catch { /* 进度发不出去不影响批量执行 */ }
}

/** 绝对序号化子批返回的步骤行：每批都是 0 起的 i，直接拼会让模型看到重复的下标。 */
function rowsOf(payload, offset) {
  const rows = Array.isArray(payload?.steps) ? payload.steps : [];
  return rows.map(row => ({ ...row, i: Number.isInteger(row?.i) ? offset + row.i : offset }));
}

/**
 * 按步委托 `browser_batch`，并在每一步前发一次分步进度。
 *
 * 为什么不是一次调用：`electron/browser/batch.cjs` 的 `runBatch()` 没有 onStep/onProgress 回调，
 * `options.authorize` 是 tools.cjs 内部闭包（本轮不允许改 electron/browser/**），
 * 技能层因此拿不到任何真实步进信号。按步调用同一个 execute 是唯一「不伪造步数」的办法。
 * 代价（已在报告里列出）：每步一次 `withLockedTarget`/`ensure`、子批的 skillCandidate 只在
 * 最后一步产生、批量末尾快照只取最后一次。
 * **删除条件**：一旦 `runBatch()` 提供 `options.onStep`，本函数整体删掉，改回一次 execute 调用。
 */
async function runStepsWithProgress(ctx, tool, input) {
  const steps = input.steps;
  const total = steps.length;
  const started = Date.now();
  const timeout = Number.isInteger(input.timeout)
    ? Math.min(Math.max(input.timeout, 1_000), BATCH_MAX_TIMEOUT_MS)
    : BATCH_DEFAULT_TIMEOUT_MS;
  const collected = [];
  let snapshot = null;
  let observed = false;
  let extra = {};
  let failedAt = null;
  let failureOutcome = null;
  let failureCode = null;
  let timedOutAt = null;
  let timeoutSuggestion = '';

  for (let index = 0; index < total; index += 1) {
    if (ctx.signal?.aborted) {
      const result = errorResult('aborted', '已停止批量操作');
      return adopt({
        ...result,
        detail: `已停止：完成 ${collected.length}/${total} 步（已做过的步骤是真的做过了）`,
      });
    }
    const remaining = timeout - (Date.now() - started);
    if (remaining <= 0) {
      timedOutAt = index;
      timeoutSuggestion = OWN_TIMEOUT_SUGGESTION;
      break;
    }
    const step = steps[index] || {};
    progressStep(ctx, index, total, step);
    const isLast = index === total - 1;
    const raw = await runTool(tool, ctx, {
      ...(typeof input.space === 'string' && input.space ? { space: input.space } : {}),
      steps: [step],
      continueOnError: false,
      // 只有最后一步带末尾快照：中间的 diff 没人看，白白多花一次往返。
      snapshot: isLast ? (input.snapshot || 'end') : 'none',
      timeout: Math.max(1_000, remaining),
    });
    const payload = payloadOf(raw);
    collected.push(...rowsOf(payload, index));
    if (payload?.observed === true) observed = true;
    if (payload?.snapshot) snapshot = payload.snapshot;
    for (const key of ['skillCandidate', 'learned', 'recipe']) {
      if (payload?.[key]) extra = { ...extra, [key]: payload[key] };
    }
    if (raw?.isError === true) {
      // 授权被拒/停手/抛错：子批的 payload 已经带 code 与 suggestion，原样交回并补上真实进度。
      return adopt({
        ...raw,
        detail: `第 ${index + 1}/${total} 步未执行（已完成 ${collected.length}/${total}）：${failureDetail(payload)}`,
      });
    }
    if (payload?.ok === false) {
      const row = collected.at(-1) ?? {};
      failureOutcome = typeof payload.outcome === 'string' ? payload.outcome : (typeof row.outcome === 'string' ? row.outcome : 'unknown');
      failureCode = typeof payload.code === 'string' ? payload.code : (typeof row.code === 'string' ? row.code : '');
      if (payload.code === 'batch-timeout') {
        timedOutAt = Number.isInteger(payload.timedOutAt) ? index + payload.timedOutAt : index;
        timeoutSuggestion = typeof payload.suggestion === 'string' ? payload.suggestion : OWN_TIMEOUT_SUGGESTION;
        break;
      }
      failedAt = index;
      if (input.continueOnError !== true) break;
    }
  }

  const ok = failedAt === null && timedOutAt === null;
  const payload = {
    ok,
    ...(ok ? { outcome: 'ok' } : {}),
    steps: collected,
    ...(failedAt === null ? {} : { failedAt, ...(failureOutcome ? { outcome: failureOutcome } : {}), ...(failureCode ? { code: failureCode } : {}) }),
    ms: Date.now() - started,
    ...(snapshot ? { snapshot } : {}),
    ...(observed ? { observed: true } : {}),
    ...extra,
    ...(timedOutAt === null ? {} : {
      code: 'batch-timeout',
      outcome: 'unknown',
      indeterminate: true,
      partial: true,
      timedOutAt,
      timeout,
      finished: collected.length,
      expected: total,
      ...(timeoutSuggestion ? { suggestion: timeoutSuggestion } : {}),
    }),
  };
  const done = collected.filter(row => row.ok === true).length;
  const detail = ok
    ? `${total} 步全部完成`
    : `已完成 ${done}/${total} 步（${timedOutAt !== null ? '总预算用尽' : `第 ${(failedAt ?? 0) + 1} 步失败`}）`;
  return adopt({ content: [{ type: 'text', text: JSON.stringify(payload) }] }, { detail });
}

/**
 * 截图成功后落盘成 chat-images，并给出 `{ id, name, src }`：
 * 前端只认 `tool` 事件上的 `image` 字段（events.mjs 的 imageOf），**不能**发 `{type:'image'}`。
 * chatImages 缺失或落盘失败都只是降级（不落盘 + 旁白），不许把一次成功的截图变成报错。
 */
async function adoptScreenshot(deps, ctx, raw) {
  const payload = payloadOf(raw);
  if (raw?.isError === true || payload?.ok === false) {
    return adopt(raw, { detail: failureDetail(payload) });
  }
  const width = Number.isFinite(payload?.width) ? Math.round(payload.width) : null;
  const height = Number.isFinite(payload?.height) ? Math.round(payload.height) : null;
  const name = width && height ? `页面截图 · ${width}×${height}` : '页面截图';
  const item = Array.isArray(raw?.content)
    ? raw.content.find(part => part?.type === 'image' && typeof part.data === 'string' && part.data)
    : null;
  const save = deps?.chatImages?.saveImage;
  let image = null;
  if (!item) {
    notice(deps, ctx, `${name}已生成，但工具结果里没有图片数据（includeInResult:false？）`, 'info');
  } else if (typeof save !== 'function') {
    notice(deps, ctx, `${name}未落盘（会话没有 chatImages 通道），尺寸 ${width ?? '?'}×${height ?? '?'}`, 'info');
  } else {
    try {
      const saved = await save({ dataUrl: `data:${item.mimeType || 'image/png'};base64,${item.data}` });
      const id = typeof saved?.id === 'string' ? saved.id.trim() : '';
      if (id) image = { id, name, src: `./chat-images/${id}` };
      else notice(deps, ctx, `${name}未落盘（chatImages 没有返回 id）`, 'warn');
    } catch (error) {
      notice(deps, ctx, `${name}落盘失败：${messageOf(error)}`, 'warn');
    }
  }
  return adopt(raw, { detail: image ? name : `${name}（未落盘）`, ...(image ? { image } : {}) });
}

/** 一行摘要：成功时给「做了什么」，失败时给 code + message。 */
function detailOf(name, payload, args, stepCount) {
  if (payload?.ok === false) return failureDetail(payload);
  if (!payload) return '';
  switch (name) {
    case 'browser_navigate':
      return `已打开 ${shortText(payload.url || args.url, 120)}`;
    case 'browser_act':
      return `${args.action} ${shortText(args.target ?? '', 80)}`.trim();
    case 'browser_batch':
      return stepCount ? `${stepCount} 步完成` : '批量操作完成';
    case 'browser_handoff':
      return `已交还用户接管（${args.reason}）`;
    case 'browser_skill':
      return `站点技能：${args.action}${Array.isArray(payload.skills) ? `（${payload.skills.length} 个）` : ''}`;
    case 'browser_tabs':
      return Array.isArray(payload.tabs) ? `${payload.tabs.length} 个标签页` : (payload.url || '');
    case 'browser_login':
      return '已用记忆库凭据填充登录表单';
    case 'browser_run_js':
      return 'JS 批处理已执行';
    case 'browser_storage_state':
      return args.action === 'import' ? '登录态已导入' : '登录态已导出';
    case 'browser_upload':
      return `已选择 ${Array.isArray(args.files) ? args.files.length : 0} 个文件`;
    case 'browser_pointer':
      return `${args.action} (${args.x}, ${args.y})`;
    default:
      return shortText(payload.url || payload.mode || '', 120);
  }
}

/**
 * 包一个浏览器工具。
 * @param {object} deps
 * @param {string} name 工具名（必须与 createBrowserTools() 的 tool.name 一致）
 */
function wrapTool(deps, name) {
  const spec = SPECS[name];
  const gatedAlways = GATED_TOOLS.has(name);
  const gatedActions = ACTION_GATES[name] ?? null;
  return async function handler(rawArgs, rawCtx) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
    // 入参校验走技能层唯一的入口。`emptyStrings:'keep'`：browser_act 的 `value:''` 是
    // 「清空输入框」的真实意图，不能被当成「没传这个参数」丢掉。
    const checked = validateInput(
      { type: 'object', properties: spec, additionalProperties: false },
      args,
      { emptyStrings: 'keep' },
    );
    if (!checked.ok) return invalidArgumentsResult(checked.errors);
    if (name === 'browser_batch') {
      const shape = checkBatchShape(checked.value);
      if (!shape.ok) return invalid(shape.message);
    }
    // 本地文件（file://）在授权与执行之前就判：只允许项目根内 + 可展示类型，
    // 根外/类型不对给出可读文案；放行的继续走 authorize 与 execute（见 guardLocalFile）。
    if (name === 'browser_navigate') {
      const blocked = await guardLocalFile(deps, ctx, checked.value.url, name);
      if (blocked) return blocked;
    }
    if (name === 'browser_batch' && Array.isArray(checked.value.steps)) {
      for (const step of checked.value.steps) {
        if (String(step?.op ?? step?.action ?? '').toLowerCase() !== 'navigate') continue;
        const blocked = await guardLocalFile(deps, ctx, step?.url, name);
        if (blocked) return blocked;
      }
    }
    const tools = openTools(deps, ctx);
    const tool = findTool(tools, name);
    if (!tool) return errorResult('tool_unavailable', `当前会话没有可用的 ${name}（浏览器未打开或能力位不足）`);

    const needsApproval = gatedAlways || (Array.isArray(gatedActions) && gatedActions.includes(checked.value.action));
    if (needsApproval) {
      const verdict = await requestAuthorization(ctx, checked.value);
      if (verdict.allowed !== true) {
        notice(deps, ctx, `已拒绝 ${name}：${verdict.reason}`);
        return errorResult(verdict.code, verdict.reason);
      }
    }

    if (name === 'browser_batch' && Array.isArray(checked.value.steps) && checked.value.steps.length) {
      return runStepsWithProgress(ctx, tool, checked.value);
    }

    const raw = await runTool(tool, ctx, checked.value);
    if (name === 'browser_screenshot') return adoptScreenshot(deps, ctx, raw);
    const payload = payloadOf(raw);
    if (raw?.isError === true) {
      // 失败原因跟着工具行走（detail），不再额外发 notice——否则时间线底部会多一条重复提示。
      return adopt(raw, { detail: failureDetail(payload) });
    }
    return adopt(raw, { detail: detailOf(name, payload, checked.value, checked.value.steps?.length) });
  };
}

/**
 * @param {{ browser?: object[]|Function, chatImages?: { saveImage?: Function }, emit?: Function }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  const source = deps?.browser;
  if (source === undefined || source === null || source === false) return {};
  let available = [];
  if (Array.isArray(source)) {
    available = source
      .filter(tool => tool && typeof tool.name === 'string' && typeof tool.execute === 'function')
      .map(tool => tool.name);
  } else if (typeof source === 'function') {
    // 探测一次「这一轮到底有哪些工具」：模型不该看见一个一调就报 tool_unavailable 的工具
    // （browser_pointer 只在控制器注入了 pointer 操作时存在）。
    try {
      const probe = source({ callId: undefined, signal: undefined, emit() {} });
      available = (Array.isArray(probe) ? probe : [])
        .filter(tool => tool && typeof tool.name === 'string' && typeof tool.execute === 'function')
        .map(tool => tool.name);
    } catch {
      return {};
    }
  }
  const handlers = {};
  for (const name of available) {
    if (!SPECS[name]) continue; // 浏览器侧将来新增工具：先在这里显式声明 schema，再自动生效
    handlers[name] = wrapTool(deps, name);
  }
  return handlers;
}
