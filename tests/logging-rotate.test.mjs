/**
 * 轮转与清理的测试。
 *
 * 判定逻辑（要不要换文件、留几个）是纯函数，直接喂数据断言；
 * 只有「真的写到磁盘」这一层才用临时目录，并且用很小的 maxBytes 触发轮转，
 * 不真写 8MB——测试要快，而且 8MB 大小本身不是被测对象。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createLogger } from '../electron/logging/logger.mjs';
import {
  DEFAULT_MAX_BYTES,
  LATEST_FILE_NAME,
  createFileSink,
  isLogFileName,
  logFileName,
  partFileName,
  pickRetention,
  pruneLogs,
  shouldRotate,
  stampFor,
} from '../electron/logging/rotate.mjs';

const tempDirs = [];

async function makeDir(prefix = 'mova-rotate-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

test('文件名是 mova-YYYYMMDD-HHMMSS-<pid>.log（本地时间）', () => {
  const name = logFileName({ date: new Date(2026, 0, 2, 3, 4, 5), pid: 4242 });
  assert.equal(name, 'mova-20260102-030405-4242.log');
  assert.equal(stampFor(new Date(2026, 10, 13, 22, 19, 3)), '20261113-221903');
  assert.equal(isLogFileName(name), true);
  assert.equal(isLogFileName('latest.txt'), false);
  assert.equal(isLogFileName('other.log'), false);
});

test('分段后缀是 -2、-3，且仍然算本系统的日志文件', () => {
  const base = 'mova-20260102-030405-4242.log';
  assert.equal(partFileName(base, 1), base);
  assert.equal(partFileName(base, 2), 'mova-20260102-030405-4242-2.log');
  assert.equal(partFileName(base, 3), 'mova-20260102-030405-4242-3.log');
  assert.equal(isLogFileName(partFileName(base, 2)), true);
});

test('轮转判定：到 8MB 就换，边界与异常输入都不会误判', () => {
  assert.equal(shouldRotate(DEFAULT_MAX_BYTES), true);
  assert.equal(shouldRotate(DEFAULT_MAX_BYTES - 1), false);
  assert.equal(shouldRotate(0), false);
  assert.equal(shouldRotate(Number.NaN), false);
  assert.equal(shouldRotate(500, 0), false);
  assert.equal(shouldRotate(500, 100), true);
});

test('清理判定：只留最近 20 个', () => {
  const nowMs = Date.parse('2026-01-02T00:00:00Z');
  const files = Array.from({ length: 22 }, (_, index) => ({
    // 5 小时内的文件，不受 14 天规则影响
    name: `mova-20260102-0${String(index).padStart(5, '0')}-${index}.log`,
    mtimeMs: nowMs - index * 60 * 1000,
  }));
  const { keep, remove } = pickRetention(files, { maxFiles: 20, maxAgeDays: 14, nowMs });
  assert.equal(keep.length, 20);
  assert.equal(remove.length, 2);
  assert.deepEqual(remove.sort(), [files[20].name, files[21].name].sort());
});

test('清理判定：14 天前的文件即使总数很少也删', () => {
  const nowMs = Date.parse('2026-01-20T00:00:00Z');
  const fresh = { name: 'mova-20260120-000000-1.log', mtimeMs: nowMs - DAY_MS };
  const old = { name: 'mova-20260101-000000-2.log', mtimeMs: nowMs - 20 * DAY_MS };
  const { keep, remove } = pickRetention([fresh, old], { maxFiles: 20, maxAgeDays: 14, nowMs });
  assert.deepEqual(keep, [fresh.name]);
  assert.deepEqual(remove, [old.name]);
});

test('真实落盘：latest.txt 只有最新文件名，内容按 JSONL 追加', async () => {
  const dir = await makeDir();
  const sink = createFileSink({ dir });
  assert.equal(sink.latestFileName(), sink.currentFile().split('\\').pop() ?? sink.latestFileName());
  const log = createLogger({ scope: 'app', sink });
  log.info('one');
  log.info('two');
  assert.equal(await log.flush(2000), true);

  const latestText = await readFile(join(dir, LATEST_FILE_NAME), 'utf8');
  assert.equal(latestText.trim(), sink.latestFileName(), 'latest.txt 内容必须只有文件名');
  assert.equal(latestText.trim().split('\n').length, 1);

  const lines = (await readFile(sink.currentFile(), 'utf8')).split('\n').filter(Boolean);
  assert.deepEqual(lines.map(line => JSON.parse(line).msg), ['one', 'two']);
  assert.equal(sink.latestFile(), sink.currentFile());
  await sink.close();
});

test('真实落盘：超过上限换到 -2 分段，记录不重不漏', async () => {
  const dir = await makeDir();
  // 每条约 130 字节，上限设 100：每条都会把当前分段撑爆，于是必须换文件。
  const sink = createFileSink({ dir, maxBytes: 100 });
  const log = createLogger({ scope: 'x', sink });
  for (let index = 0; index < 4; index += 1) {
    log.info(`m${index}`, { pad: 'p'.repeat(40) });
    await log.flush(2000);
  }
  assert.equal(await log.flush(2000), true);

  const names = (await readdir(dir)).filter(name => isLogFileName(name));
  assert.ok(names.length >= 2, `应该产生分段，实际只有 ${names.join(',')}`);
  const texts = new Map();
  for (const name of names) texts.set(name, await readFile(join(dir, name), 'utf8'));

  const all = [...texts.values()].join('');
  for (let index = 0; index < 4; index += 1) {
    assert.equal(all.match(new RegExp(`"m${index}"`, 'g')).length, 1, `m${index} 应该正好出现一次`);
  }
  const firstOwner = [...texts.entries()].find(([, text]) => text.includes('"m0"'));
  const lastOwner = [...texts.entries()].find(([, text]) => text.includes('"m3"'));
  assert.notEqual(firstOwner[0], lastOwner[0], 'm0 和 m3 不该在同一个分段里');
  assert.equal(sink.stats().part >= 2, true);
  await sink.close();
});

test('真实落盘：启动时清理到 20 个文件以内', async () => {
  const dir = await makeDir();
  const now = Date.now();
  // 25 个「昨天的」日志，按时间从新到旧。
  for (let index = 0; index < 25; index += 1) {
    const name = `mova-20260101-${String(index).padStart(6, '0')}-${index}.log`;
    const path = join(dir, name);
    await writeFile(path, '{}\n', 'utf8');
    const stamp = new Date(now - (index + 1) * 3600 * 1000);
    await utimes(path, stamp, stamp);
  }
  const sink = createFileSink({ dir });
  const report = await sink.ready;
  // 25 个候选（新日志文件要等第一次写入才存在）→ 只留 20 个，删掉最老的 5 个。
  assert.equal(report.removed.length, 5, `应该清掉最老的 5 个，实际清了 ${report.removed.length}`);
  assert.ok(report.removed.includes('mova-20260101-000024-24.log'), '最旧的必须被删');
  assert.ok(!report.removed.includes('mova-20260101-000000-0.log'), '最新的必须保留');

  const remaining = (await readdir(dir)).filter(name => isLogFileName(name));
  assert.ok(remaining.length <= 20, `清理后最多 20 个，实际 ${remaining.length}`);
  await sink.close();
});

test('pruneLogs：目录不存在时返回报告而不是抛异常', async () => {
  const dir = join(await makeDir(), 'missing-subdir');
  const report = await pruneLogs({ dir });
  assert.deepEqual(report.removed, []);
  assert.ok(report.errors.length >= 1);
});

test('pruneLogs：正在写的文件即使被判过旧也不会被删', async () => {
  const dir = await makeDir();
  const name = 'mova-20200101-000000-1.log';
  const path = join(dir, name);
  await writeFile(path, '{}\n', 'utf8');
  const old = new Date(Date.now() - 30 * DAY_MS);
  await utimes(path, old, old);

  const report = await pruneLogs({ dir, protect: [name] });
  assert.deepEqual(report.removed, []);
  assert.ok((await stat(path)).isFile());
});
