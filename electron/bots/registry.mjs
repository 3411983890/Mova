/**
 * 负责：管理 Bot 的身份与生命周期（稳定 UUID、同名支持、安全改名、版本快照、模板/对话式/自主创建、模型切换影响检查、克隆/导入导出与影响范围评估后删除）。
 * 不负责：聊天消息投递、模型推理执行或底层存储持久化（通过注入的 store 完成读写）。
 * 被谁调用：electron/bots/runtime.mjs、electron/bots/router.mjs、electron/bots/conversation-service.mjs、electron/bots/ipc.mjs 及测试。
 */
import { cloneJson, generateId } from './store.mjs';

export const MODEL_CATALOG = {
  'deepseek-chat': { name: 'DeepSeek Chat', provider: 'DeepSeek', thinking: false, tools: true, vision: false, note: '均衡，响应快，适合日常对话' },
  'deepseek-reasoner': { name: 'DeepSeek Reasoner', provider: 'DeepSeek', thinking: true, tools: true, vision: false, note: '先思考再回答，适合复杂推理' },
  'gpt-4o': { name: 'GPT-4o', provider: 'OpenAI', thinking: false, tools: true, vision: true, note: '通用多模态与工具调用能力强' },
  'o3-mini': { name: 'o3-mini', provider: 'OpenAI', thinking: true, tools: true, vision: false, note: '高性价比推理模型' },
  'claude-3-7-sonnet': { name: 'Claude 3.7 Sonnet', provider: 'Anthropic', thinking: true, tools: true, vision: true, note: '长文本写作、规划与工程能力强' },
  'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', provider: 'Google', thinking: true, tools: true, vision: true, note: '速度快且原生多模态' },
};

export const BOT_TEMPLATES = {
  'travel-planner': {
    id: 'travel-planner',
    name: '旅行策划师',
    tag: '规划',
    roleTitle: '旅行与行程策划师',
    description: '擅长按预算、天数与交通衔接规划出行路线、行前清单与每日备选方案。',
    appearance: { shape: 'blob', emotion: '02', color: '#76d1dc' },
    personaConfig: { tone: 'friendly', proactivity: 'proactive', replyLength: 'medium', askTendency: 'inquisitive', collaborationStyle: 'lead' },
    capabilityConfig: { model: 'deepseek-chat', effort: 'medium', tools: ['search', 'memory', 'files'] },
    proactiveConfig: { enabled: true, maxDaily: 1 },
  },
  'code-reviewer': {
    id: 'code-reviewer',
    name: '代码审查员',
    tag: '编程',
    roleTitle: '代码质量与架构审计师',
    description: '专注审查变更diff、边界条件、安全漏洞与测试覆盖率，先讲风险再给最小补丁。',
    appearance: { shape: 'wedge', emotion: '02', color: '#ad91e8' },
    personaConfig: { tone: 'rigorous', proactivity: 'passive', replyLength: 'detailed', askTendency: 'minimal', collaborationStyle: 'specialist' },
    capabilityConfig: { model: 'deepseek-reasoner', effort: 'high', tools: ['files', 'code', 'terminal'] },
    proactiveConfig: { enabled: false, maxDaily: 0 },
  },
  'product-analyst': {
    id: 'product-analyst',
    name: '产品分析师',
    tag: '研究',
    roleTitle: '需求拆解与调研分析师',
    description: '把零散想法梳理成需求文档、验收标准和竞品对比表。',
    appearance: { shape: 'gem', emotion: '02', color: '#f4d88a' },
    personaConfig: { tone: 'rigorous', proactivity: 'balanced', replyLength: 'medium', askTendency: 'moderate', collaborationStyle: 'cooperative' },
    capabilityConfig: { model: 'deepseek-reasoner', effort: 'medium', tools: ['search', 'files', 'memory'] },
    proactiveConfig: { enabled: false, maxDaily: 1 },
  },
  'daily-chief': {
    id: 'daily-chief',
    name: '晨间简报官',
    tag: '效率',
    roleTitle: '日程梳理与提醒助理',
    description: '每天定时梳理待办、重要节点与长期目标进度，遵守免打扰与静默时段。',
    appearance: { shape: 'blob', emotion: '02', color: '#81d1c2' },
    personaConfig: { tone: 'concise', proactivity: 'proactive', replyLength: 'short', askTendency: 'minimal', collaborationStyle: 'cooperative' },
    capabilityConfig: { model: 'deepseek-chat', effort: 'low', tools: ['search', 'memory'] },
    proactiveConfig: { enabled: true, maxDaily: 1, quietHoursStart: '22:00', quietHoursEnd: '08:00' },
  },
  'ui-critic': {
    id: 'ui-critic',
    name: '视觉设计师',
    tag: '设计',
    roleTitle: 'UI/UX 体验走查专家',
    description: '从层级、留白、可读性与交互状态审查界面和原型。',
    appearance: { shape: 'gem', emotion: '02', color: '#a7c9f4' },
    personaConfig: { tone: 'friendly', proactivity: 'balanced', replyLength: 'medium', askTendency: 'moderate', collaborationStyle: 'specialist' },
    capabilityConfig: { model: 'gpt-4o', effort: 'medium', tools: ['image', 'files', 'search'] },
    proactiveConfig: { enabled: false, maxDaily: 0 },
  },
  custom: {
    id: 'custom',
    name: '新伙伴',
    tag: '通用',
    roleTitle: '通用协作者',
    description: '按你的需要随时调整说话风格与能力范围。',
    appearance: { shape: 'blob', emotion: '02', color: '#f3f0ea' },
    personaConfig: { tone: 'friendly', proactivity: 'balanced', replyLength: 'medium', askTendency: 'moderate', collaborationStyle: 'cooperative' },
    capabilityConfig: { model: 'deepseek-chat', effort: 'medium', tools: ['search', 'memory'] },
    proactiveConfig: { enabled: false, maxDaily: 1 },
  },
};

const VALID_STATUSES = new Set(['active', 'paused', 'archived']);

export function createBotRegistry(store) {
  const clock = store.clock;

  function listBots({ includeArchived = true, status = null } = {}) {
    return store.state.bots
      .filter(bot => (includeArchived ? true : bot.status !== 'archived'))
      .filter(bot => (status ? bot.status === status : true))
      .map(cloneJson);
  }

  function getBot(botId) {
    const found = store.state.bots.find(b => b.id === botId);
    return found ? cloneJson(found) : null;
  }

  function findBotsByName(name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return [];
    return store.state.bots
      .filter(b => b.name.toLowerCase() === needle || (b.handle && b.handle.toLowerCase() === needle))
      .map(cloneJson);
  }

  function findCandidatesByName(query, { conversationId = null } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const activeMemberIds = new Set(
      conversationId
        ? store.state.conversationMembers
            .filter(m => m.conversationId === conversationId && m.memberType === 'bot' && !m.leftAt)
            .map(m => m.memberId)
        : [],
    );

    return store.state.bots
      .filter(b => b.status !== 'archived')
      .filter(b => !q || b.name.toLowerCase().includes(q) || (b.handle && b.handle.toLowerCase().includes(q)) || (b.roleTitle && b.roleTitle.toLowerCase().includes(q)))
      .map(b => ({
        id: b.id,
        shortId: b.id.slice(-6),
        name: b.name,
        tag: b.tag,
        roleTitle: b.roleTitle || b.tag,
        appearance: cloneJson(b.appearance),
        status: b.status,
        inCurrentConversation: activeMemberIds.has(b.id),
      }))
      .sort((a, b) => Number(b.inCurrentConversation) - Number(a.inCurrentConversation));
  }

  function buildBotRecord(payload = {}, { createdByBotId = null, templateId = null } = {}) {
    const now = clock();
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Bot 名称不能为空');

    const { defaultPersona, defaultCapabilities, defaultMemoryConfig, defaultProactiveConfig } = store.helpers;
    const capOverrides = { ...(payload.capabilityConfig || {}) };
    if (payload.providerId !== undefined) capOverrides.providerId = payload.providerId;
    if (payload.model) capOverrides.model = payload.model;
    if (payload.effort) capOverrides.effort = payload.effort;
    if (Array.isArray(payload.tools)) capOverrides.tools = [...new Set(payload.tools)];

    const personaOverrides = payload.personaConfig || {};
    const memoryOverrides = payload.memoryConfig || {};
    const proactiveOverrides = payload.proactiveConfig || {};
    if (typeof payload.muted === 'boolean' && proactiveOverrides.enabled === undefined) {
      proactiveOverrides.enabled = !payload.muted && Boolean(payload.proactiveEnabled);
    }

    const id = payload.id && !store.state.bots.some(b => b.id === payload.id)
      ? String(payload.id)
      : generateId('bot');

    return {
      id,
      name: name.slice(0, 40),
      handle: payload.handle ? String(payload.handle).trim().slice(0, 32) : null,
      tag: String(payload.tag || '通用').trim() || '通用',
      roleTitle: String(payload.roleTitle || payload.tag || '协作伙伴').trim(),
      tagline: String(payload.tagline || '').trim(),
      description: String(payload.description || '').trim(),
      builtin: false,
      starred: Boolean(payload.starred),
      muted: Boolean(payload.muted),
      status: VALID_STATUSES.has(payload.status) ? payload.status : 'active',
      version: 1,
      appearance: {
        shape: payload.appearance?.shape || 'blob',
        emotion: payload.appearance?.emotion || '02',
        color: payload.appearance?.color || '#f3f0ea',
      },
      personaConfig: defaultPersona(personaOverrides),
      capabilityConfig: defaultCapabilities(capOverrides),
      memoryConfig: defaultMemoryConfig(memoryOverrides),
      proactiveConfig: defaultProactiveConfig(proactiveOverrides),
      createdByBotId,
      templateId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      archivedAt: null,
      usage: { messages: 0, chats: 0, tokens: 0, daily: Array(store.state.settings.usageDays || 14).fill(0) },
    };
  }

  /** 允许同名创建：身份永远以 immutable uuid id 为准。 */
  function createBot(payload) {
    return store.mutate(state => {
      const record = buildBotRecord(payload, { createdByBotId: null, templateId: payload.templateId || null });
      state.bots.unshift(record);
      return cloneJson(record);
    });
  }

  function createFromTemplate(templateId, overrides = {}) {
    const tpl = BOT_TEMPLATES[templateId] || BOT_TEMPLATES.custom;
    return createBot({
      ...tpl,
      ...overrides,
      templateId: tpl.id,
      personaConfig: { ...tpl.personaConfig, ...(overrides.personaConfig || {}) },
      capabilityConfig: { ...tpl.capabilityConfig, ...(overrides.capabilityConfig || {}) },
      proactiveConfig: { ...tpl.proactiveConfig, ...(overrides.proactiveConfig || {}) },
    });
  }

  /** 对话式一句话创建：从自然语言描述抽取人设、工具、主动频率与模板。 */
  function createFromNaturalLanguage(promptText, overrides = {}) {
    const text = String(promptText || '').trim();
    if (!text) throw new Error('描述内容不能为空');

    let baseTemplate = BOT_TEMPLATES.custom;
    if (/代码|编程|审查|debug|bug|开发/i.test(text)) baseTemplate = BOT_TEMPLATES['code-reviewer'];
    else if (/旅行|旅游|行程|攻略|出行/i.test(text)) baseTemplate = BOT_TEMPLATES['travel-planner'];
    else if (/设计|ui|ux|界面|配色/i.test(text)) baseTemplate = BOT_TEMPLATES['ui-critic'];
    else if (/早报|晨报|提醒|日程|每日/i.test(text)) baseTemplate = BOT_TEMPLATES['daily-chief'];
    else if (/产品|调研|需求|分析|文案/i.test(text)) baseTemplate = BOT_TEMPLATES['product-analyst'];

    const quotedName = text.match(/(?:叫|名为|名字是)[「"'\s]*([^\s，。,"'」的]{1,16})/);
    const derivedName = overrides.name || (quotedName ? quotedName[1] : `${baseTemplate.name}`);
    const tools = new Set(baseTemplate.capabilityConfig.tools);
    if (/文件|文档|目录/.test(text)) tools.add('files');
    if (/搜索|联网|查资料/.test(text)) tools.add('search');
    if (/记忆|记住|长期/.test(text)) tools.add('memory');
    if (/代码|脚本|运行/.test(text)) tools.add('code');

    const wantProactive = /每天|定时|提醒|早报|主动/.test(text);
    const wantConcise = /简短|简洁|直白|少说废话/.test(text);

    return createBot({
      ...baseTemplate,
      ...overrides,
      name: derivedName,
      description: overrides.description || text.slice(0, 180),
      templateId: `nl:${baseTemplate.id}`,
      personaConfig: {
        ...baseTemplate.personaConfig,
        ...(wantConcise ? { tone: 'concise', replyLength: 'short' } : {}),
        customInstructions: text,
        ...(overrides.personaConfig || {}),
      },
      capabilityConfig: {
        ...baseTemplate.capabilityConfig,
        tools: [...tools],
        ...(overrides.capabilityConfig || {}),
      },
      proactiveConfig: {
        ...baseTemplate.proactiveConfig,
        enabled: wantProactive || baseTemplate.proactiveConfig.enabled,
        ...(overrides.proactiveConfig || {}),
      },
    });
  }

  /** Bot 自主创建新 Bot：需要父 Bot 拥有自主创建权限并记录 createdByBotId；默认最小权限且未授权前不得静默赋高危权限。 */
  function createAutonomousBot({ creatorBotId, payload = {}, userApproved = false }) {
    const creator = store.state.bots.find(b => b.id === creatorBotId);
    if (!creator) throw new Error(`创建者 Bot 不存在: ${creatorBotId}`);
    if (!creator.capabilityConfig?.autonomousCreateAllowed && !userApproved) {
      const err = new Error(`Bot「${creator.name}」未被允许自主创建新 Bot`);
      err.code = 'ERR_AUTONOMOUS_CREATE_FORBIDDEN';
      throw err;
    }

    const parentTools = new Set(creator.capabilityConfig?.tools || ['search', 'memory']);
    const requestedTools = Array.isArray(payload.capabilityConfig?.tools)
      ? payload.capabilityConfig.tools
      : Array.isArray(payload.tools)
        ? payload.tools
        : ['search', 'memory'];
    // 非特权放行下严格做最小权限裁剪：子 Bot 最多继承父 Bot 已拥有的安全能力，绝不允许通过创建子 Bot 提权。
    const safeTools = requestedTools.filter(tool => {
      if (userApproved) return parentTools.has(tool) || tool === 'memory' || tool === 'search';
      return (tool === 'search' || tool === 'memory' || tool === 'files') && parentTools.has(tool);
    });

    return store.mutate(state => {
      const record = buildBotRecord(
        {
          ...payload,
          capabilityConfig: {
            ...(payload.capabilityConfig || {}),
            tools: safeTools,
            terminal: false,
            browserAllowed: Boolean(userApproved && payload.capabilityConfig?.browserAllowed && creator.capabilityConfig?.browserAllowed),
            desktopAllowed: Boolean(userApproved && payload.capabilityConfig?.desktopAllowed && creator.capabilityConfig?.desktopAllowed),
            autonomousCreateAllowed: false,
          },
        },
        { createdByBotId: creator.id, templateId: payload.templateId || 'autonomous' },
      );
      state.bots.unshift(record);
      return cloneJson(record);
    });
  }

  function checkModelSwitchImpact(botId, nextModelId) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`Bot 不存在: ${botId}`);
    const currentModelId = bot.capabilityConfig?.model || 'deepseek-chat';
    const nextModel = MODEL_CATALOG[nextModelId] || { name: nextModelId, thinking: false, tools: true, vision: false };
    const warnings = [];
    const tools = bot.capabilityConfig?.tools || [];

    if (tools.includes('image') && nextModel.vision === false) {
      warnings.push({
        code: 'VISION_UNSUPPORTED',
        level: 'warning',
        message: `当前 Bot 已开启「图片理解」，但「${nextModel.name}」不支持多模态视觉，切过去后截图分析将受限。`,
      });
    }
    if (bot.capabilityConfig?.effort === 'high' && nextModel.thinking === false) {
      warnings.push({
        code: 'THINKING_IGNORED',
        level: 'info',
        message: `「${nextModel.name}」不支持显式思考强度，原「高」档位推理设置将降级为普通响应。`,
      });
    }
    if (tools.length > 0 && nextModel.tools === false) {
      warnings.push({
        code: 'TOOLS_UNSUPPORTED',
        level: 'warning',
        message: `「${nextModel.name}」不支持工具调用，已授权的工具能力将无法在对话中自动触发。`,
      });
    }

    return {
      botId,
      fromModelId: currentModelId,
      toModelId: nextModelId,
      compatible: warnings.filter(w => w.level === 'warning').length === 0,
      warnings,
    };
  }

  function updateBot(botId, patch = {}) {
    return store.mutate(state => {
      const bot = state.bots.find(b => b.id === botId);
      if (!bot) throw new Error(`Bot 不存在: ${botId}`);

      const nextName = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 40) : bot.name;
      const changed = nextName !== bot.name || Boolean(patch.personaConfig || patch.capabilityConfig || patch.memoryConfig || patch.proactiveConfig || patch.providerId !== undefined || patch.model || patch.effort || patch.tools || patch.description !== undefined || patch.tag !== undefined);

      bot.name = nextName;
      if (patch.handle !== undefined) bot.handle = patch.handle ? String(patch.handle).trim() : null;
      if (patch.tag !== undefined) bot.tag = String(patch.tag).trim() || bot.tag;
      if (patch.roleTitle !== undefined) bot.roleTitle = String(patch.roleTitle).trim();
      if (patch.tagline !== undefined) bot.tagline = String(patch.tagline).trim();
      if (patch.description !== undefined) bot.description = String(patch.description);
      if (typeof patch.muted === 'boolean') bot.muted = patch.muted;
      if (typeof patch.starred === 'boolean') bot.starred = patch.starred;
      if (patch.appearance) bot.appearance = { ...bot.appearance, ...patch.appearance };

      if (patch.personaConfig) {
        bot.personaConfig = {
          ...bot.personaConfig,
          ...patch.personaConfig,
          botRelations: {
            ...(bot.personaConfig?.botRelations || {}),
            ...(patch.personaConfig.botRelations || {}),
          },
        };
      }
      if (patch.capabilityConfig || patch.providerId !== undefined || patch.model || patch.effort || patch.tools) {
        bot.capabilityConfig = {
          ...bot.capabilityConfig,
          ...(patch.capabilityConfig || {}),
          ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
          ...(patch.model ? { model: patch.model } : {}),
          ...(patch.effort ? { effort: patch.effort } : {}),
          ...(Array.isArray(patch.tools) ? { tools: [...new Set(patch.tools)] } : {}),
        };
      }
      if (patch.memoryConfig) {
        bot.memoryConfig = { ...bot.memoryConfig, ...patch.memoryConfig };
      }
      if (patch.proactiveConfig) {
        bot.proactiveConfig = { ...bot.proactiveConfig, ...patch.proactiveConfig };
      }
      if (patch.status && VALID_STATUSES.has(patch.status)) {
        bot.status = patch.status;
        bot.archivedAt = patch.status === 'archived' ? clock() : null;
      }

      if (changed) bot.version += 1;
      bot.updatedAt = clock();

      // 同步私聊标题（私聊默认为一对一关系，但不破坏群聊与历史消息发言者快照）。
      for (const conv of state.conversations) {
        if (conv.type === 'private' && conv.botId === bot.id && conv.topic === '默认对话') {
          conv.title = bot.name;
        }
      }

      return cloneJson(bot);
    });
  }

  /** 安全改名：仅改显示名称与递增版本，保持 ID、历史归属、群聊成员关系、任务与小程序归属不变。 */
  function renameBot(botId, newName) {
    const clean = String(newName || '').trim();
    if (!clean) throw new Error('新名字不能为空');
    return updateBot(botId, { name: clean });
  }

  function setBotStatus(botId, nextStatus) {
    if (!VALID_STATUSES.has(nextStatus)) throw new Error(`无效状态: ${nextStatus}`);
    return store.mutate(state => {
      const bot = state.bots.find(b => b.id === botId);
      if (!bot) throw new Error(`Bot 不存在: ${botId}`);
      bot.status = nextStatus;
      bot.archivedAt = nextStatus === 'archived' ? clock() : null;
      bot.updatedAt = clock();
      if (nextStatus !== 'active') {
        for (const trigger of state.triggers) {
          if (trigger.botId === botId) trigger.enabled = false;
        }
      }
      return cloneJson(bot);
    });
  }

  function cloneBot(botId, overrides = {}) {
    const source = store.state.bots.find(b => b.id === botId);
    if (!source) throw new Error(`Bot 不存在: ${botId}`);
    return createBot({
      ...cloneJson(source),
      id: undefined,
      builtin: false,
      name: overrides.name || `${source.name} 副本`,
      createdByBotId: null,
      status: 'active',
      ...overrides,
    });
  }

  function exportBotConfig(botId) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`Bot 不存在: ${botId}`);
    return {
      format: 'mova-bot-profile-v1',
      exportedAt: clock(),
      bot: {
        name: bot.name,
        handle: bot.handle,
        tag: bot.tag,
        roleTitle: bot.roleTitle,
        tagline: bot.tagline,
        description: bot.description,
        appearance: cloneJson(bot.appearance),
        personaConfig: cloneJson(bot.personaConfig),
        capabilityConfig: {
          ...cloneJson(bot.capabilityConfig),
          allowedRootIds: [], // 导出不含本机路径或授权根 ID，防止敏感路径泄漏
        },
        proactiveConfig: cloneJson(bot.proactiveConfig),
      },
    };
  }

  function importBotConfig(exportedPayload) {
    const data = exportedPayload?.bot ? exportedPayload.bot : exportedPayload;
    if (!data || !data.name) throw new Error('导入的 Bot 配置无效');
    return createBot({
      ...cloneJson(data),
      capabilityConfig: {
        ...(data.capabilityConfig || {}),
        allowedRootIds: [],
        browserAllowed: false,
        desktopAllowed: false,
        autonomousCreateAllowed: false,
      },
    });
  }

  /** 删除前影响分析：给 UI 与调用方展示即将受影响的私聊、群聊、任务、记忆、小程序与触发器。 */
  function getDeletionImpact(botId) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`Bot 不存在: ${botId}`);

    const privateChats = store.state.conversations.filter(c => c.type === 'private' && c.botId === botId);
    const privateChatIds = new Set(privateChats.map(c => c.id));
    const privateMessageCount = store.state.messages.filter(m => privateChatIds.has(m.conversationId)).length;

    const groups = store.state.conversationMembers
      .filter(m => m.memberType === 'bot' && m.memberId === botId && !m.leftAt)
      .map(m => store.state.conversations.find(c => c.id === m.conversationId))
      .filter(c => c && c.type === 'group');

    const activeTasks = store.state.tasks.filter(
      t => t.ownerBotId === botId && !['completed', 'cancelled', 'failed'].includes(t.status),
    );
    const independentMemories = store.state.memories.filter(m => m.scopeType === 'bot' && m.botId === botId);
    const miniApps = store.state.miniApps.filter(a => a.createdByBotId === botId);
    const triggers = store.state.triggers.filter(t => t.botId === botId);

    return {
      botId: bot.id,
      botName: bot.name,
      builtin: Boolean(bot.builtin),
      privateChats: privateChats.map(c => ({ id: c.id, title: c.title })),
      privateMessageCount,
      groups: groups.map(g => ({ id: g.id, title: g.title })),
      activeTaskCount: activeTasks.length,
      independentMemoryCount: independentMemories.length,
      miniApps: miniApps.map(a => ({ appId: a.appId, name: a.name })),
      triggerCount: triggers.length,
    };
  }

  /**
   * 按确认选项删除 Bot：
   * - 移除群聊活跃成员并标记 leftAt，同时在保留的群历史消息上写入已删除标记以便追溯
   * - 可选清理私聊、独立记忆与关联小程序；停止该 Bot 的触发器与进行中任务
   */
  function deleteBot(
    botId,
    {
      keepGroupHistory = true,
      deletePrivateChats = true,
      deleteIndependentMemories = true,
      miniAppAction = 'keep', // 'keep' | 'delete'
    } = {},
  ) {
    return store.mutate(state => {
      const botIndex = state.bots.findIndex(b => b.id === botId);
      if (botIndex < 0) throw new Error(`Bot 不存在: ${botId}`);
      const bot = state.bots[botIndex];
      if (bot.builtin) throw new Error('内置核心 Bot 不支持直接删除，可选择停用');

      const now = clock();
      const privateIds = new Set(
        state.conversations.filter(c => c.type === 'private' && c.botId === botId).map(c => c.id),
      );

      if (deletePrivateChats && privateIds.size > 0) {
        state.conversations = state.conversations.filter(c => !privateIds.has(c.id));
        const removedMsgIds = new Set(
          state.messages.filter(m => privateIds.has(m.conversationId)).map(m => m.id),
        );
        state.messages = state.messages.filter(m => !privateIds.has(m.conversationId));
        state.messageMentions = state.messageMentions.filter(mt => !removedMsgIds.has(mt.messageId));
        state.conversationMembers = state.conversationMembers.filter(cm => !privateIds.has(cm.conversationId));
      }

      // 群成员退群标记
      for (const member of state.conversationMembers) {
        if (member.memberType === 'bot' && member.memberId === botId && !member.leftAt) {
          member.leftAt = now;
        }
      }

      // 群历史发言保留快照并标为已删除来源
      if (keepGroupHistory) {
        for (const msg of state.messages) {
          if (msg.senderType === 'bot' && msg.senderId === botId && !privateIds.has(msg.conversationId)) {
            msg.senderNameSnapshot = `${bot.name} (已删除)`;
          }
        }
      } else {
        const dropIds = new Set(
          state.messages.filter(m => m.senderType === 'bot' && m.senderId === botId).map(m => m.id),
        );
        state.messages = state.messages.filter(m => !dropIds.has(m.id));
        state.messageMentions = state.messageMentions.filter(mt => !dropIds.has(mt.messageId));
      }

      if (deleteIndependentMemories) {
        state.memories = state.memories.filter(m => !(m.scopeType === 'bot' && m.botId === botId));
      }

      // 停掉专属定时触发器与进行中任务
      state.triggers = state.triggers.filter(t => t.botId !== botId);
      for (const task of state.tasks) {
        if (task.ownerBotId === botId && !['completed', 'cancelled', 'failed'].includes(task.status)) {
          task.status = 'cancelled';
          task.waitingReason = 'Bot 已被删除';
          task.updatedAt = now;
        }
      }

      if (miniAppAction === 'delete') {
        const dropApps = new Set(state.miniApps.filter(a => a.createdByBotId === botId).map(a => a.appId));
        state.miniApps = state.miniApps.filter(a => !dropApps.has(a.appId));
        state.miniAppStorage = state.miniAppStorage.filter(s => !dropApps.has(s.appId));
      }

      state.bots.splice(botIndex, 1);
      return { deletedBotId: botId, deletedBotName: bot.name };
    });
  }

  return {
    listBots,
    getBot,
    findBotsByName,
    findCandidatesByName,
    createBot,
    createFromTemplate,
    createFromNaturalLanguage,
    createAutonomousBot,
    checkModelSwitchImpact,
    updateBot,
    renameBot,
    setBotStatus,
    cloneBot,
    exportBotConfig,
    importBotConfig,
    getDeletionImpact,
    deleteBot,
  };
}
