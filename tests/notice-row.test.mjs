/**
 * notice 行归一的回归用例（纯函数，无 DOM）。
 *
 * 存在的理由：notice 是主进程（上下文台账 wiring、ACP translate）发来的旁白，
 * 它没有 id、也不该进 transcript 的 timeline；渲染端只允许看到「一行带 tone 的文字」。
 * 这里锁死四条边界：tone 归一、空文案丢弃、超长截断、未知输入不抛错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNoticeEvent,
  NOTICE_COLORS,
  NOTICE_MAX_CHARS,
  noticeRow,
  noticeTone,
} from '../src/features/chat/notice-row.js';

test('keeps the three legal tones and their colours', () => {
  for (const tone of ['info', 'warn', 'error']) {
    const row = noticeRow({ type: 'notice', tone, text: '上下文已压缩' });
    assert.equal(row.tone, tone, '合法 tone 必须原样保留');
    assert.equal(row.color, NOTICE_COLORS[tone], '颜色必须来自 tone 映射');
  }
  assert.equal(NOTICE_COLORS.info, '#9e9e9e', 'info 用次要文字灰');
  assert.equal(NOTICE_COLORS.warn, '#e5cc9e', 'warn 用暖色');
  assert.equal(NOTICE_COLORS.error, '#f0b9b2', 'error 用警示色');
});

test('falls back to info for an unknown tone', () => {
  assert.equal(noticeTone('fatal'), 'info', '未知 tone 必须兜底为 info');
  const row = noticeRow({ type: 'notice', tone: 'fatal', text: '未知 tone' });
  assert.equal(row.tone, 'info', '未知 tone 的 notice 必须降级为 info');
  assert.equal(row.color, NOTICE_COLORS.info);
});

test('falls back to info when the tone is missing or not a string', () => {
  assert.equal(noticeTone(undefined), 'info', '缺失 tone 按 info 处理');
  assert.equal(noticeTone(null), 'info');
  assert.equal(noticeTone(42), 'info', '非字符串 tone 按 info 处理');
  assert.equal(noticeRow({ type: 'notice', text: '没有 tone' }).tone, 'info');
});

test('drops empty, whitespace-only and non-string text', () => {
  assert.equal(noticeRow({ type: 'notice', tone: 'info', text: '' }), null, '空文案不渲染');
  assert.equal(noticeRow({ type: 'notice', tone: 'info', text: '   \n\t ' }), null, '纯空白不渲染');
  assert.equal(noticeRow({ type: 'notice', tone: 'info' }), null, '缺 text 不渲染');
  assert.equal(noticeRow({ type: 'notice', tone: 'info', text: 123 }), null, '非字符串 text 不渲染');
});

test('ignores anything that is not a notice event', () => {
  assert.equal(isNoticeEvent({ type: 'text', text: '正文' }), false, 'text 不是 notice');
  assert.equal(isNoticeEvent(null), false, 'null 不能抛错');
  assert.equal(isNoticeEvent(undefined), false);
  assert.equal(noticeRow({ type: 'tool', label: 'read_file' }), null, '非 notice 事件不产生行');
  assert.equal(noticeRow(null), null);
});

test('truncates overlong text and marks the cut', () => {
  const long = '很长的提示'.repeat(100);
  const row = noticeRow({ type: 'notice', tone: 'warn', text: long });
  assert.equal(row.text.length, NOTICE_MAX_CHARS + 1, '截断后只多一个省略号');
  assert.ok(row.text.endsWith('…'), '截断必须有省略号');
  assert.ok(row.text.length < long.length, '超长文案必须变短');
});

test('keeps short text intact and prefixes a dot', () => {
  const row = noticeRow({ type: 'notice', tone: 'info', text: '  第 2 次重试  ' });
  assert.equal(row.text, '第 2 次重试', '短文案只去首尾空白');
  assert.equal(row.line, '· 第 2 次重试', '一行提示前置小圆点');
  assert.equal(noticeRow({ type: 'notice', tone: 'info', text: 'x'.repeat(NOTICE_MAX_CHARS) }).text.length,
    NOTICE_MAX_CHARS, '正好到上限不截断');
});

test('collapses newlines so the hint stays one line', () => {
  const row = noticeRow({ type: 'notice', tone: 'error', text: '连接中断\n\n正在重试\t第 1 次' });
  assert.equal(row.text, '连接中断 正在重试 第 1 次', '换行与多空格必须压成单行');
  assert.equal(row.line.includes('\n'), false, '提示行不能带换行');
});
