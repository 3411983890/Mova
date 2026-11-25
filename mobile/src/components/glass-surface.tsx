/**
 * 负责：非 iOS 平台的液态玻璃表面回退实现（iOS 自动加载 glass-surface.ios.tsx）。
 */
import { StyleSheet, View, type ViewProps } from 'react-native';

export type GlassSurfaceProps = ViewProps & {
  tint?: string;
  interactive?: boolean;
  glassStyle?: 'regular' | 'clear';
};

export type GlassGroupProps = ViewProps & {
  spacing?: number;
};

export default function GlassSurface({
  tint,
  interactive: _interactive,
  glassStyle: _glassStyle,
  style,
  ...props
}: GlassSurfaceProps) {
  return (
    <View
      {...props}
      style={[
        styles.surface,
        tint ? { backgroundColor: tint, borderColor: 'rgba(255,255,255,0.24)' } : undefined,
        style,
      ]}
    />
  );
}

export function GlassGroup({ spacing: _spacing, style, children, ...props }: GlassGroupProps) {
  return (
    <View {...props} style={style}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    backgroundColor: 'rgba(32, 32, 36, 0.86)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    overflow: 'hidden',
  },
});
