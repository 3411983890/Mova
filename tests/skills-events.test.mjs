// electron/skills/events.mjs 的单元测试。
// 这个文件守的是前端契约：事件的形状必须与 src/features/chat/chat-reply.ts 的 mergeReplyEvent
// 完全对得上，否则 Gemini 链路会刷出一堆重复行，或把工具截图写进用户消息气泡。
// 下面的 mergeReplyEvent 是 app.js 那份的 5 行等价物（按 type+id 找行、找到就 Object.assign）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCallIdFactory, isNoticeEvent, isStateEvent,
  skillDeniedEvent, skillDoneEvent, skillErrorEvent, skillRunningEvent,
} from '../electron/skills/events.mjs';

/** app.js / chat-reply.ts 的 mergeReplyEvent 等价实现：同一 type+id 原地覆盖，否则追加。 */
function mergeReplyEvent(timeline, event) {
  const current = timeline.find(item => item.type === event.type && item.id === event.id);
  if (!current) timeline.push(event);
  else Object.assign(current, event);
  return timeline;
}

const DEF = Object.freeze({ name: 'design_apply', label: '编辑设计' });

test('running → done 用同一个 id，时间线上只有一行（原地更新而不是新增）', () => {
  const timeline = [];
  mergeReplyEvent(timeline, skillRunningEvent({ callId: 'mcp-1', def: DEF, detail: '创建 12 个节点' }));
  mergeReplyEvent(timeline, skillDoneEvent({ callId: 'mcp-1', def: DEF, detail: '已更新 12 个节点' }));

  assert.equal(timeline.length, 1, '同一 id 的 running/done 不能变成两行');
  assert.equal(timeline[0].status, 'done', '状态被原地覆盖为 done');
  assert.equal(timeline[0].detail, '已更新 12 个节点', 'detail 被原地覆盖');
  assert.equal(timeline[0].type, 'tool');
  assert.equal(timeline[0].name, 'design_apply');
  assert.equal(timeline[0].label, '编辑设计');
});

test('长任务的分步进度原地更新同一行（不刷屏）', () => {
  const timeline = [];
  mergeReplyEvent(timeline, skillRunningEvent({ callId: 'mcp-2', def: DEF, detail: '第 1/10 步：导航', progress: { step: 1, total: 10 } }));
  mergeReplyEvent(timeline, skillRunningEvent({ callId: 'mcp-2', def: DEF, detail: '第 3/10 步：点击登录', progress: { step: 3, total: 10 } }));

  assert.equal(timeline.length, 1, '进度更新不能新增行');
  assert.equal(timeline[0].detail, '第 3/10 步：点击登录');
  assert.deepEqual(timeline[0].progress, { step: 3, total: 10 }, 'progress 被原地覆盖');
});

test('progress 传裸数字时归一成 { step }，不传时事件里没有 progress 字段', () => {
  assert.deepEqual(skillRunningEvent({ callId: 'mcp-3', def: DEF, progress: 4 }).progress, { step: 4 });
  assert.equal('progress' in skillRunningEvent({ callId: 'mcp-3', def: DEF }), false, '没有进度就不要留空字段');
});

test('running 事件不带 detail 时不能把既有 detail 覆盖成 undefined', () => {
  const timeline = [];
  mergeReplyEvent(timeline, skillRunningEvent({ callId: 'mcp-4', def: DEF, detail: '正在写入' }));
  mergeReplyEvent(timeline, skillRunningEvent({ callId: 'mcp-4', def: DEF }));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].detail, '正在写入', '空 detail 必须被省略，否则 Object.assign 会把它抹掉');
});

test('截图只能挂在 tool 事件的 image 字段上，绝不产出 { type:"image" } 事件', () => {
  const event = skillDoneEvent({
    callId: 'mcp-5', def: DEF, image: { id: 'abc123.png', name: '画板截图 · 1280×800' },
  });
  assert.equal(event.type, 'tool', '图片事件必须是 tool 类型（app.js:3037 会把 image 当用户附件）');
  assert.deepEqual(event.image, { id: 'abc123.png', name: '画板截图 · 1280×800', src: './chat-images/abc123.png' });
  const timeline = [];
  mergeReplyEvent(timeline, event);
  assert.equal(timeline.filter(item => item.type === 'image').length, 0, '时间线里不应出现独立 image 行');
});

test('image 缺 id（落盘失败）时整块丢弃，而不是留一张裂图', () => {
  const event = skillDoneEvent({ callId: 'mcp-6', def: DEF, image: { name: '没有 id' } });
  assert.equal('image' in event, false);
});

test('写文件的 diff 原样透传，before 为 null 表示新建文件', () => {
  const event = skillDoneEvent({
    callId: 'mcp-7',
    def: { name: 'write_file', label: '写入文件' },
    diff: { path: 'src/a.js', before: null, after: 'console.log(1)' },
  });
  assert.deepEqual(event.diff, { path: 'src/a.js', before: null, after: 'console.log(1)' });
  assert.equal(event.status, 'done');
});

test('error / denied 也是原地覆盖同一行，不会被当成新增动作', () => {
  const timeline = [];
  mergeReplyEvent(timeline, skillRunningEvent({ callId: 'mcp-8', def: DEF }));
  mergeReplyEvent(timeline, skillDeniedEvent({ callId: 'mcp-8', def: DEF, detail: '用户拒绝了这次操作' }));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].status, 'denied');

  mergeReplyEvent(timeline, skillErrorEvent({ callId: 'mcp-8', def: DEF, detail: '画布未打开' }));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].status, 'error');
  assert.equal(timeline[0].detail, '画布未打开');
});

test('denied / error 缺 detail 时给出可读的兜底文案', () => {
  assert.equal(skillDeniedEvent({ callId: 'mcp-9', def: DEF }).detail, '用户拒绝了这次操作');
  assert.equal(skillErrorEvent({ callId: 'mcp-9', def: DEF }).detail, '执行失败');
});

test('detail 被压成单行并截断，避免撑高时间线', () => {
  const long = `${'行一\n'.repeat(3)}${'x'.repeat(600)}`;
  const event = skillRunningEvent({ callId: 'mcp-10', def: DEF, detail: long });
  assert.ok(!event.detail.includes('\n'), 'detail 必须是单行');
  assert.ok(event.detail.length <= 401, `detail 应被截断，实际 ${event.detail.length}`);
});

test('done 事件带 durationMs（诊断用），非法值不出现', () => {
  assert.equal(skillDoneEvent({ callId: 'mcp-11', def: DEF, durationMs: 1234.6 }).durationMs, 1235);
  assert.equal('durationMs' in skillDoneEvent({ callId: 'mcp-11', def: DEF }), false);
});

test('createCallIdFactory 生成稳定递增的 mcp-<seq>，同一轮内不重复', () => {
  const next = createCallIdFactory();
  assert.equal(next(), 'mcp-1');
  assert.equal(next(), 'mcp-2');
  const ids = Array.from({ length: 5 }, () => next());
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一（前端按 id 找行）');
  assert.ok(ids.every(id => /^mcp-\d+$/.test(id)), 'id 规则统一为 mcp-<seq>');
  assert.equal(createCallIdFactory('acp')(), 'acp-1', '前缀可换（便于消歧）');
});

test('没有 callId 的事件直接抛错（否则会在时间线上留一行无法回填的孤儿）', () => {
  assert.throws(() => skillRunningEvent({ def: DEF }), TypeError);
  assert.throws(() => skillDoneEvent({ callId: '  ', def: DEF }), TypeError);
});

test('isStateEvent / isNoticeEvent 与前端分流一致', () => {
  for (const type of ['usage', 'goal', 'plan', 'context']) {
    assert.equal(isStateEvent({ type }), true, `${type} 必须归为 state event（不进时间线）`);
  }
  for (const type of ['tool', 'text', 'thinking', 'search', 'read', 'memory', 'image']) {
    assert.equal(isStateEvent({ type }), false, `${type} 不是 state event`);
  }
  assert.equal(isNoticeEvent({ type: 'notice', tone: 'warn', text: 'x' }), true);
  assert.equal(isNoticeEvent({ type: 'tool' }), false);
  assert.equal(isNoticeEvent(null), false);
  assert.equal(isStateEvent(null), false);
});
