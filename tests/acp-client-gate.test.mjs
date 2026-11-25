import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createAcpClient } from '../electron/acp/client.mjs';
import { createGate } from '../electron/acp/gate.mjs';
import { SubscriptionError } from '../electron/subscription/contract.mjs';

const ROOT = path.join(os.tmpdir(), 'mova-acp-root');
const OUTSIDE = path.join(os.tmpdir(), 'mova-acp-outside');

/** 用 PassThrough 造假 stdio：这台机器上不允许测试真起进程。 */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let wire = '';
  stdin.on('data', chunk => { wire += chunk.toString('utf8'); });
  const child = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    killed: false,
    frames() {
      return wire.split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    kill() {
      child.killed = true;
    },
    on(...args) { emitter.on(...args); return child; },
    once(...args) { emitter.once(...args); return child; },
    off(...args) { emitter.off(...args); return child; },
    emit(...args) { return emitter.emit(...args); },
  };
  return child;
}

function makeClient(options = {}) {
  const child = fakeChild();
  const client = createAcpClient({ spawn: () => child, ...options });
  client.start({ command: 'agy', args: ['acp'], cwd: ROOT });
  return { child, client };
}

async function until(predicate, label = '条件', timeout = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail(`等待超时：${label}`);
}

function tick(ms = 10) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── client.mjs：成帧、超时、反向请求、退出清理 ────────────────────────────

test('a JSON line split across two chunks is reassembled into one response', async () => {
  const { child, client } = makeClient({ timeoutMs: 500 });
  try {
    const pending = client.request('session/prompt', { text: 'hi' });
    await until(() => child.frames().length === 1, '请求帧写出');
    const [frame] = child.frames();
    assert.equal(frame.method, 'session/prompt', '请求应带着 method 写到 stdin');
    assert.deepEqual(frame.params, { text: 'hi' }, 'params 必须原样序列化');

    const reply = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } });
    child.stdout.write(reply.slice(0, 11));
    child.stdout.write(reply.slice(11) + '\n');
    assert.deepEqual(await pending, { ok: true }, '半行分帧后仍应正确配对 id');
  } finally {
    client.close();
  }
});

test('two replies arriving in one chunk settle two pending requests', async () => {
  const { child, client } = makeClient({ timeoutMs: 500 });
  try {
    const first = client.request('session/new', {});
    const second = client.request('session/load', {});
    await until(() => child.frames().length === 2, '两个请求帧写出');
    const [one, two] = child.frames();
    assert.notEqual(one.id, two.id, 'id 必须自增且互不相同');
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: one.id, result: 1 })}\n${JSON.stringify({ jsonrpc: '2.0', id: two.id, result: 2 })}\n`,
    );
    assert.equal(await first, 1);
    assert.equal(await second, 2);
  } finally {
    client.close();
  }
});

test('a request rejects with acp_idle_timeout on timeout and leaves the pending table clean', async () => {
  // `session/prompt` 现在走空闲看门狗（默认 10 分钟，见 client.mjs 的 DEFAULT_PROMPT_IDLE_MS），
  // 这里把空闲阈值压到 120ms 来测「超时要干净地失败」，其余断言与旧版一致。
  const { child, client } = makeClient({ timeoutMs: 120, promptIdleMs: 120 });
  try {
    await assert.rejects(client.request('session/prompt', {}), error => {
      assert.ok(error instanceof SubscriptionError, '超时必须抛 SubscriptionError');
      assert.equal(error.code, 'acp_idle_timeout');
      assert.match(error.detail, /session\/prompt/, '超时说明里要带 method');
      assert.match(error.detail, /空闲超时/);
      return true;
    });
    // 超时之后迟到的响应只能被丢弃，不能把读循环炸掉。
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'late' })}\n`);
    await tick(10);
    assert.equal(client.isRunning, true, '迟到的响应不应破坏连接');
    const second = client.request('ping', {});
    await until(() => child.frames().length === 2, '第二个请求写出');
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: child.frames()[1].id, result: 'pong' })}\n`);
    assert.equal(await second, 'pong', '超时后 pending 表必须已清空，新请求照常工作');
  } finally {
    client.close();
  }
});

test('a reverse request is handled and its value is written back as result', async () => {
  const { child, client } = makeClient({ timeoutMs: 500 });
  const seen = [];
  try {
    client.onRequest(async (method, params) => {
      seen.push({ method, params });
      return { content: 'file body', path: params.path };
    });
    child.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 'cli-1', method: 'fs/read_text_file', params: { path: 'notes.md' },
    })}\n`);
    await until(() => child.frames().some(frame => frame.id === 'cli-1'), '反向请求的回包写出');
    const reply = child.frames().find(frame => frame.id === 'cli-1');
    assert.deepEqual(reply.result, { content: 'file body', path: 'notes.md' });
    assert.equal(seen[0].method, 'fs/read_text_file');
  } finally {
    client.close();
  }
});

test('a throwing reverse handler is answered with a JSON-RPC error frame', async () => {
  const { child, client } = makeClient({ timeoutMs: 500 });
  try {
    client.onRequest(() => {
      throw new SubscriptionError('request', { detail: 'fs/write_text_file: 路径越界：/etc/passwd' });
    });
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/write_text_file', params: {} })}\n`);
    await until(() => child.frames().some(frame => frame.id === 7), '错误回包写出');
    const reply = child.frames().find(frame => frame.id === 7);
    assert.equal(reply.error.code, -32603);
    assert.match(reply.error.message, /路径越界/, '错误回包要带上拒因');
    assert.equal(reply.error.data.code, 'request');
    assert.equal(reply.result, undefined);
  } finally {
    client.close();
  }
});

test('a message without id is dispatched as a notification', async () => {
  const { child, client } = makeClient({ timeoutMs: 500 });
  const updates = [];
  try {
    client.onNotification((method, params) => updates.push({ method, params }));
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text: 'hi' } })}\n`);
    await until(() => updates.length === 1, '通知被分发');
    assert.equal(updates[0].method, 'session/update');
    assert.deepEqual(child.frames(), [], '通知不应产生回包');
  } finally {
    client.close();
  }
});

test('four invalid JSON lines are skipped and a valid reply still settles', async () => {
  const { child, client } = makeClient({ timeoutMs: 500 });
  try {
    const pending = client.request('session/prompt', {});
    await until(() => child.frames().length === 1, '请求帧写出');
    const { id } = child.frames()[0];
    child.stdout.write('not json\n{\nhello world\n<xml/>\n');
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { done: true } })}\n`);
    assert.deepEqual(await pending, { done: true }, '单行噪声不能判协议异常');
    assert.equal(client.isRunning, true);
  } finally {
    client.close();
  }
});

test('five consecutive invalid JSON lines fail pending requests with acp_protocol', async () => {
  const { child, client } = makeClient({ timeoutMs: 5000 });
  try {
    const pending = client.request('session/prompt', {});
    await until(() => child.frames().length === 1, '请求帧写出');
    child.stdout.write('a\nb\nc\nd\ne\n');
    await assert.rejects(pending, error => {
      assert.ok(error instanceof SubscriptionError);
      assert.equal(error.code, 'acp_protocol');
      assert.match(error.detail, /连续 5 行/);
      return true;
    });
    assert.equal(client.isRunning, false, '协议异常后连接必须停下');
    assert.equal(child.killed, true, '应尽力收掉坏掉的进程');
  } finally {
    client.close();
  }
});

test('process exit rejects every pending request and flips isRunning', async () => {
  const { child, client } = makeClient({ timeoutMs: 5000 });
  const first = client.request('session/prompt', {});
  const second = client.request('session/prompt', {});
  await until(() => child.frames().length === 2, '两个请求写出');
  child.stderr.write('fatal: acp handshake failed\n');
  await tick();
  child.emit('exit', 1, null);
  for (const pending of [first, second]) {
    await assert.rejects(pending, error => {
      assert.equal(error.code, 'acp_protocol');
      assert.match(error.detail, /ACP 进程已退出/);
      assert.match(error.detail, /handshake failed/, '退出说明应带上 stderr 尾行');
      return true;
    });
  }
  assert.equal(client.isRunning, false);
  assert.equal(client.pid, null);
  assert.throws(() => client.notify('session/cancel', {}), error => error instanceof SubscriptionError && error.code === 'acp_protocol');
});

test('close() rejects pending requests and ends the child', async () => {
  const { child, client } = makeClient({ timeoutMs: 5000 });
  const pending = client.request('session/prompt', {});
  await until(() => child.frames().length === 1, '请求写出');
  client.close();
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'acp_protocol');
    assert.match(error.detail, /连接已关闭/);
    return true;
  });
  assert.equal(client.isRunning, false);
  assert.equal(child.killed, true);
});

// ── gate.mjs：路径、审批、审计、权限透传 ─────────────────────────────────

function fakeRealpath(links) {
  return async target => {
    const key = path.resolve(target);
    if (Object.prototype.hasOwnProperty.call(links, key)) return links[key];
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  };
}

function makeGate(options = {}) {
  const files = options.files ?? {};
  const fs = {
    files,
    calls: [],
    async readFile(target) {
      fs.calls.push(['read', target]);
      if (!Object.prototype.hasOwnProperty.call(files, target)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files[target];
    },
    async writeFile(target, data) {
      fs.calls.push(['write', target, data]);
      files[target] = data;
    },
  };
  const audit = { entries: [], record(entry) { audit.entries.push(entry); } };
  const approvals = {
    calls: [],
    decide: options.decide ?? 'once',
    async ask(request) {
      approvals.calls.push(request);
      return typeof approvals.decide === 'function' ? approvals.decide(request) : approvals.decide;
    },
  };
  const gate = createGate({
    projectRoots: options.roots ?? [ROOT],
    preset: options.preset ?? 'default',
    permissions: options.permissions,
    fs,
    audit,
    approvals,
    elicitation: options.elicitation,
    realpath: fakeRealpath(options.links ?? { [ROOT]: ROOT }),
    now: () => 1_700_000_000_000,
    spawnProcess: options.spawnProcess,
  });
  return { gate, fs, audit, approvals };
}

test('fs/read_text_file refuses a ../ path that escapes the project root', async () => {
  const { gate, fs } = makeGate({ files: { [path.join(ROOT, 'ok.txt')]: 'ok' } });
  await assert.rejects(gate.handle('fs/read_text_file', { path: '../secret.txt' }), error => {
    assert.ok(error instanceof SubscriptionError, '越界必须抛 SubscriptionError');
    assert.equal(error.code, 'request');
    assert.match(error.detail, /fs\/read_text_file/, '错误里要带 method 名');
    assert.match(error.detail, /路径越界/);
    return true;
  });
  assert.deepEqual(fs.calls, [], '越界路径不得触碰文件系统');
});

test('fs/read_text_file refuses an absolute path outside the project roots', async () => {
  const { gate } = makeGate({});
  await assert.rejects(gate.handle('fs/read_text_file', { path: path.join(OUTSIDE, 'x.txt') }), error => {
    assert.equal(error.code, 'request');
    assert.match(error.detail, /fs\/read_text_file/);
    assert.match(error.detail, /路径越界/);
    return true;
  });
});

test('fs/read_text_file refuses a symlink that points outside the project root', async () => {
  const link = path.join(ROOT, 'link.txt');
  const target = path.join(OUTSIDE, 'secret.txt');
  const { gate } = makeGate({
    files: { [target]: 'secret' },
    links: { [ROOT]: ROOT, [link]: target },
  });
  await assert.rejects(gate.handle('fs/read_text_file', { path: link }), error => {
    assert.equal(error.code, 'request');
    assert.match(error.detail, /fs\/read_text_file/);
    assert.match(error.detail, /符号链接/);
    return true;
  });
});

test('write in full preset skips approval but still records an audit entry', async () => {
  const target = path.join(ROOT, 'notes.md');
  const { gate, fs, audit, approvals } = makeGate({ preset: 'full' });
  const result = await gate.handle('fs/write_text_file', { path: target, content: 'hello\nworld' });
  assert.equal(result, null);
  assert.equal(approvals.calls.length, 0, 'full 档不应弹审批');
  assert.equal(fs.files[target], 'hello\nworld');
  assert.equal(audit.entries.length, 1, 'full 档仍必须留审计');
  assert.deepEqual(
    { action: audit.entries[0].action, decision: audit.entries[0].decision, bytes: audit.entries[0].bytes },
    { action: 'fs/write_text_file', decision: 'auto', bytes: 11 },
  );
});

test('write denied by approval in default preset throws and never touches disk', async () => {
  const target = path.join(ROOT, 'notes.md');
  const { gate, fs, audit, approvals } = makeGate({ preset: 'default', decide: 'deny' });
  await assert.rejects(gate.handle('fs/write_text_file', { path: target, content: 'x' }), error => {
    assert.equal(error.code, 'request');
    assert.match(error.detail, /fs\/write_text_file/, '错误里要带 method 名');
    assert.match(error.detail, /被拒绝/);
    return true;
  });
  assert.equal(approvals.calls.length, 1, 'default 档必须先问审批');
  assert.equal(approvals.calls[0].capability, 'write');
  assert.equal(approvals.calls[0].path, target);
  assert.match(String(approvals.calls[0].diff), /\+x/, '审批卡要能预览改动');
  assert.equal(fs.files[target], undefined, '被拒后不得落盘');
  assert.equal(audit.entries.at(-1).decision, 'denied');
});

test('session/request_permission passes the chosen optionId through', async () => {
  const options = [
    { optionId: 'allow-once', kind: 'allow_once', name: '允许一次' },
    { optionId: 'reject-once', kind: 'reject_once', name: '拒绝' },
  ];
  const chosen = makeGate({ decide: { optionId: 'allow-once' } });
  const result = await chosen.gate.handle('session/request_permission', {
    sessionId: 's1', toolCall: { toolCallId: 't1', title: '写入 a.txt' }, options,
  });
  assert.deepEqual(result, { outcome: { outcome: 'selected', optionId: 'allow-once' } }, 'optionId 必须原样透传');
  assert.equal(chosen.approvals.calls[0].capability, 'permission');

  const byKind = makeGate({ decide: 'once' });
  assert.deepEqual(
    await byKind.gate.handle('session/request_permission', { options }),
    { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    'once 应落到第一个 allow 类选项上',
  );

  const refused = makeGate({ decide: 'deny' });
  assert.deepEqual(
    await refused.gate.handle('session/request_permission', { options }),
    { outcome: { outcome: 'cancelled' } },
  );
});

test('a denied capability raises an explicit error instead of an empty result', async () => {
  const denied = makeGate({
    permissions: { check: () => ({ ok: false, reason: 'not-granted' }) },
    files: { [path.join(ROOT, 'a.txt')]: 'body' },
  });
  await assert.rejects(denied.gate.handle('fs/read_text_file', { path: 'a.txt' }), error => {
    assert.equal(error.code, 'request');
    assert.match(error.detail, /fs\/read_text_file/);
    assert.match(error.detail, /能力未授权：read/);
    return true;
  });
  const allowed = makeGate({
    permissions: { check: () => ({ ok: true }) },
    files: { [path.join(ROOT, 'a.txt')]: 'body' },
  });
  assert.deepEqual(await allowed.gate.handle('fs/read_text_file', { path: 'a.txt' }), { content: 'body' });
});

test('terminal/create asks for exec approval and terminal/output truncates at 8KB', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const { gate, approvals, audit } = makeGate({ spawnProcess: () => child, decide: 'once' });
  const created = await gate.handle('terminal/create', { command: 'node', args: ['-v'], cwd: ROOT });
  assert.equal(typeof created.terminalId, 'string');
  assert.equal(approvals.calls[0].capability, 'exec', '非 full 档必须先问 exec 审批');
  assert.match(String(approvals.calls[0].command), /node -v/);

  child.stdout.write('x'.repeat(20_000));
  await until(() => audit.entries.some(entry => entry.action === 'terminal/create'), '审计写入');
  const output = await gate.handle('terminal/output', { terminalId: created.terminalId });
  assert.equal(output.truncated, true);
  assert.ok(output.output.length <= 8 * 1024, '单次输出必须截到 8KB 以内');
  assert.ok(output.output.startsWith('xxx'), '保留头部上下文');

  child.emit('exit', 0, null);
  assert.deepEqual(await gate.handle('terminal/wait_for_exit', { terminalId: created.terminalId }), { exitCode: 0, signal: null });
  assert.equal(await gate.handle('terminal/release', { terminalId: created.terminalId }), null);
  await assert.rejects(gate.handle('terminal/output', { terminalId: created.terminalId }), error => {
    assert.equal(error.code, 'request');
    assert.match(error.detail, /未知的 terminalId/);
    return true;
  });
});
