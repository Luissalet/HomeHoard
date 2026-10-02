import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { colors, radius, space } from '../theme';

export function Card({
  children,
  onPress,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const content = <View style={[styles.card, style]}>{children}</View>;
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Chip({
  label,
  color,
  selected,
  onPress,
}: {
  label: string;
  color?: string | null;
  selected?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        selected && styles.chipSelected,
        color ? { borderColor: color } : null,
      ]}
    >
      {color ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.section}>{children}</Text>;
}

export function EmptyState({ icon = 'cube-outline', title, subtitle }: { icon?: keyof typeof Ionicons.glyphMap; title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={40} color={colors.textDim} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySub}>{subtitle}</Text> : null}
    </View>
  );
}

export function Fab({ onPress, icon = 'add' }: { onPress: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85 }]} accessibilityLabel="Añadir objeto">
      <Ionicons name={icon} size={28} color={colors.onAccent} />
    </Pressable>
  );
}

export function NavRow({
  icon = 'file-tray-outline',
  title,
  subtitle,
  onPress,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.navRow, pressed && { opacity: 0.7 }]}>
      <View style={styles.navIcon}><Ionicons name={icon} size={21} color={colors.accent} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.navTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.navSub}>{subtitle}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
    </Pressable>
  );
}

export function Input(props: TextInputProps) {
  return <TextInput placeholderTextColor={colors.textDim} {...props} style={[styles.input, props.style]} />;
}

export function Button({ label, onPress, variant = 'primary' }: { label: string; onPress: () => void; variant?: 'primary' | 'ghost' | 'danger' }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        variant === 'primary' && styles.btnPrimary,
        variant === 'ghost' && styles.btnGhost,
        variant === 'danger' && styles.btnDanger,
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={[styles.btnText, variant === 'ghost' && { color: colors.text }, variant === 'danger' && { color: colors.onDanger }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space(4),
  },
  pressed: { opacity: 0.7 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    paddingVertical: space(1.5),
    paddingHorizontal: space(3),
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
  },
  chipSelected: { backgroundColor: colors.accent2, borderColor: colors.accent2 },
  chipText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: colors.onAccent },
  dot: { width: 8, height: 8, borderRadius: 4 },
  section: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: space(2) },
  empty: { alignItems: 'center', justifyContent: 'center', padding: space(10), gap: space(2) },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center' },
  fab: {
    position: 'absolute',
    right: space(5),
    bottom: space(6),
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accent2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  input: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    fontSize: 16,
  },
  btn: { paddingVertical: space(3.5), paddingHorizontal: space(5), borderRadius: radius.md, alignItems: 'center' },
  btnPrimary: { backgroundColor: colors.accent2 },
  btnGhost: { backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  btnDanger: { backgroundColor: colors.danger },
  btnText: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(3),
    paddingHorizontal: space(4),
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  navIcon: { width: 38, height: 38, borderRadius: radius.sm, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  navTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  navSub: { color: colors.textDim, fontSize: 13, marginTop: 1 },
});
