// IPC 计时补丁的契约：语义不变（返回值透传、异常原样抛）、慢调用告警、参数脱敏、
// 重复 patch 不嵌套。用假 ipcMain + 假时钟，不碰 Electron。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchIpcMain, previewArgs, safeStringify, truncateText } from '../electron/logging/ipc-trace.mjs';

function fakeLogger() {
  const records = [];
  const push = level => (msg, data) => records.push({ level, msg, data });
  return { records, debug: push('debug'), warn: push('warn'), error: push('error'), info: push('info') };
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    handleOnce(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

test('返回值原样透传，快调用只记 debug', async () => {
  const logger = fakeLogger();
  const ipcMain = fakeIpcMain();
  let clock = 0;
  patchIpcMain(ipcMain, logger, { slowMs: 1000, now: () => clock });
  ipcMain.handle('settings:get', async () => {
    clock = 25; // 这次调用花了 25ms，远低于 1000ms 阈值
    return { ok: true };
  });

  clock = 5;
  const value = await ipcMain.handlers.get('settings:get')({ sender: 1 }, { a: 1 });
  assert.deepEqual(value, { ok: true }, 'IPC 的返回值不能被补丁改掉');
  assert.deepEqual(logger.records.map(row => row.msg), ['ipc']);
  assert.equal(logger.records[0].data.channel, 'settings:get');
  assert.equal(logger.records[0].data.durationMs, 20);
});

test('超过阈值记 slow-ipc 警告', async () => {
  const logger = fakeLogger();
  const ipcMain = fakeIpcMain();
  let clock = 0;
  patchIpcMain(ipcMain, logger, { slowMs: 1000, now: () => clock });
  ipcMain.handle('providers:list', async () => {
    clock = 8500; // 模拟主进程里跑了 8.5 秒
    return [];
  });

  await ipcMain.handlers.get('providers:list')({});
  const slow = logger.records.find(row => row.msg === 'slow-ipc');
  assert.ok(slow, '慢调用必须留下一条 warn');
  assert.equal(slow.level, 'warn');
  assert.equal(slow.data.durationMs, 8500);
});

test('抛错时原样抛出同一个 error，并记 error + 脱敏参数预览', async () => {
  const logger = fakeLogger();
  const ipcMain = fakeIpcMain();
  const boom = Object.assign(new Error('upstream 401'), { code: 'auth' });
  patchIpcMain(ipcMain, logger, { slowMs: 1000, now: () => 0 });
  ipcMain.handle('subscription:login', async () => { throw boom; });

  await assert.rejects(
    ipcMain.handlers.get('subscription:login')({}, { provider: 'chatgpt', authorization: 'Bearer secret-token' }),
    error => error === boom,
    '调用方必须拿到同一个 error 实例（靠 code/message 决定提示）',
  );

  const failed = logger.records.find(row => row.msg === 'ipc-error');
  assert.ok(failed);
  assert.equal(failed.data.error.code, 'auth');
  assert.equal(failed.data.error.message, 'upstream 401');
  assert.ok(!failed.data.argsPreview.includes('secret-token'), '令牌不能进日志');
});

test('重复 patch 不会嵌套（每次调用只记一条）', async () => {
  const logger = fakeLogger();
  const ipcMain = fakeIpcMain();
  patchIpcMain(ipcMain, logger, { now: () => 0 });
  patchIpcMain(ipcMain, logger, { now: () => 0 });
  ipcMain.handle('ping', async () => 'pong');

  assert.equal(await ipcMain.handlers.get('ping')({}), 'pong');
  assert.equal(logger.records.length, 1, '同一个通道只该有一条记录');
});

test('restore() 还回原始 handle（身份相等）', () => {
  const ipcMain = fakeIpcMain();
  const before = ipcMain.handle;
  const controller = patchIpcMain(ipcMain, fakeLogger());
  assert.notEqual(ipcMain.handle, before, '打补丁后 handle 应该被替换');
  controller.restore();
  assert.equal(ipcMain.handle, before, 'restore 必须恢复原函数');
});

test('参数预览：循环引用、BigInt、抛错的 getter 都不会让 IPC 失败', () => {
  const circular = { name: 'loop' };
  circular.self = circular;
  assert.equal(safeStringify(circular).includes('[circular]'), true);

  const hostile = {
    get boom() { throw new Error('getter 炸了'); },
  };
  assert.doesNotThrow(() => previewArgs([hostile]));

  assert.equal(truncateText('x'.repeat(300), 200).length, 200);
  assert.equal(truncateText('短文本', 200), '短文本');
});
