import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BOT_CONTACTS,
  CODEMOVA_PROJECTS,
  EFFORT_CATALOG,
  MOVA_APP_MODES,
  MOVA_CODE_BLOCKS,
  MOVA_MODELS,
  MOVABOT_THREADS,
  RECENT_CONVERSATIONS,
} from '../data/movaData';
import type {
  BotContactProfile,
  BotThreadItem,
  CodeHostScope,
  EffortLevelId,
  LiquidGlassConfig,
  MovaAppMode,
  MovaModelOption,
  ScreenPreset,
} from '../types';
import { BotMascotAvatar } from './BotAvatars';
import {
  ArrowUpSendIcon,
  CheckTinyIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ComposeSquareIcon,
  CopySheetsIcon,
  DesktopCopyIcon,
  DesktopRegenerateIcon,
  EllipsisRowIcon,
  FolderProjectIcon,
  HostCloudIcon,
  HostLocalIcon,
  MenuLinesIcon,
  ModeChatBubbleIcon,
  PlusIcon,
  SearchMagnifierIcon,
  SidebarCodeMovaIcon,
  SidebarMovaBotGridIcon,
  VoiceWaveIcon,
} from './IOSIcons';
import { IOSKeyboard } from './IOSKeyboard';
import { IOSLiquidGlass } from './IOSLiquidGlass';
import { IOSPhotoCameraSheet } from './IOSPhotoCameraSheet';
import { IOSHomeIndicator, IOSStatusBar } from './IOSStatusBar';
import { MovaBotChatView, MovaBotHomeView } from './MovaBotViews';
import { MovaEffortModelOverlay } from './MovaEffortModelOverlay';
import { BotSettingsView, SystemSettingsView } from './SettingsViews';

interface MovaPhoneScreenProps {
  preset: ScreenPreset;
  resetSeed: number;
  glassConfig: LiquidGlassConfig;
}

interface UserSentItem {
  id: string;
  text: string;
  reply: string;
  timeLabel: string;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function formatMovaTime(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;
}

export const MovaPhoneScreen: React.FC<MovaPhoneScreenProps> = ({
  preset,
  resetSeed,
  glassConfig,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isBotPreset = (p: ScreenPreset) =>
    p === 'bot-list' || p === 'bot-chat' || p === 'bot-contacts' || p === 'bot-settings';

  const [drawerOpen, setDrawerOpen] = useState(preset === 'drawer' || preset === 'bot-contacts');
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(preset === 'settings');
  const [keyboardOpen, setKeyboardOpen] = useState(preset === 'keyboard');
  const [title, setTitle] = useState('工作');
  const [draft, setDraft] = useState('');
  const defaultModel = MOVA_MODELS.find((m) => m.id === 'gemini-4-hydrogen') ?? MOVA_MODELS[0];
  const [selectedModel, setSelectedModel] = useState<MovaModelOption>(defaultModel);
  const [effort, setEffort] = useState<EffortLevelId>('high');
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [mediaSheetMode, setMediaSheetMode] = useState<null | 'photos' | 'camera'>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [drawerSearching, setDrawerSearching] = useState(false);
  const [drawerQuery, setDrawerQuery] = useState('');
  const [appMode, setAppMode] = useState<MovaAppMode>(isBotPreset(preset) ? 'MovaBot' : 'ChatMova');
  const [botSubScreen, setBotSubScreen] = useState<'list' | 'chat' | 'settings'>(
    preset === 'bot-chat' ? 'chat' : preset === 'bot-settings' ? 'settings' : 'list'
  );
  const [activeBotThread, setActiveBotThread] = useState<BotThreadItem>(MOVABOT_THREADS[0]);
  const [activeBotContact, setActiveBotContact] = useState<BotContactProfile>(BOT_CONTACTS[0]);
  const [isCreatingBot, setIsCreatingBot] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [codeHost, setCodeHost] = useState<CodeHostScope>('local');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'proj-mova-core': true,
    'proj-linux-cli': true,
  });
  const [activeConvId, setActiveConvId] = useState('code-diff');
  const [toastText, setToastText] = useState<string | null>(null);
  const [sentItems, setSentItems] = useState<UserSentItem[]>([]);

  const showToast = (msg: string) => {
    setToastText(msg);
  };

  useEffect(() => {
    if (!toastText) return;
    const t = window.setTimeout(() => setToastText(null), 1900);
    return () => window.clearTimeout(t);
  }, [toastText]);

  // Restore exact screenshot pose whenever preset or resetSeed changes
  useEffect(() => {
    setDrawerOpen(preset === 'drawer' || preset === 'bot-contacts');
    setSystemSettingsOpen(preset === 'settings');
    setKeyboardOpen(preset === 'keyboard');
    setTitle('工作');
    setDraft('');
    setSelectedModel(defaultModel);
    setEffort('high');
    setModelSheetOpen(false);
    setMoreMenuOpen(false);
    setMediaSheetMode(null);
    setDrawerSearching(false);
    setDrawerQuery('');
    setAppMode(isBotPreset(preset) ? 'MovaBot' : 'ChatMova');
    setBotSubScreen(
      preset === 'bot-chat' ? 'chat' : preset === 'bot-settings' ? 'settings' : 'list'
    );
    setActiveBotThread(MOVABOT_THREADS[0]);
    setActiveBotContact(BOT_CONTACTS[0]);
    setIsCreatingBot(false);
    setModeMenuOpen(false);
    setCodeHost('local');
    setExpandedFolders({ 'proj-mova-core': true, 'proj-linux-cli': true });
    setSentItems([]);

    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      if (preset === 'chat') {
        scrollRef.current.scrollTop = 48;
      } else if (preset === 'keyboard') {
        scrollRef.current.scrollTop = 386;
      } else {
        scrollRef.current.scrollTop = 48;
      }
    });
  }, [preset, resetSeed]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    showToast('已复制到剪贴板');
    window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
  };

  const handleSend = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const nextItem: UserSentItem = {
      id: `${Date.now()}`,
      text: trimmed,
      reply: `已通过 ${selectedModel.name}（思考强度：${EFFORT_CATALOG[effort].label}）接收指令，正在同步至 Mova Linux 云端服务处理。`,
      timeLabel: formatMovaTime(new Date()),
    };
    setSentItems((prev) => [...prev, nextItem]);
    setDraft('');
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }
    });
  };

  const q = drawerQuery.trim().toLowerCase();
  const filteredConversations = RECENT_CONVERSATIONS.filter((item) =>
    item.title.toLowerCase().includes(q)
  );

  const groupedBotContacts = useMemo(() => {
    const matches = BOT_CONTACTS.filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        b.roleTitle.toLowerCase().includes(q) ||
        b.tag.toLowerCase().includes(q)
    );
    const map = new Map<string, BotContactProfile[]>();
    for (const bot of matches) {
      const list = map.get(bot.indexLetter) ?? [];
      list.push(bot);
      map.set(bot.indexLetter, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [q]);

  const filteredProjects = CODEMOVA_PROJECTS.filter(
    (proj) =>
      proj.host === codeHost &&
      (!q ||
        proj.name.toLowerCase().includes(q) ||
        proj.chats.some((c) => c.title.toLowerCase().includes(q)))
  );

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => ({ ...prev, [folderId]: !prev[folderId] }));
  };

  const renderModeIcon = (mode: MovaAppMode) => {
    switch (mode) {
      case 'ChatMova':
        return <ModeChatBubbleIcon size={18} color="#F5F5F7" />;
      case 'CodeMova':
        return <SidebarCodeMovaIcon size={19} color="#F5F5F7" />;
      case 'MovaBot':
        return <SidebarMovaBotGridIcon size={18} color="#F5F5F7" />;
    }
  };

  return (
    <div
      className={`mova-iphone-frame ${glassConfig.ambientGlow ? 'has-ambient-glow' : ''}`}
      onWheel={(e) => {
        // Allow native vertical chat scrolling unless Ctrl/Meta is held for canvas zoom
        if (!e.ctrlKey && !e.metaKey) {
          e.stopPropagation();
        }
      }}
    >
      {/* Titanium Hardware Bezel & Side Buttons */}
      <div className="iphone-hw-btn iphone-hw-btn--action" />
      <div className="iphone-hw-btn iphone-hw-btn--vol-up" />
      <div className="iphone-hw-btn iphone-hw-btn--vol-down" />
      <div className="iphone-hw-btn iphone-hw-btn--power" />

      <div className="mova-iphone-screen">
        {/* Optional Ambient Refraction Mesh for testing Liquid Glass distortion */}
        {glassConfig.ambientGlow && (
          <div className="mova-ambient-mesh" aria-hidden="true">
            <span className="mesh-orb mesh-orb--blue" />
            <span className="mesh-orb mesh-orb--indigo" />
            <span className="mesh-orb mesh-orb--cyan" />
          </div>
        )}

        {/* Top iOS 26 Status Bar */}
        <IOSStatusBar
          time={systemSettingsOpen ? '12:46' : drawerOpen ? '18:19' : '18:18'}
          carrierBadge="5GA"
          battery={systemSettingsOpen ? 62 : drawerOpen ? 43 : 44}
          cameraActive={mediaSheetMode === 'camera'}
        />

        {/* ==================== LEFT SIDEBAR DRAWER (Screenshot 3) ==================== */}
        <aside
          className={`mova-drawer-layer ${drawerOpen ? 'is-open' : ''}`}
          aria-hidden={!drawerOpen}
          onClick={() => setModeMenuOpen(false)}
        >
          <div className="mova-drawer-top">
            <button
              type="button"
              className={`mova-drawer-mode-trigger ${modeMenuOpen ? 'is-open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setModeMenuOpen((v) => !v);
              }}
              aria-expanded={modeMenuOpen}
            >
              <span className="mova-drawer-brand">{appMode}</span>
              <ChevronDownIcon
                size={17}
                color="rgba(235, 235, 245, 0.72)"
                className="mova-drawer-mode-chevron"
              />
            </button>

            <IOSLiquidGlass
              width={42}
              height={42}
              cornerRadius={21}
              config={glassConfig}
              variant="bar"
              onClick={(e) => {
                e.stopPropagation();
                setModeMenuOpen(false);
                setDrawerSearching((v) => !v);
              }}
              title="搜索对话或项目"
            >
              <SearchMagnifierIcon size={19} color="#F5F5F7" />
            </IOSLiquidGlass>
          </div>

          {/* iOS 26 Native Liquid Glass Pull-Down Mode Picker (Icon in front, Check on right) */}
          {modeMenuOpen && (
            <div className="mova-mode-glass-menu" onClick={(e) => e.stopPropagation()}>
              <IOSLiquidGlass
                width={220}
                height={146}
                cornerRadius={20}
                config={glassConfig}
                variant="menu"
                interactive={false}
                contentClassName="mova-ios-uimenu"
              >
                {MOVA_APP_MODES.map((m, idx) => {
                  const selected = m.id === appMode;
                  return (
                    <React.Fragment key={m.id}>
                      {idx > 0 && <div className="mova-uimenu-sep" />}
                      <button
                        type="button"
                        className={`mova-uimenu-item ${selected ? 'is-selected' : ''}`}
                        onClick={() => {
                          setAppMode(m.id);
                          setModeMenuOpen(false);
                          if (m.id === 'MovaBot') {
                            setBotSubScreen('list');
                          }
                        }}
                      >
                        <span className="mova-uimenu-icon">{renderModeIcon(m.id)}</span>
                        <span className="mova-uimenu-label">{m.label}</span>
                        <span className="mova-uimenu-check">
                          {selected && <CheckTinyIcon size={16} color="#FFFFFF" />}
                        </span>
                      </button>
                    </React.Fragment>
                  );
                })}
              </IOSLiquidGlass>
            </div>
          )}

          {drawerSearching && (
            <div className="mova-drawer-search-box" onClick={(e) => e.stopPropagation()}>
              <SearchMagnifierIcon size={15} color="#8E8E93" />
              <input
                type="text"
                value={drawerQuery}
                onChange={(e) => setDrawerQuery(e.target.value)}
                placeholder={appMode === 'CodeMova' ? '搜索项目或记录...' : '搜索对话...'}
                autoFocus
              />
              {drawerQuery && (
                <button type="button" onClick={() => setDrawerQuery('')}>
                  清除
                </button>
              )}
            </div>
          )}

          <div className="mova-drawer-scroll">
            {appMode === 'CodeMova' ? (
              <>
                {/* Top Host Rows matching Image 2 (Icon + Label list rows + Divider) */}
                <nav className="mova-drawer-PrimaryNav" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className={`mova-drawer-nav-row ${codeHost === 'local' ? 'is-active' : ''}`}
                    onClick={() => setCodeHost('local')}
                  >
                    <span className="mova-drawer-nav-icon">
                      <HostLocalIcon size={20} color="#F5F5F7" />
                    </span>
                    <span className="mova-drawer-nav-label">本地</span>
                  </button>

                  <button
                    type="button"
                    className={`mova-drawer-nav-row ${codeHost === 'cloud' ? 'is-active' : ''}`}
                    onClick={() => setCodeHost('cloud')}
                  >
                    <span className="mova-drawer-nav-icon">
                      <HostCloudIcon size={21} color="#F5F5F7" />
                    </span>
                    <span className="mova-drawer-nav-label">云端</span>
                  </button>
                </nav>

                <div className="mova-drawer-divider" />

                {/* Clean Project Folders (Only Folder Icon + Project Name, Chats below) */}
                <div className="mova-project-tree">
                  {filteredProjects.map((proj) => {
                    const isOpen = Boolean(expandedFolders[proj.id]);
                    return (
                      <div key={proj.id} className={`mova-project-group ${isOpen ? 'is-open' : ''}`}>
                        <button
                          type="button"
                          className="mova-project-folder-row"
                          onClick={() => toggleFolder(proj.id)}
                        >
                          <span className="mova-project-folder-icon">
                            <FolderProjectIcon size={20} open={isOpen} color="#F2F2F7" />
                          </span>
                          <span className="mova-project-folder-name">{proj.name}</span>
                        </button>

                        {isOpen && (
                          <div className="mova-project-chats">
                            {proj.chats.map((chat) => {
                              const selected = chat.id === activeConvId;
                              return (
                                <button
                                  key={chat.id}
                                  type="button"
                                  className={`mova-project-chat-row ${selected ? 'is-selected' : ''}`}
                                  onClick={() => {
                                    setActiveConvId(chat.id);
                                    setTitle(proj.name);
                                    setDrawerOpen(false);
                                  }}
                                >
                                  <span className="mova-drawer-conv-title">{chat.title}</span>
                                  {chat.activeDot && <span className="mova-unread-dot" />}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : appMode === 'MovaBot' ? (
              /* MovaBot iOS Contacts Directory (Clicking any Bot enters its Settings Page) */
              <div className="mova-bot-contacts">
                <div className="mova-contacts-caption">
                  <span>通讯录</span>
                  <small>{BOT_CONTACTS.length} 位智能体</small>
                </div>

                {groupedBotContacts.map(([letter, bots]) => (
                  <div key={letter} className="mova-contact-section">
                    <div className="mova-contact-index">{letter}</div>
                    <div className="mova-contact-group">
                      {bots.map((bot, idx) => (
                        <React.Fragment key={bot.id}>
                          {idx > 0 && <div className="mova-contact-sep" />}
                          <button
                            type="button"
                            className="mova-contact-row"
                            onClick={() => {
                              setActiveBotContact(bot);
                              setIsCreatingBot(false);
                              setBotSubScreen('settings');
                              setDrawerOpen(false);
                            }}
                          >
                            <BotMascotAvatar
                              id={bot.avatarId}
                              size={36}
                              onlineDot={bot.online}
                              dotBorderColor="#000000"
                            />
                            <div className="mova-contact-meta">
                              <span className="mova-contact-name">{bot.name}</span>
                              <span className="mova-contact-role">{bot.roleTitle}</span>
                            </div>
                            <ChevronRightIcon size={15} color="#48484A" />
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* ChatMova Clean Conversation Records */
              <div className="mova-drawer-recents">
                {filteredConversations.map((conv) => {
                  const isSelected = conv.id === activeConvId;
                  return (
                    <button
                      key={conv.id}
                      type="button"
                      className={`mova-drawer-conv-row ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => {
                        setActiveConvId(conv.id);
                        setTitle(conv.title.slice(0, 8));
                        setDrawerOpen(false);
                      }}
                    >
                      <span className="mova-drawer-conv-title">
                        {conv.title}
                        {conv.questionBadge && <span className="mova-question-badge">?</span>}
                      </span>
                      {conv.activeDot && <span className="mova-unread-dot" />}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="mova-drawer-more-btn"
                  onClick={() => showToast('已同步云端最近 30 条会话')}
                >
                  查看全部...
                </button>
              </div>
            )}
          </div>

          {/* Drawer Bottom Action Row: MovaBot uses 48×48 Blue "+" Circle; ChatMova/CodeMova uses "聊天" Pill */}
          <div className="mova-drawer-bottom">
            {appMode === 'MovaBot' ? (
              <IOSLiquidGlass
                width={48}
                height={48}
                cornerRadius={24}
                config={glassConfig}
                variant="blue"
                onClick={() => {
                  setActiveBotContact(BOT_CONTACTS[0]);
                  setIsCreatingBot(true);
                  setBotSubScreen('settings');
                  setDrawerOpen(false);
                }}
                title="新建 Bot"
              >
                <PlusIcon size={23} color="#FFFFFF" />
              </IOSLiquidGlass>
            ) : (
              <IOSLiquidGlass
                width={118}
                height={48}
                cornerRadius={24}
                config={glassConfig}
                variant="blue"
                onClick={() => {
                  setTitle('新对话');
                  setSentItems([]);
                  setDrawerOpen(false);
                  showToast('已开启新对话');
                }}
                contentClassName="mova-drawer-chat-pill"
              >
                <ComposeSquareIcon size={19} color="#FFFFFF" />
                <span>聊天</span>
              </IOSLiquidGlass>
            )}

            <IOSLiquidGlass
              width={48}
              height={48}
              cornerRadius={24}
              config={glassConfig}
              variant="bar"
              onClick={() => {
                setDrawerOpen(false);
                setSystemSettingsOpen(true);
              }}
              title="打开系统设置"
            >
              <span className="mova-avatar-badge">雪</span>
            </IOSLiquidGlass>
          </div>
        </aside>

        {/* ==================== MAIN CONVERSATION WORKSPACE ==================== */}
        <div
          className={`mova-main-card ${drawerOpen ? 'is-pushed' : ''}`}
          onClick={() => {
            if (drawerOpen) {
              setDrawerOpen(false);
            }
          }}
        >
          {/* Pushed Drawer Preview State */}
          {drawerOpen ? (
            appMode === 'MovaBot' ? (
              <div className="mova-pushed-preview mova-pushed-preview--bot">
                <div className="mova-pushed-header">
                  <div className="mova-pushed-menu-wrap">
                    <IOSLiquidGlass
                      width={42}
                      height={42}
                      cornerRadius={21}
                      config={glassConfig}
                      variant="subtle"
                    >
                      <MenuLinesIcon size={19} color="#AEAEB2" />
                    </IOSLiquidGlass>
                  </div>
                </div>
                <div className="mova-pushed-bot-list">
                  {MOVABOT_THREADS.slice(0, 6).map((t) => (
                    <div key={t.id} className="mova-pushed-bot-row">
                      <BotMascotAvatar id={t.avatarId} size={42} />
                      <div className="mova-pushed-bot-text">
                        <strong>{t.title}</strong>
                        <span>{t.preview}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mova-pushed-preview">
                <div className="mova-pushed-header">
                  <div className="mova-pushed-menu-wrap">
                    <IOSLiquidGlass
                      width={42}
                      height={42}
                      cornerRadius={21}
                      config={glassConfig}
                      variant="subtle"
                    >
                      <MenuLinesIcon size={19} color="#AEAEB2" />
                    </IOSLiquidGlass>
                    <span className="mova-menu-notify-dot" />
                  </div>
                </div>

                <div className="mova-pushed-prompt-line">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <rect x="9.5" y="2.5" width="3.5" height="8" rx="1.75" fill="#36C5F0" />
                    <rect x="13" y="9.5" width="8" height="3.5" rx="1.75" fill="#2EB67D" />
                    <rect x="10.5" y="13" width="3.5" height="8" rx="1.75" fill="#ECB22E" />
                    <rect x="3" y="10.5" width="8" height="3.5" rx="1.75" fill="#E01E5A" />
                  </svg>
                  <span>为我漏...</span>
                </div>

                <div className="mova-pushed-composer">
                  <div className="mova-pushed-composer-line">与 Mova 协作</div>
                  <div className="mova-pushed-composer-tools">
                    <PlusIcon size={20} color="#98989F" />
                  </div>
                </div>

                <div className="mova-pushed-keyboard-wrap">
                  <IOSKeyboard
                    dimmed
                    onInsertText={() => {}}
                    onBackspace={() => {}}
                    onReturn={() => {}}
                  />
                </div>
              </div>
            )
          ) : systemSettingsOpen ? (
            <>
              <SystemSettingsView
                glassConfig={glassConfig}
                resetSeed={resetSeed}
                onClose={() => setSystemSettingsOpen(false)}
                onToast={showToast}
              />
              <IOSHomeIndicator />
            </>
          ) : appMode === 'MovaBot' ? (
            <>
              {botSubScreen === 'list' ? (
                <MovaBotHomeView
                  glassConfig={glassConfig}
                  onOpenDrawer={() => setDrawerOpen(true)}
                  onSelectThread={(t) => {
                    setActiveBotThread(t);
                    setBotSubScreen('chat');
                  }}
                  onToast={showToast}
                />
              ) : botSubScreen === 'settings' ? (
                <BotSettingsView
                  bot={activeBotContact}
                  glassConfig={glassConfig}
                  isCreatingNew={isCreatingBot}
                  onBack={() => {
                    setBotSubScreen('list');
                    setDrawerOpen(true);
                  }}
                  onStartChat={(contact) => {
                    const matched =
                      MOVABOT_THREADS.find((t) => t.headerAvatarId === contact.avatarId) ??
                      MOVABOT_THREADS[0];
                    setActiveBotThread(matched);
                    setBotSubScreen('chat');
                  }}
                  onToast={showToast}
                />
              ) : (
                <MovaBotChatView
                  thread={activeBotThread}
                  glassConfig={glassConfig}
                  resetSeed={resetSeed}
                  onBack={() => {
                    setMediaSheetMode(null);
                    setBotSubScreen('list');
                  }}
                  onOpenMediaPicker={() => setMediaSheetMode('photos')}
                  onToast={showToast}
                />
              )}
              <IOSHomeIndicator />
            </>
          ) : (
            <>
              {/* Floating Top iOS 26 Liquid Glass Navigation Bar */}
              <div className="mova-top-fade-mask" aria-hidden="true" />
              <header className="mova-floating-navbar">
                <IOSLiquidGlass
                  width={44}
                  height={44}
                  cornerRadius={22}
                  config={glassConfig}
                  variant="bar"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setModelSheetOpen(false);
                    setDrawerOpen(true);
                  }}
                  title="打开侧边栏"
                >
                  <MenuLinesIcon size={20} color="#F5F5F7" />
                </IOSLiquidGlass>

                <h1 className="mova-nav-title">{title}</h1>

                <IOSLiquidGlass
                  width={44}
                  height={44}
                  cornerRadius={22}
                  config={glassConfig}
                  variant="bar"
                  onClick={() => {
                    setMoreMenuOpen((v) => !v);
                    setModelSheetOpen(false);
                  }}
                  title="更多与 Token 用量"
                >
                  <EllipsisRowIcon size={19} color="#F5F5F7" />
                </IOSLiquidGlass>
              </header>

              {/* Top-Right Pull-Down iOS 26 Context Menu (Mova Token Usage & Temp Chat) */}
              {moreMenuOpen && (
                <div className="mova-context-popover" onClick={(e) => e.stopPropagation()}>
                  <IOSLiquidGlass
                    width={224}
                    height={176}
                    cornerRadius={22}
                    config={glassConfig}
                    variant="composer"
                    interactive={false}
                    contentClassName="mova-popover-list"
                  >
                    <div className="mova-popover-meta">
                      <span>本会话 Token 用量</span>
                      <strong>3,842 · ¥0.04</strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreMenuOpen(false);
                        setTitle('工作 · 临时');
                        showToast('已切换为临时聊天（不写入记忆）');
                      }}
                    >
                      <span>开启临时聊天</span>
                      <small>隐私</small>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreMenuOpen(false);
                        showToast('引用自检通过：3 处证据可回溯');
                      }}
                    >
                      <span>校验 [n] 引用来源</span>
                      <small>3 处</small>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreMenuOpen(false);
                        if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      <span>回到顶部上下文</span>
                      <small>↑</small>
                    </button>
                  </IOSLiquidGlass>
                </div>
              )}

              {/* Edge-to-Edge Scrolling Conversation Stream */}
              <div
                ref={scrollRef}
                className={`mova-chat-scroll ${keyboardOpen ? 'is-kb-open' : ''}`}
                onClick={() => {
                  setMoreMenuOpen(false);
                  setModelSheetOpen(false);
                  setMediaSheetMode(null);
                  if (keyboardOpen && preset !== 'keyboard') {
                    setKeyboardOpen(false);
                  }
                }}
              >
                {/* Earlier context line that scrolls directly underneath the Liquid Glass Nav Bar */}
                <p className="mova-msg-paragraph mova-msg-paragraph--subtle-top">
                  已就绪，两条新线路都已启动，Linux 云端服务已放行对应的 IPv4 端口；原来的 443
                  网关保留，可以随时切回。
                </p>

                <p className="mova-msg-paragraph">
                  我在服务器本机分别通过两条新线路访问网页，均返回成功；
                  <strong>手机移动网络下是否可连接、速度是否提升，还需要你实际测试。</strong>
                </p>

                <p className="mova-msg-paragraph">
                  复制下面的链接，在 Shadowrocket 或 Mova 节点页中从剪贴板导入。
                </p>

                {MOVA_CODE_BLOCKS.map((block) => {
                  const isCopied = copiedId === block.id;
                  return (
                    <section key={block.id} className="mova-code-section">
                      <h2 className="mova-section-heading">{block.heading}</h2>
                      <div className="mova-code-card">
                        <div className="mova-code-card-head">
                          <span className="mova-code-lang">{block.languageLabel}</span>
                          <button
                            type="button"
                            className="mova-code-copy-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopy(block.id, block.code);
                            }}
                            aria-label={`复制 ${block.heading}`}
                          >
                            {isCopied ? (
                              <CheckTinyIcon size={16} color="#32D74B" />
                            ) : (
                              <CopySheetsIcon size={16} color="#D1D1D6" />
                            )}
                          </button>
                        </div>
                        <div className="mova-code-pre">{block.code}</div>
                      </div>
                    </section>
                  );
                })}

                <p className="mova-msg-paragraph">
                  先用移动流量分别测试这两条线路，再和原来的 REALITY 对比下载速度。TUIC 与 Hysteria2
                  一样使用 UDP，如果运营商对 UDP 有限制，它仍可能无法连接。链接包含连接凭据，请不要公开分享。
                </p>

                {/* Mova Desktop Original Assistant Action Row: Copy + Regenerate + Weekday Time */}
                <div className="mova-desktop-msg-actions">
                  <button
                    type="button"
                    className="mova-desktop-msg-btn"
                    onClick={() => handleCopy('full-reply', '已复制完整线路测试回复')}
                    aria-label="复制回复"
                    title="复制"
                  >
                    {copiedId === 'full-reply' ? (
                      <CheckTinyIcon size={16} color="#32D74B" />
                    ) : (
                      <DesktopCopyIcon size={17} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="mova-desktop-msg-btn"
                    onClick={() => showToast('正在重新生成回复（保留旧尝试）')}
                    aria-label="重新生成"
                    title="重新生成"
                  >
                    <DesktopRegenerateIcon size={17} />
                  </button>
                  <span className="mova-desktop-msg-time">星期一 07:43</span>
                </div>

                {/* User Interactive Follow-up Messages */}
                {sentItems.map((item) => (
                  <div key={item.id} className="mova-live-turn">
                    <div className="mova-user-bubble">{item.text}</div>
                    <p className="mova-msg-paragraph">{item.reply}</p>
                    <div className="mova-desktop-msg-actions">
                      <button
                        type="button"
                        className="mova-desktop-msg-btn"
                        onClick={() => handleCopy(item.id, item.reply)}
                        aria-label="复制回复"
                        title="复制"
                      >
                        {copiedId === item.id ? (
                          <CheckTinyIcon size={16} color="#32D74B" />
                        ) : (
                          <DesktopCopyIcon size={17} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="mova-desktop-msg-btn"
                        onClick={() => showToast('正在重新生成此条回复')}
                        aria-label="重新生成"
                        title="重新生成"
                      >
                        <DesktopRegenerateIcon size={17} />
                      </button>
                      <span className="mova-desktop-msg-time">{item.timeLabel}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Bottom Fade Mask */}
              <div className={`mova-bottom-fade-mask ${keyboardOpen ? 'is-kb' : ''}`} aria-hidden="true" />

              {/* Centered Frosted-Band Model & Reasoning Effort Selector (Zooms to screen center) */}
              {modelSheetOpen && (
                <MovaEffortModelOverlay
                  selectedModel={selectedModel}
                  effort={effort}
                  glassConfig={glassConfig}
                  onSelectModel={(m) => {
                    setSelectedModel(m);
                    if (!m.efforts.includes(effort)) {
                      setEffort(m.defaultEffort);
                    }
                  }}
                  onChangeEffort={(nextEffort) => setEffort(nextEffort)}
                  onClose={() => setModelSheetOpen(false)}
                />
              )}

              {/* ==================== FLOATING LIQUID GLASS COMPOSER ==================== */}
              {!keyboardOpen ? (
                /* State 01: Split Composer matching MovaBot (Left "+" circle + Right capsule with single blue voice orb) */
                <div className="movabot-composer-bar">
                  <IOSLiquidGlass
                    width={48}
                    height={48}
                    cornerRadius={24}
                    config={glassConfig}
                    variant="composer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMoreMenuOpen(false);
                      setModelSheetOpen(false);
                      setMediaSheetMode((cur) => (cur ? null : 'photos'));
                    }}
                    title="选择照片或拍照"
                  >
                    <PlusIcon size={23} color="#F2F2F7" />
                  </IOSLiquidGlass>

                  <IOSLiquidGlass
                    width={314}
                    height={48}
                    cornerRadius={24}
                    config={glassConfig}
                    variant="composer"
                    interactive={false}
                    contentClassName="movabot-input-capsule"
                  >
                    <button
                      type="button"
                      className="mova-idle-placeholder"
                      onClick={() => {
                        setKeyboardOpen(true);
                        window.setTimeout(() => inputRef.current?.focus(), 60);
                      }}
                    >
                      {draft || '与 Mova 协作'}
                    </button>

                    <button
                      type="button"
                      className="mova-voice-circle-btn"
                      onClick={() => showToast('Mova 实时语音协作')}
                      aria-label="实时语音"
                    >
                      <VoiceWaveIcon size={18} color="#FFFFFF" />
                    </button>
                  </IOSLiquidGlass>
                </div>
              ) : (
                /* State 02: Focused Two-Row Card Composer + iOS 26 Keyboard (Single blue voice/send orb) */
                <>
                  <div className="mova-composer-dock mova-composer-dock--focused">
                    <IOSLiquidGlass
                      width={378}
                      height={96}
                      cornerRadius={24}
                      config={glassConfig}
                      variant="composer"
                      interactive={false}
                      contentClassName="mova-focused-composer"
                    >
                      <div className="mova-focused-input-row">
                        <span className="mova-caret-bar" aria-hidden="true" />
                        <input
                          ref={inputRef}
                          type="text"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSend();
                            if (e.key === 'Escape') setKeyboardOpen(false);
                          }}
                          placeholder="与 Mova 协作"
                          className="mova-focused-input"
                        />
                      </div>

                      <div className="mova-focused-tools-row">
                        <button
                          type="button"
                          className="mova-comp-plain-btn mova-comp-plain-btn--plus"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMoreMenuOpen(false);
                            setModelSheetOpen(false);
                            setMediaSheetMode((cur) => (cur ? null : 'photos'));
                          }}
                          aria-label="选择照片或拍照"
                        >
                          <PlusIcon size={24} color="#F2F2F7" />
                        </button>

                        <div className="mova-tools-spacer" />

                        <div className="mova-focused-right-cluster">
                          <button
                            type="button"
                            className="mova-model-selector-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setModelSheetOpen((v) => !v);
                            }}
                          >
                            <span className="mova-model-name">{selectedModel.name}</span>
                            <span className="mova-model-effort">
                              {EFFORT_CATALOG[effort].short}
                            </span>
                          </button>

                          <button
                            type="button"
                            className="mova-voice-circle-btn"
                            onClick={draft.trim() ? handleSend : () => showToast('Mova 实时语音模式')}
                            aria-label={draft.trim() ? '发送消息' : '语音对话'}
                          >
                            {draft.trim() ? (
                              <ArrowUpSendIcon size={18} color="#FFFFFF" />
                            ) : (
                              <VoiceWaveIcon size={18} color="#FFFFFF" />
                            )}
                          </button>
                        </div>
                      </div>
                    </IOSLiquidGlass>
                  </div>

                  <div className="mova-keyboard-dock">
                    <IOSKeyboard
                      onInsertText={(txt) => setDraft((prev) => prev + txt)}
                      onBackspace={() => setDraft((prev) => prev.slice(0, -1))}
                      onReturn={handleSend}
                    />
                  </div>
                </>
              )}

              {!keyboardOpen && <IOSHomeIndicator />}
            </>
          )}

          {/* iOS 26 Photo Picker Grid & Live Camera Viewfinder Sheet (Triggered by "+" Button) */}
          {mediaSheetMode && !drawerOpen && !systemSettingsOpen && (
            <IOSPhotoCameraSheet
              glassConfig={glassConfig}
              mode={mediaSheetMode}
              onModeChange={(next) => setMediaSheetMode(next)}
              onClose={() => setMediaSheetMode(null)}
              onAttachPhoto={(label) => showToast(`已选择：${label}`)}
              onToast={showToast}
            />
          )}

          {/* Subtle Native iOS 26 Capsule Toast */}
          {toastText && <div className="mova-ios-toast">{toastText}</div>}
        </div>
      </div>
    </div>
  );
};
