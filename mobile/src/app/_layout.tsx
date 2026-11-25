/**
 * 负责：装配纯黑 OLED 主题、GestureHandlerRootView、共享会话和原生页面栈。
 */
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MobileProvider } from '../features/chat/mobile-provider';
import { useAppTheme } from '../theme/use-app-theme';

export default function RootLayout() {
  const { colors } = useAppTheme();

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <MobileProvider>
        <ThemeProvider
          value={{
            ...DarkTheme,
            colors: {
              ...DarkTheme.colors,
              primary: colors.accent,
              background: colors.background,
              card: colors.background,
              text: colors.text,
              border: colors.border,
            },
          }}
        >
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerTintColor: colors.text,
              headerShadowVisible: false,
              headerStyle: { backgroundColor: colors.background },
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="chat/[id]" options={{ headerShown: false }} />
            <Stack.Screen
              name="settings"
              options={{ headerShown: false, presentation: 'modal' }}
            />
            <Stack.Screen
              name="setup"
              options={{ title: '手机预览帮助', presentation: 'modal' }}
            />
          </Stack>
        </ThemeProvider>
      </MobileProvider>
    </GestureHandlerRootView>
  );
}
