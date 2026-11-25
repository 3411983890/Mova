// 真机验证：用真实 safeStorage 装配订阅 IPC，确认 assertWritable() 不再误判「凭据存储不可用」。
// 判断依据：写路径如果能走到「账号不存在」，说明加密闸门已经放行；报 credential 就说明仍然被挡。
const { app, ipcMain, safeStorage, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');

app.whenReady().then(async () => {
  const out = { steps: [] };
  try {
    const ipcUrl = pathToFileURL(path.join(__dirname, '..', 'electron', 'subscription', 'ipc.mjs')).href;
    const { installSubscriptionIpc } = await import(ipcUrl);
    const dir = await mkdtemp(path.join(tmpdir(), 'mova-sub-probe-'));

    // 只捕获 handler，不真的用窗口广播
    const handlers = new Map();
    const fakeIpcMain = {
      handle(channel, fn) { handlers.set(channel, fn); },
      removeHandler(channel) { handlers.delete(channel); },
    };

    const { service } = installSubscriptionIpc({
      ipcMain: fakeIpcMain,
      app,
      shell: { openExternal: async () => {} },
      safeStorage,
      userDataDir: dir,
      fetch: () => { throw new Error('probe 不应该发网络请求'); },
      logger: { info() {}, warn() {} },
      getWindows: () => [],
    });
    out.steps.push({ step: 'install', ok: true, handlers: handlers.size });

    // 1) 真实加密闸门：settingsSet 是纯写操作，能成功就说明 assertWritable 放行了
    const set = await handlers.get('subscription:settings:set')({}, { autoSwitch: false });
    out.steps.push({ step: 'settingsSet', ok: set?.ok === true, error: set?.error ?? null });

    // 2) logout 一个不存在的账号：闸门若仍挡住会报 credential，正确的结果是 not_configured
    const logout = await handlers.get('subscription:logout')({}, { provider: 'chatgpt', accountId: 'does-not-exist' });
    out.steps.push({
      step: 'logout(unknown)',
      ok: logout?.ok === false && logout?.error === 'not_configured',
      error: logout?.error ?? null,
    });

    // 3) 真实加解密往返：直接调 service 的 store 面（通过 list 触发读盘，空目录应当成功返回空列表）
    const listed = await service.list();
    out.steps.push({
      step: 'list()',
      ok: listed?.accounts?.length === 0,
      accounts: listed?.accounts?.length ?? null,
    });

    out.conclusion = out.steps.every(step => step.ok) ? 'PASS' : 'FAIL';
  } catch (error) {
    out.conclusion = `THREW: ${error?.message}`;
  }
  console.log(JSON.stringify(out, null, 2));
  app.quit();
});
