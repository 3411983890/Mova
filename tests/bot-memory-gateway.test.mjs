/**
 * 负责：验证四层记忆体系隔离规则（Bot 独立记忆严格禁止他者直读）、群成员退群时间截断（不接收退群后记忆）、
 *   两阶段历史检索（chatHistorySearch 摘要 -> chatHistoryRead 原文片段，排除临时聊天与内部事件），
 *   以及跨 Bot 在共同群内可见 @ 问询与无共同群时的建群建议。
 * 不负责：SQLite/Postgres 底层连接测试。
 * 被谁调用：`node --test` 与 `scripts/accept.mjs`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRuntime } from '../electron/bots/runtime.mjs';
import { mapMemorySnapshotToExternalChats } from '../electron/bots/ipc.mjs';

test('MemoryGateway: strict Bot independent memory isolation & group leave time cutoff', () => {
  let now = 1_700_000_000_000;
  const rt = createBotRuntime({ clock: () => now, initialSeed: true });

  // Bot 独立记忆：helper 不能直读 planner 的独立记忆
  rt.memoryGateway.writeBotMemory({ botId: 'planner', category: 'fact', content: '用户喜欢靠窗座位与高铁出行' });
  const ownMem = rt.memoryGateway.queryBotMemories({ requesterBotId: 'planner', targetBotId: 'planner', query: '高铁' });
  assert.equal(ownMem.length, 1);

  assert.throws(
    () => rt.memoryGateway.queryBotMemories({ requesterBotId: 'helper', targetBotId: 'planner', query: '高铁' }),
    /严禁静默读取其他 Bot/,
  );

  // 群共享记忆与退群时间截断
  const grp = rt.conversationService.createGroupConversation({
    title: '项目周会群',
    memberBotIds: ['mova', 'helper'],
  });
  rt.conversationService.addUserMessage({ conversationId: grp.id, content: '早期共同讨论：接口规范v1' });
  rt.memoryGateway.writeGroupMemory({ groupId: grp.id, authorBotId: 'mova', category: 'fact', content: '早期共同决策：使用 RESTful API' });

  now += 10_000;
  rt.conversationService.removeGroupMember(grp.id, 'helper');

  now += 10_000;
  rt.conversationService.addUserMessage({ conversationId: grp.id, content: '退群后密语：预算上调至10万' });
  rt.memoryGateway.writeGroupMemory({ groupId: grp.id, authorBotId: 'mova', category: 'fact', content: '退群后新增群记忆：预算10万' });

  // 默认退群即无权访问群共享记忆；开启 retainGroupHistoryOnLeave 后也仅能读到退群前的群记忆
  assert.throws(
    () => rt.memoryGateway.queryGroupMemories({ requesterBotId: 'helper', groupId: grp.id }),
    /无权访问群/,
  );
  rt.registry.updateBot('helper', { memoryConfig: { retainGroupHistoryOnLeave: true } });
  const helperGroupMems = rt.memoryGateway.queryGroupMemories({ requesterBotId: 'helper', groupId: grp.id });
  assert.equal(helperGroupMems.length, 1);
  assert.match(helperGroupMems[0].content, /RESTful API/);
  assert.equal(helperGroupMems.some(m => m.content.includes('预算10万')), false);
});

test('MemoryGateway: two-stage chat history search (excludes temporary chats & internal events) & askPeerBotMemoryInSharedGroup', async () => {
  const externalMock = () => [
    {
      id: 'chat-main-1',
      title: '普通项目讨论',
      temporary: false,
      updatedAt: Date.now(),
      messages: [{ id: 'ext-m1', role: 'user', text: '匹配外部记录: 外部持久记录原文' }],
    },
    {
      id: 'chat-temp-99',
      title: '临时聊天',
      temporary: true,
      updatedAt: Date.now(),
      messages: [{ id: 'ext-tmp-1', role: 'user', text: '临时密码 外部记录 123456' }],
    },
  ];

  const rt = createBotRuntime({ initialSeed: true, externalChatProvider: externalMock });

  // Stage 1: 先按摘要检索，临时聊天被过滤
  const hits = rt.memoryGateway.chatHistorySearch({ requesterBotId: 'mova', query: '外部记录' });
  assert.ok(hits.items.some(h => h.conversationId === 'chat-main-1'));
  assert.equal(hits.items.some(h => h.conversationId === 'chat-temp-99'), false);

  // Stage 2: 按需调取原文窗口，临时聊天返回 null，普通对话返回原文窗口
  const tempDenied = rt.memoryGateway.chatHistoryRead({ requesterBotId: 'mova', conversationId: 'chat-temp-99', messageId: 'ext-tmp-1' });
  assert.equal(tempDenied, null);
  const mainRead = rt.memoryGateway.chatHistoryRead({ requesterBotId: 'mova', conversationId: 'chat-main-1', messageId: 'ext-m1' });
  assert.equal(mainRead.conversationId, 'chat-main-1');
  assert.match(mainRead.messages[0].text, /外部持久记录原文/);

  // 跨 Bot 同群问询 vs 无共同群建议
  const soloA = rt.registry.createBot({ name: '孤立助手A' });
  const soloB = rt.registry.createBot({ name: '孤立助手B' });
  rt.memoryGateway.writeBotMemory({ botId: soloB.id, category: 'preference', content: '偏好使用深色模式界面' });

  // 情况 1：不在同一个群 -> 返回 no_shared_group 与建群建议
  const noGroupRes = await rt.memoryGateway.askPeerBotMemoryInSharedGroup({
    fromBotId: soloA.id,
    toBotId: soloB.id,
    question: '用户偏好什么主题？',
    postBotMessage: async p => rt.conversationService.addBotMessage(p).message,
  });
  assert.equal(noGroupRes.status, 'no_shared_group');
  assert.equal(noGroupRes.suggestedAction, 'create_group');

  // 情况 2：在同一个群内 -> 发起公开可见 @ 问询，并由目标 Bot 使用自己的独立记忆公开作答
  const sharedGrp = rt.conversationService.createGroupConversation({
    title: '记忆协作群',
    memberBotIds: [soloA.id, soloB.id],
  });
  const sharedRes = await rt.memoryGateway.askPeerBotMemoryInSharedGroup({
    fromBotId: soloA.id,
    toBotId: soloB.id,
    question: '深色模式',
    currentConversationId: sharedGrp.id,
    postBotMessage: async p => rt.conversationService.addBotMessage(p).message,
  });
  assert.equal(sharedRes.status, 'answered_in_group');
  assert.match(sharedRes.questionMessage.content, /@孤立助手B/);
  assert.match(sharedRes.answerMessage.content, /深色模式/);
  const visibleMsgs = rt.conversationService.getConversation(sharedGrp.id).messages;
  assert.equal(visibleMsgs.length, 3); // 建群欢迎语 + 公开提问 + 公开作答
});

test('Store PG dual-write & memoryRepository externalChatProvider snapshot mapping', async () => {
  const queries = [];
  const fakePool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  let poolReady = false;
  const rt = createBotRuntime({
    initialSeed: true,
    pgPool: () => (poolReady ? fakePool : null),
  });
  poolReady = true;
  rt.registry.createBot({ name: 'PG同步测试员', tag: '存储' });
  await rt.store.flushPgSync();

  assert.ok(queries.some(q => /CREATE TABLE IF NOT EXISTS mova_bot_state_kv/i.test(q.sql)));
  const upsert = queries.find(q => /INSERT INTO mova_bot_state_kv/i.test(q.sql));
  assert.ok(upsert);
  assert.equal(upsert.params[0], 'primary');
  assert.match(upsert.params[1], /PG同步测试员/);

  const mapped = mapMemorySnapshotToExternalChats({
    sessions: {
      conversations: [
        ['["ChatMova","default","工作规划"]', {
          title: 'Q4 工作规划',
          updatedAt: 1_700_000_000_000,
          messages: [
            { id: 'u1', role: 'user', text: '确定下季度主打指标', reply: { text: '建议聚焦留存与转化率' } },
            { id: 'u2', role: 'user', text: 'mock 噪声', mock: true },
          ],
        }],
        ['["Temporary","default","临时对话"]', {
          temporary: true,
          messages: [{ id: 't1', role: 'user', text: '绝不能索引的临时内容' }],
        }],
      ],
    },
  });
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].title, 'Q4 工作规划');
  assert.equal(mapped[0].messages.length, 2);
  assert.equal(mapped[0].messages[0].role, 'user');
  assert.equal(mapped[0].messages[1].role, 'assistant');
});
