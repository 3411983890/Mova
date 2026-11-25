/**
 * 负责：纯黑 OLED 系统设置页（严格遵循图六 iOS 26 分组卡片样式，同时保留真实 Mova 云端配对与演示模式入口）。
 */
import { LinearGradient } from 'expo-linear-gradient';
import { router, Stack } from 'expo-router';
import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GlassSurface from '../components/glass-surface';
import { hapticLight, hapticSelection } from '../components/haptics';
import { ChevronRightIcon, CloseIcon } from '../components/ios-icons';
import type { CloudProvider } from '../features/chat/cloud-client';
import { useMobile } from '../features/chat/mobile-provider';

const providers: [CloudProvider, string][] = [
  ['research', '联网研究'],
  ['codex', 'GPT 订阅'],
  ['gemini', 'Gemini 订阅'],
  ['api', 'API 模型'],
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const {
    demoEnabled,
    setDemoEnabled,
    clear,
    cloudOrigin,
    cloudError,
    cloudProvider,
    cloudBots,
    cloudBot,
    cloudResearch,
    cloudPush,
    connectCloud,
    disconnectCloud,
    setCloudProvider,
    setCloudBot,
    setCloudResearch,
    setCloudPush,
  } = useMobile();

  const [autoTimezone, setAutoTimezone] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [origin, setOrigin] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert('连接操作失败', error instanceof Error ? error.message : '请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Top Fade + Floating Liquid Glass Close Button & Title */}
      <LinearGradient
        colors={['rgba(0,0,0,0.96)', 'rgba(0,0,0,0.74)', 'rgba(0,0,0,0)']}
        style={[styles.topFade, { height: insets.top + 64 }]}
        pointerEvents="none"
      />
      <View style={[styles.header, { top: insets.top + 6 }]}>
        <GlassSurface interactive style={styles.closeGlass}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭设置"
            style={styles.closeBtn}
            onPress={() => {
              hapticLight();
              router.back();
            }}
          >
            <CloseIcon size={18} color="#F5F5F7" />
          </Pressable>
        </GlassSurface>
        <Text style={styles.navTitle} pointerEvents="none">
          设置
        </Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: insets.top + 66,
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom + 36, 48),
          gap: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Account, Usage & Vault Card (Image 6) */}
        <View style={styles.card}>
          <Pressable
            style={styles.row}
            onPress={() => Alert.alert('Mova 账号', '雪瑞瑞瑞 · Apple ID 已安全登录')}
          >
            <View style={styles.accountLeft}>
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarText}>雪</Text>
              </View>
              <View style={styles.rowLeft}>
                <Text style={styles.accountName}>雪瑞瑞瑞</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  nwn2762dtp@privaterelay.appleid.com
                </Text>
              </View>
            </View>
            <ChevronRightIcon size={16} color="#58585D" />
          </Pressable>

          <View style={styles.sep} />

          <Pressable style={styles.row} onPress={() => Alert.alert('用量', '本月 Mova 云端额度已使用 0%')}>
            <Text style={styles.rowTitle}>用量</Text>
            <View style={styles.rowRight}>
              <Text style={styles.rowValue}>0%</Text>
              <ChevronRightIcon size={16} color="#58585D" />
            </View>
          </Pressable>

          <View style={styles.sep} />

          <Pressable
            style={styles.row}
            onPress={() => Alert.alert('保管库', '端到端加密存储 Mova Bot 可使用的登录凭据与联系信息')}
          >
            <View style={styles.rowLeft}>
              <Text style={styles.rowTitle}>保管库</Text>
              <Text style={styles.rowSub}>Mova Bot 可以使用的登录信息、卡片和联系信息</Text>
            </View>
            <ChevronRightIcon size={16} color="#58585D" />
          </Pressable>
        </View>

        {/* Connected Apps Card */}
        <View style={styles.card}>
          <Pressable
            style={styles.row}
            onPress={() => Alert.alert('连接应用', '管理已授权的 MCP 插件、日历与浏览器扩展')}
          >
            <View style={styles.rowLeft}>
              <Text style={styles.rowTitle}>连接应用</Text>
              <Text style={styles.rowSub}>搜索插件</Text>
            </View>
            <ChevronRightIcon size={16} color="#58585D" />
          </Pressable>
        </View>

        {/* Bot Section (Image 6) */}
        <View>
          <Text style={styles.sectionLabel}>Bot</Text>
          <View style={styles.card}>
            <Pressable
              style={styles.row}
              onPress={() => Alert.alert('权限', '配置 Bot 的文件写入、终端命令与人工接管审批边界')}
            >
              <Text style={styles.rowTitle}>权限</Text>
              <ChevronRightIcon size={16} color="#58585D" />
            </Pressable>

            <View style={styles.sep} />

            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowTitle}>自动设置时区</Text>
                <Text style={styles.rowSub}>Bot 的电脑跟随此设备的时区。</Text>
              </View>
              <Switch
                value={autoTimezone}
                onValueChange={(v) => {
                  hapticSelection();
                  setAutoTimezone(v);
                }}
                trackColor={{ false: '#39393D', true: '#30D158' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.sep} />

            <Pressable style={styles.row} onPress={() => Alert.alert('时区', '当前时区：Asia/Shanghai')}>
              <Text style={styles.rowTitle}>时区</Text>
              <Text style={styles.rowValue}>Asia/Shanghai</Text>
            </Pressable>

            <View style={styles.sep} />

            <Pressable
              style={styles.row}
              onPress={() => Alert.alert('Bot 电脑', 'Mova Linux 云工作站运行中 · 已放行 REALITY / TUIC')}
            >
              <Text style={styles.rowTitle}>Bot 电脑</Text>
              <ChevronRightIcon size={16} color="#58585D" />
            </Pressable>

            <View style={styles.sep} />

            <Pressable
              style={styles.row}
              onPress={() => Alert.alert('管理你的设备', '已登录：Windows 桌面端 · iPhone 16 Pro')}
            >
              <Text style={styles.rowTitle}>管理你的设备</Text>
              <ChevronRightIcon size={16} color="#58585D" />
            </Pressable>

            <View style={styles.sep} />

            <Pressable
              style={styles.row}
              onPress={() => Alert.alert('导入记忆', '支持从桌面端 Mova 同步长期记忆与对话偏好')}
            >
              <Text style={styles.rowTitle}>导入记忆</Text>
              <ChevronRightIcon size={16} color="#58585D" />
            </Pressable>
          </View>
        </View>

        {/* Notifications Card */}
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowTitle}>通知</Text>
            <Switch
              value={notifyEnabled}
              onValueChange={(v) => {
                hapticSelection();
                setNotifyEnabled(v);
              }}
              trackColor={{ false: '#39393D', true: '#30D158' }}
              thumbColor="#FFFFFF"
            />
          </View>
        </View>

        {/* Real Mova Linux Cloud Pairing & Demo Mode Section */}
        <View>
          <Text style={styles.sectionLabel}>云端服务连接</Text>
          <View style={[styles.card, styles.cloudCardPad]}>
            <Text style={styles.rowTitle}>{cloudOrigin ? '设备已配对' : '配对 Mova 服务'}</Text>
            {cloudOrigin ? (
              <>
                <Text style={styles.rowSub}>{cloudOrigin}</Text>
                <View style={styles.providersRow}>
                  {providers.map(([id, label]) => (
                    <Pressable
                      key={id}
                      disabled={busy}
                      onPress={() => void run(() => setCloudProvider(id))}
                      style={[
                        styles.providerChip,
                        id === cloudProvider && styles.providerChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.providerChipText,
                          id === cloudProvider && { color: '#7EA5FF' },
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {cloudProvider !== 'research' && (
                  <View style={styles.inlineRow}>
                    <Text style={styles.rowTitle}>先联网检索</Text>
                    <Switch
                      value={cloudResearch}
                      disabled={busy}
                      onValueChange={(v) => void run(() => setCloudResearch(v))}
                      trackColor={{ false: '#39393D', true: '#30D158' }}
                      thumbColor="#FFFFFF"
                    />
                  </View>
                )}

                {cloudBots.length > 1 && (
                  <View style={styles.providersRow}>
                    {cloudBots.map((bot) => (
                      <Pressable
                        key={bot.id}
                        disabled={busy}
                        onPress={() => void run(() => setCloudBot(bot.id))}
                        style={[styles.providerChip, cloudBot === bot.id && styles.providerChipActive]}
                      >
                        <Text
                          style={[
                            styles.providerChipText,
                            cloudBot === bot.id && { color: '#7EA5FF' },
                          ]}
                        >
                          {bot.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                <View style={styles.inlineRow}>
                  <Text style={styles.rowTitle}>任务状态推送</Text>
                  <Switch
                    value={cloudPush}
                    disabled={busy}
                    onValueChange={(v) => void run(() => setCloudPush(v))}
                    trackColor={{ false: '#39393D', true: '#30D158' }}
                    thumbColor="#FFFFFF"
                  />
                </View>

                <Pressable disabled={busy} onPress={() => void run(disconnectCloud)}>
                  <Text style={styles.dangerText}>断开此设备</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.rowSub}>
                  在桌面「云端与连接」生成手机配对码，再填入同一个 HTTPS 地址。
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  keyboardAppearance="dark"
                  placeholder="https://mova.example.com"
                  placeholderTextColor="#636366"
                  value={origin}
                  onChangeText={setOrigin}
                  style={styles.input}
                />
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  keyboardAppearance="dark"
                  placeholder="一次性配对码"
                  placeholderTextColor="#636366"
                  value={code}
                  onChangeText={setCode}
                  style={styles.input}
                />
                <View style={styles.inlineRow}>
                  <Pressable
                    disabled={busy || !origin.trim() || !code.trim()}
                    onPress={() =>
                      void run(async () => {
                        await connectCloud(origin, code);
                        setCode('');
                      })
                    }
                  >
                    <Text
                      style={{
                        color: busy || !origin.trim() || !code.trim() ? '#636366' : '#3262FF',
                        fontSize: 15.5,
                        fontWeight: '600',
                      }}
                    >
                      配对设备
                    </Text>
                  </Pressable>
                  <View style={styles.inlineRight}>
                    <Text style={styles.rowSub}>本地演示</Text>
                    <Switch
                      value={demoEnabled}
                      onValueChange={(v) => {
                        hapticSelection();
                        setDemoEnabled(v);
                      }}
                      trackColor={{ false: '#39393D', true: '#30D158' }}
                      thumbColor="#FFFFFF"
                    />
                  </View>
                </View>
              </>
            )}
            {!!cloudError && <Text style={styles.dangerText}>{cloudError}</Text>}
          </View>
        </View>

        {!cloudOrigin && (
          <View style={styles.card}>
            <Pressable
              style={styles.row}
              onPress={() =>
                Alert.alert('清空演示记录？', '本次运行中的所有演示对话将被清除。', [
                  { text: '取消', style: 'cancel' },
                  { text: '清空', style: 'destructive', onPress: clear },
                ])
              }
            >
              <Text style={styles.dangerText}>清空演示对话记录</Text>
            </Pressable>
          </View>
        )}

        <Text style={styles.footer}>Mova iOS · Expo Go 原生液态玻璃预览</Text>
      </ScrollView>
    </View>
  );
}

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
  closeGlass: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  closeBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#F5F5F7',
  },
  scroll: {
    flex: 1,
  },
  sectionLabel: {
    marginLeft: 14,
    marginBottom: 8,
    fontSize: 13.5,
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
  cloudCardPad: {
    padding: 18,
    gap: 12,
  },
  row: {
    minHeight: 54,
    paddingHorizontal: 18,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  accountLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  avatarCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3A3A3E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  accountName: {
    fontSize: 16.5,
    fontWeight: '600',
    color: '#F5F5F7',
  },
  rowLeft: {
    flex: 1,
    gap: 3,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowTitle: {
    fontSize: 16,
    color: '#F5F5F7',
  },
  rowSub: {
    fontSize: 13,
    color: '#8E8E93',
    lineHeight: 18,
  },
  rowValue: {
    fontSize: 15.5,
    color: '#8E8E93',
  },
  sep: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
  },
  input: {
    height: 44,
    paddingHorizontal: 13,
    borderRadius: 12,
    backgroundColor: '#0E0E11',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    color: '#FFFFFF',
    fontSize: 14.5,
  },
  providersRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  providerChip: {
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    justifyContent: 'center',
  },
  providerChipActive: {
    borderColor: '#3262FF',
    backgroundColor: 'rgba(50, 98, 255, 0.16)',
  },
  providerChipText: {
    fontSize: 13.5,
    color: '#F5F5F7',
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
  },
  inlineRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dangerText: {
    fontSize: 15.5,
    color: '#FF453A',
    fontWeight: '500',
  },
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: '#636366',
    marginTop: 8,
  },
});
