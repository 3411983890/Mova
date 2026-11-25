'use strict';
const { createDesignRuntime } = require('./design-runtime.cjs');
const { createDesignFontLoader, DESIGN_FONT_ALIASES } = require('./design-fonts.cjs');
function installDesignIpc({ ipcMain, directory, authorize }) {
  const runtime = createDesignRuntime({ directory, send: (sender, channel, payload) => sender.send(channel, payload) });
  const loadFont = createDesignFontLoader();
  for (const [channel, fn] of Object.entries({
    'design:settings': () => runtime.getSettings(),
    'design:configure': (_sender, patch) => runtime.configure(patch),
    'design:load': (_sender, scope) => runtime.load(scope),
    'design:save': (_sender, scope, revision, snapshot) => runtime.save(scope, revision, snapshot),
    'design:rekey': (_sender, from, to) => runtime.rekey(from, to),
    'design:respond': (sender, payload) => runtime.respond(sender, payload),
    // The renderer builds its font catalogue from this, so the two tables cannot drift apart.
    'design:font-families': () => DESIGN_FONT_ALIASES.map(([family]) => family),
    'design:font': async (_sender, family, style) => {
      if (process.platform !== 'win32') return null;
      return loadFont(family, style);
    },
  })) ipcMain.handle(channel, async (event, ...args) => { try { authorize(event); return { ok: true, value: await fn(event.sender, ...args) }; } catch (error) { return { ok: false, error: error.message }; } });
  return runtime;
}
module.exports = { installDesignIpc };
