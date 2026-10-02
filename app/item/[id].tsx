import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useData } from '../../src/db/provider';
import { ItemCardSection } from '../../src/features/ItemCardSection';
import { ItemForm, type ItemFormValues } from '../../src/features/ItemForm';
import { MaintenanceBlock } from '../../src/features/MaintenanceBlock';
import { PapersSection } from '../../src/features/PapersSection';
import { printLabel } from '../../src/features/qrLabels';
import { colors, space } from '../../src/theme';
import { Button, EmptyState } from '../../src/ui/components';
import { useToast } from '../../src/ui/ToastProvider';

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useData();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['item', id],
    queryFn: async () => {
      const item = await data.getItem(id);
      if (!item) return { item: null as null };
      const path = await data.getItemPath(id);
      const tags = await data.getItemTags(id);
      const crumbs = path.filter((s) => s.kind === 'room' || s.kind === 'container');
      const label = crumbs.map((s) => s.name).join(' › ');
      return { item, tags, label, crumbs };
    },
  });

  const invalidate = () => qc.invalidateQueries();

  async function toggleFavorite() {
    const item = q.data?.item;
    if (!item) return;
    await data.setItemFavorite(id, item.favorite !== 1);
    invalidate();
  }

  async function remove() {
    const item = q.data?.item;
    if (!item) return;
    const name = item.name;
    await data.deleteItem(id);
    invalidate();
    router.back();
    toast(`"${name}" eliminado`, {
      actionLabel: 'Deshacer',
      onAction: async () => {
        await data.restoreItem(id);
        invalidate();
      },
    });
  }

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const item = q.data?.item;
  if (!item) {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert-circle-outline" title="Objeto no encontrado" />
      </View>
    );
  }

  const tags = q.data!.tags ?? [];
  const label = q.data!.label ?? '';
  const crumbs = q.data!.crumbs ?? [];

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ padding: space(5), paddingBottom: space(20) }} keyboardShouldPersistTaps="handled">
      <Stack.Screen
        options={{
          title: item.name,
          headerLeft: () => <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} hitSlop={10} accessibilityLabel="Volver" style={{ marginRight: space(3) }}><Ionicons name="arrow-back" size={22} color={colors.text} /></Pressable>,
          headerRight: () => (
            <Pressable onPress={toggleFavorite} hitSlop={10} accessibilityLabel="Favorito">
              <Ionicons
                name={item.favorite === 1 ? 'star' : 'star-outline'}
                size={22}
                color={item.favorite === 1 ? colors.warn : colors.text}
              />
            </Pressable>
          ),
        }}
      />

      {/* Ruta clicable: toca para saltar a la habitación o al mueble */}
      <View style={styles.crumbs}>
        {crumbs.map((s, i) => (
          <View key={s.id} style={styles.crumbItem}>
            {i > 0 ? <Text style={styles.crumbSep}>›</Text> : null}
            <Pressable onPress={() => router.push(s.kind === 'room' ? `/room/${s.id}` : `/container/${s.id}`)}>
              <Text style={styles.crumbLink}>{s.name}</Text>
            </Pressable>
          </View>
        ))}
      </View>

      <ItemForm
        initial={{
          name: item.name,
          description: item.description,
          quantity: item.quantity,
          photoUri: item.photo_uri,
          favorite: item.favorite === 1,
          tagIds: tags.map((t) => t.id),
          location: { roomId: item.room_id, containerId: item.container_id, label },
        }}
        submitLabel="Guardar cambios"
        onSubmit={async (v: ItemFormValues) => {
          await data.updateItem(id, {
            name: v.name,
            description: v.description,
            quantity: v.quantity,
            room_id: v.roomId,
            container_id: v.containerId,
            photo_uri: v.photoUri,
            favorite: v.favorite,
            tagIds: v.tagIds,
          });
          invalidate();
          router.back();
          toast('Cambios guardados ✓');
        }}
      />

      <View style={{ marginTop: space(6), gap: space(4) }}>
        <ItemCardSection itemId={id} />
        <PapersSection itemId={id} itemName={item.name} />
        <MaintenanceBlock target={{ kind: 'item', id, name: item.name }} />
      </View>

      <View style={{ marginTop: space(5) }}>
        <Button label="Imprimir etiqueta QR" variant="ghost" onPress={() => {
          void printLabel('item', id, item.name, label).catch((error) =>
            toast(error instanceof Error ? error.message : 'No se pudo imprimir la etiqueta.')
          );
        }} />
      </View>

      <View style={{ marginTop: space(8) }}>
        <Button label="Eliminar objeto" variant="danger" onPress={remove} />
        <Text style={styles.hint}>Podrás deshacerlo justo después de eliminar.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  crumbs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5), marginBottom: space(4) },
  crumbItem: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  crumbLink: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  crumbSep: { color: colors.textDim, fontSize: 13 },
  hint: { color: colors.textDim, fontSize: 12, textAlign: 'center', marginTop: space(2) },
});
