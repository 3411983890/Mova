/**
 * 负责：把一次技能调用的生命周期映射成前端能直接吃下的 `model:delta` 事件对象
 *   （`{type:'tool', id, name, label, status, detail, …}`），并给出统一的 `mcp-<seq>` id 工厂。
 * 不负责：发送事件（index.mjs 决定有没有 emit）、渲染（app.js 的 mergeReplyEvent）、
 *   审批判定（approval-bridge.mjs）。
 * 被谁调用：electron/skills/index.mjs（invoke 的统一执行壳）、
 *   tests/skills-events.test.mjs。
 *
 * 两条硬约束（改这个文件前先读）：
 * 1) 同一 `id` 的事件必须是「原地更新」语义：app.js 的 mergeReplyEvent 按 `type + id` 找行，
 *    找到就 Object.assign 覆盖。因此 running/done/error 必须共用同一个 callId。
 * 2) 技能截图**不能**发 `{ type:'image' }`：app.js:3037 会把所有 image 事件当成用户附件
 *    写进 turn.imageIds，污染用户气泡。图片只能挂在 tool 事件的 `image` 字段上。
 */

import { eventPathOf } from './tool-path.mjs';

/** 详情文本上限：一行动态摘要是给眼睛看的，不是日志转储。 */
const DETAIL_CHARS = 400;

/**
 * 工具动到的文件：渲染层据此把路径画成可点击的链接（左键右侧打开 / Ctrl+点击外部打开）。
 * 只放「路径」本身，长度与换行由 tool-path.mjs 的 eventPathOf 统一收敛。
 */
function pathField(path) {
  const value = eventPathOf(path);
  return value ? { path: value } : {};
}

/**
 * 统一 id 工厂。为什么不随机：同一轮的 id 要稳定可读（日志里 `mcp-3` 一眼能对上前端那一行），
 * 且前缀必须不是 `acp`/`pi-ai`，便于 5.2 节的 ACP 重复 tool_call 消歧识别。
 * @param {string} [prefix]
 * @returns {() => string}
 */
export function createCallIdFactory(prefix = 'mcp') {
  const head = typeof prefix === 'string' && prefix.trim() ? prefix.trim() : 'mcp';
  let seq = 0;
  return () => `${head}-${++seq}`;
}

function requireCallId(callId) {
  if (typeof callId !== 'string' || !callId.trim()) {
    // 没有 id 的事件无法原地更新，只会在时间线上多出一行孤立的工具行——宁可当场报错。
    throw new TypeError('技能事件必须带 callId（同一调用的 running/done 共用同一个 id）');
  }
  return callId;
}

function identityOf(def) {
  return {
    name: typeof def?.name === 'string' ? def.name : '',
    label: typeof def?.label === 'string' && def.label ? def.label : (def?.name ?? ''),
  };
}

function detailOf(detail) {
  if (typeof detail !== 'string' || !detail.trim()) return null;
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS)}…` : flat;
}

/** 进度既接受 `{ step, total, label }` 也接受裸数字（第几步）。 */
function progressOf(progress) {
  if (progress === null || progress === undefined || progress === false) return null;
  if (typeof progress === 'number') return Number.isFinite(progress) ? { step: progress } : null;
  if (typeof progress === 'object') return { ...progress };
  return null;
}

/** 前端的 ToolDiff 形状：保持 before/after 为 null 而不是 undefined，渲染层才能判断「新文件」。 */
function diffOf(diff) {
  if (!diff || typeof diff !== 'object') return null;
  return {
    ...diff,
    before: typeof diff.before === 'string' ? diff.before : null,
    after: typeof diff.after === 'string' ? diff.after : null,
  };
}

/** 图片只作为 tool 事件的附加字段；缺 id 说明落盘失败，宁可不显示也不要一条裂图。 */
function imageOf(image) {
  if (!image || typeof image !== 'object') return null;
  const id = typeof image.id === 'string' ? image.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: typeof image.name === 'string' && image.name ? image.name : id,
    src: typeof image.src === 'string' && image.src ? image.src : `./chat-images/${id}`,
  };
}

/**
 * @param {{ callId: string, def: { name: string, label: string }, detail?: string,
 *   progress?: number|{ step?: number, total?: number, label?: string } }} input
 * @returns {{ type: 'tool', id: string, name: string, label: string, status: 'running',
 *   detail?: string, progress?: object }}
 */
export function skillRunningEvent({ callId, def, detail, progress, path } = {}) {
  const id = requireCallId(callId);
  const flat = detailOf(detail);
  const shown = progressOf(progress);
  return {
    type: 'tool',
    id,
    ...identityOf(def),
    status: 'running',
    ...(flat ? { detail: flat } : {}),
    ...(shown ? { progress: shown } : {}),
    ...pathField(path),
  };
}

/**
 * @param {{ callId: string, def: object, detail?: string, diff?: object,
 *   image?: { id: string, name?: string, src?: string }, durationMs?: number }} input
 * @returns {{ type: 'tool', id: string, status: 'done', detail?: string, diff?: object,
 *   image?: { id: string, name: string, src: string }, durationMs?: number }}
 */
export function skillDoneEvent({ callId, def, detail, diff, image, durationMs, path } = {}) {
  const id = requireCallId(callId);
  const flat = detailOf(detail);
  const patch = diffOf(diff);
  const picture = imageOf(image);
  const spent = Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null;
  return {
    type: 'tool',
    id,
    ...identityOf(def),
    status: 'done',
    ...(flat ? { detail: flat } : {}),
    ...(patch ? { diff: patch } : {}),
    ...(picture ? { image: picture } : {}),
    ...(spent === null ? {} : { durationMs: spent }),
    ...pathField(path || patch?.path),
  };
}

/**
 * @param {{ callId: string, def: object, detail?: string }} input
 * @returns {{ type: 'tool', id: string, status: 'error', detail?: string }}
 */
export function skillErrorEvent({ callId, def, detail, path } = {}) {
  const id = requireCallId(callId);
  const flat = detailOf(detail);
  return {
    type: 'tool',
    id,
    ...identityOf(def),
    status: 'error',
    ...(flat ? { detail: flat } : { detail: '执行失败' }),
    // 失败也带上路径：用户往往正是要在失败后自己去那个文件看一眼。
    ...pathField(path),
  };
}

/**
 * @param {{ callId: string, def: object, detail?: string }} input
 * @returns {{ type: 'tool', id: string, status: 'denied', detail?: string }}
 */
export function skillDeniedEvent({ callId, def, detail, path } = {}) {
  const id = requireCallId(callId);
  const flat = detailOf(detail);
  return {
    type: 'tool',
    id,
    ...identityOf(def),
    status: 'denied',
    ...(flat ? { detail: flat } : { detail: '用户拒绝了这次操作' }),
    ...pathField(path),
  };
}

/**
 * 与 app.js / chat-reply.ts 的分流保持一致：这些是会话级状态，不进时间线。
 * @param {unknown} event
 * @returns {boolean}
 */
export function isStateEvent(event) {
  if (!event || typeof event !== 'object') return false;
  return event.type === 'usage' || event.type === 'goal' || event.type === 'plan' || event.type === 'context';
}

/**
 * 对齐 src/features/chat/notice-row.js 的 isNoticeEvent：notice 是旁白，没有 id，也不能进 timeline。
 * @param {unknown} event
 * @returns {boolean}
 */
export function isNoticeEvent(event) {
  return Boolean(event) && typeof event === 'object' && event.type === 'notice';
}
