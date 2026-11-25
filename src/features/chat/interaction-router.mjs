// Keep pending human interactions in their owning chat, never in the global view.
export function createInteractionRouter({ notify = () => {}, dismiss = () => {} } = {}) {
  let context = null;
  const channels = new Set();
  function visible(request) {
    return Boolean(context?.visible && request.conversationId && request.conversationId === context.conversationId);
  }
  function channel(bridge, kind) {
    const pending = new Map();
    const requests = new Set();
    const closes = new Set();
    const notified = new Set();
    let shown = new Set();
    function refresh() {
      const next = new Set([...pending.values()].filter(visible).map(item => item.id));
      for (const request of pending.values()) if (!next.has(request.id) && request.conversationId && !notified.has(request.id)) {
        notified.add(request.id);
        notify({ id: `${kind}:${request.id}`, conversationId: request.conversationId, kind });
      }
      for (const id of shown) if (!next.has(id)) for (const fn of closes) fn({ id });
      for (const id of next) if (!shown.has(id)) {
        dismiss(`${kind}:${id}`);
        for (const fn of requests) fn(pending.get(id));
      }
      shown = next;
    }
    const offRequest = bridge?.onRequest?.(request => {
      if (!request?.id || pending.has(request.id)) return;
      pending.set(request.id, { ...request, conversationId: request.conversationId || context?.conversationId });
      refresh();
    });
    const offClose = bridge?.onClose?.(payload => {
      const id = typeof payload === 'string' ? payload : payload?.id;
      pending.delete(id);
      notified.delete(id);
      dismiss(`${kind}:${id}`);
      refresh();
    });
    const item = { refresh, dispose: () => { offRequest?.(); offClose?.(); } };
    channels.add(item);
    return {
      onRequest(fn) { requests.add(fn); for (const id of shown) fn(pending.get(id)); return () => requests.delete(fn); },
      onClose(fn) { closes.add(fn); return () => closes.delete(fn); },
      async respond(id, answer) {
        if (!shown.has(id)) return { ok: false, error: 'inactive-chat' };
        const result = await bridge.respond(id, answer);
        if (result === true || result?.ok) { pending.delete(id); dismiss(`${kind}:${id}`); refresh(); }
        return result;
      },
    };
  }
  return {
    channel,
    setContext(next) { context = next; for (const item of channels) item.refresh(); },
    dispose() { for (const item of channels) item.dispose(); channels.clear(); },
  };
}
