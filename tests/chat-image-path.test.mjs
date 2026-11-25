/**
 * 负责：`imageFilePath()` 这条「图片在哪」的契约——路径必须真的指向 saveImage 写入的文件。
 * 不负责：ACP 支路怎么用它（见 tests/chat-acp-prompt.test.mjs 的结构断言与
 *   electron/services/attachment-text.mjs 的 imageLocationBlocks）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么单独钉这一条：ACP（Gemini 订阅）没有 image block 通道，只能把路径交给 CLI 自己读。
 * 路径与实际写入目录一旦不同源，模型就会去读一个不存在的文件，然后如实回答「读不到」——
 * 用户看到的现象仍然是「图片没生效」，和以前静默丢弃一样糟糕，只是更难查。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { configureDefaultChatImages, imageFilePath, saveImage, validId } = require('../electron/chat-images.cjs');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = (name = '截图.png') => ({ name, dataUrl: `data:image/png;base64,${PNG_BASE64}`, size: 70 });

/** 每个用例一个独立目录：默认实例是进程级单例，串目录会让断言变成「碰巧对」。 */
async function instance() {
  const directory = await mkdtemp(join(tmpdir(), 'mova-image-path-'));
  configureDefaultChatImages({ directory, objectStorage: null, logger: null });
  return directory;
}

test('imageFilePath 指向 saveImage 真正写入的那个文件', async () => {
  const directory = await instance();
  const saved = await saveImage(png());
  assert.equal(validId(saved.id), true, '返回的 id 必须是合法 id');

  const target = imageFilePath(saved.id);
  assert.equal(target, join(directory, saved.id), '路径必须就是落盘目录 + id（同源，不另算）');
  assert.equal(existsSync(target), true, '这个路径必须真的有文件——否则模型读到的是「不存在」');
});

test('临时会话的图片不落盘：路径虽然算得出来，但文件不存在（所以 ACP 支路必须不给路径）', async () => {
  await instance();
  const saved = await saveImage(png(), { temporary: true });
  assert.equal(existsSync(imageFilePath(saved.id)), false,
    '临时图片只在内存里：任何「给你个路径」的写法都是骗模型');
});

test('imageFilePath 拒绝非法 id（路径拼接不能成为任意文件读取）', async () => {
  await instance();
  for (const id of ['', '../secret.png', 'a.png', 'ab'.repeat(32) + '.bmp', null, undefined, 42]) {
    assert.throws(() => imageFilePath(id), /image/i, `非法 id 必须抛错：${String(id)}`);
  }
});
