import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, space } from '../theme';
import { data } from './index';
import type { DataSource } from './types';

const DataContext = createContext<DataSource | null>(null);

/** Acceso a la fuente de datos activa (SQLite en nativo, memoria en web). */
export const useData = (): DataSource => {
  const d = useContext(DataContext);
  if (!d) throw new Error('useData() debe usarse dentro de <DataProvider>');
  return d;
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 1000 } },
});

type State = 'loading' | 'ready' | 'error';

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await data.ready();
        if (alive) setState('ready');
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setState('error');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state !== 'ready') {
    return (
      <View style={styles.center}>
        {state === 'loading' ? (
          <>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.dim}>Preparando tu inventario…</Text>
          </>
        ) : (
          <>
            <Text style={styles.errTitle}>No se pudo abrir la base de datos</Text>
            <Text style={styles.dim}>{error}</Text>
          </>
        )}
      </View>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <DataContext.Provider value={data}>{children}</DataContext.Provider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, gap: space(3), padding: space(6) },
  dim: { color: colors.textDim, textAlign: 'center' },
  errTitle: { color: colors.danger, fontSize: 16, fontWeight: '700' },
});
