import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createNotice,
  createTranslateState,
  planEntriesToSteps,
  translatePermissionRequest,
  translateSessionUpdate,
  translateUsage,
} from '../electron/acp/translate.mjs';

/** 真实形状：JSON-RPC 通知包一层 params.update；其余用例按需传 update 本身。 */
function notify(update) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update } };
}

test('agent_thought_chunk merges within one round and bumps round after another segment', () => {
  let state = createTranslateState();
  const first = translateSessionUpdate(notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看' } }), state);
  state = first.state;
  assert.deepEqual(first.events, [{ type: 'thinking', id: 'thinking-1', round: 1, text: '先看' }], '第一段思考从 round 1 开始');

  const second = translateSessionUpdate(notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '文件' } }), state);
  state = second.state;
  assert.equal(second.events[0].id, 'thinking-1', '同轮思考共用一个 id，渲染端按 id 覆盖同一行');
  assert.equal(second.events[0].round, 1, '同轮不换 round');
  assert.equal(second.events[0].text, '先看文件', '同轮思考累计成全文');

  translateSessionUpdate(notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结论' } }), state);
  const third = translateSessionUpdate(notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '再想' } }), state);
  assert.equal(third.events[0].round, 2, '中间夹了文本就是新一段思考');
  assert.equal(third.events[0].text, '再想', '新 round 的累计从空开始');
});

test('agent_message_chunk yields deltas with a stable id and drops empty chunks', () => {
  const state = createTranslateState();
  const first = translateSessionUpdate(notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } }), state);
  assert.deepEqual(first.events, [{ type: 'text', id: 'text-1', text: '你好' }], '文本是增量，id 标记同一段');

  const empty = translateSessionUpdate(notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }), state);
  assert.deepEqual(empty.events, [], '空块丢弃');

  const space = translateSessionUpdate(notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' 世界' } }), state);
  assert.deepEqual(space.events, [{ type: 'text', id: 'text-1', text: ' 世界' }], '同一段复用 id，纯空白不当空块丢');

  translateSessionUpdate(notify({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: '读文件', status: 'in_progress' }), state);
  const afterTool = translateSessionUpdate(notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '继续' } }), state);
  assert.equal(afterTool.events[0].id, 'text-2', '工具之后的文本是新的一段');
});

test('tool_call / tool_call_update map status to four states and merge partial updates', () => {
  const state = createTranslateState();
  const call = translateSessionUpdate(notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    kind: 'execute',
    title: '运行测试',
    status: 'pending',
    rawInput: { command: 'node --test' },
  }), state);
  assert.deepEqual(call.events, [{
    type: 'tool', id: 'call-1', name: 'execute', label: '运行测试', status: 'running', detail: 'node --test',
  }], 'pending 归一成 running，命令进 detail');

  const update = translateSessionUpdate(notify({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  }), call.state);
  assert.equal(update.events[0].status, 'done', 'completed 归一成 done');
  assert.equal(update.events[0].label, '运行测试', 'update 没带 title 时保留上一次的 label');
  assert.deepEqual(update.events[0].output, ['ok'], '内容块追加到 output');

  const failed = translateSessionUpdate(notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' }), state);
  assert.equal(failed.events[0].status, 'error', 'failed 归一成 error');
  assert.deepEqual(failed.events[0].output, ['ok'], '失败更新不清空已有输出');

  const cancelled = translateSessionUpdate(notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'cancelled' }), state);
  assert.equal(cancelled.events[0].status, 'denied', '中断不能留 running（§11.5）');
});

test('tool diff content extracts path plus before/after text', () => {
  const state = createTranslateState();
  const result = translateSessionUpdate(notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-diff',
    kind: 'edit',
    title: '改配置',
    status: 'in_progress',
    content: [{ type: 'diff', path: 'src/app/main.tsx', oldText: 'a', newText: 'b' }],
  }), state);
  const event = result.events[0];
  assert.deepEqual(event.diff, { path: 'src/app/main.tsx', before: 'a', after: 'b' }, 'diff 保留路径与新旧文本');
  assert.equal(event.path, 'src/app/main.tsx', 'path 提到顶层，changes 面板直接取');
});

test('tool output truncates one entry at 8KB', () => {
  const state = createTranslateState();
  const long = 'x'.repeat(10_000);
  const result = translateSessionUpdate(notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-long',
    title: '长输出',
    status: 'in_progress',
    content: [{ type: 'content', content: { type: 'text', text: long } }],
  }), state);
  assert.equal(result.events[0].output[0].length, 8192, '单条输出截到 8KB');
});

test('plan keeps only the first in_progress active and marks failed steps', () => {
  const state = createTranslateState();
  const result = translateSessionUpdate(notify({
    sessionUpdate: 'plan',
    entries: [
      { content: '读代码', priority: 'high', status: 'completed' },
      { content: '改翻译层', priority: 'high', status: 'in_progress' },
      { content: '补测试', priority: 'medium', status: 'in_progress' },
      { content: '跑 E2E', priority: 'low', status: 'failed' },
    ],
  }), state);
  assert.deepEqual(result.events, [{
    type: 'plan',
    plan: {
      steps: [
        { label: '读代码', status: 'done' },
        { label: '改翻译层', status: 'active' },
        { label: '补测试', status: 'pending' },
        { label: '跑 E2E', status: 'done', meta: '失败' },
      ],
    },
  }], '多个 in_progress 只留第一个 active，failed 落成 done + meta 失败');
});

test('plan_removed clears the plan to null', () => {
  const state = createTranslateState();
  translateSessionUpdate(notify({ sessionUpdate: 'plan_update', entries: [{ content: '一步', status: 'in_progress' }] }), state);
  const removed = translateSessionUpdate(notify({ sessionUpdate: 'plan_removed' }), state);
  assert.deepEqual(removed.events, [{ type: 'plan', plan: null }], '移除计划给 null');
  assert.equal(state.plan, null, 'state 里也不留旧计划');
});

test('unknown updates and garbage input return no events without throwing', () => {
  const state = createTranslateState();
  for (const input of [
    notify({ sessionUpdate: 'brand_new_thing', foo: 1 }),
    notify({}),
    null,
    undefined,
    'not-an-object',
    { params: { update: null } },
  ]) {
    const result = translateSessionUpdate(input, state);
    assert.deepEqual(result.events, [], '不认识的 update 一律返回空数组');
    assert.equal(result.state, state, '不认识的 update 不改状态');
  }
});

test('compaction_update becomes an info notice', () => {
  const state = createTranslateState();
  const result = translateSessionUpdate(notify({ sessionUpdate: 'compaction_update' }), state);
  assert.deepEqual(result.events, [{ type: 'notice', tone: 'info', text: '上下文已压缩' }], '压缩提示是一行 notice');
});

test('turn_end and _meta.done signal the end of the turn', () => {
  const state = createTranslateState();
  const turnEnd = translateSessionUpdate(notify({ sessionUpdate: 'turn_end' }), state);
  assert.equal(turnEnd.done, true, '显式 turn_end 结束本轮');
  assert.deepEqual(turnEnd.events, [], 'turn_end 不产生事件');

  const metaDone = translateSessionUpdate(notify({ sessionUpdate: 'some_future_update', _meta: { done: true } }), state);
  assert.equal(metaDone.done, true, '_meta.done 也当结束信号');

  const quiet = translateSessionUpdate(notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }), state);
  assert.equal(quiet.done, undefined, '普通事件不带 done');
});

test('translateUsage folds Gemini cached and thought tokens into input/output', () => {
  const event = translateUsage({
    inputTokens: 100,
    outputTokens: 20,
    cachedReadTokens: 40,
    thoughtTokens: 5,
    model: 'gemini-2.5-pro',
    provider: 'google',
  });
  assert.equal(event.type, 'usage', '事件类型固定');
  assert.equal(event.call.input, 140, 'input = inputTokens + cachedReadTokens，直接相加会少算');
  assert.equal(event.call.output, 25, 'output = outputTokens + thoughtTokens');
  assert.equal(event.call.totalTokens, 165, 'total 用拉平后的口径');
  assert.equal(event.call.cacheRead, 0, 'cached 已并进 input，不能再单独记一次');
  assert.equal(event.model, 'gemini-2.5-pro', 'model 透传');
  assert.equal(event.provider, 'google', 'provider 透传');

  const bare = translateUsage({});
  assert.deepEqual(bare.call, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, '空 usage 不炸，给全零');
});

test('permission request with a plain option list becomes a question card', () => {
  const state = createTranslateState();
  const result = translatePermissionRequest({
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'ask-1', title: '用哪个数据库？' },
    options: [
      { optionId: 'pg', name: 'PostgreSQL' },
      { optionId: 'sqlite', name: 'SQLite' },
    ],
  }, state);
  assert.deepEqual(result, {
    kind: 'question',
    question: {
      id: 'ask-1',
      header: '需要你确认',
      question: '用哪个数据库？',
      options: [
        { value: 'pg', label: 'PostgreSQL' },
        { value: 'sqlite', label: 'SQLite' },
      ],
    },
  }, '没有语义 kind 的纯选项列表 = 提问（§11.4）');
});

test('permission request with approval kinds becomes an approval bar', () => {
  const state = createTranslateState();
  const result = translatePermissionRequest({
    toolCall: {
      toolCallId: 'perm-1',
      title: '写入 src/index.ts',
      rawInput: { path: 'src/index.ts' },
      _meta: { security_warning: { message: '该文件受保护，改动会影响启动流程' } },
    },
    options: [
      { optionId: 'once', name: '允许一次', kind: 'allow_once' },
      { optionId: 'always', name: '本会话允许', kind: 'allow_always', _meta: { security_warning: { title: '会写入受保护文件' } } },
      { optionId: 'no', name: '拒绝', kind: 'reject_once' },
    ],
  }, state);
  assert.equal(result.kind, 'approval', '带 allow_once 等语义 kind = 审批');
  assert.equal(result.uncertain, undefined, '认得出来就不标 uncertain');
  assert.equal(result.approval.message, '写入 src/index.ts', 'message 取 toolCall 标题');
  assert.equal(result.approval.detail, 'src/index.ts', 'detail 取路径/命令');
  assert.deepEqual(result.approval.options.map(option => [option.id, option.kind]), [
    ['once', 'allow_once'], ['always', 'allow_always'], ['no', 'reject_once'],
  ], '选项原样保留 id 与 kind，回填 optionId 才对得上');
  assert.equal(result.approval.options[0].warning, '该文件受保护，改动会影响启动流程', '警告可挂在 toolCall 上');
  assert.equal(result.approval.options[1].warning, '会写入受保护文件', '选项级警告优先，缺 message 时退回 title');
  assert.equal(result.approval.options[2].warning, '该文件受保护，改动会影响启动流程', '选项自己没有警告时继承 toolCall 的警告');

  const plain = translatePermissionRequest({
    toolCall: { toolCallId: 'perm-plain', title: '读取 README' },
    options: [{ optionId: 'ok', name: '允许', kind: 'allow_once' }],
  }, createTranslateState());
  assert.equal(plain.approval.options[0].warning, undefined, '没有任何警告就不带 warning 字段');
});

test('unrecognised or missing options are treated as approval with uncertain', () => {
  const state = createTranslateState();

  const unknownKind = translatePermissionRequest({
    toolCall: { toolCallId: 'perm-2', title: '执行命令', rawInput: { command: 'rm -rf build' } },
    options: [
      { optionId: 'go', name: '执行', kind: 'accept' },
      { optionId: 'stop', name: '不执行', kind: 'deny' },
    ],
  }, state);
  assert.equal(unknownKind.kind, 'approval', 'kind 存在但一个都不认识：按审批保守处理（§11.6 无匹配行）');
  assert.equal(unknownKind.uncertain, true, '拿不准必须标 uncertain，让上层可提示');
  assert.deepEqual(unknownKind.approval.options.map(option => option.kind), ['accept', 'deny'], '未知 kind 原样保留，不硬塞四态');

  const noOptions = translatePermissionRequest({ toolCall: { toolCallId: 'perm-3', title: '删除文件' }, options: [] }, state);
  assert.equal(noOptions.kind, 'approval', '没有选项无从提问');
  assert.equal(noOptions.uncertain, true, '没有选项也拿不准');

  const noToolCall = translatePermissionRequest({ options: [{ optionId: 'a', name: 'A' }] }, state);
  assert.equal(noToolCall.kind, 'approval', '缺 toolCall 说不清在批什么');
  assert.equal(noToolCall.uncertain, true, '缺 toolCall 也要标 uncertain');
});

test('partial approval kinds fall back to approval and stay uncertain', () => {
  const state = createTranslateState();
  const result = translatePermissionRequest({
    toolCall: { toolCallId: 'perm-4', title: '读取密钥文件' },
    options: [
      { optionId: 'yes', name: '允许', kind: 'allow_once' },
      { optionId: 'later', name: '稍后' },
    ],
  }, state);
  assert.equal(result.kind, 'approval', '有一个语义 kind 就是审批');
  assert.equal(result.uncertain, true, '选项集合不完整时仍标 uncertain');
  assert.equal(result.approval.options[1].kind, 'other', '缺 kind 的选项补 other，UI 才知道它没语义');
});

test('planEntriesToSteps normalises statuses and drops blank rows', () => {
  const { steps } = planEntriesToSteps([
    { content: '   ' , status: 'pending' },
    { content: 'A', status: 'pending' },
    { content: 'B', status: 'in_progress' },
    { content: 'C', status: 'completed' },
    { content: 'D', status: 'weird' },
    'E',
  ]);
  assert.deepEqual(steps, [
    { label: 'A', status: 'pending' },
    { label: 'B', status: 'active' },
    { label: 'C', status: 'done' },
    { label: 'D', status: 'pending' },
    { label: 'E', status: 'pending' },
  ], '空行丢弃，未知状态退 pending，纯字符串也认');
  assert.deepEqual(planEntriesToSteps(null), { steps: [] }, 'null 给空计划');
});

test('createNotice validates tone and trims text', () => {
  assert.deepEqual(createNotice('上下文已压缩', 'warn'), { type: 'notice', tone: 'warn', text: '上下文已压缩' });
  assert.equal(createNotice('小心', 'danger').tone, 'info', '非法 tone 退 info，提示行不能成为故障点');
  assert.equal(createNotice('  ', 'error').text, '', '空白文案 trim 成空串');
});
