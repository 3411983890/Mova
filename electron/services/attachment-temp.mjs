/**
 * 负责：给「临时会话里的图片」开一个一次性的落盘副本目录——CLI 只能读文件，而这类图片按隐私约定
 *   不写用户数据目录，所以在系统临时目录里放一份**本轮副本**，本轮结束（成功 / 失败 / 取消）立即删掉。
 * 不负责：图片校验、解码与存储（`electron/chat-images.cjs` 的 `saveImage` / `readImage`）、
 *   把路径写进提示词（`electron/services/attachment-text.mjs` 的 `imageLocationBlocks`）、
 *   判断「什么时候该用临时副本」（那是 `electron/chat-agent.mjs` 的 ACP 支路按 `request.temporary` 决定的）。
 * 被谁调用：electron/chat-agent.mjs 的 runAcpSubscriptionTurn、tests/attachment-temp.test.mjs。
 *
 * 为什么需要它：ACP（Gemini 订阅）没有 image block 通道，只能把图片路径交给 CLI 自己读。
 * 普通会话的图片本来就在 `userData/chat-images/` 里，直接给路径即可；但临时会话的图片只存在内存里
 * （`saveImage({temporary:true})`，永不落盘）。要么告诉模型「读不到」，要么临时落一份盘——
 * 这里选后者，代价是**本轮内**这些图片在系统临时目录里存在过，结束后立刻删除。
 *
 * 两条硬约束：
 * 1. `add()` 只接受 `validId` 形状的文件名（sha256 + 扩展名），路径拼接不能成为任意写；
 * 2. `dispose()` 必须可重复调用且不抛错——它总在 finally 里被调用，删不掉也不能盖掉真正的错误。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validId } from '../chat-images.cjs';

/** 目录名前缀：一眼能看出这是 Mova 的一轮临时副本，排查残留时好认。 */
const PREFIX = 'mova-acp-images-';

/**
 * 开一个临时图片暂存区。
 * @param {{directory?: string}} [options] `directory` 只给测试用（跳过 mkdtemp，直接用给定目录）
 * @returns {Promise<{directory: string, add: (id: string, bytes: Uint8Array) => Promise<string>,
 *   dispose: () => Promise<void>}>}
 */
export async function openImageStaging({ directory = null } = {}) {
  const dir = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : await mkdtemp(join(tmpdir(), PREFIX));
  let disposed = false;

  return {
    directory: dir,
    /**
     * 写入一张图，返回它的绝对路径。
     * 失败就抛错：调用方（chat-agent）会把它转成「这一轮读不到」的如实说明，绝不编一个不存在的路径。
     */
    async add(id, bytes) {
      if (disposed) throw new Error('image staging already disposed');
      if (!validId(id)) throw new Error('invalid image id');
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('empty image bytes');
      const target = join(dir, id);
      // `wx`：同一轮里同一个 id 不会重复写（图片按内容哈希），真撞上就当失败处理，不覆盖。
      await writeFile(target, bytes, { flag: 'wx' });
      return target;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
