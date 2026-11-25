/** Transient composer notices, isolated by conversation (never persisted). */
export function createChatFeedback() {
  const entries = new Map();
  return {
    entries,
    set(key, message = '', kind = 'notice') {
      if (message) entries.set(key, { message, kind });
      else entries.delete(key);
    },
    get(key) { return entries.get(key)?.message ?? ''; },
    recover(key) {
      if (entries.get(key)?.kind === 'retry') entries.delete(key);
    },
  };
}
