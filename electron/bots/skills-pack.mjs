/**
 * 负责：定义 Bot 专属协作与四层记忆技能包（chat_history_search、chat_history_read、bot_ask_peer_memory、bot_delegate_task、
 *   bot_propose_consensus、bot_incubate_mini_app、bot_query_mini_app_data），供 Bot 对话运行时按权限注入工具面。
 * 不负责：污染全局主对话的 8 个核心包前缀（DEFAULT_PACKS 保持不变以免影响提示词缓存前缀）。
 * 被谁调用：electron/bots/runtime.mjs 及测试。
 */
export function createBotCollabTools({
  memoryGateway,
  router,
  conversationService,
  miniAppService,
  policyGateway,
}) {
  return [
    {
      name: 'chat_history_search',
      description: '两阶段检索（阶段一）：检索当前用户所有已保存、未排除、非临时的历史对话记录，返回命中摘要与来源定位。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词或语义查询词' },
          conversationId: { type: 'string', description: '限定检索的会话 ID（可选）' },
          speakerId: { type: 'string', description: '限定发言者 ID（可选）' },
          dateFrom: { type: 'number', description: '起始时间戳 ms（可选）' },
          dateTo: { type: 'number', description: '结束时间戳 ms（可选）' },
          cursor: { type: 'number', description: '分页游标偏移（可选）' },
          limit: { type: 'integer', description: '返回条数上限（默认 10）' },
        },
        required: ['query'],
      },
      execute: async ({ requesterBotId, query, conversationId, speakerId, dateFrom, dateTo, cursor, limit }) =>
        memoryGateway.chatHistorySearch({ requesterBotId, query, conversationId, speakerId, dateFrom, dateTo, cursor, limit }),
    },
    {
      name: 'chat_history_read',
      description: '两阶段检索（阶段二）：根据 conversationId 与 messageId 回读命中附近的精确上下文窗口。',
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: '目标会话 ID' },
          messageId: { type: 'string', description: '锚点消息 ID' },
          before: { type: 'integer', description: '向前读取条数（默认 4）' },
          after: { type: 'integer', description: '向后读取条数（默认 4）' },
        },
        required: ['conversationId', 'messageId'],
      },
      execute: async ({ requesterBotId, conversationId, messageId, before, after }) =>
        memoryGateway.chatHistoryRead({ requesterBotId, conversationId, messageId, before, after }),
    },
    {
      name: 'bot_ask_peer_memory',
      description: '在双方共同群聊内公开 @ 另一个 Bot 询问其独立记忆中的信息；禁止静默跨 Bot 偷读。若不在同一群，返回建群建议。',
      parameters: {
        type: 'object',
        properties: {
          toBotId: { type: 'string', description: '被询问的目标 Bot ID' },
          question: { type: 'string', description: '要公开询问的问题内容' },
          currentConversationId: { type: 'string', description: '当前所在会话 ID（可选）' },
        },
        required: ['toBotId', 'question'],
      },
      execute: async ({ fromBotId, toBotId, question, currentConversationId }) =>
        memoryGateway.askPeerBotMemoryInSharedGroup({
          fromBotId,
          toBotId,
          question,
          currentConversationId,
          postBotMessage: async payload => conversationService.addBotMessage(payload).message,
        }),
    },
    {
      name: 'bot_delegate_task',
      description: '发起完全静默的后端协作事件（agent_events, visibility: internal），将子目标委派给指定 Bot，不作为可见消息展示。',
      parameters: {
        type: 'object',
        properties: {
          toBotId: { type: 'string', description: '接收委派的目标 Bot ID' },
          goal: { type: 'string', description: '清晰的子任务目标描述' },
          conversationId: { type: 'string', description: '关联的会话 ID' },
        },
        required: ['toBotId', 'goal'],
      },
      execute: async params => router.recordInternalHandoff({
        ...params,
        senderBotId: params?.senderBotId || params?.fromBotId || 'mova',
        receiverBotId: params?.receiverBotId || params?.toBotId,
      }),
    },
    {
      name: 'bot_propose_consensus',
      description: '在群聊中发布「群聊共识卡与分歧投票卡」，让用户一键拍板并可转为可执行任务。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '共识卡片标题' },
          summary: { type: 'string', description: '各方核心结论摘要' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
            description: '可供用户拍板的备选方案列表',
          },
          disagreements: {
            type: 'array',
            items: { type: 'string' },
            description: '尚未收敛的分歧点列表',
          },
        },
        required: ['title', 'summary'],
      },
      execute: async params => conversationService.createConsensusCardMessage({
        ...params,
        proposerBotId: params?.proposerBotId || params?.botId || 'mova',
        divergenceQuestion: params?.divergenceQuestion
          || (Array.isArray(params?.disagreements) && params.disagreements.length ? params.disagreements.join('；') : ''),
      }),
    },
    {
      name: 'bot_incubate_mini_app',
      description: '根据用户需求孵化自研轻应用（小程序），生成清单、独立存储与交互视图，并在聊天区发布直达卡片。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '小程序名称' },
          summary: { type: 'string', description: '一句话用途说明' },
          goal: { type: 'string', description: '用户的详细需求目标与业务场景' },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: '需要管理或展示的核心字段列表，如 ["标题","状态","截止时间"]',
          },
          layout: { type: 'string', description: '推荐界面形态，如 dashboard / table / checklist / calendar / form' },
          entryHtml: { type: 'string', description: '可选自定义单文件 HTML 源码；不传时由代码生成器自动生成' },
        },
        required: ['name', 'summary'],
      },
      execute: async params => (miniAppService.incubateMiniAppWithCodegen
        ? miniAppService.incubateMiniAppWithCodegen(params)
        : miniAppService.incubateMiniApp(params)),
    },
    {
      name: 'bot_query_mini_app_data',
      description: '在 manifest.sharedWith 与 PolicyGateway 授权下跨 Bot 读取小程序的结构化记录数据。',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: '目标小程序 ID' },
          key: { type: 'string', description: '具体存储键名（可选）' },
          namespace: { type: 'string', description: '数据命名空间（默认 default）' },
        },
        required: ['appId'],
      },
      execute: async ({ requesterBotId, appId, key, namespace }) => {
        if (policyGateway) {
          const verdict = policyGateway.canBotAccessMiniAppData({ requesterBotId, appId });
          if (!verdict.allowed) {
            const err = new Error(`无权读取小程序数据: ${verdict.reason}`);
            err.code = 'ERR_MINIAPP_ACCESS_FORBIDDEN';
            throw err;
          }
        }
        return miniAppService.queryMiniAppDataForBot({ requesterBotId, appId, key, namespace });
      },
    },
  ];
}
