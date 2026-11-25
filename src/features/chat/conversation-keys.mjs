/**
 * 负责：会话键（`JSON.stringify([mode, project, title])`）的解析与「按聊天 / 按项目」批量匹配。
 * 不负责：真正的删除动作（app.js 的删除流程）、持久化（session-sync / postgres-repository）。
 * 被谁调用：app.js 的「永久删除聊天」与「移除项目」两条流程、tests/conversation-keys.test.mjs。
 *
 * 为什么单独抽出来：这里的 bug 会造成**数据复活**——删掉的项目一会儿又回来、重启后还在。
 * 根因是「删除」只按当前 `mode` 拼一个键，而同一个聊天可能以别的 mode 存过（用户切换过
 * CodeMova / ChatMova、或历史数据 mode 不同），键对不上就只删了内存、没删掉会话行；
 * 主进程随后用会话行重建项目，于是聊天连同项目一起「复活」。
 * 所以彻底删除必须是「按 project + title 跨 mode 全删」，这件事必须有单测。
 */

/**
 * @param {string} key
 * @returns {{mode: string, project: string, title: string}|null} 脏键返回 null（不抛）
 */
export function parseConversationKey(key) {
  if (typeof key !== 'string' || !key) return null;
  let parts;
  try { parts = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 3) return null;
  const [mode, project, title] = parts;
  if (typeof project !== 'string' || !project) return null;
  return {
    mode: typeof mode === 'string' ? mode : '',
    project,
    title: typeof title === 'string' ? title : String(title ?? ''),
  };
}

/**
 * 某个聊天的所有会话键（**跨 mode**）。
 * @param {Iterable<string>} keys 现有全部键（`conversations.keys()`）
 * @param {{project: string, title: string}} target
 * @returns {string[]} 去重后的键；一个都没有时返回空数组
 */
export function keysForChat(keys, { project, title } = {}) {
  const wanted = { project: String(project ?? ''), title: String(title ?? '') };
  if (!wanted.project || !wanted.title) return [];
  const matched = new Set();
  for (const key of keys ?? []) {
    const parsed = parseConversationKey(key);
    if (!parsed) continue;
    if (parsed.project === wanted.project && parsed.title === wanted.title) matched.add(key);
  }
  return [...matched];
}

/**
 * 某个项目下所有会话键（删除项目时必须连会话一起删，否则主进程会用会话行把项目重建出来）。
 * @param {Iterable<string>} keys
 * @param {string} projectName
 * @returns {string[]}
 */
export function keysForProject(keys, projectName) {
  const name = String(projectName ?? '');
  if (!name) return [];
  const matched = new Set();
  for (const key of keys ?? []) {
    const parsed = parseConversationKey(key);
    if (parsed && parsed.project === name) matched.add(key);
  }
  return [...matched];
}
