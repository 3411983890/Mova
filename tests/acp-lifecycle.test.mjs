/**
 * agy 进程树收尾：PID 登记、宽限期、taskkill 注入点。
 *
 * 为什么必须锁住：Windows 上 `child.kill()` 只杀父进程，agy 派生的子进程会活着；
 * 残留 agy 会让**下一次** `session/new` 返回空模型列表且不报错——最难排查的一类
 * 「用着用着就没模型了」。这里的断言都落在可观察结果上（注入的 killTree 被调用几次、
 * 登记表是否清空、等待了多久），不碰真实进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createAcpEngine, killProcessTree, listActivePids } from '../electron/acp/engine.mjs';

const PID = 9091;

/**
 * 假 CLI：能应答 initialize / session/new / session/prompt，`onKill` 决定「kill 之后是否真的退出」。
 * `exitCode` / `signalCode` 显式给 null：真实 ChildProcess 一定有这两个字段，
 * engine 的默认存活判断靠它区分「真进程」与「测试假进程」。
 */
function fakeCli({ onKill = () => {}, pid = PID } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let buffer = '';
  const child = {
    stdin,
    stdout,
    stderr,
    pid,
    exitCode: null,
    signalCode: null,
    kill() {
      onKill(child);
    },
    on(...args) {
      emitter.on(...args);
      return child;
    },
    once(...args) {
      emitter.once(...args);
      return child;
    },
    removeListener(...args) {
      emitter.removeListener(...args);
      return child;
    },
    emitExit(code = 0) {
      emitter.emit('exit', code, null);
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
      const result = message.method === 'session/new'
        ? { sessionId: 'sess-1' }
        : message.method === 'initialize' ? { protocolVersion: 1 } : { stopReason: 'end_turn' };
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    }
  });
  return child;
}

test('dispose()：进程在宽限期内没退出就调用注入的 killTree(pid)，收尾后登记表清空', async () => {
  const cli = fakeCli(); // kill() 什么都不做 → 进程一直"活着"
  const killed = [];
  const engine = createAcpEngine({
    spawn: () => cli,
    timeoutMs: 500,
    graceMs: 20,
    killTree: pid => {
      killed.push(pid);
      return { ok: true };
    },
    // 测试里没有真进程：显式声明「还活着」，把等待压到 20ms。
    isAlive: () => true,
  });
  const result = await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {} });
  assert.equal(result.ok, true);
  assert.ok(listActivePids().includes(PID), 'spawn 之后必须登记 pid');

  await engine.dispose();
  assert.deepEqual(killed, [PID], '宽限期后仍存活才强杀整棵树，且只调一次');
  assert.deepEqual(listActivePids(), [], '收尾之后登记表必须清空');
});

test('dispose()：进程自己在宽限期内退出就不强杀，也不白等宽限期', async () => {
  const cli = fakeCli({ onKill: child => child.emitExit(0) });
  const killed = [];
  const engine = createAcpEngine({
    spawn: () => cli,
    timeoutMs: 500,
    // 宽限期故意给大：如果实现是「无脑等 graceMs」，这条断言会立刻暴露。
    graceMs: 2_000,
    killTree: pid => {
      killed.push(pid);
      return { ok: true };
    },
  });
  await engine.runTurn({ command: 'agy', cwd: 'C:/proj', prompt: 'x', emit: () => {} });
  const startedAt = Date.now();
  await engine.dispose();
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(killed, [], '已经退出的进程不需要 taskkill');
  assert.ok(elapsed < 1_000, `退出必须立刻返回，实际等了 ${elapsed}ms`);
  assert.deepEqual(listActivePids(), [], '正常退出也要从登记表移除');
});

test('默认 killTree：Windows 走 taskkill /T /F（windowsHide），非 Windows 不调用', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  };

  const windows = killProcessTree(4321, { platform: 'win32', run });
  assert.equal(windows.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '4321', '/T', '/F'], '/T 是收整棵树的关键');
  assert.equal(calls[0].options.windowsHide, true, '不能给用户弹黑框');

  const linux = killProcessTree(4321, { platform: 'linux', run });
  assert.equal(linux.ok, false);
  assert.equal(linux.detail, 'not-win32');
  assert.equal(calls.length, 1, '非 Windows 绝不调用 taskkill');
});

test('taskkill 失败只返回结果，绝不抛出（退出路径上抛错会盖掉真正原因）', () => {
  const failed = killProcessTree(4321, {
    platform: 'win32',
    run: () => ({ status: 128, stdout: '', stderr: 'ERROR: 没有找到进程 "4321"' }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /没有找到进程/);

  const boom = killProcessTree(4321, {
    platform: 'win32',
    run: () => {
      throw new Error('spawn EPERM');
    },
  });
  assert.equal(boom.ok, false);
  assert.match(boom.detail, /EPERM/);

  assert.equal(killProcessTree(0, { platform: 'win32' }).ok, false, '非法 pid 不执行命令');
});
