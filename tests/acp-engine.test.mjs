/**
 * ACP 会话引擎测试。
 *
 * 用 PassThrough 造假 stdio + 一个脚本化的假 CLI，不启动真实进程：
 * 这样「initialize 顺序」「通知翻译」「反向请求走向」「中断只 cancel 不 kill」都能确定性地断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createAcpEngine } from '../electron/acp/engine.mjs';

/**
 * 假 CLI：读 NDJSON 请求并按方法应答；`script` 可在 session/prompt 前插入通知。
 */
function fakeCli({ sessionId = 'sess-1', onPrompt, usage = null } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const seen = [];
  let buffer = '';
  let exited = false;

  const child = {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    killer: null,
    kill(signal) {
      exited = true;
      child.killer = signal ?? 'SIGTERM';
      stdout.end();
      stderr.end();
      child.emitExit?.(0, null);
    },
    on(event, handler) {
      if (event === 'exit') child.emitExit = handler;
      if (event === 'close' && !child.emitClose) child.emitClose = handler;
      return child;
    },
    once(event, handler) {
      return child.on(event, handler);
    },
    removeListener() {
      return child;
    },
    emitExit: null,
    emitClose: null,
  };

  function reply(message) {
    stdout.write(`${JSON.stringify(message)}\n`);
  }

  function handle(message) {
    seen.push(message.method ?? 'response');
    if (message.method === 'initialize') {
      reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'fake' } } });
      return;
    }
    if (message.method === 'session/new') {
      reply({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      return;
    }
    if (message.method === 'session/cancel') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.method === 'session/prompt') {
      // 先发两条通知：一条思考、一条正文，再回最终响应。
      reply({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看看项目结构' } } },
      });
      reply({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的，我来改。' } } },
      });
      if (typeof onPrompt === 'function') onPrompt({ reply, message });
      reply({
        jsonrpc: '2.0',
        id: message.id,
        result: { stopReason: 'end_turn', ...(usage ? { usage } : {}) },
      });
      return;
    }
    reply({ jsonrpc: '2.0', id: message.id, result: {} });
  }

  stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      handle(JSON.parse(line));
    }
  });

  return { child, seen, reply, stderr, stdout };
}

/** 同样的形状，但让某个方法永远不回，用来测超时与中断。 */
function silentCli(methodToHang) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const seen = [];
  let buffer = '';
  const child = {
    stdin,
    stdout,
    stderr,
    pid: 4343,
    kill() {
      stdout.end();
      stderr.end();
    },
    on(event, handler) {
      if (event === 'exit') child.emitExit = handler;
      return child;
    },
    once(event, handler) {
      return child.on(event, handler);
    },
    removeListener() {
      return child;
    },
  };
  stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      seen.push(message.method);
      if (message.method === methodToHang) continue;
      if (message.method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })}\n`);
      } else if (message.method === 'session/new') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-hang' } })}\n`);
      } else {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      }
    }
  });
  return { child, seen };
}

function engineWith(cli) {
  return createAcpEngine({
    spawn: () => cli.child,
    timeoutMs: 400,
  });
}

test('正常一轮：initialize → session/new → session/prompt 依次发出，事件按序 emit', async () => {
  const cli = fakeCli();
  const engine = engineWith(cli);
  const events = [];
  const result = await engine.runTurn({
    command: 'agy', args: ['acp'], cwd: 'C:/proj', prompt: '改一下空状态', emit: event => events.push(event),
  });
  assert.equal(result.ok, true, '正常一轮应当成功');
  assert.deepEqual(cli.seen.slice(0, 3), ['initialize', 'session/new', 'session/prompt']);
  assert.ok(events.some(event => event.type === 'thinking'), '应当发出 thinking 事件');
  assert.ok(events.some(event => event.type === 'text'), '应当发出 text 事件');
  assert.equal(engine.status, 'ready');
  await engine.dispose();
});

test('usage 上报：Gemini 口径（input 含 cached、output 含 thought）', async () => {
  const cli = fakeCli({ usage: { inputTokens: 100, cachedReadTokens: 20, outputTokens: 30, thoughtTokens: 10 } });
  const engine = engineWith(cli);
  const events = [];
  await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: event => events.push(event) });
  const usage = events.find(event => event.type === 'usage');
  assert.ok(usage, '应当发出 usage 事件');
  assert.equal(usage.call.input, 120, 'input 必须包含 cachedReadTokens');
  assert.equal(usage.call.output, 40, 'output 必须包含 thoughtTokens');
  await engine.dispose();
});

test('会话复用：第二轮不再重新 initialize 与 session/new', async () => {
  const cli = fakeCli();
  const engine = engineWith(cli);
  await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: '一', emit: () => {} });
  await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: '二', emit: () => {} });
  assert.equal(cli.seen.filter(method => method === 'initialize').length, 1, 'initialize 只应发生一次');
  assert.equal(cli.seen.filter(method => method === 'session/new').length, 1, 'session/new 只应发生一次');
  assert.equal(cli.seen.filter(method => method === 'session/prompt').length, 2, '两轮各发一次 prompt');
  await engine.dispose();
});

test('反向请求交给闸门，并把参数原样透传', async () => {
  const cli = fakeCli({
    onPrompt: ({ reply }) => {
      reply({
        jsonrpc: '2.0',
        id: 991,
        method: 'fs/read_text_file',
        params: { path: 'C:/proj/src/a.ts' },
      });
    },
  });
  const handled = [];
  const engine = createAcpEngine({
    spawn: () => cli.child,
    gate: {
      handle: async (method, params) => {
        handled.push({ method, params });
        return { content: 'file body' };
      },
    },
    timeoutMs: 2000,
  });
  // 闸门应答后，假 CLI 需要拿到响应才能继续；这里直接把超时当作可接受结果。
  const result = await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {} });
  assert.equal(handled.length >= 1, true, '闸门必须收到反向请求');
  assert.equal(handled[0].method, 'fs/read_text_file');
  assert.equal(handled[0].params.path, 'C:/proj/src/a.ts');
  assert.equal(typeof result.ok, 'boolean');
  await engine.dispose();
});

test('并发 runTurn：第二个直接被拒为 busy', async () => {
  const cli = fakeCli();
  const engine = engineWith(cli);
  const first = engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: '一', emit: () => {} });
  const second = await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: '二', emit: () => {} });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'request');
  assert.equal(second.detail, 'busy');
  await first;
  await engine.dispose();
});

test('中断：发 session/cancel，返回 cancelled，进程仍在', async () => {
  const cli = silentCli('session/prompt');
  const engine = engineWith(cli);
  const controller = new AbortController();
  const running = engine.runTurn({
    command: 'agy', cwd: 'C:/proj', prompt: '长任务', emit: () => {}, signal: controller.signal,
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  controller.abort();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'cancelled');
  assert.ok(cli.seen.includes('session/cancel'), '中断必须发 cancel');
  assert.equal(engine.status, 'ready', '中断不关进程，会话仍可复用');
  await engine.dispose();
});

test('没有 locate 也没有 command：报 cli_missing 而不是抛异常', async () => {
  const engine = createAcpEngine({ spawn: () => fakeCli().child, timeoutMs: 300 });
  const result = await engine.runTurn({ prompt: 'x', emit: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cli_missing');
});

test('locate 找不到 CLI：同样收敛成 cli_missing', async () => {
  const engine = createAcpEngine({ spawn: () => fakeCli().child, timeoutMs: 300, locate: async () => null });
  const result = await engine.runTurn({ prompt: 'x', emit: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cli_missing');
});

test('dispose 之后不再接受新轮次', async () => {
  const cli = fakeCli();
  const engine = engineWith(cli);
  await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: '一', emit: () => {} });
  await engine.dispose();
  const result = await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: '二', emit: () => {} });
  assert.equal(result.ok, false);
  assert.equal(engine.status, 'disposed');
});

test('session/new 没有返回 sessionId：判协议异常', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = {
    stdin, stdout, stderr: new PassThrough(), pid: 1,
    kill() {}, on(event, handler) { if (event === 'exit') child.emitExit = handler; return child; },
    once(event, handler) { return child.on(event, handler); }, removeListener() { return child; },
  };
  let buffer = '';
  stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const result = message.method === 'initialize' ? { protocolVersion: 1 } : {};
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    }
  });
  const engine = createAcpEngine({ spawn: () => child, timeoutMs: 400 });
  const result = await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acp_protocol');
  await engine.dispose();
});
