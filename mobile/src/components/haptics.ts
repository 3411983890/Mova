/**
 * 负责：封装 iOS 原生 Taptic Engine 触觉反馈，非 iOS 静默跳过。
 */
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export function hapticLight() {
  if (Platform.OS === 'ios') {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }
}

export function hapticMedium() {
  if (Platform.OS === 'ios') {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }
}

export function hapticSelection() {
  if (Platform.OS === 'ios') {
    void Haptics.selectionAsync().catch(() => {});
  }
}

export function hapticSuccess() {
  if (Platform.OS === 'ios') {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }
}
