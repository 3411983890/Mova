/**
 * 负责：把请求里的附件变成模型能读的东西这段纯逻辑——文本块的文件头、截断说明、二进制文件的如实说明，
 *   以及图片的「交接说明」（路径 / 临时会话 / 落盘失败三种）。
 * 不负责：图片落盘与取路径（chat-images.cjs）、image block 编码（pi-ai 链路）、编码与读取文件（渲染层 composer）。
 * 被谁调用：npm test / npm run accept。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentTextBlocks, imageLocationBlocks, isImageAttachment } from '../electron/services/attachment-text.mjs';

const textFile = (over = {}) => ({ kind: 'text', name: '说明.md', mime: 'text/markdown', size: 12, text: '# 标题\n正文', ...over });

test('文本附件：带文件名、类型、大小和正文', () => {
  const { blocks, truncated, dropped } = attachmentTextBlocks([textFile()]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /^附件：说明\.md（text\/markdown，12 B）/);
  assert.match(blocks[0], /# 标题\n正文$/);
  assert.deepEqual(truncated, []);
  assert.deepEqual(dropped, []);
});

test('图片附件不经过这条路径', () => {
  assert.equal(isImageAttachment({ kind: 'image' }), true);
  const { blocks } = attachmentTextBlocks([
    { kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAA' },
    textFile(),
  ]);
  assert.equal(blocks.length, 1, '只有非图片附件会变成文本块');
  assert.match(blocks[0], /说明\.md/);
  assert.equal(blocks.some(block => block.includes('a.png')), false);
});

test('老形状 { name, dataUrl } 仍按图片处理（放开文件类型之前的请求）', () => {
  assert.equal(isImageAttachment({ name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }), true);
  assert.equal(isImageAttachment({ name: 'a.bin', dataUrl: 'data:application/zip;base64,AAA' }), false);
  // 显式声明成 file 的，即使带图片 dataUrl 也不能被当成图片（那是渲染层的判断）。
  assert.equal(isImageAttachment({ kind: 'file', name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }), false);
  assert.deepEqual(attachmentTextBlocks([{ name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }]).blocks, []);
});

test('二进制文件：如实说读不到正文，不假装读过', () => {
  const { blocks } = attachmentTextBlocks([{ kind: 'file', name: '报表.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 2048 }]);
  assert.match(blocks[0], /附件：报表\.docx/);
  assert.match(blocks[0], /2\.0 KB/);
  assert.match(blocks[0], /只能读取文本类文件/);
});

test('超长文本按上限截断，并写明原文长度', () => {
  const long = 'a'.repeat(500);
  const { blocks, truncated } = attachmentTextBlocks([textFile({ text: long })], { maxChars: 100 });
  assert.match(blocks[0], /已截断，原文 500 字符，这里只保留前 100 字符/);
  assert.equal(blocks[0].endsWith('a'.repeat(100)), true, '截断后的正文要完整保留 100 字符');
  assert.deepEqual(truncated, ['说明.md']);
});

test('总预算用完后的附件：说明「没有纳入本轮」，不静默丢弃', () => {
  const { blocks, dropped } = attachmentTextBlocks(
    [textFile({ name: 'a.md', text: 'x'.repeat(80) }), textFile({ name: 'b.md', text: 'y'.repeat(80) })],
    { maxTotalChars: 80 },
  );
  assert.equal(blocks.length, 2, '每个附件都要有自己的说明块');
  assert.match(blocks[1], /附件：b\.md/);
  assert.match(blocks[1], /没有纳入/);
  assert.deepEqual(dropped, ['b.md']);
});

test('文件名里的控制字符被清掉，空名有兜底', () => {
  const { blocks } = attachmentTextBlocks([
    textFile({ name: 'evil\nname\u0000.md' }),
    textFile({ name: '' }),
  ]);
  assert.equal(blocks[0].includes('\nname'), false, '文件名里的换行不能破坏提示结构');
  assert.match(blocks[0], /附件：evil name \.md/);
  assert.match(blocks[1], /附件：未命名附件/);
});

test('空内容与空列表都有确定行为', () => {
  assert.deepEqual(attachmentTextBlocks([]).blocks, []);
  assert.deepEqual(attachmentTextBlocks(null).blocks, []);
  const { blocks } = attachmentTextBlocks([textFile({ text: '   ' })]);
  assert.match(blocks[0], /文件内容是空的/);
});

// ── 图片：把「在哪」交给读不了 image block 的通道（ACP / Gemini）────────────
test('图片有路径时：给出文件名、类型、大小和绝对路径，并让模型自己读', () => {
  const [block] = imageLocationBlocks([
    { name: '截图.png', mime: 'image/png', size: 2048, path: 'C:\\Users\\x\\AppData\\Roaming\\Mova\\chat-images\\ab12.png' },
  ]);
  assert.match(block, /^图片：截图\.png（image\/png，2\.0 KB）/);
  assert.match(block, /文件位置：C:\\Users\\x\\AppData\\Roaming\\Mova\\chat-images\\ab12\.png/);
  assert.match(block, /用你自己的文件读取工具打开上面的绝对路径/, '必须明确告诉模型下一步做什么');
  assert.match(block, /不在项目目录内/, '路径在 userData 下：项目内工具会拒绝，不写清楚模型会撞墙后说「读不到」');
  assert.match(block, /不要凭文件名猜内容/, '不许猜内容——这是「假装看到」的另一种形式');
});

test('图片没有路径时：临时会话与交接失败各自如实说明，绝不假装收到', () => {
  const [temporary] = imageLocationBlocks([{ name: 'a.png', mime: 'image/png', size: 10, temporary: true }]);
  assert.match(temporary, /文件位置：无/);
  assert.match(temporary, /临时会话/);
  assert.match(temporary, /读不到/);

  const [failed] = imageLocationBlocks([{ name: 'b.png', mime: 'image/png', size: 10, unavailable: '图片超过 4 MB' }]);
  assert.match(failed, /文件位置：无/);
  assert.match(failed, /图片超过 4 MB/, '失败原因要带给模型，它才能向用户解释');
  assert.equal(failed.includes('需要看内容'), false, '没有路径时不该让模型去读一个不存在的文件');
});

test('图片块：一张一块、顺序不变、空列表返回空数组', () => {
  const blocks = imageLocationBlocks([
    { name: '1.png', mime: 'image/png', path: '/tmp/1.png' },
    { name: '2.jpg', mime: 'image/jpeg', path: '/tmp/2.jpg' },
  ]);
  assert.equal(blocks.length, 2, '每张图各自一块，拼进 prompt 时不会串行');
  assert.match(blocks[0], /^图片：1\.png/);
  assert.match(blocks[1], /^图片：2\.jpg/);
  assert.deepEqual(imageLocationBlocks([]), []);
  assert.deepEqual(imageLocationBlocks(null), []);
  assert.deepEqual(imageLocationBlocks([null, undefined]), []);
});

test('图片块：文件名里的换行与控制字符被清掉（和文本附件同一条规则）', () => {
  const [block] = imageLocationBlocks([{ name: 'evil\nname\u0000.png', mime: 'image/png', path: '/tmp/x.png' }]);
  assert.equal(block.split('\n')[0].includes('\u0000'), false);
  assert.match(block, /^图片：evil name \.png/);
});
