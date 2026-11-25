/**
 * 负责：点击 MovaBot 通讯录中任意 Bot 或 "+" 后进入的单 Bot 设置页（纯黑 OLED + iOS 26 分组卡片）。
 */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BotMascotAvatar } from '../../components/bot-avatars';
import GlassSurface from '../../components/glass-surface';
import { hapticLight, hapticSelection } from '../../components/haptics';
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/ios-icons';
import type { BotContactProfile } from '../design/mova-design-data';

type BotSettingsViewProps = {
  bot: BotContactProfile;
  isCreatingNew?: boolean;
  onBack: () => void;
  onStartChat: (bot: BotContactProfile) => void;
  onToast: (msg: string) => void;
};

export const BotSettingsView: React.FC<BotSettingsViewProps> = ({
  bot,
  isCreatingNew = false,
  onBack,
  onStartChat,
  onToast,
}) => {
  const insets = useSafeAreaInsets();
  const [webSearch, setWebSearch] = useState(bot.webSearch);
  const [memoryEnabled, setMemoryEnabled] = useState(bot.memoryEnabled);
  const [canDelegate, setCanDelegate] = useState(bot.canDelegate);
  const [muted, setMuted] = useState(bot.defaultMuted);

  useEffect(() => {
    setWebSearch(bot.webSearch);
    setMemoryEnabled(bot.memoryEnabled);
    setCanDelegate(bot.canDelegate);
    setMuted(bot.defaultMuted);
  }, [bot]);

  return (
    <View style={styles.screen}>
      <LinearGradient
        colors={['rgba(0,0,0,0.96)', 'rgba(0,0,0,0.72)', 'rgba(0,0,0,0)']}
        style={[styles.topFade, { height: insets.top + 64 }]}
        pointerEvents="none"
      />

      <View style={[styles.header, { top: insets.top + 6 }]}>
        <GlassSurface interactive style={styles.circleGlass}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回通讯录"
            style={styles.circleBtn}
            onPress={() => {
              hapticLight();
              onBack();
            }}
          >
            <ChevronLeftIcon size={20} color="#F5F5F7" />
          </Pressable>
        </GlassSurface>

        <Text style={styles.navTitle} pointerEvents="none">
          {isCreatingNew ? '新建 Bot' : 'Bot 设置'}
        </Text>

        <GlassSurface interactive style={styles.doneGlass}>
          <Pressable
            style={styles.doneBtn}
            onPress={() => {
              hapticLight();
              onToast(isCreatingNew ? '已创建新智能体并同步至云端' : `已保存 ${bot.name} 的配置`);
            }}
          >
            <Text style={styles.doneText}>完成</Text>
          </Pressable>
        </GlassSurface>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: insets.top + 66,
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom + 32, 44),
          gap: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero Card */}
        <View style={styles.heroCard}>
          <BotMascotAvatar
            id={bot.avatarId}
            size={64}
            onlineDot={bot.online}
            dotBorderColor="#171719"
          />
          <Text style={styles.heroName}>{isCreatingNew ? '未命名智能体' : bot.name}</Text>
          <Text style={styles.heroRole}>{bot.roleTitle}</Text>
          <View style={styles.tagsRow}>
            <View style={styles.tagPill}>
              <Text style={styles.tagText}>{bot.tag}</Text>
            </View>
            {bot.builtin && (
              <View style={[styles.tagPill, styles.tagPillAccent]}>
                <Text style={[styles.tagText, { color: '#7EA5FF' }]}>系统内置</Text>
              </View>
            )}
            <View style={styles.tagPill}>
              <Text style={styles.tagText}>{bot.online ? '云电脑在线' : '待命中'}</Text>
            </View>
          </View>
          <Text style={styles.heroBio}>{bot.bio}</Text>
        </View>

        {/* Model & Persona */}
        <View>
          <Text style={styles.sectionLabel}>模型与人设</Text>
          <View style={styles.card}>
            <Pressable
              style={styles.row}
              onPress={() => onToast(`模型：${bot.model} · 思考强度 ${bot.effort}`)}
            >
              <Text style={styles.rowTitle}>默认模型</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{bot.model}</Text>
                <ChevronRightIcon size={16} color="#58585D" />
              </View>
            </Pressable>
            <View style={styles.sep} />
            <Pressable style={styles.row} onPress={() => onToast(`思考强度：${bot.effort}`)}>
              <Text style={styles.rowTitle}>思考强度</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{bot.effort}</Text>
                <ChevronRightIcon size={16} color="#58585D" />
              </View>
            </Pressable>
            <View style={styles.sep} />
            <Pressable style={styles.row} onPress={() => onToast('编辑系统提示词与说话风格')}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowTitle}>说话风格</Text>
                <Text style={styles.rowSub}>{bot.tone}</Text>
              </View>
              <ChevronRightIcon size={16} color="#58585D" />
            </Pressable>
          </View>
        </View>

        {/* Capabilities & Permissions */}
        <View>
          <Text style={styles.sectionLabel}>权限与协同能力</Text>
          <View style={styles.card}>
            <Pressable style={styles.row} onPress={() => onToast(`群聊角色：${bot.collabRole}`)}>
              <Text style={styles.rowTitle}>群聊职责</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{bot.collabRole}</Text>
                <ChevronRightIcon size={16} color="#58585D" />
              </View>
            </Pressable>
            <View style={styles.sep} />
            <Pressable style={styles.row} onPress={() => onToast(`浏览器策略：${bot.browserPolicy}`)}>
              <Text style={styles.rowTitle}>云浏览器权限</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{bot.browserPolicy}</Text>
                <ChevronRightIcon size={16} color="#58585D" />
              </View>
            </Pressable>
            <View style={styles.sep} />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowTitle}>允许联网研究</Text>
                <Text style={styles.rowSub}>多源并发检索并校验引用来源</Text>
              </View>
              <Switch
                value={webSearch}
                onValueChange={(v) => {
                  hapticSelection();
                  setWebSearch(v);
                }}
                trackColor={{ false: '#39393D', true: '#30D158' }}
                thumbColor="#FFFFFF"
              />
            </View>
            <View style={styles.sep} />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowTitle}>独立长期记忆</Text>
                <Text style={styles.rowSub}>跨会话沉淀项目上下文与偏好</Text>
              </View>
              <Switch
                value={memoryEnabled}
                onValueChange={(v) => {
                  hapticSelection();
                  setMemoryEnabled(v);
                }}
                trackColor={{ false: '#39393D', true: '#30D158' }}
                thumbColor="#FFFFFF"
              />
            </View>
            <View style={styles.sep} />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowTitle}>允许委派其他 Bot</Text>
                <Text style={styles.rowSub}>在群聊中向 Maker、Review 派发子任务</Text>
              </View>
              <Switch
                value={canDelegate}
                onValueChange={(v) => {
                  hapticSelection();
                  setCanDelegate(v);
                }}
                trackColor={{ false: '#39393D', true: '#30D158' }}
                thumbColor="#FFFFFF"
              />
            </View>
          </View>
        </View>

        {/* Notifications */}
        <View>
          <Text style={styles.sectionLabel}>免打扰与通知</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.rowTitle}>静音此 Bot 推送</Text>
              <Switch
                value={muted}
                onValueChange={(v) => {
                  hapticSelection();
                  setMuted(v);
                }}
                trackColor={{ false: '#39393D', true: '#30D158' }}
                thumbColor="#FFFFFF"
              />
            </View>
            <View style={styles.sep} />
            <Pressable style={styles.row} onPress={() => onToast(`安静时段：${bot.quietHours}`)}>
              <Text style={styles.rowTitle}>安静时段</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{bot.quietHours}</Text>
                <ChevronRightIcon size={16} color="#58585D" />
              </View>
            </Pressable>
          </View>
        </View>

        {/* Primary Action */}
        <GlassSurface interactive tint="#3262FF" style={styles.startChatGlass}>
          <Pressable
            style={styles.startChatBtn}
            onPress={() => {
              hapticLight();
              onStartChat(bot);
            }}
          >
            <Text style={styles.startChatText}>
              {isCreatingNew ? '创建并开始对话' : `发消息给 ${bot.name}`}
            </Text>
          </Pressable>
        </GlassSurface>
      </ScrollView>
    </View>
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
  navTitle: {
    position: 'absolute',
    left: 88,
    right: 88,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: '#F5F5F7',
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
  doneGlass: {
    height: 38,
    borderRadius: 19,
  },
  doneBtn: {
    height: 38,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#F5F5F7',
  },
  scroll: {
    flex: 1,
  },
  heroCard: {
    borderRadius: 24,
    backgroundColor: '#171719',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 20,
    alignItems: 'center',
    gap: 6,
  },
  heroName: {
    fontSize: 21,
    fontWeight: '600',
    color: '#F5F5F7',
    marginTop: 6,
  },
  heroRole: {
    fontSize: 13.5,
    color: '#8E8E93',
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    marginTop: 6,
  },
  tagPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
  },
  tagPillAccent: {
    backgroundColor: 'rgba(50, 98, 255, 0.2)',
  },
  tagText: {
    fontSize: 11.5,
    color: '#D1D1D6',
    fontWeight: '500',
  },
  heroBio: {
    marginTop: 8,
    fontSize: 13.5,
    lineHeight: 20,
    color: '#AEAEB2',
    textAlign: 'center',
  },
  sectionLabel: {
    marginLeft: 14,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '500',
    color: '#8E8E93',
  },
  card: {
    borderRadius: 24,
    backgroundColor: '#171719',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  row: {
    minHeight: 54,
    paddingHorizontal: 18,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowLeft: {
    flex: 1,
    gap: 3,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '58%',
  },
  rowTitle: {
    fontSize: 16,
    color: '#F5F5F7',
  },
  rowSub: {
    fontSize: 12.5,
    color: '#8E8E93',
    lineHeight: 17,
  },
  rowValue: {
    fontSize: 15,
    color: '#8E8E93',
  },
  sep: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
  },
  startChatGlass: {
    height: 52,
    borderRadius: 26,
    marginTop: 6,
  },
  startChatBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startChatText: {
    fontSize: 16.5,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
