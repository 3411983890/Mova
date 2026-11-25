// 一次性协议探针：`agy acp` 到底提供哪些能力？
//   1) initialize → agentCapabilities / authMethods（Gemini 的「登录方式」就在这里）
//   2) session/new → availableModels（模型清单在这里，不是 `agy models`）
//
// 用法：node scripts/.probe-acp-capabilities.mjs
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COMMAND = join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe');
const child = spawn(COMMAND, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buffer = '';
const pending = new Map();
const notifications = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error).slice(0, 300)));
      else resolve(message.result);
      continue;
    }
    notifications.push({ method: message.method, params: message.params });
    // ACP 的服务器→客户端请求：一律婉拒，探针只关心能力清单。
    if (message.id !== undefined && typeof message.method === 'string') {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'probe declines' } })}\n`);
    }
  }
});

let nextId = 1;
function request(method, params, timeoutMs = 20_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`${method} timeout`));
    }, timeoutMs);
    timer.unref?.();
  });
}

const report = {};
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'mova-probe', version: '0.0.0' },
  });
  report.agentInfo = init?.agentInfo ?? null;
  report.protocolVersion = init?.protocolVersion ?? null;
  report.agentCapabilities = init?.agentCapabilities ?? null;
  report.authMethods = init?.authMethods ?? null;

  try {
    const session = await request('session/new', { cwd: homedir(), mcpServers: [] }, 30_000);
    report.sessionId = session?.sessionId ? 'ok' : null;
    // ACP 的会话响应里模型清单叫 `models`（不是 availableModels），另外还有 modes / configOptions。
    report.models = session?.models ?? null;
    report.configOptions = session?.configOptions ?? null;
    report.sessionKeys = session ? Object.keys(session) : null;
  } catch (error) {
    report.sessionError = String(error?.message ?? error).slice(0, 300);
  }
} catch (error) {
  report.initializeError = String(error?.message ?? error).slice(0, 400);
}

report.notifications = notifications.slice(0, 6);
console.log(JSON.stringify(report, null, 2));
try { child.kill(); } catch { /* ignore */ }
process.exit(0);
