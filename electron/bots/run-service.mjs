/**
 * 负责：执行单个或多个 Bot 的对话推理回合（多方身份角色映射、快照版本与预算绑定、人打断抢占失效检查、
 *   静默内部委派多跳执行、跨 Bot 同群问询调用、共识卡/小程序孵化协调，以及向前端右上角发出实时 shimmer 工作状态）。
 * 不负责：底层持久化细节或 UI 组件渲染（通过注入的 modelRunner、router、conversationService、memoryGateway、miniAppService 完成）。
 * 被谁调用：electron/bots/runtime.mjs、electron/bots/ipc.mjs 及集成测试。
 */
import { cloneJson, generateId } from './store.mjs';
import { botPlainText, splitBotMessage } from '../../src/features/bot/bot-message-text.mjs';

/**
 * 将群聊/多 Bot 原始对话历史按当前发言 Bot 视角映射为合法的 LLM provider messages 数组：
 * - 当前 Bot 自己的历史回复 -> `role: 'assistant'`
 * - 人类消息 -> `role: 'user'`，带 `[用户]` 标识
 * - 其他 Bot 消息 -> `role: 'user'`，带 `[群成员发言 · 名字 | ID | 角色]` 明确身份标识，防止模型身份混淆
 * - 内部委派指令/定时器触发 -> 附加到最后一条 `role: 'user'` 消息里，确保消息序列始终以 `user` 结尾，且绝不污染存储原文。
 */
export function projectMultiPartyTranscriptForProvider({
  activeBot,
  conversation,
  rawMessages = [],
  botsById = new Map(),
  internalDirective = null,
}) {
  const projected = [];

  const pushMessage = (role, text) => {
    const content = String(text || '').trim();
    if (!content) return;
    if (projected.length > 0 && projected[projected.length - 1].role === role) {
      projected[projected.length - 1].content += `\n\n${content}`;
    } else {
      projected.push({ role, content });
    }
  };

  for (const msg of rawMessages) {
    if (msg.senderType === 'bot' && msg.senderId === activeBot.id) {
      pushMessage('assistant', msg.content);
    } else if (msg.senderType === 'user') {
      pushMessage('user', `[用户]: ${msg.content}`);
    } else if (msg.senderType === 'bot') {
      const peer = botsById.get(msg.senderId);
      const labelName = peer?.name || msg.senderNameSnapshot || msg.senderId;
      const roleTitle = peer?.roleTitle || peer?.tag || '群成员';
      pushMessage('user', `[群成员发言 · 名字: ${labelName} | ID: ${msg.senderId} | 角色: ${roleTitle}]: ${msg.content}`);
    } else {
      pushMessage('user', `[系统记录]: ${msg.content}`);
    }
  }

  if (internalDirective) {
    pushMessage('user', `[内部任务指令 · 请直接围绕本轮需求执行]:\n${internalDirective}`);
  } else if (!projected.length || projected[projected.length - 1].role !== 'user') {
    const topicHint = conversation?.topic ? `「${conversation.topic}」` : '当前对话';
    pushMessage('user', `[轮次指令]: 请以「${activeBot.name}」（ID: ${activeBot.id}）的身份接续回应 ${topicHint}。若无需补充请只输出 NO_REPLY。`);
  }

  return projected;
}

export function parseBotActionDirectives(rawText) {
  const text = String(rawText || '');
  const actions = [];
  const cleanText = text
    .replace(/<mova_bot_action>([\s\S]*?)<\/mova_bot_action>/gi, (_, inner) => {
      try {
        const parsed = JSON.parse(String(inner || '').trim());
        if (parsed && typeof parsed === 'object') actions.push(parsed);
      } catch {
        // Ignore malformed directive JSON
      }
      return '';
    })
    .trim();
  return { cleanText, actions };
}

export function createRunService({
  store,
  registry,
  conversationService,
  memoryGateway,
  router,
  policyGateway,
  miniAppService = null,
  modelRunner = null,
  onStatusChange = null,
  onEvent = null,
}) {
  const clock = store.clock;
  const activeRunsByConversation = new Map(); // conversationId -> Map<runId, { botId, botName, statusText, state, controller }>

  function emitStatus(conversationId) {
    const map = activeRunsByConversation.get(conversationId);
    const list = map ? [...map.values()] : [];
    const waitingApproval = store.state.approvalRequests.some(
      a => a.conversationId === conversationId && a.status === 'pending',
    );
    let primaryText = '';
    if (waitingApproval && list.length === 0) {
      primaryText = '等待你确认高风险操作';
    } else if (list.length === 1) {
      primaryText = list[0].statusText || `${list[0].botName} 正在思考…`;
    } else if (list.length > 1) {
      primaryText = `${list[0].botName} ${list[0].statusText || '正在处理'} · +${list.length - 1} 个 Bot 协作中`;
    }
    const payload = {
      conversationId,
      active: list.length > 0 || waitingApproval,
      waitingApproval,
      primaryText,
      activeBots: list.map(({ botId, botName, statusText, state }) => ({ botId, botName, statusText, state })),
    };
    try { onStatusChange?.(payload); } catch { /* ignore */ }
    try { onEvent?.({ type: 'bot:status', ...payload }); } catch { /* ignore */ }
  }

  function registerRun(conversationId, runId, meta) {
    let map = activeRunsByConversation.get(conversationId);
    if (!map) {
      map = new Map();
      activeRunsByConversation.set(conversationId, map);
    }
    map.set(runId, meta);
    emitStatus(conversationId);
  }

  function updateRunStatus(conversationId, runId, statusText, state = 'running') {
    const map = activeRunsByConversation.get(conversationId);
    const entry = map?.get(runId);
    if (!entry) return;
    entry.statusText = statusText;
    entry.state = state;
    emitStatus(conversationId);
  }

  function unregisterRun(conversationId, runId) {
    const map = activeRunsByConversation.get(conversationId);
    if (!map) return;
    map.delete(runId);
    if (map.size === 0) activeRunsByConversation.delete(conversationId);
    emitStatus(conversationId);
  }

  /** 人工取消/抢占：立即中止该会话所有在途运行，并提升会话版本号阻止旧响应落盘。 */
  function cancelConversationRuns(conversationId, reason = 'user_cancelled') {
    conversationService.bumpConversationVersion(conversationId);
    const map = activeRunsByConversation.get(conversationId);
    let aborted = 0;
    if (map) {
      for (const [runId, entry] of map.entries()) {
        entry.controller.abort(new Error(reason));
        aborted += 1;
        store.mutate(state => {
          const run = state.taskRuns.find(r => r.id === runId);
          if (run && !run.finishedAt) {
            run.status = 'cancelled';
            run.error = reason;
            run.finishedAt = clock();
          }
        });
      }
      map.clear();
      activeRunsByConversation.delete(conversationId);
      emitStatus(conversationId);
    }
    return { aborted };
  }

  /** 默认本地/无密钥回退执行器：确保离线与未配置密钥时各核心协作、小程序孵化、共识卡片与人设表达仍能完整走通。 */
  async function defaultOfflineSynthesis({
    bot,
    conversation,
    latestUserMessage,
    internalDirective,
    hop,
    isTaskHost,
  }) {
    const text = String(latestUserMessage?.content || internalDirective || '').trim();
    const roleHint = bot.roleTitle || bot.tag;

    // 检查是否要求孵化小程序
    if (/小程序|做个工具|做个看板|做个追踪|清单面板|记账/.test(text) && miniAppService && (!conversation.type || conversation.type === 'private' || bot.id === 'mova' || bot.id === 'planner' || isTaskHost)) {
      const appName = text.includes('账') ? '轻量收支记账板' : '智能行动小看板';
      return {
        text: `我为你搭建了「${appName}」，现在就能直接在右侧面板点开子页面使用。`,
        miniAppSpec: {
          name: appName,
          description: `由 ${bot.name} 根据「${text.slice(0, 40)}」即时孵化`,
          routes: [
            { id: 'overview', title: '总览' },
            { id: 'checklist', title: '记录列表' },
            { id: 'budget', title: '统计分析' },
          ],
        },
      };
    }

    // 任务模式或主机协作：若未到跳数上限，通过静默内部委派交由团队其他活跃 Bot 提供输入后汇总
    if (conversation.type === 'group' && conversation.groupMode === 'task' && isTaskHost && hop === 0) {
      const peers = (conversation.memberBotIds || []).filter(id => id !== bot.id);
      if (peers.length > 0) {
        return {
          text: `已收到任务，我将围绕「${text.slice(0, 40)}」整理结构化执行方案。`,
          handoffTo: {
            receiverBotId: peers[0],
            goal: `请以你的专长视角补充实现细节与风险评估，原需求：${text}`,
            constraints: ['仅内部协作，输出关键结论供汇总'],
            requestedTools: ['search', 'memory'],
          },
        };
      }
    }

    // 讨论模式：多 Bot 各自表达不同视角
    if (conversation.type === 'group' && conversation.groupMode === 'discussion') {
      const concise = bot.personaConfig?.replyLength === 'short';
      const prefix = concise ? `[${roleHint}] ` : `从${roleHint}的角度来看：`;
      return {
        text: `${prefix}围绕「${text.slice(0, 36)}」，我建议优先明确范围与验收边界，再分步骤推进。`,
      };
    }

    if (internalDirective) {
      return {
        text: `已完成「${internalDirective.slice(0, 40)}」环节的分析与补充。`,
      };
    }

    const salutation = bot.personaConfig?.userTitle && bot.personaConfig.userTitle !== '你' ? `${bot.personaConfig.userTitle}，` : '';
    if (bot.personaConfig?.replyLength === 'short') {
      return { text: `${salutation}收到，我按「${roleHint}」的方式跟进：${text.slice(0, 50)}。` };
    }
    return {
      text: `${salutation}已收到你的消息。作为「${bot.name}（${roleHint}）」，我会结合${conversation.type === 'group' ? '本群共享上下文' : '我们的历史上下文'}为你推进「${text.slice(0, 50)}」。`,
    };
  }

  async function runSingleBotTurn({
    botId,
    conversationId,
    expectedVersion,
    triggerSource = 'user_message',
    replyToMessageId = null,
    latestUserMessage = null,
    internalDirective = null,
    suppressVisibleOutput = false,
    hop = 0,
    isTaskHost = false,
    taskId = null,
    minUserMsgSeq = 0,
  }) {
    const bot = registry.getBot(botId);
    const conv = conversationService.getConversation(conversationId);
    if (!bot || !conv || bot.status !== 'active') return { skipped: true, reason: 'inactive_or_missing' };
    if (conv.version !== expectedVersion) return { preempted: true, reason: 'version_changed_before_start' };

    const runId = generateId('run');
    const controller = new AbortController();
    const runRecord = {
      id: runId,
      taskId,
      conversationId,
      botId: bot.id,
      triggerSource,
      status: 'running',
      botVersion: bot.version,
      conversationVersion: expectedVersion,
      tokenUsage: { input: 0, output: 0 },
      toolCalls: [],
      error: null,
      startedAt: clock(),
      finishedAt: null,
    };
    store.mutate(state => { state.taskRuns.unshift(runRecord); });
    registerRun(conversationId, runId, {
      botId: bot.id,
      botName: bot.name,
      statusText: internalDirective ? '正在协同处理任务…' : '正在整理思路…',
      state: 'running',
      controller,
    });

    try {
      const memCtx = conv.place?.origin ? null : memoryGateway.buildMemoryContextForPrompt({
        botId: bot.id,
        conversationId,
        query: latestUserMessage?.content || internalDirective || '',
      });
      const botsById = new Map(store.state.bots.map(b => [b.id, b]));
      const providerMessages = projectMultiPartyTranscriptForProvider({
        activeBot: bot,
        conversation: conv,
        rawMessages: conv.messages.filter(message => !conv.place?.origin || message.createdAt >= (conv.metadata?.cloudSince ?? conv.createdAt)).slice(-24),
        botsById,
        internalDirective,
      });

      const systemPrompt = [
        `你是 Mova 中的 Bot「${bot.name}」（稳定唯一 ID: ${bot.id}，职责: ${bot.roleTitle || bot.tag}）。`,
        `说明：${bot.description}`,
        '聊天回复只用纯文本，不使用 Markdown 标记。短句表达，每条消息不超过 200 字；长内容分段。信息不足时明确提问，不猜测。前端修改先向用户确认。',
        '群聊中要向其他 Bot 提问时，在消息中使用 @成员名字（同名时用 @名字#ID末六位），系统会真实投递；不要仅声称已经联系对方。',
        '信息不足或涉及前端修改确认时，用提问卡片等待用户回答，不要先执行。输出协议：<mova_bot_action>{"type":"ask_user","question":"需要确认的问题","options":["选项一","选项二"]}</mova_bot_action>。可省略 options 让用户自由回答。',
        conv.type === 'group' ? `群成员：${(conv.memberBotIds || []).map(id => { const peer = botsById.get(id); return peer ? `${peer.name}（ID: ${id}）` : id; }).join('、')}` : '',
        memCtx?.text,
        conv.type === 'group'
          ? `当前为群聊「${conv.title}」（模式: ${conv.groupMode || 'natural'}）。若无需发言请精确回复 NO_REPLY，不要重复其他 Bot 的结论。`
          : `当前为与用户的私聊（话题: ${conv.topic || '默认对话'}）。`,
      ]
        .filter(Boolean)
        .join('\n\n');

      let result;
      if (typeof modelRunner === 'function') {
        result = await modelRunner({
          runId,
          bot,
          conversation: conv,
          systemPrompt,
          messages: providerMessages,
          latestUserMessage,
          internalDirective,
          hop,
          isTaskHost,
          abortSignal: controller.signal,
          updateStatus: text => updateRunStatus(conversationId, runId, text, 'running'),
        });
      }
      if (result == null || result?.fallbackToOffline) {
        result = await defaultOfflineSynthesis({
          bot,
          conversation: conv,
          latestUserMessage,
          internalDirective,
          hop,
          isTaskHost,
        });
      }

      const normalized = typeof result === 'string' ? { text: result } : { ...(result || {}) };
      if (typeof normalized.text === 'string' && /<mova_bot_action>/i.test(normalized.text)) {
        const parsedDirectives = parseBotActionDirectives(normalized.text);
        normalized.text = parsedDirectives.cleanText;
        for (const action of parsedDirectives.actions) {
          const kind = action.type || action.action;
          if (kind === 'incubate_mini_app' && !normalized.miniAppSpec) {
            normalized.miniAppSpec = action.spec || action;
          } else if (kind === 'propose_consensus' && !normalized.consensusCard) {
            normalized.consensusCard = action.card || action;
          } else if (kind === 'ask_user' && !normalized.structuredPayload && action.question) {
            normalized.structuredPayload = {
              type: 'question_card',
              question: String(action.question).slice(0, 400),
              options: (Array.isArray(action.options) ? action.options : []).slice(0, 4).map((option, index) => ({
                label: String(typeof option === 'string' ? option : option.label || '').slice(0, 60),
                value: String(index),
              })),
            };
          } else if (kind === 'delegate_task' && !normalized.handoffTo && (action.receiverBotId || action.toBotId)) {
            normalized.handoffTo = {
              receiverBotId: action.receiverBotId || action.toBotId,
              goal: action.goal || '',
              constraints: action.constraints || [],
              requestedTools: action.requestedTools || [],
            };
          }
        }
      }

      // 人优先抢占判定：若推理过程中会话版本推进或被取消，立即作废本次结果
      const latestConv = store.state.conversations.find(c => c.id === conversationId);
      if (controller.signal.aborted || !latestConv || latestConv.version !== expectedVersion) {
        store.mutate(state => {
          const r = state.taskRuns.find(item => item.id === runId);
          if (r) { r.status = 'preempted'; r.finishedAt = clock(); }
        });
        return { preempted: true, reason: 'preempted_during_run' };
      }

      // 处理小程序孵化指令（优先使用 LLM 代码生成器生成定制单文件 HTML，并在提交前再次校验抢占）
      let structuredPayload = normalized.structuredPayload || null;
      if (normalized.miniAppSpec && miniAppService) {
        let finalSpec = normalized.miniAppSpec;
        if (!finalSpec.entryHtml && typeof miniAppService.generateEntryHtml === 'function') {
          updateRunStatus(conversationId, runId, `正在为「${finalSpec.name || '轻应用'}」定制界面代码…`, 'running');
          const generatedHtml = await miniAppService.generateEntryHtml({ bot, spec: finalSpec });
          const postCodegenConv = store.state.conversations.find(c => c.id === conversationId);
          if (controller.signal.aborted || !postCodegenConv || postCodegenConv.version !== expectedVersion) {
            store.mutate(state => {
              const r = state.taskRuns.find(item => item.id === runId);
              if (r) { r.status = 'preempted'; r.finishedAt = clock(); }
            });
            return { preempted: true, reason: 'preempted_during_run' };
          }
          finalSpec = { ...finalSpec, entryHtml: generatedHtml };
        }
        const appResult = miniAppService.incubateMiniApp({
          botId: bot.id,
          conversationId,
          spec: finalSpec,
          postCardMessage: false,
        });
        structuredPayload = appResult.cardPayload;
      } else if (normalized.consensusCard) {
        const created = conversationService.createConsensusCardMessage({
          conversationId,
          proposerBotId: bot.id,
          ...normalized.consensusCard,
          expectedConversationVersion: expectedVersion,
        });
        store.mutate(state => {
          const r = state.taskRuns.find(item => item.id === runId);
          if (r) { r.status = 'completed'; r.finishedAt = clock(); }
        });
        return { committedMessage: created.message, handoffTo: normalized.handoffTo || null };
      }

      // 检查 NO_REPLY / 重复抑制 / 静默中间跳
      let committedMessage = null;
      const committedMessages = [];
      const outText = botPlainText(normalized.text || '');
      const skipBubble = suppressVisibleOutput
        || (!structuredPayload && router.isNoReplyContent(outText))
        || (!structuredPayload && router.isNearDuplicateReply(conversationId, outText, minUserMsgSeq));

      if (!skipBubble) {
        const parts = splitBotMessage(outText);
        if (!parts.length && structuredPayload) parts.push('');
        for (const [index, part] of parts.entries()) {
          const commit = conversationService.addBotMessage({
            conversationId,
            botId: bot.id,
            content: part,
            replyToMessageId,
            structuredPayload: index === parts.length - 1 ? structuredPayload : null,
            runId,
            expectedConversationVersion: expectedVersion,
          });
          if (commit.preempted) {
            store.mutate(state => {
              const r = state.taskRuns.find(item => item.id === runId);
              if (r) { r.status = 'preempted'; r.finishedAt = clock(); }
            });
            return { preempted: true };
          }
          if (commit.message) committedMessages.push(commit.message);
        }
        committedMessage = committedMessages[0] || null;
        if (committedMessages.length) onEvent?.({ type: 'conversation:updated', conversationId });
      }

      store.mutate(state => {
        const r = state.taskRuns.find(item => item.id === runId);
        if (r) {
          r.status = 'completed';
          r.tokenUsage = normalized.tokenUsage || { input: 120, output: outText.length };
          r.finishedAt = clock();
        }
      });

      return {
        committedMessage,
        committedMessages,
        text: outText,
        handoffTo: normalized.handoffTo || null,
        askPeerMemory: normalized.askPeerMemory || null,
      };
    } catch (err) {
      store.mutate(state => {
        const r = state.taskRuns.find(item => item.id === runId);
        if (r) {
          r.status = controller.signal.aborted ? 'cancelled' : 'failed';
          r.error = String(err?.message || err);
          r.finishedAt = clock();
        }
      });
      if (controller.signal.aborted) return { preempted: true };
      throw err;
    } finally {
      unregisterRun(conversationId, runId);
    }
  }

  /**
   * 完整处理用户发消息后的一轮对话路由、Bot 发言、静默内部多跳委派与共识汇总。
   */
  async function handleUserTurn({
    conversationId,
    content,
    mentions = [],
    replyToMessageId = null,
    attachments = [],
    waitForCompletion = true,
  }) {
    // 人工发送消息立即打断该会话原有在途响应并推进版本号
    const prevMap = activeRunsByConversation.get(conversationId);
    if (prevMap && prevMap.size > 0) {
      for (const entry of prevMap.values()) {
        entry.controller.abort(new Error('preempted_by_new_user_message'));
      }
      prevMap.clear();
      activeRunsByConversation.delete(conversationId);
    }

    const { message: userMessage, conversationVersion } = conversationService.addUserMessage({
      conversationId,
      content,
      mentions,
      replyToMessageId,
      attachments,
    });

    const plan = router.selectSpeakersForUserMessage({ conversationId, message: userMessage });
    const emittedMessages = [];
    const internalEvents = [];

    for (const notice of plan.pausedNotices) {
      const noticeRes = conversationService.addBotMessage({
        conversationId,
        botId: 'system',
        content: `「${notice.botName}」当前处于已停用状态，未参与本轮回复。`,
        expectedConversationVersion: conversationVersion,
      });
      if (noticeRes.message) emittedMessages.push(noticeRes.message);
    }

    const executePlan = async () => {
      const botRepliesCount = new Map();
      const queue = plan.selected.map(slot => ({ ...slot, mentionHop: 0 }));
      const scheduled = new Set(queue.map(slot => slot.botId));
      const collectMessages = (result, slot) => {
        const messages = result.committedMessages || (result.committedMessage ? [result.committedMessage] : []);
        emittedMessages.push(...messages);
        if (messages.length) botRepliesCount.set(slot.botId, (botRepliesCount.get(slot.botId) || 0) + 1);
        const conv = conversationService.getConversation(conversationId);
        if (conv?.type !== 'group' || slot.mentionHop >= router.MAX_BOT_TO_BOT_HOPS) return;
        for (const message of messages) {
          for (const mention of message.mentions || []) {
            const target = registry.getBot(mention.targetId);
            if (!target || target.status !== 'active' || target.id === message.senderId || scheduled.has(target.id)) continue;
            if (!conv.memberBotIds?.includes(target.id)) continue;
            scheduled.add(target.id);
            queue.push({
              botId: target.id,
              reason: 'bot_mention',
              mentionHop: slot.mentionHop + 1,
              replyToMessageId: message.id,
              internalDirective: `群成员「${message.senderNameSnapshot}」在消息中 @ 你，请回应其请求：${message.content}`,
            });
          }
        }
      };

      for (const slot of queue) {
        const curConv = store.state.conversations.find(c => c.id === conversationId);
        if (!curConv || curConv.version !== conversationVersion) break;
        const already = botRepliesCount.get(slot.botId) || 0;
        if (already >= router.MAX_REPLIES_PER_BOT_PER_ROUND) continue;

        const turnRes = await runSingleBotTurn({
          botId: slot.botId,
          conversationId,
          expectedVersion: conversationVersion,
          triggerSource: slot.reason,
          latestUserMessage: userMessage,
          replyToMessageId: slot.replyToMessageId || null,
          internalDirective: slot.internalDirective || null,
          hop: slot.mentionHop,
          isTaskHost: Boolean(slot.isTaskHost),
          minUserMsgSeq: userMessage.sequence,
        });

        if (turnRes.preempted) break;
        collectMessages(turnRes, slot);

        // 处理跨 Bot 独立记忆显式询问
        if (turnRes.askPeerMemory) {
          const qa = await memoryGateway.askPeerBotMemoryInSharedGroup({
            fromBotId: slot.botId,
            toBotId: turnRes.askPeerMemory.toBotId,
            question: turnRes.askPeerMemory.question,
            currentConversationId: conversationId,
            postBotMessage: async payload => conversationService.addBotMessage({
              ...payload,
              expectedConversationVersion: conversationVersion,
            }).message,
          });
          if (qa.questionMessage) emittedMessages.push(qa.questionMessage);
          if (qa.answerMessage) emittedMessages.push(qa.answerMessage);
        }

        // 处理静默内部委派（严格不超过 MAX_BOT_TO_BOT_HOPS 跳，且中间参数绝不进入消息列表）
        let currentHandoff = turnRes.handoffTo;
        let currentSenderId = slot.botId;
        let hop = 1;
        while (currentHandoff && hop <= router.MAX_BOT_TO_BOT_HOPS) {
          const evt = router.recordInternalHandoff({
            conversationId,
            senderBotId: currentSenderId,
            receiverBotId: currentHandoff.receiverBotId,
            goal: currentHandoff.goal,
            constraints: currentHandoff.constraints || [],
            requestedTools: currentHandoff.requestedTools || [],
            budget: currentHandoff.budget || {},
            hop,
          });
          internalEvents.push(evt);

          const workerRes = await runSingleBotTurn({
            botId: currentHandoff.receiverBotId,
            conversationId,
            expectedVersion: conversationVersion,
            triggerSource: 'internal_handoff',
            latestUserMessage: userMessage,
            internalDirective: `来自 ${currentSenderId} 的内部协作者请求: ${currentHandoff.goal}`,
            suppressVisibleOutput: currentHandoff.silentIntermediate !== false,
            hop,
            minUserMsgSeq: userMessage.sequence,
          });
          if (workerRes.preempted) break;
          collectMessages(workerRes, { botId: currentHandoff.receiverBotId, mentionHop: hop });

          // 若下级给出了结论，回传并由当前发派者发一条面向用户的综合结论（若尚未发言/或允许聚合最终结论）
          if (currentHandoff.silentIntermediate !== false && workerRes.text && !router.isNoReplyContent(workerRes.text)) {
            const summaryRes = conversationService.addBotMessage({
              conversationId,
              botId: slot.botId,
              content: `已协同完成后台拆解并整合结论：${workerRes.text}`,
              expectedConversationVersion: conversationVersion,
            });
            if (summaryRes.message) emittedMessages.push(summaryRes.message);
          }

          currentSenderId = currentHandoff.receiverBotId;
          currentHandoff = workerRes.handoffTo;
          hop += 1;
        }
      }

      // 讨论模式下若多个 Bot 给出了各自视角，且尚未发过共识卡，可按需要由首位 Bot 附带分歧确认入口
      if (
        store.state.conversations.find(c => c.id === conversationId)?.groupMode === 'discussion'
        && new Set(emittedMessages.filter(m => m.senderType === 'bot').map(m => m.senderId)).size >= 2
        && !emittedMessages.some(m => m.structuredPayload?.type === 'consensus_card')
      ) {
        const cardRes = conversationService.createConsensusCardMessage({
          conversationId,
          proposerBotId: plan.selected[0].botId,
          title: '讨论要点汇总与决策投票',
          summary: `共有 ${emittedMessages.length} 位成员参与了本轮讨论。`,
          consensusItems: ['已对齐核心需求边界与主要方案方向'],
          divergenceQuestion: '请选择下一步首选推进路线，或直接转为可执行任务：',
          options: emittedMessages.slice(0, 3).map((m, idx) => ({
            id: `opt_${idx + 1}`,
            label: `采纳「${m.senderNameSnapshot}」视角：${m.content.slice(0, 38)}…`,
            proposerBotId: m.senderId,
            proposerName: m.senderNameSnapshot,
          })),
          recommendedOptionId: 'opt_1',
          taskDraft: { title: `推进：${content.slice(0, 24)}`, goal: content },
          expectedConversationVersion: conversationVersion,
        });
        if (cardRes.message) emittedMessages.push(cardRes.message);
      }

      return {
        userMessage,
        conversationVersion,
        emittedMessages,
        internalEvents,
      };
    };

    if (waitForCompletion) {
      return await executePlan();
    }
    const promise = executePlan();
    promise.catch(() => {});
    return {
      userMessage,
      conversationVersion,
      pendingPromise: promise,
    };
  }

  return {
    runSingleBotTurn,
    handleUserTurn,
    cancelConversationRuns,
    getActiveRunStatus(conversationId) {
      const map = activeRunsByConversation.get(conversationId);
      return map ? [...map.values()].map(({ botId, botName, statusText, state }) => ({ botId, botName, statusText, state })) : [];
    },
  };
}
