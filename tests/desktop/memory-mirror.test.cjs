'use strict';
// 桌面技能 → 长期记忆索引卡的护栏：
//  - 卡片文本里要有 appKey / 标题 / 步骤 / 成功率，且长度受控；
//  - 写记忆失败不能影响技能保存（返回 null，不抛）；
//  - key 固定为 desktop.procedure.<id>，重复保存靠记忆库去重。
const test = require('node:test');
const assert = require('node:assert');

const { createDesktopMemoryMirror, summaryOf, stepLabel } = require('../../electron/desktop/memory-mirror.cjs');

const procedure = {
  id: 'dp_abc123',
  appKey: 'notepad.exe',
  title: '记事本记一笔',
  intent: ['记录', '写文字'],
  steps: [
    { op: 'click', target: { path: 'document/文本编辑器' } },
    { op: 'type', target: { path: 'document/文本编辑器' }, value: '{{p1}}' },
    { op: 'key', keys: 'enter' },
    { op: 'wait', for: 'stable' },
  ],
  stats: { ok: 3, fail: 1 },
};

test('summaryOf 包含关键信息且受长度限制', () => {
  const text = summaryOf(procedure);
  assert.match(text, /^\[桌面技能\] notepad\.exe · 记事本记一笔/);
  assert.match(text, /适用：记录、写文字/);
  assert.match(text, /步骤：点击「文本编辑器」 → 输入「文本编辑器」 → 按键 → 等待/);
  assert.match(text, /成功率：3\/4/);
  assert.ok(text.length <= 2000);
});

test('stepLabel 不会把 #12 这种视觉编号当名字', () => {
  assert.equal(stepLabel({ op: 'click', target: '#12' }), '点击');
  assert.equal(stepLabel({ op: 'click', target: { stableKey: 'aid:Save' } }), '点击「aid:Save」');
  assert.equal(stepLabel({ op: 'unknown-op' }), 'unknown-op');
});

test('mirror 会用 desktop.procedure.<id> 写一条 note', async () => {
  const calls = [];
  const memory = { async saveMemory(input) { calls.push(input); return { id: 'm1' }; } };
  const mirror = createDesktopMemoryMirror({ getMemory: () => memory });
  const saved = await mirror.mirror(procedure);
  assert.equal(saved.id, 'm1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'desktop.procedure.dp_abc123');
  assert.equal(calls[0].kind, 'note');
  assert.match(calls[0].text, /记事本记一笔/);
});

test('记忆库写失败/不可用时不抛，返回 null', async () => {
  const throwing = { async saveMemory() { throw new Error('memory-limit'); } };
  assert.equal(await createDesktopMemoryMirror({ getMemory: () => throwing }).mirror(procedure), null);
  assert.equal(await createDesktopMemoryMirror({ getMemory: () => null }).mirror(procedure), null);
  assert.equal(await createDesktopMemoryMirror({}).mirror(procedure), null);
});

test('没有 id 的技能不写记忆（避免脏 key）', async () => {
  const calls = [];
  const memory = { async saveMemory(input) { calls.push(input); return { id: 'm1' }; } };
  await createDesktopMemoryMirror({ getMemory: () => memory }).mirror({ ...procedure, id: '' });
  assert.equal(calls.length, 0);
});

test('accepts memory 直接传对象（不传 getter）', async () => {
  const calls = [];
  const memory = { async saveMemory(input) { calls.push(input); return { id: 'm2' }; } };
  const saved = await createDesktopMemoryMirror({ getMemory: memory }).mirror(procedure);
  assert.equal(saved.id, 'm2');
  assert.equal(calls.length, 1);
});
