/**
 * 负责：在应用内提供手机连接和预览的操作说明。
 * 不负责：修改手机设置或创建开发者账号。
 * 被谁调用：设置页的预览帮助入口。
 */
import { router } from 'expo-router';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../theme/use-app-theme';

const STEPS = [
  ['连接同一网络', 'iPhone 连上与 Windows 电脑相同的家庭 Wi-Fi。电脑也可以使用同一路由器的网线连接。'],
  ['允许本地网络访问', '首次打开时允许 Expo Go 访问本地网络；如果曾拒绝，可到 iPhone 设置中开启 Expo Go 的本地网络权限。'],
  ['保持开发服务运行', '电脑上的开发服务需要保持开启。使用 iPhone 相机扫描电脑提供的二维码，然后选择在 Expo Go 中打开。'],
  ['体验原生界面', '新建对话、输入消息、返回列表，再到设置里切换演示模式。切换手机深色外观，检查界面是否跟随变化。'],
];

export default function SetupScreen() {
  const { colors } = useAppTheme();
  return <ScrollView contentContainerStyle={styles.content}>
    {STEPS.map(([title, description], index) => <View key={title} style={styles.step}>
      <Text style={[styles.number, { color: colors.accent }]}>{String(index + 1).padStart(2, '0')}</Text>
      <View style={styles.copy}><Text style={[styles.title, { color: colors.text }]}>{title}</Text><Text style={[styles.description, { color: colors.muted }]}>{description}</Text></View>
    </View>)}
    <Text style={[styles.note, { color: colors.muted }]}>当前使用 Expo Go 即可预览。暂时不需要购买 Apple 开发者会员，也不需要开启 iPhone 开发者模式。</Text>
    <Button title="完成" color={colors.accent} onPress={() => router.back()} />
  </ScrollView>;
}
const styles = StyleSheet.create({
  content: { padding: 26, gap: 28, paddingBottom: 48 }, step: { flexDirection: 'row', gap: 18 },
  number: { fontSize: 18, fontWeight: '600', paddingTop: 2 }, copy: { flex: 1, gap: 8 },
  title: { fontSize: 18, fontWeight: '600' }, description: { fontSize: 15, lineHeight: 25 },
  note: { fontSize: 14, lineHeight: 24 },
});
