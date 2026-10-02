import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useData } from '../src/db/provider';
import type { Container } from '../src/db/types';
import type { LocationValue } from '../src/features/LocationPicker';
import { hasPrefill, parseAddParams, pickByName, purchaseDetails, wantedPlace } from '../src/features/addPrefill';
import { ItemForm, type ItemFormValues } from '../src/features/ItemForm';
import { colors, radius, space } from '../src/theme';
import { useToast } from '../src/ui/ToastProvider';

export default function AddItemScreen() {
  const data = useData();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{
    roomId?: string; containerId?: string; name?: string; source_ref?: string; warranty_ref?: string; price?: string; merchant?: string; date?: string;
    room?: string; place?: string;
  }>();
  // Datos que trae el enlace de otro Hoard tras una compra (#/add?name=…&source_ref=…&price=…&merchant=…&date=…&room=…&place=…).
  const prefill = useMemo(() => parseAddParams(params), [params.name, params.source_ref, params.warranty_ref, params.price, params.merchant, params.date, params.room, params.place]);
  const fromPurchase = hasPrefill(prefill);
  const wanted = useMemo(() => wantedPlace(prefill), [prefill]);

  // Ubicación precargada por contexto (si venimos de una habitación o mueble) o por el nombre de la habitación y el mueble del enlace.
  const initQ = useQuery({
    queryKey: ['addInit', params.roomId, params.containerId, wanted?.room, wanted?.chain.join('/')],
    queryFn: async (): Promise<{ location: LocationValue | null; missing: string | null }> => {
      if (!params.roomId && wanted) {
        const room = pickByName((await data.listAllRooms()).map((c) => ({ name: c.room.name, id: c.room.id })), wanted.room);
        if (!room) return { location: null, missing: [wanted.room, ...wanted.chain].join(' › ') };
        let label = room.name;
        let containerId: string | null = null;
        for (const part of wanted.chain) {
          const options: Container[] = containerId ? await data.listChildContainers(containerId) : await data.listRootContainers(room.id);
          const next: Container | null = pickByName(options, part);
          if (!next) return { location: { roomId: room.id, containerId, label }, missing: [wanted.room, ...wanted.chain].join(' › ') };
          containerId = next.id;
          label += ` › ${next.name}`;
        }
        return { location: { roomId: room.id, containerId, label }, missing: null };
      }
      if (!params.roomId) return { location: null, missing: null };
      const room = await data.getRoom(params.roomId);
      if (!room) return { location: null, missing: null };
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
      return { location: { roomId: params.roomId, containerId, label }, missing: null };
    },
  });

  const add = async (v: ItemFormValues) => {
    const item = await data.addItem({
      name: v.name,
      description: v.description,
      quantity: v.quantity,
      room_id: v.roomId,
      container_id: v.containerId,
      photo_uri: v.photoUri,
      favorite: v.favorite,
      tagIds: v.tagIds,
    });
    // Un objeto que viene de una compra guarda en su ficha dónde se compró, cuánto costó, cuándo y de qué compra viene.
    const card = purchaseDetails(prefill);
    if (fromPurchase && Object.keys(card).length) await data.saveItemDetails(item.id, card);
    qc.invalidateQueries();
  };

  if ((params.roomId || wanted) && initQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ padding: space(5), paddingBottom: space(20) }} keyboardShouldPersistTaps="handled">
      {fromPurchase ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>Desde una compra</Text>
          <Text style={styles.bannerText}>
            {[prefill.merchant, prefill.price != null ? `${prefill.price} €` : null, prefill.date].filter(Boolean).join(' · ') || 'Revisa los datos y elige dónde se guarda.'}
          </Text>
          {initQ.data?.missing ? <Text style={styles.bannerText}>{`No encuentro «${initQ.data.missing}»: elige la ubicación abajo.`}</Text> : null}
        </View>
      ) : null}
      <ItemForm
        initial={{ name: prefill.name || undefined, location: initQ.data?.location ?? undefined }}
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
  banner: { backgroundColor: colors.surface, borderRadius: radius.md, padding: space(3), marginBottom: space(4), gap: 2 },
  bannerTitle: { color: colors.text, fontWeight: '700' },
  bannerText: { color: colors.textDim },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
});
