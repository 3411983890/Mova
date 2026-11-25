// electron/mcp/normalize.mjs 的单元测试（此前只在别的测试里被间接覆盖，头注释却一直指向本文件）。
// 纯内存：只有字符串与普通对象，不碰 electron、不碰磁盘、不起网络。
// 断言的核心是「交给模型的文本永远不超过调用方给的预算，且说明本身算在预算内」——
// 截断说明超预算就等于没截断，MCP 结果没有分页，超一点就是白烧一段上下文。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ERROR_MESSAGE_CHARS, MAX_TEXT_CHARS, errorResult, messageOf, normalizeResult, textResult, truncateText,
} from '../electron/mcp/normalize.mjs';

test('truncateText：没超上限时原样返回', () => {
  assert.equal(truncateText('短文本', 100), '短文本');
  assert.equal(truncateText('', 100), '');
  assert.equal(truncateText('a'.repeat(100), 100), 'a'.repeat(100), '正好等于上限不截断');
});

test('truncateText：超上限时截断并说明原文长度，总长不超过上限', () => {
  const text = 'a'.repeat(1_000);
  const sliced = truncateText(text, 100);
  assert.ok(sliced.length <= 100, `截断后长度不得超过 100，实际 ${sliced.length}`);
  assert.match(sliced, /已截断/);
  assert.match(sliced, /1000/, '说明里要保留原始字符数');
  assert.ok(sliced.startsWith('a'.repeat(10)), '保留的是开头部分');
});

test('truncateText：上限小于说明本身时退化为硬截断（不返回比原文更长的东西）', () => {
  const text = 'x'.repeat(500);
  const sliced = truncateText(text, 5);
  assert.equal(sliced.length, 5, '说明比预算还长时只能丢掉说明');
  assert.equal(sliced, 'xxxxx');
});

test('truncateText：畸形上限回落到默认预算 MAX_TEXT_CHARS', () => {
  const text = 'y'.repeat(MAX_TEXT_CHARS + 100);
  for (const limit of [0, -1, Number.NaN, 'nope', undefined]) {
    const sliced = truncateText(text, limit);
    assert.ok(sliced.length <= MAX_TEXT_CHARS, `limit=${String(limit)} 应回落到 ${MAX_TEXT_CHARS}`);
    assert.match(sliced, /已截断/);
  }
});

test('truncateText：非字符串输入先转成字符串', () => {
  assert.equal(truncateText(42, 100), '42');
  assert.equal(truncateText(null, 100), '');
  assert.equal(truncateText(undefined, 100), '');
  assert.equal(truncateText({ a: 1 }, 100), '[object Object]');
});

test('textResult：默认不带 isError，传 true 才带', () => {
  assert.deepEqual(textResult('ok'), { content: [{ type: 'text', text: 'ok' }] });
  assert.deepEqual(textResult('boom', true), { content: [{ type: 'text', text: 'boom' }], isError: true });
});

test('errorResult：isError + 可解析的 { error, message }，message 有上限', () => {
  const result = errorResult('permission_denied', 'x'.repeat(1_000));
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error, 'permission_denied');
  assert.equal(payload.message.length, ERROR_MESSAGE_CHARS, '错误 message 必须截到上限');
});

test('normalizeResult：第一种形状——字符串', () => {
  assert.deepEqual(normalizeResult('hello'), { content: [{ type: 'text', text: 'hello' }] });
  assert.deepEqual(normalizeResult(null), { content: [{ type: 'text', text: 'ok' }] }, 'null 当成功');
  const long = normalizeResult('z'.repeat(50), { maxTextChars: 20 });
  assert.ok(long.content[0].text.length <= 20);
});

test('normalizeResult：第二种形状——普通对象序列化成文本', () => {
  const result = normalizeResult({ ok: true, count: 2 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, count: 2 });

  const circular = {};
  circular.self = circular;
  const fallback = normalizeResult(circular);
  assert.equal(fallback.content[0].text, '[object Object]', '循环引用不能抛，要退化成 String(raw)');
});

test('normalizeResult：第三种形状——已有 content 的 MCP 结果（逐块截断，非 text 块原样保留）', () => {
  const raw = {
    content: [
      { type: 'text', text: 'a'.repeat(500) },
      { type: 'image', data: 'base64', mimeType: 'image/png' },
      { type: 'text', text: 'short' },
    ],
    isError: true,
  };
  const result = normalizeResult(raw, { maxTextChars: 100 });
  assert.equal(result.isError, true, 'isError 必须透传');
  assert.equal(result.content.length, 3);
  assert.ok(result.content[0].text.length <= 100, '每个 text 块各自受预算约束');
  assert.match(result.content[0].text, /已截断/);
  assert.deepEqual(result.content[1], { type: 'image', data: 'base64', mimeType: 'image/png' }, '图片块不能被改写');
  assert.equal(result.content[2].text, 'short');
});

test('normalizeResult：content 里的非对象项被丢掉，全空时回 ok', () => {
  const result = normalizeResult({ content: [null, 'x', 3] });
  assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }]);
});

test('messageOf：Error / 字符串 / 对象各给一句话', () => {
  assert.equal(messageOf(new Error('炸了')), '炸了');
  assert.equal(messageOf('炸了'), '炸了');
  assert.equal(messageOf({ code: 'x' }), '{"code":"x"}');
  assert.equal(messageOf(undefined), 'unknown error', 'JSON.stringify(undefined) 没有返回值，要给出稳定文案');
});
