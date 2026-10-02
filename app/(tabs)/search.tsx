import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useData } from '../../src/db/provider';
import type { ID, ItemWithLocation } from '../../src/db/types';
import { useItemActions } from '../../src/features/ItemActionsSheet';
import { colors, radius, space } from '../../src/theme';
import { Chip, EmptyState, Fab } from '../../src/ui/components';
import { ItemRow } from '../../src/ui/ItemRow';

type Row =
  | { type: 'header'; key: string; title: string }
  | { type: 'item'; key: string; item: ItemWithLocation };

export default function BuscarScreen() {
  const data = useData();
  const router = useRouter();
  const actions = useItemActions();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<ID[]>([]);
  const [showAll, setShowAll] = useState(false);

  // Debounce ligero: la búsqueda es local, pero evita renders por tecla.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input), 120);
    return () => clearTimeout(t);
  }, [input]);

  const browsing = !query.trim() && selectedTags.length === 0;

  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: () => data.listTags() });
  const resultsQ = useQuery({
    queryKey: ['search', query, selectedTags],
    queryFn: () => data.searchItems(query, selectedTags),
  });
  const favoritesQ = useQuery({
    queryKey: ['favorites'],
    queryFn: () => data.listFavoriteItems(),
    enabled: browsing,
  });
  const recentsQ = useQuery({
    queryKey: ['recent'],
    queryFn: () => data.listRecentItems(8),
    enabled: browsing,
  });

  const toggleTag = (id: ID) =>
    setSelectedTags((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  const results = resultsQ.data ?? [];
  const pathsQ = useQuery({
    queryKey: ['searchPaths', results.slice(0, 60).map((item) => item.id).join(',')],
    queryFn: async () => Object.fromEntries(await Promise.all(results.slice(0, 60).map(async (item) => {
      const path = await data.getItemPath(item.id);
      return [item.id, path.map((segment) => segment.name).join(' › ')];
    }))),
    enabled: results.length > 0,
  });

  // En modo exploración: Favoritos → Recientes → Todo. Buscando: solo resultados.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (browsing) {
      const favs = favoritesQ.data ?? [];
      const favIds = new Set(favs.map((item) => item.id));
      const recents = (recentsQ.data ?? []).filter((item) => !favIds.has(item.id));
      if (favs.length && !showAll) {
        out.push({ type: 'header', key: 'h-fav', title: 'Favoritos' });
        for (const it of favs) out.push({ type: 'item', key: `f-${it.id}`, item: it });
      }
      if (recents.length && !showAll) {
        out.push({ type: 'header', key: 'h-rec', title: 'Recientes' });
        for (const it of recents) out.push({ type: 'item', key: `r-${it.id}`, item: it });
      }
      if (results.length && (showAll || (!favs.length && !recents.length))) {
        out.push({ type: 'header', key: 'h-all', title: `Todos los objetos (${results.length})` });
        for (const it of results) out.push({ type: 'item', key: `a-${it.id}`, item: it });
      }
    } else {
      for (const it of results) out.push({ type: 'item', key: it.id, item: it });
    }
    return out;
  }, [browsing, favoritesQ.data, recentsQ.data, results, showAll]);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={18} color={colors.textDim} />
          <TextInputLike value={input} onChangeText={setInput} />
          {input ? (
            <Pressable onPress={() => setInput('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textDim} />
            </Pressable>
          ) : null}
        </View>
        <Pressable onPress={() => router.push('/scan')} accessibilityRole="button" accessibilityLabel="Escanear etiqueta QR" style={{ alignSelf: 'flex-end', paddingVertical: space(2) }}>
          <Text style={{ color: colors.accent, fontWeight: '700' }}>Escanear etiqueta QR</Text>
        </Pressable>
        {browsing && results.length > 0 ? <Pressable onPress={() => setShowAll((value) => !value)} accessibilityRole="button" style={{ alignSelf: 'flex-start', paddingVertical: space(2) }}><Text style={{ color: colors.accent, fontWeight: '700' }}>{showAll ? 'Mostrar selección' : `Ver todos los objetos (${results.length})`}</Text></Pressable> : null}
        {tagsQ.data && tagsQ.data.length ? (
          <FlashList
            horizontal
            data={tagsQ.data}
            estimatedItemSize={90}
            showsHorizontalScrollIndicator={false}
            keyExtractor={(t) => t.id}
            contentContainerStyle={{ paddingVertical: space(2) }}
            ItemSeparatorComponent={() => <View style={{ width: space(2) }} />}
            renderItem={({ item }) => (
              <Chip label={item.name} color={item.color} selected={selectedTags.includes(item.id)} onPress={() => toggleTag(item.id)} />
            )}
          />
        ) : null}
        {!browsing ? (
          <Text style={styles.count}>
            {results.length === 0 ? 'Sin resultados' : results.length === 1 ? '1 objeto' : `${results.length} objetos`}
          </Text>
        ) : null}
      </View>

      {rows.length === 0 ? (
        browsing ? (
          <EmptyState
            icon="cube-outline"
            title="Tu inventario está vacío"
            subtitle="Añade tu primer objeto con el botón ＋ y aparecerá aquí."
          />
        ) : (
          <EmptyState icon="search-outline" title="Sin resultados" subtitle="Prueba otro término o quita algún filtro. La búsqueda ignora acentos y busca también en notas, etiquetas y ubicaciones." />
        )
      ) : (
        <FlashList
          data={rows}
          estimatedItemSize={72}
          keyExtractor={(r) => r.key}
          getItemType={(r) => r.type}
          contentContainerStyle={{ padding: space(4) }}
          ItemSeparatorComponent={() => <View style={{ height: space(2) }} />}
          renderItem={({ item: row }) =>
            row.type === 'header' ? (
              <Text style={styles.section}>{row.title}</Text>
            ) : (
              <ItemRow
                title={row.item.name}
                subtitle={pathsQ.data?.[row.item.id] ?? (row.item.containerName ? `${row.item.roomName} › ${row.item.containerName}` : row.item.roomName)}
                quantity={row.item.quantity}
                tags={row.item.tags}
                photoUri={row.item.photo_uri}
                favorite={row.item.favorite === 1}
                onPress={() => router.push(`/item/${row.item.id}`)}
                onLongPress={() => actions.open(row.item.id)}
                onMore={() => actions.open(row.item.id)}
              />
            )
          }
        />
      )}

      <Fab onPress={() => router.push('/add')} />
    </View>
  );
}

// Input embebido en la caja de búsqueda (con icono y botón de limpiar).
function TextInputLike({ value, onChangeText }: { value: string; onChangeText: (s: string) => void }) {
  return (
    <TextInput
      placeholder="¿Dónde está la linterna Philips?"
      placeholderTextColor={colors.textDim}
      value={value}
      onChangeText={onChangeText}
      autoCorrect={false}
      style={styles.searchInput}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: space(4), paddingTop: space(3), gap: space(1) },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: space(3),
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: space(3) },
  count: { color: colors.textDim, fontSize: 12, fontWeight: '600', marginTop: space(1) },
  section: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: space(3),
    marginBottom: space(1),
  },
});
