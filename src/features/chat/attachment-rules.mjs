/**
 * 负责：一次发送里「附件」的规则——能带几个、图片/文本/二进制分别怎么校验、发给主进程时保留哪些字段。
 * 不负责：读文件与编码（vendor 的 composer 负责）、把附件变成模型输入（electron/services/attachment-text.mjs）。
 * 被谁调用：app.js 的 sendMessage()、tests/attachment-rules.test.mjs。
 *
 * 背景：以前附件只有图片，限制写死在 sendMessage 里（4 张、4MB、必须是 data:image/…）。
 * 现在放开到「所有文件类型」：图片照旧走 image block，文本类把正文带进上下文，二进制只带说明。
 * 规则集中在这里，是因为校验与发送是两次使用同一份判断，散着写必然漂。
 */

/** 一次最多几个附件（与 composer 的上限一致）。 */
export const MAX_ATTACHMENTS = 5;
/** 其中最多几张图片。 */
export const MAX_IMAGES = 4;
/** 单张图片 / 单个文本附件的大小上限。 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,/;

/**
 * 文本附件的正文在 composer 那侧叫 `extractedText`（vendor 的 ingest 结果），
 * 我们自己造的测试数据叫 `text`。两个都认，避免「明明上传了却提示没有内容」。
 */
function textOf(attachment) {
  const source = attachment && typeof attachment === 'object' ? attachment : {};
  if (typeof source.extractedText === 'string') return source.extractedText;
  if (typeof source.text === 'string') return source.text;
  return null;
}

/**
 * 校验一组附件。
 * @param {Array<{kind?: string, name?: string, size?: number, dataUrl?: string, text?: string}>} attachments
 * @returns {{ok: true} | {ok: false, code: 'image'|'size'|'count', message: string}}
 */
export function checkAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return { ok: true };
  if (list.length > MAX_ATTACHMENTS) {
    return { ok: false, code: 'count', message: `一次最多发送 ${MAX_ATTACHMENTS} 个附件。` };
  }
  const images = list.filter(item => item?.kind === 'image');
  if (images.length > MAX_IMAGES) {
    return { ok: false, code: 'count', message: `一次最多发送 ${MAX_IMAGES} 张图片。` };
  }
  for (const item of images) {
    if (typeof item.dataUrl !== 'string' || !IMAGE_DATA_URL.test(item.dataUrl)) {
      return { ok: false, code: 'image', message: '图片只支持 PNG、JPEG、WebP 或 GIF。' };
    }
    if (Number(item.size) > MAX_IMAGE_BYTES) {
      return { ok: false, code: 'size', message: '每张图片不超过 4 MB。' };
    }
  }
  for (const item of list) {
    if (item?.kind === 'image') continue;
    if (item?.kind === 'text' && textOf(item) === null) {
      return { ok: false, code: 'size', message: `「${item.name || '附件'}」没有读到内容，请重新上传。` };
    }
    if (Number(item?.size) > MAX_TEXT_BYTES) {
      return { ok: false, code: 'size', message: `「${item?.name || '附件'}」超过 4 MB，请改用更小的文件。` };
    }
  }
  return { ok: true };
}

/**
 * composer 给的一条附件 → 发给主进程的最小形状。
 * 图片保留 dataUrl（主进程要落盘），文本保留 text（主进程要拼进提示词），二进制只留元信息。
 */
export function toRequestAttachment(attachment) {
  const source = attachment && typeof attachment === 'object' ? attachment : {};
  const kind = ['image', 'text', 'file'].includes(source.kind) ? source.kind : 'file';
  const payload = {
    kind,
    name: typeof source.name === 'string' && source.name ? source.name : '附件',
    mime: typeof source.mime === 'string' ? source.mime : '',
    size: Number.isFinite(Number(source.size)) ? Number(source.size) : 0,
  };
  if (kind === 'image' && typeof source.dataUrl === 'string') payload.dataUrl = source.dataUrl;
  if (kind === 'text') {
    const text = textOf(source);
    if (text !== null) payload.text = text;
  }
  return payload;
}

/** 对话里回显用的一行附件说明（不含正文；正文已经在上下文里）。 */
export function attachmentSummary(attachment) {
  const source = attachment && typeof attachment === 'object' ? attachment : {};
  const kind = source.kind === 'image' ? '图片' : source.kind === 'text' ? '文本' : '文件';
  return { name: typeof source.name === 'string' && source.name ? source.name : '附件', kind };
}
