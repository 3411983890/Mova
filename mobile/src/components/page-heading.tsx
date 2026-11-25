/**
 * 负责：呈现手机页面的标题、说明和可选操作。
 * 不负责：导航或共享业务状态。
 * 被谁调用：聊天列表和设置页面。
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../theme/use-app-theme';

export default function PageHeading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  const { colors } = useAppTheme();
  return <View style={styles.heading}>
    <View style={styles.row}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
      {action}
    </View>
    <Text style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text>
  </View>;
}
const styles = StyleSheet.create({
  heading: { paddingHorizontal: 24, paddingTop: 22, paddingBottom: 22, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 34, fontWeight: '700', letterSpacing: -1 },
  subtitle: { fontSize: 15, lineHeight: 23 },
});
