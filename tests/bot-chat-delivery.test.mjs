import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRuntime } from '../electron/bots/runtime.mjs';
import { botPlainText, splitBotMessage } from '../src/features/bot/bot-message-text.mjs';

test('Bot text: plain text and Unicode-safe messages capped at 200 characters', () => {
  assert.equal(botPlainText('# 标题\n**重点**与`代码`\n- 项目'), '标题\n重点与代码\n项目');
  const text = '你好🙂。'.repeat(160);
  const parts = splitBotMessage(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => Array.from(part).length <= 200));
  assert.equal(parts.join(''), text);
  assert.equal(splitBotMessage('a'.repeat(180) + ' @设计师 请检查。').join(''), 'a'.repeat(180) + ' @设计师 请检查。');
});

test('Bot @ delivers in quiet mode, keeps message linkage, and prevents ping-pong', async () => {
  const calls = [];
  const rt = createBotRuntime({ modelRunner: async ({ bot, internalDirective }) => {
    calls.push({ id: bot.id, internalDirective });
    return { text: bot.id === 'planner' ? '@设计 请检查配色。' : '@策划 已完成检查。' };
  } });
  try {
    const conv = rt.conversationService.createGroupConversation({ title: '投递测试', groupMode: 'quiet', memberBotIds: ['planner', 'designer'] });
    const result = await rt.sendUserMessage({ conversationId: conv.id, content: '@规划师 请开始', mentions: [{ targetId: 'planner' }] });
    assert.deepEqual(calls.map(c => c.id), ['planner', 'designer']);
    assert.match(calls[1].internalDirective, /请检查配色/);
    const messages = result.emittedMessages;
    assert.equal(messages.length, 2);
    assert.equal(messages[1].replyToMessageId, messages[0].id);
  } finally { rt.dispose(); }
});

test('Long model reply stores separate plain-text messages and preserves one structured card', async () => {
  const rt = createBotRuntime({ modelRunner: async () => ({ text: '**确认。**'.repeat(210), structuredPayload: { type: 'question_card', question: '是否确认？' } }) });
  try {
    const conv = rt.conversationService.createPrivateTopicConversation({ botId: 'mova', topic: '分条' });
    const result = await rt.sendUserMessage({ conversationId: conv.id, content: '请汇报' });
    assert.ok(result.emittedMessages.length > 1);
    assert.ok(result.emittedMessages.every(m => Array.from(m.content).length <= 200 && !m.content.includes('**')));
    assert.equal(result.emittedMessages.filter(m => m.structuredPayload).length, 1);
  } finally { rt.dispose(); }
});

test('Question protocol becomes a card; active status events identify real working bots', async () => {
  const events = [];
  const rt = createBotRuntime({ modelRunner: async ({ updateStatus }) => {
    updateStatus('正在核对需求');
    return '<mova_bot_action>{"type":"ask_user","question":"确认修改前端吗？","options":["确认","不修改"]}</mova_bot_action>';
  } });
  rt.onEvent(event => events.push(event));
  try {
    const conv = rt.conversationService.createPrivateTopicConversation({ botId: 'mova', topic: '确认' });
    const result = await rt.sendUserMessage({ conversationId: conv.id, content: '修改页面' });
    assert.equal(result.emittedMessages[0].structuredPayload.type, 'question_card');
    assert.ok(events.some(e => e.type === 'bot:status' && e.activeBots.some(b => b.botId === 'mova' && b.statusText === '正在核对需求')));
    assert.equal(events.filter(e => e.type === 'bot:status').at(-1).active, false);
  } finally { rt.dispose(); }
});
