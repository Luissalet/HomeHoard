import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useData } from '../../src/db/provider';
import { hasExampleItems, onlyExampleItems } from '../../src/db/demo';
import { seedInitialHome } from '../../src/db/seed';
import { colors, radius, space } from '../../src/theme';
import { ItemRow } from '../../src/ui/ItemRow';
import { usePrompt } from '../../src/ui/PromptProvider';
import { useToast } from '../../src/ui/ToastProvider';

export default function InicioScreen() {
  const data = useData();
  const router = useRouter();
  const prompt = usePrompt();
  const toast = useToast();
  const qc = useQueryClient();
  const { width } = useWindowDimensions();
  const [confirmDemoReset, setConfirmDemoReset] = useState(false);
  const homesQ = useQuery({ queryKey: ['homes'], queryFn: () => data.listHomes() });
  const roomsQ = useQuery({ queryKey: ['allRooms'], queryFn: () => data.listAllRooms() });
  const recentQ = useQuery({ queryKey: ['recent'], queryFn: () => data.listRecentItems(5) });
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => data.getStats() });
  const demoQ = useQuery({ queryKey: ['demoDetection'], queryFn: () => data.searchItems('') });
  const home = homesQ.data?.[0];
  const rooms = roomsQ.data ?? [];
  const recent = recentQ.data ?? [];
  const isDemo = home?.name === 'Mi casa' && hasExampleItems(demoQ.data ?? []);
  const pureDemo = isDemo && onlyExampleItems(demoQ.data ?? []);

  async function clearDemo() {
    const bundle = await data.exportAll();
    await data.importAll({ ...bundle, data: { ...bundle.data, homes: [], floors: [], rooms: [], containers: [], items: [], tags: [], itemTags: [] } });
    setConfirmDemoReset(false);
    await qc.invalidateQueries();
    toast('Casa de ejemplo eliminada');
  }

  async function createFirstHome() {
    const name = await prompt({ title: 'Tu vivienda', placeholder: 'Por ejemplo, Mi casa', confirmLabel: 'Continuar' });
    if (!name?.trim()) return;
    const roomName = await prompt({ title: 'Primera habitación', placeholder: 'Por ejemplo, Salón', confirmLabel: 'Crear' });
    if (!roomName?.trim()) return;
    const created = await data.addHome(name.trim(), 'home');
    const floor = await data.addFloor(created.id, 'Planta principal', 900, 700);
    await data.addRoom(floor.id, roomName.trim(), { x_cm: 10, y_cm: 10, width_cm: 300, height_cm: 300 });
    await qc.invalidateQueries();
    toast('Ya puedes guardar tu primer objeto');
    router.push('/add');
  }

  async function loadExample() {
    if (!(await data.isEmpty())) return;
    await seedInitialHome(data);
    await qc.invalidateQueries();
    toast('Casa de ejemplo cargada');
  }

  if (homesQ.isLoading) return <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}><Ionicons name="home" size={20} color={colors.surface} /></View>
        <Text style={styles.brand}>HomeHoard</Text>
        <Text style={styles.local}>Solo en tus dispositivos</Text>
      </View>
      {!home ? (
        <View style={styles.onboarding}>
          <Text style={styles.heroTitle}>Cada cosa, en su sitio.</Text>
          <Text style={styles.heroText}>Guarda la habitación, el mueble y el cajón de tus objetos. Cuando los necesites, sabrás exactamente dónde mirar.</Text>
          <Pressable accessibilityRole="button" style={styles.primaryAction} onPress={createFirstHome}><Ionicons name="add" size={21} color="#fff" /><Text style={styles.primaryText}>Crear mi casa</Text></Pressable>
          <Pressable accessibilityRole="button" style={styles.exampleAction} onPress={loadExample}><Text style={styles.exampleText}>Explorar con una casa de ejemplo</Text><Ionicons name="arrow-forward" size={16} color={colors.accent} /></Pressable>
          <Text style={styles.hint}>La casa de ejemplo contiene datos ficticios. Tus datos se guardan en este dispositivo.</Text>
        </View>
      ) : (
        <>
          {isDemo ? <View style={styles.demoBanner}><Text style={styles.demoText}>{pureDemo ? 'Esta es una casa de ejemplo con objetos ficticios.' : 'Esta casa todavía contiene los objetos de ejemplo. También hay objetos añadidos: guarda una copia antes de empezar de cero.'}</Text>{pureDemo ? (confirmDemoReset ? <><Pressable onPress={clearDemo}><Text style={styles.demoLink}>Sí, empezar de cero</Text></Pressable><Pressable onPress={() => setConfirmDemoReset(false)}><Text style={styles.demoLink}>Cancelar</Text></Pressable></> : <Pressable onPress={() => setConfirmDemoReset(true)}><Text style={styles.demoLink}>Empezar con mi casa</Text></Pressable>) : null}</View> : null}
          <View style={styles.hero}>
            <View><Text style={styles.homeLabel}>{home.name}</Text><Text style={styles.heroTitle}>¿Dónde lo guardé?</Text><Text style={styles.heroText}>Busca un objeto y ve directamente a su ubicación.</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Buscar objetos" style={styles.searchAction} onPress={() => router.push('/(tabs)/search')}><Ionicons name="search" size={23} color={colors.accent} /><Text style={styles.searchActionText}>Buscar objeto, habitación o mueble…</Text><Ionicons name="arrow-forward" size={18} color={colors.accent} /></Pressable>
          </View>
          <View style={[styles.main, width >= 850 && styles.mainWide]}>
            <View style={styles.primaryColumn}>
              <View style={styles.sectionTop}><Text style={styles.sectionTitle}>Tus espacios</Text><Pressable onPress={() => router.push('/(tabs)/plan')}><Text style={styles.link}>Ver plano →</Text></Pressable></View>
              {rooms.length ? <View style={styles.rooms}>{rooms.slice(0, 8).map(({ room, label }) => <Pressable key={room.id} accessibilityRole="button" style={styles.roomRow} onPress={() => router.push(`/room/${room.id}`)}><View style={styles.roomIcon}><Ionicons name="grid-outline" size={20} color={colors.accent} /></View><View style={{ flex: 1 }}><Text style={styles.roomName}>{room.name}</Text>{label !== room.name ? <Text style={styles.roomLocation}>{label}</Text> : null}</View><Ionicons name="chevron-forward" size={17} color={colors.textDim} /></Pressable>)}</View> : <Text style={styles.hint}>Aún no hay habitaciones. Añade una desde el plano.</Text>}
              <Pressable accessibilityRole="button" style={styles.addAction} onPress={() => router.push('/add')}><Ionicons name="add-circle" size={23} color={colors.accent} /><Text style={styles.addText}>Guardar un objeto</Text><Ionicons name="arrow-forward" size={17} color={colors.accent} /></Pressable>
            </View>
            <View style={styles.secondaryColumn}>
              <View style={styles.sectionTop}><Text style={styles.sectionTitle}>Últimos objetos</Text><Text style={styles.count}>{statsQ.data?.items ?? 0} en total</Text></View>
              {recent.length ? recent.map((item) => <ItemRow key={item.id} title={item.name} subtitle={item.containerName ? `${item.roomName} › ${item.containerName}` : item.roomName} photoUri={item.photo_uri} quantity={item.quantity} onPress={() => router.push(`/item/${item.id}`)} />) : <View style={styles.emptyRecent}><Ionicons name="cube-outline" size={28} color={colors.accent} /><Text style={styles.emptyTitle}>Tu inventario empieza aquí</Text><Text style={styles.hint}>Añade un objeto y anota dónde está. Aparecerá en esta lista.</Text></View>}
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { width: '100%', maxWidth: 1040, alignSelf: 'center', paddingHorizontal: space(5), paddingTop: space(7), paddingBottom: space(12), gap: space(9) },
  loading: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  brandMark: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  brand: { color: colors.text, fontWeight: '800', fontSize: 19, letterSpacing: -0.5 },
  local: { marginLeft: 'auto', color: colors.textDim, fontSize: 12 },
  onboarding: { maxWidth: 650, paddingTop: space(13), gap: space(5) },
  hero: { gap: space(7), paddingVertical: space(5) },
  homeLabel: { color: colors.accent, fontSize: 14, fontWeight: '700', marginBottom: space(2) },
  heroTitle: { color: colors.text, fontSize: 43, fontWeight: '800', letterSpacing: -1.7, lineHeight: 49 },
  heroText: { color: colors.textDim, fontSize: 17, lineHeight: 25, marginTop: space(3), maxWidth: 550 },
  searchAction: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(5), backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, maxWidth: 680 },
  searchActionText: { color: colors.textDim, fontSize: 16, flex: 1 },
  primaryAction: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(6), paddingVertical: space(4), backgroundColor: colors.accent, borderRadius: radius.md },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  exampleAction: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(2) },
  exampleText: { color: colors.accent, fontWeight: '700' },
  main: { gap: space(8) }, mainWide: { flexDirection: 'row' },
  primaryColumn: { flex: 1.15, gap: space(3) }, secondaryColumn: { flex: 1, gap: space(3) },
  sectionTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  sectionTitle: { color: colors.text, fontSize: 23, fontWeight: '700', letterSpacing: -0.5 },
  link: { color: colors.accent, fontWeight: '700' }, count: { color: colors.textDim, fontSize: 13 },
  rooms: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  roomRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  roomIcon: { width: 37, height: 37, borderRadius: 10, backgroundColor: colors.surface2, justifyContent: 'center', alignItems: 'center' },
  roomName: { color: colors.text, fontWeight: '700', fontSize: 15 }, roomLocation: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  addAction: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(3) }, addText: { color: colors.accent, fontWeight: '700', fontSize: 15, flex: 1 },
  emptyRecent: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space(6), gap: space(2) }, emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  hint: { color: colors.textDim, fontSize: 14, lineHeight: 21, maxWidth: 500 },
  demoBanner: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3), alignItems: 'center', backgroundColor: '#E9DFCB', borderRadius: radius.md, padding: space(3) },
  demoText: { color: colors.text, flexGrow: 1, fontSize: 13 },
  demoLink: { color: colors.accent, fontWeight: '700', fontSize: 13 },
});
