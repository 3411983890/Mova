/**
 * 负责：聊天行尾那个按钮该显示什么——图标名、无障碍标签、点击语义（归档 / 恢复 / 删除）。
 * 不负责：按钮的创建与事件绑定（sidebar-chats.js）、归档与删除本身（app.js）。
 * 被谁调用：src/features/sidebar/sidebar-chats.js、tests/chat-row-action.test.mjs。
 *
 * 为什么单独成文件：这是唯一一处「这一行到底能不能归档」的判断，写错的表现是
 * 一个点了只弹出「临时聊天不会被保存，无法归档」的死按钮。纯映射，不碰 DOM，可以直接单测。
 */

/**
 * @param {{ archived?: boolean, temporary?: boolean }} chat
 * @returns {{ kind: 'archive'|'delete', icon: string, label: string, verb: string }}
 *   `label` 用于 `aria-label` 的前缀（`${label}：${标题}`），`verb` 是弹出菜单里的整句。
 */
export function chatRowAction({ archived = false, temporary = false } = {}) {
  // 临时聊天不落盘：归档标记根本存不下来（重启就复原），所以这个位置改成「删除」——
  // 同样的位置、同样的交互，但点下去真的能把它收拾干净。
  if (temporary) return { kind: 'delete', icon: 'trash', label: '删除', verb: '删除聊天' };
  if (archived) return { kind: 'archive', icon: 'arrow-u-up-left', label: '恢复', verb: '恢复聊天' };
  return { kind: 'archive', icon: 'archive', label: '归档', verb: '归档聊天' };
}
