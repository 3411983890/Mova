/**
 * 负责：把 `agy acp` 自己枚举出来的模型 id 全打印出来，再逐个试 `session/set_model`，
 *   看 Mova 目录里那些 `<family>-<effort>` 的 id 到底哪些真的能被接受。
 * 不负责：改目录（那是 electron/subscription/cli-models.mjs 的事）。
 * 被谁调用：排查「没能切到模型 X，这一轮沿用 CLI 默认模型」时手工跑。
 *
 * 用法：node scripts/probes/probe-agy-models.mjs [--cwd=<dir>]
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const command = process.env.AGY_COMMAND || join(homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
const cwdArg = process.argv.find(arg => arg.startsWith('--cwd='));
const cwd = cwdArg ? cwdArg.slice(6) : process.cwd();

const child = spawn(command, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buffer = '';
let nextId = 0;
const pending = new Map();

child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  }
});
child.stderr.on('data', () => {});

const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 30_000);
});

const finish = code => { try { child.kill(); } catch { /* 已退出 */ } process.exit(code); };

try {
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'mova-probe', version: '0.0.1' },
  });
  if (init.error) { console.error('initialize 失败', init.error); finish(1); }
  const session = await send('session/new', { cwd, mcpServers: [] });
  if (session.error) { console.error('session/new 失败', JSON.stringify(session.error).slice(0, 400)); finish(1); }
  const sessionId = session.result?.sessionId ?? session.result?.session?.id;
  const models = session.result?.models?.availableModels ?? [];
  const current = session.result?.models?.currentModelId ?? session.result?.models?.current ?? null;
  console.log(`# session=${sessionId} current=${current ?? '-'} models=${models.length}`);
  for (const model of models) {
    const id = model.modelId ?? model.id ?? '';
    console.log(`  ${id}${model.name && model.name !== id ? `   (${model.name})` : ''}`);
  }

  // 逐个试 set_model：只打印被拒的，接受的只报一次总数。
  const accepted = [];
  const rejected = [];
  for (const model of models) {
    const id = model.modelId ?? model.id ?? '';
    if (!id) continue;
    const reply = await send('session/set_model', { sessionId, modelId: id }).catch(error => ({ error: { message: String(error.message) } }));
    if (reply.error) rejected.push([id, String(reply.error.message ?? '').slice(0, 80)]);
    else accepted.push(id);
  }
  console.log(`\n# set_model 接受 ${accepted.length} 个：${accepted.join(', ')}`);
  if (rejected.length) {
    console.log(`# set_model 拒绝 ${rejected.length} 个：`);
    for (const [id, detail] of rejected) console.log(`   ${id}  ${detail}`);
  }

  // Mova 目录里配的那些 id 在不在这份名单里？
  const probe = ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen', 'gemini-4-argon-low'];
  console.log('\n# Mova 目录里的 id 是否在 CLI 名单里：');
  for (const id of probe) console.log(`   ${id}  ${models.some(m => (m.modelId ?? m.id) === id) ? '在' : '不在'}`);
  finish(0);
} catch (error) {
  console.error('探针异常：', error?.message || error);
  finish(2);
}
