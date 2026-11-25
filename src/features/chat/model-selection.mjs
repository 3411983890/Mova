// Old chats predate per-chat selections. Prefer the last recorded reply model;
// otherwise pin the current default once, rather than following later changes.
export function recoverModelSelection(turns, entries, fallback) {
  for (let index = (turns?.length ?? 0) - 1; index >= 0; index--) {
    const reply = turns[index]?.reply;
    const entry = entries.find(item => item.model.id === reply?.model && (!reply.providerId || item.providerId === reply.providerId));
    if (entry) return { providerId: entry.providerId, modelId: entry.model.id };
  }
  const entry = entries.find(item => item.providerId === fallback?.providerId && item.model.id === fallback?.modelId) ?? entries[0];
  return entry ? { providerId: entry.providerId, modelId: entry.model.id } : null;
}
