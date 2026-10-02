import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DataProvider } from '../src/db/provider';
import { hashToAddPath } from '../src/features/addPrefill';
import { ItemActionsProvider } from '../src/features/ItemActionsSheet';
import { colors, fonts, isDark } from '../src/theme';
import { PromptProvider } from '../src/ui/PromptProvider';
import { SyncBanner } from '../src/ui/SyncBanner';
import { ToastProvider } from '../src/ui/ToastProvider';

/** Web: la dirección `#/add?name=…&source_ref=…` (la que abren los demás Hoards tras una compra) abre el alta con esos datos. */
function HashEntry() {
  const router = useRouter();
  const ready = useRootNavigationState()?.key;
  useEffect(() => {
    if (Platform.OS !== 'web' || !ready || typeof window === 'undefined') return;
    const open = () => {
      const path = hashToAddPath(window.location.hash);
      if (!path) return;
      window.history.replaceState(null, '', window.location.pathname + window.location.search); // al recargar no se vuelve a abrir
      router.push(path as never);
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, [ready, router]);
  return null;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <DataProvider>
          <ToastProvider>
            <PromptProvider>
              <ItemActionsProvider>
                <StatusBar style={isDark ? 'light' : 'dark'} />
                <SyncBanner />
                <HashEntry />
                <Stack
                  screenOptions={{
                    headerStyle: { backgroundColor: colors.bg },
                    headerTintColor: colors.text,
                    headerTitleStyle: { fontFamily: fonts.serif, fontWeight: '700' },
                    headerShadowVisible: false,
                    contentStyle: { backgroundColor: colors.bg },
                  }}
                >
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen name="add" options={{ presentation: 'modal', title: 'Añadir objeto' }} />
                  <Stack.Screen name="scan" options={{ title: 'Escanear etiqueta' }} />
                  <Stack.Screen name="room/[id]" options={{ title: 'Habitación' }} />
                  <Stack.Screen name="container/[id]" options={{ title: 'Mueble' }} />
                  <Stack.Screen name="item/[id]" options={{ title: 'Objeto' }} />
                </Stack>
              </ItemActionsProvider>
            </PromptProvider>
          </ToastProvider>
        </DataProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
