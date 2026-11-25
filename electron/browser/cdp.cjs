'use strict';
// Thin CDP client over Electron's webContents.debugger.
//
// Why not Playwright: see design doc §3.1. This wrapper only talks to one
// guest target, exposes events, and makes every command cancellable by timeout
// because several CDP methods (notably screenshots of invisible pages) never
// settle on their own.

const DEFAULT_TIMEOUT = 12000;

class CdpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CdpError';
    this.code = code;
  }
}

function createCdp(guest, options = {}) {
  if (!guest || typeof guest.isDestroyed !== 'function') throw new CdpError('invalid-target');
  const timeout = Number.isInteger(options.timeout) && options.timeout > 0 ? options.timeout : DEFAULT_TIMEOUT;
  const listeners = new Set();
  let attached = false;
  let enabled = false;
  let disposed = false;

  const onMessage = (_event, method, params, sessionId) => {
    for (const listener of [...listeners]) {
      try { listener(method, params, sessionId); } catch { /* a listener must not break CDP */ }
    }
  };
  const onDetach = () => { attached = false; enabled = false; };

  function assertLive() {
    if (disposed) throw new CdpError('disposed', 'CDP client disposed');
    if (guest.isDestroyed()) throw new CdpError('target-destroyed', 'target destroyed');
  }

  async function attach() {
    assertLive();
    if (guest.debugger.isAttached()) { attached = true; return; }
    try {
      guest.debugger.attach('1.3');
    } catch (error) {
      // DevTools open is the common cause; surface a stable code.
      throw new CdpError('attach-failed', error?.message || 'debugger attach failed');
    }
    guest.debugger.on('message', onMessage);
    guest.debugger.on('detach', onDetach);
    attached = true;
  }

  function send(method, params = {}, ms = timeout) {
    assertLive();
    if (!attached) throw new CdpError('not-attached', 'debugger is not attached');
    let timer;
    return Promise.race([
      guest.debugger.sendCommand(method, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CdpError('timeout', `CDP timeout: ${method}`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async function enable() {
    if (enabled) return;
    await send('Page.enable');
    await send('DOM.enable');
    await send('Runtime.enable');
    await send('Accessibility.enable');
    enabled = true;
  }

  function on(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function detach() {
    disposed = true;
    listeners.clear();
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch { /* target may already be gone */ }
    try {
      guest.debugger.removeListener('message', onMessage);
      guest.debugger.removeListener('detach', onDetach);
    } catch { /* ignore */ }
    attached = false;
    enabled = false;
  }

  return {
    guest,
    attach,
    enable,
    send,
    on,
    detach,
    get attached() { return attached; },
    get enabled() { return enabled; },
  };
}

module.exports = { createCdp, CdpError, DEFAULT_TIMEOUT };
