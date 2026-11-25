'use strict';
const path = require('node:path');
const { app } = require('electron');
const { createMouseHook } = require(path.join(__dirname, '..', 'electron', 'desktop', 'hook.cjs'));

app.whenReady().then(async () => {
  const hook = createMouseHook({ isLocked: () => true, onUserClick: (p) => console.log('[hook] user click', p) });
  const installed = hook.install();
  console.log('[hook] install ->', JSON.stringify(installed));
  await new Promise((r) => setTimeout(r, 800));
  console.log('[hook] stats', JSON.stringify(hook.stats()));
  hook.uninstall();
  console.log('[hook] uninstalled');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
