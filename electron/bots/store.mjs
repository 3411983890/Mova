/**
 * 负责：管理 Bot 系统与自研小程序的统一持久化存储（本地原子 JSON 文件 + 可选 PostgreSQL 同步 + 内存测试模式），并提供初始内置 Bot/会话/小程序种子数据。
 * 不负责：权限裁剪、记忆隔离校验、路由选择或任务调度（这些由各自专门模块在读写本 store 时完成）。
 * 被谁调用：electron/bots/runtime.mjs、electron/bots/registry.mjs、electron/bots/conversation-service.mjs、electron/bots/memory-gateway.mjs、electron/bots/task-service.mjs、electron/bots/mini-app-service.mjs 及单元测试。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STORE_SCHEMA_VERSION = 1;

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function defaultPersona(overrides = {}) {
  return {
    tone: 'friendly', // friendly | concise | rigorous | playful
    proactivity: 'balanced', // passive | balanced | proactive
    replyLength: 'medium', // short | medium | detailed
    askTendency: 'moderate', // minimal | moderate | inquisitive
    collaborationStyle: 'cooperative', // lead | cooperative | specialist | observer
    userTitle: '你',
    customInstructions: '',
    botRelations: {}, // { [otherBotId]: { attitude, note } }
    ...overrides,
  };
}

function defaultCapabilities(overrides = {}) {
  return {
    model: 'deepseek-chat',
    effort: 'medium',
    tools: ['search', 'memory'],
    mcpServers: [],
    allowedRootIds: [],
    browserAllowed: false,
    desktopAllowed: false,
    autonomousCreateAllowed: false,
    canDelegate: true,
    ...overrides,
  };
}

function defaultMemoryConfig(overrides = {}) {
  return {
    enableIndependentMemory: true,
    enableGroupMemory: true,
    enableGlobalChatSearch: true,
    excludedConversationIds: [],
    retainGroupHistoryOnLeave: false,
    ...overrides,
  };
}

function defaultProactiveConfig(overrides = {}) {
  return {
    enabled: false,
    mode: 'balanced', // balanced | task_only | off
    maxDaily: 1,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    timezone: 'Asia/Shanghai',
    ignoredCount: 0,
    mutedTopics: [],
    lastProactiveDate: null,
    dailyCount: 0,
    ...overrides,
  };
}

export function createSeedData(now = Date.now()) {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const USAGE_DAYS = 14;

  const bots = [
    {
      id: 'mova',
      name: 'MovaBot',
      handle: 'mova',
      tag: '通用',
      roleTitle: '主协调助手',
      tagline: '把模糊的想法整理成可执行的下一步',
      description: '默认助手，擅长把模糊的想法整理成可执行的下一步。日常问答、写作和规划都可以先找它。',
      builtin: true,
      starred: true,
      muted: false,
      status: 'active',
      version: 1,
      appearance: { shape: 'blob', emotion: '02', color: '#f3f0ea' },
      personaConfig: defaultPersona({ tone: 'friendly', proactivity: 'proactive', collaborationStyle: 'lead' }),
      capabilityConfig: defaultCapabilities({
        model: 'deepseek-chat',
        effort: 'medium',
        tools: ['search', 'files', 'code', 'memory'],
        autonomousCreateAllowed: true,
      }),
      memoryConfig: defaultMemoryConfig(),
      proactiveConfig: defaultProactiveConfig({ enabled: true, maxDaily: 1 }),
      createdByBotId: null,
      templateId: 'builtin-mova',
      createdAt: now - 68 * DAY,
      updatedAt: now - 25 * 60 * 1000,
      lastUsedAt: now - 25 * 60 * 1000,
      archivedAt: null,
      usage: { messages: 1284, chats: 46, tokens: 2640000, daily: [22, 31, 18, 0, 9, 27, 40, 35, 12, 6, 29, 44, 38, 17] },
    },
    {
      id: 'helper',
      name: '助手',
      handle: 'helper',
      tag: '通用',
      roleTitle: '快速执行搭档',
      tagline: '查资料、做摘要和补充细节',
      description: '随叫随到的搭档，负责查资料、做摘要和补充细节，回答简短直接。',
      builtin: false,
      starred: false,
      muted: false,
      status: 'active',
      version: 1,
      appearance: { shape: 'blob', emotion: '02', color: '#81d1c2' },
      personaConfig: defaultPersona({ tone: 'concise', replyLength: 'short', collaborationStyle: 'cooperative' }),
      capabilityConfig: defaultCapabilities({ model: 'deepseek-chat', effort: 'low', tools: ['search', 'memory'] }),
      memoryConfig: defaultMemoryConfig(),
      proactiveConfig: defaultProactiveConfig({ enabled: false }),
      createdByBotId: null,
      templateId: 'builtin-helper',
      createdAt: now - 41 * DAY,
      updatedAt: now - 5 * HOUR,
      lastUsedAt: now - 5 * HOUR,
      archivedAt: null,
      usage: { messages: 392, chats: 19, tokens: 618000, daily: [4, 0, 11, 8, 0, 0, 15, 9, 3, 0, 12, 7, 0, 6] },
    },
    {
      id: 'planner',
      name: '策划',
      handle: 'planner',
      tag: '写作',
      roleTitle: '产品与行程策划师',
      tagline: '把目标拆成阶段和清单',
      description: '把目标拆成阶段和清单，擅长写方案、活动文案与会议纪要，会主动追问缺失的信息。',
      builtin: false,
      starred: true,
      muted: false,
      status: 'active',
      version: 1,
      appearance: { shape: 'blob', emotion: '02', color: '#f4d88a' },
      personaConfig: defaultPersona({ tone: 'rigorous', askTendency: 'inquisitive', collaborationStyle: 'lead' }),
      capabilityConfig: defaultCapabilities({ model: 'deepseek-reasoner', effort: 'high', tools: ['search', 'files', 'memory'] }),
      memoryConfig: defaultMemoryConfig(),
      proactiveConfig: defaultProactiveConfig({ enabled: true, maxDaily: 1 }),
      createdByBotId: null,
      templateId: 'builtin-planner',
      createdAt: now - 33 * DAY,
      updatedAt: now - (DAY + 3 * HOUR),
      lastUsedAt: now - (DAY + 3 * HOUR),
      archivedAt: null,
      usage: { messages: 217, chats: 11, tokens: 934000, daily: [0, 6, 14, 0, 0, 21, 5, 0, 0, 9, 18, 0, 13, 0] },
    },
    {
      id: 'designer',
      name: '设计',
      handle: 'designer',
      tag: '设计',
      roleTitle: '视觉与体验设计师',
      tagline: '关注层级、留白和一致性',
      description: '关注层级、留白和一致性，可以看截图给出修改建议，也能把想法整理成设计说明。',
      builtin: false,
      starred: false,
      muted: false,
      status: 'active',
      version: 1,
      appearance: { shape: 'gem', emotion: '02', color: '#a7c9f4' },
      personaConfig: defaultPersona({ tone: 'friendly', collaborationStyle: 'specialist' }),
      capabilityConfig: defaultCapabilities({ model: 'deepseek-chat', effort: 'medium', tools: ['image', 'files', 'search'] }),
      memoryConfig: defaultMemoryConfig(),
      proactiveConfig: defaultProactiveConfig({ enabled: false }),
      createdByBotId: null,
      templateId: 'builtin-designer',
      createdAt: now - 33 * DAY,
      updatedAt: now - 3 * DAY,
      lastUsedAt: now - 3 * DAY,
      archivedAt: null,
      usage: { messages: 158, chats: 8, tokens: 402000, daily: [7, 0, 0, 12, 16, 0, 0, 4, 10, 0, 8, 0, 0, 0] },
    },
    {
      id: 'developer',
      name: '开发',
      handle: 'developer',
      tag: '编程',
      roleTitle: '工程实现专家',
      tagline: '读代码、定位问题、写补丁',
      description: '读代码、定位问题、写补丁。改动前会先说明思路，命令只在你授权的目录里运行。',
      builtin: false,
      starred: false,
      muted: false,
      status: 'active',
      version: 1,
      appearance: { shape: 'wedge', emotion: '02', color: '#ad91e8' },
      personaConfig: defaultPersona({ tone: 'rigorous', replyLength: 'detailed', collaborationStyle: 'specialist' }),
      capabilityConfig: defaultCapabilities({ model: 'deepseek-reasoner', effort: 'high', tools: ['code', 'terminal', 'files', 'search'] }),
      memoryConfig: defaultMemoryConfig(),
      proactiveConfig: defaultProactiveConfig({ enabled: false }),
      createdByBotId: null,
      templateId: 'builtin-developer',
      createdAt: now - 29 * DAY,
      updatedAt: now - 9 * DAY,
      lastUsedAt: now - 9 * DAY,
      archivedAt: null,
      usage: { messages: 506, chats: 14, tokens: 1870000, daily: [33, 18, 25, 9, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    },
  ];

  const conversations = [
    {
      id: 'mova',
      type: 'private',
      botId: 'mova',
      title: 'MovaBot',
      topic: '默认对话',
      groupMode: 'natural',
      pinned: true,
      muted: false,
      unread: 0,
      version: 1,
      activeGoal: null,
      metadata: {},
      createdAt: now - 45 * DAY,
      updatedAt: now - 25 * 60 * 1000,
    },
    {
      id: 'group-two',
      type: 'group',
      botId: null,
      title: '双人协作',
      topic: '日常想法整理与快速执行',
      groupMode: 'natural',
      color: '#a7c9f4',
      place: null,
      pinned: false,
      muted: false,
      unread: 0,
      version: 1,
      activeGoal: null,
      metadata: {},
      createdAt: now - 10 * DAY,
      updatedAt: now - 6 * HOUR,
    },
    {
      id: 'group-team',
      type: 'group',
      botId: null,
      title: 'Mova 小团队',
      topic: '产品策划、设计与研发协作',
      groupMode: 'natural',
      color: '#f4d88a',
      place: null,
      pinned: false,
      muted: false,
      unread: 0,
      version: 1,
      activeGoal: null,
      metadata: {},
      createdAt: now - 8 * DAY,
      updatedAt: now - 2 * DAY,
    },
  ];

  const conversationMembers = [
    { conversationId: 'mova', memberType: 'user', memberId: 'user', role: 'owner', joinedAt: now - 45 * DAY, leftAt: null },
    { conversationId: 'mova', memberType: 'bot', memberId: 'mova', role: 'lead', joinedAt: now - 45 * DAY, leftAt: null },

    { conversationId: 'group-two', memberType: 'user', memberId: 'user', role: 'owner', joinedAt: now - 10 * DAY, leftAt: null },
    { conversationId: 'group-two', memberType: 'bot', memberId: 'mova', role: 'lead', joinedAt: now - 10 * DAY, leftAt: null },
    { conversationId: 'group-two', memberType: 'bot', memberId: 'helper', role: 'member', joinedAt: now - 10 * DAY, leftAt: null },

    { conversationId: 'group-team', memberType: 'user', memberId: 'user', role: 'owner', joinedAt: now - 8 * DAY, leftAt: null },
    { conversationId: 'group-team', memberType: 'bot', memberId: 'mova', role: 'lead', joinedAt: now - 8 * DAY, leftAt: null },
    { conversationId: 'group-team', memberType: 'bot', memberId: 'planner', role: 'member', joinedAt: now - 8 * DAY, leftAt: null },
    { conversationId: 'group-team', memberType: 'bot', memberId: 'designer', role: 'member', joinedAt: now - 8 * DAY, leftAt: null },
    { conversationId: 'group-team', memberType: 'bot', memberId: 'developer', role: 'member', joinedAt: now - 8 * DAY, leftAt: null },
    { conversationId: 'group-team', memberType: 'bot', memberId: 'helper', role: 'member', joinedAt: now - 8 * DAY, leftAt: null },
  ];

  const messages = [
    {
      id: 'welcome',
      conversationId: 'mova',
      sequence: 1,
      senderType: 'bot',
      senderId: 'mova',
      senderNameSnapshot: 'MovaBot',
      replyToMessageId: null,
      content: '你好，我是 MovaBot。我们可以直接聊目标、拉群协作，或者让我为你孵化一个专属小程序。',
      structuredPayload: null,
      attachments: [],
      status: 'done',
      runId: null,
      conversationVersion: 1,
      createdAt: now - 45 * DAY,
    },
    {
      id: 'group-two-1',
      conversationId: 'group-two',
      sequence: 1,
      senderType: 'bot',
      senderId: 'mova',
      senderNameSnapshot: 'MovaBot',
      replyToMessageId: null,
      content: '欢迎来到双人协作群。我们可以在这里一起整理想法，你可以 @ 任何一位成员或切换群聊模式。',
      structuredPayload: null,
      attachments: [],
      status: 'done',
      runId: null,
      conversationVersion: 1,
      createdAt: now - 10 * DAY,
    },
    {
      id: 'group-two-2',
      conversationId: 'group-two',
      sequence: 2,
      senderType: 'bot',
      senderId: 'helper',
      senderNameSnapshot: '助手',
      replyToMessageId: null,
      content: '我也在这里，随时可以帮忙查资料或做总结。',
      structuredPayload: null,
      attachments: [],
      status: 'done',
      runId: null,
      conversationVersion: 1,
      createdAt: now - 10 * DAY + 60_000,
    },
    {
      id: 'group-team-1',
      conversationId: 'group-team',
      sequence: 1,
      senderType: 'bot',
      senderId: 'mova',
      senderNameSnapshot: 'MovaBot',
      replyToMessageId: null,
      content: '大家好，这里是小团队群聊。策划、设计、开发和助手都已经就位。',
      structuredPayload: null,
      attachments: [],
      status: 'done',
      runId: null,
      conversationVersion: 1,
      createdAt: now - 8 * DAY,
    },
    {
      id: 'group-team-2',
      conversationId: 'group-team',
      sequence: 2,
      senderType: 'bot',
      senderId: 'designer',
      senderNameSnapshot: '设计',
      replyToMessageId: null,
      content: '我们可以在这里一起讨论、投票确认分歧点，并推进实际任务。',
      structuredPayload: null,
      attachments: [],
      status: 'done',
      runId: null,
      conversationVersion: 1,
      createdAt: now - 8 * DAY + 60_000,
    },
  ];

  const tripPackerHtml = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
body { font-family: var(--mova-font-sans, sans-serif); background: var(--mova-bg, #1c1c1c); color: var(--mova-fg, #efefef); margin: 0; padding: 14px; }
h1 { font-size: 16px; margin: 0 0 10px; }
.tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.tab { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--mova-border, #3a3a3a); background: var(--mova-elevated, #2a2a2a); color: inherit; cursor: pointer; font-size: 12px; }
.tab.active { background: var(--mova-accent, #5b9bf0); color: #fff; border-color: transparent; }
.card { background: var(--mova-surface, #242424); border: 1px solid var(--mova-border, #3a3a3a); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.row:last-child { border-bottom: none; }
input[type="text"] { background: var(--mova-bg, #1c1c1c); color: inherit; border: 1px solid var(--mova-border, #3a3a3a); border-radius: 6px; padding: 6px 8px; flex: 1; margin-right: 8px; }
button.primary { background: var(--mova-accent, #5b9bf0); color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
</style></head>
<body>
  <h1 id="app-title">行前清单一键看板</h1>
  <div class="tabs">
    <button class="tab active" data-route="overview">总览</button>
    <button class="tab" data-route="checklist">打包清单</button>
    <button class="tab" data-route="budget">预算账本</button>
  </div>
  <div id="view-root" class="card">加载中...</div>
  <div class="card" style="display:flex;align-items:center;">
    <input id="new-item-input" type="text" placeholder="添加新的行前准备项..." />
    <button id="add-btn" class="primary">添加</button>
  </div>
  <script>
    (async function() {
      const ctx = window.mova ? await window.mova.context.get() : { route: 'overview' };
      let currentRoute = ctx.route || 'overview';
      let items = (window.mova ? await window.mova.storage.get('items') : null) || [
        { id: 'i1', text: '护照与证件复印件', done: true, cost: 0 },
        { id: 'i2', text: '转换插头与充电宝', done: false, cost: 120 },
        { id: 'i3', text: '交通卡 / 国际漫游包', done: false, cost: 180 }
      ];
      async function saveAndRender() {
        if (window.mova) await window.mova.storage.set('items', items);
        render();
      }
      function render() {
        document.querySelectorAll('.tab').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.route === currentRoute);
        });
        const root = document.getElementById('view-root');
        const doneCount = items.filter(i => i.done).length;
        const totalCost = items.reduce((s, i) => s + Number(i.cost || 0), 0);
        if (currentRoute === 'overview') {
          root.innerHTML = '<div>完成进度：<strong>' + doneCount + ' / ' + items.length + '</strong></div><div style="margin-top:6px;opacity:.8">预计准备金：¥' + totalCost + '</div>';
        } else if (currentRoute === 'budget') {
          root.innerHTML = items.map(i => '<div class="row"><span>' + i.text + '</span><strong>¥' + (i.cost || 0) + '</strong></div>').join('');
        } else {
          root.innerHTML = items.map((i, idx) => '<label class="row" style="cursor:pointer"><span><input type="checkbox" ' + (i.done ? 'checked' : '') + ' data-idx="' + idx + '" /> ' + i.text + '</span><span>' + (i.done ? '已备齐' : '待准备') + '</span></label>').join('');
          root.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', e => { items[Number(e.target.dataset.idx)].done = e.target.checked; saveAndRender(); });
          });
        }
      }
      document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', () => { currentRoute = btn.dataset.route; render(); });
      });
      document.getElementById('add-btn').addEventListener('click', () => {
        const input = document.getElementById('new-item-input');
        const val = input.value.trim();
        if (!val) return;
        items.push({ id: 'i_' + Date.now(), text: val, done: false, cost: 0 });
        input.value = '';
        saveAndRender();
      });
      render();
    })();
  </script>
</body>
</html>`;

  const miniApps = [
    {
      appId: 'app_trip_packer',
      name: '行前清单一键看板',
      icon: 'cube',
      description: '由「策划」生成的轻量行前清单与预算看板，支持跨页签勾选和自动保存。',
      version: '1.0.0',
      createdByBotId: 'planner',
      conversationId: 'group-team',
      manifest: {
        appId: 'app_trip_packer',
        name: '行前清单一键看板',
        icon: 'cube',
        version: '1.0.0',
        createdByBotId: 'planner',
        entry: 'index.html',
        routes: [
          { id: 'overview', title: '总览' },
          { id: 'checklist', title: '打包清单' },
          { id: 'budget', title: '预算账本' },
        ],
        permissions: ['storage.read', 'storage.write'],
        sharedWith: ['mova', 'planner', 'helper'],
      },
      entryHtml: tripPackerHtml,
      sourceFiles: { 'index.html': tripPackerHtml },
      pinned: true,
      disabled: false,
      lastError: null,
      createdAt: now - 3 * DAY,
      updatedAt: now - 2 * DAY,
      lastOpenedAt: now - DAY,
    },
  ];

  const miniAppStorage = [
    {
      appId: 'app_trip_packer',
      namespace: 'kv',
      key: 'items',
      value: [
        { id: 'i1', text: '护照与证件复印件', done: true, cost: 0 },
        { id: 'i2', text: '转换插头与充电宝', done: false, cost: 120 },
        { id: 'i3', text: '交通卡 / 国际漫游包', done: false, cost: 180 },
      ],
      updatedAt: now - 2 * DAY,
    },
  ];

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    bots,
    conversations,
    conversationMembers,
    messages,
    messageMentions: [],
    events: [],
    tasks: [],
    taskRuns: [],
    triggers: [],
    memories: [
      {
        id: 'mem_seed_team_1',
        scopeType: 'group',
        scopeId: 'group-team',
        botId: 'planner',
        groupId: 'group-team',
        category: 'preference',
        content: '团队协作偏好：方案阶段先由策划梳理清单，再由设计与开发补充落地细节。',
        summary: 'Mova 小团队协作流程偏好',
        importance: 0.8,
        confidence: 0.9,
        supersededBy: null,
        sourceConversationId: 'group-team',
        sourceMessageId: 'group-team-1',
        pinned: true,
        createdAt: now - 7 * DAY,
        updatedAt: now - 7 * DAY,
        expiresAt: null,
      },
    ],
    approvalRequests: [],
    outbox: [],
    miniApps,
    miniAppStorage,
    settings: {
      keepAliveOnWindowClose: false,
      defaultTimezone: 'Asia/Shanghai',
      defaultQuietHoursStart: '22:00',
      defaultQuietHoursEnd: '08:00',
      globalMaxDailyProactive: 2,
      defaultBotMaxDailyProactive: 1,
      usageDays: USAGE_DAYS,
    },
  };
}

export function createBotStore({
  filePath = null,
  pgPool = null,
  clock = () => Date.now(),
  initialSeed = true,
  logger = console,
} = {}) {
  let state = loadInitialState();

  function loadInitialState() {
    if (filePath && fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return normalizeState(parsed);
        }
      } catch (err) {
        logger?.warn?.('[bot-store] failed to load state file, falling back to seed:', err?.message || err);
      }
    }
    const base = initialSeed ? createSeedData(clock()) : emptyState();
    return normalizeState(base);
  }

  function emptyState() {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      bots: [],
      conversations: [],
      conversationMembers: [],
      messages: [],
      messageMentions: [],
      events: [],
      tasks: [],
      taskRuns: [],
      triggers: [],
      memories: [],
      approvalRequests: [],
      outbox: [],
      miniApps: [],
      miniAppStorage: [],
      settings: {
        keepAliveOnWindowClose: false,
        defaultTimezone: 'Asia/Shanghai',
        defaultQuietHoursStart: '22:00',
        defaultQuietHoursEnd: '08:00',
        globalMaxDailyProactive: 2,
        defaultBotMaxDailyProactive: 1,
        usageDays: 14,
      },
    };
  }

  function normalizeState(raw) {
    const empty = emptyState();
    const normalized = {
      schemaVersion: Number(raw.schemaVersion || STORE_SCHEMA_VERSION),
      bots: Array.isArray(raw.bots) ? raw.bots : [],
      conversations: Array.isArray(raw.conversations) ? raw.conversations : [],
      conversationMembers: Array.isArray(raw.conversationMembers) ? raw.conversationMembers : [],
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      messageMentions: Array.isArray(raw.messageMentions) ? raw.messageMentions : [],
      events: Array.isArray(raw.events) ? raw.events : [],
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      taskRuns: Array.isArray(raw.taskRuns) ? raw.taskRuns : [],
      triggers: Array.isArray(raw.triggers) ? raw.triggers : [],
      memories: Array.isArray(raw.memories) ? raw.memories : [],
      approvalRequests: Array.isArray(raw.approvalRequests) ? raw.approvalRequests : [],
      outbox: Array.isArray(raw.outbox) ? raw.outbox : [],
      miniApps: Array.isArray(raw.miniApps) ? raw.miniApps : [],
      miniAppStorage: Array.isArray(raw.miniAppStorage) ? raw.miniAppStorage : [],
      settings: { ...empty.settings, ...(raw.settings || {}) },
    };

    // Legacy migration: if a group conversation still carries name-based `members` without `conversationMembers` rows,
    // resolve them once to stable Bot IDs.
    const botsByName = new Map();
    for (const bot of normalized.bots) {
      if (!botsByName.has(bot.name)) botsByName.set(bot.name, bot.id);
    }
    for (const conv of normalized.conversations) {
      if (conv.type === 'group' && Array.isArray(conv.legacyMemberNames)) {
        for (const name of conv.legacyMemberNames) {
          const botId = botsByName.get(name);
          if (botId && !normalized.conversationMembers.some(m => m.conversationId === conv.id && m.memberType === 'bot' && m.memberId === botId)) {
            normalized.conversationMembers.push({
              conversationId: conv.id,
              memberType: 'bot',
              memberId: botId,
              role: 'member',
              joinedAt: conv.createdAt || clock(),
              leftAt: null,
            });
          }
        }
        delete conv.legacyMemberNames;
      }
    }
    return normalized;
  }

  let pgSchemaEnsured = false;
  let pgSyncQueue = Promise.resolve();

  function resolvePgPool() {
    if (typeof pgPool === 'function') {
      try {
        return pgPool();
      } catch {
        return null;
      }
    }
    return pgPool || null;
  }

  async function ensurePgTable(pool) {
    if (pgSchemaEnsured || !pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mova_bot_state_kv (
        state_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    pgSchemaEnsured = true;
  }

  async function syncToPostgres(tableName, operation) {
    const pool = resolvePgPool();
    if (!pool) return;
    pgSyncQueue = pgSyncQueue
      .then(async () => {
        await ensurePgTable(pool);
        await operation(pool);
      })
      .catch(err => {
        logger?.warn?.(`[bot-store] pg sync failed (${tableName}):`, err?.message || err);
      });
    return pgSyncQueue;
  }

  function persistSnapshotToPostgres(snapshot = state) {
    const pool = resolvePgPool();
    if (!pool) return;
    const payloadJson = JSON.stringify(snapshot);
    const schemaVersion = Number(snapshot?.schemaVersion || STORE_SCHEMA_VERSION);
    void syncToPostgres('mova_bot_state_kv', p =>
      p.query(
        `INSERT INTO mova_bot_state_kv (state_key, payload, schema_version, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (state_key) DO UPDATE
         SET payload = EXCLUDED.payload,
             schema_version = EXCLUDED.schema_version,
             updated_at = NOW()`,
        ['primary', payloadJson, schemaVersion],
      ),
    );
  }

  function persist() {
    if (filePath) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    }
    persistSnapshotToPostgres(state);
  }

  function mutate(fn) {
    const result = fn(state);
    persist();
    return result;
  }

  function snapshot() {
    return cloneJson(state);
  }

  function nextSequence(conversationId) {
    let maxSeq = 0;
    for (const msg of state.messages) {
      if (msg.conversationId === conversationId && Number(msg.sequence) > maxSeq) {
        maxSeq = Number(msg.sequence);
      }
    }
    return maxSeq + 1;
  }

  function reloadFromDisk() {
    state = loadInitialState();
    return state;
  }

  return {
    get state() {
      return state;
    },
    clock,
    mutate,
    persist,
    snapshot,
    nextSequence,
    reloadFromDisk,
    syncToPostgres,
    flushPgSync: () => pgSyncQueue,
    helpers: {
      defaultPersona,
      defaultCapabilities,
      defaultMemoryConfig,
      defaultProactiveConfig,
    },
  };
}
