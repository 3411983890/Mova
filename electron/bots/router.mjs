/**
 * 负责：实现 Bot 对话的事件路由与可控协作护栏（触发优先级排序、群聊 4 模式发言选择、单轮最多 3 个 Bot 发言/Bot→Bot 最多 2 跳/防循环与重复抑制、
 *   以及完全静默的后端协作事件 agent_events 写入，严禁内部委派参数泄露到可见聊天气泡）。
 * 不负责：具体 LLM 文本生成或 UI 渲染（由 run-service 与前端视图负责）。
 * 被谁调用：electron/bots/run-service.mjs、electron/bots/runtime.mjs 及测试。
 */
import { cloneJson, generateId } from './store.mjs';

export const MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN = 3;
export const MAX_BOT_TO_BOT_HOPS = 2;
export const MAX_REPLIES_PER_BOT_PER_ROUND = 1;

export const TRIGGER_PRIORITY = {
  explicit_mention: 100,
  reply_to_bot: 90,
  task_delegation: 80,
  group_question: 60,
  topic_match: 40,
  peer_review: 20,
  proactive: 10,
};

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function jaccardSimilarity(aText, bText) {
  const a = tokenize(aText);
  const b = tokenize(bText);
  if (!a.size || !b.size) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  return intersect / (a.size + b.size - intersect);
}

function topicRelevanceScore(bot, text) {
  const haystack = `${bot.tag || ''} ${bot.roleTitle || ''} ${bot.description || ''} ${bot.personaConfig?.customInstructions || ''}`.toLowerCase();
  const q = String(text || '').toLowerCase();
  if (!q) return 0;
  let score = 0;
  const domainPairs = [
    [/代码|bug|报错|接口|架构|脚本|编译|测试|编程|函数/, /编程|开发|代码|debug|软件|架构/],
    [/设计|ui|ux|配色|界面|排版|交互|样式|图标/, /设计|视觉|体验|界面|留白/],
    [/策划|方案|行程|旅行|攻略|计划|规划|活动|大纲|清?单/, /写作|策划|规划|行程|方案|产品|清?单/],
    [/调研|分析|竞品|预算|表格|总结|摘要|汇总/, /通用|研究|分析|摘要|查资料|搭档/],
  ];
  for (const [msgRe, roleRe] of domainPairs) {
    if (msgRe.test(q) && roleRe.test(haystack)) score += 0.6;
  }
  for (const word of tokenize(q)) {
    if (word.length >= 2 && haystack.includes(word)) score += 0.35;
  }
  return Math.min(1, score);
}

export function createEventRouter(store, { policyGateway = null } = {}) {
  const clock = store.clock;

  /**
   * 写入完全静默的后端协作事件（agent_events, visibility: 'internal'）：
   * 只存事件流，绝不写 messages、绝不递增 unread、绝不暴露为聊天气泡/折叠卡/角标/搜索结果。
   */
  function recordInternalHandoff({
    conversationId = null,
    taskId = null,
    senderBotId,
    receiverBotId,
    goal,
    constraints = [],
    requestedTools = [],
    budget = {},
    deadline = null,
    hop = 1,
    payload = {},
    idempotencyKey = null,
  }) {
    if (hop > MAX_BOT_TO_BOT_HOPS) {
      const err = new Error(`超过 Bot→Bot 最大协作跳数上限 (${MAX_BOT_TO_BOT_HOPS})`);
      err.code = 'ERR_MAX_BOT_HOPS_EXCEEDED';
      throw err;
    }

    if (idempotencyKey) {
      const existing = store.state.events.find(e => e.idempotencyKey === idempotencyKey);
      if (existing) return cloneJson(existing);
    }

    let effectiveTools = [...requestedTools];
    if (policyGateway) {
      const task = taskId ? store.state.tasks.find(t => t.id === taskId) : null;
      const verdict = policyGateway.validateDelegation({
        senderBotId,
        receiverBotId,
        requestedTools,
        taskScopeTools: task?.budgetConfig?.allowedTools || null,
      });
      effectiveTools = verdict.effectiveTools;
    }

    return store.mutate(state => {
      const event = {
        id: generateId('evt'),
        conversationId,
        taskId,
        type: 'internal_handoff',
        senderBotId,
        receiverBotId,
        visibility: 'internal',
        payload: {
          goal: String(goal || ''),
          constraints: cloneJson(constraints),
          allowedTools: effectiveTools,
          budget: cloneJson(budget),
          deadline,
          hop,
          ...cloneJson(payload),
        },
        idempotencyKey: idempotencyKey || generateId('idem'),
        createdAt: clock(),
      };
      state.events.unshift(event);
      return cloneJson(event);
    });
  }

  function listInternalEvents({ conversationId = null, taskId = null } = {}) {
    return store.state.events
      .filter(e => (conversationId ? e.conversationId === conversationId : true))
      .filter(e => (taskId ? e.taskId === taskId : true))
      .map(cloneJson);
  }

  /**
   * 发言选择与触发预算计算：
   * 返回应参与本轮发言的 Bot 计划列表 `[{ botId, reason, priority, replyToMessageId }]` 与被跳过记录（例如已暂停的被 @ Bot）。
   */
  function selectSpeakersForUserMessage({ conversationId, message }) {
    const conv = store.state.conversations.find(c => c.id === conversationId);
    if (!conv) return { selected: [], pausedNotices: [], suppressAll: false };

    const activeMemberRows = store.state.conversationMembers.filter(
      m => m.conversationId === conversationId && m.memberType === 'bot' && !m.leftAt,
    );
    const memberBots = activeMemberRows
      .map(row => ({ row, bot: store.state.bots.find(b => b.id === row.memberId) }))
      .filter(item => Boolean(item.bot));

    const mentionedIds = (message.mentions || []).map(m => m.targetId);
    const pausedNotices = [];
    const selected = [];
    const seenBotIds = new Set();

    // 私聊：单 Bot 直接触发
    if (conv.type === 'private') {
      const target = store.state.bots.find(b => b.id === conv.botId);
      if (!target) return { selected: [], pausedNotices: [], suppressAll: false };
      if (target.status !== 'active') {
        pausedNotices.push({ botId: target.id, botName: target.name, status: target.status });
        return { selected: [], pausedNotices, suppressAll: false };
      }
      return {
        selected: [{ botId: target.id, reason: 'private_chat', priority: TRIGGER_PRIORITY.explicit_mention }],
        pausedNotices: [],
        suppressAll: false,
      };
    }

    // 1. 显式 @ 提及（最高优先级，精确到 targetId）
    for (const targetId of mentionedIds) {
      const bot = store.state.bots.find(b => b.id === targetId);
      if (!bot) continue;
      if (bot.status !== 'active') {
        pausedNotices.push({ botId: bot.id, botName: bot.name, status: bot.status });
        continue;
      }
      if (!activeMemberRows.some(m => m.memberId === bot.id)) continue;
      if (!seenBotIds.has(bot.id)) {
        seenBotIds.add(bot.id);
        selected.push({ botId: bot.id, reason: 'explicit_mention', priority: TRIGGER_PRIORITY.explicit_mention });
      }
    }

    // 2. 引用回复某条 Bot 消息
    if (message.replyToMessageId) {
      const quotedMsg = store.state.messages.find(m => m.id === message.replyToMessageId);
      if (quotedMsg?.senderType === 'bot') {
        const quotedBot = store.state.bots.find(b => b.id === quotedMsg.senderId);
        if (quotedBot && quotedBot.status === 'active' && activeMemberRows.some(m => m.memberId === quotedBot.id) && !seenBotIds.has(quotedBot.id)) {
          seenBotIds.add(quotedBot.id);
          selected.push({ botId: quotedBot.id, reason: 'reply_to_bot', priority: TRIGGER_PRIORITY.reply_to_bot });
        }
      }
    }

    const mode = conv.groupMode || 'natural';

    // 安静模式：只有显式 @ 或引用回复才会响应
    if (mode === 'quiet') {
      return {
        selected,
        pausedNotices,
        suppressAll: selected.length === 0,
      };
    }

    // 如果已经有显式 @，控制额外自发插嘴数量（最多补齐到 MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN，且 quiet/natural 下通常不再多余插嘴）
    if (selected.length > 0 && mode !== 'discussion') {
      return {
        selected: selected.slice(0, Math.max(selected.length, MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN)),
        pausedNotices,
        suppressAll: false,
      };
    }

    const candidates = memberBots
      .filter(({ bot }) => bot.status === 'active' && !seenBotIds.has(bot.id))
      .map(({ row, bot }) => {
        let score = topicRelevanceScore(bot, message.content);
        if (row.role === 'lead') score += 0.25;
        if (bot.personaConfig?.collaborationStyle === 'lead') score += 0.15;
        if (bot.personaConfig?.collaborationStyle === 'observer') score -= 0.4;
        if (bot.personaConfig?.proactivity === 'passive') score -= 0.25;
        if (bot.personaConfig?.proactivity === 'proactive') score += 0.1;
        return { bot, row, score };
      })
      .sort((a, b) => b.score - a.score || (a.row.role === 'lead' ? -1 : 1));

    if (mode === 'task') {
      // 任务模式：选出唯一主持人/主责 Bot 拆解目标并通过静默 agent_events 调度其他专家 Bot
      const host = candidates.find(c => c.row.role === 'lead') || candidates[0];
      if (host) {
        selected.push({
          botId: host.bot.id,
          reason: 'task_delegation',
          priority: TRIGGER_PRIORITY.task_delegation,
          isTaskHost: true,
        });
      }
      return { selected, pausedNotices, suppressAll: false };
    }

    if (mode === 'natural') {
      // 自然模式：最多选 1 位主回复者 + 最多 1 位强相关补充者，严格上限 <= 3
      if (candidates[0]) {
        selected.push({ botId: candidates[0].bot.id, reason: 'topic_match', priority: TRIGGER_PRIORITY.topic_match });
      }
      if (candidates[1] && candidates[1].score >= 0.45 && selected.length < 2) {
        selected.push({ botId: candidates[1].bot.id, reason: 'peer_review', priority: TRIGGER_PRIORITY.peer_review });
      }
      return {
        selected: selected.slice(0, MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN),
        pausedNotices,
        suppressAll: false,
      };
    }

    if (mode === 'discussion') {
      // 讨论模式：最多 3 位相关 Bot 从各自专业视角发言，严格受限于 MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN (3)
      const slotsLeft = Math.max(0, MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN - selected.length);
      for (const item of candidates.slice(0, slotsLeft)) {
        selected.push({
          botId: item.bot.id,
          reason: 'topic_match',
          priority: TRIGGER_PRIORITY.topic_match,
        });
      }
      return { selected, pausedNotices, suppressAll: false };
    }

    return { selected: selected.slice(0, MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN), pausedNotices, suppressAll: false };
  }

  function isNoReplyContent(text) {
    const clean = String(text || '').trim();
    return !clean || clean === 'NO_REPLY' || clean === '[NO_REPLY]';
  }

  function isNearDuplicateReply(conversationId, candidateText, minUserMsgSeq = 0) {
    const clean = String(candidateText || '').trim();
    if (!clean) return false;
    const recentBotMsgs = store.state.messages
      .filter(m => m.conversationId === conversationId && m.sequence > minUserMsgSeq && m.senderType === 'bot');
    for (const prev of recentBotMsgs) {
      if (prev.content.trim() === clean) return true;
      if (jaccardSimilarity(prev.content, clean) >= 0.82) return true;
    }
    return false;
  }

  return {
    MAX_SPONTANEOUS_BOT_REPLIES_PER_TURN,
    MAX_BOT_TO_BOT_HOPS,
    MAX_REPLIES_PER_BOT_PER_ROUND,
    TRIGGER_PRIORITY,
    recordInternalHandoff,
    listInternalEvents,
    selectSpeakersForUserMessage,
    isNoReplyContent,
    isNearDuplicateReply,
  };
}
