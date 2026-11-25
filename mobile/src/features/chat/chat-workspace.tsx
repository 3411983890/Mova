/**
 * 负责：装配 Mova 手机端完整主画布（ChatMova / CodeMova / MovaBot 三模式、iOS 26 原生液态玻璃与 Reanimated 弹簧抽屉、居中磨砂模型强度选择、悬浮相册与相机弹窗）。
 */
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GlassSurface from '../../components/glass-surface';
import { hapticLight } from '../../components/haptics';
import { EllipsisIcon, MenuLinesIcon } from '../../components/ios-icons';
import { showActionMenu } from '../../components/show-action-menu';
import { BotSettingsView } from '../bot/bot-settings-view';
import { MovaBotChatView, MovaBotHomeView } from '../bot/mova-bot-views';
import {
  BOT_CONTACTS,
  MOVA_MODELS,
  MOVABOT_THREADS,
  type BotContactProfile,
  type BotThreadItem,
  type EffortLevelId,
  type MovaAppMode,
  type MovaModelOption,
} from '../design/mova-design-data';
import ChatComposer from './chat-composer';
import ChatMessage, { DefaultShowcaseStream } from './chat-message';
import ConversationDrawer from './conversation-drawer';
import { EffortModelModal } from './effort-model-modal';
import { useMobile } from './mobile-provider';
import { PhotoCameraSheet } from './photo-camera-sheet';
import { useReplyActions } from './use-reply-actions';

const DEFAULT_MODEL =
  MOVA_MODELS.find((m) => m.id === 'gemini-4-hydrogen') ?? MOVA_MODELS[0];

export default function ChatWorkspace({ requestedId }: { requestedId?: string }) {
  const {
    state,
    activeId,
    selectConversation,
    newConversation,
    send,
    remove,
    demoEnabled,
    cloudOrigin,
    cloudError,
    activeCloudTask,
    cancelCloudTask,
    retryableCloudTask,
    retryCloudTask,
  } = useMobile();

  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(314, Math.round(width * 0.79));
  const listRef = useRef<FlatList>(null);

  const [appMode, setAppMode] = useState<MovaAppMode>('ChatMova');
  const [navTitle, setNavTitle] = useState('工作');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [sending, setSending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Model & Reasoning Effort
  const [selectedModel, setSelectedModel] = useState<MovaModelOption>(DEFAULT_MODEL);
  const [effort, setEffort] = useState<EffortLevelId>('high');
  const [modelModalOpen, setModelModalOpen] = useState(false);

  // Photo Picker & Live Camera Sheet
  const [mediaSheetOpen, setMediaSheetOpen] = useState(false);

  // MovaBot Navigation State
  const [botSubScreen, setBotSubScreen] = useState<'list' | 'chat' | 'settings'>('list');
  const [activeBotThread, setActiveBotThread] = useState<BotThreadItem>(MOVABOT_THREADS[0]);
  const [activeBotContact, setActiveBotContact] = useState<BotContactProfile>(BOT_CONTACTS[0]);
  const [isCreatingBot, setIsCreatingBot] = useState(false);

  // Capsule Toast
  const [toastText, setToastText] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToastText(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastText(null), 2000);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Reanimated Drawer Spring Progress (0 = closed, 1 = open)
  const drawerProgress = useSharedValue(0);

  useEffect(() => {
    if (requestedId) selectConversation(requestedId);
  }, [requestedId]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true)
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false)
    );
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
    return () => {
      show.remove();
      hide.remove();
      motion.remove();
    };
  }, []);

  useEffect(() => {
    drawerProgress.value = withTiming(drawerOpen ? 1 : 0, {
      duration: reduceMotion ? 0 : 260,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    });
  }, [drawerOpen, reduceMotion, drawerProgress]);

  const canvasAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drawerProgress.value * drawerWidth }],
    borderRadius: interpolate(drawerProgress.value, [0, 1], [0, 44]),
    borderWidth: interpolate(drawerProgress.value, [0, 1], [0, 1]),
    borderColor: interpolateColor(
      drawerProgress.value,
      [0, 1],
      ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.13)']
    ),
    backgroundColor: interpolateColor(drawerProgress.value, [0, 1], ['#000000', '#141417']),
  }));

  /* 侧栏展开时主视图整体轻微变灰并柔化对比度，与设计稿一致 */
  const canvasContentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drawerProgress.value, [0, 1], [1, 0.66]),
  }));

  const drawerGrayVeilStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value,
  }));

  const conversation = state.conversations.find((item) => item.id === activeId);
  const actions = useReplyActions(conversation?.id);
  const draftKey = conversation?.id ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const showShowcaseStream =
    !cloudOrigin && (!conversation || conversation.id === 'welcome') && (conversation?.messages.length ?? 0) <= 2;

  const openDrawer = () => {
    Keyboard.dismiss();
    setDrawerOpen(true);
  };
  const closeDrawer = () => setDrawerOpen(false);
  const openSettings = () => {
    closeDrawer();
    Keyboard.dismiss();
    router.push('/settings');
  };

  const startNewChat = () => {
    newConversation();
    setNavTitle('新对话');
    if (appMode === 'MovaBot') setAppMode('ChatMova');
    closeDrawer();
    Keyboard.dismiss();
    showToast('已开启新对话');
  };

  const startNewBot = () => {
    setAppMode('MovaBot');
    setActiveBotContact(BOT_CONTACTS[0]);
    setIsCreatingBot(true);
    setBotSubScreen('settings');
    closeDrawer();
  };

  const sendDraft = async () => {
    if ((!cloudOrigin && !demoEnabled) || sending || !draft.trim()) return;
    const id = conversation?.id ?? newConversation();
    setSending(true);
    try {
      await send(id, draft);
      setDrafts((cur) => ({ ...cur, [draftKey]: '', [id]: '' }));
    } catch (error) {
      Alert.alert('发送失败', error instanceof Error ? error.message : '请重试。');
    } finally {
      setSending(false);
    }
  };

  const deleteChat = (id: string) => {
    if (cloudOrigin) {
      Alert.alert('云端对话', '云端记录保存在共享工作区。');
      return;
    }
    Alert.alert('删除演示对话？', '此操作会移除本次运行中的这段对话。', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => remove(id) },
    ]);
  };

  const openMoreMenu = () => {
    hapticLight();
    showActionMenu(`${appMode} · ${selectedModel.name}`, [
      { title: '新聊天', run: startNewChat },
      { title: '切换模型与思考强度', run: () => setModelModalOpen(true) },
      { title: '系统设置', run: openSettings },
      ...(conversation && !cloudOrigin
        ? [{ title: '删除当前对话', destructive: true, run: () => deleteChat(conversation.id) }]
        : []),
      ...(activeCloudTask
        ? [
            {
              title: '取消云端任务',
              run: () => {
                void cancelCloudTask(activeCloudTask).catch((err) =>
                  Alert.alert('取消失败', err.message)
                );
              },
            },
          ]
        : []),
      ...(retryableCloudTask
        ? [
            {
              title: '重试云端任务',
              run: () => {
                void retryCloudTask(retryableCloudTask).catch((err) =>
                  Alert.alert('重试失败', err.message)
                );
              },
            },
          ]
        : []),
    ]);
  };

  return (
    <View style={styles.root}>
      {/* Left 3-Mode Sidebar Drawer */}
      <ConversationDrawer
        open={drawerOpen}
        width={drawerWidth}
        appMode={appMode}
        onChangeMode={(nextMode) => {
          setAppMode(nextMode);
          if (nextMode === 'MovaBot') {
            setBotSubScreen('list');
          } else if (nextMode === 'CodeMova') {
            setNavTitle('Mova');
          } else {
            setNavTitle('工作');
          }
        }}
        onClose={closeDrawer}
        onNewChat={startNewChat}
        onNewBot={startNewBot}
        onOpenSettings={openSettings}
        onSelectConversation={(id, title) => {
          selectConversation(id);
          if (title) setNavTitle(title.slice(0, 10));
          closeDrawer();
        }}
        onSelectBotContact={(bot) => {
          setActiveBotContact(bot);
          setIsCreatingBot(false);
          setBotSubScreen('settings');
          closeDrawer();
        }}
        onDeleteConversation={deleteChat}
        onToast={showToast}
      />

      {/* Right Main Card with Smooth Non-Bouncy Slide + Gray Elevated Card Tint */}
      <Animated.View style={[styles.canvas, canvasAnimatedStyle]}>
        <Animated.View style={[styles.page, canvasContentStyle]}>
        {appMode === 'MovaBot' ? (
          botSubScreen === 'list' ? (
            <MovaBotHomeView
              onOpenDrawer={openDrawer}
              onSelectThread={(thread) => {
                setActiveBotThread(thread);
                setBotSubScreen('chat');
              }}
              onNewBot={startNewBot}
              onToast={showToast}
            />
          ) : botSubScreen === 'settings' ? (
            <BotSettingsView
              bot={activeBotContact}
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
              onBack={() => setBotSubScreen('list')}
              onOpenMediaPicker={() => setMediaSheetOpen(true)}
              onToast={showToast}
            />
          )
        ) : (
          /* ChatMova & CodeMova Main Workspace */
          <KeyboardAvoidingView
            style={styles.page}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            {/* Floating Top Native Liquid Glass Navigation Bar (Left Menu + Title + Single Right "⋯") */}
            <LinearGradient
              colors={['rgba(0,0,0,0.96)', 'rgba(0,0,0,0.68)', 'rgba(0,0,0,0)']}
              style={[styles.topFade, { height: insets.top + 66 }]}
              pointerEvents="none"
            />
            <View style={[styles.header, { top: insets.top + 6 }]}>
              <GlassSurface interactive style={styles.circleGlass}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="打开侧边栏"
                  style={styles.centerFill}
                  onPress={() => {
                    hapticLight();
                    openDrawer();
                  }}
                >
                  <MenuLinesIcon size={20} color="#F5F5F7" />
                </Pressable>
              </GlassSurface>

              <Text accessibilityRole="header" pointerEvents="none" style={styles.headerTitle}>
                {navTitle}
              </Text>

              <GlassSurface interactive style={styles.circleGlass}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="更多操作"
                  style={styles.centerFill}
                  onPress={openMoreMenu}
                >
                  <EllipsisIcon size={19} color="#F5F5F7" />
                </Pressable>
              </GlassSurface>
            </View>

            {/* Edge-to-Edge Scrolling Conversation Stream */}
            <FlatList
              ref={listRef}
              data={showShowcaseStream ? [] : (conversation?.messages ?? [])}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{
                paddingTop: insets.top + 66,
                paddingHorizontal: 18,
                paddingBottom: 24,
                gap: 24,
                flexGrow: 1,
              }}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => {
                if (!showShowcaseStream) {
                  listRef.current?.scrollToEnd({ animated: !reduceMotion });
                }
              }}
              ListHeaderComponent={
                showShowcaseStream ? <DefaultShowcaseStream onToast={showToast} /> : undefined
              }
              ListEmptyComponent={
                showShowcaseStream ? undefined : (
                  <View style={styles.welcome}>
                    <Text style={styles.welcomeBrand}>{appMode}</Text>
                    <Text style={styles.welcomeTitle}>今天，有什么想聊的？</Text>
                    <Text style={styles.welcomeHint}>
                      随时提问，或点击左下角「+」拍照与发送图片。
                    </Text>
                  </View>
                )
              }
              renderItem={({ item }) => (
                <ChatMessage
                  message={item}
                  actions={actions}
                  onRegenerate={() => showToast('正在重新生成此条回复')}
                />
              )}
            />

            {cloudError ? (
              <Text style={styles.connectionHint}>{cloudError}</Text>
            ) : (
              !cloudOrigin &&
              !demoEnabled && (
                <Text style={styles.connectionHint}>服务尚未连接 · 可在设置中开启演示模式</Text>
              )
            )}

            {/* Bottom Floating Liquid Glass Composer */}
            <View
              style={[
                styles.composerDock,
                { paddingBottom: keyboardVisible ? 10 : Math.max(insets.bottom + 4, 14) },
              ]}
            >
              <ChatComposer
                draft={draft}
                onChange={(text) => setDrafts((cur) => ({ ...cur, [draftKey]: text }))}
                onSend={() => void sendDraft()}
                onVoicePress={() => showToast(`${appMode} 实时语音协作`)}
                onOpenMediaPicker={() => setMediaSheetOpen(true)}
                onOpenModelEffort={() => setModelModalOpen(true)}
                selectedModel={selectedModel}
                effort={effort}
                enabled={!sending && (Boolean(cloudOrigin) || demoEnabled)}
                placeholder={appMode === 'CodeMova' ? '输入代码指令或任务' : '与 Mova 协作'}
              />
            </View>
          </KeyboardAvoidingView>
        )}
        </Animated.View>

        {/* Gray Elevated Surface Veil when Drawer is Open (Matches Design Screenshot) */}
        <Animated.View
          style={[styles.drawerGrayVeil, drawerGrayVeilStyle]}
          pointerEvents={drawerOpen ? 'auto' : 'none'}
        >
          {drawerOpen && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭侧边栏"
              onPress={() => {
                hapticLight();
                closeDrawer();
              }}
              style={StyleSheet.absoluteFill}
            />
          )}
        </Animated.View>

        {/* Native Capsule Toast */}
        {toastText && (
          <Animated.View
            entering={FadeIn.duration(160)}
            exiting={FadeOut.duration(140)}
            style={[styles.toastWrap, { top: insets.top + 60 }]}
            pointerEvents="none"
          >
            <GlassSurface style={styles.toastGlass}>
              <Text style={styles.toastText}>{toastText}</Text>
            </GlassSurface>
          </Animated.View>
        )}
      </Animated.View>

      {/* Centered Frosted-Band Model & Reasoning Effort Selector */}
      <EffortModelModal
        visible={modelModalOpen}
        selectedModel={selectedModel}
        effort={effort}
        onSelectModel={(m) => {
          setSelectedModel(m);
          showToast(`已切换模型：${m.name}`);
        }}
        onChangeEffort={setEffort}
        onClose={() => setModelModalOpen(false)}
      />

      {/* Floating Inset Concentric Photo Picker & Live Camera Sheet */}
      <PhotoCameraSheet
        visible={mediaSheetOpen}
        onClose={() => setMediaSheetOpen(false)}
        onAttach={(summary) => showToast(summary)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  canvas: {
    flex: 1,
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  page: {
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
  header: {
    position: 'absolute',
    left: 16,
    right: 16,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 20,
  },
  circleGlass: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    position: 'absolute',
    left: 88,
    right: 88,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: '#F5F5F7',
    letterSpacing: -0.2,
  },
  composerDock: {
    paddingHorizontal: 15,
    paddingTop: 8,
    backgroundColor: '#000000',
  },
  connectionHint: {
    fontSize: 12,
    color: '#8E8E93',
    textAlign: 'center',
    paddingHorizontal: 20,
    paddingBottom: 4,
  },
  welcome: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 110,
  },
  welcomeBrand: {
    fontSize: 34,
    fontWeight: '600',
    color: '#F5F5F7',
    letterSpacing: -1,
  },
  welcomeTitle: {
    fontSize: 19,
    fontWeight: '500',
    color: '#E5E5EA',
  },
  welcomeHint: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
  },
  drawerGrayVeil: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(42, 42, 48, 0.38)',
    zIndex: 30,
  },
  toastWrap: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 50,
  },
  toastGlass: {
    borderRadius: 99,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  toastText: {
    fontSize: 13.5,
    fontWeight: '500',
    color: '#FFFFFF',
  },
});
