/* Mova workspace: local conversations and model streaming. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import loaderStyles from 'generative-loaders/styles.css?inline';
import { mountComposer } from './src/features/composer/composer.js';
import { ChatTranscript } from './src/features/chat/chat-transcript';
import { mergeReplyEvent, receiveReply } from './src/features/chat/chat-reply';
import { createChatFeedback } from './src/features/chat/chat-feedback.mjs';
const feedbackState = createChatFeedback();
import { mockMovaClient } from './src/services/mock-mova-client';
import { createDesktopMovaClient, ModelConnectionError } from './src/services/desktop-model-client';
import { BotConversation, BotList } from './src/features/bot/bot-conversation.jsx';
import { BotBuilder } from './src/features/bot/bot-builder.jsx';
import { BotActivity } from './src/features/bot/bot-activity.jsx';
import { Forum } from './src/features/bot/forum.jsx';
import { createProjectRecord, readProjectDraft } from './src/features/projects/project-data.js';
import { rootIdsForRequest } from './src/features/permissions/request-scope.js';
import { createDemoConversation } from './src/data/demo-transcript.js';
import { MemorySettings } from './src/features/memory/memory-settings.jsx';
import { CliModelsSettings } from './src/features/cli-models/cli-models-settings.jsx';
import { VpnSettings } from './src/features/vpn/vpn-settings.jsx';
import { CloudConnectionsSettings } from './src/features/cloud-connections/cloud-connections-settings.jsx';
import { RemoteHostForm, WorkspaceLocation } from './src/features/cloud-connections/workspace-location.jsx';
import { CLOUD_ORIGIN_STORAGE_KEY, cloudTaskError, desktopCloudCall } from './src/features/cloud-connections/workspace-location.mjs';
import { waitForCloudTask } from './src/services/cloud-tasks.mjs';
import { McpSettings } from './src/features/mcp/mcp-settings.jsx';
import { BrowserSettings } from './src/features/browser/browser-settings.jsx';
import { mountDesktopSettings } from './src/features/desktop/desktop-settings.js';
import { mountDesignWorkspace } from './src/features/design/design-workspace.js';
import { DesignSettings } from './src/features/design/design-settings.jsx';
import { AskCard } from './src/features/ask/ask-card.jsx';
import { createInteractionRouter } from './src/features/chat/interaction-router.mjs';
import { recoverModelSelection } from './src/features/chat/model-selection.mjs';
import { FormCard } from './src/features/ask/form-card.jsx';
import { mountSideBrowser } from './src/features/browser/side-browser.js';
import { ApprovalBar } from './src/features/approvals/approval-bar.jsx';
import { isNoticeEvent, noticeRow } from './src/features/chat/notice-row.js';
import { buildGoalTurn, GOAL_AUTO_MAX_ROUNDS, GOAL_STOP_TEXT, goalRoundDecision } from './src/features/chat/goal-loop.mjs';
import { bindChatQuoteSource, mergeUserText, normalizeQuote, QUOTE_LIMIT, USER_TEXT_BUDGET } from './src/features/chat/quote-source';
import { migrateKeyedState, planChatRename } from './src/features/chat/chat-rename.js';
import { instantChatTitle } from './src/features/chat/chat-title-text.mjs';
import { keysForChat, keysForProject } from './src/features/chat/conversation-keys.mjs';
import { attachmentSummary, checkAttachments, toRequestAttachment } from './src/features/chat/attachment-rules.mjs';
import { canAddQuote, createQuoteChips } from './src/features/chat/quote-chips';
import './src/features/chat/quote.css';

const loaderStyleElement = document.createElement('style');
loaderStyleElement.textContent = loaderStyles;
document.head.append(loaderStyleElement);
import { createChatRows } from './src/features/sidebar/sidebar-chats.js';
import { bindSidebarResize } from './src/features/sidebar/sidebar-resize.js';
import { bindChatUsage } from './src/features/chat/chat-usage.js';
import { bindChatAim } from './src/features/chat/chat-aim.js';
import { confirmAction } from './src/features/ui/confirm.js';
import { notify } from './src/features/ui/toast.js';
import { flushSync } from 'react-dom';
import { bindMorphPopover } from './src/features/botchat/morph-popover.js';
import { BotChatInfo, GroupChatInfo } from './src/features/botchat/bot-chat-info.jsx';
import { GroupBuilder } from './src/features/botchat/group-dialog.jsx';
import { PlacePicker } from './src/features/botchat/place-dialog.jsx';
import { Contacts } from './src/features/contacts/contacts.jsx';
import { MiniAppsView, MiniAppSideDrawer } from './src/features/miniapps/miniapps.jsx';
import {
  bots, cloneBot, createBot, createBotFromNaturalLanguage, createBotFromTemplate,
  deleteBot, exportBotConfig, findBot, findBotByName, importBotConfig, recordBotUse, renameBot, syncBotModelsFromProviders, syncBotsFromDesktop, updateBotConfig,
} from './src/features/bot/bot-directory.js';
import { icon, replaceStaticIcons } from './src/shared/icons.js';
replaceStaticIcons();

// Fullscreen takes precedence over focus for the window chrome color.
function updateWindowChrome() {
  document.documentElement.classList.toggle('window-focused', document.hasFocus() && !document.fullscreenElement);
}
window.addEventListener('focus', updateWindowChrome);
window.addEventListener('blur', updateWindowChrome);
document.addEventListener('fullscreenchange', updateWindowChrome);
updateWindowChrome();

const $ = (selector) => document.querySelector(selector);
const projects = [
  { name: 'Mova', chats: ['开发 Mova 界面 HTML 原型', { title: 'Mova开发前的思考', archived: true }] },
  { name: 'UE5MCP', chats: ['免费AI动作工具', '在 UE5 新建关卡并放置球体', { title: '选择UE5游戏项目模板', archived: true }] },
  { name: 'BirdyMall', chats: ['制作酒瓶与摇壶几何插画', { title: '分析小程序并重设计酒水点单界面', location: 'cloud' }, '配置原价门票直接核销', { title: '把成就勋章部分制作成意见反馈', archived: true }, { title: '重新设计小程序 UI 与交互', archived: true }] },
  { name: 'GameDevelopmentSkill', chats: ['生成该角色的左右视图和后视图', '替换主角服装并优化画质', '设计搜打撤佛菩萨角色', '查找免费 Blender 植被插件', { title: '规划美术资源并确认风格', archived: true }] },
].map(project => ({
  ...project,
  chats: project.chats.map(chat => ({ location: 'local', archived: false, ...(typeof chat === 'string' ? { title: chat } : chat) })),
}));
let chatTick = 0;
const ARCHIVE_BASE = Date.UTC(2026, 10, 9, 12, 54);
projects.forEach(project => project.chats.forEach(chat => {
  chat.createdAt = ARCHIVE_BASE - chatTick * 5.4 * 3600 * 1000;
  chat.updatedAt = chat.createdAt;
  chatTick += 1;
}));
const STORAGE_KEY = 'mova.workspace.v1';
const memoryBridge = window.movaDesktop?.memory;
const permissionBridge = window.movaDesktop?.permissions;
const isEdge = window.movaDesktop?.isEdge === true;
let permissionRoots = [];
const sideBrowser = mountSideBrowser({
  roots: () => {
    // 完全访问权限：所有已登记文件夹都可用于打开文件引用，不再限制在当前项目。
    if (currentPermissionPreset() === 'full') return permissionRoots;
    const scoped = permissionRoots.filter(root =>
      projectFolders().some(folder => folder.id === root.id && folder.project === selectedProject));
    if (scoped.length) return scoped;
    // ChatMova has no project scope. A file reference the user was given should
    // still open in the viewer when the folder was granted read access elsewhere.
    if ($('#mode-label').textContent !== 'ChatMova') return scoped;
    return permissionRoots.filter(root => root.capabilities?.read !== false);
  },
  collapseSidebar: () => toggleSidebar(false, true),
  expandSidebar: () => toggleSidebar(true, true),
});
let memoryReady = !memoryBridge;
let memorySaveError = '';
let memorySettings = { memoryEnabled: true, autoExtract: true, includeGlobal: true };
const temporaryConversations = new Set();
let temporaryNextChat = false;
let memoryPageRoot;
let memoryPageVersion = 0;
const memoryProjectId = () => $('#mode-label').textContent === 'CodeMova' ? selectedProject : null;
function workspaceSnapshot() {
  const filteredProjects = projects.map(project => ({ ...project, chats: project.chats.filter(chat =>
    !temporaryConversations.has(JSON.stringify([chat.mode || 'CodeMova', project.name, chat.title]))) }));
  const keep = ([key]) => !temporaryConversations.has(key);
  return {
    version: 1,
    projects: filteredProjects,
    conversations: [...conversations].filter(keep),
    // 目标 / 计划与真实用量的权威副本：会话被删后一并清理，临时会话永不写入。
    aims: [...chatAims].filter(keep),
    usage: [...chatUsage].filter(keep),
    permissionPresets: [...chatPermissionPresets].filter(row => keep(row) && conversations.has(row[0])),
    modelSelections: [...chatModelSelections].filter(row => keep(row) && conversations.has(row[0])),
  };
}
let savedWorkspace = null;
try {
  const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (value?.version === 1 && Array.isArray(value.projects) && Array.isArray(value.conversations)) savedWorkspace = value;
} catch (error) {
  console.warn('无法读取本地工作区', error);
}
if (savedWorkspace) projects.splice(0, projects.length, ...savedWorkspace.projects);

const chatRows = createChatRows($('.project-sidebar'), $('.project-scroll'));
setInterval(() => chatRows.refreshTimes?.(), 60_000);

/** The conversation key a chat row maps to; `activeReplies` is keyed by exactly this. */
function chatConversationKey(project, chat) {
  return JSON.stringify([chat.mode || 'CodeMova', project.name, chat.title]);
}

/** A chat is "running" while its reply stream is still open. */
function isChatRunning(project, chat) {
  return activeReplies.has(conversations.get(chatConversationKey(project, chat)));
}

/**
 * When the row was last active. Chats saved before the timestamp fields existed have neither
 * `updatedAt` nor `createdAt`, which left the age blank and sank them to the bottom of the list;
 * their own turns still carry the time, so fall back to the newest one.
 */
function chatStamp(project, chat) {
  const direct = Number(chat.updatedAt || chat.createdAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const messages = conversations.get(chatConversationKey(project, chat));
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const at = Number(messages[index]?.at);
    if (Number.isFinite(at) && at > 0) return at;
  }
  return 0;
}

/** Newest conversation first: the stamp is what "最后进行" means here. */
function byRecency(a, b) {
  return chatStamp(b.project, b.chat) - chatStamp(a.project, a.chat);
}

/**
 * Every piece of per-conversation state is keyed by `[mode, project, title]`, so a rename has to
 * carry those entries across — messages, draft, goal, usage, permission preset and the design
 * document — instead of leaving them behind under the old title.
 */
function migrateConversationKey(from, to) {
  migrateKeyedState({
    from,
    to,
    maps: [conversations, drafts, feedbackState.entries, chatPermissionPresets, chatModelSelections, chatAims, chatUsage, chatContexts],
    sets: [temporaryConversations],
  });
  // The canvas document is stored under the same scope, in the main process.
  if (from && to && from !== to) {
      sideBrowser?.rekeyScope(from, to);
      designWorkspace?.rekey?.(from, to);
    }
}

/** Apply a model-suggested title; keeps it unique inside the project and re-renders the list. */
function renameChat(project, chat, nextTitle, conversationKey) {
  const plan = planChatRename({ project, chat, nextTitle, conversationKey });
  if (!plan) return false;
  chat.title = plan.next;
  migrateConversationKey(plan.from, plan.to);
  if (selectedChat === plan.previous && selectedProject === project.name) selectedChat = plan.next;
  renderProjects($('#project-search').value);
  saveWorkspace();
  return true;
}

/**
 * Name a new conversation from its first exchange. Runs after the reply finished so it does not
 * compete with the stream for the provider's rate limit; any failure keeps the title derived from
 * the question, so this can never break a send.
 */
async function suggestChatTitle({ project, chat, conversationKey, user, assistant, providerId, modelId }) {
  const bridge = window.movaDesktop?.titles;
  if (!bridge?.suggest || !project || !chat) return;
  if (temporaryConversations.has(conversationKey)) return;
  try {
    const result = await bridge.suggest({
      user: String(user || ''),
      assistant: String(assistant || '').slice(0, 2000),
      // 用这条对话真正在跑的模型取名：主进程若退回「持久化的 active provider」，
      // 订阅/自建 provider 混用时就会取不到 key，标题永远生成不出来。
      ...(typeof providerId === 'string' && providerId ? { providerId } : {}),
      ...(typeof modelId === 'string' && modelId ? { modelId } : {}),
    });
    const title = result?.ok ? result.value?.title : '';
    if (title) renameChat(project, chat, title, conversationKey);
  } catch { /* keep the derived title */ }
}


/** Repaint the running rings without rebuilding the list (keeps scroll and hover intact). */
function syncRunningChats() {
  chatRows.syncRunning?.(key => activeReplies.has(conversations.get(key)));
}
const refreshSidebarResize = bindSidebarResize($('.content-frame'), $('.project-sidebar'), $('.sidebar-divider'), {
  onCollapse: () => toggleSidebar(false),
});
const collapsedProjects = new Set();
let selectedProject = 'Mova';
let selectedChat = '';
const designWorkspace = mountDesignWorkspace({ getScope: () => {
  const scope = draftKey();
  if (temporaryNextChat || temporaryConversations.has(scope)) throw new Error('请在普通对话中使用设计画板，以便保存设计文档');
  return scope;
}, host: {
  slot: sideBrowser?.getCanvasSlot?.() || null,
  showView: value => sideBrowser?.showView?.(value),
  close: () => sideBrowser?.leaveCanvas?.(),
} });
let activeArea = 'home';
let homeSelectedModel = 'deepseek-chat';
const BOT_MODEL = 'deepseek-chat';
let selectedBot = 'mova';
let botSequence = 0;
let botPendingApprovals = [];
const botTasksByConv = new Map();
const botGroupMemories = new Map();
const botStatusMap = new Map();
let miniAppsFocusedId = null;
let miniAppsFocusedRoute = 'overview';
let miniAppsInitialized = false;
const miniAppDrawerState = { open: false, appId: null, route: 'overview' };
const botChats = [
  {
    id: 'mova', botId: 'mova', type: 'private', title: 'MovaBot', topic: '日常协作', muted: false, unread: 0,
    createdAt: Date.now() - 45 * 864e5,
    messages: [{ id: 'welcome', role: 'bot', senderId: 'mova', senderName: 'MovaBot', text: '你好，我是 MovaBot。有什么想法或任务，都可以在这里告诉我。' }],
  },
  {
    id: 'group-two', type: 'group', title: '双人协作',
    memberBotIds: ['mova', 'helper'], members: ['MovaBot', '助手'],
    groupMode: 'natural', color: '#a7c9f4', muted: false, unread: 0,
    createdAt: Date.now() - 12 * 864e5,
    place: { id: 'project:Mova', name: 'Mova', kind: 'project' },
    messages: [
      { id: 'group-two-1', role: 'bot', senderId: 'mova', senderName: 'MovaBot', sender: 'MovaBot', text: '欢迎来到双人协作群。我们可以在这里一起整理想法。' },
      { id: 'group-two-2', role: 'bot', senderId: 'helper', senderName: '助手', sender: '助手', text: '我也在这里，随时可以开始。' },
    ],
  },
  {
    id: 'group-team', type: 'group', title: 'Mova 小团队',
    memberBotIds: ['mova', 'planner', 'designer', 'developer', 'helper'], members: ['MovaBot', '策划', '设计', '开发', '助手'],
    groupMode: 'discussion', color: '#f4d88a', muted: false, unread: 0,
    createdAt: Date.now() - 26 * 864e5,
    place: { id: 'project:Mova', name: 'Mova', kind: 'project' },
    messages: [
      { id: 'group-team-1', role: 'bot', senderId: 'mova', senderName: 'MovaBot', sender: 'MovaBot', text: '大家好，这里是小团队的群聊预览。' },
      { id: 'group-team-2', role: 'bot', senderId: 'designer', senderName: '设计', sender: '设计', text: '我们可以在这里一起讨论、投票决策，或让我为你动态孵化专属小程序。' },
      {
        id: 'group-team-app', role: 'bot', senderId: 'planner', senderName: '策划', sender: '策划',
        text: '我已为你准备好团队出行/行前协作轻应用「行前清单看板」：',
        structuredPayload: {
          type: 'mini_app_card',
          appId: 'app_trip_packer',
          name: '行前清单看板',
          version: '1.0.0',
          description: '支持按总览、清单条目与预算实时追踪与同步，数据独立持久化。',
          metrics: [{ label: '版本', value: 'v1.0.0' }, { label: '共享范围', value: '3 个 Bot' }],
          quickRoutes: [
            { id: 'overview', title: '总览' },
            { id: 'checklist', title: '清单条目' },
            { id: 'budget', title: '预算' },
          ],
        },
      },
    ],
  },
];
let selectedContact = 'mova';
let botListRoot;
let botConversationRoot;
let nextDraftId = 0;
const drafts = new Map();
const conversations = new Map(savedWorkspace?.conversations || []);
const chatPermissionPresets = new Map(savedWorkspace?.permissionPresets || []);
const chatModelSelections = new Map(savedWorkspace?.modelSelections || []);
let draftPermissionPreset = 'default';
const normalizePermissionPreset = value => {
  if (value === 'auto' || value === 'auto_review') return 'auto';
  if (value === 'full' || value === 'full_access') return 'full';
  return 'default';
};
/* 目标 / 计划与真实用量都按会话键存放；aimView / usageView 挂载后赋值。 */
const chatAims = new Map(Array.isArray(savedWorkspace?.aims) ? savedWorkspace.aims : []);
const chatUsage = new Map(Array.isArray(savedWorkspace?.usage) ? savedWorkspace.usage : []);
/* 上下文台账的上报（`{type:'context', report}`）只按会话存、不渲染面板、不持久化：
   它描述的是「最近一次请求实际发了什么」，属于观测值，写进 workspace 只会变成过期数字。
   生命周期与 chatAims 一致：切换会话按 key 分开，删除会话时一起清掉。 */
const chatContexts = new Map();
let aimView = null;
let usageView = null;
// 老版本没有保存 at：用聊天的创建时间兜底，避免消息行永远没有日期。
for (const [key, turns] of conversations) {
  if (!Array.isArray(turns)) continue;
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object' || turn.at) continue;
    turn.at = conversationStart(key);
  }
}
const activeReplies = new Map();
for (const messages of conversations.values()) {
  for (const message of messages) {
    if (message.reply?.status === 'streaming') {
      message.reply.status = 'interrupted';
      settleSearchRows(message.reply.timeline, '上次搜索已中断');
      settleToolRows(message.reply.timeline, '上次操作已中断');
    }
  }
}
let saveTimer;
let sessionRevision;
let acceptedSessionRevision;
let pendingSaves = 0;
let saveGeneration = 0;
let syncingSessions = false;
/**
 * 本地状态的变更计数。同步是「2 秒轮询 + 覆盖式应用」，如果请求发出之后本地又改过
 * （删了聊天、改了标题、发了新消息），那份响应就是**旧快照**：直接应用会把刚删掉的聊天
 * 又塞回来。所以发请求前记一份 epoch，回来时不一致就整份丢弃。
 */
let workspaceEpoch = 0;
async function persistSessions() {
  const generation = ++saveGeneration;
  const revision = acceptedSessionRevision;
  const snapshot = workspaceSnapshot();
  acceptedSessionRevision = undefined;
  pendingSaves += 1;
  try {
    const result = await memoryBridge.saveSessions(snapshot, revision);
    if (!result.ok && generation === saveGeneration) acceptedSessionRevision ??= revision;
    if (result.ok && generation === saveGeneration && result.value) {
      sessionRevision = result.value.refresh ? undefined : result.value.revision;
    }
    return result;
  } finally { pendingSaves -= 1; }
}
function saveWorkspace() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  workspaceEpoch += 1;
  try {
    if (memoryBridge) {
      if (!memoryReady) return;
      void persistSessions().then(result => {
        if (!result.ok) {
          memorySaveError = result.error;
          chatFeedback('聊天保存失败：' + result.error + '。为防数据丢失已暂停发送；请到「设置 → 记忆与存储」导出备份并检查磁盘。');
        } else memorySaveError = '';
      }).catch(() => {
        memorySaveError = 'storage-error';
        chatFeedback('无法连接本地会话存储，为防数据丢失已暂停发送。请勿关闭窗口。');
      });
    } else localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaceSnapshot()));
  } catch (error) {
    console.warn('无法保存本地工作区', error);
    const announcement = $('#sidebar-announcement');
    if (announcement) announcement.textContent = '本地保存失败，请检查浏览器存储空间或权限';
  }
}
function scheduleWorkspaceSave() {
  // Full snapshots are large; coalesce long streams into occasional durable checkpoints.
  workspaceEpoch += 1;
  saveTimer ??= setTimeout(saveWorkspace, 1500);
}
window.addEventListener('pagehide', () => {
  if (saveTimer !== undefined) saveWorkspace();
});
const draftKey = () => activeArea === 'messages' ? JSON.stringify(['MovaBot', selectedBot]) : JSON.stringify([$('#mode-label').textContent, selectedProject, selectedChat]);
const currentPermissionPreset = () => normalizePermissionPreset(
  selectedChat || activeArea === 'messages' ? chatPermissionPresets.get(draftKey()) : draftPermissionPreset,
);
let shownPermissionPreset;
// 引用 chip 行在 composer 挂载后创建；此处先占位，便于 restoreDraft() 早于它调用时安全返回。
let quoteChipRow = null;
function currentDraft() {
  const key = draftKey();
  if (!drafts.has(key)) drafts.set(key, { id: ++nextDraftId, text: '', attachments: [], quotes: [] });
  return drafts.get(key);
}
function restoreDraft() {
  sideBrowser?.syncScope(draftKey());
  designWorkspace.syncScope();
  syncComposerModels();
  composer.update({ draft: currentDraft() });
  renderQuoteChips();
  renderConversation();
}
function isFlatChatList() {
  return $('#mode-label').textContent !== 'CodeMova';
}

function renderProjects(query = '') {
  saveWorkspace();
  if (isEdge) renderEdgeChats();
  chatRows.close();
  const list = $('#project-list'); list.replaceChildren();
  const q = query.trim().toLocaleLowerCase();
  const flat = isFlatChatList();
  $('#project-scroll-title').textContent = flat ? '聊天' : '项目';
  $('#project-scroll').dataset.flat = String(flat);
  if (flat) {
    renderFlatChats(q, list);
    return;
  }
  projects.forEach(project => {
    const matchesProject = project.name.toLocaleLowerCase().includes(q);
    const chats = project.chats.filter(chat => (!chat.mode || chat.mode === 'CodeMova') && (matchesProject || chat.title.toLocaleLowerCase().includes(q)));
    if (!matchesProject && !chats.length) return;
    const group = document.createElement('div'); group.className = 'project-group';
    const collapsed = collapsedProjects.has(project.name);
    const row = document.createElement('div');
    row.className = 'project-row';
    row.dataset.project = project.name;
    row.classList.toggle('selected', project.name === selectedProject && !selectedChat);
    row.classList.toggle('collapsed', collapsed);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'project-row-open';
    open.append(icon('folder-open'));
    const label = document.createElement('span');
    label.textContent = project.name;
    open.append(label);
    open.title = collapsed ? `展开 ${project.name}` : `收起 ${project.name}`;
    open.setAttribute('aria-expanded', String(!collapsed));
    open.addEventListener('click', () => {
      if (collapsedProjects.has(project.name)) collapsedProjects.delete(project.name);
      else collapsedProjects.add(project.name);
      renderProjects($('#project-search').value);
    });

    const actions = document.createElement('div');
    actions.className = 'project-row-actions';
    const newChatButton = document.createElement('button');
    newChatButton.type = 'button';
    newChatButton.className = 'project-row-action';
    newChatButton.setAttribute('aria-label', `在 ${project.name} 中新建对话`);
    newChatButton.title = '新建对话';
    newChatButton.append(icon('circle-plus'));
    newChatButton.addEventListener('click', event => { event.stopPropagation(); startChatInProject(project); });
    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'project-row-action';
    menuButton.setAttribute('aria-label', `${project.name} 的更多操作`);
    menuButton.title = '更多操作';
    menuButton.append(icon('dots-three'));
    menuButton.addEventListener('click', event => {
      event.stopPropagation();
      openProjectMenu(project, menuButton);
    });
    actions.append(menuButton, newChatButton);
    row.append(open, actions);
    group.append(row);

    const renderChat = chat => chatRows.create(project, chat, {
      selected: selectedChat === chat.title && selectedProject === project.name,
      running: isChatRunning(project, chat),
      conversationKey: chatConversationKey(project, chat),
      stamp: chatStamp(project, chat),
      temporary: isTemporaryChat(project, chat),
      onOpen: () => selectProject(project.name, chat.title),
      onArchive: () => toggleArchive(project, chat),
      onDelete: () => deleteTemporaryChat(project, chat),
    });
    if (collapsed) {
      list.append(group);
      return;
    }
    const visibleChats = chats
      .filter(chat => !chat.archived)
      .sort((a, b) => byRecency({ project, chat: a }, { project, chat: b }));
    group.append(...visibleChats.map(renderChat));
    if (!visibleChats.length) {
      const empty = document.createElement('p');
      empty.className = 'project-empty';
      empty.textContent = '暂无聊天';
      group.append(empty);
    }
    list.append(group);
  });
  $('#search-empty').hidden = Boolean(list.children.length);
}

function renderFlatChats(q, list) {
  const entries = [];
  projects.forEach(project => {
    project.chats.forEach(chat => {
      if (chat.mode && chat.mode !== 'ChatMova') return;
      if (q && !chat.title.toLocaleLowerCase().includes(q)) return;
      entries.push({ project, chat });
    });
  });
  const renderChat = (project, chat) => chatRows.create(project, chat, {
    selected: selectedChat === chat.title && selectedProject === project.name,
    running: isChatRunning(project, chat),
    conversationKey: chatConversationKey(project, chat),
    stamp: chatStamp(project, chat),
    temporary: isTemporaryChat(project, chat),
    onOpen: () => selectProject(project.name, chat.title),
    onArchive: () => toggleArchive(project, chat),
    onDelete: () => deleteTemporaryChat(project, chat),
  });
  entries
    .filter(({ chat }) => !chat.archived)
    .sort(byRecency)
    .forEach(({ project, chat }) => {
      list.append(renderChat(project, chat));
    });
  $('#search-empty').hidden = Boolean(list.children.length);
}

function startChatInProject(project) {
  collapsedProjects.delete(project.name);
  selectedProject = project.name;
  selectedChat = '';
  $('#welcome-project').textContent = project.name;
  drafts.delete(draftKey());
  conversations.delete(draftKey());
  renderProjects($('#project-search').value);
  restoreDraft();
  requestAnimationFrame(() => composer.root.querySelector('textarea')?.focus());
  $('#sidebar-announcement').textContent = `已在 ${project.name} 中新建对话`;
}

let projectMenu = null;
function closeProjectMenu() {
  if (!projectMenu) return;
  projectMenu.remove();
  projectMenu = null;
}

function projectMenuItems(project) {
  return [
    { icon: 'pin', label: '置顶', run: () => {
      const index = projects.indexOf(project);
      if (index > 0) { projects.splice(index, 1); projects.unshift(project); }
      renderProjects($('#project-search').value);
    } },
    { icon: 'gear', label: '编辑', run: () => {
      editingProject = project;
      $('#project-dialog-title').textContent = '编辑项目';
      projectName.value = project.name;
      $('#project-instructions').value = project.instructions ?? '';
      setProjectPlace(project.cloudOrigin ? { kind: 'cloud', origin: project.cloudOrigin, name: project.cloudLabel || project.cloudOrigin } : null);
      $('#project-form').dispatchEvent(new CustomEvent('project-folders-load', { detail: project.sourceFolders || [] }));
      projectName.setCustomValidity('');
      projectDialog.showModal();
      projectName.select();
    } },
    { icon: 'folder-simple', label: '在资源管理器中打开', run: () => {
      const rootId = project.sourceFolders?.[0]?.id;
      if (!permissionBridge || !rootId) {
        $('#sidebar-announcement').textContent = '这个项目没有已登记的文件夹，无法在资源管理器中打开';
        return;
      }
      void permissionBridge.reveal(rootId).then(result => {
        if (!result?.ok) $('#sidebar-announcement').textContent = '无法打开文件夹：它尚未登记权限或路径不存在';
      }).catch(() => { $('#sidebar-announcement').textContent = '无法打开文件夹'; });
    } },
    { divider: true },
    { icon: 'archive', label: '归档', run: async () => {
      project.chats.forEach(chat => { chat.archived = true; });
      if (selectedProject === project.name) { selectedChat = ''; restoreDraft(); }
      const persisted = await persistArchiveChange();
      renderProjects($('#project-search').value);
      $('#sidebar-announcement').textContent = `已归档${project.name} 的聊天${persisted ? '' : STORAGE_NOT_READY_HINT}`;
    } },
    { divider: true },
    { icon: 'x', label: '移除项目', danger: true, run: async () => {
      // 移除项目必须**连会话一起删**：主进程是用会话行反推项目的
      // （postgres-repository 的 buildProjects 见到某个 projectName 的会话就会把项目建回来），
      // 只 splice 内存里的 projects 会让项目和它的聊天在几秒后、或重启后复活。
      const keys = keysForProject(conversations.keys(), project.name);
      // 产品口径：这和「删记忆」是两件事。项目下还有记忆时 mova_projects 行会被
      // 故意保留（删项目行会级联删掉记忆），所以它只是从侧栏移除，记忆页里照旧。
      // 这句话必须写在确认弹窗里，不能只活在代码注释里。
      const confirmed = await confirmAction({
        title: `移除项目「${project.name}」？`,
        body: keys.length
          ? `侧栏里的这个项目和它的 ${keys.length} 条会话会被删除，其它项目不受影响。`
          : '侧栏里的这个项目会被删除，其它项目不受影响。',
        detail: '不可撤销。项目下的记忆不会被删除：只要项目里还有记忆，项目记录就会保留下来（记忆页仍可看到），但不会再回到侧栏。',
        confirmLabel: '移除项目',
        tone: 'danger',
      });
      if (!confirmed) return;
      const current = projects.indexOf(project);
      if (current < 0) return;
      for (const key of keys) dropConversationKey(key);
      projects.splice(current, 1);
      if (selectedProject === project.name) {
        selectedProject = projects[0]?.name ?? '';
        selectedChat = '';
        restoreDraft();
      }
      renderProjects($('#project-search').value);
      $('#sidebar-announcement').textContent = `已移除项目：${project.name}${keys.length ? `（连同 ${keys.length} 条会话）` : ''}`;
      void releaseProjectPermissions(project);
    } },
  ];
}

function openProjectMenu(project, anchorEl) {
  closeProjectMenu();
  const menu = document.createElement('div');
  menu.className = 'project-menu';
  menu.setAttribute('role', 'menu');
  projectMenuItems(project).forEach(item => {
    if (item.divider) {
      const line = document.createElement('div');
      line.className = 'project-menu-divider';
      menu.append(line);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project-menu-item';
    button.setAttribute('role', 'menuitem');
    if (item.danger) button.classList.add('danger');
    button.append(icon(item.icon));
    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(label);
    if (item.chevron) {
      const chevron = document.createElement('span');
      chevron.className = 'project-menu-chevron';
      chevron.textContent = '›';
      button.append(chevron);
    }
    button.addEventListener('click', () => {
      closeProjectMenu();
      item.run();
    });
    menu.append(button);
  });
  document.body.append(menu);
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = rect.right + 6 + menuRect.width <= window.innerWidth - 12 ? rect.right + 6 : rect.left - menuRect.width - 6;
  const top = Math.min(rect.top, window.innerHeight - menuRect.height - 12);
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.top = `${Math.max(12, top)}px`;
  projectMenu = menu;
}

document.addEventListener('pointerdown', event => {
  if (projectMenu && !projectMenu.contains(event.target)) closeProjectMenu();
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeProjectMenu();
});

const STORAGE_NOT_READY_HINT = '（本地存储未就绪，这次改动可能不会保存）';
/**
 * 归档 / 取消归档是用户的显式选择，必须落盘。renderProjects() 里虽然也会存一次，但归档
 * 状态丢掉时用户当场看不出来（要等重启、聊天「复原」了才发现），所以这里显式再存一次。
 * 返回 Promise<boolean>：false = 本地存储没就绪或这次保存**真的失败**了，调用方必须把
 * STORAGE_NOT_READY_HINT 播报出去。以前这里固定 `return true`，保存失败也照样播报
 * 「已归档」，等于骗用户。
 */
function persistArchiveChange() {
  if (memoryBridge && !memoryReady) return Promise.resolve(false);
  if (!memoryBridge) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaceSnapshot()));
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
  // 和 saveWorkspace() 一样：先清掉待发的合并保存，再让任何在途的 syncSessions 响应失效，
  // 然后同步地等这一次保存的真实结果。
  clearTimeout(saveTimer);
  saveTimer = undefined;
  workspaceEpoch += 1;
  return persistSessions().then(result => {
    if (!result?.ok) {
      memorySaveError = result?.error || 'storage-error';
      return false;
    }
    memorySaveError = '';
    return true;
  }).catch(() => {
    memorySaveError = 'storage-error';
    return false;
  });
}
/** 临时聊天在 workspaceSnapshot() 里整条被过滤：它的归档标记也存不下来。 */
function isTemporaryChat(project, chat) {
  return temporaryConversations.has(chatConversationKey(project, chat));
}
/**
 * 一条聊天对应的所有会话键。
 *
 * 键必须**跨 mode** 全部命中：同一个聊天可能以别的 mode 存过（用户切换过 CodeMova / ChatMova，
 * 或历史数据 mode 不同）。只按当前 mode 拼键会「删了又回来」——这正是归档页删除那条注释的由来，
 * 现在归档页和临时聊天删除共用这一份。
 */
function chatKeysFor(project, chat) {
  const modes = chat.mode ? [chat.mode] : ['ChatMova', 'CodeMova'];
  return [...new Set([
    ...keysForChat(conversations.keys(), { project: project.name, title: chat.title }),
    ...modes.map(mode => JSON.stringify([mode, project.name, chat.title])),
  ])];
}
/**
 * 清掉一条会话的全部内存状态：正文 + 目标/计划 + 用量 + 引用上下文 + 权限预设 + 临时标记。
 * 三个入口（删聊天、删临时聊天、移除项目）都只走这一处——历史上这段逻辑抄了两份，
 * 改一边漏一边的表现就是「删了正文但目标还在」或「临时标记永远留着」。
 */
function dropConversationKey(key) {
  activeReplies.get(conversations.get(key))?.abort();
  conversations.delete(key);
  chatAims.delete(key);
  chatUsage.delete(key);
  chatContexts.delete(key);
  chatPermissionPresets.delete(key);
  temporaryConversations.delete(key);
}
/**
 * 把一个聊天从内存里彻底移除：项目里的行 + 它的每条会话，并把「正选中它」的状态收干净。
 * 不负责确认弹窗与播报（两个入口的话术不一样）。
 * @returns {string[]} 被删掉的会话键，调用方可以据此统计条数或做后续处理。
 */
function dropChat(project, chat) {
  const keys = chatKeysFor(project, chat);
  const index = project.chats.indexOf(chat);
  if (index >= 0) project.chats.splice(index, 1);
  for (const key of keys) dropConversationKey(key);
  // 删掉的正是当前打开的会话：不留在「已选中但不存在」的状态里，
  // 否则下一次发送会顺着旧 key 把会话又建出来。
  if (selectedChat === chat.title && selectedProject === project.name) {
    selectedChat = '';
    renderConversation?.();
  }
  return keys;
}
/**
 * 删除一条临时聊天。
 *
 * 临时聊天**不进存储**（workspaceSnapshot() 里整条被过滤），所以它既不能归档，也没有
 * 「删除后重启复活」的风险：直接删，连确认弹窗都不弹——弹窗只会把「删掉一段本来就没保存的
 * 对话」说得比实际更严重。侧栏播报一句，避免用户以为点了没反应。
 *
 * 刻意不调 saveWorkspace()：快照里从来没有这条聊天，存一次只会白白多跑一轮同步。
 */
function deleteTemporaryChat(project, chat) {
  // 防御：只有临时聊天可以「一键删除、不弹确认」。普通聊天必须走带了确认弹窗的
  // 「永久删除」（归档页那条路）——否则侧栏一次误点就永久丢数据。
  if (!isTemporaryChat(project, chat)) {
    $('#sidebar-announcement').textContent = `这不是临时聊天，已取消删除：${chat.title}`;
    return false;
  }
  dropChat(project, chat);
  renderProjects($('#project-search').value);
  $('#sidebar-announcement').textContent = `已删除临时聊天：${chat.title}`;
  return true;
}
async function toggleArchive(project, chat) {
  if (!chat.archived && isTemporaryChat(project, chat)) {
    // 行尾按钮对临时聊天已经换成「删除」（chatRowAction），这条分支只是兜底：
    // 万一还有旧路径走到归档，也要说清为什么不给归档，而不是默默存不下来。
    $('#sidebar-announcement').textContent = `临时聊天不会被保存，无法归档：${chat.title}`;
    return;
  }
  chat.archived = !chat.archived;
  if (chat.archived && selectedProject === project.name && selectedChat === chat.title) {
    selectedChat = '';
    restoreDraft();
  }
  const pending = persistArchiveChange();
  renderProjects($('#project-search').value);
  const row = Array.from(document.querySelectorAll('.project-row')).find(button => button.title === project.name);
  const summary = row?.parentElement.querySelector('.chat-archive summary');
  (chat.archived && summary ? summary : row)?.focus({ preventScroll: true });
  const persisted = await pending;
  $('#sidebar-announcement').textContent = `${chat.archived ? '已归档' : '已恢复'}：${chat.title}${persisted ? '' : STORAGE_NOT_READY_HINT}`;
}
function selectProject(name, chat = '') {
  hidePeekNow();
  selectedProject = name; selectedChat = chat;
  $('#welcome-project').textContent = name;
  renderProjects($('#project-search').value); restoreDraft();
  if (chat && memoryReady) reconnectProjectCloudTask();
  if (matchMedia('(max-width:620px)').matches) toggleSidebar(false);
}
let autoCollapsedAt = null;
let manualExpandedAt = null;
function toggleSidebar(expanded = $('.window-shell').classList.contains('sidebar-collapsed'), automatic = false) {
  if (!automatic) {
    autoCollapsedAt = null;
    manualExpandedAt = expanded ? $('.content-frame').clientWidth : null;
  }
  chatRows.close();
  hidePeekNow();
  $('.window-shell').classList.toggle('sidebar-collapsed', !expanded);
  $('#sidebar-toggle').setAttribute('aria-expanded', String(expanded));
  $('#sidebar-toggle').setAttribute('aria-label', expanded ? '收起侧边栏' : '展开侧边栏');
  refreshSidebarResize();
}
$('#sidebar-toggle').addEventListener('click', () => toggleSidebar());

// Observe the actual chat width: a dragged divider changes it without resizing the window.
// Remember the frame width at collapse so hiding the sidebar cannot immediately undo itself.
const layoutFrame = $('.content-frame');
const mainPanel = $('.main-panel');
const sidebarCollapseWidth = 360;
const layoutObserver = new ResizeObserver(() => {
  if (activeArea === 'forum') return;
  const frameWidth = layoutFrame.clientWidth;
  const collapsed = $('.window-shell').classList.contains('sidebar-collapsed');
  if (manualExpandedAt !== null && (frameWidth !== manualExpandedAt || mainPanel.clientWidth >= sidebarCollapseWidth)) manualExpandedAt = null;
  if (autoCollapsedAt !== null) {
    if (frameWidth >= autoCollapsedAt + 64) {
      autoCollapsedAt = null;
      toggleSidebar(true, true);
    }
  } else if (!collapsed && manualExpandedAt === null && !matchMedia('(max-width:620px)').matches && mainPanel.clientWidth < sidebarCollapseWidth) {
    autoCollapsedAt = frameWidth;
    toggleSidebar(false, true);
  }
});
layoutObserver.observe(mainPanel);
layoutObserver.observe(layoutFrame);
function closeMenus() {
  $('#mode-menu').hidden = true; $('#mode-toggle').setAttribute('aria-expanded', 'false');
  $('#notification-menu').hidden = true; $('#notifications-toggle').setAttribute('aria-expanded', 'false');
}
function openModes() {
  const wasOpen = !$('#mode-menu').hidden; closeMenus();
  $('#mode-menu').hidden = wasOpen; $('#mode-toggle').setAttribute('aria-expanded', String(!wasOpen));
}
$('#mode-toggle').addEventListener('click', openModes);
$('#mode-toggle').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); closeMenus(); $('#mode-menu').hidden = false; $('#mode-toggle').setAttribute('aria-expanded', 'true'); $('#mode-menu button').focus(); }
});
$('#mode-menu').addEventListener('keydown', e => {
  const items = [...$('#mode-menu').querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
});
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if ($('#mode-label').textContent !== button.dataset.mode) selectedChat = '';
  $('#mode-label').textContent = button.dataset.mode;
  document.title = `${button.dataset.mode} · Mova`;
  $('#new-project').hidden = button.dataset.mode !== 'CodeMova';
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-checked', String(b === button)));
  closeMenus(); renderProjects($('#project-search').value); restoreDraft(); $('#mode-toggle').focus();
}));
$('#notifications-toggle').addEventListener('click', () => {
  const wasOpen = !$('#notification-menu').hidden; closeMenus();
  $('#notification-menu').hidden = wasOpen; $('#notifications-toggle').setAttribute('aria-expanded', String(!wasOpen));
});
document.addEventListener('click', e => { if (!e.target.closest('.sidebar-heading')) closeMenus(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { const modesOpen = !$('#mode-menu').hidden; closeMenus(); if (modesOpen) $('#mode-toggle').focus(); }
});
$('#search-toggle').addEventListener('click', () => {
  const show = $('#search-box').hidden; $('#search-box').hidden = !show;
  $('#search-toggle').setAttribute('aria-expanded', String(show));
  if (show) $('#project-search').focus(); else { $('#project-search').value = ''; renderProjects(); }
});
$('#project-search').addEventListener('input', e => renderProjects(e.target.value));
$('#clear-search').addEventListener('click', () => { $('#project-search').value = ''; renderProjects(); $('#project-search').focus(); });
function newChat() {
  selectedChat = '';
  drafts.delete(draftKey());
  conversations.delete(draftKey());
  restoreDraft();
  renderProjects($('#project-search').value);
  requestAnimationFrame(() => composer.root.querySelector('textarea')?.focus());
}
$('#new-chat').addEventListener('click', newChat);
const projectDialog = $('#project-dialog');
const projectName = $('#project-name');
const projectLocationRoot = createRoot($('#project-location-root'));
const remoteHostDialog = $('#remote-host-dialog');
const remoteHostRoot = createRoot($('#remote-host-root'));
const cloudBridge = window.movaDesktop?.cloud;
function openRemoteHost(onPair, trigger) {
  if (remoteHostDialog.open) return;
  flushSync(() => remoteHostRoot.render(React.createElement(RemoteHostForm, {
    cloud: cloudBridge, onCancel: () => remoteHostDialog.close(),
    onPair: host => {
      remoteHostDialog.close();
      if (!localStorage.getItem(CLOUD_ORIGIN_STORAGE_KEY)) localStorage.setItem(CLOUD_ORIGIN_STORAGE_KEY, host.origin);
      onPair(host);
      document.dispatchEvent(new CustomEvent('mova-cloud-hosts-change', { detail: { origin: host.origin } }));
    },
  })));
  remoteHostDialog.addEventListener('close', () => trigger?.focus(), { once: true });
  remoteHostDialog.showModal();
}
remoteHostDialog.addEventListener('close', () => remoteHostRoot.render(null));
function setProjectPlace(place) {
  const form = $('#project-form');
  form.dataset.cloudOrigin = place?.origin || '';
  form.dataset.cloudLabel = place?.name || '';
  form.dispatchEvent(new Event('project-location-change'));
  projectLocationRoot.render(React.createElement(WorkspaceLocation, {
    cloud: cloudBridge, value: place, onChange: setProjectPlace, onAddHost: openRemoteHost, embedded: true,
  }));
}
setProjectPlace(null);
projectDialog.addEventListener('close', () => projectLocationRoot.render(null));
let editingProject = null;
$('#new-project').addEventListener('click', () => {
  editingProject = null;
  $('#project-form').reset();
  setProjectPlace(null);
  $('#project-dialog-title').textContent = '新项目';
  projectName.setCustomValidity('');
  projectDialog.showModal();
});
$('#cancel-project').addEventListener('click', () => projectDialog.close());
projectName.addEventListener('input', () => projectName.setCustomValidity(''));
$('#project-form').addEventListener('submit', event => {
  event.preventDefault();
  const draft = readProjectDraft(event.currentTarget);
  let record;
  try {
    record = createProjectRecord(projectName.value, draft);
  } catch (error) {
    projectName.setCustomValidity(error.message);
    projectName.reportValidity();
    return;
  }
  const name = record.name;
  const clash = projects.some(project => project !== editingProject && project.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (clash) {
    projectName.setCustomValidity('这个项目名称已存在');
    projectName.reportValidity();
    return;
  }
  if (editingProject) {
    const previous = editingProject.name;
    editingProject.name = name;
    editingProject.instructions = record.instructions;
    editingProject.sourceFolders = record.sourceFolders;
    editingProject.device = record.device;
    editingProject.cloudOrigin = record.cloudOrigin;
    editingProject.cloudLabel = record.cloudLabel;
    for (const [key, messages] of [...conversations]) {
      const parts = JSON.parse(key);
      if (parts.length === 3 && parts[1] === previous) {
        conversations.delete(key);
        parts[1] = name;
        const nextKey = JSON.stringify(parts);
        sideBrowser?.rekeyScope(key, nextKey);
        designWorkspace.rekey(key, nextKey);
        conversations.set(nextKey, messages);
        if (chatModelSelections.has(key)) {
          chatModelSelections.set(nextKey, chatModelSelections.get(key));
          chatModelSelections.delete(key);
        }
        if (chatPermissionPresets.has(key)) {
          chatPermissionPresets.set(nextKey, chatPermissionPresets.get(key));
          chatPermissionPresets.delete(key);
    chatModelSelections.delete(key);
        }
      }
    }
    if (selectedProject === previous) selectedProject = name;
    projectDialog.close();
    renderProjects($('#project-search').value);
    renderConversation();
    $('#sidebar-announcement').textContent = `已重命名项目：${name}`;
    editingProject = null;
    return;
  }
  projects.unshift(record);
  $('#project-search').value = '';
  projectDialog.close();
  selectProject(name);
  $('.project-row.selected')?.scrollIntoView({ block: 'nearest' });
  $('#sidebar-announcement').textContent = record.sourceFolders.length
    ? `已创建项目：${name}，并添加 ${record.sourceFolders.length} 个文件夹`
    : `已创建项目：${name}`;
  // Picked folders are registered by the main process with every capability off.
  void refreshPermissions();
});
$('#home-button').addEventListener('click', () => { closeSettings(); setActiveArea('home'); selectProject('Mova'); });

// Settings overlay: opened from the top menu, closed with Escape or the close button.
const settingsView = $('#settings-view');
const refreshSettingsResize = bindSidebarResize(settingsView, $('#settings-nav'), $('#settings-divider'), {
  widthVariable: '--mova-settings-split', defaultVariable: '--mova-settings-nav-width', widthLabel: '设置导航宽度',
});
const interactionRouter = createInteractionRouter({
  notify: input => { void window.movaDesktop?.interactions?.notify(input)?.catch(() => {}); },
  dismiss: id => { void window.movaDesktop?.interactions?.dismiss(id)?.catch(() => {}); },
});
const routedAsks = interactionRouter.channel(window.movaDesktop?.ask, 'ask');
const routedApprovals = interactionRouter.channel(window.movaDesktop?.approvals, 'approval');
function syncInteractionContext() {
  interactionRouter.setContext({ conversationId: draftKey(), visible: activeArea === 'home' && settingsView.hidden && !document.hidden && document.hasFocus() });
}
window.addEventListener('focus', syncInteractionContext);
window.addEventListener('blur', syncInteractionContext);
document.addEventListener('visibilitychange', syncInteractionContext);
window.movaDesktop?.interactions?.onOpen(conversationId => openMemorySource({ conversationId }));
const askRoot = createRoot($('#ask-host'));
const visibleAsks = new Map();
function renderPendingAsk() {
  const request = visibleAsks.values().next().value;
  $('.composer-area').classList.toggle('is-asking', Boolean(request));
  if (!request) { askRoot.render(null); return; }
  askRoot.render(React.createElement(AskCard, {
    key: request.id,
    ask: request,
    onSubmit: answer => { void routedAsks.respond(request.id, answer); },
    onSkip: () => { void routedAsks.respond(request.id, ''); },
  }));
}
routedAsks.onRequest(request => { visibleAsks.set(request.id, request); renderPendingAsk(); });
routedAsks.onClose(({ id }) => { visibleAsks.delete(id); renderPendingAsk(); });
let mcpPageRoot;
let servicePageRoot;
let browserPageRoot;
let designPageRoot;
let cloudPageRoot;
// 「CLI 模型」页由 React 渲染，第一次打开时才挂载：没登录任何订阅的机器不必为它建树。
let cliModelsPageRoot;
// 「网络与线路」页同理：没装内核的机器打开它要看到「未安装内核」的明确状态，而不是空白。
let vpnPageRoot;
// 「电脑操作」页由普通 DOM 渲染，第一次打开时才挂载，避免给没装桌面引擎的用户白建一页。
let desktopPageMounted = false;
function selectSettingsPage(id) {
  if (id === 'design') {
    designPageRoot ??= createRoot($('#settings-page-design'));
    designPageRoot.render(React.createElement(DesignSettings, { bridge: window.movaDesktop?.design }));
  }
  document.querySelectorAll('[data-settings-item]').forEach(button => {
    const active = button.dataset.settingsItem === id;
    button.classList.toggle('selected', active);
    // 选中态不能只靠底色：读屏与高对比度模式下也要能报出当前位置。
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  // 只切换真正的页面容器：React 页面的根 div 也带 `.settings-page` 类（它有 padding 与滚动），
  // 但它没有 id。不过滤一次就会把它一起 hidden —— 表现是「切走再切回来整页空白」。
  settingsView.querySelectorAll('.settings-page').forEach(page => {
    if (!page.id.startsWith('settings-page-')) return;
    page.hidden = page.id !== `settings-page-${id}`;
  });
  const headings = { usage: '使用情况和计费', models: '模型', archive: '已归档的聊天', memory: '记忆与存储', mcp: 'MCP 工具', service: '服务与索引', browser: '浏览器', desktop: '电脑操作', 'cli-models': 'CLI 模型', network: '网络与线路', cloud: '云端与连接' };
  // 挂载前先把标题定下来：任何一个页面容器缺失都只影响该页，不会让整页空白且标题停在「配置」。
  $('#settings-heading').textContent = headings[id] ?? '配置';
  if (id === 'design') $('#settings-heading').textContent = '设计';
  if (id === 'cloud') {
    cloudPageRoot ??= createRoot($('#settings-page-cloud'));
    cloudPageRoot.render(React.createElement(CloudConnectionsSettings, {
      bridge: window.movaDesktop?.cloud,
      clipboard: window.movaDesktop?.clipboard,
      onOpenNetwork: () => selectSettingsPage('network'),
      onAddHost: openRemoteHost,
    }));
  }
  if (id === 'memory') renderMemoryPage();
  if (id === 'service') {
    const host = $('#settings-page-service');
    if (!host) { $('#settings-heading').textContent = '服务与索引（页面容器缺失）'; return; }
    servicePageRoot ??= createRoot(host);
    servicePageRoot.render(React.createElement(MemorySettings, {
      bridge: memoryBridge, projectId: memoryProjectId(), onOpenSource: openMemorySource, serviceOnly: true,
    }));
  }
  if (id === 'cli-models') {
    const host = $('#settings-page-cli-models');
    if (!host) { $('#settings-heading').textContent = 'CLI 模型（页面容器缺失）'; return; }
    cliModelsPageRoot ??= createRoot(host);
    // 桥接缺失时页面退回内置演示数据（根节点带 data-source="demo"），不会白屏。
    cliModelsPageRoot.render(React.createElement(CliModelsSettings, { desktop: window.movaDesktop }));
  }
  if (id === 'mcp') {
    const host = $('#settings-page-mcp');
    if (!host) { $('#settings-heading').textContent = 'MCP 工具（页面容器缺失）'; return; }
    mcpPageRoot ??= createRoot(host);
    mcpPageRoot.render(React.createElement(McpSettings, { bridge: window.movaDesktop?.mcp }));
  }
  if (id === 'network') {
    const host = $('#settings-page-network');
    if (!host) { $('#settings-heading').textContent = '网络与线路（页面容器缺失）'; return; }
    vpnPageRoot ??= createRoot(host);
    // 桥接缺失 / 主进程没装 VPN 时页面自己显示「未启用 + 安装指引」，不会白屏。
    vpnPageRoot.render(React.createElement(VpnSettings, { desktop: window.movaDesktop }));
  }
  if (id === 'browser') {
    const host = $('#settings-page-browser');
    if (!host) { $('#settings-heading').textContent = '浏览器（页面容器缺失）'; return; }
    browserPageRoot ??= createRoot(host);
    browserPageRoot.render(React.createElement(BrowserSettings, { bridge: window.movaDesktop?.browser }));
  }
  if (id === 'desktop') {
    const host = $('#settings-page-desktop');
    if (!host) { $('#settings-heading').textContent = '电脑操作（页面容器缺失）'; return; }
    // 懒挂载：页面自己处理桥接缺失，挂载失败也不能让设置停在白屏。
    if (!desktopPageMounted) {
      desktopPageMounted = true;
      try {
        mountDesktopSettings(host);
      } catch (error) {
        desktopPageMounted = false;
        $('#settings-heading').textContent = '电脑操作（页面挂载失败）';
        console.warn('[desktop settings]', error);
      }
    }
  }
  if (id === 'archive') renderArchive();
  if (id === 'models') {
    void loadSearchConfig();
    // 每次打开都重读一次：订阅通道的登录态与模型目录是主进程侧的实时状态，
    // 只在启动时读一次会让「刚登录的 ChatGPT」在这一页显示成未登录。
    void loadProviders();
  }
}
function openSettings(id = 'config') {
  closeMenus();
  settingsView.hidden = false;
  syncInteractionContext();
  selectSettingsPage(id);
  refreshSettingsResize();
  document.querySelector('[data-settings-item].selected')?.focus({ preventScroll: true });
}
function renderMemoryPage() {
  memoryPageRoot ??= createRoot($('#settings-page-memory'));
  memoryPageRoot.render(React.createElement(MemorySettings, {
    key: ++memoryPageVersion, bridge: memoryBridge, projectId: memoryProjectId(),
    onOpenSource: openMemorySource,
    onChanged: async change => {
      const result = await memoryBridge?.read();
      if (!result?.ok) return;
      memorySettings = result.value.settings;
      if (change?.target === 'sessions' || change?.target === 'all') {
        for (const controller of activeReplies.values()) controller.abort();
        activeReplies.clear();
        conversations.clear();
        temporaryConversations.clear();
        projects.forEach(project => { project.chats = []; });
        selectedChat = '';
        renderProjects();
        renderConversation();
      }
    },
  }));
}
function projectFolders() {
  return projects.flatMap(project => (project.sourceFolders ?? []).map(folder => ({
    id: folder.id, name: folder.name, path: folder.path ?? null, project: project.name,
  })));
}
/**
 * Removing a project must not leave its folder grants behind: a later project
 * pointing at the same folder would otherwise inherit read/write silently.
 * Only folders no remaining project uses are forgotten, and forgetting can only
 * reduce access, so it needs no confirmation.
 */
async function releaseProjectPermissions(project) {
  if (!permissionBridge?.forget) return;
  const stillUsed = new Set(projectFolders().map(folder => folder.id));
  const orphans = (project.sourceFolders ?? [])
    .map(folder => folder.id)
    .filter(id => id && !stillUsed.has(id));
  for (const id of orphans) {
    try { await permissionBridge.forget(id); } catch { /* Keep the rest of the removal working. */ }
  }
  if (orphans.length) void refreshPermissions();
}
/** Main process is the source of truth; the renderer only displays what it reports. */
async function refreshPermissions() {
  if (!permissionBridge) return;
  try {
    const result = await permissionBridge.list();
    if (result?.ok) {
      permissionRoots = result.value.roots ?? [];
      renderChatPrivacy();
    }
  } catch { /* Keep the last known permissions. */ }
}
function openMemorySource(source) {  const conversationId = source?.conversationId;
  if (!conversations.has(conversationId)) { chatFeedback('原始会话已删除或不可用。'); return; }
  let identity;
  try { identity = JSON.parse(conversationId); } catch { return; }
  closeSettings();
  setActiveArea('home');
  $('#mode-label').textContent = identity[0];
  document.title = `${identity[0]} · Mova`;
  $('#new-project').hidden = identity[0] !== 'CodeMova';
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.mode === identity[0])));
  selectedProject = identity[1]; selectedChat = identity[2];
  renderProjects(); restoreDraft(); syncComposerModels();
  const reveal = () => window.dispatchEvent(new CustomEvent('mova:reveal-message', { detail: { messageId: source.messageId } }));
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 150);
}
window.addEventListener('mova:open-memory-source', event => openMemorySource(event.detail));
/**
 * 临时聊天只在新聊天（还没有发出第一条消息）时可选：入口是「⋯」右边的隐私图标。
 * 会话一旦开始，开关消失，只在标题后留一个灰字标记，表示这条会话不写入存储、
 * 不提取也不注入记忆。
 */
function renderChatPrivacy() {
  const inChat = activeArea === 'home';
  const messages = inChat ? conversations.get(draftKey()) : null;
  const chatting = Boolean(messages?.length);
  const temporary = chatting ? temporaryConversations.has(draftKey()) : temporaryNextChat;
  const toggle = $('#chat-temporary-toggle');
  toggle.hidden = !inChat || chatting;
  toggle.setAttribute('aria-pressed', String(temporary));
  toggle.setAttribute('aria-label', temporary ? '临时聊天（已开启）' : '临时聊天');
  toggle.title = temporary
    ? '临时聊天：这条新聊天不保存、不提取也不读取记忆'
    : '临时聊天：新聊天不保存、不提取也不读取记忆';
  $('#chat-header-tag').hidden = !inChat || !temporary;
}
/** 标题栏只在主页有对话时显示；它同时占掉「⋯」与临时聊天入口。 */
function setChatHeaderVisible(visible) {
  $('#chat-header').hidden = !visible;
  $('.main-panel').classList.toggle('has-chat-header', visible);
}
function closeSettings() {
  if (settingsView.hidden) return;
  settingsView.hidden = true;
  syncInteractionContext();
  $('#settings-button').focus({ preventScroll: true });
}

// ── Models page ───────────────────────────────────────────────────────
const providerBridge = window.movaDesktop?.providers;
const desktopMovaClient = window.movaDesktop?.model ? createDesktopMovaClient(window.movaDesktop.model) : null;
const modelConfigMessage = $('#model-config-message');
const removeDialog = $('#remove-model-dialog');
let providersState = null;
let providersLoading = Boolean(providerBridge);
let providersBusy = false;
let editorDraft = null;
/** 模型目录拖拽排序的起点下标，-1 表示当前没有拖拽。 */
let dragIndex = -1;
let pickerDraft = null;
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
const EFFORT_SHORT = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHi', max: 'Max' };
const desktopPreferences = { thinking: '' };
try {
  const prefs = JSON.parse(localStorage.getItem('mova.model-preferences') || 'null');
  if (EFFORT_LEVELS.includes(prefs?.thinking)) desktopPreferences.thinking = prefs.thinking;
} catch { /* Prefer defaults if storage is unavailable. */ }

function saveDesktopPreferences() {
  try { localStorage.setItem('mova.model-preferences', JSON.stringify(desktopPreferences)); } catch { /* Session-only selection. */ }
}

const PROTOCOL_LABELS = { openai: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages' };

/**
 * 模型菜单里的分组标题。
 * 用户要的是「DeepSeek 的模型上面写 DeepSeek，ChatGPT 的写 ChatGPT」——那正好就是
 * provider 的显示名称：订阅 provider 的名字来自订阅侧设置的 displayName，自建 provider
 * 的名字就是用户自己填的。没有名字时退回地址的主机名，总比一个空白标题好。
 */
function providerGroupLabel(provider) {
  const name = String(provider?.name ?? '').trim();
  if (name) return name;
  try { return new URL(provider?.baseUrl).host; } catch { return '其他'; }
}

/**
 * 「配置完成的」provider 分组。
 * 关键点：没登录任何账号的订阅 provider（`configured === false`）不进模型菜单——
 * 否则菜单里会挂着一条点了必然失败的 ChatGPT 模型。设置页仍然显示它，因为要在那里登录。
 */
function modelGroups() {
  return (providersState?.providers ?? [])
    .filter(provider => provider && provider.configured !== false && Array.isArray(provider.models) && provider.models.length)
    .map(provider => ({ provider, label: providerGroupLabel(provider) }));
}

function flatModels() {
  return modelGroups().flatMap(({ provider }) =>
    provider.models.map(model => ({ providerId: provider.id, provider, model, key: `${provider.id}::${model.id}` })));
}

function activeSelection() {
  const entries = flatModels();
  if (!entries.length) return null;
  const key = draftKey();
  if (!chatModelSelections.has(key)) {
    chatModelSelections.set(key, recoverModelSelection(conversations.get(key), entries, providersState?.active));
    saveWorkspace();
  }
  const active = chatModelSelections.get(key);
  return entries.find(entry => entry.providerId === active?.providerId && entry.model.id === active?.modelId) ?? entries[0];
}

/** The active model's effort levels are the only selectable thinking levels. */
function activeThinkingLevel() {
  const efforts = activeSelection()?.model.efforts ?? [];
  if (!efforts.length) return '';
  if (efforts.includes(desktopPreferences.thinking)) return desktopPreferences.thinking;
  return efforts[Math.max(0, Math.floor((efforts.length - 1) / 2))];
}

function thinkingOptionList(model) {
  return (model?.efforts ?? []).map(id => ({ id, label: EFFORT_LABELS[id] ?? id, short: EFFORT_SHORT[id] ?? id }));
}

/** Model names alone can repeat across providers; disambiguate only when they do. */
function modelKeyLabels(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const name = entry.model.name || entry.model.id;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries(entries.map(entry => {
    const name = entry.model.name || entry.model.id;
    return [entry.key, counts.get(name) > 1 ? `${name} · ${entry.provider.name}` : name];
  }));
}

function setModelMessage(text = '', tone = '') {
  modelConfigMessage.textContent = text;
  if (tone) modelConfigMessage.dataset.tone = tone;
  else modelConfigMessage.removeAttribute('data-tone');
}

async function loadProviders() {
  if (!providerBridge) {
    providersLoading = false;
    renderModelsPage();
    composer.update({ disabled: false });
    return;
  }
  if (!providersState) setModelMessage('正在读取模型提供商…');
  try {
    const result = await providerBridge.list();
    if (!result.ok) throw new ModelConnectionError(result.error);
    providersState = result.value;
    const entries = flatModels();
    let recovered = false;
    if (entries.length) for (const [key, turns] of conversations) {
      if (chatModelSelections.has(key)) continue;
      chatModelSelections.set(key, recoverModelSelection(turns, entries, providersState.active));
      recovered = true;
    }
    if (recovered) saveWorkspace();
    if (!providersState.providers.length) setModelMessage('还没有模型提供商。点击「添加提供商」填写 API 地址与密钥。');
    else setModelMessage('');
  } catch (error) {
    setModelMessage(error instanceof ModelConnectionError ? error.message : '无法读取模型提供商配置。', 'error');
  } finally {
    if (providersLoading) {
      providersLoading = false;
      composer.update({ disabled: false });
    }
    renderModelsPage();
    syncComposerModels();
    syncBotModelsFromProviders(providersState);
    if (contactsInitialized) renderContacts();
  }
}

function renderModelsPage() {
  const list = $('#provider-list');
  if (!list) return;
  list.replaceChildren();
  if (!providerBridge) {
    $('#add-provider').hidden = true;
    $('#search-settings').hidden = true;
    return;
  }
  $('#add-provider').hidden = false;
  $('#search-settings').hidden = !providersState && !searchBridge;
  $('#search-config-message').textContent = '每个搜索源单独保存密钥；联网搜索默认开启，只向已启用的搜索源发送模型生成的搜索词。';
  void loadSearchConfig();
  if (!providersState) return;
  // 订阅 provider 只在「真的登录成功」时才出现在这里：没登录的 ChatGPT / Gemini 卡片
  // 只会给出点了必然失败的模型。登录成功但目录还没读到时仍然显示，用户才能点「获取可用模型」。
  for (const provider of providersState.providers) {
    if (provider.kind === 'subscription' && provider.configured !== true) continue;
    list.append(providerCard(provider));
  }
  if (editorDraft && !editorDraft.id) list.append(providerCard({ id: '', name: '新提供商', protocol: 'openai', models: [], hasKey: false }, { isNew: true }));
}

function providerCard(provider, { isNew = false } = {}) {
  const editing = Boolean(editorDraft) && (isNew ? !editorDraft.id : editorDraft.id === provider.id);
  // 内置订阅 provider：不可删、凭据不在 keyStore 里、模型目录可编辑但不能改地址与协议。
  const subscription = provider.kind === 'subscription';
  const card = document.createElement('article');
  card.className = 'provider-card';
  card.dataset.editing = String(editing);
  if (subscription) card.dataset.kind = 'subscription';

  const head = document.createElement('div');
  head.className = 'provider-head';
  const title = document.createElement('div');
  title.className = 'provider-title';
  const name = document.createElement('strong');
  name.textContent = isNew ? '新提供商' : provider.name;
  const badge = document.createElement('span');
  badge.className = 'provider-badge';
  badge.textContent = subscription ? '订阅' : '自定义';
  const dot = document.createElement('span');
  dot.className = 'provider-dot';
  // 订阅 provider 的「亮灯」含义是「已经登录了至少一个账号」，不是「存了密钥」。
  const ready = subscription ? provider.configured === true : (!isNew && provider.hasKey === true);
  dot.dataset.on = String(ready);
  dot.title = subscription
    ? (ready ? `已登录 ${provider.subscription?.accounts ?? 1} 个账号` : '还没有登录账号')
    : (provider.hasKey ? '已保存密钥' : '尚未保存密钥');
  title.append(name, badge, dot);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  if (!editing && !isNew) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'settings-button';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => startEditing(provider));
    actions.append(edit);
  }
  if (!subscription) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'provider-remove';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      if (isNew) { editorDraft = null; renderModelsPage(); }
      else confirmRemoveProvider(provider);
    });
    actions.append(remove);
  }
  head.append(title, actions);
  card.append(head);

  if (subscription && !editing) {
    // 未登录时必须说清「为什么这里的模型还选不到」，否则用户会以为是模型列表坏了。
    const note = document.createElement('p');
    note.className = 'model-config-message';
    note.textContent = ready
      ? `订阅额度通道 · 已登录 ${provider.subscription?.accounts ?? 0} 个账号${provider.subscription?.email ? ` · ${provider.subscription.email}` : ''}`
      : '还没有登录账号。到「CLI 模型」页登录，登录完成后这里的模型才会出现在右下角的模型菜单里。';
    card.append(note);
  }

  if (editing) card.append(providerEditor(provider, isNew));
  return card;
}

function startEditing(provider) {
  const subscription = provider.kind === 'subscription';
  editorDraft = {
    id: provider.id,
    kind: subscription ? 'subscription' : undefined,
    subscriptionProvider: subscription ? provider.subscriptionProvider : undefined,
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    key: '',
    models: provider.models.map(model => ({ ...model, efforts: [...model.efforts] })),
    hasKey: provider.hasKey === true,
    // 订阅 provider 没有地址/协议可填，展开那个折叠区只会给出假的编辑权。
    advanced: !subscription,
  };
  renderModelsPage();
  requestAnimationFrame(() => {
    const selector = subscription
      ? '.provider-card[data-editing="true"] input[data-field="name"]'
      : '.provider-card[data-editing="true"] input[data-field="key"]';
    $(selector)?.focus({ preventScroll: true });
  });
}

function draftField(labelText, field, value, placeholder) {
  const label = document.createElement('label');
  label.className = 'provider-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.placeholder = placeholder ?? '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.field = field;
  input.addEventListener('input', () => { editorDraft[field] = input.value; });
  label.append(span, input);
  return label;
}

const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// 展开/收起折叠区：按内容高度做补间，展开和收起两个方向都连续。
function animateExpand(panel, open, { duration = 240 } = {}) {
  if (!panel) return;
  panel.getAnimations?.().forEach(animation => animation.cancel());
  const release = () => {
    panel.style.height = '';
    panel.style.overflow = '';
  };
  if (prefersReducedMotion?.matches) {
    panel.hidden = !open;
    release();
    return;
  }
  const easing = 'cubic-bezier(.22, .9, .26, 1)';
  if (open) {
    panel.hidden = false;
    const height = panel.scrollHeight;
    panel.style.overflow = 'hidden';
    panel.animate(
      [{ height: '0px', opacity: 0 }, { height: `${height}px`, opacity: 1 }],
      { duration, easing },
    ).onfinish = release;
    return;
  }
  const height = panel.getBoundingClientRect().height;
  if (!height) {
    panel.hidden = true;
    release();
    return;
  }
  panel.style.overflow = 'hidden';
  panel.animate(
    [{ height: `${height}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
    { duration, easing },
  ).onfinish = () => {
    panel.hidden = true;
    release();
  };
}

function providerEditor(provider, isNew) {
  const draft = editorDraft;
  const body = document.createElement('div');
  body.className = 'provider-editor';

  const summary = document.createElement('div');
  summary.className = 'provider-summary';
  const summaryName = document.createElement('strong');
  summaryName.textContent = draft.name || '未命名提供商';
  const summaryModel = document.createElement('span');
  const active = activeSelection();
  summaryModel.textContent = active && active.providerId === draft.id ? active.model.id : (draft.models[0]?.id ?? '');
  summary.append(summaryName, summaryModel);
  body.append(summary);

  // 左栏字段、右栏模型目录：宽窗口并排，窄窗口自动堆叠。
  const grid = document.createElement('div');
  grid.className = 'provider-editor-grid';
  const fields = document.createElement('div');
  fields.className = 'provider-fields';

  // 第一行：显示名称（窄）+ API 密钥（占余下宽度）。
  const topRow = document.createElement('div');
  topRow.className = 'provider-field-row';

  const subscription = draft.kind === 'subscription';
  const nameField = draftField('显示名称', 'name', draft.name, subscription ? '例如 ChatGPT' : '例如 Claude');
  if (!subscription) nameField.classList.add('provider-field-narrow');
  topRow.append(nameField);

  const keyField = document.createElement('div');
  keyField.className = 'provider-field';
  const keyLabel = document.createElement('div');
  keyLabel.className = 'provider-label';
  const keyText = document.createElement('span');
  keyText.textContent = 'API 密钥';
  const help = document.createElement('button');
  help.type = 'button';
  help.className = 'field-help';
  help.textContent = '?';
  help.title = '密钥通过 Windows 系统加密保存在本机，不会写入 providers.json。';
  help.setAttribute('aria-label', '关于 API 密钥');
  keyLabel.append(keyText, help);
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.maxLength = 512;
  keyInput.autocomplete = 'new-password';
  keyInput.spellcheck = false;
  keyInput.dataset.field = 'key';
  keyInput.value = draft.key;
  keyInput.placeholder = draft.hasKey ? '留空使用已保存凭据' : '填写提供商的 API 密钥';
  keyInput.addEventListener('input', () => { draft.key = keyInput.value; });
  keyField.append(keyLabel, keyInput);
  if (!subscription) topRow.append(keyField);
  fields.append(topRow);
  if (subscription) {
    // 订阅通道没有 API 密钥可填：登录态由「CLI 模型」页管，这里能改的只有名称与模型。
    const hint = document.createElement('p');
    hint.className = 'model-config-message';
    hint.textContent = '订阅通道不需要 API 密钥。这里可以改显示名称、模型 ID、显示名称、思考强度与上下文窗口；保存后立刻用于下一次请求。';
    fields.append(hint);
  }

  const details = document.createElement('div');
  details.className = 'provider-advanced provider-advanced-inline';
  const detailsSummary = document.createElement('button');
  detailsSummary.type = 'button';
  detailsSummary.className = 'provider-advanced-toggle';
  detailsSummary.setAttribute('aria-expanded', String(Boolean(draft.advanced)));
  const detailsIcon = icon('caret-down');
  detailsIcon.classList.add('details-caret');
  const detailsText = document.createElement('span');
  detailsText.textContent = '自定义设置';
  detailsSummary.append(detailsIcon, detailsText);
  details.append(detailsSummary);
  const advancedBody = document.createElement('div');
  advancedBody.className = 'provider-advanced-body';
  advancedBody.hidden = !draft.advanced;
  // 自定义设置里只留地址与协议，两者同行，协议取窄列。
  const endpointRow = document.createElement('div');
  endpointRow.className = 'provider-field-row';
  const baseUrlField = draftField('API 地址', 'baseUrl', draft.baseUrl, '例如 https://api.anthropic.com');
  const protocolField = document.createElement('label');
  protocolField.className = 'provider-field provider-field-narrow';
  const protocolLabel = document.createElement('span');
  protocolLabel.textContent = 'API 协议';
  const select = document.createElement('select');
  select.dataset.field = 'protocol';
  for (const [value, label] of Object.entries(PROTOCOL_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = draft.protocol;
  select.addEventListener('change', () => { draft.protocol = select.value; });
  protocolField.append(protocolLabel, select);
  endpointRow.append(baseUrlField, protocolField);
  advancedBody.append(endpointRow);
  details.append(advancedBody);
  // 自定义设置默认展开：空间够时少一次点击，新建提供商也更容易一次填完。
  if (draft.advanced !== false) {
    draft.advanced = true;
    advancedBody.hidden = false;
    detailsSummary.setAttribute('aria-expanded', 'true');
  }
  detailsSummary.addEventListener('click', () => {
    const open = advancedBody.hidden;
    draft.advanced = open;
    detailsSummary.setAttribute('aria-expanded', String(open));
    animateExpand(advancedBody, open);
  });
  // 订阅 provider 的地址/协议是内置的（Gemini 走本机 CLI，根本没有 API 地址），
  // 让它们出现在「自定义设置」里等于给出一个假的编辑权，所以整块不挂进 DOM。
  if (!subscription) fields.append(details);

  const catalogColumn = document.createElement('div');
  catalogColumn.className = 'provider-catalog-column';
  catalogColumn.append(catalogSection(isNew));
  grid.append(fields, catalogColumn);
  body.append(grid);

  const footer = document.createElement('div');
  footer.className = 'provider-editor-actions';
  const status = document.createElement('p');
  status.className = 'model-form-status';
  status.dataset.role = 'status';
  status.setAttribute('role', 'status');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'settings-button';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => { editorDraft = null; renderModelsPage(); });
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'settings-button primary';
  save.textContent = '保存';
  save.addEventListener('click', () => void saveEditor(status));
  footer.append(status, cancel, save);
  body.append(footer);
  return body;
}

function catalogSection(isNew) {
  const draft = editorDraft;
  const catalog = document.createElement('div');
  catalog.className = 'provider-catalog';
  const head = document.createElement('div');
  head.className = 'catalog-head';
  const headText = document.createElement('div');
  headText.className = 'catalog-head-text';
  const catalogTitle = document.createElement('strong');
  catalogTitle.textContent = '模型目录';
  const catalogSub = document.createElement('span');
  catalogSub.className = 'catalog-sub';
  catalogSub.textContent = draft.kind === 'subscription'
    // 一条 = 一个模型（不是一档一条）：Gemini 的 18 条档位会在登录时并成 7 个模型。
    ? '订阅通道的模型目录：一条 = 一个模型，思考强度在输入框右下角的菜单里切换；改名或删除会立刻反映到那个菜单'
    : (isNew || !draft.id ? '新建模型目录' : '已自定义模型目录');
  headText.append(catalogTitle, catalogSub);
  const headActions = document.createElement('div');
  headActions.className = 'catalog-actions';
  const defaults = document.createElement('button');
  defaults.type = 'button';
  defaults.className = 'catalog-action';
  defaults.textContent = '恢复默认模型';
  defaults.addEventListener('click', () => void restoreDefaults());
  const fetch = document.createElement('button');
  fetch.type = 'button';
  fetch.className = 'catalog-action';
  fetch.textContent = '获取可用模型';
  // 订阅 provider 走订阅侧的目录探测（Gemini 由 CLI 报，ChatGPT 报不了就如实说明），
  // 不能走 openModelPicker：那条路会用空 key 去打 api.openai.com/v1/models，必然 401。
  fetch.addEventListener('click', () => {
    void (draft.kind === 'subscription' ? discoverSubscriptionModels() : openModelPicker());
  });
  if (draft.kind !== 'subscription') headActions.append(defaults);
  headActions.append(fetch);
  head.append(headText, headActions);
  catalog.append(head);

  const rows = document.createElement('div');
  rows.className = 'catalog-list';
  if (draft.models.length) {
    const columns = document.createElement('div');
    columns.className = 'catalog-table-head';
    for (const label of ['', '模型 ID', '显示名称', '', '']) {
      const cell = document.createElement('span');
      cell.textContent = label;
      columns.append(cell);
    }
    catalog.append(columns);
  }
  if (!draft.models.length) {
    const empty = document.createElement('p');
    empty.className = 'catalog-empty';
    empty.textContent = '还没有模型。点击「获取可用模型」从提供商读取，或手动添加。';
    rows.append(empty);
  }
  for (const model of draft.models) rows.append(catalogRow(model));
  catalog.append(rows);

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'settings-add catalog-add';
  const addIcon = icon('plus');
  const addText = document.createElement('span');
  addText.textContent = '添加模型';
  add.append(addIcon, addText);
  add.addEventListener('click', () => {
    draft.models.push({ id: '', name: '', vision: false, efforts: [] });
    renderModelsPage();
    const cards = document.querySelectorAll('.provider-card[data-editing="true"] .catalog-row input[data-role="id"]');
    cards[cards.length - 1]?.focus({ preventScroll: true });
  });
  catalog.append(add);
  return catalog;
}

function catalogRow(model) {
  const item = document.createElement('div');
  item.className = 'catalog-item';
  const row = document.createElement('div');
  row.className = 'catalog-row';

  const grip = document.createElement('span');
  grip.className = 'catalog-grip';
  grip.append(icon('dots-three'));
  // 拖拽排序：只有把手可拖，输入框仍然能正常选中文字。
  grip.draggable = true;
  grip.title = '拖动调整顺序';
  grip.setAttribute('aria-label', '拖动调整顺序');
  grip.addEventListener('dragstart', event => {
    dragIndex = editorDraft.models.indexOf(model);
    item.dataset.dragging = 'true';
    event.dataTransfer.effectAllowed = 'move';
    // Firefox 需要写入数据才会开始拖拽；Chromium 里无副作用。
    event.dataTransfer.setData('text/plain', String(dragIndex));
  });
  grip.addEventListener('dragend', () => {
    dragIndex = -1;
    item.removeAttribute('data-dragging');
    document.querySelectorAll('.catalog-item[data-drop]').forEach(node => node.removeAttribute('data-drop'));
  });

  const idInput = document.createElement('input');
  idInput.className = 'catalog-id';
  idInput.value = model.id;
  idInput.placeholder = '模型 ID';
  idInput.spellcheck = false;
  idInput.dataset.role = 'id';
  // 带 variants 的条目（订阅通道的「一个模型多个思考档位」）不能改 ID：
  // 真正发给 CLI 的是 variants 里的那些 id，改这里只会让映射失效、用户还以为改成功了。
  const variantLevels = model?.variants && typeof model.variants === 'object'
    ? Object.keys(model.variants).filter(level => typeof model.variants[level] === 'string' && model.variants[level])
    : [];
  if (variantLevels.length) {
    idInput.readOnly = true;
    idInput.title = `由订阅通道决定，不能修改。${variantLevels.length} 个思考档位分别对应：${variantLevels.map(level => model.variants[level]).join('、')}`;
    idInput.dataset.locked = 'true';
  } else {
    idInput.addEventListener('input', () => { model.id = idInput.value.trim(); });
  }

  const nameInput = document.createElement('input');
  nameInput.className = 'catalog-name';
  nameInput.value = model.name;
  nameInput.placeholder = '显示名称';
  nameInput.dataset.role = 'name';
  nameInput.addEventListener('input', () => { model.name = nameInput.value; });

  const detail = document.createElement('button');
  detail.type = 'button';
  detail.className = 'catalog-detail';
  detail.setAttribute('aria-expanded', 'false');
  detail.setAttribute('aria-label', '模型能力');
  detail.append(icon('caret-down'));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'catalog-remove';
  remove.setAttribute('aria-label', '删除模型');
  remove.append(icon('trash'));
  remove.addEventListener('click', () => {
    const index = editorDraft.models.indexOf(model);
    if (index >= 0) editorDraft.models.splice(index, 1);
    renderModelsPage();
  });

  row.append(grip, idInput, nameInput, detail, remove);
  item.append(row);

  // 拖到本行上方/下方插入；放手后直接重排 editorDraft.models 并重绘。
  item.addEventListener('dragover', event => {
    if (dragIndex < 0) return;
    const target = editorDraft.models.indexOf(model);
    if (target < 0 || target === dragIndex) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    item.dataset.drop = target > dragIndex ? 'after' : 'before';
  });
  item.addEventListener('dragleave', () => item.removeAttribute('data-drop'));
  item.addEventListener('drop', event => {
    const from = dragIndex;
    const to = editorDraft.models.indexOf(model);
    dragIndex = -1;
    item.removeAttribute('data-drop');
    if (from < 0 || to < 0 || from === to) return;
    event.preventDefault();
    const [moved] = editorDraft.models.splice(from, 1);
    editorDraft.models.splice(to, 0, moved);
    renderModelsPage();
  });

  const caps = document.createElement('div');
  caps.className = 'catalog-caps';
  caps.hidden = true;
  detail.addEventListener('click', () => {
    const open = caps.hidden;
    detail.setAttribute('aria-expanded', String(open));
    detail.classList.toggle('open', open);
    animateExpand(caps, open, { duration: 200 });
  });

  const vision = document.createElement('button');
  vision.type = 'button';
  vision.className = 'cap-toggle';
  vision.dataset.cap = 'vision';
  vision.textContent = '多模态';
  vision.title = '开启后可接收图片输入（由删除/添加模型列表时的检测自动填写）';
  vision.setAttribute('aria-pressed', String(model.vision));
  vision.addEventListener('click', () => {
    model.vision = !model.vision;
    vision.setAttribute('aria-pressed', String(model.vision));
  });

  const effortLabel = document.createElement('span');
  effortLabel.className = 'cap-label';
  effortLabel.textContent = '思考强度';

  caps.append(vision, effortLabel);
  if (variantLevels.length) {
    // 档位由上游目录决定：这里给只读说明，不提供开关（关了也发不出去，因为 variants 才是真相）。
    const note = document.createElement('span');
    note.className = 'cap-note';
    note.textContent = `由订阅通道提供：${variantLevels.join(' / ')}（在输入框右下角的模型菜单里切换）`;
    caps.append(note);
  } else {
    for (const level of EFFORT_LEVELS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cap-effort';
      chip.textContent = level;
      chip.setAttribute('aria-pressed', String(model.efforts.includes(level)));
      chip.addEventListener('click', () => {
        const next = new Set(model.efforts);
        if (next.has(level)) next.delete(level); else next.add(level);
        model.efforts = EFFORT_LEVELS.filter(item => next.has(item));
        chip.setAttribute('aria-pressed', String(model.efforts.includes(level)));
      });
      caps.append(chip);
    }
  }
  const tokenRow = document.createElement('div');
  tokenRow.className = 'catalog-tokens';
  const tokenField = (labelText, key, fallback, min, max, step) => {
    const label = document.createElement('label');
    label.className = 'catalog-token-field';
    const text = document.createElement('span');
    text.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Number(model[key]) || fallback);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) model[key] = Math.min(max, Math.max(min, Math.round(value)));
    });
    label.append(text, input);
    return label;
  };
  tokenRow.append(
    tokenField('上下文窗口', 'contextWindow', 1_000_000, 1_000, 10_000_000, 1_000),
    tokenField('最大输出', 'maxTokens', 128_000, 256, 1_000_000, 256),
  );
  caps.append(tokenRow);
  item.append(caps);
  return item;
}

function validateDraft(draft) {
  if (!draft.name.trim()) return '请填写显示名称。';
  // 订阅 provider 的地址与协议是内置的，不由用户填，也不该因此挡住保存。
  if (draft.kind !== 'subscription') {
    if (!draft.baseUrl.trim()) return '请填写 API 地址。';
    try {
      const url = new URL(draft.baseUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol)) return 'API 地址需要以 http:// 或 https:// 开头。';
    } catch { return 'API 地址格式不正确。'; }
  }
  if (!draft.models.length) return '请至少添加一个模型。';
  if (draft.models.some(model => !model.id)) return '每个模型都需要填写模型 ID。';
  if (new Set(draft.models.map(model => model.id)).size !== draft.models.length) return '模型 ID 不能重复。';
  return '';
}

async function saveEditor(status) {
  if (!providerBridge || providersBusy || !editorDraft) return;
  const draft = editorDraft;
  const problem = validateDraft(draft);
  status.removeAttribute('data-tone');
  if (problem) {
    status.dataset.tone = 'error';
    status.textContent = problem;
    return;
  }
  providersBusy = true;
  status.textContent = '正在保存…';
  try {
    const payloadModels = draft.models.map(model => ({
      id: model.id,
      name: model.name.trim() || model.id,
      vision: model.vision,
      efforts: model.efforts,
      // 订阅通道的档位映射必须原样带回去：丢了它，选档位就发不出正确模型（会退回家族 id）。
      ...(model.variants && Object.keys(model.variants).length ? { variants: model.variants } : {}),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
    // 订阅 provider 不能走 save()：它拒绝内置 id（那条路会把内置通道写进 providers.json）。
    // 这里改成写订阅自己的模型目录文件，只允许改名与改模型。
    const result = draft.kind === 'subscription'
      ? await providerBridge.saveSubscription({
        target: draft.subscriptionProvider,
        displayName: draft.name.trim(),
        models: payloadModels,
      })
      : await providerBridge.save({
        id: draft.id || undefined,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol,
        models: payloadModels,
        key: draft.key,
      });
    if (!result.ok) throw new ModelConnectionError(result.error);
    editorDraft = null;
    await loadProviders();
    setModelMessage(`已保存「${draft.name.trim()}」。输入框的模型菜单可以切换模型。`);
  } catch (error) {
    status.dataset.tone = 'error';
    status.textContent = error instanceof ModelConnectionError ? error.message : '保存失败，请重试。';
  } finally {
    providersBusy = false;
  }
}

async function restoreDefaults() {
  if (!providerBridge || !editorDraft) return;
  const draft = editorDraft;
  const status = document.querySelector('.provider-card[data-editing="true"] [data-role="status"]');
  try {
    const result = await providerBridge.defaults({
      id: draft.id || undefined,
      name: draft.name,
      baseUrl: draft.baseUrl,
      protocol: draft.protocol,
    });
    if (!result.ok) throw new ModelConnectionError(result.error);
    draft.models = result.value;
    renderModelsPage();
    const next = document.querySelector('.provider-card[data-editing="true"] [data-role="status"]');
    if (next) {
      next.removeAttribute('data-tone');
      next.textContent = `已恢复${result.value.length} 个默认模型，保存后生效。`;
    }
  } catch (error) {
    if (!status) return;
    status.dataset.tone = 'error';
    status.textContent = error instanceof ModelConnectionError ? error.message : '无法恢复默认模型。';
  }
}

function confirmRemoveProvider(provider) {
  $('#remove-dialog-title').textContent = `删除「${provider.name}」`;
  $('#remove-dialog-text').textContent = '删除后该提供商的密钥与模型列表都会从本机移除，已保存的聊天不受影响。';
  removeDialog.dataset.providerId = provider.id;
  removeDialog.showModal();
}

$('#add-provider').addEventListener('click', () => {
  if (!providerBridge) return;
  editorDraft = { id: '', name: '', baseUrl: '', protocol: 'openai', key: '', models: [], hasKey: false, advanced: true };
  renderModelsPage();
  requestAnimationFrame(() => {
    document.querySelector('.provider-card[data-editing="true"] input[data-field="name"]')?.focus({ preventScroll: true });
  });
});

// ── Model picker (fetch the provider catalog, choose which models to keep) ──
/**
 * 订阅 provider 的「获取可用模型」。
 *
 * 与普通 provider 的区别：没有 `/models` 接口可打（凭据不是 API Key）。Gemini 的清单由本机
 * CLI 报；ChatGPT 侧目前无法枚举，主进程会回内置清单并在 note 里说明——如实说明比假装
 * 拉到了真实清单好。已在目录里的模型不动（保留用户改过的显示名称与思考强度）。
 */
async function discoverSubscriptionModels() {
  if (!providerBridge || !editorDraft || editorDraft.kind !== 'subscription') return;
  const draft = editorDraft;
  const say = (text, tone = '') => {
    const status = document.querySelector('.provider-card[data-editing="true"] [data-role="status"]');
    if (!status) return;
    if (tone) status.dataset.tone = tone;
    else status.removeAttribute('data-tone');
    status.textContent = text;
  };
  say('正在向订阅通道询问模型清单…');
  try {
    const result = await providerBridge.fetchSubscription({ target: draft.subscriptionProvider });
    if (!result.ok) throw new ModelConnectionError(result.error);
    const value = result.value ?? {};
    const found = Array.isArray(value.models) ? value.models : [];
    const known = new Set(draft.models.map(model => model.id));
    const merged = [...draft.models];
    for (const model of found) {
      if (model?.id && !known.has(model.id)) merged.push({ ...model, efforts: [...(model.efforts ?? [])] });
    }
    draft.models = merged;
    renderModelsPage();
    const suffix = value.note ? ` ${value.note}` : '';
    say(found.length
      ? `已读取 ${found.length} 个模型（来源：${value.source === 'probe' ? '订阅通道实时返回' : '内置清单'}）。${suffix} 记得点「保存」。`
      : `订阅通道没有返回模型。${suffix}`);
  } catch (error) {
    say(error instanceof ModelConnectionError ? error.message : '无法读取订阅模型清单。', 'error');
  }
}

async function openModelPicker() {
  if (!providerBridge || !editorDraft) return;
  const dialog = $('#model-picker-dialog');
  if (dialog.open) return;
  $('#picker-list').replaceChildren();
  $('#picker-search').value = '';
  const status = $('#picker-status');
  status.removeAttribute('data-tone');
  status.textContent = '正在获取可用模型…';
  pickerDraft = { models: [], selected: new Set(editorDraft.models.map(model => model.id)), query: '' };
  dialog.showModal();
  try {
    const result = await providerBridge.fetch({
      id: editorDraft.id || undefined,
      baseUrl: editorDraft.baseUrl,
      protocol: editorDraft.protocol,
      key: editorDraft.key,
    });
    if (!result.ok) throw new ModelConnectionError(result.error);
    pickerDraft.models = result.value;
    for (const model of result.value) {
      if (editorDraft.models.some(entry => entry.id === model.id)) pickerDraft.selected.add(model.id);
    }
    status.textContent = `获取到${result.value.length} 个模型，勾选后点击「更新列表」。`;
    renderPicker();
  } catch (error) {
    status.dataset.tone = 'error';
    status.textContent = error instanceof ModelConnectionError ? error.message : '无法获取模型列表。';
  }
}

function renderPicker() {
  const list = $('#picker-list');
  list.replaceChildren();
  const query = pickerDraft.query.trim().toLowerCase();
  const models = pickerDraft.models.filter(model =>
    !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));
  if (!models.length) {
    const empty = document.createElement('p');
    empty.className = 'picker-empty';
    empty.textContent = '没有匹配的模型。';
    list.append(empty);
    return;
  }
  for (const model of models) {
    const row = document.createElement('label');
    row.className = 'picker-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = pickerDraft.selected.has(model.id);
    box.addEventListener('change', () => {
      if (box.checked) pickerDraft.selected.add(model.id);
      else pickerDraft.selected.delete(model.id);
    });
    const text = document.createElement('span');
    text.className = 'picker-model';
    const id = document.createElement('strong');
    id.textContent = model.id;
    text.append(id);
    if (model.name && model.name !== model.id) {
      const name = document.createElement('span');
      name.className = 'picker-name';
      name.textContent = model.name;
      text.append(name);
    }
    const tags = document.createElement('span');
    tags.className = 'picker-tags';
    if (model.vision) tags.append(tagChip('多模态'));
    if (model.efforts.length) tags.append(tagChip(`思考 ${model.efforts.join(' · ')}`));
    if (tags.childElementCount) text.append(tags);
    row.append(box, text);
    list.append(row);
  }
}

function tagChip(text) {
  const chip = document.createElement('span');
  chip.className = 'picker-tag';
  chip.textContent = text;
  return chip;
}

function closePicker() {
  const dialog = $('#model-picker-dialog');
  if (dialog.open) dialog.close();
}

function confirmPicker() {
  if (!pickerDraft || !editorDraft) return closePicker();
  const selected = pickerDraft.models.filter(model => pickerDraft.selected.has(model.id));
  const existing = new Map(editorDraft.models.map(model => [model.id, model]));
  const kept = editorDraft.models.filter(model => pickerDraft.selected.has(model.id));
  const added = selected.filter(model => !existing.has(model.id)).map(model => ({
    ...model, name: model.name || model.id, efforts: [...model.efforts],
  }));
  editorDraft.models = kept.length || added.length ? [...kept, ...added] : selected.map(model => ({ ...model, efforts: [...model.efforts] }));
  closePicker();
  renderModelsPage();
}

$('#picker-search').addEventListener('input', event => {
  if (!pickerDraft) return;
  pickerDraft.query = event.target.value;
  renderPicker();
});
$('#picker-all').addEventListener('click', () => {
  if (!pickerDraft) return;
  const query = pickerDraft.query.trim().toLowerCase();
  const visible = pickerDraft.models.filter(model =>
    !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));
  const allSelected = visible.every(model => pickerDraft.selected.has(model.id));
  for (const model of visible) {
    if (allSelected) pickerDraft.selected.delete(model.id);
    else pickerDraft.selected.add(model.id);
  }
  renderPicker();
});
$('#picker-close').addEventListener('click', closePicker);
$('#picker-cancel').addEventListener('click', closePicker);
$('#picker-confirm').addEventListener('click', () => { if (pickerDraft?.models.length) confirmPicker(); });

// ── 搜索增强：检索深度 / 区域 / 语言与多源开关 ─────────────────────────
// 这些通道由主进程（Wave B）提供；缺失时整块只显示「未就绪」，绝不抛错。
const searchBridge = window.movaDesktop?.search ?? null;
const SEARCH_DEPTHS = ['fast', 'standard', 'deep'];
const SEARCH_ZONES = ['auto', 'cn', 'intl'];
const SEARCH_LANGUAGES = ['auto', 'zh-CN', 'en'];
const SEARCH_DEPTH_LABELS = { fast: '快速', standard: '标准', deep: '深入' };
let searchConfigState = null;   // null = 没读到（未就绪或读取失败）
let searchConfigLoaded = false;
let searchConfigBusy = false;

function searchControlValue(selector, allowed, fallback) {
  const value = $(selector)?.value;
  return allowed.includes(value) ? value : fallback;
}
/** model:complete 用的三个字段，读控件值，控件缺失或取值非法时退回默认值。 */
function searchDepthValue() { return searchControlValue('#search-depth', SEARCH_DEPTHS, 'standard'); }
function searchZoneValue() { return searchControlValue('#search-zone', SEARCH_ZONES, 'auto'); }
function searchLanguageValue() { return searchControlValue('#search-language', SEARCH_LANGUAGES, 'auto'); }

function setSearchSettingsStatus(text = '', tone = '') {
  const node = $('#search-settings-status');
  if (!node) return;
  node.textContent = text;
  if (tone) node.dataset.tone = tone;
  else node.removeAttribute('data-tone');
}

/** 搜索 IPC 统一返回 { ok, value | error }；桥接缺失、reject 或形状不对都转成可读原因。 */
function searchResultValue(result) {
  if (!result || typeof result !== 'object') throw new Error('搜索设置通道未就绪。');
  if (result.ok === false) throw new Error(result.error || '搜索设置通道调用失败。');
  return result.value ?? null;
}

function searchErrorText(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return '搜索设置调用失败，请重试。';
  if (/no handler|not registered|unknown channel|not implemented/i.test(message)) {
    return '搜索设置通道未就绪（主进程尚未实现对应 IPC）。';
  }
  return message;
}

/** 只把配置写回三个下拉框，不重绘搜索源（重绘由调用方决定）。 */
function applySearchConfigToControls(config) {
  const depth = $('#search-depth');
  if (depth) depth.value = SEARCH_DEPTHS.includes(config?.depth) ? config.depth : 'standard';
  const zone = $('#search-zone');
  if (zone) zone.value = SEARCH_ZONES.includes(config?.zone) ? config.zone : 'auto';
  const language = $('#search-language');
  if (language) language.value = SEARCH_LANGUAGES.includes(config?.language) ? config.language : 'auto';
}

function applySearchConfig(config) {
  if (!config || typeof config !== 'object') return;
  searchConfigState = config;
  searchConfigLoaded = true;
  applySearchConfigToControls(config);
  renderSearchProviders();
}

function searchProviderNotice(text) {
  const node = document.createElement('p');
  node.className = 'search-provider-notice';
  node.textContent = text;
  return node;
}

/** 多源开启时的隐私文案：写明查询会同时发给哪几个源。 */
function renderSearchPrivacy() {
  const node = $('#search-privacy');
  if (!node) return;
  if (!searchBridge?.getConfig) {
    node.textContent = '搜索设置未就绪：联网搜索仍只向 AnySearch 发送模型生成的搜索词。';
    return;
  }
  const enabled = searchConfigProviders().filter(provider => provider.enabled === true);
  const names = enabled.map(provider => provider.label || provider.id);
  if (names.length > 1) node.textContent = `多源已开启：查询会同时发送给 ${names.join('、')}。`;
  else if (names.length === 1) node.textContent = `查询只会发送给 ${names[0]}。`;
  else node.textContent = '当前没有启用中的搜索源，联网搜索不会发出请求。';
}

function searchConfigProviders() {
  const providers = searchConfigState?.providers;
  return Array.isArray(providers) ? providers.filter(provider => provider && provider.id) : [];
}

function searchProviderRow(provider) {
  const id = String(provider.id);
  const label = provider.label || id;
  const configured = provider.configured === true;
  const row = document.createElement('div');
  row.className = 'search-provider';
  row.dataset.provider = id;
  row.dataset.configured = String(configured);

  // 一行布局：名称与状态 | 密钥/地址输入 + 保存 | 测试 | 开关。
  const line = document.createElement('div');
  line.className = 'search-provider-line';

  const title = document.createElement('div');
  title.className = 'search-provider-title';
  const name = document.createElement('strong');
  name.textContent = label;
  const state = document.createElement('span');
  state.className = 'search-provider-state';
  state.dataset.state = configured ? 'configured' : 'missing';
  state.textContent = configured ? '已配置' : '未配置';
  title.append(name, state);
  if (provider.hasExtract === true) {
    const tag = document.createElement('span');
    tag.className = 'search-provider-tag';
    tag.textContent = '可读取正文';
    title.append(tag);
  }
  line.append(title);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'settings-switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(provider.enabled === true));
  toggle.setAttribute('aria-label', `启用 ${label}`);
  toggle.append(document.createElement('span'));
  toggle.addEventListener('click', () => {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(next));
    void saveSearchPatch(
      { providers: { [id]: { enabled: next } } },
      `${label}已${next ? '启用' : '停用'}。`,
    );
  });

  const status = document.createElement('p');
  status.className = 'search-provider-status';
  status.setAttribute('role', 'status');

  // 三个源都用同一行内的输入框：AnySearch / Tavily 存密钥，SearXNG 存服务地址。
  const field = id === 'searxng' ? 'baseUrl' : 'key';
  const form = document.createElement('form');
  form.className = 'search-provider-form';
  form.noValidate = true;
  const input = document.createElement('input');
  input.className = 'search-provider-input';
  input.type = field === 'key' ? 'password' : 'url';
  input.maxLength = field === 'key' ? 512 : 2048;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = field === 'key'
    ? (configured ? '已保存 · 输入新密钥可覆盖' : 'API 密钥')
    : 'https://searx.example.com';
  input.setAttribute('aria-label', field === 'key' ? `${label} API 密钥` : `${label} 服务地址`);
  if (field === 'baseUrl' && typeof provider.baseUrl === 'string') input.value = provider.baseUrl;
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'settings-button';
  save.textContent = '保存';
  form.append(input, save);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      status.dataset.tone = 'error';
      status.textContent = field === 'key' ? '请先填写 API 密钥。' : '请先填写服务地址。';
      return;
    }
    void saveProviderConfig({ providerId: id, [field]: value }, { input, status, okText: field === 'key' ? `${label} 密钥已保存。` : `${label} 地址已保存。` });
  });

  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'settings-button';
  test.textContent = '测试';
  test.addEventListener('click', () => void testSearchProvider(provider, { button: test, status }));

  line.append(form, test, toggle);
  row.append(line, status);
  return row;
}

function renderSearchProviders() {
  const host = $('#search-providers');
  if (!host) return;
  host.replaceChildren();
  const available = Boolean(searchBridge?.getConfig);
  $('#search-controls')?.querySelectorAll('select').forEach(select => { select.disabled = !available; });
  if (!available) {
    host.append(searchProviderNotice('搜索源未就绪：当前环境没有主进程搜索通道，联网搜索沿用旧版 AnySearch。'));
    renderSearchPrivacy();
    return;
  }
  if (!searchConfigLoaded) {
    host.append(searchProviderNotice('正在读取搜索设置…'));
    renderSearchPrivacy();
    return;
  }
  if (!searchConfigState) {
    const notice = searchProviderNotice('没有读到搜索设置。');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'settings-button';
    retry.textContent = '重新读取';
    retry.addEventListener('click', () => void loadSearchConfig(true));
    notice.append(' ', retry);
    host.append(notice);
    renderSearchPrivacy();
    return;
  }
  const providers = searchConfigProviders();
  if (!providers.length) host.append(searchProviderNotice('没有可用的搜索源。'));
  else providers.forEach(provider => host.append(searchProviderRow(provider)));
  renderSearchPrivacy();
}

async function loadSearchConfig(force = false) {
  const host = $('#search-providers');
  if (!host) return;
  if (!searchBridge?.getConfig) {
    searchConfigState = null;
    searchConfigLoaded = true;
    renderSearchProviders();
    return;
  }
  if (searchConfigBusy && !force) { renderSearchProviders(); return; }
  searchConfigBusy = true;
  renderSearchProviders();
  try {
    const config = searchResultValue(await searchBridge.getConfig());
    searchConfigState = config && typeof config === 'object' ? config : null;
    if (searchConfigState) {
      applySearchConfigToControls(searchConfigState);
      setSearchSettingsStatus('');
    } else {
      setSearchSettingsStatus('没有读到搜索设置。', 'error');
    }
  } catch (error) {
    searchConfigState = null;
    setSearchSettingsStatus(`读取搜索设置失败：${searchErrorText(error)}`, 'error');
  } finally {
    searchConfigBusy = false;
    searchConfigLoaded = true;
    renderSearchProviders();
  }
}

async function saveSearchPatch(patch, okText) {
  if (!searchBridge?.saveConfig) {
    setSearchSettingsStatus('搜索设置未就绪：主进程还没有提供保存通道。', 'error');
    renderSearchProviders();
    return;
  }
  setSearchSettingsStatus('正在保存…');
  try {
    const config = searchResultValue(await searchBridge.saveConfig(patch));
    if (config && typeof config === 'object') applySearchConfig(config);
    setSearchSettingsStatus(okText || '已保存。', 'ok');
  } catch (error) {
    setSearchSettingsStatus(`保存失败：${searchErrorText(error)}`, 'error');
    // 保存失败就按上次读到的配置重绘，避免开关看起来已经生效。
    renderSearchProviders();
  }
}

async function saveProviderConfig(payload, { input, status, okText }) {
  if (!searchBridge?.saveProvider) {
    status.dataset.tone = 'error';
    status.textContent = '保存通道未就绪。';
    return;
  }
  status.removeAttribute('data-tone');
  status.textContent = '正在保存…';
  try {
    const config = searchResultValue(await searchBridge.saveProvider(payload));
    if (input) input.value = '';
    // 保存成功后整块搜索源会重绘，行内提示会被重建，所以把确认文案放到面板级状态行。
    if (config && typeof config === 'object') applySearchConfig(config);
    else await loadSearchConfig(true);
    setSearchSettingsStatus(okText, 'ok');
  } catch (error) {
    status.dataset.tone = 'error';
    status.textContent = `保存失败：${searchErrorText(error)}`;
  }
}

async function testSearchProvider(provider, { button, status }) {
  const label = provider.label || provider.id;
  if (!searchBridge?.testProvider) {
    status.dataset.tone = 'error';
    status.textContent = '测试通道未就绪。';
    return;
  }
  button.disabled = true;
  status.removeAttribute('data-tone');
  status.textContent = '正在测试…';
  try {
    const value = searchResultValue(await searchBridge.testProvider({ providerId: provider.id }));
    const count = Number(value?.count) || 0;
    const sample = (Array.isArray(value?.sample) ? value.sample : [])
      .map(item => item?.title || item?.url).filter(Boolean).slice(0, 3);
    status.dataset.tone = count > 0 ? 'ok' : 'error';
    status.textContent = count > 0
      ? `${label} 连接成功，返回 ${count} 条来源${sample.length ? `：${sample.join('、')}` : ''}。`
      : `${label} 没有返回结果，请检查密钥或服务地址。`;
  } catch (error) {
    status.dataset.tone = 'error';
    status.textContent = `测试失败：${searchErrorText(error)}`;
  } finally {
    button.disabled = false;
  }
}

$('#search-depth')?.addEventListener('change', event => {
  void saveSearchPatch({ depth: event.target.value }, `检索深度已切换为「${SEARCH_DEPTH_LABELS[event.target.value] ?? event.target.value}」。`);
});
$('#search-zone')?.addEventListener('change', event => {
  void saveSearchPatch({ zone: event.target.value }, '搜索区域已保存。');
});
$('#search-language')?.addEventListener('change', event => {
  void saveSearchPatch({ language: event.target.value }, '搜索语言已保存。');
});
// 首次进入设置页再拉配置：启动时不打扰主进程，也不会因通道缺失报错。
renderSearchProviders();
// ── Archived chats (settings page) ────────────────────────────────────
const archiveState = { query: '', type: 'all', sort: 'updated', project: 'all' };
const archiveList = $('#archive-list');

function archiveEntries() {
  const rows = [];
  projects.forEach(project => {
    project.chats.filter(chat => chat.archived).forEach(chat => rows.push({ project, chat }));
  });
  const q = archiveState.query.trim().toLocaleLowerCase();
  let filtered = rows.filter(({ project, chat }) =>
    (!q || chat.title.toLocaleLowerCase().includes(q))
    && (archiveState.type === 'all' || chat.location === archiveState.type)
    && (archiveState.project === 'all' || archiveState.project === project.name));
  if (archiveState.sort === 'alpha') filtered.sort((a, b) => a.chat.title.localeCompare(b.chat.title, 'zh-Hans-CN'));
  else if (archiveState.sort === 'created') filtered.sort((a, b) => a.chat.createdAt - b.chat.createdAt);
  else filtered.sort((a, b) => b.chat.updatedAt - a.chat.updatedAt);
  return filtered;
}

function formatArchiveDate(value) {
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日  ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderArchive() {
  archiveList.replaceChildren();
  const entries = archiveEntries();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'archive-empty';
    empty.textContent = archiveState.query || archiveState.type !== 'all' || archiveState.project !== 'all'
      ? '没有符合条件的已归档聊天'
      : '还没有已归档的聊天';
    archiveList.append(empty);
    return;
  }
  const groups = new Map();
  entries.forEach(entry => {
    const key = archiveState.project === 'all' ? entry.project.name : entry.project.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  groups.forEach((items, name) => {
    const head = document.createElement('div');
    head.className = 'archive-group-head';
    head.append(icon('folder-simple'));
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const countSpan = document.createElement('span');
    countSpan.className = 'archive-group-count';
    countSpan.textContent = `${items.length} 个聊天`;
    head.append(nameSpan, countSpan);
    archiveList.append(head);

    const card = document.createElement('div');
    card.className = 'archive-card';
    items.forEach(({ project, chat }) => {
      const row = document.createElement('div');
      row.className = 'archive-row';
      row.innerHTML = `
        <div class="archive-row-main">
          <span class="archive-row-title"></span>
          <span class="archive-row-meta"></span>
        </div>
        <div class="archive-row-actions">
          <button type="button" class="archive-icon-button" data-action="delete" aria-label="永久删除"></button>
          <button type="button" class="settings-button" data-action="restore">取消归档</button>
        </div>`;
      row.querySelector('[data-action="delete"]').append(icon('trash'));
      row.querySelector('.archive-row-title').textContent = chat.title;
      // 元信息带上存储位置徽章，和记忆页里的项目徽章同一套样式。
      const location = document.createElement('span');
      location.className = 'memory-project';
      location.textContent = chat.location === 'cloud' ? '云端' : '本地';
      row.querySelector('.archive-row-meta').replaceChildren(location, document.createTextNode(formatArchiveDate(chat.updatedAt)));
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        // 永久删除不可恢复：先按规范走确认弹窗，确认后才动数据。
        const keys = chatKeysFor(project, chat);
        const messages = keys.reduce((total, key) => total + (conversations.get(key)?.length ?? 0), 0);
        const confirmed = await confirmAction({
          title: `永久删除「${chat.title}」？`,
          body: '删除后无法恢复，也不会再出现在已归档列表里。',
          detail: messages
            ? `这条聊天和它的 ${messages} 条消息会被永久删除，其它聊天不受影响。只想从列表里移走的话，请改用「取消归档」。`
            : '只想从列表里移走的话，请改用「取消归档」。',
          confirmLabel: '永久删除',
          tone: 'danger',
        });
        if (!confirmed) return;
        // 真正动手只有一处（dropChat）：会话正文、目标/用量/引用/权限预设一起清，
        // 并把「正选中它」的状态收干净。历史上这段逻辑在两个地方各抄了一份，改一边漏一边。
        dropChat(project, chat);
        saveWorkspace();
        renderArchive();
        $('#sidebar-announcement').textContent = `已删除聊天：${chat.title}`;
      });
      row.querySelector('[data-action="restore"]').addEventListener('click', async () => {
        chat.archived = false;
        const pending = persistArchiveChange();
        renderArchive();
        renderProjects($('#project-search').value);
        const persisted = await pending;
        $('#sidebar-announcement').textContent = `已取消归档：${chat.title}${persisted ? '' : STORAGE_NOT_READY_HINT}`;
      });
      card.append(row);
    });
    archiveList.append(card);
  });
}

function setArchiveMenu(menuId, buttonId, open) {
  $(menuId).hidden = !open;
  $(buttonId).setAttribute('aria-expanded', String(open));
}

$('#archive-search').addEventListener('input', event => {
  archiveState.query = event.target.value;
  renderArchive();
});
$('#archive-type-button').addEventListener('click', () => setArchiveMenu('#archive-type-menu', '#archive-type-button', $('#archive-type-menu').hidden));
$('#archive-project-button').addEventListener('click', () => {
  const menu = $('#archive-project-menu');
  if (menu.hidden) {
    menu.replaceChildren();
    const options = [{ id: 'all', label: '所有项目' }, ...projects.map(project => ({ id: project.name, label: project.name }))];
    options.forEach(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(archiveState.project === option.id));
      button.textContent = option.label;
      button.addEventListener('click', () => {
        archiveState.project = option.id;
        $('#archive-project-label').textContent = option.label;
        setArchiveMenu('#archive-project-menu', '#archive-project-button', false);
        renderArchive();
      });
      menu.append(button);
    });
  }
  setArchiveMenu('#archive-project-menu', '#archive-project-button', menu.hidden);
});
document.querySelectorAll('[data-archive-type]').forEach(button => {
  button.addEventListener('click', () => {
    archiveState.type = button.dataset.archiveType;
    document.querySelectorAll('[data-archive-type]').forEach(other => other.setAttribute('aria-checked', String(other === button)));
    $('#archive-type-button span').textContent = button.textContent.trim();
    renderArchive();
  });
});
document.querySelectorAll('[data-archive-sort]').forEach(button => {
  button.addEventListener('click', () => {
    archiveState.sort = button.dataset.archiveSort;
    document.querySelectorAll('[data-archive-sort]').forEach(other => other.setAttribute('aria-checked', String(other === button)));
    renderArchive();
  });
});
document.addEventListener('click', event => {
  if (!event.target.closest('.archive-menu-wrap')) {
    setArchiveMenu('#archive-type-menu', '#archive-type-button', false);
    setArchiveMenu('#archive-project-menu', '#archive-project-button', false);
  }
});

$('#remove-cancel').addEventListener('click', () => removeDialog.close());
$('#remove-confirm').addEventListener('click', async () => {
  const id = removeDialog.dataset.providerId;
  removeDialog.close();
  if (!id || !providerBridge) return;
  try {
    const result = await providerBridge.remove(id);
    if (!result.ok) throw new ModelConnectionError(result.error);
    if (providersState) {
      providersState.providers = result.value.providers;
      providersState.active = result.value.active;
    }
    editorDraft = null;
    renderModelsPage();
    syncComposerModels();
    setModelMessage('已删除提供商，聊天会使用列表中的第一个模型。');
  } catch (error) {
    setModelMessage(error instanceof ModelConnectionError ? error.message : '删除失败，请重试。', 'error');
  }
});

$('#settings-button').addEventListener('click', () => openSettings());
const settingsSearchField = $('#settings-search-field');
const settingsSearchToggle = $('#settings-search-toggle');
function setSettingsSearch(open) {
  settingsSearchField.hidden = !open;
  settingsSearchToggle.setAttribute('aria-expanded', String(open));
  if (open) { $('#settings-search').focus({ preventScroll: true }); return; }
  $('#settings-search').value = '';
  document.querySelectorAll('[data-settings-item]').forEach(button => { button.hidden = false; });
}
settingsSearchToggle.addEventListener('click', () => setSettingsSearch(settingsSearchField.hidden));
document.querySelectorAll('[data-settings-item]').forEach(button => {
  button.addEventListener('click', () => selectSettingsPage(button.dataset.settingsItem));
});
document.querySelectorAll('.settings-switch').forEach(signal => {
  signal.addEventListener('click', () => {
    signal.setAttribute('aria-checked', signal.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
});
$('#settings-search').addEventListener('input', event => {
  const query = event.target.value.trim().toLocaleLowerCase();
  document.querySelectorAll('[data-settings-item]').forEach(button => {
    const searchText = `${button.textContent} ${button.dataset.settingsKeywords ?? ''}`;
    button.hidden = Boolean(query) && !searchText.toLocaleLowerCase().includes(query);
  });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || settingsView.hidden) return;
  if (!settingsSearchField.hidden) { event.preventDefault(); event.stopPropagation(); setSettingsSearch(false); return; }
  event.stopPropagation(); closeSettings();
}, true);

// While the sidebar is collapsed, hovering the home rail button peeks it as a floating panel.
const peekHost = $('.content-frame');
let peekTimer = 0;
function peekSidebar(show) {
  clearTimeout(peekTimer);
  const collapsed = $('.window-shell').classList.contains('sidebar-collapsed');
  if (show && collapsed) {
    peekHost.classList.add('peek-sidebar');
    return;
  }
  if (show) return;
  peekTimer = setTimeout(() => peekHost.classList.remove('peek-sidebar'), 160);
}
function hidePeekNow() { clearTimeout(peekTimer); peekHost.classList.remove('peek-sidebar'); }
$('#home-button').addEventListener('pointerenter', () => peekSidebar(true));
$('#home-button').addEventListener('focus', () => peekSidebar(true));
$('#home-button').addEventListener('pointerleave', () => peekSidebar(false));
$('#home-button').addEventListener('blur', () => peekSidebar(false));
peekHost.addEventListener('pointerenter', () => clearTimeout(peekTimer));
peekHost.addEventListener('pointermove', event => {
  if (!peekHost.classList.contains('peek-sidebar')) return;
  if (event.clientX > $('.project-sidebar').getBoundingClientRect().right + 12) hidePeekNow();
});
peekHost.addEventListener('pointerleave', () => { if (!peekHost.contains(document.activeElement)) peekSidebar(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') hidePeekNow(); });
if (matchMedia('(max-width:620px)').matches) toggleSidebar(false);
// Example conversations are shown only for the pre-existing sample entries, never new chats.
if (!savedWorkspace) {
  for (const mode of ['CodeMova', 'ChatMova']) {
    for (const chat of ['开发 Mova 界面 HTML 原型', 'Mova开发前的思考']) {
      conversations.set(JSON.stringify([mode, 'Mova', chat]), createDemoConversation());
    }
  }
}

function updateComposerContext() {
  const strip = $('#composer-context');
  const codeMode = $('#mode-label').textContent === 'CodeMova';
  const show = codeMode && !selectedChat;
  strip.hidden = !show;
  if (show) $('#context-project span').textContent = selectedProject || '选择项目';
}

$('#context-project').addEventListener('click', () => {
  toggleSidebar(true);
  $('.project-row.selected')?.focus({ preventScroll: true });
});
$('#context-machine').addEventListener('click', () => {
  $('#sidebar-announcement').textContent = '原型不会访问真实文件系统';
});

const conversationView = $('#conversation');
const conversationRoot = createRoot(conversationView);
let composerBusy = false;

function syncComposerBusy() {
  const busy = activeArea === 'home' && activeReplies.has(conversations.get(draftKey()));
  if (busy === composerBusy) return;
  composerBusy = busy;
  composer.update({ busy });
}

function syncComposerModels() {
  const entries = activeArea === 'home' ? flatModels() : [];
  if (!entries.length) {
    window.__MOVA_MODEL_NAMES = {};
    window.__MOVA_MODEL_GROUPS = {};
    composer.update({
      models: ['deepseek-chat', 'deepseek-reasoner'],
      selectedModel: activeArea === 'messages' ? BOT_MODEL : (chatModelSelections.get(draftKey())?.key ?? homeSelectedModel),
      value: 'medium',
      thinkingOptions: null,
    });
    return;
  }
  const selection = activeSelection();
  window.__MOVA_MODEL_NAMES = modelKeyLabels(entries);
  // 分组标题：键是模型 key，值是 provider 显示名称。输入栏的模型菜单在 shadow DOM 里，
  // 拿不到 providersState，只能靠这两个挂在 window 上的映射表（另一张是显示名称）。
  window.__MOVA_MODEL_GROUPS = Object.fromEntries(entries.map(entry => [entry.key, providerGroupLabel(entry.provider)]));
  composer.update({
    models: entries.map(entry => entry.key),
    selectedModel: selection?.key,
    value: activeThinkingLevel(),
    thinkingOptions: thinkingOptionList(selection?.model),
  });
}

/**
 * 这一轮用户发出的图片：后端确认前先用内存里的原图，确认后改用持久化的图片地址，
 * 这样发送后立刻能看到缩略图，也不会因为上传失败而「吞掉」图片。
 */
function transcriptImages(message) {
  const pending = pendingTurnImages.get(message) ?? [];
  if (pending.length) {
    return pending
      .filter(item => item?.dataUrl)
      .map(item => ({ src: item.dataUrl, alt: item.name || '' }));
  }
  return (message.imageIds ?? [])
    .filter(id => typeof id === 'string' && id && id !== pendingImageMarker)
    .map(id => ({ src: `./chat-images/${id}`, alt: '' }));
}

/* ── notice 行：主进程的旁白，不是对话内容 ────────────────────────────────
   `{type:'notice'}` 没有 id，混进 reply.timeline 就会变成一条无法回填的怪行，
   还会被 workspace save 当成消息持久化。所以它只以「时间线里的一行浅色提示」
   存在：直接往滚动容器末尾追加一个 <p>（这个节点不归 React，也不进 turn 数据），
   这样既不新增全局状态，也不用改 styles.css。 */

/** 只留当前会话的提示行：归属写在 dataset 上，切会话时把别人的清掉。 */
function pruneNoticeRows(key) {
  for (const row of conversationView.querySelectorAll(':scope > .notice-row')) {
    if (row.dataset.noticeKey !== key) row.remove();
  }
}

/** 一条 notice → 一行提示；只在「这条回复正显示在眼前」时调用（否则会画错会话）。 */
function appendNoticeRow(key, event) {
  const row = noticeRow(event);
  if (!row || !conversationView || conversationView.hidden) return;
  const line = document.createElement('p');
  line.className = 'notice-row';
  line.setAttribute('role', 'note');
  line.dataset.noticeKey = key;
  line.dataset.tone = row.tone;
  // 视觉对齐 assistant 的次要文字：12px、次要灰，warn/error 用暖色。
  // 这几条只属于这一行，写内联是因为 styles.css 不在本次可改范围。
  line.style.margin = '0';
  line.style.fontSize = '12px';
  line.style.lineHeight = '1.6';
  line.style.color = row.color;
  line.style.whiteSpace = 'pre-wrap';
  line.style.overflowWrap = 'anywhere';
  line.textContent = row.line;
  // 用户本来就贴在底部时才跟着滚：回看旧消息时不要把阅读位置拽走。
  const follow = conversationView.scrollHeight - conversationView.scrollTop - conversationView.clientHeight < 32;
  conversationView.append(line);
  if (follow) conversationView.scrollTop = conversationView.scrollHeight;
}

function renderConversation() {
  renderChatFeedback();
  syncInteractionContext();
  syncComposerModels();
  const permissionPreset = currentPermissionPreset();
  if (shownPermissionPreset !== permissionPreset) {
    shownPermissionPreset = permissionPreset;
    window.dispatchEvent(new Event('movaPermissionPresetChanged'));
  }
  syncComposerBusy();
  if (activeArea === 'messages') { renderBotConversation(); return; }
  updateComposerContext();
  renderChatPrivacy();
  const key = draftKey();
  const messages = conversations.get(key) || [];
  const active = messages.length > 0;
  pruneNoticeRows(key);
  $('#welcome').hidden = active; conversationView.hidden = !active;
  // 标题栏在新聊天也显示：「⋯」与临时聊天入口都在这里，空态时同样可点。
  setChatHeaderVisible(true);
  $('#chat-fade').hidden = !active;
  $('.main-panel').classList.toggle('is-chatting', active);
  $('#chat-header-title').textContent = selectedChat || '新聊天';
  conversationRoot.render(active ? React.createElement(ChatTranscript, {
    key, turns: messages.map(message => ({ ...message, images: transcriptImages(message) })), viewport: conversationView,
    busy: activeReplies.has(messages), onRetry: index => retryReply(index),
    onNotify: message => chatFeedback(message),
    onRewrite: index => rewriteMessage(index),
  }) : null);
  syncHeaderPanels(key, active);
}

/** 头部两个浮层只反映当前会话：目标 / 计划与真实用量。 */
function syncHeaderPanels(key, active) {
  aimView?.setAim(active ? (chatAims.get(key) ?? null) : null);
  usageView?.setUsage(active ? (chatUsage.get(key) ?? null) : null);
}

/** 旧会话没有时间戳：用聊天记录的创建时间兜底，至少能显示真实日期。 */
function conversationStart(key) {
  try {
    const [mode, projectName, title] = JSON.parse(key);
    const project = projects.find(item => item.name === projectName);
    const chat = project?.chats.find(item => item.title === title && (item.mode || 'CodeMova') === mode);
    return Number(chat?.createdAt) || 0;
  } catch { return 0; }
}

/** 把一条用户消息放回输入框，交给用户改完再发；不做隐式重发。 */
function rewriteMessage(index) {
  const messages = conversations.get(draftKey());
  const turn = messages?.[index];
  if (!turn) return;
  if (activeReplies.has(messages)) { chatFeedback('正在生成回复，先停止再重写。'); return; }
  const root = composer.root;
  const textarea = root?.querySelector('textarea');
  if (!textarea) { chatFeedback('输入框暂时不可用，请手动复制这条消息。'); return; }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, turn.text ?? '');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus({ preventScroll: false });
  chatFeedback('已把这条消息放回输入框，可修改后重新发送。');
}

function settleToolRows(timeline, detail) {
  for (const event of timeline ?? []) {
    if (event.type === 'tool' && event.status === 'running') Object.assign(event, { status: 'error', detail });
  }
}
function settleSearchRows(timeline, detail) {
  for (const event of timeline ?? []) {
    if ((event.type === 'search' || event.type === 'read') && event.status === 'running') Object.assign(event, { status: 'error', detail });
  }
}

/* 目标 / 计划：只记录模型通过 set_goal / update_goal / set_plan 真正写入的内容，
   不做任何推测；两者都为空时把这条会话的条目一起删掉。 */
function applyAimEvent(key, event) {
  if (temporaryConversations.has(key)) return;
  // 只认 goal / plan：`context`（上下文台账上报）等其它状态事件若落进来，
  // 下面「else 即 plan」的写法会把它当成 plan:null，把用户看到的计划清空。
  if (event.type !== 'goal' && event.type !== 'plan') return;
  const current = chatAims.get(key) ?? { goal: null, plan: null };
  if (event.type === 'goal') {
    const previousTitle = current.goal?.title ?? '';
    current.goal = event.goal ?? null;
    // 换了一个新目标就重新给自动推进的轮数预算，旧目标的消耗不继承。
    if (current.goal && current.goal.title !== previousTitle) {
      current.auto = { ...(current.auto ?? {}), rounds: 0, stall: 0 };
    }
  } else {
    current.plan = event.plan ?? null;
  }
  if (!current.goal && !current.plan) chatAims.delete(key);
  else chatAims.set(key, current);
  scheduleWorkspaceSave();
}

/** 送给主进程的目标快照：只有 goal / plan，自动推进的计数留在渲染端。 */
function goalSnapshot(key) {
  const aim = chatAims.get(key);
  if (!aim?.goal && !aim?.plan) return null;
  return { goal: aim.goal ?? null, plan: aim.plan ?? null };
}

/** 用户自己发消息后重置自动推进预算（轮数与「没有进展」计数都归零）。 */
function resetGoalBudget(key) {
  const aim = chatAims.get(key);
  if (!aim?.auto) return;
  if (!aim.auto.rounds && !aim.auto.stall) return;
  chatAims.set(key, { ...aim, auto: { ...aim.auto, rounds: 0, stall: 0 } });
}

/**
 * 每轮结束后的目标检查：
 *   目标已完成 / 受阻 / 暂停 / 还没被模型接受 → 什么都不做（自动推进停止）；
 *   仍是 active 且被接受 → 自己开下一轮，直到完成或撞上轮数 / 无进展上限。
 * 只有当前会话在前台、且没有别的生成在跑时才继续，避免在后台偷偷烧 token。
 */
function maybeContinueGoal({ key, status, touched = false }) {
  const aim = chatAims.get(key);
  const decision = goalRoundDecision({ aim, status, touched });
  if (decision.action === 'skip') return;
  const next = { ...(aim ?? {}), auto: { ...(aim?.auto ?? {}), rounds: decision.rounds, stall: decision.stall } };
  if (decision.action === 'stop') {
    const reason = GOAL_STOP_TEXT[decision.reason] ?? '自动推进已停止';
    if (next.goal) {
      next.goal = { ...next.goal, status: 'paused', summary: reason };
      chatAims.set(key, next);
      scheduleWorkspaceSave();
      aimView?.setAim(next);
    }
    chatFeedback(`${reason}；在目标卡片里点「继续」可以接着做。`);
    return;
  }
  if (activeArea !== 'home' || draftKey() !== key) return;
  if (activeReplies.size) return;
  next.auto.rounds = decision.rounds + 1;
  chatAims.set(key, next);
  scheduleWorkspaceSave();
  aimView?.setAim(next);
  const round = next.auto.rounds;
  const bundle = buildGoalTurn({ goal: next.goal, steps: next.plan?.steps ?? [], round, max: GOAL_AUTO_MAX_ROUNDS });
  const accepted = sendMessage({ text: bundle.text, autoContinue: true, note: bundle.note });
  if (accepted === false) {
    // 发送被拒（存储错误、正在生成等）：把刚占用的这一轮还回去。
    next.auto.rounds = decision.rounds;
    chatAims.set(key, next);
    scheduleWorkspaceSave();
    aimView?.setAim(next);
    return;
  }
  chatFeedback(`目标未完成，正在自动继续（第 ${round}/${GOAL_AUTO_MAX_ROUNDS} 轮）…`);
}

/* Token 用量：逐次累加提供商返回的 usage；`calls` 就是模型调用次数。 */
function applyUsageEvent(key, event) {
  if (temporaryConversations.has(key)) return;
  const call = event.call ?? {};
  const current = chatUsage.get(key) ?? {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, calls: 0, elapsedMs: 0,
  };
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost']) {
    current[field] = (Number(current[field]) || 0) + (Number(call[field]) || 0);
  }
  current.calls = (Number(current.calls) || 0) + 1;
  current.lastCall = { input: Number(call.input) || 0, output: Number(call.output) || 0 };
  if (event.model) current.model = event.model;
  chatUsage.set(key, current);
  scheduleWorkspaceSave();
}

/**
 * 上下文台账的上报（`{type:'context', report}`）：只存不画。
 *
 * 为什么只存：面板还没做；而这份数据眼下唯一的用处是让「长对话怎么处理」的提示说真话。
 * 渲染端原来那段 `buildContextHistory` 先算一遍「会保留多少条」、再照发完整 history，
 * 算出来的数字只喂提示、从不参与发送（方案 §5 P0-6 记为死代码），已删除；
 * 这里统一用主进程回报的真实口径 `report.messages.sent/total`。
 * 不调 scheduleWorkspaceSave：观测值不持久化，免得 workspace 里留下过期数字。
 */
function applyContextReport(key, report) {
  if (!report || typeof report !== 'object') return;
  chatContexts.set(key, report);
  const sent = Number(report.messages?.sent);
  const total = Number(report.messages?.total);
  // 只有主进程真的少发了才提示：没压缩的正常轮次不该额外冒一句废话。
  if (!Number.isFinite(sent) || !Number.isFinite(total) || sent >= total) return;
  chatFeedback(`长对话处理：本轮发送 ${sent}/${total} 条消息，较早内容已按上下文台账压缩；原记录完整保留。`, key);
}

function renderChatFeedback() {
  const note = $('#chat-feedback');
  const message = feedbackState.get(draftKey());
  note.hidden = !message || activeArea !== 'home';
  note.textContent = note.hidden ? '' : message;
}
function chatFeedback(message = '', key = draftKey(), kind = 'notice') {
  feedbackState.set(key, message, kind);
  renderChatFeedback();
}
function recoverChatFeedback(key) {
  feedbackState.recover(key);
  renderChatFeedback();
}

// Keep originals only in memory until the backend has acknowledged every image.
const pendingTurnImages = new WeakMap();
// Stored with image IDs so an interrupted upload cannot become a text-only retry after restart.
const pendingImageMarker = 'pending-image-upload';

function retryReply(index) {
  const messages = conversations.get(draftKey());
  if (!messages || activeReplies.has(messages) || !messages[index]) return;
  const turn = messages[index];
  if (!['error', 'stopped', 'interrupted'].includes(turn.reply?.status)) return;
  const attachments = pendingTurnImages.get(turn) ?? [];
  if (!turn.text.trim() && !attachments.length && !turn.imageIds?.length) {
    chatFeedback('原图不可用，请重新上传图片后发送。'); return;
  }
  sendMessage({ text: turn.text, attachments, retryIndex: index, model: activeSelection()?.model.id });
}
function monitorProjectCloudTask(project, chat, messages, turn, key, controller, loadTask) {
  const call = (action, input) => desktopCloudCall(cloudBridge, action, chat.cloudOrigin, input);
  const reply = turn.reply;
  turn.cloudPending = true;
  saveWorkspace();
  chatFeedback('正在连接云端任务…', key);
  void (async () => {
    const task = await loadTask(call);
    if (turn.cloudTask) {
      turn.cloudTask.id = task.id;
      delete turn.cloudTask.replacementId;
    }
    reply.cloudProvider = task.provider;
    chat.cloudConversationId = task.conversationId;
    saveWorkspace();
    const result = await waitForCloudTask(call, task, { signal: controller.signal, onStatus: status => {
      if (status === 'queued' || status === 'running') chatFeedback(status === 'queued' ? '云端排队中…' : '正在云端执行…', key);
    } });
    reply.text = result.result || '';
    reply.status = 'done';
    turn.cloudPending = false;
    chatFeedback('', key);
  })().catch(error => {
    reply.status = controller.signal.aborted ? 'stopped' : 'error';
    const actualError = String(error.message || error);
    const message = cloudTaskError(reply.cloudProvider, actualError);
    reply.error = message === actualError ? message : `${message} 项目使用「设置 → 云端与连接」中的默认云端模型。`;
    if (controller.signal.aborted || error.taskStatus || error.status === 404) turn.cloudPending = false;
    chatFeedback(controller.signal.aborted ? '已请求取消云端任务。' : reply.error, key);
  }).finally(() => {
    activeReplies.delete(messages);
    syncRunningChats();
    chat.updatedAt = Date.now();
    chatRows.touch?.(chatConversationKey(project, chat), chat.updatedAt);
    saveWorkspace();
    if (activeArea === 'home' && conversations.get(draftKey()) === messages) renderConversation();
  });
}

function reconnectProjectCloudTask() {
  const project = projects.find(item => item.name === selectedProject);
  const chat = project?.chats.find(item => item.title === selectedChat);
  const key = draftKey();
  const messages = conversations.get(key);
  const turn = messages?.at(-1);
  if (!cloudBridge || !chat?.cloudOrigin || !turn?.cloudPending || !turn.cloudTask?.id || activeReplies.has(messages)) return;
  const controller = new AbortController();
  activeReplies.set(messages, controller);
  turn.reply.status = 'streaming';
  syncRunningChats();
  renderConversation();
  monitorProjectCloudTask(project, chat, messages, turn, key, controller, async call => {
    if (turn.cloudTask.replacementId) {
      const replacement = await call('task', { id: turn.cloudTask.replacementId }).catch(error => { if (error.status !== 404) throw error; });
      if (replacement) return replacement;
    }
    return call('task', { id: turn.cloudTask.id });
  });
}

function sendMessage({ text, attachments = [], model, thinking, retryIndex, quotes = [], autoContinue = false, note = '' }) {
  if (!memoryReady) { chatFeedback('正在载入本地会话，请稍候。'); return false; }
  if (memorySaveError) { chatFeedback(`上次保存失败（${memorySaveError}），为避免丢失聊天记录已暂停发送。请先导出备份并检查存储。`); return false; }
  if (providersLoading || activeArea === 'forum' || activeReplies.has(conversations.get(draftKey()))) return false;
  // 用户自己打的字：空消息判定与自动记忆提取只吃这一段，引用内容不写成“用户事实”。
  const content = text.trim();
  // 引用行 + 正文：写进 turn.text、上下文历史和 60k 预算检查（§3.12）。
  const merged = mergeUserText(quotes, content);
  if (activeArea === 'messages') {
    if (!content || attachments.length) return false;
    const chat = botChats.find(item => item.id === selectedBot);
    if (!chat) return false;
    const mentions = extractBotMentions(content, chat);
    const userMsg = {
      id: `message-${++botSequence}`,
      role: 'user',
      senderId: 'user',
      senderName: '我',
      text: content,
      content,
      replyToMessageId: null,
      replyTo: null,
      mentions,
      createdAt: Date.now(),
    };
    chat.messages.push(userMsg);
    chat.unread = 0;
    if (chat.botId) {
      const targetBot = findBot(chat.botId);
      if (targetBot) recordBotUse(targetBot);
    }
    renderBotConversation();
    void dispatchBotMessage(chat, userMsg);
    return true;
  }
  chatFeedback();
  const currentProject = projects.find(item => item.name === selectedProject);
  const cloudOrigin = selectedChat ? currentProject?.chats.find(item => item.title === selectedChat)?.cloudOrigin : currentProject?.cloudOrigin;
  if (cloudOrigin && (!cloudBridge || attachments.length || temporaryConversations.has(draftKey()) || (!selectedChat && temporaryNextChat))) {
    chatFeedback(!cloudBridge ? '请在 Mova 桌面版使用云端项目。' : attachments.length ? '云端项目支持文本任务。请将需要处理的文字贴到消息中。' : '云端任务会保存在主机上。请关闭临时聊天后发送。');
    return false;
  }
  if (cloudOrigin && merged.length > 8000) { chatFeedback('云端项目单次最多发送 8,000 字。'); return false; }
  const selection = !cloudOrigin && desktopMovaClient ? activeSelection() : null;
  if (isEdge && !selection && !cloudOrigin) { chatFeedback('请先在 Mova 桌面端配置聊天模型。'); return false; }
  const client = selection && desktopMovaClient ? desktopMovaClient : mockMovaClient;
  const entry = client.source === 'model' ? selection?.model ?? null : null;
  const retryImages = retryIndex !== undefined && (conversations.get(draftKey())?.[retryIndex]?.imageIds?.length ?? 0) > 0;
  // 附件分三类：图片（要模型支持多模态）、文本（正文进上下文）、二进制（只带说明）。
  // 校验在 attachment-rules.mjs 里，规则与主进程的上限同源。
  const hasImages = attachments.some(item => item?.kind === 'image');
  if ((hasImages || retryImages) && !entry?.vision) {
    chatFeedback('当前模型未标记「多模态」，发不了图片；文本与其它文件不受影响（可到设置 → 模型中开启多模态）。');
    return false;
  }
  const attachmentCheck = checkAttachments(attachments);
  if (!attachmentCheck.ok) { chatFeedback(attachmentCheck.message); return false; }
  if (!content && !attachments.length && retryIndex === undefined) return false;
  if (merged.length > USER_TEXT_BUDGET) { chatFeedback('单条消息超过 60,000 字符安全预算，请拆分发送。'); return false; }
  const isNewChat = !selectedChat;
  const designDraftScope = draftKey();
  const permissionPreset = currentPermissionPreset();
  const mode = $('#mode-label').textContent;
  if (isNewChat) {
    let project = projects.find(item => item.name === selectedProject);
    if (!project) { project = { name: selectedProject || 'Mova', chats: [] }; projects.unshift(project); selectedProject = project.name; }
    // 新对话的第一件事：**先把名字定下来**（不等模型、不等回复），左侧列表因此立刻有一个干净标题。
    // 以前这里是「第一句话的前 36 个字符」，而模型改名那条路对订阅账号走不通（没有 API key），
    // 所以用户看到的就是「一句话原文」一直挂在那里、永远不更新。
    const base = instantChatTitle(content || attachments[0]?.name || '') || (attachments[0]?.name ? String(attachments[0].name) : '新对话');
    let title = base;
    let suffix = 2;
    while (project.chats.some(chat => chat.title === title)) title = `${base} (${suffix++})`;
    const now = Date.now();
    project.chats.unshift({ title, mode, location: cloudOrigin ? 'cloud' : 'local', ...(cloudOrigin ? { cloudOrigin } : {}), archived: false, createdAt: now, updatedAt: now });
    selectedChat = title;
  }
  const key = draftKey();
  // 用户自己发的那一条重置自动推进预算：人重新参与后，模型又有完整的轮数可用。
  if (!autoContinue) resetGoalBudget(key);
  if (isNewChat) {
    sideBrowser?.rekeyScope(designDraftScope, key);
    if (!temporaryNextChat) designWorkspace.rekey(designDraftScope, key);
    chatPermissionPresets.set(key, permissionPreset);
    chatModelSelections.set(key, selection ? { providerId: selection.providerId, modelId: selection.model.id } : { key: model });
    chatModelSelections.delete(designDraftScope);
    draftPermissionPreset = 'default';
  }
  const replyStartedAt = Date.now();
  if (isNewChat && temporaryNextChat) {
    temporaryConversations.add(key);
    // 一次性标记：下一条新聊天默认照常保存，除非用户再点一次隐私图标。
    temporaryNextChat = false;
  }
  const messages = conversations.get(key) || [];
  const reply = { source: cloudOrigin ? 'cloud' : client.source, status: 'streaming', text: '' };
  if (entry) { reply.model = entry.id; reply.providerId = selection.providerId; reply.timeline = []; }
  let turn;
  if (retryIndex !== undefined) {
    turn = messages[retryIndex];
    if (!turn) return false;
    if (retryIndex < messages.length - 1) {
      chatFeedback('请先重试最后一条失败回复；修改历史轮次需要会话分支，当前尚未接入。'); return false;
    }
    (turn.replyAttempts ??= []).push(turn.reply);
    if (turn.replyAttempts.length > 2) turn.replyAttempts.splice(0, turn.replyAttempts.length - 2);
    // Re-uploading the originals creates new IDs. Drop partial/old IDs so a
    // later retry cannot accidentally include duplicates or exceed image limits.
    if (attachments.length) turn.imageIds = [pendingImageMarker];
    turn.reply = reply;
  } else {
    turn = { id: `msg-${crypto.randomUUID()}`, at: Date.now(), text: merged, reply };
    // 自动继续不是用户说的话：对话里只显示一条灰色进度行，不伪装成用户提问。
    if (autoContinue) { turn.internal = true; turn.note = note || '自动继续'; }
    if (attachments.length) {
      pendingTurnImages.set(turn, attachments.slice());
      // 只有图片需要占位图（等主进程回传落盘后的 id）；文本与二进制附件直接按名字回显。
      if (hasImages) turn.imageIds = [pendingImageMarker];
      const files = attachments.filter(item => item?.kind !== 'image').map(attachmentSummary);
      if (files.length) turn.files = files;
    }
    messages.push(turn);
  }
  conversations.set(key, messages);
  const project = projects.find(item => item.name === selectedProject);
  const chat = project?.chats.find(item => item.title === selectedChat);
  if (chat) chat.updatedAt = Date.now();

  const controller = new AbortController();
  activeReplies.set(messages, controller);
  // The sidebar shows a spinning ring while this reply streams, and the chat floats to the top
  // because it is now the most recently used one.
  syncRunningChats();
  if (chat) chatRows.touch?.(chatConversationKey(project, chat), chat.updatedAt);
  if (isNewChat) renderProjects($('#project-search').value);
  else saveWorkspace();
  renderConversation();
  // 失败或中断的上一轮也要进历史：模型必须看到「已经说了什么、动过哪些工具」，
  // 说「继续」时才能接着做。旧实现只发送 status === 'done' 的回复，导致中断即失忆。
  const interruptedNote = reply => {
    const tools = (reply.timeline || [])
      .filter(item => item.type === 'tool' && item.name)
      .map(item => `${item.name}${item.status && item.status !== 'done' ? `(${item.status})` : ''}`);
    const parts = ['上一轮在这里中断，以上是已经产生的内容。'];
    if (tools.length) parts.push(`已执行的操作：${[...new Set(tools)].slice(-20).join('、')}；这些操作不要重复。`);
    parts.push('继续时请从当前进度接着做，不要从头再来。');
    return `\n\n[${parts.join('')}]`;
  };
  const history = messages.filter(message => !message.thinking).flatMap(message => {
    const user = { role: 'user', text: message.text, images: message.imageIds };
    const reply = message.reply;
    if (!reply || reply.source !== client.source) return [user];
    const partial = reply.status !== 'done';
    if (partial && (!reply.text.trim() || reply.status === 'streaming')) return [user];
    const text = partial ? `${reply.text}${interruptedNote(reply)}` : reply.text;
    const lastText = reply.timeline?.filter(item => item.type === 'text').at(-1);
    const round = Number(lastText?.id.split(':')[0]);
    const reasoning = reply.timeline?.filter(item => item.type === 'thinking' && item.round === round)
      .map(item => item.text).join('\n');
    return [user, { role: 'assistant', text, model: reply.model, reasoning }];
  });
  const refreshIfVisible = () => {
    if (activeArea === 'home' && conversations.get(draftKey()) === messages) renderConversation();
  };
  if (cloudOrigin) {
    const request = turn.cloudTask ??= {
      id: turn.id, ...(chat.cloudConversationId ? { conversationId: chat.cloudConversationId } : {}),
      prompt: [project.instructions?.trim(), turn.text].filter(Boolean).join('\n\n'),
    };
    if (retryIndex !== undefined) request.replacementId ??= globalThis.crypto.randomUUID();
    monitorProjectCloudTask(project, chat, messages, turn, key, controller, async call => {
      let task;
      if (retryIndex !== undefined) {
        const replacement = await call('task', { id: request.replacementId }).catch(error => { if (error.status !== 404) throw error; });
        if (replacement) return replacement;
        task = await call('task', { id: request.id }).catch(error => { if (error.status !== 404) throw error; });
        if (task && ['blocked', 'failed', 'cancelled'].includes(task.status)) {
          task = await call('retry', { id: request.id, useHostDefault: true, replacementId: request.replacementId });
        }
      }
      return task || call('submit', request);
    });
    return true;
  }
  const temporary = temporaryConversations.has(key);
  const scopeProject = mode === 'CodeMova' ? selectedProject : null;
  const includeGlobal = memorySettings.includeGlobal && project?.memory !== 'project';
  if (memoryBridge && !temporary && !autoContinue && retryIndex === undefined && content.trim()) {
    void memoryBridge.ingest({ conversationId: key, projectId: scopeProject, messageId: turn.id, text: content, role: 'user' })
      .then(result => {
        if (!result.ok) { chatFeedback('消息已发送，但自动记忆提取失败：' + result.error); return; }
        const value = result.value || {};
        if (value.action === 'forget') chatFeedback('已忘记这条长期记忆。');
        else if (value.action === 'correct') chatFeedback('长期记忆已更正。');
        else if (value.action === 'confirm') chatFeedback(`找到 ${value.candidates?.length || 0} 条匹配记忆，请到设置页确认要忘记/更正哪一条。`);
        else if (value.action === 'none' && value.skipped === 'no-target') chatFeedback('没有找到匹配的长期记忆。');
        else if (value.skipped === 'llm-unavailable') chatFeedback('消息已发送，但记忆提取不可用：请检查模型配置和 API 密钥。');
        else if (value.skipped === 'llm-failed') chatFeedback(`消息已发送，但记忆提取失败${value.error ? `（${value.error}）` : ''}，这条内容未保存。`);
        else if (value.skipped === 'memory-limit') chatFeedback('消息已发送，但记忆数量已达上限，这条内容未保存。');
        else if (value.skipped === 'sensitive-content') chatFeedback('消息已发送，但内容疑似包含敏感信息，这条记忆未保存。');
      })
      .catch(() => chatFeedback('消息已发送，但自动记忆提取失败。'));
  }
  // 这里原来用 buildContextHistory 先算一遍「会保留多少条」，再照发完整 history：
  // 算出来的数字只喂下面那句提示、从不参与发送（方案 §5 P0-6 记为死代码），已删除。
  // 真实口径改由主进程的 context 事件回报，见 applyContextReport 的 report.messages。
  const request = {
    conversationId: key, permissionPreset, temporary, memoryScope: { projectId: scopeProject, includeGlobal },
    projectRootIds: rootIdsForRequest({
      permissionPreset,
      permissionRoots,
      mode,
      project,
    }),
    // Project rules are only meaningful for the project they were written for.
    projectInstructions: mode === 'CodeMova' ? (project?.instructions ?? '') : '',
    mode, provider: selection?.providerId, model: entry?.id ?? model,
    thinking: entry ? activeThinkingLevel() : thinking, messages: history,
    // 搜索开关随「模型能力与隐私」一起移除：配好搜索源就按需搜索，搜索词仍只发给已启用的源。
    search: providersState?.searchConfigured === true,
    // 检索预算的控制项：主进程按 fast/standard/deep 映射到 readCount/maxResults/maxQueries。
    searchDepth: searchDepthValue(), searchZone: searchZoneValue(), searchLanguage: searchLanguageValue(),
    attachments: attachments.map(toRequestAttachment),
    requireCurrentImages: retryIndex !== undefined && retryImages && !attachments.length,
    // 目标 / 计划跟着请求走：主进程据此恢复上一轮的目标状态，工具才能继续改它。
    aim: goalSnapshot(key),
  };
  // 只数图片：文本/二进制附件不会发 image 事件，用 attachments.length 比会把占位图永远留着。
  const imageCount = attachments.filter(item => item?.kind === 'image').length;
  let acknowledgedImages = 0;
  // 这一轮有没有真的动过目标 / 计划：没动过的轮次算「没有进展」，连续两轮就停止自动推进。
  let aimTouched = false;
  void receiveReply(client, request, controller.signal, delta => {
    reply.text += delta;
    recoverChatFeedback(key);
    if (!entry) { scheduleWorkspaceSave(); refreshIfVisible(); }
  }, error => {
    if (error instanceof ModelConnectionError) reply.error = error.message;
  }, event => {
    // notice 是「这一轮发生了什么」的旁白，不是对话内容：它没有 id，
    // 交给 mergeReplyEvent 会得到一条无法回填、还会被 workspace save 持久化的怪行。
    // 所以先在这里拦住，渲染成时间线上的一行浅色提示，并且不写 reply.timeline。
    if (isNoticeEvent(event)) {
      if (activeArea === 'home' && conversations.get(draftKey()) === messages) appendNoticeRow(key, event);
      return;
    }
    // 自动重试：先清掉上一次尝试的半截输出，避免两段回答首尾拼在一起；
    // 主进程会把上一轮已完成的动作作为 checkpoint 交给模型接着做。
    if (event?.type === 'retry') {
      if (reply.timeline) reply.timeline = reply.timeline.filter(item => item.type !== 'text' && item.type !== 'thinking');
      reply.text = '';
      const label = event.reason === 'timeout' ? '响应超时' : '连接中断';
      chatFeedback(`模型${label}，正在第 ${event.attempt}/5 次自动重试…`, key, 'retry');
      refreshIfVisible();
      return;
    }
    if (event?.type === 'thinking' || event?.type === 'tool') recoverChatFeedback(key);
    mergeReplyEvent(reply.timeline, event);
    if (event.type === 'image') {
      if (!turn.imageIds?.includes(event.id)) (turn.imageIds ??= []).push(event.id);
      if (++acknowledgedImages >= imageCount && imageCount) {
        turn.imageIds = turn.imageIds.filter(id => id !== pendingImageMarker);
      }
    }
    scheduleWorkspaceSave();
    refreshIfVisible();
  }, state => {
    // 目标 / 计划与真实用量：不进 transcript，只更新会话级状态。
    if (state.type === 'usage') applyUsageEvent(key, state);
    // 上下文台账只存不画：它既不是 goal 也不是 plan，不能落到下面的 applyAimEvent 分支。
    else if (state.type === 'context') applyContextReport(key, state.report);
    else { aimTouched = true; applyAimEvent(key, state); }
    refreshIfVisible();
  }).then(status => {
    reply.status = status;
    recoverChatFeedback(key);
    if (status === 'done') pendingTurnImages.delete(turn);
    if (reply.timeline) reply.text = reply.timeline.filter(event => event.type === 'text').map(event => event.text).join('\n\n');
    settleSearchRows(reply.timeline, status === 'stopped' ? '搜索已停止' : '搜索未完成');
    settleToolRows(reply.timeline, status === 'stopped' ? '操作已停止' : '操作未完成');
    // 最近一轮耗时：墙钟时间，和用量一起构成卡片上的可核对数字。
    const reported = chatUsage.get(key);
    if (reported) { reported.elapsedMs = Date.now() - replyStartedAt; chatUsage.set(key, reported); }
    activeReplies.delete(messages);
    // The ring goes away and the age comes back; the chat is now the most recent one, so it also
    // floats to the top of the list.
    syncRunningChats();
    if (chat) {
      chat.updatedAt = Date.now();
      chatRows.touch?.(chatConversationKey(project, chat), chat.updatedAt);
    }
    saveWorkspace();
    refreshIfVisible();
    // A brand-new conversation gets its name from the model, once its first exchange exists.
    if (isNewChat && chat && status === 'done') {
      void suggestChatTitle({
        project,
        chat,
        conversationKey: key,
        user: messages.find(message => !message.thinking)?.text,
        assistant: reply.text,
        // 这条对话真正在跑的模型（订阅 provider 没有 API key，必须靠它走对分支）。
        ...(selection?.providerId ? { providerId: selection.providerId } : {}),
        ...(entry?.id ? { modelId: entry.id } : {}),
      });
    }
    // 每次回复结束都检查目标：完成就停，没完成且模型已接受目标就自己开下一轮。
    maybeContinueGoal({ key, status, touched: aimTouched });
  }).catch(error => {
    // A stream that throws never reached the cleanup above, which left the row marked as running
    // (spinner instead of the age) and the composer busy until reload. Treat it as an interruption.
    if (reply.status === 'streaming') reply.status = 'error';
    settleSearchRows(reply.timeline, '搜索已中断');
    settleToolRows(reply.timeline, '操作已中断');
    activeReplies.delete(messages);
    syncRunningChats();
    if (chat) {
      chat.updatedAt = Date.now();
      chatRows.touch?.(chatConversationKey(project, chat), chat.updatedAt);
    }
    chatFeedback(`模型运行中断${error?.message ? `（${error.message}）` : ''}，已停止。已完成的进度会保留，点「重试」或直接说「继续」都能接着做。`, key);
    saveWorkspace();
    refreshIfVisible();
  });
  return true;
}

// Approvals for a single write/command live in the app, above the composer.
// The main process now sends `rootId` with each request, so the bar can wire
// `files.reveal({ rootId, path })`; the desktop object is passed through for
// that, and the bar still hides the button if either half is missing.
createRoot($('#approval-host')).render(React.createElement(ApprovalBar, {
  bridge: routedApprovals,
  clipboard: window.movaDesktop?.clipboard,
  desktop: window.movaDesktop,
}));

/* ── 头部两个浮层 ────────────────────────────────────────────────────
   Token 用量：逐次累加提供商返回的 usage，只显示可核对的总数；
   目标 / 计划：只呈现模型通过 set_goal / update_goal / set_plan 真正写入的内容。
   两者数据都按会话存，并随会话持久化。 */
usageView = bindChatUsage({
  enabled: () => activeArea === 'home',
  onOpen: () => aimView?.close(),
});

aimView = bindChatAim({
  onOpen: () => usageView?.close(),
  onTogglePause: () => {
    const key = draftKey();
    const current = chatAims.get(key);
    if (!current?.goal || current.goal.status === 'done') return;
    const resuming = current.goal.status === 'paused' || current.goal.status === 'blocked';
    const goal = { ...current.goal, status: resuming ? 'active' : 'paused', accepted: resuming ? true : current.goal.accepted };
    if (resuming && goal.summary) delete goal.summary;
    // 用户手动继续 = 重新给一份自动推进预算，并立刻接着做下一步。
    const auto = resuming ? { ...(current.auto ?? {}), rounds: 0, stall: 0, enabled: true } : current.auto;
    const next = { ...current, goal, auto };
    chatAims.set(key, next);
    aimView?.setAim(next);
    scheduleWorkspaceSave();
    if (resuming) {
      chatFeedback('已继续目标。');
      maybeContinueGoal({ key, status: 'done', touched: true });
    }
  },
  onToggleAuto: () => {
    const key = draftKey();
    const current = chatAims.get(key);
    if (!current?.goal) return;
    const enabled = current.auto?.enabled === false;
    const next = { ...current, auto: { ...(current.auto ?? {}), enabled } };
    chatAims.set(key, next);
    aimView?.setAim(next);
    scheduleWorkspaceSave();
    if (enabled) maybeContinueGoal({ key, status: 'done', touched: true });
    else chatFeedback('已关闭自动推进；目标仍保留，点开关可重新打开。');
  },
  onDelete: async () => {
    const key = draftKey();
    const current = chatAims.get(key);
    if (!current) return false;
    const both = Boolean(current.goal && current.plan);
    const confirmed = await confirmAction({
      title: both ? '删除目标和计划？' : current.goal ? '删除当前目标？' : '删除当前计划？',
      body: '删除后这条会话不再显示目标与计划。',
      detail: '模型之后再次调用 set_goal / set_plan 时仍会重新创建，这里只清除当前记录。',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!confirmed) return false;
    chatAims.delete(key);
    aimView?.setAim(null);
    scheduleWorkspaceSave();
    return true;
  },
});

const composer = mountComposer($('#composer'), {  draft: currentDraft(),
  edgeCompact: isEdge,
  disabled: providersLoading,
  // 提交包装：把当前草稿的引用一起带上；发送被拒（空消息/超预算等）时把引用放回去。
  onSubmit: message => {
    const quotes = takeQuotes();
    const accepted = sendMessage({ ...message, quotes });
    if (accepted === false) restoreQuotes(quotes);
    return accepted;
  },
  onStop: () => activeReplies.get(conversations.get(draftKey()))?.abort(),
  onModelChange: key => { void chooseModel(key).then(renderChatPrivacy); },
  onValueChange: thinking => {
    if (typeof thinking !== 'string' || !thinking) return;
    const efforts = activeSelection()?.model.efforts ?? [];
    if (efforts.length && !efforts.includes(thinking)) return;
    desktopPreferences.thinking = thinking;
    saveDesktopPreferences();
  },
  getPermissionPreset: currentPermissionPreset,
  onPermissionChange: preset => {
    if (!permissionBridge) throw new Error('当前未连接 Mova 权限服务。');
    const value = normalizePermissionPreset(preset);
    if (isEdge) void permissionBridge.setConversationPreset?.(draftKey(), value);
    if (selectedChat || activeArea === 'messages') {
      chatPermissionPresets.set(draftKey(), value);
      saveWorkspace();
    } else {
      draftPermissionPreset = value;
    }
    shownPermissionPreset = value;
  },
});

// Bind the initial chat before the user can open the panel, so its first state is not lost.
sideBrowser?.syncScope(draftKey());

/* ── 引用 chip：草稿级数据（drafts Map 按 draftKey 分会话），刷新即丢，与草稿文本一致 ── */
let quoteSequence = 0;

function focusComposer() {
  requestAnimationFrame(() => composer.root.querySelector('textarea')?.focus());
}

function renderQuoteChips() {
  if (!quoteChipRow) return;
  quoteChipRow.render(activeArea === 'home' ? currentDraft().quotes ?? [] : []);
}

/** 统一入口：事件、window.movaQuotes、右侧面板都走这里做规范化 / 去重 / 上限。 */
function addQuote(detail) {
  // 只在 ChatMova / CodeMova 的对话区收集引用（MovaBot / 论坛没有引用语义）。
  if (activeArea !== 'home') return false;
  const quote = normalizeQuote(detail);
  if (!quote) return false;
  const draft = currentDraft();
  draft.quotes ??= [];
  const verdict = canAddQuote(draft.quotes, quote);
  if (!verdict.ok) {
    if (verdict.reason === 'limit') notify('一次最多引用 5 段。', { tone: 'error' });
    else if (verdict.reason === 'duplicate') notify('这段已经引用过了。', { tone: 'error' });
    return false;
  }
  draft.quotes.push({ id: `quote-${++quoteSequence}`, text: quote.text, source: quote.source, at: Date.now() });
  renderQuoteChips();
  focusComposer();
  notify('已引用到对话。');
  return true;
}

function removeQuote(id) {
  const draft = currentDraft();
  draft.quotes = (draft.quotes ?? []).filter(quote => quote.id !== id);
  renderQuoteChips();
}

/** 取出并清空当前草稿的引用（发送用）；返回值就是这一轮要合并的引用。 */
function takeQuotes() {
  const draft = currentDraft();
  const quotes = Array.isArray(draft.quotes) ? draft.quotes.slice() : [];
  if (quotes.length) { draft.quotes = []; renderQuoteChips(); }
  return quotes;
}

/** 发送被拒时把引用放回草稿，避免用户重新选区。 */
function restoreQuotes(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return;
  const draft = currentDraft();
  draft.quotes = [...quotes, ...(draft.quotes ?? [])].slice(0, QUOTE_LIMIT);
  renderQuoteChips();
}

function clearQuotes() {
  currentDraft().quotes = [];
  renderQuoteChips();
}

quoteChipRow = createQuoteChips({ host: $('.composer-area'), anchor: $('#composer'), onRemove: removeQuote });
renderQuoteChips();

// 聊天区、右侧文件视图、网页视图共用同一个事件与同一份 chip 仓库（§4.7）。
window.addEventListener('mova:quote-to-chat', event => { addQuote(event?.detail); });
window.movaQuotes = { add: detail => addQuote(detail), list: () => (currentDraft().quotes ?? []).slice(), clear: () => clearQuotes() };

// 聊天区选区浮层：只在 ChatMova / CodeMova 的对话区生效（MovaBot 会话不显示）。
bindChatQuoteSource({ isEnabled: () => activeArea === 'home', onQuote: detail => addQuote(detail) });

async function chooseModel(key) {  if (activeArea !== 'home') return;
  const entry = flatModels().find(item => item.key === key);
  if (!entry) { chatModelSelections.set(draftKey(), { key }); homeSelectedModel = key; saveWorkspace(); syncComposerModels(); return; }
  const conversationKey = draftKey();
  const previousSelection = chatModelSelections.get(conversationKey);
  const next = { providerId: entry.providerId, modelId: entry.model.id };
  chatModelSelections.set(conversationKey, next);
  saveWorkspace();
  const previous = providersState.active;
  providersState.active = { providerId: entry.providerId, modelId: entry.model.id };
  syncComposerModels();
  if (!providerBridge) return;
  try {
    const result = await providerBridge.setActive(next);
    if (!result.ok) throw new ModelConnectionError(result.error);
  } catch (error) {
    if (chatModelSelections.get(conversationKey) !== next) return;
    if (previousSelection) chatModelSelections.set(conversationKey, previousSelection);
    else chatModelSelections.delete(conversationKey);
    if (providersState.active?.providerId === next.providerId && providersState.active?.modelId === next.modelId) providersState.active = previous;
    saveWorkspace();
    syncComposerModels();
    chatFeedback(error instanceof ModelConnectionError ? error.message : '无法切换模型。');
  }
}

function unwrapBotIpc(res) {
  if (res && typeof res === 'object' && 'ok' in res) {
    if (!res.ok) throw new Error(res.message || res.error || 'Bot 操作失败');
    return res.value;
  }
  return res;
}

const desktopBotsBridge = window.movaDesktop?.bots || null;

function isGroupChat(chat) {
  return Boolean(chat && (chat.type === 'group' || (chat.type !== 'private' && Array.isArray(chat.members) && chat.members.length > 1)));
}

function extractBotMentions(content, chat) {
  const results = [];
  const memberIds = chat?.memberBotIds?.length ? chat.memberBotIds : bots.map(b => b.id);
  const regex = /@([^\s@#]+)(?:#([a-zA-Z0-9_-]{4,}))?/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const [, rawName, shortId] = match;
    const candidates = bots.filter(b => b.name === rawName && (!memberIds.length || memberIds.includes(b.id) || !isGroupChat(chat)));
    let picked = null;
    if (shortId) {
      picked = bots.find(b => b.id === shortId || b.id.endsWith(shortId));
    } else if (candidates.length === 1) {
      picked = candidates[0];
    } else if (candidates.length > 1) {
      picked = candidates[0];
    }
    if (picked) {
      results.push({ botId: picked.id, name: picked.name, token: match[0] });
    }
  }
  return results;
}

function insertMentionToken(candidate) {
  const textarea = composer?.root?.querySelector('textarea');
  if (!textarea || !candidate) return;
  const duplicates = bots.filter(b => b.name === candidate.name).length > 1;
  const tag = duplicates ? `@${candidate.name}#${String(candidate.id).slice(-6)} ` : `@${candidate.name} `;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = `${before}${before && !before.endsWith(' ') ? ' ' : ''}${tag}${after}`;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}

function normalizeDesktopChat(raw) {
  if (!raw) return null;
  const isGroup = raw.type === 'group';
  const memberBotIds = Array.isArray(raw.memberBotIds) && raw.memberBotIds.length
    ? raw.memberBotIds
    : (Array.isArray(raw.members)
      ? raw.members.map(m => (typeof m === 'string' ? (findBot(m) || findBotByName(m))?.id || m : m.memberId)).filter(id => id && id !== 'user')
      : []);
  const memberNames = memberBotIds.map(id => findBot(id)?.name || id);
  const bot = raw.botId ? findBot(raw.botId) : null;
  const messages = (raw.messages || [])
    .filter(m => m.visibility !== 'internal')
    .map(m => ({
      ...m,
      role: m.role || (m.senderType === 'user' ? 'user' : 'bot'),
      text: m.text ?? m.content ?? '',
      sender: m.sender ?? m.senderNameSnapshot ?? findBot(m.senderId)?.name ?? m.senderId,
      senderName: m.senderName ?? m.senderNameSnapshot ?? findBot(m.senderId)?.name ?? m.senderId,
    }));
  return {
    ...raw,
    type: isGroup ? 'group' : 'private',
    appearance: raw.appearance || bot?.appearance,
    memberBotIds: isGroup ? memberBotIds : undefined,
    members: isGroup ? memberNames : undefined,
    messages,
  };
}

function mergeDesktopConversation(conv) {
  const norm = normalizeDesktopChat(conv);
  if (!norm) return null;
  const idx = botChats.findIndex(c => c.id === norm.id);
  if (idx >= 0) botChats.splice(idx, 1, norm);
  else botChats.unshift(norm);
  return norm;
}

async function refreshDesktopBotConversation(conversationId) {
  if (!desktopBotsBridge?.getConversation) return;
  try {
    const conv = unwrapBotIpc(await desktopBotsBridge.getConversation(conversationId));
    if (conv) mergeDesktopConversation(conv);
    if (desktopBotsBridge.listApprovals) {
      const apps = unwrapBotIpc(await desktopBotsBridge.listApprovals({ status: 'pending' }));
      if (Array.isArray(apps)) botPendingApprovals = apps;
    }
    if (desktopBotsBridge.listTasks) {
      const tasks = unwrapBotIpc(await desktopBotsBridge.listTasks({ conversationId }));
      if (Array.isArray(tasks)) botTasksByConv.set(conversationId, tasks);
    }
    if (activeArea === 'messages') renderBotConversation();
  } catch { /* ignore transient refresh errors */ }
}

async function dispatchBotMessage(chat, userMsg) {
  if (desktopBotsBridge?.sendMessage) {
    try {
      await unwrapBotIpc(await desktopBotsBridge.sendMessage({
        conversationId: chat.id,
        content: userMsg.text,
        replyToMessageId: userMsg.replyToMessageId,
        mentions: userMsg.mentions,
      }));
      await refreshDesktopBotConversation(chat.id);
    } catch (err) {
      chat.messages.push({ id: `err-${++botSequence}`, role: 'bot', senderName: '系统提示', text: `发送失败：${err?.message || err}` });
      renderBotConversation();
    }
    return;
  }

  // 离线无桌面桥时提供本地可控协作回复兜底
  const text = userMsg.text;
  const lower = text.toLowerCase();
  let responder = chat.botId ? findBot(chat.botId) : null;
  if (!responder && userMsg.mentions?.length) responder = findBot(userMsg.mentions[0].botId);
  if (!responder && isGroupChat(chat)) {
    const firstId = chat.memberBotIds?.[0];
    responder = findBot(firstId) || findBotByName(chat.members?.[0]) || bots[0];
  }
  responder ??= bots[0];

  if (/生成小程序|制作.*清单|做一个.*应用|看板/.test(text)) {
    chat.messages.push({
      id: `message-${++botSequence}`,
      role: 'bot',
      senderId: responder.id,
      senderName: responder.name,
      sender: responder.name,
      text: `我已根据你的要求创建了交互式小程序视图（数据在本地沙箱独立保存）：`,
      structuredPayload: {
        type: 'mini_app_card',
        appId: 'app_trip_packer',
        name: '行前清单看板',
        version: '1.0.0',
        description: '支持新增清单项、切换完成状态和预算追踪。',
        quickRoutes: [
          { id: 'overview', title: '总览' },
          { id: 'checklist', title: '清单条目' },
          { id: 'budget', title: '预算' },
        ],
      },
    });
  } else if (/投票|共识|分歧|选方案|对比方案/.test(text)) {
    chat.messages.push({
      id: `message-${++botSequence}`,
      role: 'bot',
      senderId: responder.id,
      senderName: responder.name,
      sender: responder.name,
      text: '两位成员给出了不同侧重的建议，请通过下方共识卡拍板：',
      structuredPayload: {
        type: 'consensus_card',
        title: '执行方案投票',
        consensusPoints: ['优先保持现有数据结构兼容', '核心改动控制在可控范围内'],
        divergencePoints: ['方案 A 偏稳健增量迭代', '方案 B 一步重构界面模块'],
        question: '请选择接下来推进的方案：',
        options: [
          { id: 'opt_a', label: '方案 A：稳健增量推进' },
          { id: 'opt_b', label: '方案 B：同步重构界面' },
        ],
        recommendedOptionId: 'opt_a',
        status: 'open',
        taskDraft: { title: '按选定方案推进任务', goal: text },
      },
    });
  } else {
    chat.messages.push({
      id: `message-${++botSequence}`,
      role: 'bot',
      senderId: responder.id,
      senderName: responder.name,
      sender: responder.name,
      text: `收到！已记录「${text.slice(0, 48)}」。${responder.name} 会基于当前上下文继续协助推进。`,
    });
  }
  if (activeArea === 'messages') renderBotConversation();
}

const miniAppsRoot = createRoot($('#miniapps-view'));
const miniAppDrawerRoot = createRoot($('#miniapp-side-drawer'));

function renderMiniAppsPage() {
  miniAppsRoot.render(React.createElement(MiniAppsView, {
    active: activeArea === 'miniapps',
    bots: [...bots],
    focusedAppId: miniAppsFocusedId,
    focusedRoute: miniAppsFocusedRoute,
    onSelectApp: (appId, route = 'overview') => {
      miniAppsFocusedId = appId;
      miniAppsFocusedRoute = route;
      renderMiniAppsPage();
    },
    onOpenSideDrawer: (appId, route = 'overview') => openMiniAppSurface(appId, route, 'side'),
    onOpenConversation: convId => {
      if (botChats.some(c => c.id === convId)) {
        setActiveArea('messages');
        selectBot(convId);
      }
    },
    onNotify: notify,
  }));
}

function renderMiniAppDrawer() {
  const drawerEl = $('#miniapp-side-drawer');
  if (!drawerEl) return;
  const shouldShow = miniAppDrawerState.open && activeArea !== 'miniapps' && activeArea !== 'contacts' && activeArea !== 'forum';
  drawerEl.hidden = !shouldShow;
  if (!shouldShow) {
    miniAppDrawerRoot.render(null);
    return;
  }
  miniAppDrawerRoot.render(React.createElement(MiniAppSideDrawer, {
    open: true,
    appId: miniAppDrawerState.appId,
    route: miniAppDrawerState.route,
    bots: [...bots],
    onRouteChange: nextRoute => {
      miniAppDrawerState.route = nextRoute;
      renderMiniAppDrawer();
    },
    onOpenFullView: (appId, route) => openMiniAppSurface(appId, route, 'full'),
    onClose: () => {
      miniAppDrawerState.open = false;
      renderMiniAppDrawer();
    },
    onNotify: notify,
  }));
}

function openMiniAppSurface(appId, routeId = 'overview', mode = 'side') {
  if (!appId) return;
  if (mode === 'full') {
    miniAppsFocusedId = appId;
    miniAppsFocusedRoute = routeId || 'overview';
    miniAppDrawerState.open = false;
    renderMiniAppDrawer();
    setActiveArea('miniapps');
    return;
  }
  miniAppDrawerState.open = true;
  miniAppDrawerState.appId = appId;
  miniAppDrawerState.route = routeId || 'overview';
  if (activeArea === 'miniapps' || activeArea === 'contacts' || activeArea === 'forum') {
    setActiveArea('messages');
  } else {
    renderMiniAppDrawer();
  }
}

let botActivityRoot;
function renderBotActivity() {
  const entries = [];
  for (const [conversationId, live] of botStatusMap) {
    for (const bot of live.activeBots || []) {
      entries.push({ ...bot, conversationId, conversationTitle: botChats.find(chat => chat.id === conversationId)?.title });
    }
  }
  botActivityRoot ??= createRoot($('#bot-activity-host'));
  botActivityRoot.render(React.createElement(BotActivity, { entries, bots: [...bots] }));
}

function syncBotAimStatus() {
  // Bot progress has its own avatar popover, not the unrelated goal/plan panel.
  aimView?.setAim(null);
  renderBotActivity();
}

function renderBotConversation() {
  const chat = botChats.find(item => item.id === selectedBot);
  if (!chat) return;
  $('#welcome').hidden = true;
  $('#conversation').hidden = true;
  $('#composer-context').hidden = true;
  $('#bot-conversation').hidden = false;
  setChatHeaderVisible(true);
  $('#chat-fade').hidden = false;
  $('#chat-header-title').textContent = chat.title;
  // Bot 对话不是临时聊天：入口与标题后的灰字都不属于这里。
  renderChatPrivacy();
  const groupFlag = isGroupChat(chat);
  // 「⋯」在对话页是 Bot / 群聊信息入口，在主页是 Token 用量入口：文案跟着当前对象走。
  $('#chat-more').setAttribute('aria-label', groupFlag ? '群聊信息' : 'Bot 信息');
  $('#chat-more').setAttribute('title', groupFlag ? '群聊信息' : 'Bot 信息');
  $('#chat-more').setAttribute('aria-controls', 'bot-popover');
  $('.main-panel').classList.add('is-chatting');
  botConversationRoot.render(React.createElement(BotConversation, {
    chat,
    messages: [...chat.messages],
    appearance: chat.appearance || findBot(chat.botId)?.appearance,
    botName: groupFlag ? 'MovaBot' : chat.title,
    bots: [...bots],
    pendingApprovals: botPendingApprovals.filter(a => !a.conversationId || a.conversationId === chat.id),
    onVoteConsensus: async ({ messageId, selectedOptionId, confirmTask }) => {
      if (desktopBotsBridge?.voteConsensus) {
        await unwrapBotIpc(await desktopBotsBridge.voteConsensus({
          conversationId: chat.id,
          messageId,
          optionId: selectedOptionId,
          confirmTask,
        }));
        await refreshDesktopBotConversation(chat.id);
      } else {
        const msg = chat.messages.find(m => m.id === messageId);
        if (msg?.structuredPayload) {
          msg.structuredPayload = {
            ...msg.structuredPayload,
            selectedOptionId,
            status: confirmTask ? 'confirmed_as_task' : 'voted',
          };
          renderBotConversation();
        }
      }
      if (confirmTask) notify('已确认共识并创建对应可执行任务');
    },
    onOpenMiniApp: ({ appId, routeId, mode }) => openMiniAppSurface(appId, routeId, mode),
    onMentionBot: groupFlag ? bot => insertMentionToken(bot) : null,
    onAnswerQuestion: (message, answer) => {
      const userMsg = {
        id: `bot-answer-${++botSequence}`, role: 'user', text: answer,
        replyToMessageId: message.id,
        mentions: message.senderId ? [{ targetType: 'bot', targetId: message.senderId }] : [],
      };
      chat.messages.push(userMsg);
      renderBotConversation();
      void dispatchBotMessage(chat, userMsg);
    },
    onResolveApproval: async (approvalId, decision) => {
      if (desktopBotsBridge?.resolveApproval) {
        await unwrapBotIpc(await desktopBotsBridge.resolveApproval(approvalId, { decision }));
      }
      botPendingApprovals = botPendingApprovals.filter(a => a.id !== approvalId);
      renderBotConversation();
      if (desktopBotsBridge?.getConversation) await refreshDesktopBotConversation(chat.id);
    },
  }));
  const muted = new Set(botChats.filter(item => item.muted || findBot(item.botId)?.muted).map(item => item.id));
  botListRoot.render(React.createElement(BotList, {
    chats: [...botChats],
    selected: selectedBot,
    onSelect: selectBot,
    muted,
    appearanceOf: name => (findBot(name) || findBotByName(name))?.appearance,
    appearanceById: id => findBot(id)?.appearance,
  }));
  syncBotAimStatus(chat);
}

// ── Bot / 群聊信息浮层（「⋯」） ────────────────────────────────────────
function currentBotChat() {
  return botChats.find(chat => chat.id === selectedBot) ?? null;
}
function botPlaces() {
  const list = projects.map(project => ({ id: `project:${project.name}`, name: project.name, kind: 'project', ...(project.cloudOrigin ? { origin: project.cloudOrigin } : {}) }));
  return list.length ? list : [{ id: 'project:Mova', name: 'Mova', kind: 'project' }];
}
function botWorkspaceLocation() {
  const picker = window.movaDesktop?.projects?.pickFolders;
  return { cloud: cloudBridge, projects: botPlaces(), onAddHost: openRemoteHost,
    pickFolder: picker ? async onSelect => {
      try {
        const [folder] = await picker();
        if (folder) onSelect({ id: folder.id, kind: 'folder', name: folder.name });
      } catch (error) { notify(error.message, { tone: 'error' }); }
    } : undefined };
}
const botPopoverRoot = createRoot($('#bot-popover-inner'));
let botInfoView = null;
function syncBotPopover(flush) {
  const chat = currentBotChat();
  if (!chat) return;
  if (isGroupChat(chat) && desktopBotsBridge?.listMemories && !botGroupMemories.has(chat.id)) {
    desktopBotsBridge.listMemories({ ownerType: 'group', ownerId: chat.id }).then(res => {
      const rows = unwrapBotIpc(res);
      if (Array.isArray(rows)) {
        botGroupMemories.set(chat.id, rows);
        if (!$('#bot-popover').hidden && currentBotChat()?.id === chat.id) syncBotPopover(false);
      }
    }).catch(() => {});
  }
  const render = () => botPopoverRoot.render(React.createElement(isGroupChat(chat) ? GroupChatInfo : BotChatInfo, botInfoProps(chat)));
  if (flush) flushSync(render);
  else { render(); requestAnimationFrame(() => botInfoView?.resize()); }
}
function botInfoProps(chat) {
  if (isGroupChat(chat)) return {
    chat,
    bots: [...bots],
    groupMemories: botGroupMemories.get(chat.id) || [],
    onPickPlace: (current, apply) => openPlaceDialog({ value: current, onSelect: apply }),
    onMentionBot: bot => {
      botInfoView?.hide();
      insertMentionToken(bot);
    },
    onRename: async name => {
      chat.title = name;
      renderBotConversation();
      syncBotPopover();
      if (desktopBotsBridge?.updateMeta) await desktopBotsBridge.updateMeta(chat.id, { title: name }).catch(() => {});
      notify(`群聊已改名为「${name}」`);
    },
    onPlace: async place => {
      try { if (desktopBotsBridge?.updateMeta) unwrapBotIpc(await desktopBotsBridge.updateMeta(chat.id, { place: place ?? null })); }
      catch (error) { notify(error.message, { tone: 'error' }); return; }
      chat.place = place ?? null;
      syncBotPopover();
    },
    onMute: async muted => {
      chat.muted = muted;
      renderBotConversation();
      syncBotPopover();
      if (desktopBotsBridge?.updateMeta) await desktopBotsBridge.updateMeta(chat.id, { muted }).catch(() => {});
      notify(muted ? `已把「${chat.title}」设为免打扰` : `已取消「${chat.title}」的免打扰`);
    },
    onSetGroupMode: async mode => {
      chat.groupMode = mode;
      renderBotConversation();
      syncBotPopover();
      if (desktopBotsBridge?.setGroupMode) await desktopBotsBridge.setGroupMode(chat.id, mode).catch(() => {});
      notify(`群聊模式已更新`);
    },
    onAddMember: async botId => {
      const target = findBot(botId);
      if (!target) return;
      chat.memberBotIds = [...new Set([...(chat.memberBotIds || []), botId])];
      chat.members = chat.memberBotIds.map(id => findBot(id)?.name || id);
      renderBotConversation();
      syncBotPopover();
      if (desktopBotsBridge?.addMembers) await desktopBotsBridge.addMembers(chat.id, [botId]).catch(() => {});
      notify(`已将「${target.name}」加入群聊`);
    },
    onRemoveMember: async botId => {
      const target = findBot(botId);
      chat.memberBotIds = (chat.memberBotIds || []).filter(id => id !== botId);
      chat.members = chat.memberBotIds.map(id => findBot(id)?.name).filter(Boolean);
      renderBotConversation();
      syncBotPopover();
      if (desktopBotsBridge?.removeMember) await desktopBotsBridge.removeMember(chat.id, botId).catch(() => {});
      notify(`已将「${target?.name || botId}」移出群聊（保留历史消息，不再接收新群记忆）`);
    },
    onAddGroupMemory: async content => {
      const entry = desktopBotsBridge?.saveGroupMemory
        ? unwrapBotIpc(await desktopBotsBridge.saveGroupMemory({ conversationId: chat.id, category: 'fact', content }))
        : { id: `gmem-${Date.now()}`, content, category: 'fact', createdAt: Date.now() };
      const list = [...(botGroupMemories.get(chat.id) || []), entry];
      botGroupMemories.set(chat.id, list);
      syncBotPopover();
      notify('已写入群共享记忆');
    },
    onDelete: () => {
      botInfoView?.hide();
      void confirmGroupDelete(chat);
    },
  };
  const bot = findBot(chat.botId) ?? { name: chat.title, appearance: chat.appearance };
  return {
    bot,
    chat,
    tasks: botTasksByConv.get(chat.id) || [],
    onMute: async muted => {
      bot.muted = muted;
      renderBotConversation();
      syncBotPopover();
      if (bot.id && desktopBotsBridge?.update) await desktopBotsBridge.update(bot.id, { muted }).catch(() => {});
      notify(muted ? `已开启「${bot.name}」的免打扰` : `已关闭「${bot.name}」的免打扰`);
    },
    onNewTopic: botId => {
      botInfoView?.hide();
      void startNewBotTopic(botId || bot.id);
    },
    onTaskControl: async (taskId, nextStatus) => {
      if (desktopBotsBridge?.transitionTask) {
        await desktopBotsBridge.transitionTask(taskId, nextStatus).catch(() => {});
        await refreshDesktopBotConversation(chat.id);
        syncBotPopover();
      }
    },
    onOpenProfile: () => {
      botInfoView?.hide();
      if (!bot.id) return;
      selectedContact = bot.id;
      setActiveArea('contacts');
    },
  };
}
// 删除群聊：先用规范里的确认弹窗说明影响，确认后再删。
async function confirmGroupDelete(chat) {
  const count = chat.messages.length;
  const confirmed = await confirmAction({
    title: `删除「${chat.title}」？`,
    body: '删除后无法恢复。',
    detail: `群聊和其中的 ${count} 条消息会永久删除。成员 Bot 本身、它们与你的私聊、以及其它群聊都不受影响。`,
    confirmLabel: '删除群聊',
    tone: 'danger',
  });
  if (confirmed) deleteGroupChat(chat);
}
function deleteGroupChat(chat) {
  const index = botChats.indexOf(chat);
  if (index < 0) return;
  botChats.splice(index, 1);
  botInfoView?.hide();
  if (selectedBot === chat.id) selectedBot = botChats[0]?.id ?? '';
  renderBotConversation();
  if (desktopBotsBridge?.deleteConversation) desktopBotsBridge.deleteConversation(chat.id).catch(() => {});
  notify(`已删除群聊「${chat.title}」`);
}
botInfoView = bindMorphPopover({
  trigger: $('#chat-more'),
  panel: $('#bot-popover'),
  host: $('.main-panel'),
  width: 248,
  canOpen: () => activeArea === 'messages' && Boolean(currentBotChat()),
  onOpen: () => syncBotPopover(true),
});

function selectBot(id) {
  selectedBot = id;
  const chat = botChats.find(item => item.id === id);
  if (chat) chat.unread = 0;
  botInfoView?.hide();
  restoreDraft();
  if (desktopBotsBridge?.markRead) desktopBotsBridge.markRead(id).catch(() => {});
  if (matchMedia('(max-width:620px)').matches) toggleSidebar(false);
}

// ── 新建群聊（Bot 列表右上角的加号） ──────────────────────────────────
const groupDialogRoot = createRoot($('#group-dialog-root'));
let groupSequence = 0;
function openGroupDialog() {
  const dialog = $('#group-dialog');
  if (dialog.open) { dialog.close(); return; }
  botInfoView?.hide();
  flushSync(() => groupDialogRoot.render(React.createElement(GroupBuilder, {
    bots: [...bots],
    location: botWorkspaceLocation(),
    onCancel: () => dialog.close(),
    onCreate: payload => { dialog.close(); void createGroupChat(payload); },
  })));
  dialog.showModal();
  const form = dialog.querySelector('.group-dialog-form');
  if (form && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const opening = form.animate([
      { opacity: 0, transform: 'scale(.93) translateY(8px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 320, easing: 'cubic-bezier(.2, 1.22, .35, 1)', fill: 'both' });
    opening.addEventListener('finish', () => opening.cancel(), { once: true });
  }
}
async function createGroupChat({ name, members, place, color, groupMode = 'natural', topic = '' }) {
  const memberBotIds = [...members];
  const names = memberBotIds.map(botId => findBot(botId)?.name).filter(Boolean);
  if (names.length < 2) return;
  if (place?.origin) {
    try {
      const persisted = unwrapBotIpc(await desktopBotsBridge.createGroupChat({ title: name, topic, groupMode, memberBotIds, color, place }));
      const chat = mergeDesktopConversation(persisted);
      if (!chat) throw new Error('云端群聊未能保存');
      setActiveArea('messages');
      selectBot(chat.id);
      notify(`已创建群聊「${name}」`);
    } catch (error) { notify(error.message, { tone: 'error' }); }
    return;
  }
  const id = `group-${Date.now().toString(36)}-${++groupSequence}`;
  const chat = {
    id,
    type: 'group',
    title: name,
    topic,
    groupMode,
    memberBotIds,
    members: names,
    color,
    place: place ?? undefined,
    muted: false,
    unread: 0,
    createdAt: Date.now(),
    messages: [{ id: `${id}-welcome`, role: 'bot', senderId: memberBotIds[0], sender: names[0], text: `「${name}」建好了，${names.join('、')} 都在这里。` }],
  };
  botChats.unshift(chat);
  selectedBot = id;
  setActiveArea('messages');
  selectBot(id);
  notify(`已创建群聊「${name}」`);
  if (desktopBotsBridge?.createGroupChat) {
    try {
      const persisted = unwrapBotIpc(await desktopBotsBridge.createGroupChat({ title: name, topic, groupMode, memberBotIds, color, place }));
      if (persisted?.id) {
        const idx = botChats.indexOf(chat);
        const normalized = normalizeDesktopChat(persisted);
        if (idx >= 0) botChats.splice(idx, 1, normalized);
        selectedBot = normalized.id;
        renderBotConversation();
      }
    } catch { /* 保持本地创建状态 */ }
  }
}
$('#group-dialog').addEventListener('close', () => groupDialogRoot.render(null));
$('#group-dialog').addEventListener('click', event => { if (event.target === $('#group-dialog')) $('#group-dialog').close(); });

// ── 选择工作位置（弹窗） ──────────────────────────────────────────────
const placeDialogRoot = createRoot($('#place-dialog-root'));
function openPlaceDialog({ value, onSelect }) {
  const dialog = $('#place-dialog');
  if (dialog.open) return;
  flushSync(() => placeDialogRoot.render(React.createElement(PlacePicker, {
    location: botWorkspaceLocation(),
    value,
    onCancel: () => dialog.close(),
    onSelect: place => { dialog.close(); onSelect(place ?? null); },
  })));
  dialog.showModal();
  const panel = dialog.querySelector('.place-dialog-panel');
  if (panel && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const opening = panel.animate([
      { opacity: 0, transform: 'scale(.93) translateY(8px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 320, easing: 'cubic-bezier(.2, 1.22, .35, 1)', fill: 'both' });
    opening.addEventListener('finish', () => opening.cancel(), { once: true });
  }
}
$('#place-dialog').addEventListener('close', () => placeDialogRoot.render(null));
$('#place-dialog').addEventListener('click', event => { if (event.target === $('#place-dialog')) $('#place-dialog').close(); });

// ── 通讯录 ────────────────────────────────────────────────────────────
const contactsRoot = createRoot($('#contacts-view'));
let contactsInitialized = false;
async function startNewBotTopic(botId, topicLabel = null) {
  const bot = findBot(botId);
  if (!bot) return;
  const topic = topicLabel || `新话题 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  let chat;
  if (desktopBotsBridge?.createPrivateChat) {
    try {
      const created = unwrapBotIpc(await desktopBotsBridge.createPrivateChat({ botId: bot.id, topic }));
      if (created) chat = mergeDesktopConversation(created);
    } catch { /* fallback locally */ }
  }
  if (!chat) {
    const id = ++botSequence;
    chat = {
      id: `bot-chat-${id}`,
      type: 'private',
      botId: bot.id,
      title: `${bot.name} · ${topic}`,
      topic,
      appearance: bot.appearance,
      muted: Boolean(bot.muted),
      unread: 0,
      createdAt: Date.now(),
      messages: [{ id: `welcome-${id}`, role: 'bot', senderId: bot.id, senderName: bot.name, text: `围绕「${topic}」开启了新话题，请说你的想法。` }],
    };
    botChats.unshift(chat);
  }
  selectedBot = chat.id;
  setActiveArea('messages');
  selectBot(chat.id);
}

function renderContacts() {
  contactsRoot.render(React.createElement(Contacts, {
    active: activeArea === 'contacts',
    bots: [...bots],
    chats: [...botChats],
    selectedId: selectedContact,
    onSelect: id => { selectedContact = id; renderContacts(); },
    onCreate: anchor => openBotBuilder(anchor),
    onOpenChat: id => { setActiveArea('messages'); selectBot(id); },
    onMessage: id => {
      const bot = findBot(id);
      if (!bot) return;
      let chat = botChats.find(item => item.botId === id);
      if (!chat) {
        chat = botChatFor(bot);
        botChats.unshift(chat);
      }
      setActiveArea('messages');
      selectBot(chat.id);
    },
    onNewTopic: id => void startNewBotTopic(id),
    onUpdate: (id, patch) => {
      const bot = updateBotConfig(id, patch);
      if (!bot) return;
      if ('muted' in patch) notify(patch.muted ? `已开启「${bot.name}」的免打扰` : `已关闭「${bot.name}」的免打扰`);
      if ('description' in patch) notify('个人介绍已更新');
      if (desktopBotsBridge?.update) desktopBotsBridge.update(id, patch).catch(() => {});
      renderContacts();
      if (activeArea === 'messages') renderBotConversation();
    },
    onRename: async (id, newName) => {
      const bot = renameBot(id, newName);
      if (!bot) return;
      for (const chat of botChats) {
        if (chat.botId === id) {
          chat.title = chat.topic && chat.title.includes('·') ? `${bot.name} · ${chat.topic}` : bot.name;
        } else if (isGroupChat(chat) && chat.memberBotIds?.includes(id)) {
          chat.members = chat.memberBotIds.map(mid => findBot(mid)?.name || mid);
        }
      }
      if (desktopBotsBridge?.rename) await desktopBotsBridge.rename(id, newName).catch(() => {});
      renderContacts();
      if (activeArea === 'messages') renderBotConversation();
      notify(`已重命名为「${bot.name}」，历史对话与群聊关联均保持不变`);
    },
    onClone: async id => {
      let cloned = cloneBot(id);
      if (desktopBotsBridge?.clone) {
        try {
          const remote = unwrapBotIpc(await desktopBotsBridge.clone(id));
          if (remote?.id) {
            const idx = bots.indexOf(cloned);
            if (idx >= 0) bots[idx].id = remote.id;
          }
        } catch { /* 保持本地克隆 */ }
      }
      if (!cloned) return;
      selectedContact = cloned.id;
      renderContacts();
      notify(`已克隆 Bot「${cloned.name}」`);
    },
    onExport: id => {
      const json = exportBotConfig(id);
      const bot = findBot(id);
      if (!json || !bot) return;
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${bot.name}-bot-config.json`;
      link.click();
      URL.revokeObjectURL(url);
      notify(`已导出「${bot.name}」配置 JSON`);
    },
    onImport: async jsonText => {
      try {
        const imported = importBotConfig(jsonText);
        if (desktopBotsBridge?.importBot) {
          const remote = unwrapBotIpc(await desktopBotsBridge.importBot(jsonText));
          if (remote?.id) imported.id = remote.id;
        }
        selectedContact = imported.id;
        renderContacts();
        notify(`已导入 Bot「${imported.name}」`);
      } catch (err) {
        notify(err?.message || '导入 Bot JSON 失败', { tone: 'error' });
      }
    },
    onDelete: (id, opts = {}) => {
      const bot = findBot(id);
      if (!bot || bot.builtin) return;
      deleteBot(bot, botChats, opts);
      if (!botChats.some(chat => chat.id === selectedBot)) selectedBot = botChats[0]?.id;
      selectedContact = bots[0]?.id;
      if (desktopBotsBridge?.delete) desktopBotsBridge.delete(id, opts).catch(() => {});
      notify(`已删除 Bot「${bot.name}」`);
      $('#sidebar-announcement').textContent = `已删除 Bot：${bot.name}`;
      renderContacts();
    },
  }));
}
function botChatFor(bot) {
  const id = ++botSequence;
  return { id: `bot-chat-${id}`, type: 'private', botId: bot.id, title: bot.name, appearance: bot.appearance, muted: false, unread: 0, createdAt: Date.now(), messages: [{ id: `welcome-${id}`, role: 'bot', senderId: bot.id, senderName: bot.name, text: bot.description || `你好，我是${bot.name}。我们从哪里开始？` }] };
}

function setActiveArea(area) {
  if (area !== 'messages') botInfoView?.hide();
  // 两个头部浮层只属于主页对话：切到消息 / 社区 / 通讯录 / 小程序时先收起，避免浮在别的页面上。
  if (area !== 'home') { usageView?.close(); if (area !== 'messages') aimView?.close(); }
  activeArea = area;
  syncInteractionContext();
  const showingBots = area === 'messages';
  const showingForum = area === 'forum';
  const showingContacts = area === 'contacts';
  const showingMiniApps = area === 'miniapps';
  $('.window-shell').classList.toggle('forum-active', showingForum);
  $('.content-frame').classList.toggle('forum-mode', showingForum);
  $('#forum-view').hidden = !showingForum;
  if (showingForum) forumInitialized = true;
  if (forumInitialized) forumRoot.render(React.createElement(Forum, { active: showingForum }));
  $('.window-shell').classList.toggle('contacts-active', showingContacts);
  $('.content-frame').classList.toggle('contacts-mode', showingContacts);
  $('#contacts-view').hidden = !showingContacts;
  if (showingContacts) contactsInitialized = true;
  if (contactsInitialized) renderContacts();
  $('.window-shell').classList.toggle('miniapps-active', showingMiniApps);
  $('.content-frame').classList.toggle('miniapps-mode', showingMiniApps);
  $('#miniapps-view').hidden = !showingMiniApps;
  if (showingMiniApps) miniAppsInitialized = true;
  if (miniAppsInitialized) renderMiniAppsPage();
  renderMiniAppDrawer();
  composer.element.dataset.botMode = String(showingBots);
  syncComposerModels();
  $('.project-sidebar').classList.toggle('bot-mode', showingBots);
  $('.main-panel').classList.toggle('bot-view', showingBots);
  $('#bot-sidebar').hidden = !showingBots;
  $('#bot-conversation').hidden = !showingBots;
  $('#home-button').classList.toggle('selected', area === 'home');
  $('#messages-button').classList.toggle('selected', showingBots);
  $('#forum-button').classList.toggle('selected', showingForum);
  $('#contacts-button').classList.toggle('selected', showingContacts);
  $('#miniapps-button')?.classList.toggle('selected', showingMiniApps);
  for (const [id, selected] of [
    ['home-button', area === 'home'],
    ['messages-button', showingBots],
    ['contacts-button', showingContacts],
    ['miniapps-button', showingMiniApps],
    ['forum-button', showingForum],
  ]) {
    const btn = $(`#${id}`);
    if (!btn) continue;
    if (selected) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  }
  // 回到主页时「⋯」是 Token 用量入口，把对话页改过的文案还原。
  if (!showingBots) {
    $('#chat-more').setAttribute('aria-label', 'Token 用量');
    $('#chat-more').setAttribute('title', 'Token 用量');
    $('#chat-more').setAttribute('aria-controls', 'chat-usage');
  }
  $('#bot-notice').hidden = true;
  $('#bot-notifications').setAttribute('aria-expanded', 'false');
  renderChatFeedback();
  syncComposerBusy();
  renderChatPrivacy();
  if (showingBots) { toggleSidebar(true); restoreDraft(); }
  else if (!showingForum && !showingContacts && !showingMiniApps) { botConversationRoot.render(null); restoreDraft(); }
  else { botConversationRoot.render(null); if ($('#bot-builder-dialog').open) $('#bot-builder-dialog').close(); }
}

botListRoot = createRoot($('#bot-list'));
botConversationRoot = createRoot($('#bot-conversation'));
const forumRoot = createRoot($('#forum-view'));
let forumInitialized = false;
$('#contacts-button').addEventListener('click', () => { closeSettings(); hidePeekNow(); setActiveArea('contacts'); });
$('#miniapps-button')?.addEventListener('click', () => { closeSettings(); hidePeekNow(); setActiveArea('miniapps'); });
$('#messages-button').addEventListener('click', () => { closeSettings(); setActiveArea('messages'); });
$('#forum-button').addEventListener('click', () => { closeSettings(); hidePeekNow(); setActiveArea('forum'); });
$('#bot-notifications').addEventListener('click', () => {
  const show = $('#bot-notice').hidden;
  $('#bot-notice').hidden = !show;
  $('#bot-notifications').setAttribute('aria-expanded', String(show));
});
// 创建 Bot 的浮层可以从「通讯录」的加号打开，定位与焦点都跟随触发按钮。
let botBuilderAnchor = $('#bot-add');
$('#bot-add').addEventListener('click', () => openGroupDialog());
function openBotBuilder(anchor) {
  if ($('#bot-builder-dialog').open) { $('#bot-builder-dialog').close(); return; }
  botBuilderAnchor = anchor;
  botBuilderRoot.render(React.createElement(BotBuilder, {
    onCancel: () => $('#bot-builder-dialog').close(),
    onCreate: async payload => {
      // 允许同名 Bot，不因 name 相同拦截创建，系统通过唯一 ID 区分
      const { creationMode, templateId, promptText, name, ...rest } = payload;
      const bot = creationMode === 'nl'
        ? createBotFromNaturalLanguage(promptText, { name, ...rest })
        : creationMode === 'template'
          ? createBotFromTemplate(templateId, { name, ...rest })
          : createBot({ name, ...rest });

      if (desktopBotsBridge) {
        try {
          let remote = null;
          if (creationMode === 'nl' && desktopBotsBridge.createFromNaturalLanguage) {
            remote = unwrapBotIpc(await desktopBotsBridge.createFromNaturalLanguage(promptText, { name, ...rest }));
          } else if (creationMode === 'template' && desktopBotsBridge.createFromTemplate) {
            remote = unwrapBotIpc(await desktopBotsBridge.createFromTemplate(templateId, { name, ...rest }));
          } else if (desktopBotsBridge.create) {
            remote = unwrapBotIpc(await desktopBotsBridge.create({ name, ...rest }));
          }
          if (remote?.id) bot.id = remote.id;
        } catch { /* 保留本地创建记录 */ }
      }

      const chat = botChatFor(bot);
      botChats.unshift(chat);
      $('#bot-builder-dialog').close();
      $('#sidebar-announcement').textContent = `已创建 Bot：${bot.name}`;
      if (activeArea === 'contacts') { selectedContact = bot.id; renderContacts(); notify(`已创建 Bot「${bot.name}」`); }
      else selectBot(chat.id);
    },
  }));
  $('#bot-builder-dialog').show();
  botBuilderAnchor.setAttribute('aria-expanded', 'true');
  positionBotBuilder();
  requestAnimationFrame(positionBotBuilder);
}
const botBuilderRoot = createRoot($('#bot-builder-root'));
function positionBotBuilder() {
  const dialog = $('#bot-builder-dialog');
  if (!dialog.open) return;
  const anchor = botBuilderAnchor.getBoundingClientRect();
  const width = dialog.getBoundingClientRect().width;
  const left = anchor.right + 8 + width <= window.innerWidth - 8 ? anchor.right + 8 : Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  dialog.style.left = `${left}px`;
  dialog.style.top = `${Math.min(Math.max(8, anchor.top), Math.max(8, window.innerHeight - dialog.offsetHeight - 8))}px`;
}
$('#bot-builder-dialog').addEventListener('close', () => { botBuilderRoot.render(null); botBuilderAnchor.setAttribute('aria-expanded', 'false'); if (botBuilderAnchor.getClientRects().length) botBuilderAnchor.focus(); });
document.addEventListener('pointerdown', event => { if ($('#bot-builder-dialog').open && !$('#bot-builder-dialog').contains(event.target) && !botBuilderAnchor.contains(event.target)) $('#bot-builder-dialog').close(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('#bot-builder-dialog').open) { event.preventDefault(); $('#bot-builder-dialog').close(); } });
window.addEventListener('resize', positionBotBuilder);
new ResizeObserver(positionBotBuilder).observe($('#bot-builder-dialog'));
// The original NX_emotion-ball engine renders and animates the companion.
// Keep the initial state at 02 (idle); no simulated project-status transitions.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const companion = EmotionBall.create($('#emotion-ball'), {
  emotion: '02', shape: 'blob', eyeScale: 1.65, lite: true,
  idle: false, autostart: !reducedMotion.matches,
});
const syncAnimation = () => companion.setActive(!document.hidden && !reducedMotion.matches);
document.addEventListener('visibilitychange', syncAnimation);
reducedMotion.addEventListener('change', syncAnimation);
document.addEventListener('pointermove', e => {
  if (reducedMotion.matches) return;
  const rect = $('#emotion-ball').getBoundingClientRect();
  companion.setGaze(Math.max(-1, Math.min(1, (e.clientX - rect.x - rect.width / 2) / 380)), Math.max(-1, Math.min(1, (e.clientY - rect.y - rect.height / 2) / 380)));
});
// Future project integration: window.movaCompanion.setEmotion('30'), or handleAIMessage(...).
window.movaCompanion = companion;
/* 临时聊天：只对新聊天开放，点一次给下一条消息用，发送后开关消失、只留灰字标记。 */
$('#chat-temporary-toggle').addEventListener('click', () => {
  if (selectedChat) return;
  temporaryNextChat = !temporaryNextChat;
  renderChatPrivacy();
  if (temporaryNextChat) {
    chatFeedback('这条新聊天是临时聊天：不保存会话和图片，不提取也不读取记忆。');
    $('#sidebar-announcement').textContent = '已开启临时聊天';
  } else {
    chatFeedback();
    $('#sidebar-announcement').textContent = '已关闭临时聊天';
  }
});
async function initializeMemory() {
  if (!memoryBridge) return;
  chatFeedback('正在启动本地记忆服务（首次启动可能需要下载模型或等待 Docker）…');
  try {
    const result = await memoryBridge.read();
    if (!result.ok) throw new Error(result.error);
    memorySettings = result.value.settings;
    let snapshot = result.value.sessions;
    if (memoryBridge.syncSessions) {
      const synced = await memoryBridge.syncSessions();
      if (!synced.ok) throw new Error(synced.error);
      sessionRevision = acceptedSessionRevision = synced.value.revision;
      snapshot = synced.value.sessions;
    }
    // A nonempty store is authoritative even when its history was deliberately cleared;
    // only a brand-new store keeps the built-in design samples.
    if (snapshot?.version === 1 && (snapshot.projects?.length || result.value.storage?.bytes > 0)) {
      projects.splice(0, projects.length, ...snapshot.projects);
      conversations.clear();
      for (const [key, turns] of snapshot.conversations ?? []) {
        if (typeof key !== 'string' || !Array.isArray(turns)) continue;
        for (const turn of turns) {
          if (!turn || typeof turn !== 'object') continue;
          turn.id ??= `msg-${crypto.randomUUID()}`;
          turn.at ??= conversationStart(key);
          if (!isEdge && sessionRevision === 0 && turn.reply?.status === 'streaming') { turn.reply.status = 'interrupted'; settleSearchRows(turn.reply.timeline, '上次搜索已中断'); settleToolRows(turn.reply.timeline, '上次操作已中断'); }
        }
        conversations.set(key, turns);
      }
      if (!projects.some(project => project.name === selectedProject)) selectedProject = projects[0]?.name ?? 'Mova';
      selectedChat = '';
      for (const [map, rows] of [[chatAims, snapshot.aims], [chatUsage, snapshot.usage], [chatPermissionPresets, snapshot.permissionPresets], [chatModelSelections, snapshot.modelSelections]]) {
        map.clear();
        for (const [key, value] of rows || []) map.set(key, value);
      }
    }
    for (const turns of conversations.values()) for (const turn of turns) turn.id ??= `msg-${crypto.randomUUID()}`;
    memoryReady = true;
    // One-time migration: disk becomes authoritative; do not keep a second editable copy.
    if (!isEdge) {
      const saved = await persistSessions();
      if (!saved.ok) throw new Error(saved.error);
    }
    localStorage.removeItem(STORAGE_KEY);
    chatFeedback();
    renderSyncedSessions();
  } catch (error) {
    memoryReady = false;
    chatFeedback(`无法载入或保存本地记忆与会话存储：${error.message}。已阻止发送和覆盖，请先检查或备份数据。`);
  }
}
function renderSyncedSessions() {
  memoryReady = false;
  try { renderProjects($('#project-search').value); renderConversation(); }
  finally { memoryReady = true; }
}
async function syncWorkspace() {
  if (!memoryReady || !memoryBridge?.syncSessions || activeReplies.size || saveTimer !== undefined || pendingSaves || syncingSessions) return;
  syncingSessions = true;
  const generation = saveGeneration;
  // 请求期间任何本地变更都会让这份响应变成旧快照，回来时必须整份丢弃。
  const epoch = workspaceEpoch;
  try {
    const response = await memoryBridge.syncSessions(sessionRevision);
    if (!response.ok || !response.value.sessions || generation !== saveGeneration || activeReplies.size || saveTimer !== undefined) return;
    if (epoch !== workspaceEpoch || pendingSaves > 0) return;
    const { sessions, revision } = response.value;
    sessionRevision = acceptedSessionRevision = revision;
    projects.splice(0, projects.length, ...sessions.projects);
    for (const [map, rows] of [[conversations, sessions.conversations], [chatAims, sessions.aims], [chatUsage, sessions.usage], [chatPermissionPresets, sessions.permissionPresets], [chatModelSelections, sessions.modelSelections]]) {
      for (const key of map.keys()) if (!temporaryConversations.has(key)) map.delete(key);
      for (const [key, value] of rows || []) {
        if (temporaryConversations.has(key)) continue;
        // 用量是累加出来的：服务端副本比本地旧（少了几次调用）时保留本地总数，
        // 避免刚统计到的数字被一次轮询回滚。
        const local = map === chatUsage ? map.get(key) : null;
        if (local && (Number(local.calls) || 0) > (Number(value.calls) || 0)) continue;
        map.set(key, value);
      }
    }
    if (!projects.some(project => project.name === selectedProject)) selectedProject = projects[0]?.name ?? 'Mova';
    if (selectedChat && !conversations.has(draftKey())) selectedChat = '';
    renderSyncedSessions();
    composer.update({ draft: currentDraft() });
    renderQuoteChips();
  } catch { /* A transient disconnect is retried on the next poll. */ }
  finally { syncingSessions = false; }
}
function renderEdgeChats() {
  const list = $('#edge-chats');
  list.replaceChildren();
  const chats = projects.flatMap(project => project.chats
    .filter(chat => chat.mode === 'ChatMova' && !chat.archived)
    .map(chat => ({ project: project.name, ...chat })))
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  for (const chat of chats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = chat.title;
    button.title = chat.title;
    if (chat.project === selectedProject && chat.title === selectedChat) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => {
      $('#edge-chat-menu').hidePopover();
      selectProject(chat.project, chat.title);
    });
    list.append(button);
  }
}
if (isEdge) {
  $('#edge-avatar').append($('.companion'));
  $('#welcome h1').replaceChildren('今天想聊些什么？', $('#welcome-project'));
  $('#edge-new-chat').addEventListener('click', () => {
    $('#edge-chat-menu').hidePopover();
    newChat();
  });
}
if (window.movaDesktop?.edge?.pair) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '连接 Edge';
  button.addEventListener('click', () => { void window.movaDesktop.edge.pair(); });
  $('.app-menu').append(button);
}
if (memoryBridge?.syncSessions) setInterval(() => void syncWorkspace(), 2000);
renderProjects();
renderConversation();
void loadProviders().then(renderChatPrivacy);

/* 订阅账号变化（登录成功 / 退出 / 切号）后必须重读 provider 列表：
   订阅 provider 的 `models` 与「算不算配置完成」都来自主进程侧的账号快照，
   不重读的话，用户刚登录完回到聊天页，右下角的模型菜单还是登录前那份（空的）。 */
window.movaDesktop?.subscription?.onEvent?.(payload => {
  const kind = payload?.kind;
  if (kind === 'accounts' || kind === 'login' || kind === 'selection') void loadProviders();
});
/**
 * 收掉启动动画覆盖层（index.html 的 #boot-splash，里面是我们的动画 iframe）。
 *
 * 三条硬约束：
 * 1. **只揭一次**：重复调用要无副作用（首屏准备可能被重试/多路径触发）。
 * 2. **最短播放时间**：动画至少播 1.8 秒，否则在快机器上一帧就没了，看着像闪屏。
 * 3. **兜底**：不管初始化成功还是失败都要揭幕（失败时界面里已经有错误提示，
 *    把用户永远挡在动画后面比看到报错更糟）。
 */
const BOOT_SPLASH_MIN_MS = 1800;
let bootSplashHidden = false;
function hideBootSplash() {
  if (bootSplashHidden) return;
  bootSplashHidden = true;
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  // performance.now() 的原点就是 navigationStart，所以这里直接就是「已经过了多久」。
  const remaining = Math.max(0, BOOT_SPLASH_MIN_MS - performance.now());
  setTimeout(() => {
    splash.classList.add('is-done');
    // 淡出结束再整块移除：留着会让 iframe 里的 rAF 一直空转。
    setTimeout(() => splash.remove(), 300);
  }, remaining);
}
async function hydrateBotsAndChatsFromDesktop() {
  if (!desktopBotsBridge) return;
  try {
    const botList = unwrapBotIpc(await desktopBotsBridge.list({ includeArchived: true }));
    if (Array.isArray(botList) && botList.length) syncBotsFromDesktop(botList);
    const convs = unwrapBotIpc(await desktopBotsBridge.listConversations({ filter: 'all' }));
    if (Array.isArray(convs) && convs.length) {
      botChats.length = 0;
      for (const c of convs) botChats.push(normalizeDesktopChat(c));
      if (!botChats.some(c => c.id === selectedBot)) selectedBot = botChats[0]?.id || 'mova';
    }
    if (desktopBotsBridge.listApprovals) {
      const approvals = unwrapBotIpc(await desktopBotsBridge.listApprovals({ status: 'pending' }));
      if (Array.isArray(approvals)) botPendingApprovals = approvals;
    }
    if (activeArea === 'messages') renderBotConversation();
    if (activeArea === 'contacts' && contactsInitialized) renderContacts();
  } catch { /* 保持本地默认预览数据 */ }
}

if (desktopBotsBridge?.onEvent) {
  desktopBotsBridge.onEvent(evt => {
    if (!evt) return;
    if (evt.type === 'navigate:conversation') {
      setActiveArea('messages');
      const targetId = evt.conversationId || selectedBot;
      if (!targetId) return;
      if (botChats.some(item => item.id === targetId)) {
        selectBot(targetId);
        renderBotConversation();
        void refreshDesktopBotConversation(targetId);
      } else {
        void refreshDesktopBotConversation(targetId).then(() => {
          selectBot(targetId);
          renderBotConversation();
        });
      }
      return;
    }
    if ((evt.type === 'bot:status' || evt.type === 'bot-status') && evt.conversationId) {
      const running = evt.type === 'bot:status' ? Boolean(evt.active) : evt.status === 'running';
      const statusText = evt.type === 'bot:status' ? (evt.primaryText || '正在处理协作任务') : evt.text;
      if (running) {
        botStatusMap.set(evt.conversationId, { status: 'running', text: statusText, activeBots: evt.activeBots || [] });
      } else {
        botStatusMap.delete(evt.conversationId);
      }
      renderBotActivity();
      return;
    }
    if (
      evt.type === 'conversation:updated'
      || evt.type === 'task:proactive-sent'
      || evt.type === 'message-added'
      || evt.type === 'run-completed'
      || evt.type === 'approval-requested'
      || evt.type === 'task-updated'
    ) {
      if (evt.conversationId) void refreshDesktopBotConversation(evt.conversationId);
    }
    if (evt.type === 'scheduler:recovered') {
      void hydrateBotsAndChatsFromDesktop();
    }
    if (evt.type === 'mini-app-updated' && activeArea === 'miniapps') {
      renderMiniAppsPage();
    }
  });
}

void refreshPermissions();
void hydrateBotsAndChatsFromDesktop();
// 首屏准备 = 会话与记忆都读回来了（失败也揭幕，见 hideBootSplash 的注释）。
void initializeMemory().finally(hideBootSplash);

/* ── FormCard 宿主：elicitation（结构化参数确认）的挂载点 ─────────────────────
   目前没有 elicitation 的 IPC 通道，所以这里只留一个「可挂载」的入口：
   index.html 的 #form-card-host 一直存在但为空，React root 懒创建，
   没有数据源时既不建树也不留占位，页面渲染结果与改造前完全一致。
   将来接通道时，在通道回调里直接调 showFormCard(request, onRespond)；
   showFormCard(null) 即卸载。通道名归 electron/ 定义，渲染端不伪造。 */
let formCardRoot = null;
function showFormCard(request, onRespond) {
  const host = $('#form-card-host');
  if (!host) return false;
  if (!request) { formCardRoot?.render(null); return true; }
  formCardRoot ??= createRoot(host);
  formCardRoot.render(React.createElement(FormCard, { request, onRespond }));
  return true;
}
// 挂到 window 上而不是留成「未使用的局部函数」：将来 elicitation 的 IPC 回调
// 在别处（preload 暴露的桥接）拿到请求时，直接 window.movaShowFormCard(...) 即可，
// 不需要再回到这个文件里找位置。null 传入即卸载。
window.movaShowFormCard = showFormCard;
