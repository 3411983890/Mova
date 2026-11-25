/**
 * 负责：为非 iOS 预览提供平台开关。
 * 不负责：iOS SwiftUI 控件或服务连接。
 * 被谁调用：设置页的 Web 和 Android 构建。
 */
import { Switch, Text, View } from 'react-native';
import { useAppTheme } from '../theme/use-app-theme';

export default function DemoToggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const { colors } = useAppTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 54 }}>
    <Text style={{ color: colors.text, fontSize: 17 }}>使用演示模式</Text>
    <Switch accessibilityLabel="使用演示模式" value={value} onValueChange={onChange} />
  </View>;
}
