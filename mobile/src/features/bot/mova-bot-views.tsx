/**
 * 负责：MovaBot 主页列表与单 Bot / 群聊详情页（原生 iOS 26 Liquid Glass + 纯黑 OLED）。
 */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BotMascotAvatar,
  KeyboardRenderShotOne,
  KeyboardRenderShotTwo,
} from '../../components/bot-avatars';
import GlassSurface, { GlassGroup } from '../../components/glass-surface';
import { hapticLight, hapticSelection } from '../../components/haptics';
import {
  ArrowUpIcon,
  ChevronLeftIcon,
  MenuLinesIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  VoiceWaveIcon,
} from '../../components/ios-icons';
import { MOVABOT_THREADS, type BotThreadItem } from '../design/mova-design-data';

type MovaBotHomeViewProps = {
  onOpenDrawer: () => void;
  onSelectThread: (thread: BotThreadItem) => void;
  onNewBot: () => void;
  onToast: (msg: string) => void;
};

export const MovaBotHomeView: React.FC<MovaBotHomeViewProps> = ({
  onOpenDrawer,
  onSelectThread,
  onNewBot,
}) => {
  const insets = useSafeAreaInsets();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const threads = MOVABOT_THREADS.filter(
    (t) => !q || t.title.toLowerCase().includes(q) || t.preview.toLowerCase().includes(q)
  );

  return (
    <View style={styles.screen}>
      {/* Top Progressive Fade + Floating Liquid Glass Nav */}
      <LinearGradient
        colors={['rgba(0,0,0,0.96)', 'rgba(0,0,0,0.68)', 'rgba(0,0,0,0)']}
        style={[styles.topFade, { height: insets.top + 66 }]}
        pointerEvents="none"
      />
      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <GlassSurface interactive style={styles.circleGlass}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开 MovaBot 通讯录侧栏"
            style={styles.circleBtn}
            onPress={() => {
              hapticLight();
              onOpenDrawer();
            }}
          >
            <MenuLinesIcon size={20} color="#F5F5F7" />
          </Pressable>
        </GlassSurface>

        <Text style={styles.navTitle} pointerEvents="none">
          MovaBot
        </Text>

        <GlassGroup spacing={10} style={styles.topRightGroup}>
          <GlassSurface interactive style={styles.circleGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="搜索 Bot 会话"
              style={styles.circleBtn}
              onPress={() => {
                hapticLight();
                setSearching((v) => !v);
              }}
            >
              <SearchIcon size={19} color="#F5F5F7" />
            </Pressable>
          </GlassSurface>

          <GlassSurface interactive style={styles.circleGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="新建 Bot"
              style={styles.circleBtn}
              onPress={() => {
                hapticLight();
                onNewBot();
              }}
            >
              <PlusIcon size={22} color="#F5F5F7" />
            </Pressable>
          </GlassSurface>
        </GlassGroup>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: insets.top + 64,
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom + 24, 34),
        }}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="interactive"
      >
        {searching && (
          <View style={styles.searchBox}>
            <SearchIcon size={15} color="#8E8E93" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索智能体或协作记录..."
              placeholderTextColor="#636366"
              keyboardAppearance="dark"
              autoFocus
              style={styles.searchInput}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')}>
                <Text style={styles.clearText}>清除</Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={styles.threadList}>
          {threads.map((item) => (
            <Pressable
              key={item.id}
              style={({ pressed }) => [styles.threadRow, pressed && styles.threadRowPressed]}
              onPress={() => {
                hapticSelection();
                onSelectThread(item);
              }}
            >
              <BotMascotAvatar
                id={item.avatarId}
                size={48}
                onlineDot={item.onlineDot}
                dotBorderColor="#000000"
              />
              <View style={styles.threadBody}>
                <View style={styles.threadTop}>
                  <Text style={styles.threadTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.threadTime}>{item.time}</Text>
                </View>
                <View style={styles.threadBottom}>
                  <Text
                    style={[styles.threadPreview, item.waitingAmber && styles.threadPreviewAmber]}
                    numberOfLines={1}
                  >
                    {item.preview}
                  </Text>
                  {item.unreadBlueDot && <View style={[styles.dot, { backgroundColor: '#2F6BFF' }]} />}
                  {item.waitingAmber && <View style={[styles.dot, { backgroundColor: '#E5A024' }]} />}
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
};

type MovaBotChatViewProps = {
  thread: BotThreadItem;
  onBack: () => void;
  onOpenMediaPicker: () => void;
  onToast: (msg: string) => void;
};

type ExtraTurn = {
  id: string;
  userText: string;
  botReply: string;
};

export const MovaBotChatView: React.FC<MovaBotChatViewProps> = ({
  thread,
  onBack,
  onOpenMediaPicker,
  onToast,
}) => {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const [draft, setDraft] = useState('');
  const [extraTurns, setExtraTurns] = useState<ExtraTurn[]>([]);

  useEffect(() => {
    setDraft('');
    setExtraTurns([]);
  }, [thread.id]);

  const handleSend = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    hapticLight();
    setExtraTurns((prev) => [
      ...prev,
      {
        id: `${Date.now()}`,
        userText: trimmed,
        botReply: '收到。我这就同步给 Maker 和 Review，等第 6 镜渲染出片立刻推给你看。',
      },
    ]);
    setDraft('');
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 60);
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Top Progressive Fade & Floating Liquid Glass Islands */}
      <LinearGradient
        colors={['rgba(0,0,0,0.96)', 'rgba(0,0,0,0.68)', 'rgba(0,0,0,0)']}
        style={[styles.topFade, { height: insets.top + 66 }]}
        pointerEvents="none"
      />
      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <GlassGroup spacing={8} style={styles.chatHeaderLeft}>
          <GlassSurface interactive style={styles.circleGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回 MovaBot 列表"
              style={styles.circleBtn}
              onPress={() => {
                hapticLight();
                onBack();
              }}
            >
              <ChevronLeftIcon size={20} color="#F5F5F7" />
            </Pressable>
          </GlassSurface>

          <GlassSurface interactive style={styles.identityGlass}>
            <Pressable
              style={styles.identityBtn}
              onPress={() => {
                hapticLight();
                onToast(`${thread.headerName} · 运行于 Mova Linux 云电脑`);
              }}
            >
              <BotMascotAvatar
                id={thread.headerAvatarId}
                size={24}
                onlineDot
                dotBorderColor="#232327"
              />
              <Text style={styles.identityName}>{thread.headerName}</Text>
            </Pressable>
          </GlassSurface>
        </GlassGroup>

        <GlassSurface interactive style={styles.circleGlass}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="查看云电脑工作台"
            style={styles.circleBtn}
            onPress={() => {
              hapticLight();
              onToast('查看云电脑实时桌面与渲染队列');
            }}
          >
            <MonitorIcon size={20} color="#F5F5F7" />
          </Pressable>
        </GlassSurface>
      </View>

      {/* Conversation Stream */}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: insets.top + 64,
          paddingHorizontal: 16,
          paddingBottom: 24,
          gap: 10,
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.bubble, styles.botBubble]}>
          <Text style={[styles.bubbleText, { color: 'rgba(242,242,247,0.75)' }]}>
            不改大框架，先锁风格，建模出片给 Maker，配乐另做，齐了 Review 看。
          </Text>
        </View>

        <View style={styles.delegationRow}>
          <Text style={styles.delegationText}>Messaged</Text>
          <BotMascotAvatar id="maker" size={16} />
          <Text style={styles.delegationStrong}>Maker</Text>
        </View>

        <View style={[styles.bubble, styles.botBubble]}>
          <Text style={styles.bubbleText}>
            Maker 建键盘、出运动镜头。配乐等他片子到了再另叫，不跟建模捆一个人身上。我过风格，不碰
            Blender。
          </Text>
        </View>

        <Text style={styles.timestamp}>Today 01:50</Text>

        <View style={[styles.bubble, styles.userBubble]}>
          <Text style={styles.userBubbleText}>怎么样了</Text>
        </View>

        <View style={[styles.bubble, styles.botBubble, styles.compactBubble]}>
          <Text style={styles.bubbleText}>我去看 Maker 做到哪了。</Text>
        </View>

        <View style={[styles.bubble, styles.botBubble]}>
          <Text style={styles.bubbleText}>
            Maker 在渲。模型有了，黑场、同一把铝壳白键。前三镜成片了，正在渲第 4 镜，一共 6
            镜。配乐还没叫。
          </Text>
        </View>

        {/* Two Stacked 3D Keyboard Renders */}
        <View style={styles.mediaStack}>
          <Pressable
            style={styles.mediaCard}
            onPress={() => onToast('预览第 1 镜：黑场铝壳白键低机位透视 (1920×1080)')}
          >
            <KeyboardRenderShotOne />
          </Pressable>
          <Pressable
            style={styles.mediaCard}
            onPress={() => onToast('预览第 3 镜：阳极氧化铝倒角微距特写 (1920×1080)')}
          >
            <KeyboardRenderShotTwo />
          </Pressable>
        </View>

        <View style={styles.signoff}>
          <BotMascotAvatar id={thread.headerAvatarId} size={26} />
        </View>

        {extraTurns.map((turn) => (
          <React.Fragment key={turn.id}>
            <View style={[styles.bubble, styles.userBubble]}>
              <Text style={styles.userBubbleText}>{turn.userText}</Text>
            </View>
            <View style={[styles.bubble, styles.botBubble]}>
              <Text style={styles.bubbleText}>{turn.botReply}</Text>
            </View>
            <View style={styles.signoff}>
              <BotMascotAvatar id={thread.headerAvatarId} size={26} />
            </View>
          </React.Fragment>
        ))}
      </ScrollView>

      {/* Bottom Split Native Liquid Glass Composer ("+" Left + Capsule Right with Single Blue Voice Orb) */}
      <View
        style={[
          styles.composerDock,
          { paddingBottom: Math.max(insets.bottom + 4, 14) },
        ]}
      >
        <GlassGroup spacing={10} style={styles.composerRow}>
          <GlassSurface interactive style={styles.plusGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择照片或拍照"
              style={styles.circleBtn}
              onPress={() => {
                hapticLight();
                onOpenMediaPicker();
              }}
            >
              <PlusIcon size={23} color="#F2F2F7" />
            </Pressable>
          </GlassSurface>

          <GlassSurface style={styles.capsuleGlass}>
            <View style={styles.capsuleInner}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder={`Ask ${thread.headerName}`}
                placeholderTextColor="rgba(235, 235, 245, 0.44)"
                keyboardAppearance="dark"
                returnKeyType="send"
                onSubmitEditing={handleSend}
                style={styles.textInput}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={draft.trim() ? '发送' : '实时语音'}
                style={styles.blueVoiceBtn}
                onPress={() => {
                  if (draft.trim()) {
                    handleSend();
                  } else {
                    hapticLight();
                    onToast(`与 ${thread.headerName} 实时通话`);
                  }
                }}
              >
                {draft.trim() ? (
                  <ArrowUpIcon size={18} color="#FFFFFF" />
                ) : (
                  <VoiceWaveIcon size={18} color="#FFFFFF" />
                )}
              </Pressable>
            </View>
          </GlassSurface>
        </GlassGroup>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  topFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  topBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 20,
  },
  navTitle: {
    position: 'absolute',
    left: 96,
    right: 96,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: '#F5F5F7',
    letterSpacing: -0.2,
  },
  topRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  chatHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  circleGlass: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  circleBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityGlass: {
    height: 44,
    borderRadius: 22,
  },
  identityBtn: {
    height: 44,
    paddingHorizontal: 14,
    paddingLeft: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  identityName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  scroll: {
    flex: 1,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
    marginBottom: 12,
    borderRadius: 13,
    backgroundColor: '#17171A',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14.5,
  },
  clearText: {
    color: '#8E8E93',
    fontSize: 12.5,
  },
  threadList: {
    gap: 4,
  },
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 16,
  },
  threadRowPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  threadBody: {
    flex: 1,
    gap: 4,
  },
  threadTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  threadTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#F5F5F7',
    letterSpacing: -0.2,
  },
  threadTime: {
    fontSize: 13,
    color: '#6C6C70',
  },
  threadBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  threadPreview: {
    flex: 1,
    fontSize: 14.5,
    color: '#8E8E93',
  },
  threadPreviewAmber: {
    color: '#E5A024',
    fontWeight: '500',
  },
  dot: {
    width: 8.5,
    height: 8.5,
    borderRadius: 4.25,
  },
  bubble: {
    maxWidth: '88%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  botBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#1A1A1E',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  compactBubble: {
    maxWidth: undefined,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#2B2C32',
    borderRadius: 22,
    paddingVertical: 10,
    paddingHorizontal: 17,
    marginVertical: 4,
  },
  bubbleText: {
    fontSize: 16,
    lineHeight: 24,
    color: '#F2F2F7',
  },
  userBubbleText: {
    fontSize: 16,
    lineHeight: 22,
    color: '#FFFFFF',
  },
  delegationRow: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  delegationText: {
    fontSize: 13,
    color: '#8E8E93',
  },
  delegationStrong: {
    fontSize: 13,
    fontWeight: '500',
    color: '#AEAEB2',
  },
  timestamp: {
    alignSelf: 'center',
    paddingVertical: 4,
    fontSize: 12.5,
    color: '#636366',
  },
  mediaStack: {
    gap: 8,
    marginTop: 2,
  },
  mediaCard: {
    width: 246,
    height: 124,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    backgroundColor: '#060608',
  },
  signoff: {
    marginTop: 2,
    paddingLeft: 2,
  },
  composerDock: {
    paddingHorizontal: 15,
    paddingTop: 8,
    backgroundColor: '#000000',
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  plusGlass: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  capsuleGlass: {
    flex: 1,
    height: 48,
    borderRadius: 24,
  },
  capsuleInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 6,
    gap: 10,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    color: '#FFFFFF',
    paddingVertical: 0,
  },
  blueVoiceBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#3262FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
