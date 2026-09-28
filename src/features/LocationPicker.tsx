import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useData } from '../db/provider';
import type { Container, RoomChoice } from '../db/types';
import { colors, radius, space } from '../theme';
import { containerLineIcon, roomLineIcon } from '../ui/kinds';

export interface LocationValue {
  roomId: string | null;
  containerId: string | null;
  label: string;
}

export function LocationPicker({
  value,
  onChange,
}: {
  value: LocationValue;
  onChange: (v: LocationValue) => void;
}) {
  const data = useData();
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState<RoomChoice | null>(null);

  const roomsQ = useQuery({
    queryKey: ['allRooms'],
    enabled: open,
    queryFn: () => data.listAllRooms(),
  });

  const contsQ = useQuery({
    queryKey: ['flatContainers', room?.room.id],
    enabled: !!room,
    queryFn: async (): Promise<{ container: Container; depth: number }[]> => {
      const result: { container: Container; depth: number }[] = [];
      const dfs = async (parentId: string | null, depth: number) => {
        const nodes = parentId == null ? await data.listRootContainers(room!.room.id) : await data.listChildContainers(parentId);
        for (const c of nodes) {
          result.push({ container: c, depth });
          await dfs(c.id, depth + 1);
        }
      };
      await dfs(null, 0);
      return result;
    },
  });

  function choose(rc: RoomChoice, container: Container | null) {
    const containers = new Map((contsQ.data ?? []).map((entry) => [entry.container.id, entry.container]));
    const names: string[] = [];
    let current = container;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parent_container_id ? containers.get(current.parent_container_id) ?? null : null;
    }
    onChange({
      roomId: rc.room.id,
      containerId: container ? container.id : null,
      label: rc.label + (names.length ? ` › ${names.join(' › ')}` : ''),
    });
    setOpen(false);
    setRoom(null);
  }

  return (
    <>
      <Pressable style={styles.field} onPress={() => setOpen(true)}>
        <Ionicons name="location-outline" size={18} color={colors.textDim} />
        <Text style={[styles.fieldText, !value.roomId && { color: colors.textDim }]} numberOfLines={1}>
          {value.roomId ? value.label : 'Elegir ubicación'}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
      </Pressable>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <View style={styles.head}>
              {room ? (
                <Pressable onPress={() => setRoom(null)} hitSlop={10}>
                  <Ionicons name="chevron-back" size={22} color={colors.text} />
                </Pressable>
              ) : (
                <View style={{ width: 22 }} />
              )}
              <Text style={styles.headTitle}>{room ? room.room.name : 'Elige habitación'}</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={{ padding: space(4), gap: space(2) }}>
              {!room ? (
                (roomsQ.data ?? []).map((rc) => (
                  <Pressable key={rc.room.id} style={styles.opt} onPress={() => setRoom(rc)}>
                    <Ionicons name={roomLineIcon(rc.room.kind)} size={20} color={colors.accent} />
                    <Text style={styles.optText}>{rc.label}</Text>
                    <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                  </Pressable>
                ))
              ) : (
                <>
                  <Pressable style={[styles.opt, styles.optLoose]} onPress={() => choose(room, null)}>
                    <Ionicons name="location-outline" size={20} color={colors.accent} />
                    <Text style={styles.optText}>Suelto en la habitación</Text>
                  </Pressable>
                  {(contsQ.data ?? []).map(({ container, depth }) => (
                    <Pressable
                      key={container.id}
                      style={[styles.opt, { marginLeft: depth * space(4) }]}
                      onPress={() => choose(room, container)}
                    >
                      <Ionicons name={containerLineIcon(container.kind)} size={20} color={colors.accent} />
                      <Text style={styles.optText}>{container.name}</Text>
                    </Pressable>
                  ))}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
  },
  fieldText: { flex: 1, color: colors.text, fontSize: 16 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: '80%' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space(4), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  headTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  opt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  optLoose: { borderWidth: 1, borderColor: colors.accent2 },
  optText: { flex: 1, color: colors.text, fontSize: 15 },
});
