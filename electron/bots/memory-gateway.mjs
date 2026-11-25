/**
 * 负责：实现 Mova Bot 的四层记忆网关与两阶段全量历史检索（群共享记忆、全量聊天历史两阶段检索、Bot 独立记忆严格隔离及同群可见 @ 互问机制、人设与关系记忆），以及去重/冲突替换/置顶编辑等记忆治理能力。
 * 不负责：LLM 回复生成或隐藏任务委派事件路由（仅读取独立/群记忆供上下文注入，且绝不暴露 internal 事件）。
 * 被谁调用：electron/bots/run-service.mjs、electron/bots/runtime.mjs、electron/bots/ipc.mjs、Bot 工具包及测试。
 */
import { cloneJson, generateId } from './store.mjs';

function normalizeTokens(query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return [];
  const words = raw.split(/[\s,，。；;、！？!?/|]+/).filter(Boolean);
  const tokens = new Set(words);
  // 针对连续中文短句增加 2-gram 匹配支持，确保无分词器时也可精准召回
  if (raw.length >= 2) {
    tokens.add(raw);
    for (const part of words) {
      if (part.length >= 3 && /[\u4e00-\u9fa5]/.test(part)) {
        for (let i = 0; i <= part.length - 2; i += 1) {
          tokens.add(part.slice(i, i + 2));
        }
      }
    }
  }
  return [...tokens];
}

function scoreText(text, tokens, queryRaw) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return 0;
  if (!tokens.length) return 0.5;
  let hits = 0;
  for (const token of tokens) {
    if (lower.includes(token)) hits += token.length >= 4 ? 1.5 : 1;
  }
  if (queryRaw && lower.includes(queryRaw.toLowerCase())) hits += 3;
  return hits / Math.max(1, tokens.length);
}

function makeSnippet(text, query) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 160) return clean;
  const idx = query ? clean.toLowerCase().indexOf(String(query).toLowerCase()) : -1;
  if (idx < 0) return `${clean.slice(0, 150)}…`;
  const start = Math.max(0, idx - 40);
  const end = Math.min(clean.length, start + 150);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

export function createMemoryGateway(
  store,
  {
    /**
     * 可选外部主对话记录提供者（返回用户主聊天区中已保存、非临时、非保密柜的对话数组）：
     * 格式 [{ id, title, temporary, archived, messages: [{ id, role, text, senderName, createdAt }] }]
     */
    externalChatProvider = null,
  } = {},
) {
  const clock = store.clock;

  function activeMembership(conversationId, botId) {
    return store.state.conversationMembers.find(
      m => m.conversationId === conversationId && m.memberType === 'bot' && m.memberId === botId && !m.leftAt,
    );
  }

  function latestMembership(conversationId, botId) {
    return store.state.conversationMembers.find(
      m => m.conversationId === conversationId && m.memberType === 'bot' && m.memberId === botId,
    );
  }

  // ── 1. 群共享记忆（按群成员自动同步，跨群/退群严格隔离） ─────────────────

  function writeGroupMemory({
    groupId,
    authorBotId,
    content,
    summary = null,
    category = 'fact',
    importance = 0.6,
    confidence = 0.85,
    sourceMessageId = null,
    pinned = false,
  }) {
    const conv = store.state.conversations.find(c => c.id === groupId && c.type === 'group');
    if (!conv) throw new Error(`群聊不存在: ${groupId}`);

    if (authorBotId !== 'user' && !activeMembership(groupId, authorBotId)) {
      const err = new Error(`Bot ${authorBotId} 不是群 ${groupId} 的活跃成员，无权写入群共享记忆`);
      err.code = 'ERR_GROUP_MEMORY_FORBIDDEN';
      throw err;
    }

    const cleanContent = String(content || '').trim();
    if (!cleanContent) throw new Error('记忆内容不能为空');

    return store.mutate(state => {
      const now = clock();
      const dup = state.memories.find(
        m => m.scopeType === 'group' && m.groupId === groupId && !m.supersededBy && m.content.trim() === cleanContent,
      );
      if (dup) {
        dup.updatedAt = now;
        dup.importance = Math.max(dup.importance, importance);
        if (pinned) dup.pinned = true;
        return cloneJson(dup);
      }

      const item = {
        id: generateId('mem'),
        scopeType: 'group',
        scopeId: groupId,
        botId: authorBotId === 'user' ? null : authorBotId,
        groupId,
        category,
        content: cleanContent,
        summary: summary || cleanContent.slice(0, 80),
        importance,
        confidence,
        supersededBy: null,
        sourceConversationId: groupId,
        sourceMessageId,
        pinned: Boolean(pinned),
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
      };
      state.memories.unshift(item);
      return cloneJson(item);
    });
  }

  function queryGroupMemories({ groupId, requesterBotId, query = '', limit = 20 }) {
    const conv = store.state.conversations.find(c => c.id === groupId && c.type === 'group');
    if (!conv) return [];

    let cutoffTimestamp = Infinity;
    if (requesterBotId !== 'user') {
      const active = activeMembership(groupId, requesterBotId);
      if (!active) {
        const former = latestMembership(groupId, requesterBotId);
        const requesterBot = store.state.bots.find(b => b.id === requesterBotId);
        if (!former || !requesterBot?.memoryConfig?.retainGroupHistoryOnLeave) {
          const err = new Error(`Bot ${requesterBotId} 无权访问群 ${groupId} 的共享记忆`);
          err.code = 'ERR_GROUP_MEMORY_FORBIDDEN';
          throw err;
        }
        // 已退群且允许保留历史上下文时，也严格止步于 leftAt，绝不能读到退群后的新群记忆
        cutoffTimestamp = former.leftAt;
      }
    }

    const tokens = normalizeTokens(query);
    return store.state.memories
      .filter(m => m.scopeType === 'group' && m.groupId === groupId && !m.supersededBy)
      .filter(m => m.createdAt <= cutoffTimestamp)
      .filter(m => !m.expiresAt || m.expiresAt > clock())
      .map(m => ({
        ...cloneJson(m),
        score: scoreText(`${m.content} ${m.summary || ''}`, tokens, query) + (m.pinned ? 0.5 : 0),
      }))
      .filter(m => !tokens.length || m.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  // ── 2. Bot 独立记忆（严格隔离，禁止跨 Bot 静默检索或复制） ──────────────

  function writeBotMemory({
    botId,
    content,
    summary = null,
    category = 'fact',
    importance = 0.6,
    confidence = 0.85,
    sourceConversationId = null,
    sourceMessageId = null,
    pinned = false,
    supersedesMemoryId = null,
  }) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`Bot 不存在: ${botId}`);
    const cleanContent = String(content || '').trim();
    if (!cleanContent) throw new Error('记忆内容不能为空');

    return store.mutate(state => {
      const now = clock();
      const dup = state.memories.find(
        m => m.scopeType === 'bot' && m.botId === botId && !m.supersededBy && m.content.trim() === cleanContent,
      );
      if (dup) {
        dup.updatedAt = now;
        dup.importance = Math.max(dup.importance, importance);
        if (pinned) dup.pinned = true;
        return cloneJson(dup);
      }

      const item = {
        id: generateId('mem'),
        scopeType: 'bot',
        scopeId: botId,
        botId,
        groupId: null,
        category,
        content: cleanContent,
        summary: summary || cleanContent.slice(0, 80),
        importance,
        confidence,
        supersededBy: null,
        sourceConversationId,
        sourceMessageId,
        pinned: Boolean(pinned),
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
      };
      if (supersedesMemoryId) {
        const prev = state.memories.find(m => m.id === supersedesMemoryId && m.botId === botId);
        if (prev) prev.supersededBy = item.id;
      }
      state.memories.unshift(item);
      return cloneJson(item);
    });
  }

  function queryBotMemories({ requesterBotId, targetBotId, query = '', limit = 20 }) {
    if (requesterBotId !== 'user' && requesterBotId !== targetBotId) {
      const err = new Error(`严禁静默读取其他 Bot（${targetBotId}）的独立记忆；必须通过同群可见 @ 提问获取`);
      err.code = 'ERR_CROSS_BOT_MEMORY_FORBIDDEN';
      throw err;
    }

    const tokens = normalizeTokens(query);
    return store.state.memories
      .filter(m => m.scopeType === 'bot' && m.botId === targetBotId && !m.supersededBy)
      .filter(m => !m.expiresAt || m.expiresAt > clock())
      .map(m => ({
        ...cloneJson(m),
        score: scoreText(`${m.content} ${m.summary || ''}`, tokens, query) + (m.pinned ? 0.5 : 0),
      }))
      .filter(m => !tokens.length || m.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  function updateMemory(memoryId, { requesterId = 'user', patch = {} }) {
    return store.mutate(state => {
      const mem = state.memories.find(m => m.id === memoryId);
      if (!mem) throw new Error(`记忆不存在: ${memoryId}`);
      if (requesterId !== 'user' && mem.scopeType === 'bot' && mem.botId !== requesterId) {
        const err = new Error('无权修改其他 Bot 的独立记忆');
        err.code = 'ERR_CROSS_BOT_MEMORY_FORBIDDEN';
        throw err;
      }
      if (patch.content !== undefined) mem.content = String(patch.content).trim();
      if (patch.summary !== undefined) mem.summary = String(patch.summary).trim();
      if (typeof patch.pinned === 'boolean') mem.pinned = patch.pinned;
      if (typeof patch.importance === 'number') mem.importance = patch.importance;
      mem.updatedAt = clock();
      return cloneJson(mem);
    });
  }

  function deleteMemory(memoryId, { requesterId = 'user' } = {}) {
    return store.mutate(state => {
      const idx = state.memories.findIndex(m => m.id === memoryId);
      if (idx < 0) return false;
      const mem = state.memories[idx];
      if (requesterId !== 'user' && mem.scopeType === 'bot' && mem.botId !== requesterId) {
        const err = new Error('无权删除其他 Bot 的独立记忆');
        err.code = 'ERR_CROSS_BOT_MEMORY_FORBIDDEN';
        throw err;
      }
      state.memories.splice(idx, 1);
      return true;
    });
  }

  function listMemories({ scopeType = null, scopeId = null, requesterBotId = 'user', query = '', limit = 50 } = {}) {
    if (scopeType === 'bot' && scopeId) {
      return queryBotMemories({ requesterBotId, targetBotId: scopeId, query, limit });
    }
    if (scopeType === 'group' && scopeId) {
      return queryGroupMemories({ groupId: scopeId, requesterBotId, query, limit });
    }
    if (requesterBotId !== 'user') {
      // 非用户直接请求全局列出时，只返回请求者自身独立记忆与当前所属群聊共享记忆
      const myGroups = new Set(
        store.state.conversationMembers
          .filter(m => m.memberType === 'bot' && m.memberId === requesterBotId && !m.leftAt)
          .map(m => m.conversationId),
      );
      return store.state.memories
        .filter(m => !m.supersededBy)
        .filter(m => (m.scopeType === 'bot' && m.botId === requesterBotId) || (m.scopeType === 'group' && myGroups.has(m.groupId)))
        .slice(0, limit)
        .map(cloneJson);
    }
    return store.state.memories.filter(m => !m.supersededBy).slice(0, limit).map(cloneJson);
  }

  /**
   * 跨 Bot 独立记忆可见问询机制（§6.1 & §13.4）：
   * 1. 查找双方同为活跃成员的群聊（优先当前群）；
   * 2. 若无共同群聊，返回 no_shared_group 与建群建议（绝不静默偷读）；
   * 3. 若有共同群聊，由 fromBot 在群内发出带结构化 @toBot 的可见消息，触发 toBot 用自身独立记忆作答并发表可见回复。
   */
  async function askPeerBotMemoryInSharedGroup({
    fromBotId,
    toBotId,
    question,
    currentConversationId = null,
    postBotMessage,
    generatePeerAnswer = null,
  }) {
    const fromBot = store.state.bots.find(b => b.id === fromBotId);
    const toBot = store.state.bots.find(b => b.id === toBotId);
    if (!fromBot || !toBot) throw new Error('提问或受访 Bot 不存在');
    if (fromBotId === toBotId) throw new Error('不能向自己发起跨 Bot 询问');

    const groupCandidates = store.state.conversations
      .filter(c => c.type === 'group')
      .filter(c => activeMembership(c.id, fromBotId) && activeMembership(c.id, toBotId))
      .sort((a, b) => Number(b.id === currentConversationId) - Number(a.id === currentConversationId) || b.updatedAt - a.updatedAt);

    if (!groupCandidates.length) {
      return {
        status: 'no_shared_group',
        suggestedAction: 'create_group',
        fromBotId,
        toBotId,
        toBotName: toBot.name,
        message: `我无法直接读取「${toBot.name}」的独立记忆，且我们目前不在同一个群聊中。建议将我和「${toBot.name}」拉入同一个群聊后，我再在群里公开 @ 它询问。`,
      };
    }

    const targetGroup = groupCandidates[0];
    const mentionPrefix = `@${toBot.name} `;
    const visibleQuestionText = `${mentionPrefix}${String(question || '').trim()}`;

    const questionMessage = await postBotMessage({
      conversationId: targetGroup.id,
      botId: fromBot.id,
      content: visibleQuestionText,
      mentions: [
        {
          targetType: 'bot',
          targetId: toBot.id,
          displayText: `@${toBot.name}`,
          startOffset: 0,
          endOffset: mentionPrefix.trimEnd().length,
        },
      ],
    });

    // 只能由 toBot 本身读取它自己的独立记忆（requesterBotId === toBot.id）
    const ownMemories = queryBotMemories({
      requesterBotId: toBot.id,
      targetBotId: toBot.id,
      query: question,
      limit: 5,
    });

    let answerText;
    if (typeof generatePeerAnswer === 'function') {
      answerText = await generatePeerAnswer({
        fromBot: cloneJson(fromBot),
        toBot: cloneJson(toBot),
        question,
        ownMemories,
        groupConversation: cloneJson(targetGroup),
      });
    } else if (ownMemories.length > 0) {
      answerText = `@${fromBot.name} 根据我记录的独立记忆：${ownMemories.map(m => m.content).join('；')}`;
    } else {
      answerText = `@${fromBot.name} 我这边暂时没有关于「${question}」的独立记忆记录。`;
    }

    const answerMention = `@${fromBot.name}`;
    const answerMessage = await postBotMessage({
      conversationId: targetGroup.id,
      botId: toBot.id,
      replyToMessageId: questionMessage.id,
      content: answerText,
      mentions: answerText.startsWith(answerMention)
        ? [{ targetType: 'bot', targetId: fromBot.id, displayText: answerMention, startOffset: 0, endOffset: answerMention.length }]
        : [],
    });

    return {
      status: 'answered_in_group',
      groupConversationId: targetGroup.id,
      groupTitle: targetGroup.title,
      questionMessage,
      answerMessage,
      usedMemoriesCount: ownMemories.length,
    };
  }

  // ── 3. 全量聊天记录两阶段检索（不泄露 internal 事件/临时/保密/被排除会话） ─

  function collectSearchableConversations(requesterBotId) {
    const bot = requesterBotId && requesterBotId !== 'user'
      ? store.state.bots.find(b => b.id === requesterBotId)
      : null;
    if (bot && bot.memoryConfig?.enableGlobalChatSearch === false) return [];
    const excluded = new Set(bot?.memoryConfig?.excludedConversationIds || []);

    const results = [];

    // Bot 私聊与群聊（仅读取 visible 消息，绝不读取 store.state.events 里的 internal 协作指令）
    for (const conv of store.state.conversations) {
      if (excluded.has(conv.id)) continue;
      if (conv.metadata?.temporary || conv.metadata?.vault || conv.metadata?.deleted) continue;
      const msgs = store.state.messages
        .filter(m => m.conversationId === conv.id && m.content)
        .sort((a, b) => a.sequence - b.sequence)
        .map(m => ({
          id: m.id,
          sequence: m.sequence,
          senderType: m.senderType,
          senderId: m.senderId,
          senderName: m.senderNameSnapshot || (m.senderType === 'user' ? '用户' : 'Bot'),
          text: m.content,
          createdAt: m.createdAt,
        }));
      results.push({
        conversationId: conv.id,
        conversationTitle: conv.title,
        sourceKind: conv.type === 'group' ? 'bot_group' : 'bot_private',
        messages: msgs,
      });
    }

    // 主对话区与其它用户已保存对话（通过 externalChatProvider 注入）
    if (typeof externalChatProvider === 'function') {
      const externals = externalChatProvider() || [];
      for (const conv of externals) {
        if (!conv || !conv.id || excluded.has(conv.id)) continue;
        if (conv.temporary || conv.vault || conv.deleted) continue;
        results.push({
          conversationId: conv.id,
          conversationTitle: conv.title || '主对话',
          sourceKind: 'user_chat',
          messages: (conv.messages || []).map((m, idx) => ({
            id: m.id || `${conv.id}_m_${idx}`,
            sequence: m.sequence ?? idx + 1,
            senderType: m.role === 'user' ? 'user' : 'assistant',
            senderId: m.senderId || m.role || 'assistant',
            senderName: m.senderName || (m.role === 'user' ? '用户' : 'Mova'),
            text: String(m.text || m.content || ''),
            createdAt: m.createdAt || conv.updatedAt || 0,
          })),
        });
      }
    }

    return results;
  }

  /**
   * 阶段一：chat_history_search — 按关键词/发言人/时间/会话检索跨对话历史，返回紧凑摘要与来源链接
   */
  function chatHistorySearch({
    requesterBotId = 'user',
    query = '',
    conversationId = null,
    speakerId = null,
    dateFrom = null,
    dateTo = null,
    cursor = 0,
    limit = 10,
  } = {}) {
    const convs = collectSearchableConversations(requesterBotId);
    const tokens = normalizeTokens(query);
    const hits = [];

    for (const conv of convs) {
      if (conversationId && conv.conversationId !== conversationId) continue;
      for (const msg of conv.messages) {
        if (speakerId && msg.senderId !== speakerId) continue;
        if (dateFrom && msg.createdAt < dateFrom) continue;
        if (dateTo && msg.createdAt > dateTo) continue;
        const s = scoreText(`${conv.conversationTitle} ${msg.text}`, tokens, query);
        if (tokens.length > 0 && s <= 0) continue;
        hits.push({
          conversationId: conv.conversationId,
          conversationTitle: conv.conversationTitle,
          sourceKind: conv.sourceKind,
          messageId: msg.id,
          sequence: msg.sequence,
          speakerId: msg.senderId,
          speakerName: msg.senderName,
          createdAt: msg.createdAt,
          snippet: makeSnippet(msg.text, query),
          score: Number(s.toFixed(4)),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    const offset = Math.max(0, Number(cursor) || 0);
    const pageSize = Math.min(50, Math.max(1, Number(limit) || 10));
    const slice = hits.slice(offset, offset + pageSize);
    return {
      total: hits.length,
      cursor: offset,
      nextCursor: offset + slice.length < hits.length ? offset + slice.length : null,
      hasMore: offset + slice.length < hits.length,
      items: slice,
    };
  }

  /**
   * 阶段二：chat_history_read — 回读指定命中的精确上下文窗口，带完整来源标识
   */
  function chatHistoryRead({ requesterBotId = 'user', conversationId, messageId, before = 3, after = 3 }) {
    const convs = collectSearchableConversations(requesterBotId);
    const conv = convs.find(c => c.conversationId === conversationId);
    if (!conv) return null;
    const idx = conv.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return null;
    const start = Math.max(0, idx - Math.max(0, Number(before) || 0));
    const end = Math.min(conv.messages.length, idx + Math.max(0, Number(after) || 0) + 1);
    return {
      conversationId: conv.conversationId,
      conversationTitle: conv.conversationTitle,
      sourceKind: conv.sourceKind,
      targetMessageId: messageId,
      messages: conv.messages.slice(start, end),
    };
  }

  /** 为单轮 Bot 推理拼装分域上下文（仅注入本 Bot 独立记忆 + 当前群记忆 + 人设），不混入其他 Bot 独立记忆。 */
  function buildMemoryContextForPrompt({ botId, conversationId, query = '' }) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) return { botMemories: [], groupMemories: [], text: '' };

    const botMemories = bot.memoryConfig?.enableIndependentMemory !== false
      ? queryBotMemories({ requesterBotId: botId, targetBotId: botId, query, limit: 6 })
      : [];

    const conv = store.state.conversations.find(c => c.id === conversationId);
    const groupMemories = conv?.type === 'group' && bot.memoryConfig?.enableGroupMemory !== false
      ? queryGroupMemories({ groupId: conv.id, requesterBotId: botId, query, limit: 6 })
      : [];

    const lines = [];
    if (bot.personaConfig) {
      lines.push(`[人设配置] 称呼用户:${bot.personaConfig.userTitle || '你'} | 语气:${bot.personaConfig.tone} | 篇幅:${bot.personaConfig.replyLength} | 协作风格:${bot.personaConfig.collaborationStyle}`);
      if (bot.personaConfig.customInstructions) lines.push(`[自定义指令] ${bot.personaConfig.customInstructions}`);
    }
    if (groupMemories.length > 0) {
      lines.push(`[本群共享记忆] ${groupMemories.map(m => `- ${m.content}`).join('\n')}`);
    }
    if (botMemories.length > 0) {
      lines.push(`[${bot.name}的独立记忆] ${botMemories.map(m => `- ${m.content}`).join('\n')}`);
    }
    return {
      botMemories,
      groupMemories,
      text: lines.join('\n'),
    };
  }

  return {
    writeGroupMemory,
    queryGroupMemories,
    writeBotMemory,
    queryBotMemories,
    updateMemory,
    deleteMemory,
    listMemories,
    askPeerBotMemoryInSharedGroup,
    chatHistorySearch,
    chatHistoryRead,
    buildMemoryContextForPrompt,
  };
}
