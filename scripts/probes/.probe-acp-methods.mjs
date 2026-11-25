/**
 * 探针：agy 1.5.8 的 ACP 是否提供「选模型」的方法？
 * 未登录时也能测：未知方法回 -32601，已知方法会先撞到认证（-32000）。
 */
import { spawn } from 'node:child_process';
import { createAcpClient } from '../../electron/acp/client.mjs';

const command = 'C:\\Users\\34119\\AppData\\Local\\agy\\bin\\agy.exe';
const client = createAcpClient({ spawn, timeoutMs: 15_000 });
client.onRequest(async () => ({ action: 'decline' }));

const call = async (method, params) => {
  try {
    const response = await client.request(method, params);
    return `OK ${JSON.stringify(response).slice(0, 200)}`;
  } catch (error) {
    return `ERR code=${error?.code ?? ''} detail=${String(error?.detail ?? error?.message ?? '').slice(0, 140)}`;
  }
};

client.start({ command, args: ['acp'], env: process.env, cwd: process.env.APPDATA });
await client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'Mova', version: '0.1.0' } });

for (const method of [
  'session/set_model', 'session/setModel', 'session/select_model', 'session/models',
  'session/model', 'session/configure', 'session/set_mode', 'session/load',
]) {
  console.log(method.padEnd(24), await call(method, { sessionId: 'probe', modelId: 'gemini-4-argon-medium' }));
}

console.log('session/new        ', await call('session/new', { cwd: process.env.APPDATA, mcpServers: [] }));
client.close();
process.exit(0);
