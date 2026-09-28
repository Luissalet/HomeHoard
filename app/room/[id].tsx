import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useData } from '../../src/db/provider';
import { ContainerSheet, RoomSheet } from '../../src/features/CreateSheets';
import { useItemActions } from '../../src/features/ItemActionsSheet';
import { colors, space } from '../../src/theme';
import { Button, EmptyState, NavRow, SectionTitle } from '../../src/ui/components';
import { ItemRow } from '../../src/ui/ItemRow';
import { containerLineIcon, containerKindLabel, roomKindLabel } from '../../src/ui/kinds';
import { useToast } from '../../src/ui/ToastProvider';

export default function RoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useData();
  const router = useRouter();
  const toast = useToast();
  const actions = useItemActions();
  const qc = useQueryClient();
  const [furnitureSheet, setFurnitureSheet] = useState(false);
  const [editSheet, setEditSheet] = useState(false);

  const q = useQuery({
    queryKey: ['room', id],
    queryFn: async () => {
      const room = await data.getRoom(id);
      const containers = await data.listRootContainers(id);
      const counts = await Promise.all(containers.map((c) => data.listItemsInContainerDeep(c.id).then((a) => a.length)));
      const loose = await data.listLooseItemsInRoom(id);
      const total = await data.countItemsInRoom(id);
      return { room, containers: containers.map((c, i) => ({ c, count: counts[i] })), loose, total };
    },
  });

  const refresh = () => qc.invalidateQueries();

  async function createFurniture(draft: { name: string; kind: string | null }) {
    const room = q.data?.room;
    if (!room) return;
    const idx = q.data!.containers.length;
    const cols = Math.max(1, Math.floor(room.width_cm / 120));
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    await data.addContainer(id, draft.name, {
      kind: draft.kind ?? 'box',
      rect: { x_cm: col * 120 + 10, y_cm: row * 90 + 90, width_cm: 100, height_cm: 70 },
    });
    refresh();
    toast(`"${draft.name}" añadido · colócalo desde el mapa con ✏️`);
  }

  async function saveRoomMeta(draft: { name: string; kind: string | null; color: string }) {
    await data.updateRoomMeta(id, { name: draft.name, kind: draft.kind, color: draft.color });
    refresh();
  }

  async function removeRoom() {
    const room = q.data?.room;
    if (!room) return;
    const ok = await data.deleteRoom(id);
    if (!ok) {
      toast('No se puede borrar: la habitación tiene muebles u objetos');
      return;
    }
    refresh();
    router.back();
    toast(`Habitación "${room.name}" eliminada`);
  }

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const room = q.data?.room;
  if (!room) {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert-circle-outline" title="Habitación no encontrada" />
      </View>
    );
  }

  const containers = q.data!.containers;
  const loose = q.data!.loose;
  const total = q.data!.total;
  const empty = containers.length === 0 && loose.length === 0;

  return (
    <View style={styles.wrap}>
      <Stack.Screen
        options={{
          title: room.name,
          headerLeft: () => <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} hitSlop={10} accessibilityLabel="Volver a inicio" style={{ marginRight: space(3) }}><Ionicons name="arrow-back" size={22} color={colors.text} /></Pressable>,
          headerRight: () => (
            <Pressable onPress={() => setEditSheet(true)} hitSlop={10}>
              <Ionicons name="create-outline" size={22} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.meta}>
          {roomKindLabel(room.kind)} · {total === 1 ? '1 objeto' : `${total} objetos`} en total
        </Text>

        <View style={styles.actions}>
          <View style={{ flex: 1 }}>
            <Button label="＋ Mueble" variant="ghost" onPress={() => setFurnitureSheet(true)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="＋ Objeto" onPress={() => router.push({ pathname: '/add', params: { roomId: id } })} />
          </View>
        </View>

        <SectionTitle>Muebles</SectionTitle>
        {containers.length ? (
          containers.map(({ c, count }) => (
            <NavRow
              key={c.id}
              icon={containerLineIcon(c.kind)}
              title={c.name}
              subtitle={`${c.name === containerKindLabel(c.kind) ? '' : `${containerKindLabel(c.kind)} · `}${count === 1 ? '1 objeto' : `${count} objetos`}`}
              onPress={() => router.push(`/container/${c.id}`)}
            />
          ))
        ) : (
          <Text style={styles.dim}>Aún no hay muebles en esta habitación.</Text>
        )}

        <View style={{ height: space(2) }} />
        <SectionTitle>Objetos sueltos</SectionTitle>
        {loose.length ? (
          loose.map((it) => (
            <ItemRow
              key={it.id}
              title={it.name}
              quantity={it.quantity}
              photoUri={it.photo_uri}
              favorite={it.favorite === 1}
              onPress={() => router.push(`/item/${it.id}`)}
              onLongPress={() => actions.open(it.id)}
              onMore={() => actions.open(it.id)}
            />
          ))
        ) : (
          <Text style={styles.dim}>No hay objetos sueltos. Abre un mueble para ver su contenido.</Text>
        )}

        {empty ? (
          <View style={{ marginTop: space(6) }}>
            <Button label="Eliminar habitación" variant="danger" onPress={removeRoom} />
          </View>
        ) : null}
      </ScrollView>

      <ContainerSheet visible={furnitureSheet} onClose={() => setFurnitureSheet(false)} onSubmit={createFurniture} />
      <RoomSheet
        visible={editSheet}
        onClose={() => setEditSheet(false)}
        onSubmit={saveRoomMeta}
        title="Editar habitación"
        submitLabel="Guardar"
        initial={{ name: room.name, kind: room.kind, color: room.color ?? undefined }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  content: { width: '100%', maxWidth: 800, alignSelf: 'center', padding: space(5), gap: space(4), paddingBottom: space(18) },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  actions: { flexDirection: 'row', gap: space(3) },
  dim: { color: colors.textDim, fontSize: 14, paddingHorizontal: space(1) },
  meta: { color: colors.textDim, fontSize: 13 },
});
