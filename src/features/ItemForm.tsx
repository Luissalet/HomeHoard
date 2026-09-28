import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useData } from '../db/provider';
import { normalizeText } from '../db/searchUtil';
import type { ID } from '../db/types';
import { colors, radius, space } from '../theme';
import { Button, Chip, Input } from '../ui/components';
import { usePrompt } from '../ui/PromptProvider';
import { LocationPicker, type LocationValue } from './LocationPicker';
import { cameraAvailable, persistPhoto, pickFromLibrary, takePhoto } from './photos';

export interface ItemFormValues {
  name: string;
  description: string | null;
  quantity: number;
  roomId: ID;
  containerId: ID | null;
  photoUri: string | null;
  favorite: boolean;
  tagIds: ID[];
}

export interface ItemFormInitial {
  name?: string;
  description?: string | null;
  quantity?: number;
  location?: LocationValue;
  photoUri?: string | null;
  favorite?: boolean;
  tagIds?: ID[];
}

export function ItemForm({
  initial,
  submitLabel,
  onSubmit,
  onSubmitAndAnother,
  checkDuplicates = false,
}: {
  initial?: ItemFormInitial;
  submitLabel: string;
  onSubmit: (v: ItemFormValues) => Promise<void> | void;
  onSubmitAndAnother?: (v: ItemFormValues) => Promise<void> | void;
  /** En alta: avisa si ya existe un objeto con nombre parecido. */
  checkDuplicates?: boolean;
}) {
  const data = useData();
  const prompt = usePrompt();
  const qc = useQueryClient();

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [quantity, setQuantity] = useState(initial?.quantity ?? 1);
  const [photoUri, setPhotoUri] = useState<string | null>(initial?.photoUri ?? null);
  const [favorite, setFavorite] = useState(initial?.favorite ?? false);
  const [tagIds, setTagIds] = useState<ID[]>(initial?.tagIds ?? []);
  const [location, setLocation] = useState<LocationValue>(
    initial?.location ?? { roomId: null, containerId: null, label: '' }
  );
  const [busy, setBusy] = useState(false);
  const [dupQuery, setDupQuery] = useState('');

  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: () => data.listTags() });

  // Aviso de duplicados (debounced, solo en alta).
  useEffect(() => {
    if (!checkDuplicates) return;
    const t = setTimeout(() => setDupQuery(name.trim()), 350);
    return () => clearTimeout(t);
  }, [name, checkDuplicates]);

  const dupQ = useQuery({
    queryKey: ['dupCheck', dupQuery],
    enabled: checkDuplicates && dupQuery.length >= 3,
    queryFn: () => data.searchItems(dupQuery),
  });

  const duplicate =
    checkDuplicates && dupQuery.length >= 3
      ? (dupQ.data ?? []).find((i) => normalizeText(i.name) === normalizeText(dupQuery)) ?? null
      : null;

  const canSubmit = name.trim().length > 0 && !!location.roomId && !busy;

  const collect = (): ItemFormValues => ({
    name: name.trim(),
    description: description.trim() ? description.trim() : null,
    quantity,
    roomId: location.roomId!,
    containerId: location.containerId,
    photoUri,
    favorite,
    tagIds,
  });

  async function addPhoto(fromCamera: boolean) {
    const uri = fromCamera ? await takePhoto() : await pickFromLibrary();
    if (!uri) return;
    const saved = await persistPhoto(uri);
    setPhotoUri(saved);
  }

  async function newTag() {
    const tagName = await prompt({ title: 'Nueva etiqueta', placeholder: 'p. ej. Frágil', confirmLabel: 'Crear' });
    if (!tagName) return;
    const tag = await data.createTag(tagName);
    qc.invalidateQueries({ queryKey: ['tags'] });
    setTagIds((prev) => (prev.includes(tag.id) ? prev : [...prev, tag.id]));
  }

  const toggleTag = (id: ID) => setTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  async function submit(another: boolean) {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const values = collect();
      if (another && onSubmitAndAnother) {
        await onSubmitAndAnother(values);
        // Mantiene la ubicación; limpia el resto para meter el siguiente objeto rápido.
        setName('');
        setDescription('');
        setQuantity(1);
        setPhotoUri(null);
        setFavorite(false);
        setTagIds([]);
        setDupQuery('');
      } else {
        await onSubmit(values);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: space(4) }}>
      <View>
        <Text style={styles.label}>Nombre</Text>
        <Input placeholder="¿Qué objeto es?" value={name} onChangeText={setName} autoFocus />
        {duplicate ? (
          <View style={styles.dupHint}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.warn} />
            <Text style={styles.dupText} numberOfLines={2}>
              Ya tienes "{duplicate.name}" en {duplicate.containerName ? `${duplicate.roomName} › ${duplicate.containerName}` : duplicate.roomName}
              {duplicate.quantity > 1 ? ` (×${duplicate.quantity})` : ''}. Quizá prefieras subir su cantidad.
            </Text>
          </View>
        ) : null}
      </View>

      <View>
        <Text style={styles.label}>Ubicación</Text>
        <LocationPicker value={location} onChange={setLocation} />
      </View>

      <View style={styles.row}>
        <View style={styles.photoBox}>
          {photoUri ? (
            <>
              <Image source={{ uri: photoUri }} style={styles.photo} contentFit="cover" />
              <Pressable style={styles.photoRemove} onPress={() => setPhotoUri(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={22} color="#fff" />
              </Pressable>
            </>
          ) : (
            <Ionicons name="image-outline" size={28} color={colors.textDim} />
          )}
        </View>
        <View style={{ flex: 1, gap: space(2) }}>
          <Button label="Galería" variant="ghost" onPress={() => addPhoto(false)} />
          {cameraAvailable ? <Button label="Cámara" variant="ghost" onPress={() => addPhoto(true)} /> : null}
        </View>
      </View>

      <View style={styles.inlineRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Cantidad</Text>
          <View style={styles.stepper}>
            <Pressable style={styles.stepBtn} onPress={() => setQuantity((q) => Math.max(1, q - 1))}>
              <Ionicons name="remove" size={20} color={colors.text} />
            </Pressable>
            <Text style={styles.qty}>{quantity}</Text>
            <Pressable style={styles.stepBtn} onPress={() => setQuantity((q) => q + 1)}>
              <Ionicons name="add" size={20} color={colors.text} />
            </Pressable>
          </View>
        </View>
        <View>
          <Text style={styles.label}>Favorito</Text>
          <Pressable
            style={[styles.favBtn, favorite && styles.favBtnOn]}
            onPress={() => setFavorite((f) => !f)}
            accessibilityLabel={favorite ? 'Quitar de favoritos' : 'Marcar como favorito'}
          >
            <Ionicons name={favorite ? 'star' : 'star-outline'} size={22} color={favorite ? colors.warn : colors.textDim} />
          </Pressable>
        </View>
      </View>

      <View>
        <Text style={styles.label}>Etiquetas</Text>
        <View style={styles.tags}>
          {(tagsQ.data ?? []).map((t) => (
            <Chip key={t.id} label={t.name} color={t.color} selected={tagIds.includes(t.id)} onPress={() => toggleTag(t.id)} />
          ))}
          <Chip label="＋ Nueva" onPress={newTag} />
        </View>
      </View>

      <View>
        <Text style={styles.label}>Notas (opcional)</Text>
        <Input placeholder="Detalles…" value={description} onChangeText={setDescription} multiline />
      </View>

      <View style={{ gap: space(2), marginTop: space(2) }}>
        <Button label={busy ? 'Guardando…' : submitLabel} onPress={() => submit(false)} />
        {onSubmitAndAnother ? (
          <Button label="Guardar y añadir otro" variant="ghost" onPress={() => submit(true)} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: space(2) },
  row: { flexDirection: 'row', gap: space(3), alignItems: 'center' },
  inlineRow: { flexDirection: 'row', gap: space(5), alignItems: 'flex-start' },
  dupHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    marginTop: space(2),
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
  },
  dupText: { flex: 1, color: colors.textDim, fontSize: 13 },
  photoBox: {
    width: 90,
    height: 90,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photo: { width: 90, height: 90 },
  photoRemove: { position: 'absolute', top: 2, right: 2, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space(4) },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  favBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  favBtnOn: { borderColor: colors.warn },
  qty: { color: colors.text, fontSize: 18, fontWeight: '700', minWidth: 30, textAlign: 'center' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
});
