/**
 * 负责：将同一组操作映射为 iOS 原生操作表或其他平台对话框。
 * 不负责：执行菜单背后的业务逻辑。
 * 被谁调用：聊天顶栏、输入栏和回复操作菜单。
 */
import { ActionSheetIOS, Alert, Platform } from 'react-native';

type MenuAction = { title: string; run: () => void; destructive?: boolean };

/** 在点击时展示系统菜单，不将取消当作操作执行。 */
export function showActionMenu(title: string, actions: MenuAction[]) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...actions.map(item => item.title), '取消'],
      cancelButtonIndex: actions.length, destructiveButtonIndex: actions.some(item => item.destructive) ? actions.findIndex(item => item.destructive) : undefined,
      userInterfaceStyle: 'dark' }, index => actions[index]?.run());
    return;
  }
  Alert.alert(title, undefined, [...actions.map(item => ({ text: item.title, onPress: item.run,
    style: item.destructive ? 'destructive' as const : 'default' as const })), { text: '取消', style: 'cancel' }]);
}
