/**
 * 负责：点击输入框模型名称后放大至屏幕中心的模型与思考强度浮层。
 * 视觉规范：全宽磨砂条（上下渐变透明）+ 顶部居中放大模型名（无“模型/思考强度”文案）+ 中间桌面端星云滑块 + 点击模型名弹出分组 Liquid Glass 选单。
 */
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import GlassSurface from '../../components/glass-surface';
import { hapticLight, hapticSelection } from '../../components/haptics';
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon } from '../../components/ios-icons';
import {
  EFFORT_CATALOG,
  MOVA_MODELS,
  type EffortLevelId,
  type ModelProviderGroup,
  type MovaModelOption,
} from '../design/mova-design-data';

const PROVIDER_ORDER: ModelProviderGroup[] = ['ChatGPT', 'Gemini', 'DeepSeek'];

const STAR_POINTS = [
  { left: '12%', top: '28%', size: 2.2 },
  { left: '24%', top: '66%', size: 1.8 },
  { left: '38%', top: '24%', size: 2.4 },
  { left: '51%', top: '70%', size: 1.9 },
  { left: '63%', top: '34%', size: 2.2 },
  { left: '76%', top: '62%', size: 2.5 },
  { left: '86%', top: '30%', size: 1.8 },
];

type EffortModelModalProps = {
  visible: boolean;
  selectedModel: MovaModelOption;
  effort: EffortLevelId;
  onSelectModel: (model: MovaModelOption) => void;
  onChangeEffort: (effort: EffortLevelId) => void;
  onClose: () => void;
};

export const EffortModelModal: React.FC<EffortModelModalProps> = ({
  visible,
  selectedModel,
  effort,
  onSelectModel,
  onChangeEffort,
  onClose,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [trackWidth, setTrackWidth] = useState(310);
  const trackWidthSv = useSharedValue(310);

  const stops = useMemo(
    () => selectedModel.efforts.map((id) => EFFORT_CATALOG[id]),
    [selectedModel.efforts]
  );

  const activeIdx = Math.max(
    0,
    stops.findIndex((s) => s.value === effort)
  );
  const maxIdx = Math.max(1, stops.length - 1);
  const ratio = activeIdx / maxIdx;

  const thumbProgress = useSharedValue(ratio);
  const thumbScaleX = useSharedValue(1);
  const thumbScaleY = useSharedValue(1);
  const shimmer = useSharedValue(0);

  useEffect(() => {
    if (!visible) {
      setPickerOpen(false);
    }
  }, [visible]);

  useEffect(() => {
    thumbProgress.value = withTiming(ratio, {
      duration: 170,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    });
  }, [ratio, thumbProgress]);

  useEffect(() => {
    shimmer.value = withRepeat(withTiming(1, { duration: 2800 }), -1, true);
  }, [shimmer]);

  const selectIndex = (nextIdx: number) => {
    const clamped = Math.max(0, Math.min(stops.length - 1, nextIdx));
    const target = stops[clamped];
    if (target && target.value !== effort) {
      hapticSelection();
      onChangeEffort(target.value);
    }
  };

  const trackWidthRef = useRef(trackWidth);
  trackWidthRef.current = trackWidth;
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const effortRef = useRef(effort);
  effortRef.current = effort;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          thumbScaleX.value = withTiming(1.06, { duration: 110, easing: Easing.out(Easing.cubic) });
          thumbScaleY.value = withTiming(0.96, { duration: 110, easing: Easing.out(Easing.cubic) });
          const x = evt.nativeEvent.locationX;
          const usable = Math.max(1, trackWidthRef.current - 34);
          const pct = Math.max(0, Math.min(1, (x - 17) / usable));
          const idx = Math.round(pct * Math.max(1, stopsRef.current.length - 1));
          const target = stopsRef.current[idx];
          if (target && target.value !== effortRef.current) {
            hapticSelection();
            onChangeEffort(target.value);
          }
        },
        onPanResponderMove: (evt) => {
          const x = evt.nativeEvent.locationX;
          const usable = Math.max(1, trackWidthRef.current - 34);
          const pct = Math.max(0, Math.min(1, (x - 17) / usable));
          thumbProgress.value = pct;
          const idx = Math.round(pct * Math.max(1, stopsRef.current.length - 1));
          const target = stopsRef.current[idx];
          if (target && target.value !== effortRef.current) {
            hapticSelection();
            onChangeEffort(target.value);
          }
        },
        onPanResponderRelease: () => {
          thumbScaleX.value = withTiming(1, { duration: 140, easing: Easing.out(Easing.cubic) });
          thumbScaleY.value = withTiming(1, { duration: 140, easing: Easing.out(Easing.cubic) });
          const curIdx = Math.max(
            0,
            stopsRef.current.findIndex((s) => s.value === effortRef.current)
          );
          const snapRatio = curIdx / Math.max(1, stopsRef.current.length - 1);
          thumbProgress.value = withTiming(snapRatio, {
            duration: 160,
            easing: Easing.bezier(0.22, 1, 0.36, 1),
          });
        },
        onPanResponderTerminate: () => {
          thumbScaleX.value = withTiming(1, { duration: 120 });
          thumbScaleY.value = withTiming(1, { duration: 120 });
        },
      }),
    [onChangeEffort, thumbProgress, thumbScaleX, thumbScaleY]
  );

  const thumbAnimatedStyle = useAnimatedStyle(() => {
    const usable = Math.max(0, trackWidthSv.value - 36);
    return {
      transform: [
        { translateX: thumbProgress.value * usable },
        { scaleX: thumbScaleX.value },
        { scaleY: thumbScaleY.value },
      ],
    };
  });

  const fillAnimatedStyle = useAnimatedStyle(() => {
    const usable = Math.max(0, trackWidthSv.value - 36);
    return {
      width: 34 + thumbProgress.value * usable,
    };
  });

  const starOpacityStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + shimmer.value * 0.45,
  }));

  const groupedModels = useMemo(
    () =>
      PROVIDER_ORDER.map((provider) => ({
        provider,
        items: MOVA_MODELS.filter((m) => m.provider === provider),
      })),
    []
  );

  const handleTrackLayout = (e: LayoutChangeEvent) => {
    if (e.nativeEvent.layout.width > 0) {
      setTrackWidth(e.nativeEvent.layout.width);
      trackWidthSv.value = e.nativeEvent.layout.width;
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          hapticLight();
          if (pickerOpen) {
            setPickerOpen(false);
          } else {
            onClose();
          }
        }}
      >
        {/* Full-Width Frosted Horizontal Band fading softly to transparent at top & bottom */}
        <Animated.View
          entering={FadeIn.duration(220)}
          exiting={FadeOut.duration(160)}
          style={styles.frostedBandWrap}
        >
          <Pressable style={styles.frostedBandInner} onPress={() => {}}>
            <BlurView intensity={52} tint="dark" style={StyleSheet.absoluteFill} />
            {/* Smooth vertical vignette so top & bottom edges dissolve transparently */}
            <LinearGradient
              colors={[
                'rgba(0,0,0,0.85)',
                'rgba(18,19,26,0.42)',
                'rgba(20,21,30,0.48)',
                'rgba(18,19,26,0.42)',
                'rgba(0,0,0,0.85)',
              ]}
              locations={[0, 0.2, 0.5, 0.8, 1]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />

            <View style={styles.centerStage}>
              {/* Top: Centered Enlarged Model Name ONLY (No "模型" or "思考强度" text) */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`当前模型 ${selectedModel.name}，点击切换模型`}
                style={styles.modelTrigger}
                onPress={() => {
                  hapticLight();
                  setPickerOpen(true);
                }}
              >
                <Text style={styles.modelHeroName}>{selectedModel.name}</Text>
                <ChevronDownIcon size={20} color="rgba(235, 235, 245, 0.72)" />
              </Pressable>

              {/* Middle: Mova Desktop Cosmic Wave / Starfield Effort Slider */}
              <View style={styles.sliderSection}>
                <View
                  style={styles.track}
                  onLayout={handleTrackLayout}
                  {...panResponder.panHandlers}
                >
                  {/* Animated Cosmic Fill */}
                  <Animated.View style={[styles.cosmicFill, fillAnimatedStyle]}>
                    <LinearGradient
                      colors={['#1E2440', '#485AC8', '#7C82F8', '#989BFF']}
                      start={{ x: 0, y: 0.5 }}
                      end={{ x: 1, y: 0.5 }}
                      style={StyleSheet.absoluteFill}
                    />
                    <Animated.View
                      style={[StyleSheet.absoluteFill, starOpacityStyle]}
                      pointerEvents="none"
                    >
                      {STAR_POINTS.map((st, idx) => (
                        <View
                          key={idx}
                          style={[
                            styles.starDot,
                            {
                              left: st.left as `${number}%`,
                              top: st.top as `${number}%`,
                              width: st.size,
                              height: st.size,
                              borderRadius: st.size / 2,
                            },
                          ]}
                        />
                      ))}
                    </Animated.View>
                  </Animated.View>

                  {/* Track Stop Dots */}
                  <View style={styles.dotsRow} pointerEvents="none">
                    {stops.map((st) => (
                      <View key={st.value} style={styles.stopDot} />
                    ))}
                  </View>

                  {/* Spring Jelly Thumb */}
                  <Animated.View style={[styles.thumb, thumbAnimatedStyle]} pointerEvents="none" />
                </View>

                {/* Stop Labels */}
                <View style={styles.stopsLabelsRow}>
                  {stops.map((st, idx) => {
                    const active = st.value === effort;
                    return (
                      <Pressable
                        key={st.value}
                        style={styles.stopLabelBtn}
                        onPress={() => selectIndex(idx)}
                      >
                        <Text style={[styles.stopLabelText, active && styles.stopLabelActive]}>
                          {st.short}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </View>
          </Pressable>
        </Animated.View>

        {/* Grouped Native Liquid Glass Model Picker Popup */}
        {pickerOpen && (
          <Animated.View
            entering={FadeIn.duration(170).easing(Easing.out(Easing.cubic))}
            exiting={FadeOut.duration(130)}
            style={styles.popupWrap}
          >
            <Pressable onPress={() => {}}>
              <GlassSurface style={styles.popupGlass} glassStyle="regular">
                <Pressable
                  style={styles.popupBack}
                  onPress={() => {
                    hapticLight();
                    setPickerOpen(false);
                  }}
                >
                  <ChevronLeftIcon size={17} color="#A6A6AE" />
                  <Text style={styles.popupBackText}>选择模型</Text>
                </Pressable>

                <ScrollView
                  style={styles.popupScroll}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.popupScrollContent}
                >
                  {groupedModels.map((group, gIdx) => (
                    <View key={group.provider} style={styles.popupGroup}>
                      <Text style={[styles.popupGroupTitle, gIdx === 0 && { marginTop: 4 }]}>
                        {group.provider}
                      </Text>
                      {group.items.map((model) => {
                        const selected = model.id === selectedModel.id;
                        return (
                          <Pressable
                            key={model.id}
                            style={({ pressed }) => [
                              styles.popupItem,
                              pressed && styles.popupItemPressed,
                            ]}
                            onPress={() => {
                              hapticSelection();
                              onSelectModel(model);
                              if (!model.efforts.includes(effort)) {
                                onChangeEffort(model.defaultEffort);
                              }
                              setPickerOpen(false);
                            }}
                          >
                            <Text
                              style={[
                                styles.popupItemText,
                                selected && styles.popupItemTextSelected,
                              ]}
                            >
                              {model.name}
                            </Text>
                            {selected && <CheckIcon size={16} color="#FFFFFF" />}
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                </ScrollView>
              </GlassSurface>
            </Pressable>
          </Animated.View>
        )}
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.36)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  frostedBandWrap: {
    width: '100%',
    height: 310,
    justifyContent: 'center',
  },
  frostedBandInner: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  centerStage: {
    width: '100%',
    paddingHorizontal: 32,
    alignItems: 'center',
    gap: 24,
  },
  modelTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 18,
  },
  modelHeroName: {
    fontSize: 27,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: -0.6,
  },
  sliderSection: {
    width: '100%',
    maxWidth: 336,
  },
  track: {
    width: '100%',
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.11)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  cosmicFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 18,
    overflow: 'hidden',
  },
  starDot: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
  },
  dotsRow: {
    position: 'absolute',
    left: 17,
    right: 17,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stopDot: {
    width: 4.5,
    height: 4.5,
    borderRadius: 2.25,
    backgroundColor: 'rgba(255, 255, 255, 0.36)',
  },
  thumb: {
    position: 'absolute',
    left: 3,
    top: 3,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#FAFAFA',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.34,
    shadowRadius: 5,
  },
  stopsLabelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingHorizontal: 4,
  },
  stopLabelBtn: {
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  stopLabelText: {
    fontSize: 13.5,
    color: '#A6A6AE',
    fontWeight: '400',
  },
  stopLabelActive: {
    color: '#9BA8FF',
    fontWeight: '600',
  },
  popupWrap: {
    position: 'absolute',
    width: 288,
    maxHeight: 418,
  },
  popupGlass: {
    borderRadius: 24,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 12,
    maxHeight: 418,
  },
  popupBack: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  popupBackText: {
    fontSize: 14.5,
    fontWeight: '500',
    color: '#A6A6AE',
  },
  popupScroll: {
    maxHeight: 356,
  },
  popupScrollContent: {
    paddingBottom: 6,
  },
  popupGroup: {
    marginBottom: 4,
  },
  popupGroupTitle: {
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    letterSpacing: 0.4,
  },
  popupItem: {
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  popupItemPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  popupItemText: {
    fontSize: 15.5,
    color: '#B4B4BC',
  },
  popupItemTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
