/**
 * 负责：使用 iOS 26 原生 UIGlassEffect (expo-glass-effect) 呈现真正的系统液态玻璃与交互动效；
 * 在 iOS 26 以下系统自动平滑回退为原生 UIBlurEffect (expo-blur)。
 */
import { BlurView } from 'expo-blur';
import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
  type GlassStyle,
} from 'expo-glass-effect';
import { StyleSheet, View, type ViewProps } from 'react-native';

export type GlassSurfaceProps = ViewProps & {
  tint?: string;
  interactive?: boolean;
  glassStyle?: GlassStyle;
};

export type GlassGroupProps = ViewProps & {
  spacing?: number;
};

const supportsNativeLiquidGlass = () => {
  try {
    return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  } catch {
    return false;
  }
};

/** iOS 26 系统级 Liquid Glass；低版本 iOS 回退为系统深色毛玻璃。 */
export default function GlassSurface({
  tint,
  interactive = false,
  glassStyle = 'regular',
  style,
  children,
  ...props
}: GlassSurfaceProps) {
  if (supportsNativeLiquidGlass()) {
    return (
      <GlassView
        {...props}
        colorScheme="dark"
        glassEffectStyle={glassStyle}
        isInteractive={interactive}
        tintColor={tint}
        style={[styles.glass, style]}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View
      {...props}
      style={[
        styles.fallbackOuter,
        tint ? { backgroundColor: tint, borderColor: 'rgba(255,255,255,0.22)' } : undefined,
        style,
      ]}
    >
      {!tint && (
        <BlurView
          intensity={56}
          tint="systemChromeMaterialDark"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      {children}
    </View>
  );
}

/** iOS 26 GlassContainer：让相邻液态玻璃控件在形变和交互时产生原生融合效果。 */
export function GlassGroup({ spacing = 10, style, children, ...props }: GlassGroupProps) {
  if (supportsNativeLiquidGlass()) {
    return (
      <GlassContainer {...props} spacing={spacing} style={style}>
        {children}
      </GlassContainer>
    );
  }
  return (
    <View {...props} style={style}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  glass: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  fallbackOuter: {
    backgroundColor: 'rgba(28, 28, 32, 0.72)',
    borderRadius: 24,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
