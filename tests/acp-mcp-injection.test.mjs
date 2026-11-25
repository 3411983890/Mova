/**
 * ACP 会话的 `mcpServers` 注入契约（§11.3b）。
 *
 * 关键点：要不要挂 Mova 的工具，只能在 `initialize` 之后决定（对面自报
 * `agentCapabilities.mcpCapabilities.http`）。所以 engine 允许 `mcpServers`
 * 传函数，并把它拿到的能力位转交给调用方。这里锁住三件事：
 * 函数形态被调用、能力位被透传、返回的数组原样进 `session/new`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createAcpEngine } from '../electron/acp/engine.mjs';

/** 假 CLI：git 记录 session/new 的 params，并回一个带能力位的 initialize。 */
function fakeCli({ httpCapable = true } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const seen = { methods: [], sessionNew: null };
  let buffer = '';
  const child = {
    stdin, stdout, stderr, pid: 51,
    kill() { stdout.end(); stderr.end(); },
    on(event, handler) { if (event === 'exit') child.emitExit = handler; return child; },
    once(event, handler) { return child.on(event, handler); },
    removeListener() { return child; },
  };
  const reply = message => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      seen.methods.push(message.method);
      if (message.method === 'initialize') {
        reply({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { mcpCapabilities: { http: httpCapable, stdio: true } },
          },
        });
      } else if (message.method === 'session/new') {
        seen.sessionNew = message.params;
        reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's-1' } });
      } else if (message.method === 'session/prompt') {
        reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      } else {
        reply({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    }
  });
  return { child, seen };
}

test('mcpServers 传函数：initialize 之后被调用，能力位被透传，结果原样进 session/new', async () => {
  const cli = fakeCli({ httpCapable: true });
  const engine = createAcpEngine({ spawn: () => cli.child, timeoutMs: 2000 });
  let received = null;
  const servers = [{ type: 'http', name: 'mova-tools', url: 'http://127.0.0.1:1234/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] }];
  const result = await engine.runTurn({
    command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {},
    mcpServers: async ({ capabilities }) => {
      received = capabilities;
      return servers;
    },
  });
  assert.equal(result.ok, true, '这一轮应当成功');
  assert.ok(received, '函数形态必须被调用，并收到能力位');
  assert.equal(received.mcpCapabilities.http, true, '能力位要如实透传');
  assert.deepEqual(cli.seen.sessionNew?.mcpServers, servers, 'session/new 必须收到调用方给的数组');
  await engine.dispose();
});

test('mcpServers 传函数并返回空数组：session/new 收到空数组（不是 undefined）', async () => {
  const cli = fakeCli({ httpCapable: false });
  const engine = createAcpEngine({ spawn: () => cli.child, timeoutMs: 2000 });
  const result = await engine.runTurn({
    command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {},
    mcpServers: async ({ capabilities }) => (capabilities?.mcpCapabilities?.http === true ? [{}] : []),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(cli.seen.sessionNew?.mcpServers, [], '不支持 HTTP 型 MCP 时应当不挂任何 server');
  await engine.dispose();
});

test('mcpServers 传函数抛错：整轮失败收敛成 acp_protocol，不抛裸异常', async () => {
  const cli = fakeCli();
  const engine = createAcpEngine({ spawn: () => cli.child, timeoutMs: 2000 });
  const result = await engine.runTurn({
    command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {},
    mcpServers: async () => { throw new Error('tool server down'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acp_protocol');
  await engine.dispose();
});

test('mcpServers 传数组（旧形态）仍然可用', async () => {
  const cli = fakeCli();
  const engine = createAcpEngine({ spawn: () => cli.child, timeoutMs: 2000 });
  const servers = [{ name: 'plain', command: 'node', args: ['x.js'] }];
  await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {}, mcpServers: servers });
  assert.deepEqual(cli.seen.sessionNew?.mcpServers, servers);
  await engine.dispose();
});
