import './design-workspace.css';

/**
 * The design canvas' app-level entry. The editor itself is a separately built
 * bundle; this wrapper owns when it loads, where its panel lives and how the
 * shared browser surface switches to it.
 */
export function mountDesignWorkspace({ getScope, host }) {
  let workspace, pending;
  let migrations = Promise.resolve();
  async function load() {
    if (workspace) return workspace;
    if (!window.movaDesktop?.design) throw new Error('设计画板需要 Mova 桌面版');
    pending ??= (async () => {
      const module = await import(/* @vite-ignore */ new URL('./vendor/open-pencil-editor/index.js', window.location.href).href);
      workspace = module.mountDesignWorkspace({ getScope, host });
      const panel = document.querySelector('.mova-design-panel');
      if (host?.slot && panel && panel.parentElement !== host.slot) host.slot.append(panel);
      return workspace;
    })().catch(error => {
      pending = null;
      throw error;
    });
    return pending;
  }
  const button = document.createElement('button');
  button.className = 'rail-button';
  button.title = '设计画板';
  button.setAttribute('aria-label', '设计画板');
  button.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12m4-7 4 4m0-4-4 4"/></svg>';
  /** Open the canvas surface. The side panel asks for this when its view chooser picks 画板. */
  async function openCanvas() {
    await migrations;
    const instance = await load();
    host?.showView?.('canvas');
    await instance.open();
  }
  button.addEventListener('click', () => {
    openCanvas().catch(error => {
      button.title = error.message;
      console.warn('[design]', error.message);
      host?.showView?.('web');
    });
  });
  // The design editor lives in its own bundle, so the side browser cannot call into it: it asks
  // through this event instead, which keeps the canvas' own load path in one place.
  const onOpenDesign = () => {
    openCanvas().catch(error => console.warn('[design]', error.message));
  };
  window.addEventListener('mova:open-design', onOpenDesign);
  document.querySelector('.rail-top').append(button);
  const unsubscribe = window.movaDesktop?.design?.onCommand(async request => {
    try {
      await migrations;
      await (await load()).handleCommand(request);
    } catch (error) {
      await window.movaDesktop.design.respond({ id: request.id, error: error.message });
    }
  });
  window.addEventListener('beforeunload', () => unsubscribe?.());
  window.addEventListener('mova:design-settings', event => {
    if (!event.detail.enabled) {
      const panel = document.querySelector('.mova-design-panel');
      if (panel) panel.hidden = true;
      host?.showView?.('web');
    }
  });
  return {
    rekey(from, to) {
      if (!window.movaDesktop?.design || from === to) return;
      migrations = migrations.then(async () => {
        if (workspace) await workspace.rekey(from, to);
        else {
          const result = await window.movaDesktop.design.rekey(from, to);
          if (!result.ok) throw new Error(result.error);
        }
      }).catch(error => {
        console.warn('[design]', error.message);
        button.title = error.message;
      });
    },
    syncScope() {
      void migrations.then(() => workspace?.syncScope());
    },
  };
}
