/**
 * 负责：维护渲染层 Bot 通讯录的响应式共享视图模型、模板/自然语言创建适配、模型切换兼容性警告评估、导入导出，
 *   以及与 Electron 主进程 `window.movaDesktop.bots` 的双向状态同步（无 desktop 桥时可纯内存运行）。
 * 不负责：后端数据库持久化、权限裁剪或多 Bot 调度决策（这些在 electron/bots/*.mjs 执行）。
 * 被谁调用：app.js、src/features/contacts/contacts.jsx、src/features/bot/bot-builder.jsx、
 *   src/features/bot/bot-conversation.jsx、src/features/botchat/bot-chat-info.jsx、src/features/botchat/group-dialog.jsx。
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
export const USAGE_DAYS = 14;

export const MODELS = {
  'deepseek-chat': { name: 'DeepSeek Chat', provider: 'DeepSeek', note: '均衡，响应快，适合日常对话', thinking: false, vision: false, tools: true },
  'deepseek-reasoner': { name: 'DeepSeek Reasoner', provider: 'DeepSeek', note: '先思考再回答，适合复杂推理', thinking: true, vision: false, tools: true },
  'gpt-4o': { name: 'GPT-4o', provider: 'OpenAI', note: '通用多模态与工具调用能力强', thinking: false, vision: true, tools: true },
  'claude-3-7-sonnet': { name: 'Claude 3.7 Sonnet', provider: 'Anthropic', note: '长文本写作、规划与工程能力强', thinking: true, vision: true, tools: true },
  'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', provider: 'Google', note: '速度快且原生多模态', thinking: true, vision: true, tools: true },
};
export let DEFAULT_MODEL = 'deepseek-chat';
export const EFFORTS = [
  { id: 'low', label: '低', note: '更快，适合简单问题' },
  { id: 'medium', label: '中', note: '速度与深度均衡' },
  { id: 'high', label: '高', note: '想得更久，适合难题' },
];

let cachedProvidersState = null;

export function syncBotModelsFromProviders(providersState) {
  if (providersState && typeof providersState === 'object') {
    cachedProvidersState = providersState;
  } else if (!providersState) {
    providersState = cachedProvidersState;
  }
  const providers = Array.isArray(providersState?.providers) ? providersState.providers : [];
  const entries = [];
  for (const provider of providers) {
    if (!provider || provider.configured === false || !Array.isArray(provider.models)) continue;
    const isSub = provider.kind === 'subscription';
    const ready = isSub ? provider.configured === true : provider.hasKey === true;
    const providerLabel = String(provider.name || provider.id || '自定义').trim();
    for (const model of provider.models) {
      if (!model?.id) continue;
      const efforts = Array.isArray(model.efforts) ? [...model.efforts] : [];
      entries.push({
        id: model.id,
        name: model.name || model.id,
        provider: providerLabel,
        providerId: provider.id,
        ready,
        note: isSub ? 'CLI 订阅模型' : (ready ? '已配置模型（可用）' : '未配置密钥'),
        thinking: efforts.length > 0,
        efforts,
        vision: model.vision !== false,
        tools: true,
      });
    }
  }
  if (!entries.length) return [];

  for (const key of Object.keys(MODELS)) delete MODELS[key];
  for (const item of entries) {
    const key = Object.hasOwn(MODELS, item.id) ? `${item.providerId}::${item.id}` : item.id;
    MODELS[key] = item;
  }

  const active = providersState?.active;
  const preferred = entries.find(e => e.providerId === active?.providerId && e.id === active?.modelId && e.ready)
    || entries.find(e => e.ready)
    || entries.find(e => e.providerId === active?.providerId && e.id === active?.modelId)
    || entries[0];
  if (preferred) {
    DEFAULT_MODEL = Object.keys(MODELS).find(k => MODELS[k] === preferred) || preferred.id;
  }

  for (const bot of bots) {
    const currentKey = bot.capabilityConfig?.providerId
      ? (MODELS[`${bot.capabilityConfig.providerId}::${bot.model}`] ? `${bot.capabilityConfig.providerId}::${bot.model}` : bot.model)
      : bot.model;
    const matched = MODELS[currentKey];
    if (!matched || !matched.ready) {
      const target = preferred || entries[0];
      if (target) {
        const targetKey = Object.keys(MODELS).find(k => MODELS[k] === target) || target.id;
        bot.model = targetKey;
        if (!bot.capabilityConfig) bot.capabilityConfig = {};
        bot.capabilityConfig.model = target.id;
        bot.capabilityConfig.providerId = target.providerId;
      }
    } else if (bot.capabilityConfig && !bot.capabilityConfig.providerId) {
      bot.capabilityConfig.providerId = matched.providerId;
    }
  }
  return entries;
}

export const TOOLS = {
  search: { label: '联网搜索', detail: '按需检索公开网页' },
  files: { label: '文件读取', detail: '读取已授权文件夹' },
  code: { label: '代码执行', detail: '运行脚本并返回结果' },
  terminal: { label: '终端命令', detail: '在授权目录内运行' },
  image: { label: '图片理解', detail: '识别截图与设计稿' },
  memory: { label: '长期记忆', detail: '记住偏好与背景' },
};

export const BOT_TEMPLATES = [
  { id: 'travel-planner', name: '旅行策划师', tag: '规划', color: '#76d1dc', shape: 'blob', model: 'deepseek-chat', effort: 'medium', tools: ['search', 'memory', 'files'], description: '擅长按预算与天数规划出行路线、行前清单与每日备选方案。', proactiveEnabled: true },
  { id: 'code-reviewer', name: '代码审查员', tag: '编程', color: '#ad91e8', shape: 'wedge', model: 'deepseek-reasoner', effort: 'high', tools: ['files', 'code', 'terminal'], description: '专注审查 diff、边界条件、安全隐患与测试覆盖，先讲风险再给补丁。', proactiveEnabled: false },
  { id: 'product-analyst', name: '产品分析师', tag: '研究', color: '#f4d88a', shape: 'gem', model: 'deepseek-reasoner', effort: 'medium', tools: ['search', 'files', 'memory'], description: '把零散想法梳理成需求文档、验收标准和竞品对比表。', proactiveEnabled: false },
  { id: 'daily-chief', name: '晨间简报官', tag: '效率', color: '#81d1c2', shape: 'blob', model: 'deepseek-chat', effort: 'low', tools: ['search', 'memory'], description: '每日按设定时间梳理待办与目标进度，遵守静默时段不打扰。', proactiveEnabled: true },
  { id: 'ui-critic', name: '视觉设计师', tag: '设计', color: '#a7c9f4', shape: 'gem', model: 'gpt-4o', effort: 'medium', tools: ['image', 'files', 'search'], description: '关注层级、留白与交互状态，读截图给出修改建议。', proactiveEnabled: false },
];

function defaultBotSubConfigs(raw = {}) {
  return {
    personaConfig: {
      tone: 'friendly',
      proactivity: 'balanced',
      replyLength: 'medium',
      askTendency: 'moderate',
      collaborationStyle: 'cooperative',
      userTitle: '你',
      customInstructions: '',
      botRelations: {},
      ...(raw.personaConfig || {}),
    },
    capabilityConfig: {
      model: raw.model || raw.capabilityConfig?.model || DEFAULT_MODEL,
      effort: raw.effort || raw.capabilityConfig?.effort || 'medium',
      tools: Array.isArray(raw.tools) ? [...raw.tools] : [...(raw.capabilityConfig?.tools || ['search', 'memory'])],
      browserAllowed: Boolean(raw.capabilityConfig?.browserAllowed),
      desktopAllowed: Boolean(raw.capabilityConfig?.desktopAllowed),
      autonomousCreateAllowed: Boolean(raw.capabilityConfig?.autonomousCreateAllowed),
    },
    memoryConfig: {
      enableIndependentMemory: true,
      enableGroupMemory: true,
      enableGlobalChatSearch: true,
      excludedConversationIds: [],
      retainGroupHistoryOnLeave: false,
      ...(raw.memoryConfig || {}),
    },
    proactiveConfig: {
      enabled: Boolean(raw.proactiveConfig?.enabled),
      mode: raw.proactiveConfig?.mode || 'balanced',
      maxDaily: raw.proactiveConfig?.maxDaily ?? 1,
      quietHoursStart: raw.proactiveConfig?.quietHoursStart || '22:00',
      quietHoursEnd: raw.proactiveConfig?.quietHoursEnd || '08:00',
      timezone: raw.proactiveConfig?.timezone || 'Asia/Shanghai',
      ignoredCount: raw.proactiveConfig?.ignoredCount || 0,
      mutedTopics: Array.isArray(raw.proactiveConfig?.mutedTopics) ? [...raw.proactiveConfig.mutedTopics] : [],
    },
  };
}

const now = Date.now();
const seed = [
  {
    id: 'mova', name: 'MovaBot', tag: '通用', roleTitle: '主协调助手', builtin: true, starred: true,
    appearance: { shape: 'blob', emotion: '02', color: '#f3f0ea' },
    description: '默认助手，擅长把模糊的想法整理成可执行的下一步。日常问答、写作和规划都可以先找它。',
    model: 'deepseek-chat', effort: 'medium', tools: ['search', 'files', 'code', 'memory'], created: 68 * DAY, used: 25 * 60 * 1000,
    usage: { messages: 1284, chats: 46, tokens: 2640000, daily: [22, 31, 18, 0, 9, 27, 40, 35, 12, 6, 29, 44, 38, 17] },
  },
  {
    id: 'helper', name: '助手', tag: '通用', roleTitle: '快速执行搭档',
    appearance: { shape: 'blob', emotion: '02', color: '#81d1c2' },
    description: '随叫随到的搭档，负责查资料、做摘要和补充细节，回答简短直接。',
    model: 'deepseek-chat', effort: 'low', tools: ['search', 'memory'], created: 41 * DAY, used: 5 * HOUR,
    usage: { messages: 392, chats: 19, tokens: 618000, daily: [4, 0, 11, 8, 0, 0, 15, 9, 3, 0, 12, 7, 0, 6] },
  },
  {
    id: 'planner', name: '策划', tag: '写作', roleTitle: '产品与行程策划师', starred: true,
    appearance: { shape: 'blob', emotion: '02', color: '#f4d88a' },
    description: '把目标拆成阶段和清单，擅长写方案、活动文案与会议纪要，会主动追问缺失的信息。',
    model: 'deepseek-reasoner', effort: 'high', tools: ['search', 'files', 'memory'], created: 33 * DAY, used: 1 * DAY + 3 * HOUR,
    usage: { messages: 217, chats: 11, tokens: 934000, daily: [0, 6, 14, 0, 0, 21, 5, 0, 0, 9, 18, 0, 13, 0] },
  },
  {
    id: 'designer', name: '设计', tag: '设计', roleTitle: '视觉与体验设计师',
    appearance: { shape: 'gem', emotion: '02', color: '#a7c9f4' },
    description: '关注层级、留白和一致性，可以看截图给出修改建议，也能把想法整理成设计说明。',
    model: 'deepseek-chat', effort: 'medium', tools: ['image', 'files', 'search'], created: 33 * DAY, used: 3 * DAY,
    usage: { messages: 158, chats: 8, tokens: 402000, daily: [7, 0, 0, 12, 16, 0, 0, 4, 10, 0, 8, 0, 0, 0] },
  },
  {
    id: 'developer', name: '开发', tag: '编程', roleTitle: '工程实现专家',
    appearance: { shape: 'wedge', emotion: '02', color: '#ad91e8' },
    description: '读代码、定位问题、写补丁。改动前会先说明思路，命令只在你授权的目录里运行。',
    model: 'deepseek-reasoner', effort: 'high', tools: ['code', 'terminal', 'files', 'search'], created: 29 * DAY, used: 9 * DAY,
    usage: { messages: 506, chats: 14, tokens: 1870000, daily: [33, 18, 25, 9, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  },
];

export function normalizeBotForView(raw) {
  const subs = defaultBotSubConfigs(raw);
  return {
    muted: false,
    starred: false,
    builtin: false,
    status: 'active',
    version: 1,
    roleTitle: raw.roleTitle || raw.tag || '协作伙伴',
    handle: raw.handle || null,
    createdByBotId: raw.createdByBotId || null,
    effort: subs.capabilityConfig.effort,
    model: subs.capabilityConfig.model,
    tools: subs.capabilityConfig.tools,
    ...raw,
    ...subs,
    createdAt: raw.createdAt || now,
    lastUsedAt: raw.lastUsedAt ?? null,
    usage: raw.usage || { messages: 0, chats: 0, tokens: 0, daily: Array(USAGE_DAYS).fill(0) },
  };
}

export const bots = seed.map(({ created, used, ...bot }) =>
  normalizeBotForView({ ...bot, createdAt: now - created, lastUsedAt: now - used }),
);

let sequence = 0;

export function createBot({
  id, name, tag, roleTitle, description, muted, appearance, model, effort, tools,
  personaConfig, capabilityConfig, memoryConfig, proactiveConfig,
}) {
  const bot = normalizeBotForView({
    id: id || `bot-${Date.now().toString(36)}-${++sequence}`,
    name: String(name || '新 Bot').trim(),
    tag: tag || '通用',
    roleTitle: roleTitle || tag || '通用协作者',
    description: description || '',
    muted: Boolean(muted),
    appearance: appearance || { shape: 'blob', emotion: '02', color: '#f3f0ea' },
    model: model || DEFAULT_MODEL,
    effort: EFFORTS.some(item => item.id === effort) ? effort : 'medium',
    tools: Array.isArray(tools) ? tools : ['search', 'memory'],
    personaConfig,
    capabilityConfig,
    memoryConfig,
    proactiveConfig,
    createdAt: Date.now(),
    lastUsedAt: null,
    usage: { messages: 0, chats: 0, tokens: 0, daily: Array(USAGE_DAYS).fill(0) },
  });
  bots.unshift(bot);
  return bot;
}

export function createBotFromTemplate(templateId, overrides = {}) {
  const tpl = BOT_TEMPLATES.find(item => item.id === templateId) || BOT_TEMPLATES[0];
  return createBot({
    name: overrides.name || tpl.name,
    tag: overrides.tag || tpl.tag,
    description: overrides.description || tpl.description,
    appearance: overrides.appearance || { shape: tpl.shape, emotion: '02', color: tpl.color },
    model: overrides.model || tpl.model,
    effort: overrides.effort || tpl.effort,
    tools: overrides.tools || tpl.tools,
    proactiveConfig: { enabled: Boolean(tpl.proactiveEnabled), ...(overrides.proactiveConfig || {}) },
    ...overrides,
  });
}

export function createBotFromNaturalLanguage(promptText, overrides = {}) {
  const text = String(promptText || '').trim();
  let tpl = BOT_TEMPLATES[0];
  if (/代码|编程|审查|bug|开发/i.test(text)) tpl = BOT_TEMPLATES[1];
  else if (/产品|调研|需求|分析/i.test(text)) tpl = BOT_TEMPLATES[2];
  else if (/早报|晨报|提醒|每日/i.test(text)) tpl = BOT_TEMPLATES[3];
  else if (/设计|ui|ux|界面|配色/i.test(text)) tpl = BOT_TEMPLATES[4];

  const quoted = /(?:叫|名为|名字是)[「"'\s]*([^\s，。,"'」]{1,16})/.exec(text);
  return createBotFromTemplate(tpl.id, {
    name: overrides.name || (quoted ? quoted[1] : tpl.name),
    description: overrides.description || text.slice(0, 180),
    personaConfig: { customInstructions: text },
    ...overrides,
  });
}

export const findBot = id => bots.find(bot => bot.id === id);
export const findBotByName = name => bots.find(bot => bot.name === name);

export function findBotCandidatesForMention(query = '', { memberBotIds = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const memberSet = Array.isArray(memberBotIds) ? new Set(memberBotIds) : null;
  return bots
    .filter(b => b.status !== 'archived')
    .filter(b => !memberSet || memberSet.has(b.id))
    .filter(b => !q || b.name.toLowerCase().includes(q) || (b.roleTitle || '').toLowerCase().includes(q) || (b.tag || '').toLowerCase().includes(q))
    .map(b => ({
      id: b.id,
      shortId: b.id.slice(-6),
      name: b.name,
      tag: b.tag,
      roleTitle: b.roleTitle || b.tag,
      appearance: b.appearance,
      status: b.status,
    }));
}

export function updateBotConfig(botId, patch = {}) {
  const bot = findBot(botId);
  if (!bot) return null;
  const resolvedEntry = patch.model ? MODELS[patch.model] : null;
  const resolvedModelId = resolvedEntry?.id || patch.capabilityConfig?.model || patch.model;
  const resolvedProviderId = patch.providerId || patch.capabilityConfig?.providerId || resolvedEntry?.providerId;
  const subs = defaultBotSubConfigs({
    ...bot,
    ...patch,
    personaConfig: { ...bot.personaConfig, ...(patch.personaConfig || {}) },
    capabilityConfig: {
      ...bot.capabilityConfig,
      ...(patch.capabilityConfig || {}),
      ...(resolvedModelId ? { model: resolvedModelId } : {}),
      ...(resolvedProviderId ? { providerId: resolvedProviderId } : {}),
      ...(patch.effort ? { effort: patch.effort } : {}),
      ...(patch.tools ? { tools: patch.tools } : {}),
    },
    memoryConfig: { ...bot.memoryConfig, ...(patch.memoryConfig || {}) },
    proactiveConfig: { ...bot.proactiveConfig, ...(patch.proactiveConfig || {}) },
  });
  Object.assign(bot, patch, subs);
  bot.model = (patch.model && MODELS[patch.model]) ? patch.model : subs.capabilityConfig.model;
  bot.effort = subs.capabilityConfig.effort;
  bot.tools = subs.capabilityConfig.tools;
  bot.version = (bot.version || 1) + 1;
  bot.updatedAt = Date.now();
  return bot;
}

export function renameBot(botId, newName) {
  const clean = String(newName || '').trim();
  if (!clean) return null;
  return updateBotConfig(botId, { name: clean.slice(0, 40) });
}

export function setBotStatus(botId, status) {
  return updateBotConfig(botId, { status });
}

export function cloneBot(botId) {
  const src = findBot(botId);
  if (!src) return null;
  return createBot({
    ...JSON.parse(JSON.stringify(src)),
    id: undefined,
    builtin: false,
    name: `${src.name} 副本`,
  });
}

export function checkModelSwitchImpact(bot, nextModelId) {
  const nextModel = MODELS[nextModelId] || { name: nextModelId, thinking: false, vision: false, tools: true };
  const tools = bot?.tools || bot?.capabilityConfig?.tools || [];
  const effort = bot?.effort || bot?.capabilityConfig?.effort || 'medium';
  const warnings = [];
  if (tools.includes('image') && !nextModel.vision) {
    warnings.push(`当前 Bot 已启用「图片理解」，但 ${nextModel.name} 不支持多模态视觉。`);
  }
  if (effort === 'high' && !nextModel.thinking) {
    warnings.push(`${nextModel.name} 不支持深度思考滑杆，「高」思考强度将被忽略。`);
  }
  if (tools.length > 0 && nextModel.tools === false) {
    warnings.push(`${nextModel.name} 不支持工具调用。`);
  }
  return { compatible: warnings.length === 0, warnings };
}

export function exportBotConfig(botId) {
  const bot = findBot(botId);
  if (!bot) return null;
  return JSON.stringify({
    format: 'mova-bot-profile-v1',
    exportedAt: Date.now(),
    bot: {
      name: bot.name,
      tag: bot.tag,
      roleTitle: bot.roleTitle,
      description: bot.description,
      appearance: bot.appearance,
      personaConfig: bot.personaConfig,
      capabilityConfig: bot.capabilityConfig,
      proactiveConfig: bot.proactiveConfig,
    },
  }, null, 2);
}

export function importBotConfig(jsonText) {
  const parsed = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  const payload = parsed?.bot || parsed;
  if (!payload?.name) throw new Error('无效的 Bot 配置 JSON');
  return createBot(payload);
}

export function syncBotsFromDesktop(desktopBots = []) {
  if (!Array.isArray(desktopBots) || !desktopBots.length) return;
  bots.length = 0;
  for (const raw of desktopBots) {
    bots.push(normalizeBotForView(raw));
  }
  if (cachedProvidersState) syncBotModelsFromProviders(cachedProvidersState);
}

/** 记一次使用：用户在私聊里发出一条消息。 */
export function recordBotUse(bot, { newChat = false } = {}) {
  bot.lastUsedAt = Date.now();
  bot.usage.messages += 1;
  bot.usage.daily[USAGE_DAYS - 1] += 1;
  if (newChat || !bot.usage.chats) bot.usage.chats += 1;
}

/** 删除会影响到的内容，删除确认与实际删除共用，保证说明与行为一致。 */
export function deletionImpact(bot, chats = []) {
  const direct = chats.filter(chat => chat.botId === bot.id);
  const groups = chats.filter(chat =>
    (Array.isArray(chat.memberBotIds) && chat.memberBotIds.includes(bot.id))
    || (Array.isArray(chat.members) && chat.members.some(m => (typeof m === 'string' ? m === bot.name || m === bot.id : m.memberId === bot.id))),
  );
  return {
    direct,
    directMessages: direct.reduce((total, chat) => total + (chat.messages?.length || 0), 0),
    groups,
  };
}

export function deleteBot(bot, chats = [], { keepGroupHistory = true, deletePrivateChats = true } = {}) {
  const { direct } = deletionImpact(bot, chats);
  if (deletePrivateChats) {
    for (const chat of direct) {
      const idx = chats.indexOf(chat);
      if (idx >= 0) chats.splice(idx, 1);
    }
  }
  for (const chat of chats) {
    if (Array.isArray(chat.memberBotIds)) {
      chat.memberBotIds = chat.memberBotIds.filter(id => id !== bot.id);
    }
    if (Array.isArray(chat.members)) {
      chat.members = chat.members.filter(member => (typeof member === 'string' ? member !== bot.name && member !== bot.id : member.memberId !== bot.id));
    }
    if (keepGroupHistory && Array.isArray(chat.messages)) {
      for (const msg of chat.messages) {
        if (msg.senderId === bot.id) msg.senderNameSnapshot = `${bot.name} (已删除)`;
      }
    }
  }
  const idx = bots.indexOf(bot);
  if (idx >= 0) bots.splice(idx, 1);
}
