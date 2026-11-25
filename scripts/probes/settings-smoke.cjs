'use strict';
const { createBrowserTools } = require('../../electron/browser/tools.cjs');
async function run(jsBatch) {
  const operations = new Proxy({
    getPrefs: () => ({ agent: { tier: 'interact' }, advanced: { jsBatch } }),
    runJs: async () => ({ ok: true, result: 1 }),
    emit: () => {},
  }, { get: (target, key) => target[key] ?? (() => ({})) });
  const tool = createBrowserTools(operations).find(item => item.name === 'browser_run_js');
  const result = await tool.execute('t1', { script: 'return 1' });
  return { isError: result.isError, text: result.content?.[0]?.text };
}
(async () => {
  console.log('on', JSON.stringify(await run(true)));
  console.log('off', JSON.stringify(await run(false)));
})();
