/**
 * 负责：新对话的「即时标题」——不等模型、不等回复，从第一句话里直接提炼一个能进左侧列表的短标题。
 * 不负责：调模型取标题（electron/services/chat-title.cjs）、改名与 key 迁移（chat-rename.js）、
 *   渲染与落盘（app.js 的 sendMessage / renameChat）。
 * 被谁调用：app.js 的 sendMessage（新对话创建那一刻）、tests/chat-title-text.test.mjs。
 *
 * 为什么要它：命名原来是「等第一条回复跑完再问模型」，而模型那条路对订阅账号是走不通的
 * （订阅通道 `loadProviderKey()` 恒为空串），于是标题一直停在「第一句话原文的前 36 个字符」。
 * 现在创建对话时就先给一个干净的短标题（去掉「帮我/请/你好」这类开头与结尾语气词、
 * 去掉链接与路径、压成一行），左侧列表因此立刻有名字；模型那条路仍然是「有更好的就改名」。
 */

/** 与模型取名的上限保持一致（12 个汉字 / 6 个词左右，多了在侧栏会被截断成省略号）。 */
export const TITLE_MAX_CHARS = 24;

/** 开头的客套与请求前缀：只吃紧贴开头的那一小段，句中出现的同一批字不能动。 */
const LEADING_FILLER = /^(?:请|麻烦|帮我|帮忙|我想|我要|我需要|需要|能不能|能否|可以|可不可以|你好|您好|嗨|hi|hello|hey|请问|那个|就)?[，,、。.；;:：\s]*/i;

/** 结尾的语气词与客套：问句、请求句最常见，去掉之后标题更像「话题」。 */
const TRAILING_FILLER = /(?:[，,、。.；;：:！!？?～~\s]|谢谢|多谢|感谢|好吗|行吗|可以吗|好不好|吧|吗|呢|啊|呀|哦|嗯|了)+$/;

/** 链接、邮箱、看起来像路径的片段：标题里不该出现（与模型取名的隐私规则一致）。 */
const NOISE = /(?:https?:\/\/\S+|mailto:\S+|[\w.+-]+@[\w-]+\.[\w.]+|(?:[A-Za-z]:)?[\\/][\w.-]+(?:[\\/][\w.-]+)+|\b[\w-]+(?:\/[\w-]+)+\.[A-Za-z0-9]{1,6}\b)/g;

/** 标题至少得有一个真实字符：纯标点（「。。。」）不算标题，交给调用方兜底。 */
const HAS_WORD = /[\p{L}\p{N}]/u;

/** 一行一个标题：换行、制表、Markdown 标记都压平（标题不是正文）。 */
function flatten(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`>#~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按「字符」截断，不切断代理对；超长时给省略号，让人知道被截了。 */
function clipChars(value, limit) {
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : value;
}

/**
 * 第一句话 → 即时标题。
 * @param {unknown} text 用户第一条消息（或附件名）
 * @param {{maxChars?: number}} [options]
 * @returns {string} 无法提炼时返回空串（调用方自己决定兜底文案）
 */
export function instantChatTitle(text, { maxChars = TITLE_MAX_CHARS } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : TITLE_MAX_CHARS;
  const raw = flatten(text);
  if (!raw) return '';
  // 先删噪声再删前缀：否则「帮我看看 https://x 里说的」会先被前缀规则吃掉「帮我」，留下一个网址。
  const withoutNoise = flatten(raw.replace(NOISE, ' '));
  // 前缀是「可以叠几层」的（「你好，我想问一下…」里有两层）：一直剥到不再变化，最多 4 轮防死循环。
  let body = withoutNoise;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = body.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim();
    if (next === body) break;
    body = next;
  }
  // 全被清掉（例如消息只有一个链接）时退回原文，宁可粗糙也不给空标题。
  const chosen = flatten(body || withoutNoise || raw);
  // 纯标点（「。。。」）不是标题：返回空串，让调用方用它自己的兜底文案。
  if (!HAS_WORD.test(chosen)) return '';
  return clipChars(chosen, limit);
}
