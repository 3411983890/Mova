/**
 * 负责：接通 Linux Codex App Server 和 Antigravity ACP 的模型、状态与文本回合。
 * 不负责：模型工具挂载、网页操作、设备同步或凭据复制。
 * 被谁调用：cloud-api.mjs、cloud-worker.mjs 及 mova model login。
 */

import { once } from 'node:events';
import { createAcpClient } from '../acp/client.mjs';
import { openModelIsolation } from './cloud-model-isolation.mjs';
import { probeGeminiUsageViaPrint } from '../subscription/gemini-usage-cli.mjs';
import { fail } from './cloud-store.mjs';

async function withModel(options, signal, action) {
  signal.throwIfAborted();
  const isolation = await openModelIsolation(options);
  const exited = Promise.withResolvers();
  const client = createAcpClient({ spawn: isolation.spawn, timeoutMs: 35_000, onProcessExit: () => exited.resolve(true) });
  const onAbort = () => client.close();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const isCodex = options.provider === 'codex';
    client.start({ command: isCodex ? 'codex' : 'agy', args: isCodex ? ['app-server', '--listen', 'stdio://'] : ['acp'] });
    client.onRequest(method => method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : undefined);
    const clientInfo = { name: 'mova-linux', title: 'Mova', version: '1.0.0' };
    await client.request('initialize', isCodex ? { clientInfo } : { protocolVersion: 1, clientInfo, clientCapabilities: {} });
    if (isCodex) client.notify('initialized', {});
    return await action(client, exited.promise, isolation.spawn);
  } finally {
    signal.removeEventListener('abort', onAbort);
    client.close();
    await isolation.close();
  }
}

async function codexAccount(client) {
  const { account } = await client.request('account/read', { refreshToken: false });
  return account?.type === 'chatgpt' ? account : null;
}

function missingLogin(provider) {
  return fail('model_login', `请在 Linux 运行 mova model login ${provider} 完成订阅授权`, 503);
}

async function runCodex(client, exited, model, prompt, signal) {
  if (!await codexAccount(client)) throw missingLogin('codex');
  const { thread } = await client.request('thread/start', { cwd: '/work', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
    ...(model ? { model } : {}) });
  let output = '';
  const finished = Promise.withResolvers();
  const unsubscribe = client.onNotification((method, value) => {
    if (value?.threadId !== thread.id) return;
    if (method === 'item/agentMessage/delta' && typeof value.delta === 'string' && output.length < 32_000) output += value.delta;
    if (method === 'turn/completed') finished.resolve(value.turn);
  });
  const cancelled = () => finished.resolve(null);
  signal.addEventListener('abort', cancelled, { once: true });
  try {
    await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }] });
    const turn = await Promise.race([finished.promise, exited.then(() => null)]);
    signal.throwIfAborted();
    if (turn?.status !== 'completed' || !output.trim()) throw fail('codex_turn', 'Codex 未完成该回合，请检查订阅和线路后重试', 503);
    return output;
  } finally { unsubscribe(); signal.removeEventListener('abort', cancelled); }
}

async function agySession(client) {
  try { return await client.request('session/new', { cwd: '/work', mcpServers: [] }); }
  catch { throw missingLogin('gemini'); }
}

async function runAgy(client, model, prompt, signal) {
  const { sessionId } = await agySession(client);
  if (model) await client.request('session/set_model', { sessionId, modelId: model });
  let output = '';
  const unsubscribe = client.onNotification((method, value) => {
    const update = value?.update;
    if (method === 'session/update' && value?.sessionId === sessionId && update?.sessionUpdate === 'agent_message_chunk'
      && update.content?.type === 'text' && output.length < 32_000) output += update.content.text;
  });
  try {
    const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    signal.throwIfAborted();
    if (!output.trim() || ['cancelled', 'refusal'].includes(result?.stopReason)) throw fail('agy_turn', 'Antigravity 未返回可用结果', 503);
    return output;
  } finally { unsubscribe(); }
}

export function createSubscriptions({ dir, vpn, env }) {
  async function connected(provider, model, signal, action) {
    const route = await vpn.resolve(provider, model);
    try { return await withModel({ dir, provider, proxy: route.url, env }, signal, action); }
    catch (error) {
      signal.throwIfAborted();
      if (error.status) throw error;
      throw fail('subscription_unavailable', '订阅 CLI 无法执行，请检查 Linux 授权、隔离和 VPN 线路', 503);
    }
  }
  return {
    run(provider, model, prompt, signal) {
      return connected(provider, model, signal, (client, exited) => provider === 'codex'
        ? runCodex(client, exited, model, prompt, signal) : runAgy(client, model, prompt, signal));
    },
    async status(provider) {
      try {
        return await connected(provider, '', AbortSignal.timeout(20_000), async (client, _exited, spawnImpl) => {
          if (provider === 'codex') {
            if (!await codexAccount(client)) return { provider, authorized: false, models: [], usage: null };
            const catalog = await client.request('model/list', { limit: 100 }).catch(() => ({}));
            const usage = await client.request('account/rateLimits/read', {}).catch(() => null);
            return { provider, authorized: true, models: (catalog.data || []).map(model => model.id || model.model).filter(Boolean), usage };
          }
          const session = await agySession(client);
          const probe = await probeGeminiUsageViaPrint({ command: 'agy', spawnImpl, timeoutMs: 5000 });
          return { provider, authorized: true, models: (session.models?.availableModels || []).map(model => model.modelId || model.id).filter(Boolean),
            usage: probe.windows.length ? { checkedAt: probe.checkedAt, windows: probe.windows } : null };
        });
      } catch (err) { return { provider, authorized: err.code === 'model_login' ? false : null, models: [], usage: null, error: err.code || 'unavailable', message: err.status ? err.message : '无法读取订阅状态' }; }
    },
  };
}

export async function loginCloudModel({ dir, provider, proxy, env = process.env }) {
  const isolation = await openModelIsolation({ dir, provider, proxy, env, interactive: true });
  try {
    const cli = isolation.spawn('', provider === 'codex' ? ['login', '--device-auth'] : [], { stdio: 'inherit' });
    const [code] = await once(cli, 'close');
    if (code !== 0) throw fail('login_failed', '订阅授权未完成，请确认线路和账号后再试');
  } finally { await isolation.close(); }
}
