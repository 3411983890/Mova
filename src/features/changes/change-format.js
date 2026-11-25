/**
 * Labels and text shared by the "改动历史" panel and the approval bar.
 *
 * The main process is the source of truth for change records: it sends a `kind`
 * from the file tools and an error code from the bridge. Nothing here guesses a
 * value the main process did not send — an unknown kind or code gets an honest
 * fallback label instead of a made-up one.
 */

/** Every `kind` the main process can record for a file change. */
export const CHANGE_KINDS = ['write', 'create', 'replace', 'delete', 'move', 'undo'];

const KIND_LABELS = {
  write: '写入',
  create: '新建',
  replace: '替换',
  delete: '删除',
  move: '移动',
  undo: '撤销',
};

/** Chinese label for a change kind; unknown kinds stay visible, never dropped. */
export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? '未知操作';
}

/** Change kind used as a CSS modifier, restricted to known values. */
export function kindTone(kind) {
  return CHANGE_KINDS.includes(kind) ? kind : 'unknown';
}

/**
 * Byte count as a short human string. The main process reports the size of the
 * stored snapshot; a missing or invalid number says so rather than printing
 * `NaN` or pretending the file was empty.
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Local time for a change record. `time` may arrive as epoch milliseconds or as
 * an ISO string; an unparsable value becomes "时间未知" instead of "Invalid Date".
 */
export function formatChangeTime(time) {
  const millis = typeof time === 'number' ? time : Date.parse(time);
  if (!Number.isFinite(millis)) return '时间未知';
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Error codes the changes bridge documents. `history-unreadable` is the one the
 * user can act on (a corrupt or locked history file); an unrecognised code is
 * reported as "未知错误" so a newer main process never produces an empty state.
 */
const CHANGE_ERRORS = {
  'not-registered': '文件夹未登记，看不到改动历史。',
  'not-found': '找不到这个文件夹，它可能已被移动或删除。',
  'history-unreadable': '改动历史不可读，可能文件已损坏或被占用。',
  'invalid-arguments': '这条改动记录的 id 无效，无法读取详情。',
  'path-escape': '这个路径不在项目文件夹内。',
  unauthorized: '当前窗口没有权限读取改动历史。',
};

export function changeErrorText(code) {
  return CHANGE_ERRORS[code] ?? '未知错误：无法读取改动记录。';
}

/** `files.reveal` failures. `path-escape` is the expected one on a stale path. */
const REVEAL_ERRORS = {
  'path-escape': '这个路径不在项目文件夹内。',
  'invalid-path': '这个路径不在项目文件夹内。',
  'not-registered': '文件夹未登记，无法在资源管理器中显示。',
  'not-found': '这个文件已经不存在了。',
  'reveal-failed': '系统没有打开资源管理器，请稍后重试。',
  unauthorized: '当前窗口没有权限在资源管理器中显示文件。',
};

export function revealErrorText(code) {
  return REVEAL_ERRORS[code] ?? '无法在资源管理器中显示这个文件。';
}
