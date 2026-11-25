/**
 * 负责：集中定义 ChatMova / CodeMova / MovaBot 三个模式的演示模型、项目文件夹、Bot 通讯录与线程数据。
 */
export type MovaAppMode = 'ChatMova' | 'CodeMova' | 'MovaBot';
export type EffortLevelId = 'low' | 'medium' | 'high' | 'xhigh';
export type ModelProviderGroup = 'ChatGPT' | 'Gemini' | 'DeepSeek';
export type CodeHostScope = 'local' | 'cloud';
export type BotAvatarId =
  | 'advisor'
  | 'group-swarm'
  | 'maker'
  | 'scout'
  | 'copy'
  | 'planner'
  | 'review'
  | 'qa';

export interface EffortStop {
  value: EffortLevelId;
  label: string;
  short: string;
  hue: number;
}

export interface MovaModelOption {
  id: string;
  provider: ModelProviderGroup;
  name: string;
  defaultEffort: EffortLevelId;
  efforts: EffortLevelId[];
}

export interface CodeBlockItem {
  id: string;
  heading: string;
  languageLabel: string;
  code: string;
}

export interface CodeProjectFolder {
  id: string;
  name: string;
  host: CodeHostScope;
  chats: { id: string; title: string; activeDot?: boolean }[];
}

export interface BotThreadItem {
  id: string;
  avatarId: BotAvatarId;
  headerAvatarId: Exclude<BotAvatarId, 'group-swarm'>;
  headerName: string;
  title: string;
  preview: string;
  time: string;
  onlineDot?: boolean;
  unreadBlueDot?: boolean;
  waitingAmber?: boolean;
}

export interface BotContactProfile {
  id: string;
  avatarId: Exclude<BotAvatarId, 'group-swarm'>;
  name: string;
  indexLetter: string;
  roleTitle: string;
  tag: string;
  builtin?: boolean;
  online: boolean;
  bio: string;
  model: string;
  effort: string;
  tone: string;
  collabRole: string;
  browserPolicy: string;
  quietHours: string;
  defaultMuted: boolean;
  webSearch: boolean;
  memoryEnabled: boolean;
  canDelegate: boolean;
}

export const MOVA_APP_MODES: { id: MovaAppMode; label: MovaAppMode }[] = [
  { id: 'ChatMova', label: 'ChatMova' },
  { id: 'CodeMova', label: 'CodeMova' },
  { id: 'MovaBot', label: 'MovaBot' },
];

export const EFFORT_CATALOG: Record<EffortLevelId, EffortStop> = {
  low: { value: 'low', label: 'Low', short: 'Low', hue: 215 },
  medium: { value: 'medium', label: 'Medium', short: 'Med', hue: 224 },
  high: { value: 'high', label: 'High', short: 'High', hue: 236 },
  xhigh: { value: 'xhigh', label: 'Extra High', short: 'XHi', hue: 254 },
};

export const MOVA_MODELS: MovaModelOption[] = [
  {
    id: 'gpt-6.1-sol',
    provider: 'ChatGPT',
    name: 'GPT-6.1 Sol',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-6.1-terra',
    provider: 'ChatGPT',
    name: 'GPT-6.1 Terra',
    defaultEffort: 'high',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-6-astra',
    provider: 'ChatGPT',
    name: 'GPT-6 Astra',
    defaultEffort: 'high',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gemini-4-argon',
    provider: 'Gemini',
    name: 'Gemini 4 Argon',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gemini-4-hydrogen',
    provider: 'Gemini',
    name: 'Gemini 4 Hydrogen',
    defaultEffort: 'high',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'deepseek-v4.1-flash',
    provider: 'DeepSeek',
    name: 'DeepSeek V4.1 Flash',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'DeepSeek',
    name: 'DeepSeek-V4-Pro',
    defaultEffort: 'high',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
];

export const MOVA_CODE_BLOCKS: CodeBlockItem[] = [
  {
    id: 'reality-high',
    heading: 'REALITY 高位端口',
    languageLabel: 'Plain text',
    code: 'vless://fb81f57d-4736-4805-a6b7-bb825bf406e2@mova-cloud.edge:28443?security=reality&sni=mova.local#Mova-Reality',
  },
  {
    id: 'tuic-backup',
    heading: 'TUIC 备用线路',
    languageLabel: 'Plain text',
    code: 'tuic://2c5d3e9d-3794-456e-9571-76c36e288575:mova_sync@mova-cloud.edge:19443?congestion_control=bbr&alpn=h3',
  },
];

export const CODEMOVA_PROJECTS: CodeProjectFolder[] = [
  {
    id: 'proj-mova-core',
    name: 'Mova',
    host: 'local',
    chats: [
      { id: 'cm-mobile-glass', title: '手机端液态玻璃无限画板', activeDot: true },
      { id: 'cm-perm-lock', title: '审查文件写入权限护栏与路径锁' },
      { id: 'cm-rrf-search', title: '优化多源并发 RRF 检索管线' },
    ],
  },
  {
    id: 'proj-mova-ios',
    name: 'mova-mobile-ios',
    host: 'local',
    chats: [
      { id: 'cm-expo-pair', title: '一次性配对码与钥匙串存储' },
      { id: 'cm-apns-push', title: '配置 APNs 离线任务完成推送' },
    ],
  },
  {
    id: 'proj-edge-ext',
    name: 'edge-extension',
    host: 'local',
    chats: [{ id: 'cm-cdp-snap', title: '修复侧栏网页正文提取快照' }],
  },
  {
    id: 'proj-linux-cli',
    name: 'mova-linux-daemon',
    host: 'cloud',
    chats: [
      { id: 'cm-sse-cursor', title: '实现 SSE 断线重连与游标去重', activeDot: true },
      { id: 'cm-pg-lease', title: 'PostgreSQL 作业租约与重启恢复' },
      { id: 'cm-vpn-route', title: '同步桌面订阅模型专线规则' },
    ],
  },
  {
    id: 'proj-browser-worker',
    name: 'cloud-browser-skill',
    host: 'cloud',
    chats: [
      { id: 'cm-takeover', title: '验证码暂停与手机端人工接管闭环' },
      { id: 'cm-chromium-cdp', title: '无头 Chromium 独立配置隔离' },
    ],
  },
];

export const MOVABOT_THREADS: BotThreadItem[] = [
  {
    id: 'bot-advisor-dm',
    avatarId: 'advisor',
    headerAvatarId: 'advisor',
    headerName: 'advisor',
    title: 'advisor',
    preview: 'Maker 在渲。前三镜成片了，正在渲第 4 镜，一共 6 镜...',
    time: '01:52',
    onlineDot: true,
  },
  {
    id: 'bot-swarm-group',
    avatarId: 'group-swarm',
    headerAvatarId: 'advisor',
    headerName: 'advisor',
    title: 'advisor, Scout, Maker, Copy',
    preview: '你们几个人能不能去做一个赛道分析，你们自己...',
    time: '01:51',
  },
  {
    id: 'bot-maker',
    avatarId: 'maker',
    headerAvatarId: 'maker',
    headerName: 'Maker',
    title: 'Maker',
    preview: '键盘在建。成片 1920×1080，大约 16 秒，6 镜...',
    time: '01:21',
    onlineDot: true,
  },
  {
    id: 'bot-scout',
    avatarId: 'scout',
    headerAvatarId: 'scout',
    headerName: 'Scout',
    title: 'Scout',
    preview: '顾问不另开题。Fable 那条我盯着，到两位数...',
    time: 'Yesterday',
    unreadBlueDot: true,
  },
  {
    id: 'bot-copy',
    avatarId: 'copy',
    headerAvatarId: 'copy',
    headerName: 'Copy',
    title: 'Copy',
    preview: '明早那班精读我也先停了，免得又去点。顾问说...',
    time: 'Thursday',
  },
  {
    id: 'bot-planner',
    avatarId: 'planner',
    headerAvatarId: 'planner',
    headerName: '策划',
    title: '策划',
    preview: '今晚这题标题定了：Codex 额度莫名少了先查复...',
    time: 'Wednesday',
  },
  {
    id: 'bot-review',
    avatarId: 'review',
    headerAvatarId: 'review',
    headerName: 'Review',
    title: 'Review',
    preview: 'Waiting for you: Sign in to your X account',
    time: '8/13',
    waitingAmber: true,
  },
  {
    id: 'bot-qa',
    avatarId: 'qa',
    headerAvatarId: 'qa',
    headerName: 'QA Engineer',
    title: 'QA Engineer',
    preview: '监听新部署还差一步：聊天里那张 GitHub 连接...',
    time: '8/13',
  },
];

export const BOT_CONTACTS: BotContactProfile[] = [
  {
    id: 'contact-advisor',
    avatarId: 'advisor',
    name: 'advisor',
    indexLetter: 'A',
    roleTitle: '主统筹与视觉风格总监',
    tag: '统筹',
    builtin: true,
    online: true,
    bio: '负责锁风格、拆解多步骤任务并委派给 Maker、Scout、Copy 与 Review，不直接操作 Blender。',
    model: 'Gemini 4 Hydrogen',
    effort: 'High',
    tone: '干练直接 · 少废话',
    collabRole: '群聊主统筹（可委派子任务）',
    browserPolicy: '人工接管登录',
    quietHours: '22:00 – 08:00',
    defaultMuted: false,
    webSearch: true,
    memoryEnabled: true,
    canDelegate: true,
  },
  {
    id: 'contact-copy',
    avatarId: 'copy',
    name: 'Copy',
    indexLetter: 'C',
    roleTitle: '内容文案与深度精读',
    tag: '文案',
    online: false,
    bio: '擅长提炼技术与产品卖点、撰写发布文案与每日早报精读。',
    model: 'GPT-6.1 Terra',
    effort: 'Med',
    tone: '克制精准 · 有节奏感',
    collabRole: '协作者（受邀发言）',
    browserPolicy: '仅只读抓取',
    quietHours: '22:00 – 08:00',
    defaultMuted: false,
    webSearch: true,
    memoryEnabled: true,
    canDelegate: false,
  },
  {
    id: 'contact-planner',
    avatarId: 'planner',
    name: '策划',
    indexLetter: 'C',
    roleTitle: '选题策划与排期统筹',
    tag: '策划',
    online: false,
    bio: '将零散灵感整理为可执行选题、标题备选与每日发布排期。',
    model: 'DeepSeek-V4-Pro',
    effort: 'Med',
    tone: '有条理 · 善于追问关键点',
    collabRole: '创意策划',
    browserPolicy: '允许只读浏览',
    quietHours: '22:00 – 08:00',
    defaultMuted: false,
    webSearch: true,
    memoryEnabled: true,
    canDelegate: true,
  },
  {
    id: 'contact-maker',
    avatarId: 'maker',
    name: 'Maker',
    indexLetter: 'M',
    roleTitle: '3D 建模与产品动效渲染',
    tag: '制作',
    online: true,
    bio: '在云端工作站运行 Blender 与渲染管线，负责 1920×1080 镜头出片与材质打光。',
    model: 'Gemini 4 Hydrogen',
    effort: 'High',
    tone: '工程向 · 汇报进度清晰',
    collabRole: '专业执行者',
    browserPolicy: '已关闭',
    quietHours: '23:00 – 08:00',
    defaultMuted: false,
    webSearch: false,
    memoryEnabled: true,
    canDelegate: false,
  },
  {
    id: 'contact-qa',
    avatarId: 'qa',
    name: 'QA Engineer',
    indexLetter: 'Q',
    roleTitle: '自动化测试与部署巡检',
    tag: '质量',
    online: false,
    bio: '监听 GitHub 部署与 PR 状态，自动运行回归测试并汇总阻塞风险。',
    model: 'GPT-6 Astra',
    effort: 'High',
    tone: '严谨客观 · 先给结论',
    collabRole: '审计与验收',
    browserPolicy: '只读预览',
    quietHours: '22:00 – 08:00',
    defaultMuted: true,
    webSearch: true,
    memoryEnabled: true,
    canDelegate: false,
  },
  {
    id: 'contact-review',
    avatarId: 'review',
    name: 'Review',
    indexLetter: 'R',
    roleTitle: '成片审核与社媒发布把关',
    tag: '审核',
    online: true,
    bio: '对照风格基线验收镜头与文案，涉及外部账号登录与提交前必须发起人工确认。',
    model: 'Gemini 4 Hydrogen',
    effort: 'High',
    tone: '细致挑剔 · 注重合规',
    collabRole: '终审把关',
    browserPolicy: '提交前人工确认',
    quietHours: '22:00 – 08:00',
    defaultMuted: false,
    webSearch: true,
    memoryEnabled: true,
    canDelegate: false,
  },
  {
    id: 'contact-scout',
    avatarId: 'scout',
    name: 'Scout',
    indexLetter: 'S',
    roleTitle: '全网情报追踪与竞品雷达',
    tag: '调研',
    online: true,
    bio: '持续监控行业动态与热点帖子，采用多源 RRF 检索并附带可回溯引用。',
    model: 'DeepSeek-V4-Pro',
    effort: 'XHi',
    tone: '敏锐简洁 · 数据驱动',
    collabRole: '信息侦察',
    browserPolicy: '允许只读浏览',
    quietHours: '22:00 – 08:00',
    defaultMuted: false,
    webSearch: true,
    memoryEnabled: true,
    canDelegate: false,
  },
];

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function formatMovaWeekdayTime(ts?: number): string {
  const date = ts ? new Date(ts) : new Date();
  return `${WEEKDAYS[date.getDay()]} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;
}
