/**
 * 负责：提供云服务 REST 协议、Unix 管理入口、设备配对和任务生命周期。
 * 不负责：HTTPS 证书终止、供应商凭据管理和浏览器自动化。
 * 被谁调用：scripts/mova-health.mjs 和云端集成测试。
 */

import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, openCloudStore, text } from './cloud-store.mjs';
import { cloudProviders, createCloudRunner, startCloudWorker } from './cloud-worker.mjs';
import { createSubscriptions } from './cloud-subscriptions.mjs';
import { createCloudVpn } from './cloud-vpn.mjs';
import { startCloudPush, validPushToken } from './cloud-push.mjs';
import { apiProfiles, importGithubTool, projectId, projectPatch } from './cloud-projects.mjs';
import { CLOUD_HEALTH_PATH, CLOUD_PROTOCOL_VERSION } from '../../src/services/cloud-connection.mjs';

const MAX_BODY = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/;
const healthy = { service: 'mova', protocolVersion: CLOUD_PROTOCOL_VERSION, status: 'ready', capabilities: ['pairing', 'tasks', 'vpn', 'projects'] };

export function cloudPaths(env = process.env) {
  const dir = resolve(env.MOVA_HOME || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'mova', 'cloud'));
  return { dir, database: join(dir, 'workspace.sqlite'), socket: join(dir, 'control.sock') };
}

function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw fail('content_type', '请求须使用 application/json', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail('too_large', '请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* invalid input is reported below */ }
  throw fail('invalid_json', '请求不是有效的 JSON 对象');
}

function idOf(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw fail('invalid_id', `${label}无效`);
  return value;
}

function requireOwner(device) {
  if (device.role !== 'owner') throw fail('owner_required', '此操作需要桌面管理员权限', 403);
}

function cursorOf(url) {
  const after = url.searchParams.get('after');
  if (after === null) return undefined;
  const cursor = Number(after);
  if (!/^\d+$/.test(after) || !Number.isSafeInteger(cursor)) throw fail('invalid_cursor', '事件游标无效');
  return cursor;
}

function taskInput(input) {
  const provider = input.provider == null || input.provider === '' ? undefined : input.provider;
  if (provider !== undefined && !cloudProviders.has(provider)) throw fail('unsupported_provider', '模型通道无效');
  if (input.projectRevision !== undefined && (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 1 || !input.projectId)) {
    throw fail('project_input', '云项目版本无效');
  }
  return {
    id: idOf(input.id ?? randomUUID(), '任务标识'),
    ...(input.conversationId ? { conversationId: idOf(input.conversationId, '会话标识') } : {}),
    ...(input.projectId !== undefined ? { projectId: projectId(input.projectId) } : {}),
    ...(input.projectRevision !== undefined ? { projectRevision: input.projectRevision } : {}),
    botId: idOf(input.botId ?? 'mova', 'Bot 标识'),
    prompt: text(input.prompt, '任务内容', 12_000), provider, research: input.research === true && provider !== 'research',
    ...(input.model != null ? { model: text(input.model, '模型', 200, true) } : {}),
  };
}

function createDispatch(store, worker, subscriptions, vpn, paths, pushEnabled, env) {
  return async (req, res, local) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    if (route === `GET ${CLOUD_HEALTH_PATH}`) return respond(res, 200, healthy);
    if (route === 'POST /v1/pair') {
      const input = await body(req);
      return respond(res, 201, store.devices.pair(text(input.code, '配对码', 48), text(input.name, '设备名称', 80)));
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1] || '';
    const device = local ? { id: 'local', role: 'owner' } : store.devices.authenticate(token);
    if (!device) throw fail('unauthorized', '设备尚未配对或已撤销', 401);
    if (route === 'GET /v1/session') return respond(res, 200, device);
    if (route === 'GET /v1/projects' || route === 'GET /v1/api-profiles') {
      requireOwner(device);
      return respond(res, 200, route.endsWith('/projects') ? store.projects.list() : apiProfiles(env));
    }
    const projectRoute = /^\/v1\/projects\/([a-z0-9_-]+)(\/tools)?$/.exec(url.pathname);
    if (projectRoute) {
      requireOwner(device);
      const id = projectId(projectRoute[1]);
      if (!projectRoute[2] && req.method === 'GET') return respond(res, 200, store.projects.mustGet(id));
      if (!projectRoute[2] && req.method === 'PATCH') {
        const { revision, patch } = projectPatch(await body(req), env);
        return respond(res, 200, store.projects.save(id, revision, patch));
      }
      if (projectRoute[2] && req.method === 'POST') {
        const input = await body(req);
        if (store.projects.mustGet(id).revision !== input.revision) throw fail('project_conflict', '云项目已更新，请重新读取后再修改', 409);
        const tool = await importGithubTool(input);
        if (!local && !store.devices.authenticate(token)) throw fail('unauthorized', '设备已撤销', 401);
        return respond(res, 201, store.projects.linkTool(id, input.revision, tool));
      }
    }
    if (route === 'PUT /v1/device/push' && !local) {
      const { token: pushToken } = await body(req);
      if (pushToken !== null && !pushEnabled) throw fail('push_unavailable', '管理员尚未开启任务通知', 503);
      if (pushToken !== null && !validPushToken(pushToken)) throw fail('push_invalid', '设备通知凭证无效');
      store.push.set(device.id, pushToken);
      return respond(res, 200, { enabled: Boolean(pushToken) });
    }
    if (route === 'GET /v1/snapshot') return respond(res, 200, store.snapshot(cursorOf(url)));
    if (route === 'GET /v1/events') {
      const cursor = cursorOf(url) ?? 0;
      const events = store.tasks.events(cursor);
      return respond(res, 200, { events, cursor: events.at(-1)?.seq ?? cursor });
    }
    if (route === 'POST /v1/tasks') return respond(res, 202, store.tasks.submit(taskInput(await body(req))));
    if (route === 'GET /v1/tasks') return respond(res, 200, store.tasks.list());
    const task = /^\/v1\/tasks\/([A-Za-z0-9_-]+)(?:\/(cancel|retry))?$/.exec(url.pathname);
    if (task && (!task[2] ? req.method === 'GET' : req.method === 'POST')) {
      const current = store.tasks.find(task[1]);
      if (!current) throw fail('not_found', '任务不存在', 404);
      if (!task[2]) return respond(res, 200, current);
      const updated = store.tasks.change(task[1], task[2] === 'cancel' ? 'cancelled' : 'queued');
      if (task[2] === 'cancel') worker.cancel(task[1]);
      return respond(res, 200, updated);
    }
    if (route === 'POST /v1/bots') {
      const input = await body(req);
      return respond(res, 201, store.importBot(text(input.name, 'Bot 名称', 80), text(input.instructions, 'Bot 指令', 8000, true)));
    }
    if (route === 'POST /v1/pair-codes') {
      requireOwner(device);
      const input = await body(req);
      const role = local && input.role === 'owner' ? 'owner' : 'client';
      return respond(res, 201, store.devices.invite(role));
    }
    if (route === 'GET /v1/devices') {
      requireOwner(device);
      return respond(res, 200, store.devices.list());
    }
    const revoke = /^\/v1\/devices\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && revoke) {
      if (device.id !== revoke[1]) requireOwner(device);
      return respond(res, 200, { revoked: store.devices.revoke(revoke[1]) });
    }
    if (route === 'GET /v1/vpn') { requireOwner(device); return respond(res, 200, vpn.status()); }
    if (route === 'PUT /v1/vpn') { requireOwner(device); return respond(res, 200, await vpn.configure(await body(req))); }
    if (route === 'POST /v1/admin/proxy' && local) {
      const { provider } = await body(req);
      if (!['codex', 'gemini'].includes(provider)) throw fail('unsupported_provider', '订阅通道无效');
      return respond(res, 200, { proxy: (await vpn.resolve(provider, '')).url });
    }
    const model = /^\/v1\/models\/(codex|gemini)$/.exec(url.pathname);
    if (req.method === 'GET' && model) { requireOwner(device); return respond(res, 200, await subscriptions.status(model[1])); }
    if (route === 'POST /v1/admin/backup' && local) {
      const input = await body(req);
      const destination = resolve(text(input.path, '备份路径', 1024));
      if (destination === paths.database) throw fail('backup_target', '备份需要不同的文件名');
      store.backup(destination);
      await chmod(destination, 0o600);
      return respond(res, 201, { path: destination });
    }
    throw fail('not_found', '接口不存在', 404);
  };
}

async function removeStaleSocket(path) {
  let info;
  try { info = await stat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isSocket()) throw fail('socket_path', '控制地址被其他文件占用');
  const listening = await new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
  if (listening) throw fail('already_running', 'Mova 服务已在运行');
  await unlink(path);
}

function asServer(dispatch, local) {
  return createServer({ headersTimeout: 5000, requestTimeout: 15_000 }, (req, res) => {
    void dispatch(req, res, local).catch(error => {
      if (res.destroyed) return;
      respond(res, error.status || 500, { error: error.status ? error.code : 'internal', message: error.status ? error.message : '服务执行失败，请检查服务日志' });
    });
  });
}

export async function startCloudService({ port, signal, env = process.env, executor } = {}) {
  if (process.platform !== 'linux') throw fail('linux_required', '请在 Linux 或 WSL 中启动 Mova 服务');
  signal?.throwIfAborted();
  const paths = cloudPaths(env);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  const store = openCloudStore(paths.database);
  const vpn = createCloudVpn(paths.dir, env);
  const subscriptions = createSubscriptions({ dir: paths.dir, vpn, env });
  const worker = startCloudWorker(store.tasks, executor || createCloudRunner({ env, subscriptions }));
  const pushEnabled = env.MOVA_ENABLE_PUSH === '1';
  const closePush = pushEnabled ? startCloudPush(store.push, env.MOVA_EXPO_PUSH_ACCESS_TOKEN) : null;
  const dispatch = createDispatch(store, worker, subscriptions, vpn, paths, pushEnabled, env);
  const remote = asServer(dispatch, false);
  const local = asServer(dispatch, true);
  let stopped;
  const stop = () => stopped ??= (async () => {
    await Promise.all([local, remote].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    try { await closePush?.(); await worker.stop(); await vpn.close(); } finally { store.close(); }
  })();
  try {
    remote.listen(port, '127.0.0.1');
    await once(remote, 'listening');
    await removeStaleSocket(paths.socket);
    local.listen(paths.socket);
    await once(local, 'listening');
    await chmod(paths.socket, 0o600);
    await vpn.start();
    const onAbort = () => { void stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return { address: remote.address(), socket: paths.socket, async close() { signal?.removeEventListener('abort', onAbort); await stop(); } };
  } catch (error) { await stop(); throw error; }
}
