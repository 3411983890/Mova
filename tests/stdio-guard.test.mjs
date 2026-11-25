/**
 * 负责：锁住 electron/stdio-guard.cjs —— 管道断掉时写 stdout/stderr 不能变成 uncaughtException。
 * 不负责：真实 Electron 主进程行为（这里是假的事件发射器 + 假 process）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么值得单测：这层守卫的全部作用就是「别让一个异步流事件变成崩溃弹窗」，
 * 而它一旦写错（没挂监听、挂了但 throw、或者吞掉真实错误）都不会在手工测试里暴露。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installStdioGuards, isBrokenPipe } = require('../electron/stdio-guard.cjs');

function fakeProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  stdout.write = () => true;
  stderr.write = () => true;
  return { stdout, stderr };
}

function epipe(message = 'write EPIPE') {
  const error = new Error(message);
  error.code = 'EPIPE';
  return error;
}

test('isBrokenPipe 认得 EPIPE 类错误，不认得真实故障', () => {
  assert.equal(isBrokenPipe(epipe()), true);
  assert.equal(isBrokenPipe(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' })), true);
  assert.equal(isBrokenPipe(Object.assign(new Error('x'), { code: 'ERR_STREAM_WRITE_AFTER_END' })), true);
  // Electron 有时不给 code，只给 message。
  assert.equal(isBrokenPipe(Object.assign(new Error('write EPIPE'), { code: undefined })), true);
  assert.equal(isBrokenPipe(Object.assign(new Error('Cannot call write after a stream was destroyed'), { code: '' })), true);
  // 真实故障不能被当成管道断掉。
  assert.equal(isBrokenPipe(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })), false);
  assert.equal(isBrokenPipe(null), false);
  assert.equal(isBrokenPipe(undefined), false);
});

test('挂上守卫之后，emit(EPIPE) 不再抛成 uncaughtException', () => {
  const proc = fakeProcess();
  // 没有监听器时，EventEmitter 的 'error' 事件会同步抛出——这正是 Node 把它升级成
  // uncaughtException 的机制。
  assert.throws(() => proc.stderr.emit('error', epipe()), /EPIPE/);

  const result = installStdioGuards({ process: proc });
  assert.deepEqual(result.installed.sort(), ['stderr', 'stdout']);
  // 有监听器后必须安静通过。
  assert.doesNotThrow(() => proc.stderr.emit('error', epipe()));
  assert.doesNotThrow(() => proc.stdout.emit('error', epipe()));
  // 真实故障也不许炸；它只被记一次。
  const dropped = [];
  installStdioGuards({ process: proc, onDrop: (error, stream) => dropped.push([stream, error.code]) });
  assert.doesNotThrow(() => proc.stdout.emit('error', Object.assign(new Error('disk'), { code: 'ENOSPC' })));
  assert.deepEqual(dropped, []);
});

test('重复安装是幂等的，onDrop 只报一次', () => {
  const proc = fakeProcess();
  const dropped = [];
  const first = installStdioGuards({ process: proc, onDrop: (error, stream) => dropped.push([stream, error.code]) });
  const second = installStdioGuards({ process: proc, onDrop: () => dropped.push(['again', 'x']) });
  assert.deepEqual(first.installed.sort(), ['stderr', 'stdout']);
  assert.deepEqual(second.installed, []);
  assert.deepEqual(second.skipped.sort(), ['stderr', 'stdout']);

  proc.stderr.emit('error', epipe());
  proc.stdout.emit('error', epipe());
  assert.deepEqual(dropped, [['stderr', 'EPIPE']], 'onDrop 只该被调用一次');
});

test('缺失的流只被跳过，不报错', () => {
  const proc = { stdout: null };
  const result = installStdioGuards({ process: proc });
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped, ['stdout', 'stderr']);
});
