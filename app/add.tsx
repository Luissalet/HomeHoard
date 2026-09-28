import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useData } from '../src/db/provider';
import type { LocationValue } from '../src/features/LocationPicker';
import { ItemForm, type ItemFormValues } from '../src/features/ItemForm';
import { colors, space } from '../src/theme';
import { useToast } from '../src/ui/ToastProvider';

export default function AddItemScreen() {
  const data = useData();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ roomId?: string; containerId?: string }>();

  // Ubicación precargada por contexto (si venimos de una habitación o mueble).
  const initQ = useQuery({
    queryKey: ['addInit', params.roomId, params.containerId],
    queryFn: async (): Promise<LocationValue | null> => {
      if (!params.roomId) return null;
      const room = await data.getRoom(params.roomId);
      if (!room) return null;
      let label = room.name;
      const containerId = params.containerId ?? null;
      if (containerId) {
        const chain: string[] = [];
        let id: string | null = containerId;
        const seen = new Set<string>();
        while (id && !seen.has(id)) {
          seen.add(id);
          const container = await data.getContainer(id);
          if (!container) break;
          chain.unshift(container.name);
          id = container.parent_container_id;
        }
        if (chain.length) label += ` › ${chain.join(' › ')}`;
      }
      return { roomId: params.roomId, containerId, label };
    },
  });

  const add = async (v: ItemFormValues) => {
    await data.addItem({
      name: v.name,
      description: v.description,
      quantity: v.quantity,
      room_id: v.roomId,
      container_id: v.containerId,
      photo_uri: v.photoUri,
      favorite: v.favorite,
      tagIds: v.tagIds,
    });
    qc.invalidateQueries();
  };

  if (params.roomId && initQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ padding: space(5), paddingBottom: space(20) }} keyboardShouldPersistTaps="handled">
      <ItemForm
        initial={{ location: initQ.data ?? undefined }}
        submitLabel="Guardar objeto"
        checkDuplicates
        onSubmit={async (v) => {
          await add(v);
          router.back();
          toast(`"${v.name}" guardado ✓`);
        }}
        onSubmitAndAnother={async (v) => {
          await add(v);
          toast(`"${v.name}" guardado ✓ · siguiente`);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
});
