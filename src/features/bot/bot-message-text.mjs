/** Plain-text Bot chat formatting, shared by storage output and historical rendering. */
export const BOT_MESSAGE_LIMIT = 200;

export function botPlainText(value = '') {
  return String(value)
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^\n)]+)\)/g, '$1（$2）')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[，。！？,.!?]|$)/g, '$1$2')
    .trim();
}

export function splitBotMessage(value = '', limit = BOT_MESSAGE_LIMIT) {
  const text = botPlainText(value);
  const chars = Array.from(text);
  const parts = [];
  while (chars.length > limit) {
    let cut = limit;
    for (let i = limit - 1; i >= Math.floor(limit / 2); i -= 1) {
      if (/[。！？!?；;\n]/u.test(chars[i])) { cut = i + 1; break; }
      if (/\s/u.test(chars[i])) cut = i + 1;
    }
    // Never split a mention token or URL when there is an earlier word boundary.
    const prefix = chars.slice(0, cut).join('');
    const tokenStart = Math.max(prefix.lastIndexOf('@'), prefix.lastIndexOf('http'));
    if (tokenStart > 0 && !/\s/.test(prefix.slice(tokenStart))) {
      cut = Array.from(prefix.slice(0, tokenStart)).length;
    }
    parts.push(chars.splice(0, cut).join('').trim());
    while (chars[0] && /\s/u.test(chars[0])) chars.shift();
  }
  if (chars.length) parts.push(chars.join('').trim());
  return parts.filter(Boolean);
}
