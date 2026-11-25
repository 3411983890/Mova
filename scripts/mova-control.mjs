/**
 * 负责：把 Mova CLI 命令映射到 Linux 服务的 Unix 管理接口。
 * 不负责：直接写任务数据、对外 HTTP 鉴权或供应商协议实现。
 * 被谁调用：scripts/mova.mjs。
 */

import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { cloudPaths } from '../electron/services/cloud-api.mjs';
import { terminalTaskStates, fail } from '../electron/services/cloud-store.mjs';
import { loginCloudModel } from '../electron/services/cloud-subscriptions.mjs';
import { restoreCloudBackup } from './mova-restore.mjs';

/** 发出一个管理请求，只向当前系统用户可访问的 Unix 套接字发送。 */
export function control(path, method = 'GET', data, signal) {
  const socketPath = cloudPaths().socket;
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, signal,
      ...(data ? { headers: { 'content-type': 'application/json' } } : {}) }, res => {
      const buffers = [];
      res.on('data', data => buffers.push(data));
      res.once('error', reject);
      res.once('end', () => {
        try {
          const content = JSON.parse(Buffer.concat(buffers));
          if (res.statusCode < 400) resolve(content);
          else reject(fail(content.error, content.message, res.statusCode));
        } catch (err) { reject(err); }
      });
    });
    req.once('error', error => reject(['ENOENT', 'ECONNREFUSED'].includes(error.code)
      ? fail(error.code, 'Mova 服务未运行，请先执行 mova serve 或启动用户服务') : error));
    req.setTimeout(55_000, () => req.destroy(new Error('等待本机服务响应超时')));
    req.end(data ? JSON.stringify(data) : undefined);
  });
}

const print = value => console.log(JSON.stringify(value, null, 2));
const segment = value => encodeURIComponent(value || '');

async function watch(id, signal, after) {
  let cursor = after === undefined ? null : Number(after);
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error('事件游标无效');
  let previous;
  while (!signal.aborted) {
    if (cursor !== null) {
      const page = await control(`/v1/events?after=${cursor}`, 'GET', null, signal);
      for (const event of page.events) if (event.type === 'task' && event.data.id === id) print(event);
      cursor = page.cursor;
      if (page.events.length === 250) continue;
    }
    const task = await control(`/v1/tasks/${segment(id)}`, 'GET', null, signal);
    const current = JSON.stringify(task);
    if (previous !== current) print(task);
    if (terminalTaskStates.has(task.status)) return task;
    previous = current;
    await delay(800, undefined, { signal });
  }
  signal.throwIfAborted();
}

const startTask = (prompt, options, signal) => control('/v1/tasks', 'POST', {
  prompt, id: options.id || randomUUID(), botId: options.bot, conversationId: options.conversation, projectId: options.project,
  provider: options.provider, model: options.model, research: options.research,
}, signal);

async function chat(words, values, signal) {
  if (words.length) return watch((await startTask(words.join(' '), values, signal)).id, signal);
  if (!process.stdin.isTTY) throw new Error('请提供聊天内容，或从终端进入交互模式');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  let conversation = values.conversation;
  try {
    for (;;) {
      const line = (await reader.question('你 > ', { signal })).trim();
      if (line === '/exit') return;
      if (!line) continue;
      const task = await startTask(line, { ...values, id: undefined, conversation }, signal);
      conversation = task.conversationId;
      await watch(task.id, signal);
    }
  } finally { reader.close(); }
}

export async function runCloudCommand(positionals, values, signal) {
  const [area, action, ...args] = positionals;
  const [first] = args;
  if (area === 'chat') return chat(action === undefined ? [] : [action, ...args], values, signal);
  const operation = `${area}/${action || ''}`;
  if (operation === 'task/submit' && args.length) return print(await startTask(args.join(' '), values, signal));
  if (operation === 'task/watch' && args.length === 1) return watch(first, signal, values.after);
  if (['task/cancel', 'task/retry'].includes(operation) && args.length === 1) return print(await control(`/v1/tasks/${segment(first)}/${action}`, 'POST', {}, signal));
  if (operation === 'task/list' && !args.length) return print(await control('/v1/tasks', 'GET', null, signal));
  if (operation === 'project/list' && !args.length) return print(await control('/v1/projects', 'GET', null, signal));
  if (operation === 'project/profiles' && !args.length) return print(await control('/v1/api-profiles', 'GET', null, signal));
  if (operation === 'project/show' && args.length === 1) return print(await control('/v1/projects/' + segment(first), 'GET', null, signal));
  if (operation === 'project/save' && args.length === 2) return print(await control('/v1/projects/' + segment(first), 'PATCH', JSON.parse(await readFile(args[1], 'utf8')), signal));
  if (operation === 'project/import-tool' && args.length === 2) return print(await control('/v1/projects/' + segment(first) + '/tools', 'POST', JSON.parse(await readFile(args[1], 'utf8')), signal));
  if (operation === 'bot/list' && !args.length) return print((await control('/v1/snapshot', 'GET', null, signal)).bots);
  if (operation === 'bot/import' && args.length === 1) {
    const payload = JSON.parse(await readFile(first, 'utf8'));
    const bot = payload.bot || payload;
    const instructions = bot.instructions || [bot.personaConfig?.prompt, bot.personaConfig?.instructions, bot.description].filter(Boolean).join('\n');
    return print(await control('/v1/bots', 'POST', { name: bot.name, instructions }, signal));
  }
  if (operation === 'pair/code' && !args.length && [undefined, 'owner', 'client'].includes(values.role)) {
    return print(await control('/v1/pair-codes', 'POST', { role: values.role || 'owner' }, signal));
  }
  if (operation === 'devices/list' && !args.length) return print(await control('/v1/devices', 'GET', null, signal));
  if (operation === 'devices/revoke' && args.length === 1) return print(await control(`/v1/devices/${segment(first)}`, 'DELETE', null, signal));
  if (operation === 'vpn/status' && !args.length) return print(await control('/v1/vpn', 'GET', null, signal));
  if (operation === 'vpn/apply' && args.length === 1) return print(await control('/v1/vpn', 'PUT', JSON.parse(await readFile(first, 'utf8')), signal));
  if (['model/status', 'model/login'].includes(operation) && args.length === 1 && ['codex', 'gemini'].includes(first)) {
    if (action === 'status') return print(await control(`/v1/models/${first}`, 'GET', null, signal));
    const { proxy } = await control('/v1/admin/proxy', 'POST', { provider: first }, signal);
    return loginCloudModel({ dir: cloudPaths().dir, provider: first, proxy });
  }
  if (area === 'doctor' && action === undefined) {
    return print({ service: await control('/v1/health', 'GET', null, signal), vpn: await control('/v1/vpn', 'GET', null, signal) });
  }
  if (area === 'backup' && action && !args.length) return print(await control('/v1/admin/backup', 'POST', { path: resolve(action) }, signal));
  if (area === 'restore' && action && !args.length) {
    try { await control('/v1/health', 'GET', null, signal); } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return print(await restoreCloudBackup(cloudPaths(), resolve(action)));
      throw error;
    }
    throw new Error('请先停止 Mova 服务，再恢复备份');
  }
  throw new Error('命令或参数不正确，请运行 mova --help');
}
