/**
 * 负责：提供有无障碍标签的图标触摸目标。
 * 不负责：图标资源映射或业务操作。
 * 被谁调用：聊天工作区的顶栏、输入栏和回复操作。
 */
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import DesignIcon, { type DesignIconName } from './design-icon';

type Props = {
  icon: DesignIconName; label: string; onPress: () => void; size?: number; iconSize?: number;
  color?: string; disabled?: boolean; selected?: boolean; style?: StyleProp<ViewStyle>;
};

/** 默认 44 点触摸范围；小型回复按钮仍提供额外命中区域。 */
export default function IconButton({ icon, label, onPress, size = 44, iconSize = 24, color, disabled, selected, style }: Props) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    hitSlop={size < 44 ? 4 : 0} style={({ pressed }) => [{ width: size, height: size,
      alignItems: 'center', justifyContent: 'center', borderRadius: size / 2,
      backgroundColor: pressed ? 'rgba(255,255,255,0.08)' : 'transparent' }, style]}>
    <DesignIcon name={icon} size={iconSize} color={color} />
  </Pressable>;
}
