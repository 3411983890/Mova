/**
 * 负责：把请求里的附件翻译成模型能读的文本块——
 *   `attachmentTextBlocks()`：非图片附件（文件名 + 正文 / 或明确说明读不了正文）；
 *   `imageLocationBlocks()`：图片（文件名 + **本机路径**，让读不了 image block 的通道自己去读文件）。
 * 不负责：图片落盘与取路径（`electron/chat-images.cjs` 的 `saveImage` / `imageFilePath`，ACP 支路自己调）、
 *   文件选择与编码（渲染层的 composer）、pi-ai 链路的 image block 编码（`prepareMessages`）。
 * 被谁调用：electron/chat-agent.mjs（pi-ai 与 ACP 两条链路都要用），
 *   tests/attachment-text.test.mjs。
 *
 * 为什么要有这个模块：附件以前只有图片。放开到「所有文件类型」之后，模型真正能读的只有文本类，
 * 二进制文件（zip / docx / exe）我们既不该假装读过，也不该悄悄丢掉——所以统一给出
 * 「有这个名字、这个大小、这种类型，但正文读不出来」的说明，让模型自己决定怎么回应。
 *
 * 图片为什么要单开一个函数：ACP（Gemini 订阅）只收一段文本，CLI 侧的模型拿不到 image block。
 * 以前这段图片被直接过滤掉——用户看到缩略图，模型却什么都没收到（最糟的一种错误）。
 * 现在改成把「图片存在哪」写进提示词，由 CLI 自己用文件工具去读；读不到也要如实说明。
 *
 * 两道闸（都很重要）：
 * 1. 单个附件截断：超长日志贴进来会直接顶爆上下文，截断时必须写明「已截断，原文 N 字符」；
 * 2. 总预算：多个附件加起来也不能超过上限，超出的整块标成「未纳入本轮」。
 */

/** 单个文本附件最多带多少字符进上下文。 */
export const ATTACHMENT_MAX_CHARS = 40_000;
/** 本轮所有附件加起来的上限。 */
export const ATTACHMENT_MAX_TOTAL_CHARS = 80_000;
/** 文件名本身的长度上限：文件名也是模型输入，不能当成可信文本无限塞。 */
const MAX_NAME_CHARS = 160;

/** 控制字符（含换行）会打乱提示结构，统一换成空格。 */
function safeName(value) {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NAME_CHARS) || '未命名附件';
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 是图片就走图片那条路：这个模块只管剩下的。
 *
 * 兼容老形状：放开「所有文件类型」之前，附件只有 `{ name, dataUrl }` 两个字段（没有 `kind`）。
 * 那种形状且 `dataUrl` 确实是图片时，仍然按图片处理——否则旧请求/旧客户端会把图片
 * 当成「二进制文件」塞进文本块，模型看到的就是一句「读不到正文」。
 */
export function isImageAttachment(attachment) {
  if (attachment?.kind === 'image') return true;
  if (attachment?.kind !== undefined) return false;
  return typeof attachment?.dataUrl === 'string' && attachment.dataUrl.startsWith('data:image/');
}

/**
 * @param {Array<{kind?: string, name?: string, mime?: string, size?: number, text?: string}>} attachments
 * @param {{maxChars?: number, maxTotalChars?: number}} [options]
 * @returns {{blocks: string[], accepted: number, truncated: string[], dropped: string[]}}
 *   `blocks` 是直接拼进用户消息的文本块；`truncated`/`dropped` 只用于日志与测试。
 */
export function attachmentTextBlocks(attachments, options = {}) {
  const list = Array.isArray(attachments) ? attachments.filter(item => item && !isImageAttachment(item)) : [];
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : ATTACHMENT_MAX_CHARS;
  const maxTotal = Number.isFinite(options.maxTotalChars) ? options.maxTotalChars : ATTACHMENT_MAX_TOTAL_CHARS;
  const blocks = [];
  const truncated = [];
  const dropped = [];
  let used = 0;

  for (const attachment of list) {
    const name = safeName(attachment.name);
    const mime = typeof attachment.mime === 'string' && attachment.mime.trim() ? attachment.mime.trim().slice(0, 120) : '未知类型';
    const size = formatSize(attachment.size);
    const header = `附件：${name}（${mime}${size ? `，${size}` : ''}）`;

    if (attachment.kind !== 'text') {
      // 二进制文件：如实说明「读不到正文」。假装读过是更糟的错误。
      blocks.push(`${header}\n（Mova 目前只能读取文本类文件的内容，这个文件没有正文可提供。需要用它的内容时，请让用户把关键部分粘贴进对话。）`);
      continue;
    }

    const text = typeof attachment.text === 'string' ? attachment.text : '';
    if (!text.trim()) {
      blocks.push(`${header}\n（文件内容是空的。）`);
      continue;
    }
    if (used >= maxTotal) {
      dropped.push(name);
      blocks.push(`${header}\n（本轮附件太多，这个文件的正文没有纳入，需要时请单独发送。）`);
      continue;
    }

    const room = Math.min(maxChars, maxTotal - used);
    const clipped = text.length > room;
    const body = clipped ? text.slice(0, room) : text;
    used += body.length;
    if (clipped) truncated.push(name);
    blocks.push(clipped
      ? `${header}\n（已截断，原文 ${text.length} 字符，这里只保留前 ${body.length} 字符）\n\n${body}`
      : `${header}\n\n${body}`);
  }

  return { blocks, accepted: blocks.length, truncated, dropped };
}

/**
 * 图片的「交接说明」：这条路读不了 image block，就把**本机绝对路径**交给模型，让它自己读。
 *
 * 三种情况都要如实写出来，绝不允许「假装收到了图」：
 * 1. 有路径（图片已落盘，或临时会话已经复制到系统临时目录）→ 给路径 + 说明该用什么工具读它；
 * 2. 临时会话但没能生成副本 → 明确说这一轮读不到（不要编路径）；
 * 3. 保存/复制失败（超限 / 配额 / 格式 / 磁盘）→ 写明原因，同样不假装。
 *
 * 为什么要写「用你自己的文件读取工具」：这个路径在 `userData/chat-images/`（或系统临时目录）下，
 * **不在任何已登记的项目根内**，Mova 的项目工具（read_file 等）会直接拒绝它；
 * 只有 CLI 自带的文件读取能力能打开。不写清楚，模型会去调项目内工具、被拒之后回一句「读不到」。
 *
 * @param {Array<{name?: string, mime?: string, size?: number, path?: string, temporary?: boolean,
 *   unavailable?: string}>} images `path` 来自 `imageFilePath()` 或 `openImageStaging().add()`
 * @returns {string[]} 每张图一块，直接拼进 prompt（空数组表示没有图片）
 */
export function imageLocationBlocks(images) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  return list.map(image => {
    const name = safeName(image?.name);
    const mime = typeof image?.mime === 'string' && image.mime.trim() ? image.mime.trim().slice(0, 120) : '未知类型';
    const size = formatSize(image?.size);
    const header = `图片：${name}（${mime}${size ? `，${size}` : ''}）`;
    const location = typeof image?.path === 'string' ? image.path.trim() : '';
    if (location) {
      return `${header}\n文件位置：${location}\n（这是一张图片：需要看内容时用你自己的文件读取工具打开上面的绝对路径——它不在项目目录内，Mova 的项目工具会拒绝它。读不到就如实说明，不要凭文件名猜内容。）`;
    }
    if (image?.temporary === true) {
      return `${header}\n文件位置：无 —— 这是临时会话，图片没能复制成可读文件，这一轮读不到它。`;
    }
    const reason = typeof image?.unavailable === 'string' && image.unavailable ? `（${image.unavailable.slice(0, 120)}）` : '';
    return `${header}\n文件位置：无 —— 没能把图片交给 CLI 读取${reason}，这一轮读不到它。`;
  });
}
