// 端到端探针：真的走一遍「添加 Gemini 账号」——用本机 agy CLI 的登录态，
// 而不是任何假实现。证明的链路是：
//   installSubscriptionIpc → CHANNELS.login{gemini} → agy models（真实子进程）→ 落库 → CHANNELS.list
//
// 用法：node scripts/.probe-gemini-account.mjs   （纯 Node，不需要 Electron）
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSubscriptionIpc } from '../../electron/subscription/ipc.mjs';
import { CHANNELS } from '../../electron/subscription/contract.mjs';

const xor = buffer => buffer.map(byte => byte ^ 0x5a);

function fakeSafeStorage() {
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(text) { return xor(Buffer.from(text, 'utf8')); },
    async decryptStringAsync(data) { return { shouldReEncrypt: false, result: xor(Buffer.from(data)).toString('utf8') }; },
  };
}

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle(channel, listener) { handlers.set(channel, listener); }, removeHandler(channel) { handlers.delete(channel); } };
}

const dir = await mkdtemp(join(tmpdir(), 'mova-gemini-probe-'));
const ipcMain = fakeIpcMain();
const events = [];

const installed = installSubscriptionIpc({
  ipcMain,
  app: { getPath: () => dir },
  shell: { openExternal: async () => {} },
  safeStorage: fakeSafeStorage(),
  userDataDir: dir,
  fetch: globalThis.fetch,
  logger: { info: () => {}, warn: () => {} },
  getWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel, payload) => events.push(payload) } }],
});

const invoke = async (channel, payload) => ipcMain.handlers.get(channel)({}, payload);

const loginStarted = Date.now();
const login = await invoke(CHANNELS.login, { provider: 'gemini' });
const loginMs = Date.now() - loginStarted;
const list = await invoke(CHANNELS.list);
const cliStatus = await invoke(CHANNELS.cliStatus, { force: true });

let stored = '';
try { stored = await readFile(join(dir, 'subscription-accounts.json'), 'utf8'); } catch { stored = '(no file)'; }

console.log(JSON.stringify({
  loginMs,
  login,
  cli: cliStatus.value ? { found: cliStatus.value.found, version: cliStatus.value.version, command: cliStatus.value.command } : cliStatus,
  accounts: (list.value?.accounts ?? []).map(account => ({
    id: account.id, provider: account.provider, email: account.email, plan: account.plan, state: account.state,
  })),
  eventKinds: events.map(event => `${event.kind}:${event.state ?? event.provider ?? ''}`),
  storedPreview: stored.slice(0, 120),
}, null, 2));

installed.dispose();
await rm(dir, { recursive: true, force: true });
