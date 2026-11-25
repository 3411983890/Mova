/**
 * 负责：一次「点文件/点链接」到底落在右侧面板还是系统外部——修饰键判定（纯函数）
 *   以及两条极薄的副作用封装（打开外部文件 / 打开外部网址）。
 * 不负责：右侧面板怎么打开（`mova:open-reference` 事件由 src/features/browser/side-browser.js 处理）、
 *   路径合法性（越界判断全在主进程的 files-view.cjs）、文件内容渲染。
 * 被谁调用：src/features/chat/markdown-renderer.js（回答里的路径与链接）、
 *   src/features/chat/thinking-block.jsx（工具行路径、截图路径）、tests/open-target.test.mjs。
 *
 * 交互约定（与浏览器「新标签打开」的习惯一致）：
 *   左键 → 右侧面板（Mova 内部，不打断当前上下文）
 *   Ctrl / ⌘ + 左键 → 系统外部（文件用默认关联程序，网址用默认浏览器）
 * Shift / Alt 一律不参与判定：它们在别处已有含义（选区、拖拽），抢过来只会误触。
 */

/** Ctrl（Windows/Linux）或 ⌘（macOS）。 */
export function isExternalModifier(event) {
  return Boolean(event?.ctrlKey === true || event?.metaKey === true);
}

/**
 * @param {{ctrlKey?: boolean, metaKey?: boolean}} [event] React 合成事件或原生事件都行
 * @returns {'panel'|'external'} 面板打开 / 系统外部打开
 */
export function decideTarget(event) {
  return isExternalModifier(event) ? 'external' : 'panel';
}

/**
 * 用系统默认程序打开一个已登记项目根内的文件（md 走关联的编辑器/浏览器，等同在文件管理器里双击）。
 *
 * 主进程只认 `rootId + 相对路径`，也接受直接给一个绝对路径字符串 `raw`（由主进程自己做
 * 「落在哪个已登记根里」的判定）——模型给出的路径常常是绝对的，这里不猜。
 *
 * @param {{rootId?: string, path?: string, raw?: string}} target
 * @returns {Promise<boolean>} 真的发起了打开才算 true；桥不可用/主进程拒绝一律 false
 */
export async function openFileExternally(target = {}) {
  const bridge = globalThis.window?.movaDesktop?.files?.view;
  if (!bridge || typeof bridge.openExternal !== 'function') return false;
  const payload = {};
  if (typeof target.rootId === 'string' && target.rootId) payload.rootId = target.rootId;
  if (typeof target.path === 'string' && target.path) payload.path = target.path;
  if (typeof target.raw === 'string' && target.raw) payload.raw = target.raw;
  if (!Object.keys(payload).length) return false;
  try {
    const result = await bridge.openExternal(payload);
    return result?.ok === true;
  } catch {
    return false;
  }
}

/**
 * 用系统默认浏览器打开一个 http(s) 网址（主进程只放行 http/https，见 browser:external）。
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function openUrlExternally(url) {
  const bridge = globalThis.window?.movaDesktop?.browser;
  if (!bridge || typeof bridge.external !== 'function') return false;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  try {
    return (await bridge.external(url)) === true;
  } catch {
    return false;
  }
}

/**
 * 「在右侧面板打开」的唯一入口：派发既有事件，行为与改动前逐字一致。
 * 单独抽出来只是为了让三处调用点不再各写一份 CustomEvent。
 * @param {{kind: 'file'|'url', path?: string, rootId?: string, url?: string}} detail
 */
export function openInPanel(detail) {
  if (!detail || typeof detail !== 'object') return;
  globalThis.window?.dispatchEvent(new CustomEvent('mova:open-reference', { detail }));
}
