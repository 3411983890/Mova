/**
 * 负责：把任意工具返回值收敛成 MCP 的 `{ content: [{type:'text'|...}], isError? }` 形状，
 *   并把超长文本按上限截断后附一句「已截断，原文 N 字符」。
 * 不负责：判断某个工具是否存在/可用（那在 mcp/tools.mjs 与 skills/registry.mjs），
 *   也不负责决定上限该是多少——上限由调用方作为参数传入。
 * 被谁调用：electron/mcp/tools.mjs（createToolTable 的结果归一）、
 *   electron/skills/adapters/mcp.mjs（技能调用结果归一），tests/mcp-normalize.test.mjs。
 *
 * 为什么单独成文件：MCP 截断语义在「旧工具表」和「技能包适配器」两处都要用，
 * 复制两份必然漂移（旧表曾把上限写死在函数里）。这里只做一次实现，上限走参数。
 */

/** 单条工具结果的文本上限默认值。超过就是白烧上下文，模型也读不完。 */
export const MAX_TEXT_CHARS = 8_192;
/** 错误码文本里 message 的上限：错误是摘要，不是堆栈转储。 */
export const ERROR_MESSAGE_CHARS = 300;

/** @param {unknown} error @returns {string} 任何抛出物的一句话描述 */
export function messageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  try {
    return JSON.stringify(error) ?? 'unknown error';
  } catch {
    return String(error);
  }
}

/**
 * 超长文本一律截断而不是拒绝：MCP 结果没有分页，截断 + 说明才让模型知道「还有更多」。
 * 说明本身算在预算内，保证最终长度不超过上限。
 * @param {unknown} value
 * @param {number} [maxTextChars] 上限（字符数）
 * @returns {string}
 */
export function truncateText(value, maxTextChars = MAX_TEXT_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const limit = Number.isFinite(maxTextChars) && maxTextChars > 0 ? Math.floor(maxTextChars) : MAX_TEXT_CHARS;
  if (text.length <= limit) return text;
  const note = `\n…[已截断：原文 ${text.length} 字符，仅保留前 ${limit} 字符]`;
  // 上限小于说明本身时（畸形入参）至少不能返回比原文更长的东西。
  if (note.length >= limit) return text.slice(0, limit);
  return text.slice(0, limit - note.length) + note;
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 * @returns {{ content: Array<{type:'text', text:string}>, isError?: true }}
 */
export function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * 错误结果的唯一形状：`{"error": code, "message": ...}` 序列化成文本。
 * @param {string} code
 * @param {unknown} message
 * @returns {{ content: Array<{type:'text', text:string}>, isError: true }}
 */
export function errorResult(code, message) {
  return textResult(JSON.stringify({ error: code, message: String(message).slice(0, ERROR_MESSAGE_CHARS) }), true);
}

/**
 * handler 可能返回字符串、普通对象，也可能直接返回 MCP 形状（agent-tools.cjs 的 toolResult 就是），
 * 三种都收敛成同一种形状，调用方才能不关心来源。
 * @param {unknown} raw
 * @param {{ maxTextChars?: number }} [options]
 * @returns {{ content: Array<object>, isError?: true }}
 */
export function normalizeResult(raw, { maxTextChars = MAX_TEXT_CHARS } = {}) {
  if (raw == null) return textResult('ok');
  if (typeof raw === 'string') return textResult(truncateText(raw, maxTextChars));
  if (typeof raw === 'object' && Array.isArray(raw.content)) {
    // 非 text 内容（image 等）原样保留，尺寸限制由注入方负责，这里不擅自删。
    const content = raw.content
      .filter(item => item && typeof item === 'object')
      .map(item => (item.type === 'text' ? { type: 'text', text: truncateText(item.text ?? '', maxTextChars) } : item));
    return {
      content: content.length ? content : [{ type: 'text', text: 'ok' }],
      ...(raw.isError === true ? { isError: true } : {}),
    };
  }
  try {
    return textResult(truncateText(JSON.stringify(raw), maxTextChars));
  } catch {
    return textResult(truncateText(String(raw), maxTextChars));
  }
}
