// Sheets de creación/edición de habitaciones y muebles: nombre + tipo (con
// icono) + color en un solo paso, en lugar de un prompt de texto plano.
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '../theme';
import { Button, Input } from '../ui/components';
import { CONTAINER_KINDS, containerLineIcon, ROOM_COLORS, ROOM_KINDS, roomLineIcon } from '../ui/kinds';

export interface RoomDraft {
  name: string;
  kind: string | null;
  color: string;
}

export interface ContainerDraft {
  name: string;
  kind: string | null;
}

export function SheetShell({
  title,
  visible,
  onClose,
  children,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.head}>
              <Text style={styles.title}>{title}</Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textDim} />
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space(4) }}>
              {children}
            </ScrollView>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

export function RoomSheet({
  visible,
  onClose,
  onSubmit,
  title = 'Nueva habitación',
  submitLabel = 'Crear',
  initial,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (draft: RoomDraft) => void | Promise<void>;
  title?: string;
  submitLabel?: string;
  initial?: Partial<RoomDraft>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<string | null>(initial?.kind ?? null);
  const [color, setColor] = useState(initial?.color ?? ROOM_COLORS[0]);

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setKind(initial?.kind ?? null);
      setColor(initial?.color ?? ROOM_COLORS[Math.floor(Math.random() * ROOM_COLORS.length)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    <SheetShell title={title} visible={visible} onClose={onClose}>
      <Input placeholder="Nombre (p. ej. Despacho)" value={name} onChangeText={setName} autoFocus />

      <View>
        <Text style={styles.label}>Tipo</Text>
        <View style={styles.kindGrid}>
          {ROOM_KINDS.map((k) => (
            <Pressable
              key={k.key}
              style={[styles.kindBtn, kind === k.key && styles.kindBtnSel]}
              onPress={() => setKind(kind === k.key ? null : k.key)}
            >
              <Ionicons name={roomLineIcon(k.key)} size={18} color={colors.accent} />
              <Text style={[styles.kindLabel, kind === k.key && { color: colors.text }]}>{k.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View>
        <Text style={styles.label}>Color</Text>
        <View style={styles.colors}>
          {ROOM_COLORS.map((c) => (
            <Pressable key={c} style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchSel]} onPress={() => setColor(c)} />
          ))}
        </View>
      </View>

      <Button
        label={submitLabel}
        onPress={async () => {
          if (!name.trim()) return;
          await onSubmit({ name: name.trim(), kind, color });
          onClose();
        }}
      />
    </SheetShell>
  );
}

export function ContainerSheet({
  visible,
  onClose,
  onSubmit,
  title = 'Nuevo mueble',
  submitLabel = 'Crear',
  initial,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (draft: ContainerDraft) => void | Promise<void>;
  title?: string;
  submitLabel?: string;
  initial?: Partial<ContainerDraft>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<string | null>(initial?.kind ?? null);

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setKind(initial?.kind ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    <SheetShell title={title} visible={visible} onClose={onClose}>
      <Input placeholder="Nombre (p. ej. Cómoda)" value={name} onChangeText={setName} autoFocus />

      <View>
        <Text style={styles.label}>Tipo</Text>
        <View style={styles.kindGrid}>
          {CONTAINER_KINDS.map((k) => (
            <Pressable
              key={k.key}
              style={[styles.kindBtn, kind === k.key && styles.kindBtnSel]}
              onPress={() => setKind(kind === k.key ? null : k.key)}
            >
              <Ionicons name={containerLineIcon(k.key)} size={18} color={colors.accent} />
              <Text style={[styles.kindLabel, kind === k.key && { color: colors.text }]}>{k.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Button
        label={submitLabel}
        onPress={async () => {
          if (!name.trim()) return;
          await onSubmit({ name: name.trim(), kind });
          onClose();
        }}
      />
    </SheetShell>
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
    maxHeight: 560,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  label: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: space(2) },
  kindGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  kindBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    paddingVertical: space(2),
    paddingHorizontal: space(3),
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
  },
  kindBtnSel: { borderColor: colors.accent, backgroundColor: withAlphaHex(colors.accent, 0.15) },
  kindLabel: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  colors: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: 'transparent' },
  swatchSel: { borderColor: '#fff' },
});

function withAlphaHex(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
