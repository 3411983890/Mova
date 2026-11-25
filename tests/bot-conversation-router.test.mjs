/**
 * 负责：验证多话题私聊、稳定 ID 群聊 4 种模式、结构化 @ 同名消歧、防死循环与复读护栏、人工发送立即打断抢占、
 *   后台静默协作不进可见消息、多方 Provider 角色映射（projectMultiPartyTranscriptForProvider）以及共识投票转任务。
 * 不负责：真实外部大模型网络请求或 DOM 挂载渲染。
 * 被谁调用：`node --test` 与 `scripts/accept.mjs`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRuntime } from '../electron/bots/runtime.mjs';
import { parseBotActionDirectives, projectMultiPartyTranscriptForProvider } from '../electron/bots/run-service.mjs';

test('Conversation & EventRouter: multi-topic, structured @ disambiguation, 4 modes, anti-loop & NO_REPLY/duplicate suppression', async () => {
  const modelCalls = [];
  const rt = createBotRuntime({
    initialSeed: true,
    modelRunner: async ({ bot, conversation, latestUserMessage, internalDirective, hop }) => {
      modelCalls.push({ botId: bot.id, convId: conversation.id, internalDirective, hop });
      if (bot.id === 'helper' && conversation.id === 'group-team') {
        return { text: 'NO_REPLY' }; // 验证 NO_REPLY 静默吞掉
      }
      if (bot.id === 'planner' && /重复测试/.test(latestUserMessage?.content || '')) {
        return { text: '方案确定为先做数据库建模后做接口开发。' };
      }
      if (bot.id === 'designer' && /重复测试/.test(latestUserMessage?.content || '')) {
        return { text: '方案确定为先做数据库建模后做接口开发。' }; // 完全同义复读
      }
      return { text: `${bot.name}(${bot.id}) 的回应 [hop=${hop}]` };
    },
  });

  // 同一个 Bot 可建多个独立话题私聊
  const topicA = rt.conversationService.createPrivateTopicConversation({ botId: 'mova', topic: '架构方案' });
  const topicB = rt.conversationService.createPrivateTopicConversation({ botId: 'mova', topic: '周报整理' });
  assert.notEqual(topicA.id, topicB.id);

  // 同名 @ 结构化 ID 消歧：只触发被指定 ID 的那一个 Bot
  const dupA = rt.registry.createBot({ name: '评审官', tag: '编程' });
  const dupB = rt.registry.createBot({ name: '评审官', tag: '设计' });
  const dupGroup = rt.conversationService.createGroupConversation({
    title: '双同名评审群',
    groupMode: 'quiet', // 安静模式下只允许显式 @ 响应
    memberBotIds: [dupA.id, dupB.id],
  });

  const quietRes = await rt.runService.handleUserTurn({
    conversationId: dupGroup.id,
    content: '大家好，先打个招呼', // 无 @，安静模式应不触发任何 Bot
  });
  assert.equal(quietRes.emittedMessages.length, 0);

  const targetedRes = await rt.runService.handleUserTurn({
    conversationId: dupGroup.id,
    content: `@评审官 请审查代码`,
    mentions: [{ targetType: 'bot', targetId: dupB.id, displayText: '@评审官' }],
  });
  assert.equal(targetedRes.emittedMessages.length, 1);
  assert.equal(targetedRes.emittedMessages[0].senderId, dupB.id);

  // 讨论模式最多 MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN = 3
  rt.conversationService.setGroupMode('group-team', 'discussion');
  const discRes = await rt.runService.handleUserTurn({
    conversationId: 'group-team',
    content: '请各位讨论一下新版本发布节奏？',
  });
  assert.ok(discRes.emittedMessages.length <= rt.router.MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN + 1); // +1 为自动汇总共识卡
  assert.ok(!discRes.emittedMessages.some(m => m.senderId === 'helper' && m.content === 'NO_REPLY'));

  // 重复观点自动抑制（第二条与第一条完全相同的文本会被拦截）
  const repGroup = rt.conversationService.createGroupConversation({
    title: '防复读测试群',
    groupMode: 'discussion',
    memberBotIds: ['planner', 'designer'],
  });
  const repRes = await rt.runService.handleUserTurn({
    conversationId: repGroup.id,
    content: '重复测试一下',
  });
  const afterMsgs = rt.conversationService.getConversation(repGroup.id).messages.filter(
    m => m.senderType === 'bot' && !m.structuredPayload && m.sequence > repRes.userMessage.sequence,
  );
  assert.equal(afterMsgs.length, 1);
});

test('RunService: silent internal handoff, human preemption (version bump), provider transcript projection, consensus vote -> task', async () => {
  let resolveSlowRun;
  const slowStarted = new Promise(resolve => { resolveSlowRun = resolve; });
  let releaseSlowRun;
  const slowWait = new Promise(resolve => { releaseSlowRun = resolve; });

  const rt = createBotRuntime({
    initialSeed: true,
    modelRunner: async ({ bot, hop, internalDirective }) => {
      if (bot.id === 'mova' && hop === 0 && !internalDirective && /任务协同测试/.test('任务协同测试')) {
        // 触发 2 跳静默内部委派给 planner -> developer
        return {
          text: '我正在协调架构并推进子任务。',
          handoffTo: {
            receiverBotId: 'planner',
            goal: '给出阶段拆解',
            silentIntermediate: true,
          },
        };
      }
      if (bot.id === 'planner' && internalDirective) {
        return {
          text: '阶段一完成接口设计，阶段二完成联调。',
          handoffTo: {
            receiverBotId: 'developer',
            goal: '超出跳数上限测试',
            silentIntermediate: true,
          },
        };
      }
      if (bot.id === 'developer' && internalDirective) {
        return { text: '开发阶段估算 2 天。' };
      }
      if (bot.id === 'helper') {
        resolveSlowRun();
        await slowWait;
        return { text: '迟到的慢响应，应该因版本抢占而被丢弃' };
      }
      return { text: `${bot.name} 正常回应` };
    },
  });

  // 1. 任务模式下的内部多跳静默委派：agent_events 有记录，但 UI/聊天消息与检索中无中间内部传递
  const taskGrp = rt.conversationService.createGroupConversation({
    title: '任务协同组',
    groupMode: 'task',
    memberBotIds: ['mova', 'planner', 'developer'],
  });
  await rt.runService.handleUserTurn({
    conversationId: taskGrp.id,
    content: '帮我安排一次任务协同测试',
  });
  const convAfter = rt.conversationService.getConversation(taskGrp.id);
  const internalEvts = rt.router.listInternalEvents(taskGrp.id);
  assert.ok(internalEvts.length >= 1);
  assert.ok(internalEvts.every(e => e.visibility === 'internal'));
  // planner/developer 中间条不会变成普通聊天记录里的孤立内部消息
  assert.equal(convAfter.messages.some(m => m.visibility === 'internal'), false);
  // hop 限制 MAX_BOT_TO_BOT_HOPS = 2 不应无限循环
  assert.ok(internalEvts.length <= rt.router.MAX_BOT_TO_BOT_HOPS);

  // 2. 人优先打断抢占（conversation.version 推进导致在途慢响应落库失效）
  const slowChat = rt.conversationService.createPrivateTopicConversation({ botId: 'helper', topic: '打断测试' });
  const pendingTurn = rt.runService.handleUserTurn({
    conversationId: slowChat.id,
    content: '先跑一个很慢的任务',
    waitForCompletion: false,
  });
  await slowStarted;
  const vBefore = rt.conversationService.getConversation(slowChat.id).version;
  // 人工紧接着发一条打断消息
  rt.conversationService.addUserMessage({ conversationId: slowChat.id, content: '算了不用跑了，改需求！' });
  const vAfter = rt.conversationService.getConversation(slowChat.id).version;
  assert.ok(vAfter > vBefore);
  releaseSlowRun();
  await pendingTurn.pendingPromise;
  const msgsAfterAbort = rt.conversationService.getConversation(slowChat.id).messages;
  assert.equal(msgsAfterAbort.some(m => m.content.includes('迟到的慢响应')), false);

  // 3. Multi-party transcript 角色映射：当前 Bot -> assistant，其余 Bot -> user 带清晰身份标记
  const projected = projectMultiPartyTranscriptForProvider({
    activeBot: rt.registry.getBot('planner'),
    conversation: { id: 'c1', topic: '方案评审' },
    botsById: new Map(rt.registry.listBots().map(b => [b.id, b])),
    rawMessages: [
      { senderType: 'user', senderId: 'user', content: '大家怎么看？' },
      { senderType: 'bot', senderId: 'designer', senderNameSnapshot: '设计', content: '先定界面规范' },
      { senderType: 'bot', senderId: 'planner', senderNameSnapshot: '策划', content: '我补充里程碑' },
    ],
  });
  assert.equal(projected[0].role, 'user');
  assert.match(projected[0].content, /\[群成员发言 · 名字: 设计 \| ID: designer/);
  assert.equal(projected[1].role, 'assistant');
  assert.equal(projected[1].content, '我补充里程碑');
  assert.equal(projected.at(-1).role, 'user');

  // 4. 共识卡投票后转化为任务
  const cardMsg = rt.conversationService.createConsensusCardMessage({
    conversationId: taskGrp.id,
    proposerBotId: 'mova',
    title: '技术栈选型',
    consensusItems: ['优先本地持久化'],
    divergenceQuestion: '选用哪种打包策略？',
    options: [{ id: 'a', label: 'Electron + Vite' }, { id: 'b', label: '纯 Web' }],
    taskDraft: { title: '完成技术架构定型', goal: '输出架构文档' },
  });
  const voted = rt.conversationService.voteOrConfirmConsensusCard({
    conversationId: taskGrp.id,
    messageId: cardMsg.message.id,
    selectedOptionId: 'a',
    confirmTask: true,
  });
  assert.equal(voted.structuredPayload.confirmedAsTask, true);
  assert.equal(voted.structuredPayload.selectedOptionId, 'a');
});

test('RunService: <mova_bot_action> mini-app codegen trigger & null modelRunner fallback to defaultOfflineSynthesis', async () => {
  let codegenCalled = 0;
  const rt = createBotRuntime({
    initialSeed: true,
    modelRunner: async ({ latestUserMessage }) => {
      if (latestUserMessage.content.includes('回退本地')) return null;
      return {
        text: '已经为你规划好看板结构。<mova_bot_action>{"type":"incubate_mini_app","name":"迭代看板","summary":"跟踪本周迭代"}</mova_bot_action>',
      };
    },
  });
  rt.miniAppService.setCodeGenerator(async ({ spec }) => {
    codegenCalled += 1;
    return `<!doctype html><html><body><div>Custom-${spec.name}</div></body></html>`;
  });

  const chat = rt.conversationService.createPrivateTopicConversation({ botId: 'planner', topic: '小程序动作协议' });
  const r1 = await rt.sendUserMessage({ conversationId: chat.id, content: '帮我做一个迭代看板' });
  assert.equal(codegenCalled, 1);
  assert.equal(r1.emittedMessages.length, 1);
  assert.equal(r1.emittedMessages[0].structuredPayload?.type, 'mini_app_card');
  assert.equal(r1.emittedMessages[0].content, '已经为你规划好看板结构。');
  const appId = r1.emittedMessages[0].structuredPayload.appId;
  assert.match(rt.miniAppService.getApp(appId).entryHtml, /Custom-迭代看板/);

  // null modelRunner 时应走 defaultOfflineSynthesis 而非静默失败
  const r2 = await rt.sendUserMessage({ conversationId: chat.id, content: '回退本地合成测试' });
  assert.equal(r2.emittedMessages.length, 1);
  assert.match(r2.emittedMessages[0].content, /策划|Mova|已收到/);

  const parsed = parseBotActionDirectives('前置正文<mova_bot_action>{"type":"delegate_task","toBotId":"developer","goal":"联调"}</mova_bot_action>尾注');
  assert.equal(parsed.cleanText, '前置正文尾注');
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].toBotId, 'developer');
});
