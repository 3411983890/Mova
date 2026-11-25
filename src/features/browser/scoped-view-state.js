/** In-memory view state belongs to a conversation, not to the shared panel DOM. */
export function createScopedViewState({ capture, restore }) {
  const states = new Map();
  let current = null;
  return {
    select(key) {
      if (key === current) return;
      if (current !== null) states.set(current, capture());
      current = key;
      restore(states.get(key) ?? { open: false, view: 'web', tabId: null });
    },
    rekey(from, to) {
      if (from === to) return;
      if (current === from) {
        states.set(from, capture());
        current = to;
      }
      if (states.has(from)) {
        states.set(to, states.get(from));
        states.delete(from);
      }
    },
  };
}
