import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Tag } from '../db/types';
import { colors, radius, space } from '../theme';

export function ItemRow({
  title,
  subtitle,
  quantity,
  tags,
  photoUri,
  favorite,
  onPress,
  onLongPress,
  onMore,
}: {
  title: string;
  subtitle?: string | null;
  quantity?: number;
  tags?: Tag[];
  photoUri?: string | null;
  favorite?: boolean;
  onPress?: () => void;
  /** Long-press: normalmente abre las acciones rápidas. */
  onLongPress?: () => void;
  /** Botón "⋯" visible: acciones rápidas sin descubrir el long-press. */
  onMore?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.thumb}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.img} contentFit="cover" />
        ) : (
          <Ionicons name="cube-outline" size={22} color={colors.textDim} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.titleRow}>
          {favorite ? <Ionicons name="star" size={13} color={colors.warn} /> : null}
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {quantity && quantity > 1 ? <Text style={styles.qty}>×{quantity}</Text> : null}
        </View>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {tags && tags.length ? (
          <View style={styles.tags}>
            {tags.map((t) => (
              <View key={t.id} style={styles.tagChip}>
                {t.color ? <View style={[styles.dot, { backgroundColor: t.color }]} /> : null}
                <Text style={styles.tagText}>{t.name}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      {onMore ? (
        <Pressable onPress={onMore} hitSlop={10} style={styles.more}>
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textDim} />
        </Pressable>
      ) : (
        <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
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
  thumb: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  img: { width: 44, height: 44 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  title: { color: colors.text, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  qty: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  subtitle: { color: colors.textDim, fontSize: 13, marginTop: 1 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5), marginTop: space(1.5) },
  tagChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface2, borderRadius: radius.pill, paddingHorizontal: space(2), paddingVertical: 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  tagText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
  more: { padding: space(1) },
});
