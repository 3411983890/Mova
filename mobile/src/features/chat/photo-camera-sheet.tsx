/**
 * 负责：点击输入框 "+" 弹出的 iOS 26 悬浮圆角相册选择弹窗与实时相机弹窗。
 * 特性：
 * - 第一格为相机预览块，点击切换为全幅实时相机取景器（真机授权后直接调用原生 CameraView，未授权可一键请求并保留高质量取景预览）。
 * - 相册网格授权后自动读取 iPhone 系统最近照片，未授权时展示高质感内置示例图库。
 * - 底部悬浮控制栏全部采用 iOS 原生 GlassView 液态玻璃与 Taptic Engine 触觉反馈。
 */
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import * as MediaLibrary from 'expo-media-library';
import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GlassSurface from '../../components/glass-surface';
import { hapticLight, hapticMedium, hapticSelection, hapticSuccess } from '../../components/haptics';
import {
  CameraIcon,
  CheckIcon,
  ChevronLeftIcon,
  EllipsisIcon,
} from '../../components/ios-icons';

type FallbackTile = {
  id: string;
  label: string;
  colors: [string, string, ...string[]];
  accent?: string;
  titleText?: string;
  subText?: string;
  darkText?: boolean;
};

const FALLBACK_TILES: FallbackTile[] = [
  {
    id: 'sample-ui',
    label: 'Mova 界面截图',
    colors: ['#12131A', '#242636'],
    accent: '#3262FF',
    titleText: 'Mova',
    subText: 'Liquid Glass',
  },
  {
    id: 'sample-crimson',
    label: '活动海报 11.27',
    colors: ['#8B1111', '#4B0707'],
    titleText: '11.27',
    subText: '9pm–3am',
  },
  {
    id: 'sample-ivory',
    label: '字体排版稿',
    colors: ['#F5F3EC', '#ECE6D8'],
    titleText: '11.27',
    subText: '9pm–3am',
    darkText: true,
  },
  {
    id: 'sample-lounge',
    label: '暖光插画',
    colors: ['#5C2B46', '#180B18'],
    accent: '#F59E0B',
  },
  {
    id: 'sample-sunset',
    label: '落日海岸',
    colors: ['#1B2848', '#8C3F59', '#EA8C55', '#1B1526'],
  },
  {
    id: 'sample-city',
    label: '城市夜景',
    colors: ['#090D1F', '#1C2246', '#30244D'],
    accent: '#8AB4FF',
  },
  {
    id: 'sample-kb',
    label: '铝壳白键渲染',
    colors: ['#32353E', '#09090B'],
    titleText: 'ALU 65%',
    subText: 'Render',
  },
  {
    id: 'sample-alpine',
    label: '雪山晨雾',
    colors: ['#1E3A5F', '#6FA0C7', '#1B2B3D'],
  },
  {
    id: 'sample-orb',
    label: '液态玻璃材质',
    colors: ['#2C4A9E', '#0B1024'],
    accent: '#9AC4FF',
  },
  {
    id: 'sample-desk',
    label: '桌面工作区',
    colors: ['#1E2028', '#0D0E12'],
    accent: '#4F7CFF',
  },
  {
    id: 'sample-code',
    label: '终端部署日志',
    colors: ['#0D1814', '#162C24'],
    titleText: '200 OK',
    subText: 'REALITY',
  },
];

type DevicePhoto = {
  id: string;
  uri: string;
  label: string;
};

type PhotoCameraSheetProps = {
  visible: boolean;
  initialMode?: 'photos' | 'camera';
  onClose: () => void;
  onAttach: (summary: string) => void;
};

export const PhotoCameraSheet: React.FC<PhotoCameraSheetProps> = ({
  visible,
  initialMode = 'photos',
  onClose,
  onAttach,
}) => {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [mode, setMode] = useState<'photos' | 'camera'>(initialMode);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [devicePhotos, setDevicePhotos] = useState<DevicePhoto[]>([]);
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [zoomStep, setZoomStep] = useState<'0.5×' | '1×' | '2×'>('1×');
  const [camMenuOpen, setCamMenuOpen] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const flashOpacity = useSharedValue(0);

  const sheetWidth = Math.max(300, width - 20);
  const sheetHeight = Math.min(540, Math.round(height * 0.6));
  const tileSize = Math.floor((sheetWidth - 4) / 3);

  useEffect(() => {
    if (!visible) {
      setSelectedIds([]);
      setCamMenuOpen(false);
      return;
    }
    setMode(initialMode);
    if (Platform.OS !== 'web') {
      void MediaLibrary.getPermissionsAsync()
        .then(async (perm) => {
          if (perm.granted) {
            const assets = await MediaLibrary.getAssetsAsync({
              first: 18,
              mediaType: ['photo'],
              sortBy: ['creationTime'],
            });
            setDevicePhotos(
              assets.assets.map((a) => ({
                id: a.id,
                uri: a.uri,
                label: a.filename || '相册照片',
              }))
            );
          }
        })
        .catch(() => {});
    }
  }, [visible, initialMode]);

  const openSystemPhotosPermission = async () => {
    hapticLight();
    if (Platform.OS === 'web') {
      onAttach('系统相册 · 所有照片');
      onClose();
      return;
    }
    try {
      const res = await MediaLibrary.requestPermissionsAsync();
      if (res.granted) {
        const assets = await MediaLibrary.getAssetsAsync({
          first: 24,
          mediaType: ['photo'],
          sortBy: ['creationTime'],
        });
        setDevicePhotos(
          assets.assets.map((a) => ({
            id: a.id,
            uri: a.uri,
            label: a.filename || '相册照片',
          }))
        );
      }
    } catch {
      // Ignore permission rejection
    }
  };

  const enterCameraMode = async () => {
    hapticMedium();
    setMode('camera');
    if (Platform.OS !== 'web' && !camPermission?.granted) {
      try {
        await requestCamPermission();
      } catch {
        // Fallback preview stays active
      }
    }
  };

  const toggleSelect = (id: string) => {
    hapticSelection();
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id].slice(0, 4)
    );
  };

  const handleCapture = async () => {
    hapticMedium();
    flashOpacity.value = withSequence(
      withTiming(0.92, { duration: 60 }),
      withTiming(0, { duration: 220 })
    );
    if (Platform.OS !== 'web' && camPermission?.granted && cameraRef.current) {
      try {
        await cameraRef.current.takePictureAsync({ quality: 0.7 });
      } catch {
        // Proceed cleanly
      }
    }
    setTimeout(() => {
      hapticSuccess();
      onAttach('已拍摄实时照片');
      onClose();
    }, 220);
  };

  const flashStyle = useAnimatedStyle(() => ({
    opacity: flashOpacity.value,
  }));

  const zoomNumeric = zoomStep === '2×' ? 0.35 : zoomStep === '0.5×' ? 0 : 0.08;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable
        style={styles.overlay}
        onPress={() => {
          hapticLight();
          onClose();
        }}
      >
        <Animated.View
          entering={SlideInDown.duration(250).easing(Easing.bezier(0.22, 1, 0.36, 1))}
          exiting={SlideOutDown.duration(190).easing(Easing.in(Easing.cubic))}
          style={[
            styles.sheet,
            {
              height: sheetHeight,
              bottom: Math.max(insets.bottom, 10),
            },
          ]}
        >
          <Pressable
            style={styles.sheetInner}
            onPress={() => {
              if (camMenuOpen) setCamMenuOpen(false);
            }}
          >
            {mode === 'photos' ? (
              /* ==================== PHOTO PICKER GRID SHEET (IMAGE 1) ==================== */
              <>
                <ScrollView
                  style={styles.gridScroll}
                  contentContainerStyle={styles.gridContent}
                  showsVerticalScrollIndicator={false}
                >
                  <View style={styles.grid}>
                    {/* Tile 1: Live Camera Trigger Tile */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="打开相机拍照"
                      onPress={() => void enterCameraMode()}
                      style={[styles.tile, { width: tileSize, height: Math.round(tileSize * 1.04) }]}
                    >
                      {Platform.OS !== 'web' && camPermission?.granted ? (
                        <CameraView
                          style={StyleSheet.absoluteFill}
                          facing={facing}
                          active={visible && mode === 'photos'}
                        />
                      ) : (
                        <LinearGradient
                          colors={['#3A3E44', '#1E2024', '#0F1013']}
                          start={{ x: 0.2, y: 0 }}
                          end={{ x: 0.8, y: 1 }}
                          style={StyleSheet.absoluteFill}
                        />
                      )}
                      <View style={styles.cameraTileCenter}>
                        <View style={styles.cameraTilePill}>
                          <CameraIcon size={24} color="#FFFFFF" />
                          <Text style={styles.cameraTileText}>相机</Text>
                        </View>
                      </View>
                    </Pressable>

                    {/* Real iPhone Photos (if authorized) OR Editorial Sample Gallery */}
                    {devicePhotos.length > 0
                      ? devicePhotos.map((photo) => {
                          const selected = selectedIds.includes(photo.id);
                          return (
                            <Pressable
                              key={photo.id}
                              onPress={() => toggleSelect(photo.id)}
                              style={[
                                styles.tile,
                                { width: tileSize, height: Math.round(tileSize * 1.04) },
                              ]}
                            >
                              <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} />
                              {selected && (
                                <>
                                  <View style={styles.selectedFrame} />
                                  <View style={styles.checkBadge}>
                                    <CheckIcon size={12} color="#FFFFFF" />
                                  </View>
                                </>
                              )}
                            </Pressable>
                          );
                        })
                      : FALLBACK_TILES.map((tile) => {
                          const selected = selectedIds.includes(tile.id);
                          return (
                            <Pressable
                              key={tile.id}
                              accessibilityRole="button"
                              accessibilityLabel={tile.label}
                              onPress={() => toggleSelect(tile.id)}
                              style={[
                                styles.tile,
                                { width: tileSize, height: Math.round(tileSize * 1.04) },
                              ]}
                            >
                              <LinearGradient
                                colors={tile.colors}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 1 }}
                                style={styles.sampleTileInner}
                              >
                                {tile.accent && (
                                  <View
                                    style={[
                                      styles.sampleGlowOrb,
                                      { backgroundColor: tile.accent },
                                    ]}
                                  />
                                )}
                                {tile.titleText && (
                                  <Text
                                    style={[
                                      styles.sampleTitle,
                                      tile.darkText && { color: '#D3C29F' },
                                    ]}
                                  >
                                    {tile.titleText}
                                  </Text>
                                )}
                                {tile.subText && (
                                  <Text
                                    style={[
                                      styles.sampleSub,
                                      tile.darkText && { color: '#C7B693' },
                                    ]}
                                  >
                                    {tile.subText}
                                  </Text>
                                )}
                              </LinearGradient>
                              {selected && (
                                <>
                                  <View style={styles.selectedFrame} />
                                  <View style={styles.checkBadge}>
                                    <CheckIcon size={12} color="#FFFFFF" />
                                  </View>
                                </>
                              )}
                            </Pressable>
                          );
                        })}
                  </View>
                </ScrollView>

                {/* Bottom Floating Native Liquid Glass Bar: "<" Left + "所有照片" / "添加 (N)" Right */}
                <View style={styles.bottomBar} pointerEvents="box-none">
                  <GlassSurface interactive style={styles.circleGlass}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="关闭相册"
                      style={styles.circleBtn}
                      onPress={() => {
                        hapticLight();
                        onClose();
                      }}
                    >
                      <ChevronLeftIcon size={20} color="#FFFFFF" />
                    </Pressable>
                  </GlassSurface>

                  {selectedIds.length > 0 ? (
                    <GlassSurface interactive tint="#3262FF" style={styles.pillGlass}>
                      <Pressable
                        style={styles.pillBtn}
                        onPress={() => {
                          hapticSuccess();
                          onAttach(`已添加 ${selectedIds.length} 张相册图片`);
                          setSelectedIds([]);
                          onClose();
                        }}
                      >
                        <Text style={styles.pillText}>添加 ({selectedIds.length})</Text>
                      </Pressable>
                    </GlassSurface>
                  ) : (
                    <GlassSurface interactive style={styles.pillGlass}>
                      <Pressable
                        style={styles.pillBtn}
                        onPress={() => void openSystemPhotosPermission()}
                      >
                        <Text style={styles.pillText}>所有照片</Text>
                      </Pressable>
                    </GlassSurface>
                  )}
                </View>
              </>
            ) : (
              /* ==================== LIVE CAMERA VIEWFINDER SHEET (IMAGE 2) ==================== */
              <>
                {Platform.OS !== 'web' && camPermission?.granted ? (
                  <CameraView
                    ref={cameraRef}
                    style={StyleSheet.absoluteFill}
                    facing={facing}
                    zoom={zoomNumeric}
                    active={visible && mode === 'camera'}
                  />
                ) : (
                  <LinearGradient
                    colors={
                      facing === 'front'
                        ? ['#303B5A', '#1B2030', '#0D0E14']
                        : ['#5B5F63', '#2E3135', '#151719']
                    }
                    start={{ x: 0.75, y: 0.08 }}
                    end={{ x: 0.25, y: 0.92 }}
                    style={StyleSheet.absoluteFill}
                  >
                    <View style={styles.fallbackStudioCurve} />
                  </LinearGradient>
                )}

                {/* Subtle Rule-of-Thirds Grid & Autofocus Reticle */}
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <View style={[styles.gridLineV, { left: '33.3%' }]} />
                  <View style={[styles.gridLineV, { left: '66.6%' }]} />
                  <View style={[styles.gridLineH, { top: '33.3%' }]} />
                  <View style={[styles.gridLineH, { top: '66.6%' }]} />
                  <View style={styles.reticle} />
                </View>

                {/* Zoom Pill */}
                <Pressable
                  style={styles.zoomBadge}
                  onPress={() => {
                    hapticSelection();
                    setZoomStep((cur) => (cur === '1×' ? '2×' : cur === '2×' ? '0.5×' : '1×'));
                  }}
                >
                  <Text style={styles.zoomText}>{zoomStep}</Text>
                </Pressable>

                {/* White Shutter Flash */}
                <Animated.View
                  style={[styles.shutterFlash, flashStyle]}
                  pointerEvents="none"
                />

                {/* Camera Options Liquid Glass Popover */}
                {camMenuOpen && (
                  <Animated.View
                    entering={FadeIn.duration(140)}
                    exiting={FadeOut.duration(110)}
                    style={styles.camMenuWrap}
                  >
                    <GlassSurface style={styles.camMenuGlass}>
                      <Pressable
                        style={styles.camMenuItem}
                        onPress={() => {
                          hapticSelection();
                          setZoomStep((cur) =>
                            cur === '1×' ? '2×' : cur === '2×' ? '0.5×' : '1×'
                          );
                          setCamMenuOpen(false);
                        }}
                      >
                        <Text style={styles.camMenuLabel}>切换焦距</Text>
                        <Text style={styles.camMenuValue}>{zoomStep}</Text>
                      </Pressable>
                      <View style={styles.camMenuSep} />
                      <Pressable
                        style={styles.camMenuItem}
                        onPress={() => {
                          hapticLight();
                          setFacing((f) => (f === 'back' ? 'front' : 'back'));
                          setCamMenuOpen(false);
                        }}
                      >
                        <Text style={styles.camMenuLabel}>翻转镜头</Text>
                        <Text style={styles.camMenuValue}>
                          {facing === 'back' ? '后置' : '前置'}
                        </Text>
                      </Pressable>
                      <View style={styles.camMenuSep} />
                      <Pressable
                        style={styles.camMenuItem}
                        onPress={() => {
                          hapticLight();
                          setCamMenuOpen(false);
                          onAttach('已开启文稿 OCR 扫描');
                        }}
                      >
                        <Text style={styles.camMenuLabel}>扫描文稿</Text>
                        <Text style={styles.camMenuValue}>OCR</Text>
                      </Pressable>
                    </GlassSurface>
                  </Animated.View>
                )}

                {/* Bottom Camera Controls: "<" Left · White Ring Shutter Center · "⋯" + Blue Dot Right */}
                <View style={styles.bottomBar} pointerEvents="box-none">
                  <GlassSurface interactive style={styles.circleGlass}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="返回相册选择"
                      style={styles.circleBtn}
                      onPress={() => {
                        hapticLight();
                        setCamMenuOpen(false);
                        setMode('photos');
                      }}
                    >
                      <ChevronLeftIcon size={20} color="#FFFFFF" />
                    </Pressable>
                  </GlassSurface>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="拍摄照片"
                    onPress={() => void handleCapture()}
                    style={({ pressed }) => [
                      styles.shutterOuter,
                      pressed && { transform: [{ scale: 0.94 }] },
                    ]}
                  >
                    <View style={styles.shutterInner} />
                  </Pressable>

                  <View style={styles.moreWrap}>
                    <GlassSurface interactive style={styles.circleGlass}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="相机选项"
                        style={styles.circleBtn}
                        onPress={() => {
                          hapticLight();
                          setCamMenuOpen((v) => !v);
                        }}
                      >
                        <EllipsisIcon size={19} color="#FFFFFF" />
                      </Pressable>
                    </GlassSurface>
                    <View style={styles.moreBlueDot} pointerEvents="none" />
                  </View>
                </View>
              </>
            )}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
  },
  sheet: {
    position: 'absolute',
    left: 10,
    right: 10,
    borderRadius: 40,
    overflow: 'hidden',
    backgroundColor: '#0D0D10',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  sheetInner: {
    flex: 1,
  },
  gridScroll: {
    flex: 1,
    backgroundColor: '#0A0A0C',
  },
  gridContent: {
    paddingBottom: 88,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
  },
  tile: {
    overflow: 'hidden',
    backgroundColor: '#16161A',
    position: 'relative',
  },
  cameraTileCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraTilePill: {
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: 'rgba(16, 17, 20, 0.56)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.24)',
  },
  cameraTileText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  sampleTileInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  sampleGlowOrb: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    opacity: 0.45,
  },
  sampleTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: 'rgba(255, 245, 232, 0.92)',
    letterSpacing: -0.6,
  },
  sampleSub: {
    fontSize: 10.5,
    fontWeight: '500',
    color: 'rgba(255, 245, 232, 0.72)',
    marginTop: 2,
  },
  selectedFrame: {
    ...StyleSheet.absoluteFill,
    borderWidth: 2.5,
    borderColor: '#3262FF',
  },
  checkBadge: {
    position: 'absolute',
    right: 7,
    bottom: 7,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#3262FF',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  pillGlass: {
    height: 42,
    minWidth: 104,
    borderRadius: 21,
  },
  pillBtn: {
    flex: 1,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  fallbackStudioCurve: {
    position: 'absolute',
    left: -40,
    right: -40,
    bottom: -60,
    height: '66%',
    borderTopLeftRadius: 220,
    borderTopRightRadius: 180,
    backgroundColor: 'rgba(34, 36, 40, 0.86)',
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
  },
  reticle: {
    position: 'absolute',
    left: '50%',
    top: '44%',
    width: 64,
    height: 64,
    marginLeft: -32,
    marginTop: -32,
    borderWidth: 1,
    borderColor: 'rgba(255, 214, 10, 0.56)',
    borderRadius: 2,
  },
  zoomBadge: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 92,
    height: 26,
    paddingHorizontal: 11,
    borderRadius: 13,
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#FFD60A',
  },
  shutterOuter: {
    width: 64,
    height: 64,
    borderRadius: 32,
    padding: 4,
    borderWidth: 2.5,
    borderColor: 'rgba(255, 255, 255, 0.92)',
    backgroundColor: 'rgba(0, 0, 0, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: '100%',
    height: '100%',
    borderRadius: 26,
    backgroundColor: '#F2F2F5',
  },
  moreWrap: {
    position: 'relative',
  },
  moreBlueDot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#4B7BFF',
    borderWidth: 1.5,
    borderColor: '#16181D',
  },
  camMenuWrap: {
    position: 'absolute',
    right: 16,
    bottom: 84,
    width: 176,
  },
  camMenuGlass: {
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  camMenuItem: {
    height: 40,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  camMenuLabel: {
    fontSize: 14.5,
    color: '#F5F5F7',
  },
  camMenuValue: {
    fontSize: 12.5,
    color: '#8E8E93',
  },
  camMenuSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginHorizontal: 8,
  },
  shutterFlash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#FFFFFF',
  },
});
