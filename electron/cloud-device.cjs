/**
 * 负责：保存桌面设备凭证，并为云端工作区的专用 IPC 发起认证请求。
 * 不负责：把令牌或 VPN 密钥交给渲染进程、管理本地 Bot 存储或执行任务。
 * 被谁调用：electron/main.cjs。
 */

const { readFile, rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseCloudOrigin } = require('../src/services/cloud-connection.mjs');

const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('设备或任务标识无效');
  return value;
};
const providers = new Set(['codex', 'gemini', 'api', 'research']);
const publicHost = ({ origin, label, role, provider, autoVpn }) => ({
  origin, label: label || new URL(origin).host, role, provider: provider || 'codex', autoVpn: Boolean(autoVpn),
});

function createDesktopCloud({ userData, safeStorage, exportVpn }) {
  const file = join(userData, 'cloud-device.bin');
  let queue = Promise.resolve();
  const synced = new Map();
  const syncing = new Map();

  async function credentials() {
    let encrypted;
    try { encrypted = await readFile(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    const stored = JSON.parse(decrypted.result ?? decrypted);
    return Array.isArray(stored?.hosts) ? stored.hosts : stored?.origin ? [stored] : [];
  }

  async function save(value) {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统的凭据存储不可用');
    if (!value.length) { await rm(file, { force: true }); return; }
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ hosts: value }));
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, encrypted.result ?? encrypted, { mode: 0o600 }); await rename(temp, file); }
    finally { await rm(temp, { force: true }); }
  }

  async function request(origin, path, method, value, token, timeout = 8000) {
    const response = await fetch(new URL(path, origin), {
      method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeout),
      headers: { accept: 'application/json', ...(value ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error('云端响应过大');
      chunks.push(chunk);
    }
    let content;
    try { content = JSON.parse(Buffer.concat(chunks)); } catch { /* report by status below */ }
    if (!response.ok) throw Object.assign(new Error(typeof content?.message === 'string' ? content.message.slice(0, 300) : 'Mova 云服务请求失败'), { status: response.status, code: content?.error });
    if (content == null) throw new Error('云服务返回了无效的数据');
    return content;
  }

  function syncVpn(origin, call, force = false) {
    if (syncing.has(origin)) return syncing.get(origin);
    const pending = (async () => {
      const bundle = await exportVpn();
      const hash = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
      if (!force && synced.get(origin) === hash) return null;
      const status = await call('/v1/vpn', 'PUT', bundle, 40_000);
      synced.set(origin, hash);
      return status;
    })().finally(() => syncing.delete(origin));
    syncing.set(origin, pending);
    return pending;
  }

  async function dispatch(action, address, input = {}) {
    const hosts = await credentials();
    if (action === 'hosts') return hosts.map(publicHost);
    const origin = parseCloudOrigin(address);
    const stored = hosts.find(host => host.origin === origin);
    const token = stored?.token;
    const call = (path, method = 'GET', value, timeout) => request(origin, path, method, value, token, timeout);
    const syncSubscription = provider => stored?.autoVpn && ['codex', 'gemini'].includes(provider) ? syncVpn(origin, call) : null;
    const submit = async task => {
      await syncSubscription(task.provider);
      return call('/v1/tasks', 'POST', task);
    };
    if (action === 'session' && !token) return null;
    if (action === 'pair') {
      if (token) throw new Error('此桌面已配对');
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统的凭据存储不可用');
      const { id, name, role, token: newToken } = await call('/v1/pair', 'POST', { code: String(input.code || '').trim().slice(0, 48), name: 'Windows 桌面' });
      if (!/^[A-Za-z0-9_-]{32}$/.test(newToken || '') || !['owner', 'client'].includes(role)) throw new Error('云服务返回了无效的设备凭证');
      const label = typeof input.label === 'string' ? input.label.trim().slice(0, 60) : undefined;
      const provider = providers.has(input.provider) ? input.provider : 'codex';
      try { await save([...hosts, { origin, id: identifier(id), token: newToken, label, provider, role }]); }
      catch (error) { await request(origin, `/v1/devices/${identifier(id)}`, 'DELETE', null, newToken).catch(() => {}); throw error; }
      return { id, name, role };
    }
    if (action === 'forget' && !token) return null;
    if (!token) throw new Error('请先配对桌面设备');
    switch (action) {
      case 'session': return call('/v1/session');
      case 'projects': return call('/v1/projects');
      case 'api-profiles': return call('/v1/api-profiles');
      case 'project': return call('/v1/projects/' + identifier(input.projectId));
      case 'project-save': {
        const { revision, name, instructions, provider, model, apiProfile } = input;
        return call('/v1/projects/' + identifier(input.projectId), 'PATCH', { revision, name, instructions, provider, model, apiProfile });
      }
      case 'project-import': {
        const { revision, repository, commit, manifestPath, filePath, toolName, description } = input;
        return call('/v1/projects/' + identifier(input.projectId) + '/tools', 'POST', { revision, repository, commit, manifestPath, filePath, toolName, description }, 30_000);
      }
      case 'project-run': {
        const projectId = identifier(input.projectId);
        const project = await call('/v1/projects/' + projectId);
        if (project.revision !== input.revision) throw new Error('云项目已更新，请重新读取后再提交');
        await syncSubscription(project.provider);
        return call('/v1/tasks', 'POST', { id: input.id, projectId, projectRevision: input.revision, prompt: input.prompt, research: input.research });
      }
      case 'preferences': {
        const next = { ...stored, ...(providers.has(input.provider) ? { provider: input.provider } : {}),
          ...(typeof input.autoVpn === 'boolean' ? { autoVpn: input.autoVpn && (await call('/v1/session')).role === 'owner' } : {}) };
        if (next.autoVpn && !stored.autoVpn) await syncVpn(origin, call);
        await save(hosts.map(host => host.origin === origin ? next : host));
        if (!next.autoVpn) synced.delete(origin);
        return publicHost(next);
      }
      case 'snapshot': return call(Number.isSafeInteger(input.after) && input.after >= 0 ? `/v1/snapshot?after=${input.after}` : '/v1/snapshot');
      case 'invite': return call('/v1/pair-codes', 'POST', {});
      case 'devices': return call('/v1/devices');
      case 'revoke': return call(`/v1/devices/${identifier(input.id)}`, 'DELETE');
      case 'submit': {
        const provider = input.provider || stored.provider || 'codex';
        return submit({ id: input.id, prompt: input.prompt, provider, botId: input.botId, conversationId: input.conversationId, model: input.model, research: input.research });
      }
      case 'task': return call(`/v1/tasks/${identifier(input.id)}`);
      case 'cancel': return call(`/v1/tasks/${identifier(input.id)}/cancel`, 'POST', {});
      case 'retry': {
        const id = identifier(input.id);
        if (!stored.autoVpn && !input.useHostDefault && !input.replacementId) return call(`/v1/tasks/${id}/retry`, 'POST', {});
        const task = await call(`/v1/tasks/${id}`);
        const provider = input.useHostDefault ? stored.provider || 'codex' : input.provider ?? task.provider;
        if (!providers.has(provider)) throw new Error('模型通道无效');
        if (!['blocked', 'failed', 'cancelled'].includes(task.status)) throw new Error('只能重试等待处理、失败或已取消的任务');
        if (provider !== task.provider) {
          const replacementId = identifier(input.replacementId);
          return submit({ id: replacementId, prompt: task.prompt, provider, conversationId: task.conversationId,
            research: provider !== 'research' && Boolean(task.research) });
        }
        await syncSubscription(provider);
        return call(`/v1/tasks/${id}/retry`, 'POST', {});
      }
      case 'model-status':
        if (!['codex', 'gemini'].includes(input.provider)) throw new Error('模型通道无效');
        return call(`/v1/models/${input.provider}`, 'GET', null, 25_000);
      case 'import': return call('/v1/bots', 'POST', { name: input.name, instructions: input.instructions });
      case 'vpn-status': return call('/v1/vpn');
      case 'vpn-refresh': return stored.autoVpn ? syncVpn(origin, call) : null;
      case 'vpn': return syncVpn(origin, call, true);
      case 'forget':
        if (!input.localOnly) await call(`/v1/devices/${identifier(stored.id)}`, 'DELETE').catch(error => { if (error.status !== 401) throw error; });
        synced.delete(origin);
        await save(hosts.filter(host => host.origin !== origin));
        return null;
      default: throw new Error('云端操作不受支持');
    }
  }

  return function invoke(action, origin, input) {
    const work = () => dispatch(action, origin, input);
    if (!['pair', 'forget', 'preferences'].includes(action)) return work();
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
}

module.exports = { createDesktopCloud };
