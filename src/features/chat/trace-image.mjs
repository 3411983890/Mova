/**
 * 负责：把「工具事件自带的截图」和「工具状态行」的决策压成纯函数——
 *       一个 tool 事件该产出什么样的行（`toolStatusRow`），行上要不要画截图（`shouldRenderImage`）。
 * 不负责：不画 DOM、不开灯箱、不合并 timeline（渲染在 thinking-block.jsx，事件合并仍在
 *         chat-reply.ts 的 mergeReplyEvent）。也绝不构造 `{ type: 'image' }` 事件：
 *         那个形状会被 app.js 当成用户上传的附件写进 `turn.imageIds`，污染用户消息气泡。
 * 被谁调用：src/features/chat/chat-transcript.tsx 的 traceSegments（`toolStatusRow`）、
 *           src/features/chat/thinking-block.jsx 的 Row（`shouldRenderImage` 决定缩略图）、
 *           tests/tool-image-row.test.mjs（纯函数断言，不需要 React）。
 */

/** 截图只在工具真的跑完之后才有：running 还没生成，error / denied 没有可展示的结果。 */
const RENDERABLE_STATUS = 'done';

/** 后端（electron/chat-images.cjs 的 saveImage）把截图落在 `./chat-images/<id>`。 */
const SCREENSHOT_DIR = './chat-images/';

/** 行图标：与 chat-transcript.tsx 历史上用的映射逐项一致，迁移过来时不许改。 */
const TOOL_ICONS = {
  list_files: 'folder',
  read_file: 'file',
  write_file: 'edit',
  replace_in_file: 'edit',
  run_command: 'run',
};

/** 空白字符串一律折算成空串，避免把 `' '` 当成有效字段。 */
const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * 工具行的说明文字（状态行右侧那一列）。命令行卡片与变更卡片也用同一份：
 * 状态文案只在这里实现一次，别在渲染层再抄一份。
 * @param {{ status?: string, detail?: string }} event
 * @returns {string | undefined} running 时固定「执行中」
 */
export function toolStatusMeta(event) {
  if (event.status === 'running') return '执行中';
  if (event.status === 'denied') return event.detail || '已拒绝';
  if (event.status === 'error') return event.detail || '失败';
  return event.detail;
}

/**
 * 归一 tool 事件上的截图附件。
 * @param {{ type?: string, status?: string, image?: { id?: string, name?: string, src?: string } | null }} event
 * @returns {{ id: string, name: string, src: string } | null} 不可展示时返回 null
 */
export function toolImageOf(event) {
  if (!event || typeof event !== 'object') return null;
  // 独立的 image 事件代表「用户上传的附件」，不是工具截图：绝不在这里变成缩略图。
  if (event.type !== 'tool') return null;
  // running 还没生成截图，error / denied 也没有可展示的结果。
  if (event.status !== RENDERABLE_STATUS) return null;
  const image = event.image;
  if (!image || typeof image !== 'object') return null;
  const id = text(image.id);
  // 落盘失败的事件没有 id：整块丢弃，不留一张必然裂图的占位。
  if (!id) return null;
  return {
    id,
    name: text(image.name) || '工具截图',
    src: text(image.src) || `${SCREENSHOT_DIR}${id}`,
  };
}

/**
 * 这一行要不要画缩略图（渲染前的最后一道闸）。
 * @param {{ image?: { id?: string, name?: string, src?: string } | null }} row traceSegments 产出的行
 * @returns {boolean} 只有 id 与 src 都在的行才画
 */
export function shouldRenderImage(row) {
  if (!row || typeof row !== 'object') return false;
  const image = row.image;
  if (!image || typeof image !== 'object') return false;
  return Boolean(text(image.id) && text(image.src));
}

/**
 * 把截图挂到已经产出的工具行上。
 * 没有截图时返回**同一个对象引用**：不带 image 的事件产出的行与改动前完全一致。
 * @template {object} Row
 * @param {Row} row
 * @param {{ type?: string, status?: string, image?: object | null }} event
 * @returns {Row}
 */
export function attachToolImage(row, event) {
  const image = toolImageOf(event);
  return image ? { ...row, image } : row;
}

/**
 * `traceSegments` 里 ran_command / diff 之外的普通工具行：图标 + 标题 + 右侧说明，
 * 截图（如果有）挂在 `image` 上，由渲染层决定画在状态行下方。
 * `path`（工具读写/读取的文件）单独带出来，渲染层据此画成可点击的路径。
 * @param {{
 *   type?: string, name?: string, label?: string, status?: string, detail?: string,
 *   path?: string,
 *   image?: { id?: string, name?: string, src?: string } | null,
 * }} event
 * @returns {{ icon: string, label: string, meta: string | undefined, path?: string,
 *   image?: { id: string, name: string, src: string } }}
 */
export function toolStatusRow(event) {
  const touched = text(event.path).slice(0, 300);
  const row = {
    icon: event.status === 'denied' ? 'denied' : TOOL_ICONS[event.name] ?? 'bulb',
    // 进行中的工具会把 detail 当进度贴在标题后面；跑完之后 detail 归右侧的 meta。
    label: `${event.label}${event.detail && event.status === 'running' ? ` · ${event.detail.slice(0, 80)}` : ''}`,
    meta: toolStatusMeta(event),
    // 路径只在真的是路径时带出来：`git_status` 之类的 `args.path` 可能只是 '.'
    ...(touched && touched !== '.' ? { path: touched } : {}),
  };
  return attachToolImage(row, event);
}
