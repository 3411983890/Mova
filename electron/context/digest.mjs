/**
 * 确定性摘要与紧急裁剪（纯函数，零 IO、零 Electron 依赖、零随机性）
 *
 * 负责：摘要器失败/超时/溢出恢复时的降级文本——按固定规则从原文里抽取用户诉求、
 *       工具名与结果首行、路径/命令/数字片段，按时间顺序拼成一段可信但很粗糙的摘要；
 *       以及把一条工具结果换成「可回查」的占位符（方案 §4.4 ③b）。
 * 不负责：调用模型写摘要（summarize.mjs）、决定压哪一段（ledger.mjs）、落盘归档（archive.mjs）。
 * 硬规则：同一输入两次输出必须字节相同——所以这里不排序、不 hash、不用时间、不用随机数。
 * 被谁调用：electron/context/summarize.mjs（回退路径）、ledger.mjs（紧急裁剪）、tests。
 */

const USER_HEAD_CHARS = 80;
const TOOL_FIRST_LINE_CHARS = 140;
const MAX_FRAGMENTS_PER_MESSAGE = 6;
const FRAGMENT_CHARS = 60;
const MAX_FRAGMENT_CHARS_PER_MESSAGE = 180;
const MERGE_PARTIAL_MIN = 8;

const URL_PATTERN = /https?:\/\/[^\s"'`<>()]+/g;
// 目录前缀可选的相对/绝对路径，含可选的 :行号 后缀。
const FILE_PATTERN = /(?:^|[\s("'`=[])((?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonc|md|css|html|py|sh|ps1|yml|yaml|toml|txt|log)(?::\d+(?:-\d+)?)?)/g;
const WINDOWS_PATH = /(?<![\w])([A-Za-z]:\\[^\s"'`<>|]+)/g;
const POSIX_PATH = /(?<![\w:./<>])((?:\/|\.\.?\/)[\w.@%+-]+(?:\/[\w.@%+-]+)*)/g;
const COMMAND = /(?<![\w-])((?:npm|pnpm|npx|node|yarn|git|python3?|pip|pwsh|powershell|deno|bun)\s+[^\n"'`]{1,80})/g;
const NUMBER = /\b\d+(?:\.\d+)?\s?(?:ms|s|kb|mb|gb|%|px|行|条|个)(?![\w])/gi;

function clipTo(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  if (limit === 1) return text.slice(0, 1);
  return text.slice(0, limit - 1) + '…';
}

// 字段级截断：保留 limit 个原文字符，被截断时再补一个省略号（比硬上限多 1 个字符）。
// 「用户消息前 80 字」是内容预算，不该被省略号挤掉一个汉字。
function clipHead(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

// 丢掉最旧的一侧、保留尾部：越靠后的内容越接近当前任务。
function clipTail(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  if (limit === 1) return text.slice(-1);
  return '…' + text.slice(-(limit - 1));
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function textOf(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  // 动作记录（chat-agent 的 {type:'tool', name, status, detail}）把结果放在 detail。
  if (typeof message.detail === 'string') return message.detail;
  return '';
}

function roleOf(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.role === 'string') return message.role;
  if (typeof message.type === 'string') return message.type;
  return '';
}

function toolNameOf(message) {
  if (!message || typeof message !== 'object') return '';
  for (const value of [message.name, message.toolName, message.label, message.detail?.name]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isToolError(message) {
  if (!message || typeof message !== 'object') return false;
  return message.status === 'error' || message.detail?.status === 'error';
}

function idOf(message, index) {
  if (message && typeof message === 'object') {
    if (typeof message.id === 'string' || typeof message.id === 'number') return message.id;
  }
  // 没有 id 的消息用索引当稳定标识，保证 covered 可复现。
  return index === null || index === undefined ? '' : `idx:${index}`;
}

function firstLine(text) {
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}

function collect(pattern, text, out) {
  for (const match of text.matchAll(pattern)) {
    const value = (match[1] ?? match[0] ?? '').trim();
    if (value) out.push(value);
  }
}

// 路径 / 命令 / 数字形态片段的抽取顺序固定，因此同输入必然同输出。
function fragmentsOf(text) {
  if (!text) return [];
  const raw = [];
  collect(URL_PATTERN, text, raw);
  collect(FILE_PATTERN, text, raw);
  collect(WINDOWS_PATH, text, raw);
  collect(POSIX_PATH, text, raw);
  collect(COMMAND, text, raw);
  collect(NUMBER, text, raw);
  const seen = new Set();
  const fragments = [];
  let budget = MAX_FRAGMENT_CHARS_PER_MESSAGE;
  for (const value of raw) {
    const fragment = clipTo(value, FRAGMENT_CHARS);
    if (seen.has(fragment)) continue;
    seen.add(fragment);
    if (fragments.length >= MAX_FRAGMENTS_PER_MESSAGE) break;
    if (fragment.length > budget) break;
    fragments.push(fragment);
    budget -= fragment.length;
  }
  return fragments;
}

function lineFor(message, index) {
  const text = textOf(message);
  const role = roleOf(message);
  if (!text && role !== 'tool') return null;
  const fragments = text ? fragmentsOf(text) : [];
  let head = '';
  if (role === 'user') {
    const images = Array.isArray(message?.images) ? message.images.length : 0;
    head = `用户: ${clipHead(collapse(text), USER_HEAD_CHARS)}${images ? ` [图片×${images}]` : ''}`;
  } else if (role === 'tool' || role === 'toolResult') {
    const name = toolNameOf(message) || 'tool';
    const mark = isToolError(message) ? '（失败）' : '';
    let result = collapse(firstLine(text));
    if (!result) result = '无输出';
    head = `工具 ${name}${mark}: ${clipHead(result, TOOL_FIRST_LINE_CHARS)}`;
  } else if (role === 'assistant') {
    // 助手文本不复述（那是摘要器的活），只留其中的路径/命令/数字这类硬线索。
    if (!fragments.length) return null;
    return { id: idOf(message, index), text: `助手: ${fragments.join(' | ')}` };
  } else {
    return null;
  }
  const fresh = fragments.filter(fragment => !head.includes(fragment));
  if (!head) return null;
  return { id: idOf(message, index), text: fresh.length ? `${head} » ${fresh.join(' | ')}` : head };
}

/**
 * 确定性摘要：从一段消息里抽出「谁说了什么关键内容」，按时间顺序拼成一段文本。
 * 超限时从最旧开始丢（保留越新的越好），最后只剩一条仍超限时按字数硬截断。
 *
 * @param {Array<object|string>} messages 一段连续历史（不修改原文）
 * @param {{ maxChars?: number }} [options]
 * @returns {{ text: string, covered: Array<string|number> }} covered 是真正被写进 text 的消息 id
 */
export function deterministicDigest(messages, { maxChars = 1200 } = {}) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 0;
  const list = Array.isArray(messages) ? messages : [];
  const lines = [];
  for (let index = 0; index < list.length; index++) {
    const line = lineFor(list[index], index);
    if (line) lines.push(line);
  }
  if (!lines.length || limit === 0) return { text: '', covered: [] };
  let start = 0;
  let used = lines.reduce((sum, line) => sum + line.text.length, 0) + (lines.length - 1);
  while (start < lines.length - 1 && used > limit) {
    used -= lines[start].text.length + 1;
    start++;
  }
  const kept = lines.slice(start);
  let text = kept.map(line => line.text).join('\n');
  if (text.length > limit) text = clipTo(text, limit);
  return { text, covered: kept.map(line => line.id) };
}

function normalizeSpan(span) {
  if (!span || typeof span !== 'object') return null;
  const from = Number(span.from);
  const to = Number(span.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from, to };
}

/**
 * 组装一段摘要锚点（L4 的载体）。所有字段都有默认值，因为调用方既可能是 LLM 摘要器，
 * 也可能是确定性回退——形状必须一致，组装层才不用分支。
 */
export function buildSummaryBlock({ text, span, source } = {}) {
  const body = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  return {
    kind: 'summary',
    span: normalizeSpan(span),
    source: typeof source === 'string' && source ? source : 'deterministic',
    text: body.trim(),
  };
}

function sourceOf(blocks) {
  const values = new Set(blocks.map(block => (typeof block.source === 'string' && block.source ? block.source : 'deterministic')));
  return values.size === 1 ? [...values][0] : 'mixed';
}

/**
 * 合并多段摘要（滚动摘要用）。新的优先：装不下时从最旧的一段开始丢，
 * 最旧那一段如果还剩一点空间就保留它的尾部（离现在更近的部分）。
 */
export function mergeSummaryBlocks(blocks, { maxChars = 2000 } = {}) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) >= 0 ? Math.floor(Number(maxChars)) : 0;
  const list = (Array.isArray(blocks) ? blocks : []).filter(block => block && typeof block === 'object');
  const pieces = list
    .map((block, index) => ({ block, index, text: typeof block.text === 'string' ? block.text.trim() : '' }))
    .filter(piece => piece.text);
  if (!pieces.length || limit === 0) return buildSummaryBlock({ text: '', span: null, source: 'deterministic' });
  const kept = [];
  let used = 0;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i];
    const separator = kept.length ? 1 : 0;
    if (used + separator + piece.text.length <= limit) {
      kept.unshift({ index: piece.index, text: piece.text });
      used += separator + piece.text.length;
      continue;
    }
    const room = limit - used - separator;
    if (room > MERGE_PARTIAL_MIN) kept.unshift({ index: piece.index, text: clipTail(piece.text, room) });
    // 更旧的段落一律丢弃：滚动摘要只向前保留，避免新旧结论互相污染。
    break;
  }
  const spanValues = kept
    .map(item => list[item.index].span)
    .filter(span => span && Number.isFinite(Number(span.from)) && Number.isFinite(Number(span.to)));
  const span = spanValues.length
    ? {
      from: Math.min(...spanValues.map(value => Number(value.from))),
      to: Math.max(...spanValues.map(value => Number(value.to))),
    }
    : null;
  return buildSummaryBlock({
    text: kept.map(item => item.text).join('\n'),
    span,
    source: sourceOf(kept.map(item => list[item.index])),
  });
}

/**
 * 紧急裁剪占位符（方案 §4.4 ③b）：把一条旧的工具结果换成指针，不生成摘要、不调模型。
 * preview 是被引用（可回查）的尾部字符数，不是抄进上下文的字符数——正文留在归档里。
 */
export function emergencyPlaceholder(toolMessage, { preview = 6000 } = {}) {
  const text = textOf(toolMessage);
  const span = idOf(toolMessage, null);
  const name = toolNameOf(toolMessage);
  const chars = Number.isFinite(Number(preview)) && Number(preview) > 0 ? Math.floor(Number(preview)) : 6000;
  const parts = ['[工具结果已释放'];
  if (span) parts.push(`span=${span}`);
  if (name) parts.push(`tool=${name}`);
  parts.push(`${text.length} 字符`);
  parts.push(`用 context_read 可回查最后 ${chars} 字符]`);
  return parts.join('，');
}
