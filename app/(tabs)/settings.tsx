import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useData } from '../../src/db/provider';
import { discardRestoredPhotos, exportBackup, pickBackup, updateFaustus } from '../../src/features/backup';
import { colors, radius, space } from '../../src/theme';
import { Button, Card, Chip, Input, SectionTitle } from '../../src/ui/components';
import { ROOM_COLORS } from '../../src/ui/kinds';
import { usePrompt } from '../../src/ui/PromptProvider';
import { useToast } from '../../src/ui/ToastProvider';
import type { Tag } from '../../src/db/types';

export default function AjustesScreen() {
  const data = useData();
  const prompt = usePrompt();
  const toast = useToast();
  const qc = useQueryClient();
  const [tagEdit, setTagEdit] = useState<Tag | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);

  const homesQ = useQuery({
    queryKey: ['settingsHomes'],
    queryFn: async () => {
      const homes = await data.listHomes();
      const withFloors = await Promise.all(
        homes.map(async (h) => ({ home: h, floors: await data.listFloors(h.id) }))
      );
      return withFloors;
    },
  });
  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: () => data.listTags() });
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => data.getStats() });

  const refresh = () => qc.invalidateQueries();

  async function addHome() {
    const name = await prompt({ title: 'Nueva vivienda', placeholder: 'p. ej. Trastero', confirmLabel: 'Crear' });
    if (!name) return;
    const home = await data.addHome(name, 'storage');
    await data.addFloor(home.id, 'Planta única', 800, 600);
    refresh();
  }

  async function addFloor(homeId: string) {
    const name = await prompt({ title: 'Nueva planta', placeholder: 'p. ej. Piso 1', confirmLabel: 'Crear' });
    if (!name) return;
    await data.addFloor(homeId, name, 900, 700);
    refresh();
  }

  async function addTag() {
    const name = await prompt({ title: 'Nueva etiqueta', placeholder: 'p. ej. Frágil', confirmLabel: 'Crear' });
    if (!name) return;
    await data.createTag(name);
    refresh();
  }

  async function doExport() {
    try {
      const filename = await exportBackup(data);
      toast(`Copia exportada: ${filename}`);
    } catch (e) {
      toast('No se pudo exportar la copia');
    }
  }

  async function syncFaustus() {
    try {
      const count = await updateFaustus(data);
      toast(`Faustus actualizado: ${count} objetos`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo actualizar Faustus');
    }
  }

  async function doImport() {
    setConfirmImport(false);
    const bundle = await pickBackup();
    if (!bundle) {
      toast('Importación cancelada o archivo no válido');
      return;
    }
    try {
      await data.importAll(bundle);
      refresh();
      const n = bundle.data.items.filter((i) => i.deleted_at == null).length;
      toast(`Inventario restaurado: ${n === 1 ? '1 objeto' : `${n} objetos`}`);
    } catch (error) {
      await discardRestoredPhotos(bundle);
      toast(error instanceof Error && error.message.includes('espacio disponible')
        ? error.message : 'El archivo no es una copia válida de HomeHoard');
    }
  }

  const s = statsQ.data;

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      {/* Resumen */}
      {s ? (
        <View style={{ gap: space(2) }}>
          <SectionTitle>Tu inventario</SectionTitle>
          <View style={styles.statsGrid}>
            <StatTile icon="cube-outline" value={s.items} label="Objetos" />
            <StatTile icon="layers-outline" value={s.totalQuantity} label="Unidades" />
            <StatTile icon="file-tray-stacked-outline" value={s.containers} label="Muebles" />
            <StatTile icon="grid-outline" value={s.rooms} label="Habitaciones" />
            <StatTile icon="star-outline" value={s.favorites} label="Favoritos" />
            <StatTile icon="image-outline" value={s.photos} label="Con foto" />
          </View>
        </View>
      ) : null}

      <View style={{ gap: space(2) }}>
        <SectionTitle>Estructura</SectionTitle>
        {(homesQ.data ?? []).map(({ home, floors }) => (
          <Card key={home.id}>
            <Text style={styles.homeName}>{home.name}</Text>
            <Text style={styles.dim}>
              {floors.length === 1 ? '1 planta' : `${floors.length} plantas`}: {floors.map((f) => f.name).join(', ')}
            </Text>
            <View style={{ marginTop: space(3) }}>
              <Button label="＋ Planta" variant="ghost" onPress={() => addFloor(home.id)} />
            </View>
          </Card>
        ))}
        <Button label="＋ Vivienda" variant="ghost" onPress={addHome} />
      </View>

      <View style={{ gap: space(2) }}>
        <SectionTitle>Etiquetas</SectionTitle>
        <Text style={styles.dim}>Toca una etiqueta para renombrarla, cambiarle el color o borrarla.</Text>
        <View style={styles.tags}>
          {(tagsQ.data ?? []).map((t) => (
            <Chip key={t.id} label={t.name} color={t.color} onPress={() => setTagEdit(t)} />
          ))}
          <Chip label="＋ Nueva" onPress={addTag} />
        </View>
      </View>

      <View style={{ gap: space(2) }}>
        <SectionTitle>Copia de seguridad</SectionTitle>
        <Card>
          <View style={styles.backupRow}>
            <Ionicons name="download-outline" size={22} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Exportar a JSON</Text>
              <Text style={styles.dim}>Guarda inventario y fotos en un archivo portable.</Text>
            </View>
          </View>
          <View style={{ marginTop: space(3) }}>
            <Button label="Exportar copia" variant="ghost" onPress={doExport} />
          </View>
        </Card>
        <Card>
          <View style={styles.backupRow}>
            <Ionicons name="document-text-outline" size={22} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Importar desde JSON</Text>
              <Text style={styles.dim}>Restaura una copia. Sustituye todos los datos actuales.</Text>
            </View>
          </View>
          <View style={{ marginTop: space(3) }}>
            {confirmImport ? (
              <View style={{ gap: space(2) }}>
                <Text style={styles.warn}>Esto reemplazará tu inventario actual. ¿Continuar?</Text>
                <Button label="Sí, importar" variant="danger" onPress={doImport} />
                <Button label="Cancelar" variant="ghost" onPress={() => setConfirmImport(false)} />
              </View>
            ) : (
              <Button label="Importar copia" variant="ghost" onPress={() => setConfirmImport(true)} />
            )}
          </View>
        </Card>
      </View>

      <View style={{ gap: space(2) }}>
        <SectionTitle>Preguntar a Faustus</SectionTitle>
        <Card>
          <View style={styles.backupRow}>
            <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>¿Dónde guardé la linterna?</Text>
              <Text style={styles.dim}>Faustus puede buscar tus objetos con una copia local sin fotos. Después de la primera actualización, los cambios de esta web se enviarán solos mientras el puente local esté abierto.</Text>
            </View>
          </View>
          {Platform.OS === 'web' && ['127.0.0.1', 'localhost'].includes(window.location.hostname) ? <View style={{ marginTop: space(3), gap: space(2) }}><Button label="Actualizar Faustus ahora" onPress={syncFaustus} /><Button label="Abrir puente local" variant="ghost" onPress={() => { void Linking.openURL('http://127.0.0.1:5196/'); }} /></View> : <Text style={[styles.dim, { marginTop: space(3) }]}>Pasa la copia JSON a tu ordenador y cárgala en el puente local de HomeHoard. No se envía a ningún servicio externo.</Text>}
        </Card>
      </View>

      <View style={{ gap: space(2) }}>
        <SectionTitle>Acerca de</SectionTitle>
        <Card>
          <Text style={styles.homeName}>HomeHoard</Text>
          <Text style={styles.dim}>Versión {Constants.expoConfig?.version ?? '0.2.0'} · Inventario local, sin cuenta ni nube.</Text>
        </Card>
      </View>

      <TagEditSheet
        tag={tagEdit}
        onClose={() => setTagEdit(null)}
        onSaved={() => {
          setTagEdit(null);
          refresh();
        }}
      />
    </ScrollView>
  );
}

function StatTile({ icon, value, label }: { icon: keyof typeof Ionicons.glyphMap; value: number; label: string }) {
  return (
    <View style={styles.statTile}>
      <Ionicons name={icon} size={18} color={colors.accent} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function TagEditSheet({ tag, onClose, onSaved }: { tag: Tag | null; onClose: () => void; onSaved: () => void }) {
  const data = useData();
  const toast = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  React.useEffect(() => {
    if (tag) {
      setName(tag.name);
      setColor(tag.color);
      setConfirmDelete(false);
    }
  }, [tag]);

  if (!tag) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Editar etiqueta</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textDim} />
            </Pressable>
          </View>

          <Input value={name} onChangeText={setName} placeholder="Nombre" />

          <View>
            <Text style={styles.label}>Color</Text>
            <View style={styles.colorRow}>
              {ROOM_COLORS.map((c) => (
                <Pressable
                  key={c}
                  style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchSel]}
                  onPress={() => setColor(color === c ? null : c)}
                />
              ))}
            </View>
          </View>

          <Button
            label="Guardar"
            onPress={async () => {
              if (!name.trim()) return;
              await data.updateTag(tag.id, { name: name.trim(), color });
              onSaved();
            }}
          />

          {confirmDelete ? (
            <View style={{ gap: space(2) }}>
              <Text style={styles.warn}>Se quitará de todos los objetos. ¿Borrar "{tag.name}"?</Text>
              <Button
                label="Sí, borrar etiqueta"
                variant="danger"
                onPress={async () => {
                  await data.deleteTag(tag.id);
                  toast(`Etiqueta "${tag.name}" borrada`);
                  onSaved();
                }}
              />
            </View>
          ) : (
            <Button label="Borrar etiqueta" variant="ghost" onPress={() => setConfirmDelete(true)} />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  content: { width: '100%', maxWidth: 900, alignSelf: 'center', padding: space(5), paddingBottom: space(16), gap: space(7) },
  homeName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  dim: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  warn: { color: colors.text, fontSize: 14, textAlign: 'center' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  backupRow: { flexDirection: 'row', gap: space(3), alignItems: 'center' },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  statTile: {
    flexGrow: 1,
    flexBasis: '30%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    paddingVertical: space(3),
    gap: 2,
  },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '800' },
  statLabel: { color: colors.textDim, fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space(5),
    gap: space(4),
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  label: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: space(2) },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: 'transparent' },
  swatchSel: { borderColor: '#fff' },
});
