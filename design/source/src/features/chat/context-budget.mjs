// Conservative character budgets, not a claim of exact provider token usage.
export function buildContextHistory(history, { maxChars = 60_000, maxMessages = 100, excerptChars = 4_000 } = {}) {
  if (!Array.isArray(history) || !history.length || history.at(-1)?.role !== 'user') throw new Error('history');
  for (const message of history) {
    if (!['user', 'assistant'].includes(message?.role) || typeof message.text !== 'string' ||
        (message.reasoning !== undefined && typeof message.reasoning !== 'string')) throw new Error('history');
  }
  // Preserve the newest user input verbatim; ask for a smaller input instead of silently cutting it.
  const last = history.at(-1);
  if (last.text.length > maxChars) throw new Error('input_too_long');
  let start = history.length - 1;
  let size = last.text.length;
  while (start > 0 && history.length - start < maxMessages) {
    const previous = history[start - 1];
    if (size + previous.text.length > maxChars) break;
    size += previous.text.length;
    start--;
  }
  // Do not start the portable history with an orphaned assistant response.
  while (start < history.length - 1 && history[start].role === 'assistant') start++;
  const messages = history.slice(start).map(message => ({ ...message, reasoning: undefined }));
  let summary = '';
  if (start > 0) {
    const old = history.slice(0, start);
    const head = old.slice(0, 4);
    const tail = old.slice(Math.max(4, old.length - 8));
    summary = [...head, ...tail].map(message => `${message.role}: ${message.text.slice(0, 250)}`).join('\n').slice(0, excerptChars);
  }
  return { messages, summary, omittedMessages: start, estimatedChars: messages.reduce((sum, item) => sum + item.text.length, 0) };
}
