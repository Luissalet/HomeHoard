// Piezas pequeñas de formulario y etiquetas de estado usadas por la ficha y el mantenimiento.
import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { colors, radius, space } from '../theme';
import { Input } from './components';

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <View style={{ gap: space(1.5) }}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function TextField({ label, value, onChange, placeholder, hint, error, keyboard, multiline, testID }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  keyboard?: 'default' | 'numeric' | 'decimal-pad' | 'url';
  multiline?: boolean;
  testID?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      <Input
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        keyboardType={keyboard ?? 'default'}
        multiline={multiline}
        accessibilityLabel={label}
        testID={testID}
        style={multiline ? { minHeight: 72, textAlignVertical: 'top' } : undefined}
      />
    </Field>
  );
}

export type Tone = 'danger' | 'warn' | 'good' | 'info' | 'dim';

const TONE: Record<Tone, string> = { danger: colors.danger, warn: colors.warn, good: colors.good, info: colors.accent, dim: colors.textDim };

export function Badge({ label, tone = 'dim', style }: { label: string; tone?: Tone; style?: ViewStyle }) {
  return (
    <View style={[styles.badge, { borderColor: TONE[tone] }, style]}>
      <Text style={[styles.badgeText, { color: TONE[tone] }]}>{label}</Text>
    </View>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: {
  options: { key: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segRow}>
      {options.map((o) => (
        <Pressable key={String(o.key)} accessibilityRole="button" accessibilityState={{ selected: value === o.key }}
          onPress={() => onChange(o.key)} style={[styles.seg, value === o.key && styles.segSel]}>
          <Text style={[styles.segText, value === o.key && styles.segTextSel]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  hint: { color: colors.textDim, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12, fontWeight: '600' },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space(2), paddingVertical: 1, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '700' },
  segRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  seg: { paddingVertical: space(1.5), paddingHorizontal: space(3), borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 },
  segSel: { backgroundColor: colors.accent2, borderColor: colors.accent2 },
  segText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  segTextSel: { color: colors.onAccent },
});
