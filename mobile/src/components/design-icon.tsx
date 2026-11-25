/**
 * 负责：呈现 Figma 源文件中复用的 Lucide 图标资源。
 * 不负责：用近似字符或 SF Symbol 替换设计稿图标。
 * 被谁调用：顶栏、抽屉、输入栏及回复操作。
 */
import { Image, type ImageSourcePropType } from 'react-native';
import { useAppTheme } from '../theme/use-app-theme';

const ICONS = {
  'panel-left': require('../../assets/icons/panel-left.png'),
  'square-pen': require('../../assets/icons/square-pen.png'),
  ellipsis: require('../../assets/icons/ellipsis.png'),
  plus: require('../../assets/icons/plus.png'),
  mic: require('../../assets/icons/mic.png'),
  'audio-lines': require('../../assets/icons/audio-lines.png'),
  copy: require('../../assets/icons/copy.png'),
  'thumbs-up': require('../../assets/icons/thumbs-up.png'),
  'volume-2': require('../../assets/icons/volume-2.png'),
  share: require('../../assets/icons/share.png'),
  'chevron-down': require('../../assets/icons/chevron-down.png'),
  'chevron-right': require('../../assets/icons/chevron-right.png'),
  search: require('../../assets/icons/search.png'),
  library: require('../../assets/icons/library.png'),
  brain: require('../../assets/icons/brain.png'),
  code: require('../../assets/icons/code.png'),
  bot: require('../../assets/icons/bot.png'),
  sparkles: require('../../assets/icons/sparkles.png'),
  'arrow-up': require('../../assets/icons/arrow-up.png'),
} satisfies Record<string, ImageSourcePropType>;

export type DesignIconName = keyof typeof ICONS;

/** 保持原始资源比例，按设计槽位尺寸与语义颜色呈现。 */
export default function DesignIcon({ name, size = 24, color }: { name: DesignIconName; size?: number; color?: string }) {
  const { colors } = useAppTheme();
  return <Image source={ICONS[name]} accessible={false} resizeMode="contain"
    style={{ width: size, height: size, tintColor: color ?? colors.text }} />;
}
