/**
 * Pure helpers for renaming a conversation.
 *
 * Everything per-conversation in the app is keyed by `[mode, project, title]`, so a rename is a key
 * migration as much as a label change. Keeping the decision here makes both halves testable without
 * a DOM.
 */

/** The conversation key for a chat title, matching the app's `draftKey()` shape. */
export function chatKey(conversationKey, title) {
  const parts = JSON.parse(conversationKey);
  parts[2] = title;
  return JSON.stringify(parts);
}

/**
 * Decide whether a suggested title may be applied.
 * @returns {{ previous: string, next: string, from: string, to: string } | null}
 */
export function planChatRename({ project, chat, nextTitle, conversationKey }) {
  const next = String(nextTitle ?? '').trim();
  const previous = String(chat?.title ?? '');
  if (!next || !previous || next === previous) return null;
  if (!Array.isArray(project?.chats)) return null;
  // Two chats with one title would share a key and therefore one message list.
  if (project.chats.some(item => item !== chat && String(item?.title ?? '') === next)) return null;
  if (typeof conversationKey !== 'string' || !conversationKey) return null;
  try {
    const from = conversationKey;
    const to = chatKey(conversationKey, next);
    return to === from ? null : { previous, next, from, to };
  } catch {
    return null;
  }
}

/** Move every keyed entry from `from` to `to`, leaving no stale copy behind. */
export function migrateKeyedState({ from, to, maps = [], sets = [] }) {
  if (!from || !to || from === to) return;
  for (const map of maps) {
    if (!map?.has?.(from)) continue;
    map.set(to, map.get(from));
    map.delete(from);
  }
  for (const set of sets) {
    if (!set?.has?.(from)) continue;
    set.delete(from);
    set.add(to);
  }
}
