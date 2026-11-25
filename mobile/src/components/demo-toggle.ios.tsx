/**
 * 负责：在 iPhone 设置中呈现真实 SwiftUI Toggle。
 * 不负责：更改服务连接或控制模型权限。
 * 被谁调用：设置页；其他平台使用 demo-toggle.tsx。
 */
import { Host, Toggle } from '@expo/ui/swift-ui';
import { tint } from '@expo/ui/swift-ui/modifiers';
import { useAppTheme } from '../theme/use-app-theme';

export default function DemoToggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const { colors, dark } = useAppTheme();
  return <Host colorScheme={dark ? 'dark' : 'light'} style={{ width: '100%', height: 54 }}>
    <Toggle label="使用演示模式" isOn={value} onIsOnChange={onChange} modifiers={[tint(colors.accent)]} />
  </Host>;
}
