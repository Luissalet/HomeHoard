import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useData } from '../../src/db/provider';
import type { Container } from '../../src/db/types';
import { ContainerSheet } from '../../src/features/CreateSheets';
import { printLabel } from '../../src/features/qrLabels';
import { useItemActions } from '../../src/features/ItemActionsSheet';
import { colors, space } from '../../src/theme';
import { Button, EmptyState, NavRow, SectionTitle } from '../../src/ui/components';
import { ItemRow } from '../../src/ui/ItemRow';
import { containerLineIcon, containerKindLabel } from '../../src/ui/kinds';
import { useToast } from '../../src/ui/ToastProvider';

export default function ContainerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useData();
  const router = useRouter();
  const toast = useToast();
  const actions = useItemActions();
  const qc = useQueryClient();
  const [subSheet, setSubSheet] = useState(false);
  const [editSheet, setEditSheet] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const q = useQuery({
    queryKey: ['container', id],
    queryFn: async () => {
      const container = await data.getContainer(id);
      if (!container) return { container: null as Container | null };
      const ancestors: Container[] = [];
      let pid = container.parent_container_id;
      const guard = new Set<string>();
      while (pid && !guard.has(pid)) {
        guard.add(pid);
        const p = await data.getContainer(pid);
        if (!p) break;
        ancestors.unshift(p);
        pid = p.parent_container_id;
      }
      const room = await data.getRoom(container.room_id);
      const children = await data.listChildContainers(id);
      const counts = await Promise.all(children.map((c) => data.listItemsInContainerDeep(c.id).then((a) => a.length)));
      const items = await data.listItemsInContainer(id);
      const deepCount = (await data.listItemsInContainerDeep(id)).length;
      return { container, ancestors, room, children: children.map((c, i) => ({ c, count: counts[i] })), items, deepCount };
    },
  });

  const refresh = () => qc.invalidateQueries();

  async function createSub(draft: { name: string; kind: string | null }) {
    await data.addContainer(q.data!.container!.room_id, draft.name, {
      kind: draft.kind ?? 'drawer',
      parentContainerId: id,
    });
    refresh();
  }

  async function saveMeta(draft: { name: string; kind: string | null }) {
    await data.updateContainerMeta(id, { name: draft.name, kind: draft.kind });
    refresh();
  }

  async function removeContainer() {
    const c = q.data?.container;
    if (!c) return;
    await data.deleteContainer(id);
    refresh();
    router.back();
    toast(`"${c.name}" eliminado · sus objetos quedan sueltos en la habitación`);
  }

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const container = q.data?.container;
  if (!container) {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert-circle-outline" title="Mueble no encontrado" />
      </View>
    );
  }

  const { ancestors = [], room, children = [], items = [], deepCount = 0 } = q.data!;

  async function printContainerLabel() {
    try {
      await printLabel('container', id, container!.name, [room?.name, ...ancestors.map((a) => a.name)].filter(Boolean).join(' › '));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo imprimir la etiqueta.');
    }
  }

  return (
    <View style={styles.wrap}>
      <Stack.Screen
        options={{
          title: container.name,
          headerLeft: () => <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} hitSlop={10} accessibilityLabel="Volver" style={{ marginRight: space(3) }}><Ionicons name="arrow-back" size={22} color={colors.text} /></Pressable>,
          headerRight: () => (
            <Pressable onPress={() => setEditSheet(true)} hitSlop={10}>
              <Ionicons name="create-outline" size={22} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {/* Migas de pan */}
        <View style={styles.crumbs}>
          {room ? (
            <Pressable onPress={() => router.push(`/room/${room.id}`)}>
              <Text style={styles.crumbLink}>{room.name}</Text>
            </Pressable>
          ) : null}
          {ancestors.map((a) => (
            <View key={a.id} style={styles.crumbItem}>
              <Text style={styles.crumbSep}>›</Text>
              <Pressable onPress={() => router.push(`/container/${a.id}`)}>
                <Text style={styles.crumbLink}>{a.name}</Text>
              </Pressable>
            </View>
          ))}
          <Text style={styles.crumbSep}>›</Text>
          <Text style={styles.crumbCurrent}>
            {containerKindLabel(container.kind)} · {deepCount === 1 ? '1 objeto' : `${deepCount} objetos`}
          </Text>
        </View>

        <View style={styles.actions}>
          <View style={{ flex: 1 }}>
            <Button label="＋ Sub-contenedor" variant="ghost" onPress={() => setSubSheet(true)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="＋ Objeto"
              onPress={() => router.push({ pathname: '/add', params: { roomId: container.room_id, containerId: id } })}
            />
          </View>
        </View>
        <Button label="Imprimir etiqueta QR" variant="ghost" onPress={printContainerLabel} />

        {children.length ? (
          <>
            <SectionTitle>Dentro de este mueble</SectionTitle>
            {children.map(({ c, count }) => (
              <NavRow
                key={c.id}
                icon={containerLineIcon(c.kind)}
                title={c.name}
                subtitle={`${c.name === containerKindLabel(c.kind) ? '' : `${containerKindLabel(c.kind)} · `}${count === 1 ? '1 objeto' : `${count} objetos`}`}
                onPress={() => router.push(`/container/${c.id}`)}
              />
            ))}
          </>
        ) : null}

        <View style={{ height: space(2) }} />
        <SectionTitle>Objetos</SectionTitle>
        {items.length ? (
          items.map((it) => (
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
          <Text style={styles.dim}>Este mueble está vacío. Añade objetos con el botón ＋.</Text>
        )}

        <View style={{ marginTop: space(6), gap: space(2) }}>
          {confirmDelete ? (
            <>
              <Text style={styles.warn}>
                {deepCount > 0
                  ? `Se eliminará el mueble y sus sub-contenedores. Sus ${deepCount === 1 ? 'objeto quedará suelto' : `${deepCount} objetos quedarán sueltos`} en la habitación.`
                  : '¿Eliminar este mueble?'}
              </Text>
              <Button label="Sí, eliminar" variant="danger" onPress={removeContainer} />
              <Button label="Cancelar" variant="ghost" onPress={() => setConfirmDelete(false)} />
            </>
          ) : (
            <Button label="Eliminar mueble" variant="danger" onPress={() => setConfirmDelete(true)} />
          )}
        </View>
      </ScrollView>

      <ContainerSheet visible={subSheet} onClose={() => setSubSheet(false)} onSubmit={createSub} title="Nuevo sub-contenedor" />
      <ContainerSheet
        visible={editSheet}
        onClose={() => setEditSheet(false)}
        onSubmit={saveMeta}
        title="Editar mueble"
        submitLabel="Guardar"
        initial={{ name: container.name, kind: container.kind }}
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
  warn: { color: colors.text, fontSize: 14, textAlign: 'center' },
  crumbs: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space(1.5) },
  crumbItem: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  crumbLink: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  crumbCurrent: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  crumbSep: { color: colors.textDim, fontSize: 13 },
});
