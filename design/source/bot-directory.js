// Bot 通讯录的共享数据：通讯录页与「消息」页读的是同一份资料。
// 群聊仍按成员名字（chat.members）关联，私聊按 chat.botId 关联。

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
export const USAGE_DAYS = 14;

export const MODELS = {
  'deepseek-chat': { name: 'DeepSeek Chat', provider: 'DeepSeek', note: '均衡，响应快，适合日常对话', thinking: false },
  'deepseek-reasoner': { name: 'DeepSeek Reasoner', provider: 'DeepSeek', note: '先思考再回答，适合复杂推理', thinking: true },
};
export const DEFAULT_MODEL = 'deepseek-chat';
export const EFFORTS = [
  { id: 'low', label: '低', note: '更快，适合简单问题' },
  { id: 'medium', label: '中', note: '速度与深度均衡' },
  { id: 'high', label: '高', note: '想得更久，适合难题' },
];

export const TOOLS = {
  search: { label: '联网搜索', detail: '按需检索公开网页' },
  files: { label: '文件读取', detail: '读取已授权文件夹' },
  code: { label: '代码执行', detail: '运行脚本并返回结果' },
  terminal: { label: '终端命令', detail: '在授权目录内运行' },
  image: { label: '图片理解', detail: '识别截图与设计稿' },
  memory: { label: '长期记忆', detail: '记住偏好与背景' },
};

const now = Date.now();
const seed = [
  { id: 'mova', name: 'MovaBot', tag: '通用', builtin: true, starred: true, appearance: { shape: 'blob', emotion: '02', color: '#f3f0ea' },
    description: '默认助手，擅长把模糊的想法整理成可执行的下一步。日常问答、写作和规划都可以先找它。',
    model: 'deepseek-chat', tools: ['search', 'files', 'code', 'memory'], created: 68 * DAY, used: 25 * 60 * 1000,
    usage: { messages: 1284, chats: 46, tokens: 2640000, daily: [22, 31, 18, 0, 9, 27, 40, 35, 12, 6, 29, 44, 38, 17] } },
  { id: 'helper', name: '助手', tag: '通用', appearance: { shape: 'blob', emotion: '02', color: '#81d1c2' },
    description: '随叫随到的搭档，负责查资料、做摘要和补充细节，回答简短直接。',
    model: 'deepseek-chat', tools: ['search', 'memory'], created: 41 * DAY, used: 5 * HOUR,
    usage: { messages: 392, chats: 19, tokens: 618000, daily: [4, 0, 11, 8, 0, 0, 15, 9, 3, 0, 12, 7, 0, 6] } },
  { id: 'planner', name: '策划', tag: '写作', starred: true, appearance: { shape: 'blob', emotion: '02', color: '#f4d88a' },
    description: '把目标拆成阶段和清单，擅长写方案、活动文案与会议纪要，会主动追问缺失的信息。',
    model: 'deepseek-reasoner', tools: ['search', 'files', 'memory'], created: 33 * DAY, used: 1 * DAY + 3 * HOUR,
    usage: { messages: 217, chats: 11, tokens: 934000, daily: [0, 6, 14, 0, 0, 21, 5, 0, 0, 9, 18, 0, 13, 0] } },
  { id: 'designer', name: '设计', tag: '设计', appearance: { shape: 'gem', emotion: '02', color: '#a7c9f4' },
    description: '关注层级、留白和一致性，可以看截图给出修改建议，也能把想法整理成设计说明。',
    model: 'deepseek-chat', tools: ['image', 'files', 'search'], created: 33 * DAY, used: 3 * DAY,
    usage: { messages: 158, chats: 8, tokens: 402000, daily: [7, 0, 0, 12, 16, 0, 0, 4, 10, 0, 8, 0, 0, 0] } },
  { id: 'developer', name: '开发', tag: '编程', appearance: { shape: 'wedge', emotion: '02', color: '#ad91e8' },
    description: '读代码、定位问题、写补丁。改动前会先说明思路，命令只在你授权的目录里运行。',
    model: 'deepseek-reasoner', tools: ['code', 'terminal', 'files', 'search'], created: 29 * DAY, used: 9 * DAY,
    usage: { messages: 506, chats: 14, tokens: 1870000, daily: [33, 18, 25, 9, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
];

export const bots = seed.map(({ created, used, ...bot }) => ({ muted: false, starred: false, builtin: false, effort: 'medium', ...bot, createdAt: now - created, lastUsedAt: now - used }));

let sequence = 0;
export function createBot({ name, tag, description, muted, appearance, model, effort }) {
  const bot = {
    id: `bot-${Date.now().toString(36)}-${++sequence}`, name, tag: tag || '通用', description, muted: Boolean(muted), starred: false, builtin: false,
    appearance, model: MODELS[model] ? model : DEFAULT_MODEL, effort: EFFORTS.some(item => item.id === effort) ? effort : 'medium', tools: ['search', 'memory'], createdAt: Date.now(), lastUsedAt: null,
    usage: { messages: 0, chats: 0, tokens: 0, daily: Array(USAGE_DAYS).fill(0) },
  };
  bots.unshift(bot);
  return bot;
}

export const findBot = id => bots.find(bot => bot.id === id);
export const findBotByName = name => bots.find(bot => bot.name === name);

/** 记一次使用：用户在私聊里发出一条消息。 */
export function recordBotUse(bot, { newChat = false } = {}) {
  bot.lastUsedAt = Date.now();
  bot.usage.messages += 1;
  bot.usage.daily[USAGE_DAYS - 1] += 1;
  if (newChat || !bot.usage.chats) bot.usage.chats += 1;
}

/** 删除会影响到的内容，删除确认与实际删除共用，保证说明与行为一致。 */
export function deletionImpact(bot, chats) {
  const direct = chats.filter(chat => chat.botId === bot.id);
  return {
    direct,
    directMessages: direct.reduce((total, chat) => total + chat.messages.length, 0),
    groups: chats.filter(chat => chat.members?.includes(bot.name)),
  };
}

export function deleteBot(bot, chats) {
  const { direct } = deletionImpact(bot, chats);
  for (const chat of direct) chats.splice(chats.indexOf(chat), 1);
  for (const chat of chats) if (chat.members) chat.members = chat.members.filter(member => member !== bot.name);
  bots.splice(bots.indexOf(bot), 1);
}
