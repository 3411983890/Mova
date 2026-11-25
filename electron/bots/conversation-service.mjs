/**
 * 负责：管理 Bot 私聊（支持单 Bot 多话题会话）与多 Bot 群聊的会话生命周期、稳定 ID 成员关系、群聊模式切换（安静/自然/讨论/任务）、结构化 @ 提及解析、人工打断与会话版本抢占，以及群聊共识卡/分歧投票卡。
 * 不负责：模型推理、权限裁剪或跨群记忆检索（这些由 run-service、router、memory-gateway 负责）。
 * 被谁调用：electron/bots/runtime.mjs、electron/bots/router.mjs、electron/bots/run-service.mjs、electron/bots/ipc.mjs 及测试。
 */
import { cloneJson, generateId } from './store.mjs';

export const GROUP_MODES = ['quiet', 'natural', 'discussion', 'task'];

export function createConversationService(store) {
  const clock = store.clock;

  function activeMembersForConversation(conversationId) {
    return store.state.conversationMembers
      .filter(m => m.conversationId === conversationId && !m.leftAt)
      .map(cloneJson);
  }

  function hydrateConversation(conv) {
    if (!conv) return null;
    const members = activeMembersForConversation(conv.id).filter(m => m.memberType === 'bot');
    const messages = store.state.messages
      .filter(m => m.conversationId === conv.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map(msg => {
        const mentions = store.state.messageMentions
          .filter(mt => mt.messageId === msg.id)
          .map(cloneJson);
        return {
          ...cloneJson(msg),
          mentions,
        };
      });

    const activeTasks = store.state.tasks.filter(
      t => t.conversationId === conv.id && ['running', 'waiting_info', 'waiting_approval', 'waiting_resource'].includes(t.status),
    );
    const pendingApprovals = store.state.approvalRequests.filter(
      a => a.conversationId === conv.id && a.status === 'pending',
    );

    return {
      ...cloneJson(conv),
      memberBotIds: members.map(m => m.memberId),
      members,
      messages,
      isWorking: activeTasks.length > 0,
      activeTaskCount: activeTasks.length,
      pendingApprovalCount: pendingApprovals.length,
    };
  }

  function listConversations({ filter = 'all' } = {}) {
    const hydrated = store.state.conversations
      .map(hydrateConversation)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);

    if (filter === 'unread') return hydrated.filter(c => c.unread > 0);
    if (filter === 'groups') return hydrated.filter(c => c.type === 'group');
    if (filter === 'working') return hydrated.filter(c => c.isWorking || c.pendingApprovalCount > 0);
    return hydrated;
  }

  function getConversation(conversationId) {
    const conv = store.state.conversations.find(c => c.id === conversationId);
    return hydrateConversation(conv);
  }

  function createPrivateTopicConversation({ botId, title = null, topic = '新话题' }) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`Bot 不存在: ${botId}`);

    return store.mutate(state => {
      const now = clock();
      const id = generateId('chat');
      const conv = {
        id,
        type: 'private',
        botId: bot.id,
        title: title ? String(title).trim() : `${bot.name} · ${topic}`,
        topic: String(topic || '新话题').trim(),
        groupMode: 'natural',
        pinned: false,
        muted: false,
        unread: 0,
        version: 1,
        activeGoal: null,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      };
      state.conversations.unshift(conv);
      state.conversationMembers.push(
        { conversationId: id, memberType: 'user', memberId: 'user', role: 'owner', joinedAt: now, leftAt: null },
        { conversationId: id, memberType: 'bot', memberId: bot.id, role: 'lead', joinedAt: now, leftAt: null },
      );
      state.messages.push({
        id: generateId('msg'),
        conversationId: id,
        sequence: 1,
        senderType: 'bot',
        senderId: bot.id,
        senderNameSnapshot: bot.name,
        replyToMessageId: null,
        content: bot.description ? `已围绕「${conv.topic}」开启新话题。${bot.tagline || ''}`.trim() : `你好，我是${bot.name}，我们开始「${conv.topic}」吧。`,
        structuredPayload: null,
        attachments: [],
        status: 'done',
        runId: null,
        conversationVersion: 1,
        createdAt: now,
      });
      return hydrateConversation(conv);
    });
  }

  function getOrCreatePrivateConversation(botId) {
    const existing = store.state.conversations.find(c => c.type === 'private' && c.botId === botId);
    if (existing) return hydrateConversation(existing);
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`Bot 不存在: ${botId}`);
    return createPrivateTopicConversation({ botId, title: bot.name, topic: '默认对话' });
  }

  function createGroupConversation({
    title,
    botIds = [],
    memberBotIds = [],
    groupMode = 'natural',
    topic = '',
    color = '#a7c9f4',
    place = null,
    leadBotId = null,
  }) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('群聊名称不能为空');
    const requestedIds = Array.isArray(botIds) && botIds.length ? botIds : memberBotIds;
    const uniqueBotIds = [...new Set(requestedIds)].filter(id => store.state.bots.some(b => b.id === id));
    if (uniqueBotIds.length < 2) throw new Error('群聊至少需要 2 个有效 Bot 成员');
    const mode = GROUP_MODES.includes(groupMode) ? groupMode : 'natural';

    return store.mutate(state => {
      const now = clock();
      const id = generateId('group');
      const conv = {
        id,
        type: 'group',
        botId: null,
        title: cleanTitle.slice(0, 40),
        topic: String(topic || '').trim(),
        groupMode: mode,
        color,
        place,
        pinned: false,
        muted: false,
        unread: 0,
        version: 1,
        activeGoal: null,
        metadata: place?.origin ? { cloudSince: now } : {},
        createdAt: now,
        updatedAt: now,
      };
      state.conversations.unshift(conv);
      state.conversationMembers.push({
        conversationId: id,
        memberType: 'user',
        memberId: 'user',
        role: 'owner',
        joinedAt: now,
        leftAt: null,
      });

      const resolvedLead = leadBotId && uniqueBotIds.includes(leadBotId) ? leadBotId : uniqueBotIds[0];
      const names = [];
      for (const bid of uniqueBotIds) {
        const bot = state.bots.find(b => b.id === bid);
        if (bot) names.push(bot.name);
        state.conversationMembers.push({
          conversationId: id,
          memberType: 'bot',
          memberId: bid,
          role: bid === resolvedLead ? 'lead' : 'member',
          joinedAt: now,
          leftAt: null,
        });
      }

      const firstBot = state.bots.find(b => b.id === resolvedLead);
      state.messages.push({
        id: generateId('msg'),
        conversationId: id,
        sequence: 1,
        senderType: 'bot',
        senderId: resolvedLead,
        senderNameSnapshot: firstBot?.name || 'Bot',
        replyToMessageId: null,
        content: `「${cleanTitle}」建好了（当前模式：${mode}），${names.join('、')} 都在这里。`,
        structuredPayload: null,
        attachments: [],
        status: 'done',
        runId: null,
        conversationVersion: 1,
        createdAt: now,
      });

      return hydrateConversation(conv);
    });
  }

  function addGroupMembers(conversationId, botIds = []) {
    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId && c.type === 'group');
      if (!conv) throw new Error(`群聊不存在: ${conversationId}`);
      const now = clock();
      for (const bid of botIds) {
        if (!state.bots.some(b => b.id === bid)) continue;
        const existing = state.conversationMembers.find(
          m => m.conversationId === conversationId && m.memberType === 'bot' && m.memberId === bid,
        );
        if (existing) {
          existing.leftAt = null;
          existing.joinedAt = now;
        } else {
          state.conversationMembers.push({
            conversationId,
            memberType: 'bot',
            memberId: bid,
            role: 'member',
            joinedAt: now,
            leftAt: null,
          });
        }
      }
      conv.updatedAt = now;
      return hydrateConversation(conv);
    });
  }

  function removeGroupMember(conversationId, botId) {
    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId && c.type === 'group');
      if (!conv) throw new Error(`群聊不存在: ${conversationId}`);
      const member = state.conversationMembers.find(
        m => m.conversationId === conversationId && m.memberType === 'bot' && m.memberId === botId && !m.leftAt,
      );
      if (member) {
        member.leftAt = clock();
        conv.updatedAt = clock();
      }
      return hydrateConversation(conv);
    });
  }

  function setMemberRole(conversationId, botId, role = 'lead') {
    return store.mutate(state => {
      const members = state.conversationMembers.filter(
        m => m.conversationId === conversationId && m.memberType === 'bot' && !m.leftAt,
      );
      if (role === 'lead') {
        for (const m of members) m.role = m.memberId === botId ? 'lead' : 'member';
      } else {
        const target = members.find(m => m.memberId === botId);
        if (target) target.role = role;
      }
      return getConversation(conversationId);
    });
  }

  function setGroupMode(conversationId, groupMode) {
    if (!GROUP_MODES.includes(groupMode)) throw new Error(`无效群聊模式: ${groupMode}`);
    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId);
      if (!conv) throw new Error(`会话不存在: ${conversationId}`);
      conv.groupMode = groupMode;
      conv.updatedAt = clock();
      return hydrateConversation(conv);
    });
  }

  function updateConversationMeta(conversationId, patch = {}) {
    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId);
      if (!conv) throw new Error(`会话不存在: ${conversationId}`);
      if (patch.title !== undefined && String(patch.title).trim()) conv.title = String(patch.title).trim().slice(0, 40);
      if (patch.topic !== undefined) conv.topic = String(patch.topic).trim();
      if (typeof patch.pinned === 'boolean') conv.pinned = patch.pinned;
      if (typeof patch.muted === 'boolean') conv.muted = patch.muted;
      if (patch.place !== undefined) {
        if (patch.place?.origin !== conv.place?.origin) {
          (conv.metadata ??= {}).cloudSince = patch.place?.origin ? clock() : null;
          conv.version += 1;
        }
        conv.place = patch.place;
      }
      if (patch.groupMode && GROUP_MODES.includes(patch.groupMode)) conv.groupMode = patch.groupMode;
      if (patch.activeGoal !== undefined) {
        conv.activeGoal = patch.activeGoal;
        conv.version += 1;
      }
      conv.updatedAt = clock();
      return hydrateConversation(conv);
    });
  }

  function markConversationRead(conversationId) {
    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId);
      if (!conv) return false;
      conv.unread = 0;
      return true;
    });
  }

  function deleteConversation(conversationId) {
    return store.mutate(state => {
      const idx = state.conversations.findIndex(c => c.id === conversationId);
      if (idx < 0) return false;
      state.conversations.splice(idx, 1);
      const msgIds = new Set(state.messages.filter(m => m.conversationId === conversationId).map(m => m.id));
      state.messages = state.messages.filter(m => m.conversationId !== conversationId);
      state.messageMentions = state.messageMentions.filter(mt => !msgIds.has(mt.messageId));
      state.conversationMembers = state.conversationMembers.filter(cm => cm.conversationId !== conversationId);
      return true;
    });
  }

  /**
   * 仅从文本提取未显式带 targetId 的 @ 提及（如 "@策划#a1b2c3" 或唯一同名 "@策划"）；
   * 当 UI 通过 @ 弹层选中时，优先信赖显式传入的 structured mentions[{ targetId, ... }]，彻底解决同名消歧。
   */
  function resolveMentions(conversationId, content, explicitMentions = []) {
    const resolved = [];
    const seenIds = new Set();

    const activeMemberBotIds = new Set(
      store.state.conversationMembers
        .filter(m => m.conversationId === conversationId && m.memberType === 'bot' && !m.leftAt)
        .map(m => m.memberId),
    );
    const activeBots = store.state.bots.filter(b => activeMemberBotIds.has(b.id));

    if (Array.isArray(explicitMentions)) {
      for (const m of explicitMentions) {
        if (!m?.targetId || seenIds.has(m.targetId)) continue;
        const bot = store.state.bots.find(b => b.id === m.targetId);
        if (!bot) continue;
        seenIds.add(bot.id);
        resolved.push({
          id: generateId('mnt'),
          targetType: 'bot',
          targetId: bot.id,
          displayText: m.displayText || `@${bot.name}`,
          startOffset: Number(m.startOffset || 0),
          endOffset: Number(m.endOffset || 0),
        });
      }
    }

    // 扫描文本里的 @Name#shortId 或 @Name（优先在当前群活跃成员内解析；同名且未带 shortId 且无 explicit 时才按文本精确匹配）
    const regex = /@([^\s@#，。！？,.!?:：]+)(?:#([A-Za-z0-9_-]{4,16}))?/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const tokenName = match[1];
      const shortId = match[2];
      let candidates = activeBots.filter(b => b.name === tokenName || b.handle === tokenName);
      if (!candidates.length) {
        candidates = store.state.bots.filter(b => b.name === tokenName || b.handle === tokenName);
      }
      if (shortId) {
        candidates = candidates.filter(b => b.id.endsWith(shortId) || b.id === shortId);
      }
      // 如果已有 explicit mentions 涵盖了相同的位置或名称，就不重复匹配同名的另一个 Bot
      const alreadyMatchedOffset = resolved.some(
        r => Math.abs(r.startOffset - match.index) <= 1,
      );
      if (alreadyMatchedOffset) continue;

      if (candidates.length === 1 && !seenIds.has(candidates[0].id)) {
        seenIds.add(candidates[0].id);
        resolved.push({
          id: generateId('mnt'),
          targetType: 'bot',
          targetId: candidates[0].id,
          displayText: match[0],
          startOffset: match.index,
          endOffset: match.index + match[0].length,
        });
      }
    }

    return resolved;
  }

  /**
   * 人工发送消息：递增会话版本（conversation.version += 1）以实现人优先抢占，使旧版本的在途运行自动失效。
   */
  function addUserMessage({
    conversationId,
    content,
    mentions = [],
    replyToMessageId = null,
    attachments = [],
  }) {
    const text = String(content || '').trim();
    if (!text && !attachments.length) throw new Error('消息内容不能为空');

    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId);
      if (!conv) throw new Error(`会话不存在: ${conversationId}`);
      const now = clock();
      conv.version += 1;
      conv.updatedAt = now;
      conv.unread = 0;

      const msgId = generateId('msg');
      const seq = store.nextSequence(conversationId);
      const resolvedMentions = resolveMentions(conversationId, text, mentions);

      const message = {
        id: msgId,
        conversationId,
        sequence: seq,
        senderType: 'user',
        senderId: 'user',
        senderNameSnapshot: '你',
        replyToMessageId,
        content: text,
        structuredPayload: null,
        attachments: cloneJson(attachments),
        status: 'done',
        runId: null,
        conversationVersion: conv.version,
        createdAt: now,
      };
      state.messages.push(message);
      for (const mt of resolvedMentions) {
        state.messageMentions.push({ ...mt, messageId: msgId, conversationId });
      }
      return {
        message: { ...cloneJson(message), mentions: resolvedMentions },
        conversationVersion: conv.version,
      };
    });
  }

  /** 人工主动中断或改目标，同样递增 conversationVersion 并抢占当前轮。 */
  function bumpConversationVersion(conversationId) {
    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId);
      if (!conv) return null;
      conv.version += 1;
      conv.updatedAt = clock();
      return conv.version;
    });
  }

  function addBotMessage({
    conversationId,
    botId,
    content = '',
    mentions = [],
    replyToMessageId = null,
    structuredPayload = null,
    runId = null,
    expectedConversationVersion = null,
    incrementUnread = false,
  }) {
    return store.mutate(state => {
      const conv = state.conversations.find(c => c.id === conversationId);
      if (!conv) throw new Error(`会话不存在: ${conversationId}`);
      if (expectedConversationVersion !== null && conv.version !== expectedConversationVersion) {
        return { preempted: true, message: null, currentVersion: conv.version };
      }

      const bot = state.bots.find(b => b.id === botId);
      const now = clock();
      conv.updatedAt = now;
      if (incrementUnread) conv.unread = (conv.unread || 0) + 1;

      const msgId = generateId('msg');
      const seq = store.nextSequence(conversationId);
      const resolvedMentions = resolveMentions(conversationId, content, mentions);
      const message = {
        id: msgId,
        conversationId,
        sequence: seq,
        senderType: botId === 'system' ? 'system' : 'bot',
        senderId: botId,
        senderNameSnapshot: bot?.name || (botId === 'system' ? '系统' : 'Bot'),
        replyToMessageId,
        content: String(content || ''),
        structuredPayload: cloneJson(structuredPayload),
        attachments: [],
        status: 'done',
        runId,
        conversationVersion: conv.version,
        createdAt: now,
      };
      state.messages.push(message);
      for (const mt of resolvedMentions) {
        state.messageMentions.push({ ...mt, messageId: msgId, conversationId });
      }

      if (bot) {
        bot.lastUsedAt = now;
        bot.usage.messages = (bot.usage.messages || 0) + 1;
        if (Array.isArray(bot.usage.daily) && bot.usage.daily.length > 0) {
          bot.usage.daily[bot.usage.daily.length - 1] += 1;
        }
      }

      return {
        preempted: false,
        message: { ...cloneJson(message), mentions: resolvedMentions },
      };
    });
  }

  /**
   * 群聊共识卡 & 分歧投票卡（§5.5 & §13.3）
   */
  function createConsensusCardMessage({
    conversationId,
    proposerBotId,
    title,
    summary = '',
    consensusItems = [],
    divergenceQuestion = '',
    options = [],
    recommendedOptionId = null,
    taskDraft = null,
    expectedConversationVersion = null,
  }) {
    const payload = {
      type: 'consensus_card',
      cardId: generateId('card'),
      title: String(title || '群聊共识与分歧确认'),
      summary: String(summary || ''),
      consensusItems: consensusItems.map(item => String(item)),
      divergenceQuestion: String(divergenceQuestion || ''),
      options: options.map((opt, idx) => ({
        id: opt.id || `opt_${idx + 1}`,
        label: String(opt.label || opt),
        proposerBotId: opt.proposerBotId || null,
        proposerName: opt.proposerName || null,
        votes: Array.isArray(opt.votes) ? opt.votes : [],
      })),
      recommendedOptionId,
      selectedOptionId: null,
      confirmedAsTask: false,
      taskId: null,
      taskDraft,
    };

    const content = [
      `【${payload.title}】`,
      summary,
      consensusItems.length ? `已达成共识：${consensusItems.join('；')}` : '',
      divergenceQuestion ? `待你拍板：${divergenceQuestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return addBotMessage({
      conversationId,
      botId: proposerBotId,
      content,
      structuredPayload: payload,
      expectedConversationVersion,
    });
  }

  function voteOrConfirmConsensusCard({ conversationId, messageId, selectedOptionId, confirmTask = false }) {
    return store.mutate(state => {
      const msg = state.messages.find(m => m.id === messageId && m.conversationId === conversationId);
      if (!msg || msg.structuredPayload?.type !== 'consensus_card') {
        throw new Error('未找到对应的群聊共识卡片');
      }
      const card = msg.structuredPayload;
      if (selectedOptionId) {
        const option = card.options.find(o => o.id === selectedOptionId);
        if (!option) throw new Error(`选项不存在: ${selectedOptionId}`);
        for (const o of card.options) {
          o.votes = (o.votes || []).filter(v => v !== 'user');
        }
        option.votes.push('user');
        card.selectedOptionId = selectedOptionId;
      }
      if (confirmTask) {
        card.confirmedAsTask = true;
      }
      return cloneJson(msg);
    });
  }

  return {
    GROUP_MODES,
    listConversations,
    getConversation,
    createPrivateTopicConversation,
    getOrCreatePrivateConversation,
    createGroupConversation,
    addGroupMembers,
    removeGroupMember,
    setMemberRole,
    setGroupMode,
    updateConversationMeta,
    markConversationRead,
    deleteConversation,
    resolveMentions,
    addUserMessage,
    bumpConversationVersion,
    addBotMessage,
    createConsensusCardMessage,
    voteOrConfirmConsensusCard,
  };
}
