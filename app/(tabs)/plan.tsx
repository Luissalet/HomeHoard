import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useData } from '../../src/db/provider';
import type { ID, Rect } from '../../src/db/types';
import { RoomSheet } from '../../src/features/CreateSheets';
import { FloorPlanView } from '../../src/plan/FloorPlanView';
import { colors, radius, space } from '../../src/theme';
import { Button, Chip, EmptyState, Fab } from '../../src/ui/components';
import { useToast } from '../../src/ui/ToastProvider';

export default function MapaScreen() {
  const data = useData();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [floorId, setFloorId] = useState<ID | null>(null);
  const [editing, setEditing] = useState(false);
  const [roomSheet, setRoomSheet] = useState(false);
  const { width } = useWindowDimensions();

  const homesQ = useQuery({ queryKey: ['homes'], queryFn: () => data.listHomes() });
  const home = homesQ.data?.[0];

  const floorsQ = useQuery({
    queryKey: ['floors', home?.id],
    queryFn: () => data.listFloors(home!.id),
    enabled: !!home,
  });

  useEffect(() => {
    if (!floorId && floorsQ.data && floorsQ.data.length) setFloorId(floorsQ.data[0].id);
  }, [floorsQ.data, floorId]);

  const planQ = useQuery({
    queryKey: ['plan', floorId],
    queryFn: () => data.getFloorPlan(floorId!),
    enabled: !!floorId,
  });

  const countsQ = useQuery({
    queryKey: ['counts', floorId],
    queryFn: () => data.countItemsByRoom(floorId!),
    enabled: !!floorId,
  });

  const roomCounts: Record<ID, number> = {};
  countsQ.data?.forEach((c) => {
    roomCounts[c.room.id] = c.count;
  });

  async function createRoom(draft: { name: string; kind: string | null; color: string }) {
    if (!floorId || !planQ.data) return;
    const rooms = planQ.data.rooms;
    const idx = rooms.length;
    const floorW = planQ.data.floor.width_cm;
    const cols = Math.max(1, Math.floor(floorW / 320));
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    await data.addRoom(
      floorId,
      draft.name,
      { x_cm: col * 320 + 10, y_cm: row * 320 + 10, width_cm: 300, height_cm: 300 },
      { kind: draft.kind ?? undefined, color: draft.color }
    );
    qc.invalidateQueries({ queryKey: ['plan', floorId] });
    qc.invalidateQueries({ queryKey: ['counts', floorId] });
    qc.invalidateQueries({ queryKey: ['allRooms'] });
    toast(`Habitación "${draft.name}" creada · muévela con ✏️`);
  }

  async function saveRoomGeometry(roomId: ID, rect: Rect) {
    await data.updateRoomGeometry(roomId, rect);
    qc.invalidateQueries({ queryKey: ['plan', floorId] });
  }

  async function saveContainerGeometry(containerId: ID, rect: Rect) {
    await data.updateContainerGeometry(containerId, rect);
    qc.invalidateQueries({ queryKey: ['plan', floorId] });
  }

  if (homesQ.isLoading || floorsQ.isLoading || (floorId && planQ.isLoading)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const floors = floorsQ.data ?? [];
  const plan = planQ.data;

  if (!home) return (
    <View style={styles.center}>
      <EmptyState icon="home-outline" title="Crea tu casa primero" subtitle="Después podrás añadir habitaciones y verlas en el plano." />
      <Button label="Ir a inicio" onPress={() => router.push('/(tabs)')} />
    </View>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.controls}>
        <View style={{ flex: 1 }}>
          <Text style={styles.homeName}>{home?.name ?? 'Mi casa'}</Text>
          {floors.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.floorRow}>
              {floors.map((f) => (
                <Chip key={f.id} label={f.name} selected={f.id === floorId} onPress={() => setFloorId(f.id)} />
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.floorName}>{plan?.floor.name}</Text>
          )}
        </View>
        {plan && plan.rooms.length ? (
          <Pressable
            style={[styles.editBtn, editing && styles.editBtnActive]}
            onPress={() => setEditing((e) => !e)}
            accessibilityLabel={editing ? 'Terminar edición' : 'Editar plano'}
          >
            <Ionicons name={editing ? 'checkmark' : 'pencil'} size={18} color={editing ? '#fff' : colors.text} />
          </Pressable>
        ) : null}
        <Button label="＋ Habitación" variant="ghost" onPress={() => setRoomSheet(true)} />
      </View>

      {editing ? (
        <View style={styles.editBanner}>
          <Ionicons name="information-circle-outline" size={14} color={colors.accent} />
          <Text style={styles.editBannerText}>Modo edición: mueve y redimensiona. Pulsa ✓ al terminar.</Text>
        </View>
      ) : null}

      {plan && plan.rooms.length ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.planContent}>
          <View style={[styles.planFrame, { height: Math.max(315, Math.min(width * 0.78, 520)) }]}>
            <FloorPlanView
              plan={plan}
              roomCounts={roomCounts}
              editable={editing}
              onSelectRoom={(id) => router.push(`/room/${id}`)}
              onSelectContainer={(id) => router.push(`/container/${id}`)}
              onRoomGeometry={saveRoomGeometry}
              onContainerGeometry={saveContainerGeometry}
            />
          </View>
          {!editing ? <View style={styles.roomDirectory}>
            <Text style={styles.directoryTitle}>Habitaciones</Text>
            {plan.rooms.map((room) => <Pressable key={room.id} style={styles.directoryRow} onPress={() => router.push(`/room/${room.id}`)} accessibilityRole="button"><Text style={styles.directoryName}>{room.name}</Text><Text style={styles.directoryCount}>{roomCounts[room.id] === 1 ? '1 objeto' : `${roomCounts[room.id] ?? 0} objetos`}</Text><Ionicons name="chevron-forward" size={16} color={colors.textDim} /></Pressable>)}
          </View> : null}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState
            icon="map-outline"
            title="Aún no has mapeado esta planta"
            subtitle="Añade tu primera habitación para empezar a colocar muebles y objetos."
          />
          <View style={{ paddingHorizontal: space(6) }}>
            <Button label="Añadir habitación" onPress={() => setRoomSheet(true)} />
          </View>
        </View>
      )}

      {!editing ? <Fab onPress={() => router.push('/add')} /> : null}

      <RoomSheet visible={roomSheet} onClose={() => setRoomSheet(false)} onSubmit={createRoom} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3) },
  homeName: { color: colors.text, fontSize: 20, fontWeight: '800' },
  floorName: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  floorRow: { gap: space(2), paddingTop: space(2) },
  editBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBtnActive: { backgroundColor: colors.accent2, borderColor: colors.accent2 },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingHorizontal: space(4),
    paddingBottom: space(2),
  },
  editBannerText: { color: colors.textDim, fontSize: 12 },
  planContent: { width: '100%', maxWidth: 920, alignSelf: 'center', paddingHorizontal: space(4), paddingBottom: space(20), gap: space(5) },
  planFrame: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  roomDirectory: { gap: space(1) },
  directoryTitle: { color: colors.text, fontSize: 21, fontWeight: '700', marginBottom: space(2) },
  directoryRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), backgroundColor: colors.surface, borderRadius: radius.md, padding: space(4) },
  directoryName: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  directoryCount: { color: colors.textDim, fontSize: 13 },
});
