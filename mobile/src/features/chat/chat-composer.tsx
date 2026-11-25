/**
 * 负责：iOS 26 原生 Liquid Glass 融合变形输入栏。
 * - 空闲态：左侧独立 48×48 "+" 玻璃球 + 右侧 48pt 玻璃胶囊（单枚蓝色声波球）。
 * - 聚焦态：左侧 "+" 按钮与右侧输入胶囊丝滑融合为一个 96pt 双层液态玻璃输入卡片；
 *   全程复用同一个 TextInput 实例（永不卸载重建），彻底消除点击闪屏，动效采用无过冲的 iOS 平滑缓出曲线。
 */
import React, { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import GlassSurface, { GlassGroup } from '../../components/glass-surface';
import { hapticLight } from '../../components/haptics';
import { ArrowUpIcon, PlusIcon, VoiceWaveIcon } from '../../components/ios-icons';
import {
  EFFORT_CATALOG,
  type EffortLevelId,
  type MovaModelOption,
} from '../design/mova-design-data';
import { MAX_MESSAGE_LENGTH } from './chat-state';

const IOS_SMOOTH_EASE = Easing.bezier(0.22, 1, 0.36, 1);

type ChatComposerProps = {
  draft: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onVoicePress: () => void;
  onOpenMediaPicker: () => void;
  onOpenModelEffort: () => void;
  selectedModel: MovaModelOption;
  effort: EffortLevelId;
  enabled: boolean;
  placeholder?: string;
};

export default function ChatComposer({
  draft,
  onChange,
  onSend,
  onVoicePress,
  onOpenMediaPicker,
  onOpenModelEffort,
  selectedModel,
  effort,
  enabled,
  placeholder = '与 Mova 协作',
}: ChatComposerProps) {
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);

  const expanded = focused || draft.length > 0;
  const hasText = draft.trim().length > 0;
  const canSend = enabled && hasText;

  const progress = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, {
      duration: 240,
      easing: IOS_SMOOTH_EASE,
    });
  }, [expanded, progress]);

  const handleActionPress = () => {
    hapticLight();
    if (hasText) {
      if (canSend) onSend();
    } else {
      onVoicePress();
    }
  };

  /* 左侧独立 "+" 玻璃球：向右侧滑入并与主输入栏融合消失 */
  const leftPlusAnimatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.55], [1, 0]),
    transform: [
      { translateX: interpolate(progress.value, [0, 1], [0, 18]) },
      { scale: interpolate(progress.value, [0, 1], [1, 0.86]) },
    ],
  }));

  /* 主玻璃卡片：从右侧 48pt 胶囊向左扩展吞并 "+" 空间并平稳升高至 96pt */
  const mainCardAnimatedStyle = useAnimatedStyle(() => ({
    marginLeft: interpolate(progress.value, [0, 1], [58, 0]),
    height: interpolate(progress.value, [0, 1], [48, 96]),
  }));

  /* 单一持久化 TextInput 容器：始终不卸载，位置从居中胶囊平滑过渡到卡片顶行 */
  const inputBoxAnimatedStyle = useAnimatedStyle(() => ({
    top: interpolate(progress.value, [0, 1], [0, 8]),
    height: interpolate(progress.value, [0, 1], [48, 42]),
    paddingLeft: interpolate(progress.value, [0, 1], [16, 15]),
    paddingRight: interpolate(progress.value, [0, 1], [50, 15]),
  }));

  /* 展开后的左下角 "+" 按钮与右侧模型标签平滑显现 */
  const innerToolsAnimatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.32, 1], [0, 1]),
    transform: [{ translateY: interpolate(progress.value, [0.32, 1], [6, 0]) }],
  }));

  return (
    <View style={styles.outerWrap}>
      <GlassGroup spacing={16} style={styles.morphStage}>
        {/* Left Standalone "+" Glass Circle (Idle -> slides & merges into main card) */}
        <Animated.View
          style={[styles.leftPlusAbs, leftPlusAnimatedStyle]}
          pointerEvents={expanded ? 'none' : 'auto'}
        >
          <GlassSurface interactive style={styles.plusCircleGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择照片或拍照"
              style={styles.centerFill}
              disabled={!enabled || expanded}
              onPress={() => {
                hapticLight();
                Keyboard.dismiss();
                onOpenMediaPicker();
              }}
            >
              <PlusIcon size={23} color="#F2F2F7" />
            </Pressable>
          </GlassSurface>
        </Animated.View>

        {/* Main Liquid Glass Capsule -> Smoothly expands leftward & upward into Unified 96pt Card */}
        <Animated.View style={[styles.mainCardWrap, mainCardAnimatedStyle]}>
          <GlassSurface style={styles.mainCardGlass}>
            {/* Single Persistent TextInput (Never Unmounts -> Zero Flicker!) */}
            <Animated.View style={[styles.inputLayer, inputBoxAnimatedStyle]}>
              <TextInput
                ref={inputRef}
                accessibilityLabel="消息输入框"
                value={draft}
                onChangeText={onChange}
                placeholder={enabled ? placeholder : '服务尚未连接'}
                placeholderTextColor="rgba(235, 235, 245, 0.44)"
                multiline
                scrollEnabled={expanded}
                editable={enabled}
                maxLength={MAX_MESSAGE_LENGTH}
                keyboardAppearance="dark"
                selectionColor="#3262FF"
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                style={styles.textInput}
              />
            </Animated.View>

            {/* Bottom Expanded Tools (Inner "+" Left + Model Selector Right, seamlessly revealed) */}
            <Animated.View
              style={[styles.expandedToolsRow, innerToolsAnimatedStyle]}
              pointerEvents={expanded ? 'box-none' : 'none'}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="选择照片或拍照"
                style={styles.plainPlusBtn}
                onPress={() => {
                  hapticLight();
                  Keyboard.dismiss();
                  onOpenMediaPicker();
                }}
              >
                <PlusIcon size={24} color="#F2F2F7" />
              </Pressable>

              <View style={{ flex: 1 }} />

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`模型与思考强度：${selectedModel.name} ${EFFORT_CATALOG[effort].short}`}
                style={styles.modelSelectorBtn}
                onPress={() => {
                  hapticLight();
                  Keyboard.dismiss();
                  onOpenModelEffort();
                }}
              >
                <Text style={styles.modelNameText} numberOfLines={1}>
                  {selectedModel.name}
                </Text>
                <Text style={styles.modelEffortText}>{EFFORT_CATALOG[effort].short}</Text>
              </Pressable>
            </Animated.View>

            {/* Persistent Right-Bottom Single Blue Voice / Send Orb (Stays anchored with zero jump) */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={hasText ? '发送消息' : '实时语音'}
              style={[styles.blueOrbBtn, hasText && !canSend && { opacity: 0.45 }]}
              onPress={handleActionPress}
            >
              {hasText ? (
                <ArrowUpIcon size={18} color="#FFFFFF" />
              ) : (
                <VoiceWaveIcon size={18} color="#FFFFFF" />
              )}
            </Pressable>
          </GlassSurface>
        </Animated.View>
      </GlassGroup>

      {draft.length >= MAX_MESSAGE_LENGTH && (
        <Text style={styles.limitText}>已达字符上限，请拆分发送</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  outerWrap: {
    width: '100%',
  },
  morphStage: {
    position: 'relative',
    width: '100%',
    justifyContent: 'flex-end',
  },
  leftPlusAbs: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: 48,
    height: 48,
    zIndex: 2,
  },
  plusCircleGlass: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainCardWrap: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  mainCardGlass: {
    flex: 1,
    borderRadius: 24,
  },
  inputLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    justifyContent: 'center',
  },
  textInput: {
    fontSize: 16.5,
    lineHeight: 22,
    color: '#FFFFFF',
    paddingVertical: 0,
  },
  expandedToolsRow: {
    position: 'absolute',
    left: 8,
    right: 48,
    bottom: 6,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
  },
  plainPlusBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelSelectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 8,
    maxWidth: 214,
  },
  modelNameText: {
    fontSize: 14.5,
    fontWeight: '500',
    color: '#F5F5F7',
    letterSpacing: -0.2,
  },
  modelEffortText: {
    fontSize: 13.5,
    fontWeight: '400',
    color: '#8E8E93',
  },
  blueOrbBtn: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#3262FF',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
  },
  limitText: {
    marginTop: 4,
    fontSize: 12,
    color: '#FF453A',
    paddingHorizontal: 8,
  },
});
