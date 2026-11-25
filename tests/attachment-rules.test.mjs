/**
 * 负责：锁住「附件能带什么」的规则——所有文件类型都能带，但图片/文本/二进制各有各的校验，
 *   并且发出去的形状只保留该保留的字段。
 * 不负责：读文件（vendor composer）、把附件变成模型输入（electron/services/attachment-text.mjs）。
 * 被谁调用：npm test / npm run accept。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentSummary, checkAttachments, MAX_ATTACHMENTS, MAX_IMAGES, toRequestAttachment } from '../src/features/chat/attachment-rules.mjs';

const png = (over = {}) => ({ kind: 'image', name: 'a.png', mime: 'image/png', size: 1024, dataUrl: 'data:image/png;base64,AAA', ...over });
const md = (over = {}) => ({ kind: 'text', name: '说明.md', mime: 'text/markdown', size: 2048, text: '# 标题', ...over });

test('Markdown / 文本 / 二进制文件都能通过校验', () => {
  assert.deepEqual(checkAttachments([md()]), { ok: true });
  assert.deepEqual(checkAttachments([{ kind: 'file', name: 'x.zip', mime: 'application/zip', size: 999 }]), { ok: true });
  assert.deepEqual(checkAttachments([png(), md(), { kind: 'file', name: 'a.bin', size: 10 }]), { ok: true });
});

test('图片仍然有自己的硬约束（格式 / 大小 / 张数）', () => {
  assert.equal(checkAttachments([png({ dataUrl: 'data:text/plain;base64,AAA' })]).code, 'image');
  assert.equal(checkAttachments([png({ dataUrl: undefined })]).code, 'image');
  assert.equal(checkAttachments([png({ size: 5 * 1024 * 1024 })]).code, 'size');
  const many = Array.from({ length: MAX_IMAGES + 1 }, (_, index) => png({ name: `${index}.png` }));
  assert.equal(checkAttachments(many).code, 'count');
});

test('总附件数量上限对图片与文件一起生效', () => {
  const list = [md({ name: '1.md' }), md({ name: '2.md' }), md({ name: '3.md' }), md({ name: '4.md' }), md({ name: '5.md' }), md({ name: '6.md' })];
  const verdict = checkAttachments(list);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'count');
  assert.match(verdict.message, new RegExp(String(MAX_ATTACHMENTS)));
});

test('文本附件没有正文时明确失败（不发出一个空附件）', () => {
  const verdict = checkAttachments([md({ text: undefined })]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /没有读到内容/);
});

test('composer 给的是 extractedText：两种字段名都认', () => {
  // vendor 的 ingest 结果字段叫 extractedText；只认 text 会让真实上传被判成「没有读到内容」。
  const fromComposer = { kind: 'text', name: '说明.md', mime: 'text/markdown', size: 10, extractedText: '# 标题' };
  assert.deepEqual(checkAttachments([fromComposer]), { ok: true });
  assert.equal(toRequestAttachment(fromComposer).text, '# 标题');
});

test('发给主进程的形状：图片带 dataUrl、文本带正文、二进制只带元信息', () => {
  assert.deepEqual(toRequestAttachment(png()), {
    kind: 'image', name: 'a.png', mime: 'image/png', size: 1024, dataUrl: 'data:image/png;base64,AAA',
  });
  assert.deepEqual(toRequestAttachment(md()), {
    kind: 'text', name: '说明.md', mime: 'text/markdown', size: 2048, text: '# 标题',
  });
  // 二进制绝不能把 dataUrl 之类的大字段带进请求。
  assert.deepEqual(toRequestAttachment({ kind: 'file', name: 'x.zip', mime: 'application/zip', size: 999, dataUrl: 'data:...' }), {
    kind: 'file', name: 'x.zip', mime: 'application/zip', size: 999,
  });
});

test('缺字段时不产生 undefined，名字有兜底', () => {
  const payload = toRequestAttachment({});
  assert.deepEqual(payload, { kind: 'file', name: '附件', mime: '', size: 0 });
  assert.deepEqual(attachmentSummary({ name: 'README.md', kind: 'text' }), { name: 'README.md', kind: '文本' });
  assert.deepEqual(attachmentSummary(null), { name: '附件', kind: '文件' });
});
