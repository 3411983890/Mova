/**
 * 负责：临时会话图片副本（系统临时目录）的三个契约——写进去的字节就是原图、路径可读、dispose 之后一定不残留。
 * 不负责：什么时候该用它（chat-agent 的 ACP 支路按 request.temporary 决定）、图片校验（chat-images.cjs）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么值得单独钉：这是**唯一会为了「让模型看见图」而把临时会话的图片落盘**的地方。
 * 一旦 dispose 失效或目录名不可预测地重名，隐私约定就变成了「临时会话的图片留在磁盘上」。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { openImageStaging } from '../electron/services/attachment-temp.mjs';

const require = createRequire(import.meta.url);

const ID = `${'a1'.repeat(32)}.png`;
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test('add：文件名就是 id，写进去的字节与原图一致，返回的路径可直接读', async () => {
  const staging = await openImageStaging();
  try {
    const target = await staging.add(ID, BYTES);
    assert.equal(target, join(staging.directory, ID), '路径必须是暂存目录 + id（幂等可预测）');
    assert.deepEqual(new Uint8Array(await readFile(target)), BYTES, '写入的必须是原始字节，不能被编码破坏');
    assert.match(staging.directory, /mova-acp-images-/, '目录名前缀要能一眼认出是 Mova 的临时副本');
  } finally {
    await staging.dispose();
  }
});

test('dispose：整目录消失，且可重复调用不抛错（它总在 finally 里跑）', async () => {
  const staging = await openImageStaging();
  await staging.add(ID, BYTES);
  assert.equal(existsSync(staging.directory), true);

  await staging.dispose();
  assert.equal(existsSync(staging.directory), false, 'dispose 之后目录必须不存在');

  await staging.dispose();
  await staging.dispose(); // 再来两次也不能抛：否则 finally 会盖掉真正的错误
});

test('add 的入口护栏：非法 id / 空字节 / 已 dispose 都抛错，绝不静默写坏文件', async () => {
  const staging = await openImageStaging();
  try {
    await assert.rejects(() => staging.add('../../evil.png', BYTES), /invalid image id/);
    await assert.rejects(() => staging.add('a1.png', BYTES), /invalid image id/);
    await assert.rejects(() => staging.add(ID, new Uint8Array()), /empty image bytes/);
    await assert.rejects(() => staging.add(ID, 'not-bytes'), /empty image bytes/);
  } finally {
    await staging.dispose();
  }
  await assert.rejects(() => staging.add(ID, BYTES), /already disposed/);
});

test('重复写同一个 id 会失败而不是覆盖（同一轮里图片按内容哈希命名）', async () => {
  const staging = await openImageStaging();
  try {
    await staging.add(ID, BYTES);
    await assert.rejects(() => staging.add(ID, BYTES), /EEXIST/);
  } finally {
    await staging.dispose();
  }
});

test('可以指定目录（测试/排查用），仍然只清扫这个目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mova-staging-given-'));
  const staging = await openImageStaging({ directory });
  assert.equal(staging.directory, directory);
  await staging.add(ID, BYTES);
  await staging.dispose();
  assert.equal(existsSync(directory), false);
});

test('真实链路：临时会话的图片（只在内存）→ 暂存副本可读 → dispose 后消失', async () => {
  const chatImages = require('../electron/chat-images.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'mova-temp-handoff-'));
  chatImages.configureDefaultChatImages({ directory, objectStorage: null, logger: null });

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const saved = await chatImages.saveImage(
    { name: '截图.png', dataUrl: `data:image/png;base64,${png}`, size: 70 },
    { temporary: true },
  );
  // 临时图片不落用户数据目录——所以 CLI 直接读不到它，必须靠暂存副本。
  assert.equal(existsSync(join(directory, saved.id)), false, '临时会话的图片不该写进用户数据目录');

  const staging = await openImageStaging();
  try {
    const file = await chatImages.readImage(saved.id);
    const target = await staging.add(saved.id, file.bytes);
    const bytes = await readFile(target);
    assert.deepEqual(new Uint8Array(bytes), new Uint8Array(file.bytes), '暂存副本必须与内存里的原图一致');
    assert.equal(file.mimeType, 'image/png');
  } finally {
    await staging.dispose();
  }
  assert.equal(existsSync(staging.directory), false, '这一轮结束后副本必须不留痕');
});
