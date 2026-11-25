/**
 * notice 行的文案归一（纯函数、无 DOM、无全局状态）。
 *
 * 负责：把主进程 `{type:'notice', tone, text}` 收敛成「一行提示」该显示什么、用什么颜色；
 *        不负责建节点、不负责滚动与布局（那是 app.js 的 appendNoticeRow）。
 * 被谁调用：app.js 中 receiveReply 的 onEvent 回调（在 mergeReplyEvent 之前）；
 *           tests/notice-row.test.mjs。
 *
 * 为什么单独拆出来：notice 没有 id、也不该进 reply.timeline，
 * 「tone 兜底 / 空文案丢弃 / 超长截断」这三条必须能脱离 Electron 与 DOM 单独验证。
 */

/** 只认这三种 tone；未知值一律按 info——一行旁白永远不该让一轮对话失败。 */
const TONES = new Set(['info', 'warn', 'error']);

/** 视觉对齐 assistant 的次要文字：info 用次要灰，warn/error 用暖色，不抢正文注意力。 */
export const NOTICE_COLORS = Object.freeze({ info: '#9e9e9e', warn: '#e5cc9e', error: '#f0b9b2' });

/** 一行的字数上限：notice 是旁白，超过这个长度说明上游把正文塞进来了，截断而不是撑高时间线。 */
export const NOTICE_MAX_CHARS = 200;

/** 时间线里的一行提示：只认 notice 事件，其他事件一律交回给原来的 timeline 逻辑。 */
export function isNoticeEvent(event) {
  return Boolean(event) && event.type === 'notice';
}

/** tone 归一：非法 / 缺失都当 info。 */
export function noticeTone(tone) {
  return TONES.has(tone) ? tone : 'info';
}

/**
 * 把一条 notice 事件变成可渲染的一行。
 * @returns {{ tone: string, text: string, color: string, line: string } | null}
 *   文案为空（或不是字符串）时返回 null：宁可不显示，也不要一条空白怪行。
 */
export function noticeRow(event) {
  if (!isNoticeEvent(event)) return null;
  // 换行会把「一行提示」拆成多段正文；压成单行后再截断，缩进才不会被破坏。
  const flat = typeof event.text === 'string' ? event.text.replace(/\s+/g, ' ').trim() : '';
  if (!flat) return null;
  const tone = noticeTone(event.tone);
  const text = flat.length > NOTICE_MAX_CHARS ? `${flat.slice(0, NOTICE_MAX_CHARS).trimEnd()}…` : flat;
  return { tone, text, color: NOTICE_COLORS[tone], line: `· ${text}` };
}
