/**
 * 负责：从一次工具调用的参数里认出「这次动的是哪个文件」——只有一个判定口径。
 * 不负责：路径是否在项目根内（approval-bridge.mjs 与 acp/gate.mjs 的闸门）、把路径渲染成链接
 *   （src/features/chat/thinking-block.jsx）、判断工具是否有文件语义（manifest 的 permissions.fs）。
 * 被谁调用：electron/skills/approval-bridge.mjs（送闸门前的路径提取）、
 *   electron/skills/index.mjs（把 path 带进 tool 事件，渲染层才有东西可点）。
 *
 * 为什么单独一个模块：同一份「哪些参数名算路径」以前只有 approval-bridge 私有的一份，
 * 现在渲染层要显示路径了，如果再抄一份，两边迟早对不上——一处改了、另一处还认旧名字，
 * 现象就是「有的工具行能点、有的不能」，而且很难查。
 */

/**
 * 只有这些参数名会被当作「文件路径」。
 * 刻意不含 `target` / `url` / `selector`：浏览器工具的 target 是 `@e5` 这类选择器，
 * 当路径解析会被误判越界，反而把正常调用挡掉。
 */
export const PATH_ARG_KEYS = Object.freeze(['path', 'file', 'filePath', 'cwd', 'dir']);

/** 事件里带的路径长度上限：一行动态摘要，不是完整路径转储。 */
const MAX_PATH_CHARS = 300;

/**
 * 参数里的第一个路径参数（原始值，未规范化）。
 * @param {Record<string, unknown>} [args]
 * @returns {string} 没有就给空串
 */
export function firstPathOf(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 事件用的路径：去控制字符、压成一行、截断到 300 字符。
 * 渲染层拿它去派发 `mova:open-reference`，所以不能带换行（会破坏行内排版）。
 * @param {unknown} value
 * @returns {string} 不可用时返回空串
 */
export function eventPathOf(value) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > MAX_PATH_CHARS ? flat.slice(0, MAX_PATH_CHARS) : flat;
}
