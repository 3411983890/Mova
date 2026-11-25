/**
 * 负责：提供纯黑 OLED 画布与 iOS 26 深色语义色彩。
 * 不负责：桌面 CSS、状态存储或导航。
 */
const COLORS = {
  background: '#000000',
  surface: '#171719',
  surfaceElevated: '#1C1C1F',
  text: '#F5F5F7',
  muted: '#8E8E93',
  subtle: '#636366',
  border: 'rgba(255, 255, 255, 0.09)',
  accent: '#3262FF',
  accentSoft: 'rgba(50, 98, 255, 0.18)',
  userBubble: '#2B2C32',
  botBubble: '#1A1A1E',
  danger: '#FF453A',
  green: '#30D158',
  amber: '#E5A024',
  avatar: '#7356CF',
};

export function useAppTheme() {
  return { colors: COLORS, dark: true };
}
