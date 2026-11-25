/**
 * logger 的单元测试：记录形状、级别过滤、JSONL 落盘、span 两条路径。
 *
 * 全部用注入的 sink / now，测试不依赖真实时间，也不碰 Electron。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  createLogger,
  createNoopLogger,
  formatLocalIso,
  normalizeLevel,
  resolveLevel,
  shouldWrite,
} from '../electron/logging/logger.mjs';
import { createFileSink } from '../electron/logging/rotate.mjs';

const tempDirs = [];

async function makeDir(prefix = 'mova-logger-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 收集记录的内存 sink。 */
function collectSink() {
  const records = [];
  let flushed = 0;
  return {
    records,
    get flushed() {
      return flushed;
    },
    write(record) {
      records.push(record);
    },
    async flush() {
      flushed += 1;
      return true;
    },
  };
}

test('记录形状固定为 t/level/scope/msg + data，且 data 已脱敏', () => {
  const sink = collectSink();
  const log = createLogger({ scope: 'subscription', sink, now: () => Date.parse('2026-01-02T03:04:05.678Z') });
  log.info('probe-usage', { k: 1, durationMs: 1234, access_token: 'secret-value' });

  assert.equal(sink.records.length, 1);
  const record = sink.records[0];
  assert.equal(record.level, 'info');
  assert.equal(record.scope, 'subscription');
  assert.equal(record.msg, 'probe-usage');
  assert.equal(record.k, 1);
  assert.equal(record.durationMs, 1234);
  assert.match(record.access_token, /^\[redacted:\d+\]$/);
  assert.ok(!Number.isNaN(Date.parse(record.t)), 't 必须能被 Date.parse');
  assert.match(record.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
});

test('级别过滤：低于阈值的不写，warn 及以上无论阈值都写', () => {
  const sink = collectSink();
  const log = createLogger({ scope: 'x', sink, level: 'warn' });
  log.debug('dropped');
  log.info('dropped');
  log.warn('kept');
  log.error('kept');
  assert.deepEqual(sink.records.map(record => record.msg), ['kept', 'kept']);

  const fatalOnly = collectSink();
  const quiet = createLogger({ scope: 'x', sink: fatalOnly, level: 'fatal' });
  quiet.info('dropped');
  quiet.warn('kept-warn');
  quiet.fatal('kept-fatal');
  assert.deepEqual(fatalOnly.records.map(record => record.msg), ['kept-warn', 'kept-fatal']);
});

test('级别工具函数：normalizeLevel / resolveLevel / shouldWrite', () => {
  assert.equal(normalizeLevel('DEBUG'), 'debug');
  assert.equal(normalizeLevel('nope'), 'info');
  assert.equal(normalizeLevel(undefined), 'info');
  assert.equal(resolveLevel({}), 'info');
  assert.equal(resolveLevel({ MOVA_LOG_LEVEL: ' trace ' }), 'trace');
  assert.equal(resolveLevel({ MOVA_LOG_LEVEL: 'weird' }), 'info');

  assert.equal(shouldWrite('debug', 'debug'), true);
  assert.equal(shouldWrite('trace', 'debug'), false);
  assert.equal(shouldWrite('warn', 'fatal'), true);
  assert.equal(shouldWrite('error', 'fatal'), true, 'warn 及以上永远写');
  assert.equal(shouldWrite('info', 'fatal'), false);
  assert.equal(shouldWrite('fatal', 'info'), true);
});

test('child 拼出 subscription:login，withScope 替换整段', () => {
  const sink = collectSink();
  const parent = createLogger({ scope: 'subscription', sink });
  parent.child('login').info('a');
  parent.withScope('renderer').info('b');
  assert.deepEqual(sink.records.map(record => record.scope), ['subscription:login', 'renderer']);
  // 子 logger 与父 logger 共享级别：改父的级别，子立刻跟着变。
  parent.level = 'error';
  parent.child('x').info('dropped');
  parent.child('x').error('kept');
  assert.deepEqual(sink.records.map(record => record.msg), ['a', 'b', 'kept']);
});

test('span 成功：记 info + durationMs，并返回原值', async () => {
  const sink = collectSink();
  let clock = 1000;
  const log = createLogger({ scope: 'x', sink, now: () => clock });
  const value = await log.span('probe-usage', async () => {
    clock = 2500;
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.equal(sink.records.length, 1);
  assert.equal(sink.records[0].level, 'info');
  assert.equal(sink.records[0].msg, 'probe-usage');
  assert.equal(sink.records[0].durationMs, 1500);
  assert.equal(sink.records[0].ok, true);
});

test('span 失败：记 error（含 durationMs 与 error），并把原异常原样抛出', async () => {
  const sink = collectSink();
  let clock = 0;
  const log = createLogger({ scope: 'x', sink, now: () => clock });
  const boom = Object.assign(new Error('probe failed with sk-abcdefghijklmnop'), { code: 'E_PROBE' });

  await assert.rejects(
    () => log.span('probe-usage', async () => {
      clock = 700;
      throw boom;
    }),
    error => error === boom,
  );

  assert.equal(sink.records.length, 1);
  const record = sink.records[0];
  assert.equal(record.level, 'error');
  assert.equal(record.msg, 'probe-usage');
  assert.equal(record.durationMs, 700);
  assert.equal(record.ok, false);
  assert.equal(record.error.name, 'Error');
  assert.equal(record.error.code, 'E_PROBE');
  assert.ok(!record.error.message.includes('sk-abcdef'), '异常 message 也要脱敏');
});

test('markPhase / getPhase 与 debug 记录', () => {
  const sink = collectSink();
  const log = createLogger({ scope: 'x', sink, level: 'debug' });
  assert.equal(log.getPhase(), null);
  log.markPhase('subscription:list');
  assert.equal(log.getPhase(), 'subscription:list');
  log.child('deep').markPhase('  subscription:probe  ');
  assert.equal(log.getPhase(), 'subscription:probe', 'phase 在整棵 logger 树上共享');
  assert.deepEqual(
    sink.records.filter(record => record.msg === 'phase').map(record => record.phase),
    ['subscription:list', 'subscription:probe'],
  );
  log.markPhase('');
  assert.equal(log.getPhase(), null);
});

test('flush 转发给 sink 并吞掉 sink 的异常', async () => {
  const sink = collectSink();
  const log = createLogger({ scope: 'x', sink });
  assert.equal(await log.flush(50), true);
  assert.equal(sink.flushed, 1);

  const broken = { write() {}, async flush() { throw new Error('disk gone'); } };
  const brokenLog = createLogger({ scope: 'x', sink: broken });
  assert.equal(await brokenLog.flush(10), false);
});

test('sink 写失败不会冒泡到调用方', () => {
  const log = createLogger({
    scope: 'x',
    sink: {
      write() {
        throw new Error('append failed');
      },
    },
  });
  assert.doesNotThrow(() => log.info('safe'));
  assert.equal(log.state().dropped, 1);
});

test('data 里的 level/scope/msg 不能覆盖核心字段', () => {
  const sink = collectSink();
  const log = createLogger({ scope: 'real', sink });
  log.info('real-msg', { level: 'fatal', scope: 'fake', msg: 'fake', extra: 1 });
  const record = sink.records[0];
  assert.equal(record.level, 'info');
  assert.equal(record.scope, 'real');
  assert.equal(record.msg, 'real-msg');
  assert.equal(record.extra, 1);
});

test('Error 直接当 data 传也能记成结构化字段', () => {
  const sink = collectSink();
  const log = createLogger({ scope: 'x', sink });
  log.error('boom', Object.assign(new Error('nope'), { code: 'E_NOPE' }));
  assert.equal(sink.records[0].error.message, 'nope');
  assert.equal(sink.records[0].error.code, 'E_NOPE');
});

test('JSONL 文件：一行一条、每行都能解析、t 可被 Date.parse', async () => {
  const dir = await makeDir();
  const sink = createFileSink({ dir });
  const log = createLogger({ scope: 'app', sink });
  log.info('first', { k: 1 });
  log.warn('second\nwith newline', { note: 'a "quoted" value' });
  log.error('third', { durationMs: 12 });
  assert.equal(await log.flush(2000), true);

  const text = await readFile(sink.currentFile(), 'utf8');
  const lines = text.split('\n').filter(line => line.length > 0);
  assert.equal(lines.length, 3, '三条记录必须正好三行（多行 msg 已被 JSON 转义）');
  const records = lines.map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.msg), ['first', 'second\nwith newline', 'third']);
  for (const record of records) {
    assert.ok(!Number.isNaN(Date.parse(record.t)), `t 不合法：${record.t}`);
  }
  assert.equal(records[0].k, 1);
  assert.equal(records[2].durationMs, 12);
  await sink.close();
});

test('本地 ISO 串带偏移且长度稳定（含毫秒补零）', () => {
  const stamp = formatLocalIso(new Date(2026, 0, 2, 3, 4, 5, 7));
  assert.equal(stamp, `${stamp.slice(0, 23)}${stamp.slice(23)}`);
  assert.match(stamp, /^2026-01-02T03:04:05\.007[+-]\d{2}:\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(stamp)));
});

test('空实现：不写日志，但 span 仍然执行 fn 并原样传递结果/异常', async () => {
  const noop = createNoopLogger('app');
  assert.equal(noop.info('x'), false);
  assert.equal(noop.child('a').scope, 'app:a');
  assert.equal(await noop.span('x', async () => 42), 42);
  await assert.rejects(
    () => noop.span('x', async () => {
      throw new Error('nope');
    }),
    /nope/,
  );
});

test('函数形式的 sink 也能用', () => {
  const seen = [];
  const log = createLogger({ scope: 'x', sink: record => seen.push(record) });
  log.info('hi');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].msg, 'hi');
});
