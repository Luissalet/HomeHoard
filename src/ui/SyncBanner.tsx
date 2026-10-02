// Franja que avisa cuando la web ha perdido la conexión con el ordenador: se sigue trabajando con la copia local.
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { getServerSync } from '../db/serverSync';
import { useSyncStatus } from '../db/useSync';
import { colors, space } from '../theme';

export function SyncBanner() {
  const status = useSyncStatus();
  if (status.mode !== 'offline') return null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Reintentar conexión con el ordenador" style={styles.banner}
      onPress={() => { void getServerSync()?.pull(true); }}>
      <Ionicons name="cloud-offline-outline" size={16} color={colors.text} />
      <Text style={styles.text}>
        Sin conexión con el ordenador. Los cambios se guardan en este navegador{status.pending ? ` (${status.pending} pendientes)` : ''} y se enviarán al volver. Toca para reintentar.
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(4), paddingVertical: space(2), backgroundColor: '#E9DFCB' },
  text: { color: colors.text, fontSize: 13, flex: 1 },
});
