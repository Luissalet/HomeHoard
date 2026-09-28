// Hoja de acciones rápidas para un objeto: cantidad ±, favorito, mover,
// editar y eliminar (con deshacer). Se abre desde cualquier lista con
// long-press o el botón "⋯" — sin salir de la pantalla actual.
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { createContext, useCallback, useContext, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useData } from '../db/provider';
import type { ID } from '../db/types';
import { colors, radius, space } from '../theme';
import { useToast } from '../ui/ToastProvider';
import { LocationPicker, type LocationValue } from './LocationPicker';

interface ItemActionsApi {
  /** Abre la hoja de acciones para el objeto indicado. */
  open: (itemId: ID) => void;
}

const Ctx = createContext<ItemActionsApi | null>(null);

export const useItemActions = (): ItemActionsApi => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useItemActions() debe usarse dentro de <ItemActionsProvider>');
  return ctx;
};

export function ItemActionsProvider({ children }: { children: React.ReactNode }) {
  const [itemId, setItemId] = useState<ID | null>(null);
  const open = useCallback((id: ID) => setItemId(id), []);

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {itemId ? <Sheet itemId={itemId} onClose={() => setItemId(null)} /> : null}
    </Ctx.Provider>
  );
}

function Sheet({ itemId, onClose }: { itemId: ID; onClose: () => void }) {
  const data = useData();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();

  const q = useQuery({
    queryKey: ['itemActions', itemId],
    queryFn: () => data.getItemWithLocation(itemId),
  });

  const item = q.data;

  const refreshAll = () => qc.invalidateQueries();

  async function setQuantity(delta: number) {
    if (!item) return;
    const next = Math.max(1, item.quantity + delta);
    if (next === item.quantity) return;
    await data.updateItem(itemId, { quantity: next });
    refreshAll();
  }

  async function toggleFavorite() {
    if (!item) return;
    await data.setItemFavorite(itemId, item.favorite !== 1);
    refreshAll();
  }

  async function move(loc: LocationValue) {
    if (!loc.roomId) return;
    await data.updateItem(itemId, { room_id: loc.roomId, container_id: loc.containerId });
    refreshAll();
    onClose();
    toast(`Movido a ${loc.label}`);
  }

  async function remove() {
    if (!item) return;
    const name = item.name;
    await data.deleteItem(itemId);
    refreshAll();
    onClose();
    toast(`"${name}" eliminado`, {
      actionLabel: 'Deshacer',
      onAction: async () => {
        await data.restoreItem(itemId);
        refreshAll();
      },
    });
  }

  const locationLabel = item
    ? item.containerName
      ? `${item.roomName} › ${item.containerName}`
      : item.roomName
    : '';

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
          {item ? (
            <>
              {/* Cabecera */}
              <View style={styles.head}>
                <View style={styles.thumb}>
                  {item.photo_uri ? (
                    <Image source={{ uri: item.photo_uri }} style={styles.img} contentFit="cover" />
                  ) : (
                    <Ionicons name="cube-outline" size={24} color={colors.textDim} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.path} numberOfLines={1}>
                    {locationLabel}
                  </Text>
                </View>
                <Pressable onPress={onClose} hitSlop={10}>
                  <Ionicons name="close" size={22} color={colors.textDim} />
                </Pressable>
              </View>

              {/* Cantidad */}
              <View style={styles.qtyRow}>
                <Text style={styles.qtyLabel}>Cantidad</Text>
                <View style={styles.stepper}>
                  <Pressable style={styles.stepBtn} onPress={() => setQuantity(-1)} disabled={item.quantity <= 1}>
                    <Ionicons name="remove" size={20} color={item.quantity <= 1 ? colors.border : colors.text} />
                  </Pressable>
                  <Text style={styles.qty}>{item.quantity}</Text>
                  <Pressable style={styles.stepBtn} onPress={() => setQuantity(1)}>
                    <Ionicons name="add" size={20} color={colors.text} />
                  </Pressable>
                </View>
              </View>

              {/* Mover */}
              <LocationPicker
                value={{ roomId: item.room_id, containerId: item.container_id, label: locationLabel }}
                onChange={move}
              />

              {/* Acciones */}
              <View style={styles.actions}>
                <ActionBtn
                  icon={item.favorite === 1 ? 'star' : 'star-outline'}
                  label={item.favorite === 1 ? 'Quitar favorito' : 'Favorito'}
                  active={item.favorite === 1}
                  onPress={toggleFavorite}
                />
                <ActionBtn
                  icon="create-outline"
                  label="Editar"
                  onPress={() => {
                    onClose();
                    router.push(`/item/${itemId}`);
                  }}
                />
                <ActionBtn icon="trash-outline" label="Eliminar" danger onPress={remove} />
              </View>
            </>
          ) : (
            <View style={{ padding: space(6) }}>
              <Text style={styles.path}>Cargando…</Text>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionBtn({
  icon,
  label,
  onPress,
  danger,
  active,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
  active?: boolean;
}) {
  const tint = danger ? colors.danger : active ? colors.warn : colors.text;
  return (
    <Pressable style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <Ionicons name={icon} size={22} color={tint} />
      <Text style={[styles.actionLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space(5),
    gap: space(4),
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  img: { width: 48, height: 48 },
  name: { color: colors.text, fontSize: 17, fontWeight: '700' },
  path: { color: colors.textDim, fontSize: 13, marginTop: 1 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qtyLabel: { color: colors.textDim, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qty: { color: colors.text, fontSize: 17, fontWeight: '700', minWidth: 28, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: space(2) },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    gap: space(1),
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: space(3),
  },
  actionLabel: { fontSize: 12, fontWeight: '700' },
});
