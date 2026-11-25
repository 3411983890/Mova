/**
 * 负责：呈现三模式侧边抽屉（ChatMova 对话列表、CodeMova 本地/云端项目文件夹、MovaBot 通讯录样式）
 * 顶部左上角模式触发器弹出 iOS 26 原生液态玻璃下拉菜单；底部点击个人头像进入系统设置页；MovaBot 左下角为蓝色液态玻璃 "+" 按钮。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BotMascotAvatar } from '../../components/bot-avatars';
import GlassSurface from '../../components/glass-surface';
import { hapticLight, hapticSelection } from '../../components/haptics';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ComposeSquareIcon,
  FolderIcon,
  HostCloudIcon,
  HostLocalIcon,
  ModeBotIcon,
  ModeChatIcon,
  ModeCodeIcon,
  PlusIcon,
  SearchIcon,
} from '../../components/ios-icons';
import {
  BOT_CONTACTS,
  CODEMOVA_PROJECTS,
  MOVA_APP_MODES,
  type BotContactProfile,
  type CodeHostScope,
  type MovaAppMode,
} from '../design/mova-design-data';
import { useMobile } from './mobile-provider';

type ConversationDrawerProps = {
  open: boolean;
  width: number;
  appMode: MovaAppMode;
  onChangeMode: (mode: MovaAppMode) => void;
  onClose: () => void;
  onNewChat: () => void;
  onNewBot: () => void;
  onOpenSettings: () => void;
  onSelectConversation: (id: string, title?: string) => void;
  onSelectBotContact: (bot: BotContactProfile) => void;
  onDeleteConversation: (id: string) => void;
  onToast: (msg: string) => void;
};

export default function ConversationDrawer({
  open,
  width,
  appMode,
  onChangeMode,
  onClose,
  onNewChat,
  onNewBot,
  onOpenSettings,
  onSelectConversation,
  onSelectBotContact,
  onDeleteConversation,
  onToast,
}: ConversationDrawerProps) {
  const insets = useSafeAreaInsets();
  const { state, activeId } = useMobile();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [codeHost, setCodeHost] = useState<CodeHostScope>('local');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'proj-mova-core': true,
    'proj-linux-cli': true,
  });

  useEffect(() => {
    if (!open) {
      setSearching(false);
      setQuery('');
      setModeMenuOpen(false);
    }
  }, [open]);

  const q = query.trim().toLowerCase();

  const conversations = useMemo(
    () => state.conversations.filter((item) => item.title.toLowerCase().includes(q)),
    [state.conversations, q]
  );

  const filteredProjects = useMemo(
    () =>
      CODEMOVA_PROJECTS.filter(
        (proj) =>
          proj.host === codeHost &&
          (!q ||
            proj.name.toLowerCase().includes(q) ||
            proj.chats.some((c) => c.title.toLowerCase().includes(q)))
      ),
    [codeHost, q]
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

  const renderModeIcon = (mode: MovaAppMode) => {
    switch (mode) {
      case 'ChatMova':
        return <ModeChatIcon size={18} color="#F5F5F7" />;
      case 'CodeMova':
        return <ModeCodeIcon size={18} color="#F5F5F7" />;
      case 'MovaBot':
        return <ModeBotIcon size={18} color="#F5F5F7" />;
    }
  };

  return (
    <View
      accessibilityViewIsModal={open}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
      pointerEvents={open ? 'auto' : 'none'}
      style={[
        styles.drawer,
        {
          width,
          paddingTop: insets.top + 10,
          paddingBottom: Math.max(insets.bottom + 14, 24),
        },
      ]}
    >
      {/* Top Row: Mode Picker Trigger ("ChatMova ⌄") + Circular Liquid Glass Search */}
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`当前模式 ${appMode}，点击切换模式`}
          style={styles.modeTrigger}
          onPress={() => {
            hapticLight();
            setModeMenuOpen((v) => !v);
          }}
        >
          <Text style={styles.brandText}>{appMode}</Text>
          <View style={modeMenuOpen && { transform: [{ rotate: '180deg' }] }}>
            <ChevronDownIcon size={17} color="rgba(235, 235, 245, 0.72)" />
          </View>
        </Pressable>

        <GlassSurface interactive style={styles.searchGlass}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="搜索对话或项目"
            style={styles.centerFill}
            onPress={() => {
              hapticLight();
              setModeMenuOpen(false);
              setSearching((v) => !v);
            }}
          >
            <SearchIcon size={19} color="#F5F5F7" />
          </Pressable>
        </GlassSurface>
      </View>

      {/* Native iOS 26 Liquid Glass Pull-Down Mode Picker */}
      {modeMenuOpen && (
        <Animated.View
          entering={FadeIn.duration(140)}
          exiting={FadeOut.duration(110)}
          style={[styles.modeMenuWrap, { top: insets.top + 58 }]}
        >
          <GlassSurface style={styles.modeMenuGlass}>
            {MOVA_APP_MODES.map((m, idx) => {
              const selected = m.id === appMode;
              return (
                <React.Fragment key={m.id}>
                  {idx > 0 && <View style={styles.modeMenuSep} />}
                  <Pressable
                    style={({ pressed }) => [
                      styles.modeMenuItem,
                      pressed && styles.modeMenuItemPressed,
                    ]}
                    onPress={() => {
                      hapticSelection();
                      onChangeMode(m.id);
                      setModeMenuOpen(false);
                    }}
                  >
                    <View style={styles.modeMenuLeft}>
                      {renderModeIcon(m.id)}
                      <Text
                        style={[styles.modeMenuLabel, selected && { fontWeight: '600', color: '#FFFFFF' }]}
                      >
                        {m.label}
                      </Text>
                    </View>
                    {selected && <CheckIcon size={16} color="#FFFFFF" />}
                  </Pressable>
                </React.Fragment>
              );
            })}
          </GlassSurface>
        </Animated.View>
      )}

      {searching && (
        <View style={styles.searchBox}>
          <SearchIcon size={15} color="#8E8E93" />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={
              appMode === 'CodeMova'
                ? '搜索项目或记录...'
                : appMode === 'MovaBot'
                  ? '搜索通讯录 Bot...'
                  : '搜索对话...'
            }
            placeholderTextColor="#636366"
            keyboardAppearance="dark"
            style={styles.searchInput}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')}>
              <Text style={styles.clearText}>清除</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Drawer Content Switcher by App Mode */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => modeMenuOpen && setModeMenuOpen(false)}
      >
        {appMode === 'CodeMova' ? (
          /* CodeMova: Local / Cloud Vertical Rows + Hairline Divider + Minimal Project Folders */
          <View style={styles.codeSection}>
            <View style={styles.hostList}>
              <Pressable
                style={[styles.hostRow, codeHost === 'local' && styles.hostRowActive]}
                onPress={() => {
                  hapticSelection();
                  setCodeHost('local');
                }}
              >
                <HostLocalIcon size={20} color="#F5F5F7" />
                <Text style={styles.hostLabel}>本地</Text>
              </Pressable>

              <Pressable
                style={[styles.hostRow, codeHost === 'cloud' && styles.hostRowActive]}
                onPress={() => {
                  hapticSelection();
                  setCodeHost('cloud');
                }}
              >
                <HostCloudIcon size={21} color="#F5F5F7" />
                <Text style={styles.hostLabel}>云端</Text>
              </Pressable>
            </View>

            <View style={styles.divider} />

            <View style={styles.projectTree}>
              {filteredProjects.map((proj) => {
                const isOpen = Boolean(expandedFolders[proj.id]);
                return (
                  <View key={proj.id} style={styles.projectGroup}>
                    <Pressable
                      style={styles.folderRow}
                      onPress={() => {
                        hapticLight();
                        setExpandedFolders((prev) => ({ ...prev, [proj.id]: !prev[proj.id] }));
                      }}
                    >
                      <FolderIcon size={20} open={isOpen} color="#F2F2F7" />
                      <Text style={styles.folderName} numberOfLines={1}>
                        {proj.name}
                      </Text>
                    </Pressable>

                    {isOpen && (
                      <View style={styles.projectChats}>
                        {proj.chats.map((chat) => (
                          <Pressable
                            key={chat.id}
                            style={({ pressed }) => [
                              styles.projectChatRow,
                              pressed && styles.rowPressed,
                            ]}
                            onPress={() => {
                              hapticSelection();
                              onSelectConversation(activeId ?? 'welcome', proj.name);
                              onClose();
                            }}
                          >
                            <Text style={styles.convTitle} numberOfLines={1}>
                              {chat.title}
                            </Text>
                            {chat.activeDot && <View style={styles.unreadDot} />}
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        ) : appMode === 'MovaBot' ? (
          /* MovaBot: iOS Contacts Directory Grouped A-Z (Tap any Bot -> Bot Settings Page) */
          <View style={styles.contactsWrap}>
            <View style={styles.contactsCaption}>
              <Text style={styles.contactsCaptionTitle}>通讯录</Text>
              <Text style={styles.contactsCaptionCount}>{BOT_CONTACTS.length} 位智能体</Text>
            </View>

            {groupedBotContacts.map(([letter, bots]) => (
              <View key={letter} style={styles.contactSection}>
                <Text style={styles.contactIndex}>{letter}</Text>
                <View style={styles.contactGroup}>
                  {bots.map((bot, idx) => (
                    <React.Fragment key={bot.id}>
                      {idx > 0 && <View style={styles.contactSep} />}
                      <Pressable
                        style={({ pressed }) => [styles.contactRow, pressed && styles.rowPressed]}
                        onPress={() => {
                          hapticSelection();
                          onSelectBotContact(bot);
                        }}
                      >
                        <BotMascotAvatar
                          id={bot.avatarId}
                          size={36}
                          onlineDot={bot.online}
                          dotBorderColor="#161618"
                        />
                        <View style={styles.contactMeta}>
                          <Text style={styles.contactName} numberOfLines={1}>
                            {bot.name}
                          </Text>
                          <Text style={styles.contactRole} numberOfLines={1}>
                            {bot.roleTitle}
                          </Text>
                        </View>
                        <ChevronRightIcon size={15} color="#48484A" />
                      </Pressable>
                    </React.Fragment>
                  ))}
                </View>
              </View>
            ))}
          </View>
        ) : (
          /* ChatMova: Clean Recent Conversations */
          <View style={styles.recentsList}>
            {conversations.map((item) => {
              const selected = item.id === activeId;
              return (
                <Pressable
                  key={item.id}
                  style={({ pressed }) => [
                    styles.convRow,
                    selected && styles.convRowSelected,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => {
                    hapticSelection();
                    onSelectConversation(item.id, item.title);
                  }}
                  onLongPress={() => onDeleteConversation(item.id)}
                >
                  <Text style={styles.convTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {selected && <View style={styles.unreadDot} />}
                </Pressable>
              );
            })}

            <Pressable
              style={styles.moreBtn}
              onPress={() => {
                hapticLight();
                onToast('已同步云端最近 30 条会话');
              }}
            >
              <Text style={styles.moreBtnText}>查看全部...</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {/* Bottom Action Bar: MovaBot uses 48×48 Blue "+" Glass Circle; ChatMova/CodeMova uses Blue "聊天" Glass Pill; Right is Personal Avatar "雪" */}
      <View style={styles.bottomRow}>
        {appMode === 'MovaBot' ? (
          <GlassSurface interactive tint="#3262FF" style={styles.bottomCircleGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="新建 Bot"
              style={styles.centerFill}
              onPress={() => {
                hapticLight();
                onNewBot();
              }}
            >
              <PlusIcon size={23} color="#FFFFFF" />
            </Pressable>
          </GlassSurface>
        ) : (
          <GlassSurface interactive tint="#3262FF" style={styles.chatPillGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="新建聊天"
              style={styles.chatPillBtn}
              onPress={() => {
                hapticLight();
                onNewChat();
              }}
            >
              <ComposeSquareIcon size={19} color="#FFFFFF" />
              <Text style={styles.chatPillText}>聊天</Text>
            </Pressable>
          </GlassSurface>
        )}

        <GlassSurface interactive style={styles.bottomCircleGlass}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开系统设置"
            style={styles.centerFill}
            onPress={() => {
              hapticLight();
              onOpenSettings();
            }}
          >
            <View style={styles.avatarBadge}>
              <Text style={styles.avatarText}>雪</Text>
            </View>
          </Pressable>
        </GlassSurface>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: '#000000',
    paddingLeft: 18,
    paddingRight: 20,
    gap: 14,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 46,
  },
  modeTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  brandText: {
    fontSize: 24,
    fontWeight: '600',
    color: '#F5F5F7',
    letterSpacing: -0.6,
  },
  searchGlass: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeMenuWrap: {
    position: 'absolute',
    left: 18,
    width: 220,
    zIndex: 40,
  },
  modeMenuGlass: {
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  modeMenuItem: {
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modeMenuItemPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  modeMenuLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modeMenuLabel: {
    fontSize: 15.5,
    color: '#E5E5EA',
  },
  modeMenuSep: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#17171A',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#FFFFFF',
  },
  clearText: {
    fontSize: 12,
    color: '#8E8E93',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  recentsList: {
    gap: 2,
  },
  convRow: {
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  convRowSelected: {
    backgroundColor: '#19191C',
  },
  rowPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  convTitle: {
    flex: 1,
    fontSize: 15.5,
    color: '#F5F5F7',
  },
  unreadDot: {
    width: 6.5,
    height: 6.5,
    borderRadius: 3.25,
    backgroundColor: '#3262FF',
  },
  moreBtn: {
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  moreBtnText: {
    fontSize: 14,
    color: '#8E8E93',
  },
  codeSection: {
    gap: 12,
  },
  hostList: {
    gap: 2,
  },
  hostRow: {
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  hostRowActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  hostLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#F5F5F7',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginHorizontal: 6,
  },
  projectTree: {
    gap: 6,
  },
  projectGroup: {
    gap: 2,
  },
  folderRow: {
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  folderName: {
    flex: 1,
    fontSize: 15.5,
    fontWeight: '500',
    color: '#F5F5F7',
  },
  projectChats: {
    paddingLeft: 30,
    gap: 2,
  },
  projectChatRow: {
    minHeight: 38,
    paddingHorizontal: 10,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  contactsWrap: {
    gap: 10,
  },
  contactsCaption: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
  },
  contactsCaptionTitle: {
    fontSize: 12.5,
    fontWeight: '600',
    color: 'rgba(235, 235, 245, 0.5)',
  },
  contactsCaptionCount: {
    fontSize: 11.5,
    color: 'rgba(235, 235, 245, 0.36)',
  },
  contactSection: {
    gap: 4,
  },
  contactIndex: {
    paddingHorizontal: 8,
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(235, 235, 245, 0.42)',
  },
  contactGroup: {
    borderRadius: 16,
    backgroundColor: '#161618',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 9,
    paddingHorizontal: 10,
  },
  contactMeta: {
    flex: 1,
    gap: 2,
  },
  contactName: {
    fontSize: 15.5,
    fontWeight: '500',
    color: '#F5F5F7',
  },
  contactRole: {
    fontSize: 12,
    color: '#8E8E93',
  },
  contactSep: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
  },
  chatPillGlass: {
    width: 118,
    height: 48,
    borderRadius: 24,
  },
  chatPillBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  chatPillText: {
    fontSize: 16.5,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  bottomCircleGlass: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  avatarBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#7356CF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
