/* Mova workspace: local conversations and model streaming. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import loaderStyles from 'generative-loaders/styles.css?inline';
import { mountComposer } from './composer.js';
import { bindChatUsage } from './chat-usage.js';
import { bindChatAim } from './chat-aim.js';
import { ChatTranscript } from './src/features/chat/chat-transcript';
import { mergeReplyEvent, receiveReply } from './src/features/chat/chat-reply';
import { mockMovaClient } from './src/services/mock-mova-client';
import { createDesktopMovaClient, ModelConnectionError } from './src/services/desktop-model-client';
import { BotConversation, BotList } from './bot-conversation.jsx';
import { BotBuilder } from './bot-builder.jsx';
import { BotChatInfo, GroupChatInfo } from './src/features/botchat/bot-chat-info.jsx';
import { GroupBuilder } from './src/features/botchat/group-dialog.jsx';
import { PlacePicker } from './src/features/botchat/place-dialog.jsx';
import { bindMorphPopover } from './src/features/botchat/morph-popover.js';
import { Forum } from './forum.jsx';
import { Contacts } from './src/features/contacts/contacts.jsx';
import { bots, createBot, deleteBot, findBot, findBotByName, recordBotUse } from './bot-directory.js';
import { createProjectRecord, readProjectDraft } from './project-data.js';
import { MemorySettings } from './src/features/memory/memory-settings.jsx';
import { ServiceSettings } from './src/features/memory/service-settings.jsx';
import { ApprovalBar } from './src/features/approvals/approval-bar.jsx';
import { AskCard } from './src/features/ask/ask-card.jsx';
import { PermissionsSettings } from './src/features/permissions/permissions-settings.jsx';
import { buildContextHistory } from './src/features/chat/context-budget.mjs';

const loaderStyleElement = document.createElement('style');
loaderStyleElement.textContent = loaderStyles;
document.head.append(loaderStyleElement);
import { createChatRows } from './sidebar-chats.js';
import { bindSidebarResize } from './sidebar-resize.js';
import { notify } from './src/features/ui/toast.js';
import { confirmAction } from './src/features/ui/confirm.js';
import { icon, replaceStaticIcons } from './icons.js';
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
const STORAGE_KEY = 'mova-design.workspace.v1';
const memoryBridge = window.movaDesktop?.memory;
let memoryReady = !memoryBridge;
let memorySettings = { memoryEnabled: true, autoExtract: true, includeGlobal: true };
const temporaryConversations = new Set();
let temporaryNextChat = false;
let memoryPageRoot;
let servicePageRoot;
let permissionsPageRoot;
const memoryProjectId = () => $('#mode-label').textContent === 'CodeMova' ? selectedProject : null;
function workspaceSnapshot() {
  const filteredProjects = projects.map(project => ({ ...project, chats: project.chats.filter(chat =>
    !temporaryConversations.has(JSON.stringify([chat.mode || 'CodeMova', project.name, chat.title]))) }));
  return { version: 1, projects: filteredProjects, conversations: [...conversations].filter(([key]) => !temporaryConversations.has(key)) };
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
const refreshSidebarResize = bindSidebarResize($('.content-frame'), $('.project-sidebar'), $('.sidebar-divider'), {
  onCollapse: () => toggleSidebar(false),
});
const expandedArchives = new Set();
const collapsedProjects = new Set();
let selectedProject = 'Mova';
let selectedChat = '';
let activeArea = 'home';
let homeSelectedModel = 'deepseek-chat';
const BOT_MODEL = 'deepseek-chat';
let selectedBot = 'mova';
let botSequence = 0;
const botChats = [
  { id: 'mova', botId: 'mova', title: 'MovaBot', messages: [{ id: 'welcome', role: 'bot', text: '你好，我是 MovaBot。有什么想法或任务，都可以在这里告诉我。' }] },
  { id: 'group-two', title: '双人协作', members: ['MovaBot', '助手'], color: '#a7c9f4', muted: false,
    createdAt: Date.now() - 12 * 864e5,
    place: { id: 'project:Mova', name: 'Mova', kind: 'project' },
    messages: [
      { id: 'group-two-1', role: 'bot', sender: 'MovaBot', text: '欢迎来到双人协作群。我们可以在这里一起整理想法。' },
      { id: 'group-two-2', role: 'bot', sender: '助手', text: '我也在这里，随时可以开始。' },
    ] },
  { id: 'group-team', title: 'Mova 小团队', members: ['MovaBot', '策划', '设计', '开发', '助手'], color: '#f4d88a', muted: false,
    createdAt: Date.now() - 26 * 864e5,
    place: { id: 'project:Mova', name: 'Mova', kind: 'project' },
    messages: [
      { id: 'group-team-1', role: 'bot', sender: 'MovaBot', text: '大家好，这里是小团队的群聊预览。' },
      { id: 'group-team-2', role: 'bot', sender: '设计', text: '我们可以在这里一起讨论和推进任务。' },
    ] },
];
let botListRoot;
let botConversationRoot;
let selectedContact = 'mova';
// 社区与通讯录都是占满内容区的整页视图：没有项目侧栏、对话区和输入框。
const isFullView = area => area === 'forum' || area === 'contacts';
let nextDraftId = 0;
const drafts = new Map();
const conversations = new Map(savedWorkspace?.conversations || []);
/* 目标与计划按会话键存放；aimView 在挂载头部入口后赋值。 */
const chatAims = new Map();
let aimView = null;
const activeReplies = new Map();
for (const messages of conversations.values()) {
  for (const message of messages) {
    if (message.reply?.status === 'streaming') {
      message.reply.status = 'interrupted';
      settleSearchRows(message.reply.timeline, '上次搜索已中断');
    }
  }
}
let saveTimer;
function saveWorkspace() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    if (memoryBridge) {
      if (!memoryReady) return;
      void memoryBridge.saveSessions(workspaceSnapshot()).then(result => {
        if (!result.ok) chatFeedback('聊天保存失败 + result.error + ');
      }).catch(() => chatFeedback('无法连接本地会话存储，请勿关闭窗口。'));
    } else localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaceSnapshot()));
  } catch (error) {
    console.warn('无法保存本地工作区', error);
    const announcement = $('#sidebar-announcement');
    if (announcement) announcement.textContent = '本地保存失败，请检查浏览器存储空间或权限';
  }
}
function scheduleWorkspaceSave() {
  // Full snapshots are large; coalesce long streams into occasional durable checkpoints.
  saveTimer ??= setTimeout(saveWorkspace, 1500);
}
window.addEventListener('pagehide', () => {
  if (saveTimer !== undefined) saveWorkspace();
});
const draftKey = () => activeArea === 'messages' ? JSON.stringify(['MovaBot', selectedBot]) : JSON.stringify([$('#mode-label').textContent, selectedProject, selectedChat]);
function currentDraft() {
  const key = draftKey();
  if (!drafts.has(key)) drafts.set(key, { id: ++nextDraftId, text: '', attachments: [] });
  return drafts.get(key);
}
function restoreDraft() {
  composer.update({ draft: currentDraft() });
  renderConversation();
}
function isFlatChatList() {
  return $('#mode-label').textContent !== 'CodeMova';
}

function renderProjects(query = '') {
  saveWorkspace();
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
    newChatButton.setAttribute('aria-label', `${project.name} 中新建对话`);
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
      onOpen: () => selectProject(project.name, chat.title),
      onArchive: () => toggleArchive(project, chat),
    });
    if (collapsed) {
      list.append(group);
      return;
    }
    const visibleChats = chats.filter(chat => !chat.archived);
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
    onOpen: () => selectProject(project.name, chat.title),
    onArchive: () => toggleArchive(project, chat),
  });
  entries.filter(({ chat }) => !chat.archived).forEach(({ project, chat }) => {
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
      projectName.setCustomValidity('');
      projectDialog.showModal();
      projectName.select();
    } },
    { icon: 'folder-simple', label: '在资源管理器中打开', run: () => {
      $('#sidebar-announcement').textContent = '原型不会访问真实文件系统';
    } },
    { divider: true },
    { icon: 'archive', label: '归档', run: () => {
      project.chats.forEach(chat => { chat.archived = true; });
      if (selectedProject === project.name) { selectedChat = ''; restoreDraft(); }
      renderProjects($('#project-search').value);
      $('#sidebar-announcement').textContent = `已归${project.name} 的聊天`;
    } },
    { divider: true },
    { icon: 'x', label: '移除项目', danger: true, run: () => {
      const index = projects.indexOf(project);
      if (index < 0) return;
      for (const [key, messages] of conversations) {
        if (JSON.parse(key)[1] === project.name) activeReplies.get(messages)?.abort();
      }
      projects.splice(index, 1);
      if (selectedProject === project.name) {
        selectedProject = projects[0]?.name ?? '';
        selectedChat = '';
        restoreDraft();
      }
      renderProjects($('#project-search').value);
      $('#sidebar-announcement').textContent = `已移除项目：${project.name}`;
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
      chevron.textContent = '键';
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

function toggleArchive(project, chat) {
  chat.archived = !chat.archived;
  if (chat.archived && selectedProject === project.name && selectedChat === chat.title) {
    selectedChat = '';
    restoreDraft();
  }
  renderProjects($('#project-search').value);
  const row = Array.from(document.querySelectorAll('.project-row')).find(button => button.title === project.name);
  const summary = row?.parentElement.querySelector('.chat-archive summary');
  (chat.archived && summary ? summary : row)?.focus({ preventScroll: true });
  $('#sidebar-announcement').textContent = `已在 ${project.name} 中新建对话`;
}
function selectProject(name, chat = '') {
  hidePeekNow();
  selectedProject = name; selectedChat = chat;
  $('#welcome-project').textContent = name;
  renderProjects($('#project-search').value); restoreDraft();
  if (matchMedia('(max-width:620px)').matches) toggleSidebar(false);
}
let autoCollapsedAt = null;
let manualExpandedAt = null;
// 内置浏览器在这里挂接：左侧面板展开后若空间不足，右侧分屏自动收回
let sidebarExpandHook = null;
// 打开分屏时自动收起过左侧二级菜单：关闭分屏时还原。
let browserAutoCollapsed = false;
function toggleSidebar(expanded = $('.window-shell').classList.contains('sidebar-collapsed'), automatic = false) {
  if (!automatic) {
    autoCollapsedAt = null;
    manualExpandedAt = expanded ? $('.content-frame').clientWidth : null;
    browserAutoCollapsed = false;
  }
  chatRows.close();
  hidePeekNow();
  $('.window-shell').classList.toggle('sidebar-collapsed', !expanded);
  $('#sidebar-toggle').setAttribute('aria-expanded', String(expanded));
  $('#sidebar-toggle').setAttribute('aria-expanded', String(expanded));
  refreshSidebarResize();
  if (expanded) sidebarExpandHook?.();
  syncSidebarToggle();
}
$('#sidebar-toggle').addEventListener('click', () => {
// 对话区被分屏挤掉时，第一次点击先把它恢复，不展开左侧列表
  if (browserState.chatCollapsed) { restoreChatView(); return; }
  toggleSidebar();
});
// 聊天页顶栏只保留内置浏览器按钮；侧栏开关由标题栏按钮负责
$('#panel-toggle')?.addEventListener('click', () => toggleSidebar());

// Observe the actual chat width: a dragged divider changes it without resizing the window.
// Remember the frame width at collapse so hiding the sidebar cannot immediately undo itself.
const layoutFrame = $('.content-frame');
const mainPanel = $('.main-panel');
const sidebarCollapseWidth = 420;
const layoutObserver = new ResizeObserver(() => {
  if (isFullView(activeArea)) return;
  // The browser pane deliberately narrows the chat column; do not treat that
  // as a reason to auto-collapse the project sidebar.
  if (layoutFrame.classList.contains('browser-open')) return;
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

// ── Right-side built-in browser ──────────────────────────────────────
const browserPanel = $('#browser-panel');
const browserToolbar = $('#browser-toolbar');
const browserStage = $('#browser-stage');
const browserViewport = $('#browser-viewport');
const browserFrame = $('#browser-frame');
const browserStart = $('#browser-start');
const browserLoading = $('#browser-loading');
const browserUrlInput = $('#browser-url');
const browserAddressForm = $('#browser-address-form');
const browserBack = $('#browser-back');
const browserForward = $('#browser-forward');
const browserReload = $('#browser-reload');
const browserMenu = $('#browser-menu');
const browserMenuTrigger = $('#browser-menu-trigger');
const browserResizer = $('#browser-resizer');
const browserRevealZone = $('#browser-reveal-zone');
const browserToggleButtons = [$('#browser-toggle'), $('#chat-browser-toggle')].filter(Boolean);
const BROWSER_PREFS_KEY = 'mova-design.browser.v1';
// 对话区、浏览器、拖拽收缩的宽度边界（像素）
const CHAT_MIN = 460;          // 打开分屏时给对话区保留的宽度
const CHAT_DRAG_MIN = 350;     // 拖拽时对话区最小可留宽度（输入栏已精简）
const CHAT_RESTORE_AT = 470;   // 往回拉到这里再展开对话
const BROWSER_MIN = 260;
const BROWSER_CLOSE_OVERSHOOT = 36;
const BROWSER_ARM_DISTANCE = 6;
const browserState = {
  open: false, url: '', pendingUrl: '', history: [], index: -1,
  toolbarHidden: false, chatCollapsed: false, limitArmed: false, dragArmed: false,
  width: null, frameCleanup: null, frameScroll: null, resize: null, loadTimer: 0,
};

function readBrowserPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem(BROWSER_PREFS_KEY) || 'null');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
function saveBrowserPrefs() {
  try {
    const value = { url: browserState.url || '', width: browserState.width || null };
    localStorage.setItem(BROWSER_PREFS_KEY, JSON.stringify(value));
  } catch { /* Browser history is best-effort. */ }
}
function normalizeBrowserUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(?:https?|file):\/\//i.test(raw)) return raw;
  if (/^about:blank$/i.test(raw)) return '';
  if (/\s/.test(raw)) return `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)) return `http://${raw}`;
  if (/^[\w.-]+:\d+(?:\/|$)/.test(raw)) return `http://${raw}`;
  if (/^[\w-]+(?:\.[\w-]+)+(?:[/:?#]|$)/.test(raw)) return `https://${raw}`;
  return `https://${raw}`;
}
function updateBrowserNav() {
  const hasUrl = Boolean(browserState.url);
  browserBack.disabled = browserState.index <= 0;
  browserForward.disabled = browserState.index < 0 || browserState.index >= browserState.history.length - 1;
  browserReload.disabled = false;
  browserMenu.querySelectorAll('[data-browser-action="open-external"], [data-browser-action="copy-url"], [data-browser-action="reload"]')
    .forEach(button => { button.disabled = !hasUrl; });
}
function setBrowserToolbarHidden(hidden) {
  if (!browserPanel || browserState.toolbarHidden === hidden) return;
  if (hidden && (browserToolbar.contains(document.activeElement) || !browserMenu.hidden)) return;
  browserState.toolbarHidden = hidden;
  browserPanel.classList.toggle('toolbar-hidden', hidden);
  browserToolbar.inert = hidden;
  browserToolbar.setAttribute('aria-hidden', String(hidden));
}
function handleBrowserScroll(delta) {
  if (!browserState.open || !Number.isFinite(delta) || Math.abs(delta) < 1.5) return;
  if (browserToolbar.contains(document.activeElement) || !browserMenu.hidden) return;
  setBrowserToolbarHidden(delta > 0);
}
function setBrowserMenuOpen(open) {
  browserMenu.hidden = !open;
  browserMenuTrigger.setAttribute('aria-expanded', String(open));
  if (open) setBrowserToolbarHidden(false);
}
function cleanupBrowserFrameScroll() {
  browserState.frameCleanup?.();
  browserState.frameCleanup = null;
}
function attachBrowserFrameScroll() {
  cleanupBrowserFrameScroll();
  let frameWindow;
  try {
    frameWindow = browserFrame.contentWindow;
    if (!frameWindow?.document || frameWindow.location.href === 'about:blank') return;
  } catch {
    // Cross-origin pages block access. The page still works; the top reveal
    // handle remains available for bringing the toolbar back.
    return;
  }
  let lastY = frameWindow.scrollY || 0;
  const onWheel = event => handleBrowserScroll(event.deltaY);
  const onScroll = () => {
    const nextY = frameWindow.scrollY || 0;
    const delta = nextY - lastY;
    lastY = nextY;
    if (Math.abs(delta) >= 2) handleBrowserScroll(delta);
  };
  frameWindow.addEventListener('wheel', onWheel, { passive: true });
  frameWindow.addEventListener('scroll', onScroll, { passive: true });
  browserState.frameCleanup = () => {
    frameWindow.removeEventListener('wheel', onWheel);
    frameWindow.removeEventListener('scroll', onScroll);
  };
}
function showBrowserStart(focus = false) {
  cleanupBrowserFrameScroll();
  browserState.url = '';
  browserState.pendingUrl = '';
  browserState.history = [];
  browserState.index = -1;
  browserUrlInput.value = '';
  browserStart.hidden = false;
  browserViewport.hidden = true;
  browserFrame.src = 'about:blank';
  browserLoading.hidden = true;
  clearTimeout(browserState.loadTimer);
  updateBrowserNav();
  if (focus) browserUrlInput.focus({ preventScroll: true });
}
function loadBrowserUrl(value, { push = true, focus = false } = {}) {
  const url = normalizeBrowserUrl(value);
  if (!url) { showBrowserStart(focus); return; }
  browserUrlInput.value = url;
  if (push && browserState.url === url) { reloadBrowser(); return; }

  if (push) {
    browserState.history = browserState.history.slice(0, browserState.index + 1);
    if (browserState.history.at(-1) !== url) browserState.history.push(url);
    browserState.index = browserState.history.length - 1;
  } else if (!browserState.history.length) {
    browserState.history = [url];
    browserState.index = 0;
  } else {
    browserState.history[browserState.index] = url;
  }
  browserState.url = url;
  browserState.pendingUrl = url;
  browserUrlInput.value = url;
  browserStart.hidden = true;
  browserViewport.hidden = false;
  browserLoading.hidden = false;
  setBrowserToolbarHidden(false);
  updateBrowserNav();
  clearTimeout(browserState.loadTimer);
  browserState.loadTimer = setTimeout(() => {
    if (browserState.open && browserState.pendingUrl) browserLoading.hidden = true;
  }, 15000);
  try {
    browserFrame.src = url;
  } catch {
    browserLoading.hidden = true;
    notify('无法打开这个网址', { tone: 'error' });
  }
  saveBrowserPrefs();
  if (focus) browserUrlInput.focus({ preventScroll: true });
}
function reloadBrowser() {
  if (!browserState.url) return;
  browserState.pendingUrl = browserState.url;
  browserLoading.hidden = false;
  clearTimeout(browserState.loadTimer);
  browserState.loadTimer = setTimeout(() => { browserLoading.hidden = true; }, 15000);
  try {
    browserFrame.contentWindow.location.reload();
  } catch {
    browserFrame.src = browserState.url;
  }
}
function navigateBrowserHistory(direction) {
  const next = browserState.index + direction;
  if (next < 0 || next >= browserState.history.length) return;
  browserState.index = next;
  loadBrowserUrl(browserState.history[next], { push: false });
}
function setBrowserOpen(open) {
  if (!browserPanel || browserState.open === open) return;
  browserState.open = open;
  browserPanel.hidden = !open;
  layoutFrame.classList.toggle('browser-open', open);
  for (const button of browserToggleButtons) {
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? '关闭内置浏览器' : '打开内置浏览器');
    button.title = open ? '关闭内置浏览器' : '内置浏览器';
  }
  browserPanel.classList.remove('toolbar-hidden');
  browserState.toolbarHidden = false;
  browserToolbar.inert = false;
  browserToolbar.setAttribute('aria-hidden', 'false');
  setBrowserMenuOpen(false);

  if (!open) {
    saveBrowserPrefs();
    cleanupBrowserFrameScroll();
    clearTimeout(browserState.loadTimer);
    browserState.pendingUrl = '';
    browserViewport.hidden = true;
    browserFrame.src = 'about:blank';
    browserStart.hidden = false;
    browserLoading.hidden = true;
    browserUrlInput.blur();
    setBrowserArmed(false);
    setChatCollapsed(false);
    if (browserAutoCollapsed) {
      browserAutoCollapsed = false;
      if ($('.window-shell').classList.contains('sidebar-collapsed')) toggleSidebar(true, true);
    }
    syncSidebarToggle();
    return;
  }

  const prefs = readBrowserPrefs();
  const preferred = Number.isFinite(prefs.width) ? prefs.width : browserDefaultWidth();
  fitBrowserWidth(preferred);
  // 空间不够时先让左侧二级菜单消失，保留对话，而不是盖住它。
  requestAnimationFrame(ensureBrowserFits);
  const restoreUrl = browserState.url || (typeof prefs.url === 'string' ? prefs.url : '');
  if (restoreUrl) loadBrowserUrl(restoreUrl, { push: !browserState.url, focus: true });
  else showBrowserStart(true);
  requestAnimationFrame(updateBrowserResizerA11y);
}

// 打开或缩放分屏时保证对话区仍在：优先自动收起左侧二级菜单，
// 其次收窄分屏自身，绝不把对话区变成覆盖层。
function ensureBrowserFits() {
  if (!browserState.open) return;
  if (matchMedia('(max-width: 620px)').matches) return;
  const frameWidth = layoutFrame.clientWidth;
  if (frameWidth - sidebarWidthNow() - browserPanel.getBoundingClientRect().width >= CHAT_MIN) return;
  if (sidebarWidthNow() > 0) {
    browserAutoCollapsed = true;
    toggleSidebar(false, true);
  }
  const usable = frameWidth - sidebarWidthNow();
  const target = Math.max(BROWSER_MIN, Math.min(browserPanel.getBoundingClientRect().width, usable - CHAT_DRAG_MIN));
  if (target < browserPanel.getBoundingClientRect().width) setBrowserWidth(target);
  updateBrowserResizerA11y();
}

// 分屏优先贴着右侧；打开时先按默认比例，再收到“刚好不挤坏对话区”的宽度
function browserDefaultWidth() {
  return Math.min(720, Math.max(320, layoutFrame.clientWidth * 0.42));
}
function sidebarWidthNow() {
  if ($('.window-shell').classList.contains('sidebar-collapsed')) return 0;
  return $('.project-sidebar')?.getBoundingClientRect().width || 0;
}
function fitBrowserWidth(preferred) {
  const usable = layoutFrame.clientWidth - sidebarWidthNow();
  const max = Math.max(BROWSER_MIN, Math.min(720, usable - CHAT_MIN));
  setBrowserWidth(Math.min(preferred, max));
}

for (const button of browserToggleButtons) {
  button.addEventListener('click', () => setBrowserOpen(!browserState.open));
}
browserAddressForm.addEventListener('submit', event => {
  event.preventDefault();
  loadBrowserUrl(browserUrlInput.value, { push: true });
  browserUrlInput.blur();
});
browserUrlInput.addEventListener('focus', () => {
  setBrowserToolbarHidden(false);
  browserUrlInput.select();
});
browserUrlInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); browserUrlInput.blur(); }
});
browserBack.addEventListener('click', () => navigateBrowserHistory(-1));
browserForward.addEventListener('click', () => navigateBrowserHistory(1));
browserReload.addEventListener('click', reloadBrowser);
browserFrame.addEventListener('load', () => {
  clearTimeout(browserState.loadTimer);
  const pending = browserState.pendingUrl;
  browserState.pendingUrl = '';
  browserLoading.hidden = true;
  if (!browserState.open) return;
  setBrowserToolbarHidden(false);
  // Same-origin pages are fully observable: keep the address bar and history
  // in sync with links the user follows inside the embedded page.
  try {
    const href = browserFrame.contentWindow?.location.href;
    if (href && href !== 'about:blank' && href !== browserState.url) {
      if (pending) {
        browserState.history[browserState.index] = href;
      } else {
        browserState.history = browserState.history.slice(0, browserState.index + 1);
        browserState.history.push(href);
        browserState.index = browserState.history.length - 1;
      }
      browserState.url = href;
      browserUrlInput.value = href;
      updateBrowserNav();
      saveBrowserPrefs();
    }
  } catch { /* Cross-origin page: retain the URL that was requested. */ }
  configureFrameViewport();
  attachBrowserFrameScroll();
});
browserStage.addEventListener('wheel', event => handleBrowserScroll(event.deltaY), { passive: true });
browserPanel.addEventListener('focusin', () => setBrowserToolbarHidden(false));
browserRevealZone.addEventListener('pointerenter', () => setBrowserToolbarHidden(false));
browserRevealZone.addEventListener('click', () => {
  setBrowserToolbarHidden(false);
  browserUrlInput.focus({ preventScroll: true });
});

// ǶҳͬԴֱעʽزţ iframe Ŵ
// һȦٲУѹƵ⣬ҳԿɹ
let frameSameOrigin = false;
function configureFrameViewport() {
  let sameOrigin = false;
  try {
    const win = browserFrame.contentWindow;
    const doc = win?.document;
    if (doc?.documentElement && win.location.href !== 'about:blank') sameOrigin = true;
  } catch {
    sameOrigin = false;
  }
  frameSameOrigin = sameOrigin;
  browserViewport.classList.toggle('is-cross-origin', !sameOrigin);
  if (!sameOrigin) return;
  try {
    const doc = browserFrame.contentDocument;
    if (doc && !doc.querySelector('style[data-mova-frame]')) {
      const style = doc.createElement('style');
      style.dataset.movaFrame = 'scrollbars';
      style.textContent = 'html{scrollbar-width:none!important;-ms-overflow-style:none!important}'
        + 'html::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}';
      (doc.head || doc.documentElement).append(style);
    }
  } catch { /* Page switched origins mid-load. */ }
  fitFrameToWidth();
}
function fitFrameToWidth() {
  if (!frameSameOrigin) return;
  try {
    const doc = browserFrame.contentDocument;
    const root = doc?.documentElement;
    if (!root) return;
    root.style.zoom = '';
    const width = browserFrame.clientWidth;
    const contentWidth = Math.max(root.scrollWidth, doc.body?.scrollWidth || 0);
    if (contentWidth > width + 2) {
      root.style.zoom = String(Math.max(0.5, Math.min(1, width / contentWidth)));
    }
  } catch { /* Cross-origin or detached document. */ }
}
new ResizeObserver(() => fitFrameToWidth()).observe(browserFrame);

browserMenuTrigger.addEventListener('click', event => {
  event.stopPropagation();
  setBrowserMenuOpen(browserMenu.hidden);
});
browserMenu.addEventListener('click', event => {
  const button = event.target.closest('[data-browser-action]');
  if (!button) return;
  const action = button.dataset.browserAction;
  setBrowserMenuOpen(false);
  if (action === 'open-external') {
    if (browserState.url) window.open(browserState.url, '_blank', 'noopener,noreferrer');
  } else if (action === 'copy-url') {
    if (!browserState.url) return;
    void navigator.clipboard?.writeText(browserState.url)
      .then(() => notify('网址已复制'))
      .catch(() => notify('无法复制网址', { tone: 'error' }));
  } else if (action === 'reload') {
    reloadBrowser();
  } else if (action === 'close') {
    setBrowserOpen(false);
  }
});
document.addEventListener('pointerdown', event => {
  if (browserMenu.hidden) return;
  if (!browserMenu.contains(event.target) && !browserMenuTrigger.contains(event.target)) setBrowserMenuOpen(false);
}, true);
document.addEventListener('keydown', event => {
  if (!browserState.open) return;
  if (event.key === 'Escape' && !browserMenu.hidden) {
    event.preventDefault();
    setBrowserMenuOpen(false);
    browserMenuTrigger.focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    setBrowserToolbarHidden(false);
    browserUrlInput.focus({ preventScroll: true });
  }
  if (event.altKey && event.key === 'ArrowLeft') navigateBrowserHistory(-1);
  if (event.altKey && event.key === 'ArrowRight') navigateBrowserHistory(1);
});
browserStart.addEventListener('click', () => browserUrlInput.focus({ preventScroll: true }));

function browserWidthBounds() {
  const usable = layoutFrame.clientWidth - sidebarWidthNow();
  if (browserState.chatCollapsed) {
    return { min: BROWSER_MIN, max: Math.max(BROWSER_MIN, usable) };
  }
  return { min: BROWSER_MIN, max: Math.max(BROWSER_MIN, Math.min(720, usable - CHAT_DRAG_MIN)) };
}
function updateBrowserResizerA11y() {
  const { min, max } = browserWidthBounds();
  const width = Math.round(browserPanel.getBoundingClientRect().width);
  browserResizer.setAttribute('aria-valuemin', String(Math.round(min)));
  browserResizer.setAttribute('aria-valuemax', String(Math.round(max)));
  browserResizer.setAttribute('aria-valuenow', String(width));
  browserResizer.setAttribute('aria-valuetext', `浏览器宽${width} 像素`);
}
function setBrowserWidth(width) {
  const { min, max } = browserWidthBounds();
  const next = Math.round(Math.max(min, Math.min(max, width)));
  browserState.width = next;
  layoutFrame.style.setProperty('--browser-width', `${next}px`);
  updateBrowserResizerA11y();
}
function setBrowserArmed(armed) {
  browserState.limitArmed = Boolean(armed);
  browserPanel.classList.toggle('is-armed', Boolean(armed));
}
// 收起/展开中间对话区：收起后浏览器占满右侧，左上角图标负责恢复对话
function setChatCollapsed(collapsed) {
  const next = Boolean(collapsed) && browserState.open && !matchMedia('(max-width: 900px)').matches;
  if (browserState.chatCollapsed === next) return;
  browserState.chatCollapsed = next;
  layoutFrame.classList.toggle('chat-collapsed', next);
  if (next) {
    browserState.width = null;
    layoutFrame.style.removeProperty('--browser-width');
    setBrowserArmed(false);
  }
  syncSidebarToggle();
  updateBrowserResizerA11y();
}
function restoreChatView() {
  if (!browserState.open || !browserState.chatCollapsed) return;
  const usable = layoutFrame.clientWidth - sidebarWidthNow();
  setChatCollapsed(false);
  setBrowserWidth(Math.min(720, Math.max(BROWSER_MIN, usable - CHAT_RESTORE_AT)));
}
// 对话区收起时，左上角图标的语义变成"展开对话区"，不会顺手把左侧列表也拉开
function syncSidebarToggle() {
  const toggle = $('#sidebar-toggle');
  if (!toggle) return;
  if (browserState.chatCollapsed) {
    toggle.setAttribute('aria-label', '展开对话区');
    toggle.title = '展开对话区';
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }
  const expanded = !$('.window-shell').classList.contains('sidebar-collapsed');
  toggle.setAttribute('aria-label', expanded ? '收起侧边栏' : '展开侧边栏');
  toggle.title = expanded ? '收起侧边栏' : '展开侧边栏';
  toggle.setAttribute('aria-expanded', String(expanded));
}
// 左侧面板展开后，如果对话区已经放不下，右侧分屏整块收回。
// 对话区此刻处于收起态时，先让浏览器让位、把对话还回来。
function retractBrowserIfNoRoom() {
  if (!browserState.open) return;
  if (matchMedia('(max-width: 620px)').matches) return;
  if (browserState.chatCollapsed) {
    setBrowserOpen(false);
    return;
  }
  const usable = layoutFrame.clientWidth - sidebarWidthNow();
  const browserWidth = browserPanel.getBoundingClientRect().width;
  if (usable - browserWidth >= CHAT_MIN - 2) return;
  setBrowserOpen(false);
}
sidebarExpandHook = () => requestAnimationFrame(retractBrowserIfNoRoom);
$('#sidebar-divider')?.addEventListener('pointerup', () => requestAnimationFrame(retractBrowserIfNoRoom));
$('#sidebar-divider')?.addEventListener('keydown', () => requestAnimationFrame(retractBrowserIfNoRoom));
// 窗口变窄时重新均衡：先让左侧二级菜单让位，对话区始终可见。
let browserFitTimer = 0;
window.addEventListener('resize', () => {
  if (!browserState.open) return;
  clearTimeout(browserFitTimer);
  browserFitTimer = setTimeout(ensureBrowserFits, 150);
});

browserResizer.addEventListener('pointerdown', event => {
  if (event.button !== 0 || matchMedia('(max-width: 900px)').matches) return;
  event.preventDefault();
  browserState.resize = {
    id: event.pointerId,
    startX: event.clientX,
    startWidth: browserPanel.getBoundingClientRect().width,
    // 上一段手势已经在极限位置松手：这一段再往左拖才收起对话区
    armed: browserState.limitArmed,
    atLimit: false,
  };
  browserPanel.classList.add('is-resizing');
  document.body.classList.add('browser-resizing');
  try { browserResizer.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers still drag. */ }
});
function updateBrowserDrag(event) {
  const resize = browserState.resize;
  if (!resize || resize.id !== event.pointerId) return;
  const desired = resize.startWidth + resize.startX - event.clientX;
  const usable = layoutFrame.clientWidth - sidebarWidthNow();

  // 往右拉过最小宽度一段距离：整个分屏收回，跟侧栏的收起手势一致
  if (desired < BROWSER_MIN - BROWSER_CLOSE_OVERSHOOT) {
    finishBrowserResize();
    browserState.width = null;
    layoutFrame.style.removeProperty('--browser-width');
    setBrowserOpen(false);
    return;
  }

  if (!browserState.chatCollapsed) {
    const limit = Math.max(BROWSER_MIN, usable - CHAT_DRAG_MIN);
    // 第二段手势：到极限松手后再往左拖，才把对话区收起
    if (resize.armed) {
      if (resize.startX - event.clientX >= BROWSER_ARM_DISTANCE) {
        setChatCollapsed(true);
        finishBrowserResize();
        return;
      }
      if (event.clientX - resize.startX >= BROWSER_ARM_DISTANCE) {
        resize.armed = false;
        setBrowserArmed(false);
      }
    }
    resize.atLimit = desired >= limit - 1;
    setBrowserWidth(Math.min(desired, limit));
    setBrowserArmed(resize.atLimit);
    return;
  }

  // 已收起对话区：往右拉到能重新放下对话区时恢复
  if (desired <= usable - CHAT_RESTORE_AT) {
    setChatCollapsed(false);
    setBrowserWidth(Math.max(BROWSER_MIN, desired));
    resize.startWidth = browserPanel.getBoundingClientRect().width;
    resize.startX = event.clientX;
  }
}
window.addEventListener('pointermove', updateBrowserDrag);
function finishBrowserResize() {
  if (!browserState.resize) return;
  const { atLimit } = browserState.resize;
  browserState.resize = null;
  browserPanel.classList.remove('is-resizing');
  document.body.classList.remove('browser-resizing');
  // 停在极限位置松手：锁定“再拖一次即可收起”的待命状态  setBrowserArmed(Boolean(atLimit) && !browserState.chatCollapsed);
  saveBrowserPrefs();
}
window.addEventListener('pointerup', finishBrowserResize);
window.addEventListener('pointercancel', finishBrowserResize);
browserResizer.addEventListener('dblclick', () => {
  if (browserState.chatCollapsed) { restoreChatView(); return; }
  browserState.width = null;
  layoutFrame.style.removeProperty('--browser-width');
  fitBrowserWidth(browserDefaultWidth());
  setBrowserArmed(false);
  saveBrowserPrefs();
});
browserResizer.addEventListener('keydown', event => {
  const step = event.shiftKey ? 48 : 16;
  const usable = layoutFrame.clientWidth - sidebarWidthNow();
  if (browserState.chatCollapsed) {
    if (event.key === 'ArrowRight' || event.key === 'Home') {
      event.preventDefault();
      restoreChatView();
    }
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    const limit = Math.max(BROWSER_MIN, usable - CHAT_DRAG_MIN);
    const next = browserPanel.getBoundingClientRect().width + step;
    if (next >= limit) {
      setBrowserWidth(limit);
      setBrowserArmed(true);
    } else {
      setBrowserWidth(next);
      setBrowserArmed(false);
    }
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    setBrowserWidth(browserPanel.getBoundingClientRect().width - step);
    setBrowserArmed(false);
  }
});

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
let editingProject = null;
$('#new-project').addEventListener('click', () => {
  editingProject = null;
  $('#project-form').reset();
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
    editingProject.instructions = draft.instructions;
    editingProject.sourceFolders = draft.sourceFolders;
    editingProject.memory = draft.memory;
    for (const [key, messages] of [...conversations]) {
      const parts = JSON.parse(key);
      if (parts.length === 3 && parts[1] === previous) {
        conversations.delete(key);
        parts[1] = name;
        conversations.set(JSON.stringify(parts), messages);
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
});
$('#home-button').addEventListener('click', () => { closeSettings(); setActiveArea('home'); selectProject('Mova'); });

// Settings overlay: opened from the top menu, closed with Escape or the close button.
const settingsView = $('#settings-view');
// 设置页的导航宽度可拖拽调整，复用对话页的分隔条手感（双击复位、方向键微调）
const refreshSettingsResize = bindSidebarResize(settingsView, $('#settings-nav'), $('#settings-divider'), {
  widthVariable: '--mova-settings-split',
  defaultVariable: '--mova-settings-nav-width',
  widthLabel: '设置导航宽度',
});
function selectSettingsPage(id) {
  document.querySelectorAll('[data-settings-item]').forEach(button => {
    button.classList.toggle('selected', button.dataset.settingsItem === id);
  });
  document.querySelectorAll('.settings-page').forEach(page => {
    page.hidden = page.id !== `settings-page-${id}`;
  });
  const headings = { usage: '使用情况和计费', models: '模型', archive: '已归档的聊天', memory: '记忆与存储', permissions: '权限', service: '服务与索引' };
  if (id === 'memory') renderMemoryPage();
  if (id === 'permissions') renderPermissionsPage();
  if (id === 'service') renderServicePage();
  $('#settings-heading').textContent = headings[id] ?? '配置';
  if (id === 'archive') renderArchive();
}
function renderPermissionsPage() {
  permissionsPageRoot ??= createRoot($('#settings-page-permissions'));
  permissionsPageRoot.render(React.createElement(PermissionsSettings, {
    onToast: message => notify(message),
  }));
}
function renderServicePage() {
  servicePageRoot ??= createRoot($('#settings-page-service'));
  servicePageRoot.render(React.createElement(ServiceSettings, { bridge: memoryBridge }));
}
function openSettings(id = 'config') {
  if (browserState.open) setBrowserOpen(false);
  closeMenus();
  if (settingsView.hidden) suppressRailSelection(true);
  settingsView.hidden = false;
  selectSettingsPage(id);
  document.querySelector('[data-settings-item].selected')?.focus({ preventScroll: true });
}
// While the settings overlay is open, no rail item is "current": remember the
// state, drop .selected / aria-current so the rail does not look active.
function suppressRailSelection(suppressed) {
  for (const id of ['home-button', 'messages-button', 'contacts-button', 'forum-button']) {
    const button = $(`#${id}`);
    if (!button) continue;
    if (suppressed) {
      button.dataset.railSelected = button.classList.contains('selected') ? '1' : '0';
      button.dataset.railCurrent = button.getAttribute('aria-current') === 'page' ? '1' : '0';
      button.classList.remove('selected');
      button.removeAttribute('aria-current');
    } else {
      if (button.dataset.railSelected === '1') button.classList.add('selected');
      if (button.dataset.railCurrent === '1') button.setAttribute('aria-current', 'page');
      delete button.dataset.railSelected;
      delete button.dataset.railCurrent;
    }
  }
}
function renderMemoryPage() {
  memoryPageRoot ??= createRoot($('#settings-page-memory'));
  memoryPageRoot.render(React.createElement(MemorySettings, {
    bridge: memoryBridge, projectId: memoryProjectId(),
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
function openMemorySource(source) {
  const conversationId = source?.conversationId;
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
function renderChatCapabilities() {
  const details = $('#chat-capabilities');
  details.hidden = activeArea !== 'home';
  const selection = activeSelection();
  const model = selection?.model;
  $('#chat-capability-summary').textContent = `${model?.name || model?.id || '模拟模式'} · ${model?.vision ? '图片' : '仅文字'} · 能力与隐私`;
  $('#chat-capability-detail').textContent = `${model ? '能力来自提供商目录声明，不保证密钥实际有权调用。' : '未连接真实模型，当前为模拟回复。'} 思考：${model?.efforts?.length ? model.efforts.join(' / ') : '未声明'}。文件、终端、电脑控制尚未接入。长对话按 60,000 字符安全预算保留最近消息，较早内容仅取有限原文摘录，完整记录不删除；模型切换不继承内部思考。${memoryBridge ? '本地历史与记忆为未加密 JSON，请保护系统账户。' : '浏览器仅保存聊天预览，不提供长期记忆。'}`;
  $('#chat-search-enabled').disabled = !providersState?.searchConfigured;
  $('#chat-temporary').disabled = Boolean(selectedChat);
  $('#chat-temporary').checked = selectedChat ? temporaryConversations.has(draftKey()) : temporaryNextChat;
}
function closeSettings() {
  if (settingsView.hidden) return;
  settingsView.hidden = true;
  suppressRailSelection(false);
  $('#search-key').value = '';
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
let pickerDraft = null;
let searchBusy = false;
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
const EFFORT_SHORT = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHi', max: 'Max' };
const desktopPreferences = { thinking: '' };
try {
  const prefs = JSON.parse(localStorage.getItem('mova-design.model-preferences') || 'null');
  if (EFFORT_LEVELS.includes(prefs?.thinking)) desktopPreferences.thinking = prefs.thinking;
} catch { /* Prefer defaults if storage is unavailable. */ }

function saveDesktopPreferences() {
  try { localStorage.setItem('mova-design.model-preferences', JSON.stringify(desktopPreferences)); } catch { /* Session-only selection. */ }
}

const PROTOCOL_LABELS = { openai: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages' };

function flatModels() {
  return (providersState?.providers ?? []).flatMap(provider =>
    provider.models.map(model => ({ providerId: provider.id, provider, model, key: `${provider.id}::${model.id}` })));
}

function activeSelection() {
  const entries = flatModels();
  if (!entries.length) return null;
  const active = providersState?.active;
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
  $('#search-settings').hidden = !providersState;
  $('#search-config-message').textContent = (providersState?.searchConfigured ? '密钥已保存。' : '还没有保存密钥。')
    + '联网搜索默认开启，仅向 AnySearch 发送模型生成的搜索词。';
  if (!providersState) return;
  for (const provider of providersState.providers) list.append(providerCard(provider));
  if (editorDraft && !editorDraft.id) list.append(providerCard({ id: '', name: '新提供商', protocol: 'openai', models: [], hasKey: false }, { isNew: true }));
}

function providerCard(provider, { isNew = false } = {}) {
  const editing = Boolean(editorDraft) && (isNew ? !editorDraft.id : editorDraft.id === provider.id);
  const card = document.createElement('article');
  card.className = 'provider-card';
  card.dataset.editing = String(editing);

  const head = document.createElement('div');
  head.className = 'provider-head';
  const title = document.createElement('div');
  title.className = 'provider-title';
  const name = document.createElement('strong');
  name.textContent = isNew ? '新提供商' : provider.name;
  const badge = document.createElement('span');
  badge.className = 'provider-badge';
  badge.textContent = '自定义';
  const dot = document.createElement('span');
  dot.className = 'provider-dot';
  dot.dataset.on = String(!isNew && provider.hasKey === true);
  dot.title = provider.hasKey ? '已保存密钥' : '尚未保存密钥';
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
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'provider-remove';
  remove.textContent = '删除';
  remove.addEventListener('click', () => {
    if (isNew) { editorDraft = null; renderModelsPage(); }
    else confirmRemoveProvider(provider);
  });
  actions.append(remove);
  head.append(title, actions);
  card.append(head);
  if (editing) card.append(providerEditor(provider, isNew));
  return card;
}

function startEditing(provider) {
  editorDraft = {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    key: '',
    models: provider.models.map(model => ({ ...model, efforts: [...model.efforts] })),
    hasKey: provider.hasKey === true,
    advanced: false,
  };
  renderModelsPage();
  requestAnimationFrame(() => {
    $('.provider-card[data-editing="true"] input[data-field="key"]')?.focus({ preventScroll: true });
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

// 展开/收起折叠区：按内容高度做补间，展开和收起两个方向都连续
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

  // Saved providers can switch the chat model without leaving settings.
  const savedModels = provider.models ?? [];
  if (!isNew && draft.id && savedModels.length) {
    const activeField = document.createElement('label');
    activeField.className = 'provider-field provider-active-field';
    const activeLabel = document.createElement('span');
    activeLabel.textContent = '当前聊天模型';
    const activeSelect = document.createElement('select');
    for (const model of savedModels) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name || model.id;
      activeSelect.append(option);
    }
    activeSelect.value = active && active.providerId === draft.id ? active.model.id : savedModels[0].id;
    activeSelect.addEventListener('change', () => { void chooseModel(`${draft.id}::${activeSelect.value}`); });
    activeField.append(activeLabel, activeSelect);
    body.append(activeField);
  }

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
  body.append(keyField);

  const details = document.createElement('div');
  details.className = 'provider-advanced';
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
  advancedBody.append(
    draftField('显示名称', 'name', draft.name, '例如 Claude'),
    draftField('API 地址', 'baseUrl', draft.baseUrl, '例如 https://api.anthropic.com'),
  );
  const protocolField = document.createElement('label');
  protocolField.className = 'provider-field';
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
  advancedBody.append(protocolField);
  details.append(advancedBody);
  detailsSummary.addEventListener('click', () => {
    const open = advancedBody.hidden;
    draft.advanced = open;
    detailsSummary.setAttribute('aria-expanded', String(open));
    animateExpand(advancedBody, open);
  });
  body.append(details);

  body.append(catalogSection(isNew));

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
  catalogSub.textContent = isNew || !draft.id ? '新建模型目录' : '已自定义模型目录';
  headText.append(catalogTitle, catalogSub);
  const headActions = document.createElement('div');
  headActions.className = 'catalog-actions';
  const defaults = document.createElement('button');
  defaults.type = 'button';
  defaults.textContent = '恢复默认模型';
  defaults.addEventListener('click', () => void restoreDefaults());
  const fetch = document.createElement('button');
  fetch.type = 'button';
  fetch.textContent = '获取可用模型';
  fetch.addEventListener('click', () => void openModelPicker());
  headActions.append(defaults, fetch);
  head.append(headText, headActions);
  catalog.append(head);

  const rows = document.createElement('div');
  rows.className = 'catalog-list';
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

  const idInput = document.createElement('input');
  idInput.className = 'catalog-id';
  idInput.value = model.id;
  idInput.placeholder = '模型 ID';
  idInput.spellcheck = false;
  idInput.dataset.role = 'id';
  idInput.addEventListener('input', () => { model.id = idInput.value.trim(); });

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
  item.append(caps);
  return item;
}

function validateDraft(draft) {
  if (!draft.name.trim()) return '请填写显示名称。';
  if (!draft.baseUrl.trim()) return '请填写 API 地址。';
  try {
    const url = new URL(draft.baseUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return 'API 地址需要以 http:// 或 https:// 开头。';
  } catch { return 'API 地址格式不正确。'; }
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
    const result = await providerBridge.save({
      id: draft.id || undefined,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      protocol: draft.protocol,
      models: draft.models.map(model => ({
        id: model.id,
        name: model.name.trim() || model.id,
        vision: model.vision,
        efforts: model.efforts,
      })),
      key: draft.key,
    });
    if (!result.ok) throw new ModelConnectionError(result.error);
    editorDraft = null;
    await loadProviders();
    setModelMessage(`已保存{draft.name.trim()}」。输入框的模型菜单可以切换模型。`);
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
      next.textContent = `已恢${result.value.length} 个默认模型，保存后生效。`;
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
    status.textContent = `获取${result.value.length} 个模型，勾选后点击「更新列表」。`;
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
    if (model.efforts.length) tags.append(tagChip(`思${model.efforts.join(' · ')}`));
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

async function configureSearch(save) {
  if (!window.movaDesktop?.model || searchBusy) return;
  searchBusy = true;
  const status = $('#search-status');
  const key = $('#search-key');
  const buttons = [...$('#search-form').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  status.removeAttribute('data-tone');
  status.textContent = save ? '正在保存…' : '正在测试搜索…';
  try {
    const bridge = window.movaDesktop.model;
    const result = await (save ? bridge.saveSearch(key.value) : bridge.testSearch(key.value.trim()));
    if (!result.ok) throw new Error(result.error);
    if (save) {
      key.value = '';
      if (providersState) providersState.searchConfigured = true;
      renderModelsPage();
    }
    status.textContent = save ? 'AnySearch 密钥已保存。' : `连接成功，返${result.value} 条来源。`;
  } catch (error) {
    status.dataset.tone = 'error';
    status.textContent = /AnySearch/.test(error.message) ? error.message : new ModelConnectionError(error.message).message;
  } finally {
    searchBusy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

$('#search-test').addEventListener('click', () => void configureSearch(false));
$('#search-form').addEventListener('submit', event => { event.preventDefault(); void configureSearch(true); });
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
  return `${date.getFullYear()}{date.getMonth() + 1}{date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
      row.querySelector('.archive-row-meta').textContent = formatArchiveDate(chat.updatedAt);
      const badge = document.createElement('span');
      badge.className = 'memory-project';
      badge.textContent = chat.location === 'cloud' ? '云端' : '本地';
      row.querySelector('.archive-row-meta').append(' · ', badge);
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const confirmed = await confirmAction({
          title: '永久删除这个聊天？',
          body: '删除后无法恢复，也不会再出现在已归档列表里。只想从列表里移走的话，请改用「取消归档」。',
          detail: chat.title,
          confirmLabel: '永久删除',
          tone: 'danger',
        });
        if (!confirmed) return;
        const index = project.chats.indexOf(chat);
        if (index >= 0) project.chats.splice(index, 1);
        for (const mode of chat.mode ? [chat.mode] : ['ChatMova', 'CodeMova']) {
          const key = JSON.stringify([mode, project.name, chat.title]);
          activeReplies.get(conversations.get(key))?.abort();
          conversations.delete(key);
        }
        saveWorkspace();
        renderArchive();
        $('#sidebar-announcement').textContent = `已删除聊天：${chat.title}`;
      });
      row.querySelector('[data-action="restore"]').addEventListener('click', () => {
        chat.archived = false;
        renderArchive();
        renderProjects($('#project-search').value);
        $('#sidebar-announcement').textContent = `已取消归档：${chat.title}`;
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
  setModelMessage(error instanceof ModelConnectionError ? error.message : '删除失败，请重试', 'error');
  }
});

$('#settings-button').addEventListener('click', () => openSettings());
$('#open-permissions').addEventListener('click', () => openSettings('permissions'));
document.querySelectorAll('[data-settings-item]').forEach(button => {
  button.addEventListener('click', () => selectSettingsPage(button.dataset.settingsItem));
});
document.querySelectorAll('.settings-switch').forEach(signal => {
  signal.addEventListener('click', () => {
    signal.setAttribute('aria-checked', signal.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
});
// 设置搜索收进右上角图标：点开才显示输入框，关闭时清空并恢复全部导航项
const settingsSearchField = $('#settings-search-field');
const settingsSearchToggle = $('#settings-search-toggle');
function setSettingsSearch(open) {
  settingsSearchField.hidden = !open;
  settingsSearchToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    $('#settings-search').focus({ preventScroll: true });
    return;
  }
  $('#settings-search').value = '';
  document.querySelectorAll('[data-settings-item]').forEach(button => { button.hidden = false; });
}
settingsSearchToggle.addEventListener('click', () => setSettingsSearch(settingsSearchField.hidden));
$('#settings-search').addEventListener('input', event => {
  const query = event.target.value.trim().toLocaleLowerCase();
  document.querySelectorAll('[data-settings-item]').forEach(button => {
    button.hidden = Boolean(query) && !button.textContent.toLocaleLowerCase().includes(query);
  });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || settingsView.hidden) return;
  // 搜索打开时，Esc 先收起搜索，再关设置
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
const ANSWER_INTRO = '我会把之前讨论的产品定位、技术架构和分阶段开发计划整理成一份 Markdown 文档，放在 Mova 项目文件夹里。';
const ANSWER_OUTRO = '项目里已经有一版可运行的界面原型，我会把它作为现状写进方案，并明确哪些是真实功能、哪些仍是演示。点击思考过程中的「来源」可展开查看参考网站详情。';

const PRICING_SOURCES = [
  { id: 'src-reddit', site: 'reddit', title: 'Tailwind UI 与构建自己的 UI：成本对比', url: 'https://www.reddit.com/r/reactjs/' },
  { id: 'src-linkedin', site: 'linkedin', title: '我们在 6 周内交付了我们的设计系统', url: 'https://www.linkedin.com/company/figma/' },
  { id: 'src-github', site: 'github', title: 'shadcn/ui — 注册表模型解释', url: 'https://ui.shadcn.com/docs/registry' },
  { id: 'src-figma', site: 'figma', title: '设计变量实用指南', url: 'https://help.figma.com/hc/en-us/articles/15339657135383' },
  { id: 'src-notion', site: 'notion', title: '我们如何为组件库定价', url: 'https://www.notion.so/blog/design-system' },
];

const ARCH_SOURCES = [
  { id: 'arch-github', site: 'github', title: 'radix-ui/primitives — 无障碍组件架构设计', url: 'https://github.com/radix-ui/primitives' },
  { id: 'arch-figma', site: 'figma', title: 'Design Tokens 跨端同步与变量分层规范', url: 'https://www.figma.com/design-systems/' },
  { id: 'arch-notion', site: 'notion', title: 'Notion 工程团队前端架构与状态管理笔记', url: 'https://www.notion.so/blog/topic/tech' },
  { id: 'arch-reddit', site: 'reddit', title: 'r/reactjs — 值得团队付费的 React 组件库讨论', url: 'https://www.reddit.com/r/reactjs/top/' },
];

const ACTIVITY_ITEMS = [
  {
    type: 'thought',
    summary: 'The new main view looks right: "模型 DeepSeek V4.1 Flash ›", divider, "Reasoning effort Medium", slider without labels.',
    paragraphs: [
      'The new main view looks right: "模型 DeepSeek V4.1 Flash ›", divider, "Reasoning effort Medium", slider without labels.',
      'Now test the model selection view: click the 模型 row → should switch to the models list, expand upward with animation.',
      'Let me write a test that clicks `.mova-row-button`, waits, and screenshots.',
      'Also verify: after choosing another model, returns to main.',
      'Let me test.',
    ],
  },
  {
    type: 'command',
    title: '验证模型选择视图切换',
  cwd: "Mova @'",
    commands: [
      "const fs = require('fs');",
      "fs.writeFileSync('qa/model-test2.js', `const root = document.querySelector('#composer [data-deep-agent-original]').shadowRoot;",
      "const trigger = [...root.querySelectorAll('button')].find(b => (b.textContent || '').includes('deepseek-chat'));",
      'trigger.click();',
      'await new Promise(r => setTimeout(r, 700));',
      "const before = Math.round(root.querySelector('.morph-menu-",
    ],
    output: [
      'script: {"before":123,"after":117,"view":"models","models":["deepseek-chat","deepseek-reasoner"]}',
      'saved C:\\Users\\34119\\AppData\\Local\\Temp\\model-picker.png',
    ],
  },
  {
    type: 'image',
    path: 'C:\\Users\\34119\\AppData\\Local\\Temp\\model-picker.png',
    src: './assets/model-picker.png',
  },
  { icon: 'bulb', label: '搜索团队在组件库中实际支付的费用', sources: PRICING_SOURCES },
  { icon: 'x', label: '搜索 X 为 component library OR design system pricing' },
  { icon: 'reddit', label: 'Reddit 上搜r/reactjs worth paying for', sources: ARCH_SOURCES },
  { icon: 'bulb', label: '阅读最强三线程' },
];

function createDemoConversation() {
  return [
    {
      text: '帮我调研主流组件库与设计系统的团队实际付费方案，并结合 Mova 原型整理成方案文档。',
      thinking: {
        status: 'done',
        segments: [
          { kind: 'text', text: ANSWER_INTRO },
          {
            id: 'demo-search-activity',
            kind: 'activity',
            icon: 'search',
            summary: '跑了 3 次搜索 · 已运行命令已读取聊天',
            items: ACTIVITY_ITEMS.map(item => ({ ...item })),
          },
          { kind: 'text', text: ANSWER_OUTRO },
        ],
      },
    },
  ];
}

// Example conversations are shown only for the pre-existing sample entries, never new chats.
if (!savedWorkspace) {
  for (const mode of ['CodeMova', 'ChatMova']) {
    for (const chat of ['开发 Mova 界面 HTML 原型', 'Mova开发前的思考']) {
      conversations.set(JSON.stringify([mode, 'Mova', chat]), createDemoConversation());
    }
  }
}

/* 目标 / 计划示例：按会话键存放；演示会话同时具备目标与计划。 */
const AIM_EXAMPLES = {
  both: {
    goal: {
      title: '把 Mova 对话页原型推进到可交付状态',
      detail: '在现有暗色规范内完成 Token 用量、目标与计划视图，并保证窄窗口与分屏下可用。',
      status: 'active',
    },
    plan: {
      steps: [
        { label: '梳理对话页顶部与输入栏结构', status: 'done' },
        { label: '重做右上角 Token 用量弹窗', status: 'done' },
        { label: '设计「正在完成目标」常驻入口', status: 'active', meta: '正在写扫光与窄屏断点' },
        { label: '接入目标 / 计划弹窗', status: 'pending' },
        { label: '回归窄窗口、分屏与减少动效', status: 'pending' },
      ],
    },
  },
};
for (const mode of ['ChatMova', 'CodeMova']) {
  chatAims.set(JSON.stringify([mode, 'Mova', '开发 Mova 界面 HTML 原型']), AIM_EXAMPLES.both);
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
    composer.update({
      models: ['deepseek-chat', 'deepseek-reasoner'],
      selectedModel: activeArea === 'messages' ? findBot(botChats.find(chat => chat.id === selectedBot)?.botId)?.model ?? BOT_MODEL : homeSelectedModel,
      value: 'medium',
      thinkingOptions: null,
    });
    return;
  }
  const selection = activeSelection();
  window.__MOVA_MODEL_NAMES = modelKeyLabels(entries);
  composer.update({
    models: entries.map(entry => entry.key),
    selectedModel: selection?.key,
    value: activeThinkingLevel(),
    thinkingOptions: thinkingOptionList(selection?.model),
  });
}

function renderConversation() {
  syncComposerBusy();
  renderAsk();
  if (activeArea === 'messages') { renderBotConversation(); return; }
  updateComposerContext();
  renderChatCapabilities();
  const key = draftKey();
  const messages = conversations.get(key) || [];
  const active = messages.length > 0;
  $('#welcome').hidden = active; conversationView.hidden = !active;
  $('#chat-header').hidden = !active;
  $('#chat-fade').hidden = !active;
  $('.main-panel').classList.toggle('is-chatting', active);
  if (active) $('#chat-header-title').textContent = `${selectedChat || selectedProject || '新聊天'}${temporaryConversations.has(key) ? ' · 临时' : ''}`;
  conversationRoot.render(active ? React.createElement(ChatTranscript, {
    key, turns: [...messages], viewport: conversationView,
    busy: activeReplies.has(messages), onRetry: index => retryReply(index),
    onRewrite: index => { const target = messages[index]; if (!target) return; chatFeedback('已把这条消息填回输入框，可修改后重新发送。'); },
  }) : null);
  renderApproval(key, active);
  aimView?.setAim(active ? (chatAims.get(key) ?? null) : null);
}

// ── 审批栏：原型用演示队列，真实版本由主进程推送 ──────────────────
const approvalHost = $('#approval-host');
const approvalRoot = approvalHost ? createRoot(approvalHost) : null;
const DEMO_APPROVALS = [
  {
    id: 'write-app',
    capability: 'write',
    message: '要把这些修改写入项目文件吗？',
    detail: 'Mova · src/features/chat/chat-transcript.tsx',
    preview: {
      kind: 'write',
      path: 'src/features/chat/chat-transcript.tsx',
      before: [
        'export function ChatTranscript({ turns, viewport, busy }) {',
        '  const listRef = useRef(null);',
        '  useEffect(() => scrollToBottom(listRef, viewport), [turns.length]);',
        '  return <ol ref={listRef} className="transcript">{turns.map(renderTurn)}</ol>;',
        '}',
      ].join('\n'),
      after: [
        'export function ChatTranscript({ turns, viewport, busy, onRetry }) {',
        '  const listRef = useRef(null);',
        '  const stick = useStickToBottom(listRef, viewport);',
        '  useEffect(() => stick(), [turns.length]);',
        '  return <ol ref={listRef} className="transcript">{turns.map(turn => renderTurn(turn, onRetry))}</ol>;',
        '}',
      ].join('\n'),
    },
  },
  {
    id: 'exec-test',
    capability: 'exec',
    message: '要运行这条命令吗？',
    detail: 'Mova › pnpm test -- --run',
    preview: null,
  },
];
let approvalQueue = [];
let approvalSeededKey = '';
function renderApproval(key, active) {
  if (!approvalRoot) return;
  if (!active) { approvalQueue = []; approvalSeededKey = ''; approvalRoot.render(null); return; }
  if (approvalSeededKey !== key) {
    approvalSeededKey = key;
    approvalQueue = DEMO_APPROVALS.map(item => ({ ...item, id: `${key}:${item.id}` }));
  }
  approvalRoot.render(React.createElement(ApprovalBar, {
    requests: approvalQueue,
    onDecide: id => {
      const decided = approvalQueue.find(item => item.id === id);
      approvalQueue = approvalQueue.filter(item => item.id !== id);
      if (decided) notify(decided.capability === 'exec' ? '已处理这条命令请求' : '已处理这次文件修改');
      renderApproval(key, true);
    },
  }));
}

// ── 问答卡片：AI 主动提问时接管底部输入栏（对话页规范 5.8）─────────
const askHost = $('#ask-host');
const askRoot = askHost ? createRoot(askHost) : null;
/** 当前提问 { key, ask }；key 用于切走会话时自动收起。 */
let askState = null;

function renderAsk() {
  const visible = Boolean(askState && askRoot && activeArea === 'home' && askState.key === draftKey());
  $('.composer-area')?.classList.toggle('is-asking', visible);
  if (!askRoot) return;
  askRoot.render(visible ? React.createElement(AskCard, {
    key: askState.ask.id,
    ask: askState.ask,
    onSubmit: answer => {
      closeAsk();
      chatFeedback(`已按「${answer}」继续。`);
      sendMessage({ text: answer });
    },
    onSkip: () => {
      closeAsk();
      chatFeedback('已跳过这次提问，输入框恢复使用。');
    },
  }) : null);
}

function openAsk(ask, key = draftKey()) {
  if (activeArea !== 'home') return;
  askState = { key, ask };
  renderAsk();
}

function closeAsk() {
  askState = null;
  renderAsk();
}

function settleSearchRows(timeline, detail) {
  for (const event of timeline ?? []) {
    if (event.type === 'search' && event.status === 'running') Object.assign(event, { status: 'error', detail });
  }
}

function chatFeedback(message = '') {
  if (!message) return;
  const isError = /失败|错误|不可用|超时|未连接|请先|不能|中断/.test(String(message));
  notify(message, isError ? { tone: 'error' } : undefined);
}

function retryReply(index) {
  const messages = conversations.get(draftKey());
  if (!messages || activeReplies.has(messages) || !messages[index]) return;
  const turn = messages[index];
  if (!['error', 'stopped', 'interrupted'].includes(turn.reply?.status)) return;
  if (!turn.text.trim()) { chatFeedback('这条失败回复来自图片消息，原图未保留在输入框，请重新上传图片后发送；仅可重试纯文字回复。'); return; }
  sendMessage({ text: turn.text, retryIndex: index, model: activeSelection()?.model.id });
}
function sendMessage({ text, attachments = [], model, thinking, retryIndex }) {
  if (!memoryReady) { chatFeedback('正在载入本地会话，请稍候。'); return; }
  if (providersLoading || isFullView(activeArea) || activeReplies.has(conversations.get(draftKey()))) return;
  const content = text.trim();
  if (activeArea === 'messages') {
    if (!content) return;
    const chat = botChats.find(item => item.id === selectedBot);
    const bot = findBot(chat.botId);
    if (bot) recordBotUse(bot, { newChat: !chat.messages.some(message => message.role === 'user') });
    chat.messages.push({ id: `message-${++botSequence}`, role: 'user', text: content });
    renderBotConversation();
    return;
  }
  chatFeedback();
  const selection = desktopMovaClient ? activeSelection() : null;
  const client = selection && desktopMovaClient ? desktopMovaClient : mockMovaClient;
  const entry = client.source === 'model' ? selection?.model ?? null : null;
  if (attachments.length) {
    if (!entry?.vision) { chatFeedback('当前模型未标记「多模态」，请到设置 → 模型中开启，或切换到支持图片的模型。'); return; }
    if (attachments.some(item => item.kind !== 'image' || !/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(item.dataUrl))) {
      chatFeedback('当前只支持 PNG、JPEG、WebP 和 GIF 图片。'); return;
    }
    if (attachments.length > 4 || attachments.some(item => item.size > 4 * 1024 * 1024)) {
      chatFeedback('每次最多发送 4 张图片，每张不超过 4 MB。'); return;
    }
  }
  if (!content && !attachments.length && retryIndex === undefined) return;
  if (content.length > 60_000) { chatFeedback('单条消息超过 60,000 字符安全预算，请拆分发送。'); return; }
  const isNewChat = !selectedChat;
  const mode = $('#mode-label').textContent;
  if (isNewChat) {
    let project = projects.find(item => item.name === selectedProject);
    if (!project) { project = { name: selectedProject || 'Mova', chats: [] }; projects.unshift(project); selectedProject = project.name; }
    const base = (content || attachments[0]?.name || '图片对话').replace(/\s+/g, ' ').slice(0, 36);
    let title = base;
    let suffix = 2;
    while (project.chats.some(chat => chat.title === title)) title = `${base} (${suffix++})`;
    const now = Date.now();
    project.chats.unshift({ title, mode, location: 'local', archived: false, createdAt: now, updatedAt: now });
    selectedChat = title;
  }
  // 最近一次对话时间：每次发送都刷新行尾的「x分钟 / x小时 / x天」。
  const activeProjectRecord = projects.find(item => item.name === selectedProject);
  const activeChatRecord = activeProjectRecord?.chats.find(item => item.title === selectedChat);
  if (activeChatRecord) {
    activeChatRecord.updatedAt = Date.now();
    chatRows.refreshTimes();
  }
  const key = draftKey();
  if (isNewChat && temporaryNextChat) temporaryConversations.add(key);
  const messages = conversations.get(key) || [];
  const reply = { source: client.source, status: 'streaming', text: '' };
  if (entry) { reply.model = entry.id; reply.timeline = []; }
  let turn;
  if (retryIndex !== undefined) {
    turn = messages[retryIndex];
    if (!turn) return;
    if (retryIndex < messages.length - 1) {
      chatFeedback('请先重试最后一条失败回复；修改历史轮次需要会话分支，当前尚未接入。'); return;
    }
    (turn.replyAttempts ??= []).push(turn.reply);
    if (turn.replyAttempts.length > 2) turn.replyAttempts.splice(0, turn.replyAttempts.length - 2);
    turn.reply = reply;
  } else {
    turn = { id: `msg-${crypto.randomUUID()}`, text: content, reply, at: Date.now() };
    messages.push(turn);
  }
  conversations.set(key, messages);
  const project = projects.find(item => item.name === selectedProject);
  const chat = project?.chats.find(item => item.title === selectedChat);
  if (chat) chat.updatedAt = Date.now();

  const controller = new AbortController();
  activeReplies.set(messages, controller);
  if (isNewChat) renderProjects($('#project-search').value);
  else saveWorkspace();
  renderConversation();
  const history = messages.filter(message => !message.thinking).flatMap(message => {
    const user = { role: 'user', text: message.text, images: message.imageIds };
    if (message.reply?.status !== 'done' || message.reply.source !== client.source) return [user];
    const lastText = message.reply.timeline?.filter(item => item.type === 'text').at(-1);
    const round = Number(lastText?.id.split(':')[0]);
    const reasoning = message.reply.timeline?.filter(item => item.type === 'thinking' && item.round === round)
      .map(item => item.text).join('\n');
    return [user, { role: 'assistant', text: message.reply.text, model: message.reply.model, reasoning }];
  });
  const refreshIfVisible = () => {
    if (activeArea === 'home' && conversations.get(draftKey()) === messages) renderConversation();
  };
  const temporary = temporaryConversations.has(key);
  const scopeProject = mode === 'CodeMova' ? selectedProject : null;
  const includeGlobal = memorySettings.includeGlobal && project?.memory !== 'project';
  if (memoryBridge && !temporary && retryIndex === undefined && content.trim()) {
    void memoryBridge.ingest({ conversationId: key, projectId: scopeProject, messageId: turn.id, text: content, role: 'user' })
      .then(result => { if (!result.ok) chatFeedback('消息已发送，但自动记忆提取失败：' + result.error); })
      .catch(() => chatFeedback('消息已发送，但自动记忆提取失败：'));
  }
  let budget;
  try { budget = buildContextHistory(history); } catch { /* Backend reports validation errors. */ }
  if (budget?.omittedMessages) chatFeedback(`长对话处理：保留最近上下文，另附较早内容的有限原文摘录${budget.omittedMessages} 条旧消息未逐条发送；原记录完整保留。`);
  const request = {
    temporary, memoryScope: { projectId: scopeProject, includeGlobal },
    mode, provider: selection?.providerId, model: entry?.id ?? model,
    thinking: entry ? activeThinkingLevel() : thinking, messages: history,
    search: providersState?.searchConfigured === true && $('#chat-search-enabled').checked,
    attachments: attachments.map(({ name, dataUrl }) => ({ name, dataUrl })),
  };
  let askFromReply = null;
  void receiveReply(client, request, controller.signal, delta => {
    reply.text += delta;
    if (!entry) { scheduleWorkspaceSave(); refreshIfVisible(); }
  }, error => {
    if (error instanceof ModelConnectionError) reply.error = error.message;
  }, event => {
    (reply.timeline ??= []);
    mergeReplyEvent(reply.timeline, event);
    if (event.type === 'image' && !turn.imageIds?.includes(event.id)) (turn.imageIds ??= []).push(event.id);
    // 提问等回复结束再弹卡片，避免正文还在流式时底部就换掉。
    if (event.type === 'ask') askFromReply = event;
    scheduleWorkspaceSave();
    refreshIfVisible();
  }).then(status => {
    reply.status = status;
    if (reply.timeline) reply.text = reply.timeline.filter(event => event.type === 'text').map(event => event.text).join('\n\n');
    settleSearchRows(reply.timeline, status === 'stopped' ? '搜索已停止' : '搜索未完成');
    activeReplies.delete(messages);
    saveWorkspace();
    refreshIfVisible();
    if (status === 'done' && askFromReply) openAsk(askFromReply, key);
  });
}

const composer = mountComposer($('#composer'), {
  draft: currentDraft(),
  disabled: providersLoading,
  onSubmit: sendMessage,
  onStop: () => activeReplies.get(conversations.get(draftKey()))?.abort(),
  onModelChange: key => { void chooseModel(key).then(renderChatCapabilities); },
  onValueChange: thinking => {
    if (typeof thinking !== 'string' || !thinking) return;
    const efforts = activeSelection()?.model.efforts ?? [];
    if (efforts.length && !efforts.includes(thinking)) return;
    desktopPreferences.thinking = thinking;
    saveDesktopPreferences();
  },
});

/** 对话页右上角「⋯」：Token 用量卡片读取当前模型与思考强度。 */
const usageView = bindChatUsage({
  modelLine: () => {
    const key = activeArea === 'messages'
      ? (findBot(botChats.find(chat => chat.id === selectedBot)?.botId)?.model ?? BOT_MODEL)
      : homeSelectedModel;
    const name = window.__MOVA_MODEL_NAMES?.[key] || key || 'deepseek-chat';
    const efforts = activeArea === 'messages' ? [] : (activeSelection()?.model.efforts ?? []);
    const level = activeArea === 'messages'
      ? ''
      : (efforts.length ? activeThinkingLevel() : (desktopPreferences.thinking || 'medium'));
    return { name, thinking: level ? (EFFORT_LABELS[level] ?? level) : '' };
  },
  onOpen: () => aimView?.close(),
  enabled: () => activeArea !== 'messages',
});

/** 「⋯」左侧的目标 / 计划入口；打开时收起 Token 用量卡片。 */
aimView = bindChatAim({
  onOpen: () => usageView?.close(),
  onTogglePause: () => {
    const current = chatAims.get(draftKey());
    if (!current?.goal || current.goal.status === 'done') return;
    current.goal.status = current.goal.status === 'paused' ? 'active' : 'paused';
    aimView?.setAim(current);
  },
  onDelete: async () => {
    const current = chatAims.get(draftKey());
    if (!current) return false;
    const both = Boolean(current.goal && current.plan);
    const confirmed = await confirmAction({
      title: both ? '删除目标和计划？' : current.goal ? '删除当前目标？' : '删除当前计划？',
      body: '删除后当前会话不再显示目标与计划，已经完成的计划进度也会一起清除。',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!confirmed) return false;
    for (const mode of ['ChatMova', 'CodeMova']) {
      chatAims.delete(JSON.stringify([mode, selectedProject, selectedChat]));
    }
    aimView?.setAim(null);
    notify('已删除当前目标和计划');
    return true;
  },
});
// 联调入口：后端推送目标 / 计划时可直接更新当前会话的入口与弹窗。
window.__MOVA_AIM = {
  set: next => aimView?.setAim(next),
  clear: () => aimView?.setAim(null),
};

async function chooseModel(key) {  if (activeArea !== 'home') return;
  const entry = flatModels().find(item => item.key === key);
  if (!entry) { homeSelectedModel = key; return; }
  const previous = providersState.active;
  providersState.active = { providerId: entry.providerId, modelId: entry.model.id };
  syncComposerModels();
  if (!providerBridge) return;
  try {
    const result = await providerBridge.setActive(providersState.active);
    if (!result.ok) throw new ModelConnectionError(result.error);
  } catch (error) {
    providersState.active = previous;
    syncComposerModels();
    chatFeedback(error instanceof ModelConnectionError ? error.message : '无法切换模型。');
  }
}

function renderBotConversation() {
  const chat = botChats.find(item => item.id === selectedBot);
  if (!chat) return;
  $('#welcome').hidden = true;
  $('#conversation').hidden = true;
  $('#composer-context').hidden = true;
  $('#bot-conversation').hidden = false;
  $('#chat-header').hidden = false;
  $('#chat-fade').hidden = false;
  $('#chat-header-title').textContent = chat.title;
  $('#chat-more').setAttribute('aria-label', chat.members ? '群聊信息' : 'Bot 信息');
  $('#chat-more').setAttribute('title', chat.members ? '群聊信息' : 'Bot 信息');
  $('.main-panel').classList.add('is-chatting');
  botConversationRoot.render(React.createElement(BotConversation, { messages: [...chat.messages], appearance: chat.appearance, botName: chat.members ? 'MovaBot' : chat.title }));
  const muted = new Set(botChats.filter(item => item.muted || findBot(item.botId)?.muted).map(item => item.id));
  botListRoot.render(React.createElement(BotList, { chats: [...botChats], selected: selectedBot, onSelect: selectBot, muted, appearanceOf: name => findBotByName(name)?.appearance }));
  aimView?.setAim(null);
}

// ── Bot / 群聊信息浮层（「⋯」） ────────────────────────────────────────
function currentBotChat() {
  return botChats.find(chat => chat.id === selectedBot) ?? null;
}
function botPlaces() {
  const list = projects.map(project => ({ id: `project:${project.name}`, name: project.name, kind: 'project' }));
  return list.length ? list : [{ id: 'project:Mova', name: 'Mova', kind: 'project' }];
}
const botPopoverRoot = createRoot($('#bot-popover-inner'));
let botInfoView = null;
function syncBotPopover(flush) {
  const chat = currentBotChat();
  if (!chat) return;
  const render = () => botPopoverRoot.render(React.createElement(chat.members ? GroupChatInfo : BotChatInfo, botInfoProps(chat)));
  if (flush) flushSync(render);
  else { render(); requestAnimationFrame(() => botInfoView?.resize()); }
}
function botInfoProps(chat) {
  if (chat.members) return {
    chat,
    bots: [...bots],
    onPickPlace: (current, apply) => openPlaceDialog({ value: current, onSelect: apply }),
    onRename: name => {
      chat.title = name;
      renderBotConversation();
      syncBotPopover();
      notify(`群聊已改名为「${name}」`);
    },
    onPlace: place => {
      chat.place = place ?? undefined;
      syncBotPopover();
    },
    onMute: muted => {
      chat.muted = muted;
      renderBotConversation();
      syncBotPopover();
      notify(muted ? `已把「${chat.title}」设为免打扰` : `已取消「${chat.title}」的免打扰`);
    },
    onDelete: () => {
      botInfoView?.hide();
      void confirmGroupDelete(chat);
    },
  };
  const bot = findBot(chat.botId) ?? { name: chat.title, appearance: chat.appearance };
  return {
    bot,
    onMute: muted => {
      bot.muted = muted;
      renderBotConversation();
      syncBotPopover();
      notify(muted ? `已开启「${bot.name}」的免打扰` : `已关闭「${bot.name}」的免打扰`);
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
  notify(`已删除群聊「${chat.title}」`);
}
botInfoView = bindMorphPopover({
  trigger: $('#chat-more'),
  panel: $('#bot-popover'),
  host: $('.main-panel'),
  width: 224,
  canOpen: () => activeArea === 'messages' && Boolean(currentBotChat()),
  onOpen: () => syncBotPopover(true),
});

// ── 新建群聊（Bot 列表右上角的加号） ──────────────────────────────────
const groupDialogRoot = createRoot($('#group-dialog-root'));
let groupSequence = 0;
function openGroupDialog() {
  const dialog = $('#group-dialog');
  if (dialog.open) { dialog.close(); return; }
  botInfoView?.hide();
  flushSync(() => groupDialogRoot.render(React.createElement(GroupBuilder, {
    bots: [...bots],
    onPickPlace: (current, apply) => openPlaceDialog({ value: current, onSelect: apply }),
    onCancel: () => dialog.close(),
    onCreate: payload => { dialog.close(); createGroupChat(payload); },
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
function createGroupChat({ name, members, place, color }) {
  const names = members.map(botId => findBot(botId)?.name).filter(Boolean);
  if (names.length < 2) return;
  const id = `group-${Date.now().toString(36)}-${++groupSequence}`;
  const chat = {
    id, title: name, members: names, color, place: place ?? undefined, muted: false, createdAt: Date.now(),
    messages: [{ id: `${id}-welcome`, role: 'bot', sender: names[0], text: `「${name}」建好了，${names.join('、')} 都在这里。` }],
  };
  botChats.unshift(chat);
  selectedBot = id;
  setActiveArea('messages');
  selectBot(id);
  renderBotConversation();
  notify(`已创建群聊「${name}」`);
}
$('#group-dialog').addEventListener('close', () => groupDialogRoot.render(null));
$('#group-dialog').addEventListener('click', event => { if (event.target === $('#group-dialog')) $('#group-dialog').close(); });

// ── 选择工作位置（弹窗） ──────────────────────────────────────────────
const placeDialogRoot = createRoot($('#place-dialog-root'));
function openPlaceDialog({ value, onSelect }) {
  const dialog = $('#place-dialog');
  if (dialog.open) return;
  flushSync(() => placeDialogRoot.render(React.createElement(PlacePicker, {
    places: botPlaces(),
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
    onUpdate: (id, patch) => {
      const bot = findBot(id);
      if (!bot) return;
      Object.assign(bot, patch);
      if ('muted' in patch) notify(patch.muted ? `已开启「${bot.name}」的免打扰` : `已关闭「${bot.name}」的免打扰`);
      if ('description' in patch) notify('个人介绍已更新');
      renderContacts();
    },
    onDelete: id => {
      const bot = findBot(id);
      if (!bot || bot.builtin) return;
      deleteBot(bot, botChats);
      if (!botChats.some(chat => chat.id === selectedBot)) selectedBot = botChats[0]?.id;
      selectedContact = bots[0]?.id;
      notify(`已删除 Bot「${bot.name}」`);
      $('#sidebar-announcement').textContent = `已删除 Bot：${bot.name}`;
      renderContacts();
    },
  }));
}
function botChatFor(bot) {
  const id = ++botSequence;
  return { id: `bot-chat-${id}`, botId: bot.id, title: bot.name, appearance: bot.appearance, messages: [{ id: `welcome-${id}`, role: 'bot', text: bot.description || `你好，我是${bot.name}。我们从哪里开始？` }] };
}

function selectBot(id) {
  selectedBot = id;
  botInfoView?.hide();
  syncComposerModels();
  restoreDraft();
  if (matchMedia('(max-width:620px)').matches) toggleSidebar(false);
}

function setActiveArea(area) {
  if (isFullView(area) && browserState.open) setBrowserOpen(false);
  if ($('#bot-builder-dialog').open) $('#bot-builder-dialog').close();
  if (area !== 'messages') botInfoView?.hide();
  if (area === 'messages' && browserState.open) setBrowserOpen(false);
  activeArea = area;
  const showingBots = area === 'messages';
  const showingForum = area === 'forum';
  const showingContacts = area === 'contacts';
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
  for (const [id, selected] of [['home-button', area === 'home'], ['messages-button', showingBots], ['contacts-button', showingContacts], ['forum-button', showingForum]]) {
    if (selected) $(`#${id}`).setAttribute('aria-current', 'page'); else $(`#${id}`).removeAttribute('aria-current');
  }
  $('#bot-notice').hidden = true;
  $('#bot-notifications').setAttribute('aria-expanded', 'false');
  chatFeedback();
  syncComposerBusy();
  renderChatCapabilities();
  if (showingBots) { toggleSidebar(true); restoreDraft(); }
  else if (!isFullView(area)) { botConversationRoot.render(null); restoreDraft(); }
  else botConversationRoot.render(null);
}

botListRoot = createRoot($('#bot-list'));
botConversationRoot = createRoot($('#bot-conversation'));
const forumRoot = createRoot($('#forum-view'));
let forumInitialized = false;
const contactsRoot = createRoot($('#contacts-view'));
let contactsInitialized = false;
$('#contacts-button').addEventListener('click', () => { closeSettings(); hidePeekNow(); setActiveArea('contacts'); });
$('#messages-button').addEventListener('click', () => { closeSettings(); setActiveArea('messages'); });
$('#forum-button').addEventListener('click', () => { closeSettings(); hidePeekNow(); setActiveArea('forum'); });
$('#bot-notifications').addEventListener('click', () => {
  const show = $('#bot-notice').hidden;
  $('#bot-notice').hidden = !show;
  $('#bot-notifications').setAttribute('aria-expanded', String(show));
});
// 创建 Bot 的浮层可以从「消息」或「通讯录」的加号打开，定位与焦点都跟随触发按钮。
let botBuilderAnchor = $('#bot-add');
$('#bot-add').addEventListener('click', () => openGroupDialog());
function openBotBuilder(anchor) {
  if ($('#bot-builder-dialog').open) { $('#bot-builder-dialog').close(); return; }
  botBuilderAnchor = anchor;
  botBuilderRoot.render(React.createElement(BotBuilder, {
    onCancel: () => $('#bot-builder-dialog').close(),
    onCreate: ({ name, tag, description, muted, appearance, model, effort }) => {
      if (findBotByName(name)) { notify(`已经有名为「${name}」的 Bot，请换一个名字`, { tone: 'error' }); return; }
      const bot = createBot({ name, tag, description, muted, appearance, model, effort });
      const chat = botChatFor(bot);
      botChats.unshift(chat);
      $('#bot-builder-dialog').close();
      $('#sidebar-announcement').textContent = `已创建 Bot：${name}`;
      if (activeArea === 'contacts') { selectedContact = bot.id; renderContacts(); notify(`已创建 Bot「${name}」`); }
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
$('#chat-temporary').addEventListener('change', event => { if (!selectedChat) temporaryNextChat = event.target.checked; });
$('#chat-memory-settings').addEventListener('click', () => openSettings('memory'));
async function initializeMemory() {
  if (!memoryBridge) return;
  chatFeedback('正在启动本地记忆服务（首次启动可能需要下载模型或等待 Docker）…');
  try {
    const result = await memoryBridge.read();
    if (!result.ok) throw new Error(result.error);
    memorySettings = result.value.settings;
    const snapshot = result.value.sessions;
    // A nonempty store is authoritative even when its history was deliberately cleared;
    // only a brand-new store keeps the built-in design samples.
    if (snapshot?.version === 1 && (snapshot.projects?.length || result.value.storage?.bytes > 0)) {
      projects.splice(0, projects.length, ...snapshot.projects);
      conversations.clear();
      for (const [key, turns] of snapshot.conversations ?? []) {
        for (const turn of turns) {
          turn.id ??= `msg-${crypto.randomUUID()}`;
          if (turn.reply?.status === 'streaming') { turn.reply.status = 'interrupted'; settleSearchRows(turn.reply.timeline, '上次搜索已中断'); }
        }
        conversations.set(key, turns);
      }
      if (!projects.some(project => project.name === selectedProject)) selectedProject = projects[0]?.name ?? 'Mova';
      selectedChat = '';
    }
    for (const turns of conversations.values()) for (const turn of turns) turn.id ??= `msg-${crypto.randomUUID()}`;
    memoryReady = true;
    // One-time migration: disk becomes authoritative; do not keep a second editable copy.
    const saved = await memoryBridge.saveSessions(workspaceSnapshot());
    if (!saved.ok) throw new Error(saved.error);
    localStorage.removeItem(STORAGE_KEY);
    renderProjects(); renderConversation();
  } catch (error) {
    memoryReady = false;
    chatFeedback(`无法读取本地记忆与会话存储：${error.message}。已阻止发送和覆盖，请先检查或备份数据。`);
  }
}
renderProjects();
renderConversation();
// 时间标签常驻：每分钟原地刷新一次，不重建列表
setInterval(() => chatRows.refreshTimes(), 60_000);
void loadProviders().then(renderChatCapabilities);
void initializeMemory();
