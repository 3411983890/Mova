import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChatAgent } from '../electron/chat-agent.mjs';

const entry = { id: 'goal-model', name: 'Goal Model', vision: false, efforts: ['low', 'high'] };
const provider = { id: 'goal-test', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
const signal = () => new AbortController().signal;

function completion(deltas, finish) {
  const chunk = (delta, finishReason = null) => 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }) + '\n\n';
  return new Response(deltas.map(delta => chunk(delta)).join('') + chunk({}, finish) + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const toolCall = (name, args) => ({
  tool_calls: [{
    index: 0, id: `call_${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }],
});

const goalEvents = events => events.filter(event => event.type === 'goal').map(event => event.goal);
const planEvents = events => events.filter(event => event.type === 'plan').map(event => event.plan);

test('goal protocol: set → accept → plan → done, and acceptance is explicit', async () => {
  const events = [];
  const payloads = [];
  const replies = [
    completion([{ content: '先立目标。' }, toolCall('set_goal', { title: '整理面试资料', detail: '产出一页提纲' })], 'tool_calls'),
    completion([toolCall('accept_goal', { note: '先读现有笔记' })], 'tool_calls'),
    completion([toolCall('set_plan', { steps: [
      { label: '读笔记', status: 'active' },
      { label: '写提纲', status: 'pending' },
    ] })], 'tool_calls'),
    completion([toolCall('update_goal', { status: 'done', summary: '提纲已交付' })], 'tool_calls'),
    completion([{ content: '完成了。' }], 'stop'),
  ];
  await runChatAgent({
    key: 'k', provider, entry, signal: signal(),
    request: { thinking: 'low', messages: [{ role: 'user', text: '帮我整理面试资料' }] },
    emit: event => events.push(event),
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return replies[payloads.length - 1] ?? replies.at(-1);
    },
  });

  const goals = goalEvents(events);
  assert.equal(goals[0].title, '整理面试资料');
  assert.equal(goals[0].status, 'active');
  assert.equal(goals[0].accepted, false, '新目标必须等模型接受，自动推进才不会启动');
  assert.equal(goals[1].accepted, true, 'accept_goal 之后目标才算被接受');
  assert.equal(goals[1].summary, '先读现有笔记');
  assert.deepEqual(planEvents(events)[0].steps.map(step => step.status), ['active', 'pending']);
  assert.equal(goals.at(-1).status, 'done');
  assert.equal(goals.at(-1).summary, '提纲已交付');
  assert.equal(goals.at(-1).accepted, false, 'done 之后不再自动推进');

  // 提示词要说明自动推进的协议，否则模型会停下来等用户说“继续”。
  const system = payloads[0].messages.find(message => message.role === 'system');
  assert.match(system.content, /accept_goal/);
  assert.match(system.content, /automatically starts the next round/);
});

test('a goal carried by the request is usable without re-publishing it', async () => {
  const events = [];
  const payloads = [];
  await runChatAgent({
    key: 'k', provider, entry, signal: signal(),
    request: {
      thinking: 'low',
      messages: [{ role: 'user', text: '继续' }],
      aim: {
        goal: { title: '既有目标', detail: '', status: 'active', accepted: true },
        plan: { steps: [{ label: '第一步', status: 'active' }] },
      },
    },
    emit: event => events.push(event),
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) return completion([toolCall('update_goal', { status: 'done', summary: '做完了' })], 'tool_calls');
      return completion([{ content: '好。' }], 'stop');
    },
  });

  const goals = goalEvents(events);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].status, 'done', '跨轮目标要能直接标记完成，而不是报“没有目标”');
  const system = payloads[0].messages.find(message => message.role === 'system');
  assert.match(system.content, /Current goal of this conversation/, '提示词要带上已有目标');
  assert.match(system.content, /既有目标/);
});

test('blocked ends the loop with the reported reason', async () => {
  const events = [];
  const payloads = [];
  await runChatAgent({
    key: 'k', provider, entry, signal: signal(),
    request: {
      thinking: 'low',
      messages: [{ role: 'user', text: '继续' }],
      aim: { goal: { title: '需要权限的目标', status: 'active', accepted: true, detail: '' }, plan: null },
    },
    emit: event => events.push(event),
    fetchModel: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) return completion([toolCall('update_goal', { status: 'blocked', summary: '缺少目标文件夹的写入权限' })], 'tool_calls');
      return completion([{ content: '卡住了。' }], 'stop');
    },
  });
  const goal = goalEvents(events).at(-1);
  assert.equal(goal.status, 'blocked');
  assert.equal(goal.summary, '缺少目标文件夹的写入权限');
});
