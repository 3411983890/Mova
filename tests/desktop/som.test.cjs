'use strict';
/* global require */
// som.cjs 单测：候选挑选（纯函数）/ 去重 / 排序 / 绘制。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const sharp = require('sharp');

const { annotate, pickMarks, marksFromTree, MARK_COLOR } = require('../../electron/desktop/vision/som.cjs');

function node(overrides = {}) {
  return {
    role: 'button',
    name: '确定',
    rect: [100, 100, 80, 28],
    states: { enabled: true, focusable: true, offscreen: false, password: false },
    patterns: ['invoke'],
    ...overrides,
  };
}

// 在输出图里找“偏蓝”的像素：用来确认真的画了描边而不是原图返回
async function findBluePixel(buffer, box) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const left = Math.max(0, box.x - 2);
  const top = Math.max(0, box.y - 2);
  const right = Math.min(info.width - 1, box.x + box.w + 2);
  const bottom = Math.min(info.height - 1, box.y + box.h + 2);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * channels;
      const r = data[offset];
      const b = data[offset + 2];
      if (b - r > 20) return { x, y, r, g: data[offset + 1], b };
    }
  }
  return null;
}

test('pickMarks 只保留可交互、有 rect、可见的节点', () => {
  const nodes = [
    node({ rect: [10, 10, 80, 28] }),
    node({ role: 'window', name: '微信', rect: [0, 0, 1200, 800], patterns: ['window'] }),
    node({ rect: [20, 20, 80, 28], states: { offscreen: true } }),
    node({ rect: [30, 30, 80, 28], states: { password: true } }),
    node({ rect: [40, 40, 5, 28] }), // 太窄，点不准
    node({ role: 'custom', name: '', patterns: [], states: { focusable: false } }), // 无名且不可交互
    node({ rect: null }),
  ];
  const marks = pickMarks(nodes);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].role, 'button');
  assert.deepEqual(marks[0].box, { x: 10, y: 10, w: 80, h: 28 });
  assert.equal(marks[0].id, 1);
});

test('pickMarks 排序：可交互优先 -> 面积大优先，id 从 1 连续', () => {
  const nodes = [
    node({ role: 'custom', name: '自绘焦点块', rect: [0, 100, 10, 10], patterns: [], states: { focusable: true } }),
    node({ role: 'listitem', name: '项', rect: [0, 80, 50, 10] }),
    node({ role: 'edit', name: '搜索', rect: [0, 0, 200, 30], patterns: ['value'] }),
    node({ role: 'button', name: '确定', rect: [0, 50, 100, 20] }),
  ];
  const marks = pickMarks(nodes);
  assert.deepEqual(marks.map((mark) => mark.role), ['edit', 'button', 'listitem', 'custom']);
  assert.deepEqual(marks.map((mark) => mark.id), [1, 2, 3, 4]);
});

test('pickMarks 去重：完全重合只留一个，被更高优先级框包住的子节点去掉', () => {
  const nodes = [
    node({ role: 'button', name: '发送', rect: [100, 200, 80, 30] }),
    node({ role: 'button', name: '发送', rect: [100, 200, 80, 30] }), // UIA 包装重复
    node({ role: 'hyperlink', name: '发送', rect: [102, 202, 76, 26] }), // 被按钮几乎完全包含
    node({ role: 'button', name: '取消', rect: [100, 240, 80, 30] }),
  ];
  const marks = pickMarks(nodes);
  assert.equal(marks.length, 2);
  assert.deepEqual(marks.map((mark) => mark.name), ['发送', '取消']);
});

test('pickMarks 尊重 limit，最多 99 个（两位数字标签）', () => {
  const nodes = [];
  for (let i = 0; i < 60; i += 1) {
    nodes.push(node({ name: `按钮${i}`, rect: [i * 10, 0, 9, 9] }));
  }
  assert.equal(pickMarks(nodes, 40).length, 40);
  assert.equal(pickMarks(nodes, { limit: 3 }).length, 3);
  assert.equal(pickMarks(nodes, 500).length, 60);
  assert.equal(pickMarks(nodes, { limit: 500 }).length, 60);
  assert.equal(pickMarks([], 40).length, 0);
  assert.equal(pickMarks(null, 40).length, 0);
});

test('marksFromTree 把框换算到图像空间（boxScale / offset）', () => {
  const nodes = [node({ rect: { x: 200, y: 100, width: 80, height: 28 } })];
  const scaled = marksFromTree(nodes, { boxScale: 0.5 });
  assert.deepEqual(scaled[0].box, { x: 100, y: 50, w: 40, h: 14 });
  const offset = marksFromTree(nodes, { boxScale: { x: 0.5, y: 0.25 }, offsetX: 100, offsetY: 50 });
  assert.deepEqual(offset[0].box, { x: 50, y: 12.5, w: 40, h: 7 });
  assert.equal(offset[0].id, 1);
});

test('annotate 画出描边与标签，尺寸不变，marks 带回 imageBox', async () => {
  const base = await sharp({ create: { width: 240, height: 160, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = await annotate(base, {
    marks: [
      { id: 1, role: 'button', name: '确定', box: [20, 40, 80, 28] },
      { id: 2, role: 'edit', name: '搜索', box: [20, 100, 120, 24] },
    ],
  });
  assert.equal(result.width, 240);
  assert.equal(result.height, 160);
  assert.equal(result.marks.length, 2);
  assert.deepEqual(result.marks[0].imageBox, { x: 20, y: 40, w: 80, h: 28 });

  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 240);
  assert.equal(meta.height, 160);
  assert.equal(meta.format, 'png');

  const blue = await findBluePixel(result.buffer, { x: 20, y: 40, w: 80, h: 28 });
  assert.ok(blue, '框边应出现偏蓝描边');
  assert.ok(blue.b > blue.r, '描边应偏蓝');
});

test('annotate 支持 boxScale 与越界裁剪；空 marks 原样返回', async () => {
  const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const scaled = await annotate(base, { marks: [{ id: 3, box: [40, 20, 40, 20] }], boxScale: 0.5 });
  assert.deepEqual(scaled.marks[0].imageBox, { x: 20, y: 10, w: 20, h: 10 });

  // 越界的框会被夹回图内，而不是让 sharp composite 报错
  const clipped = await annotate(base, { marks: [{ id: 4, box: [90, 70, 80, 60] }] });
  assert.deepEqual(clipped.marks[0].imageBox, { x: 90, y: 70, w: 10, h: 10 });

  const empty = await annotate(base, { marks: [] });
  assert.equal(empty.buffer, base);
  assert.deepEqual(empty.marks, []);
});

test('annotate 拒绝非 Buffer 输入', async () => {
  await assert.rejects(() => annotate('not-a-buffer', { marks: [] }), (error) => error.code === 'bad-image');
});

test('MARK_COLOR 与设计文档一致', () => {
  assert.equal(MARK_COLOR, '#4DA3FF');
});
