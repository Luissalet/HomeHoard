// Bloque «Mantenimiento» de la página de un objeto o una habitación: sus tareas, las plantillas sugeridas y alta rápida.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useData } from '../db/provider';
import type { MaintenanceWithTarget } from '../db/types';
import { colors, radius, space } from '../theme';
import { SectionTitle } from '../ui/components';
import { useToast } from '../ui/ToastProvider';
import { BASIS_LABEL, suggestTemplates } from './maintenanceCore';
import { AddTaskSheet, DoneSheet, EditTaskSheet, TaskRow, type MaintenanceTargetRef } from './MaintenanceSheets';
import { CATALOGUE } from './templates';

export function MaintenanceBlock({ target }: { target: MaintenanceTargetRef }) {
  const data = useData();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<MaintenanceWithTarget | null>(null);
  const [editing, setEditing] = useState<MaintenanceWithTarget | null>(null);
  const q = useQuery({ queryKey: ['maintenance', target.kind, target.id], queryFn: () => data.listMaintenance({ target_kind: target.kind, target_id: target.id }) });
  const tasks = q.data ?? [];
  const suggestions = useMemo(() => suggestTemplates(CATALOGUE, target.name, { target: target.kind, roomKind: target.roomKind })
    .filter((t) => !tasks.some((task) => task.template_id === t.id)), [target, tasks]);
  const refresh = () => qc.invalidateQueries();

  async function quickAdd(id: string) {
    const t = CATALOGUE.templates.find((x) => x.id === id)!;
    await data.addMaintenance({
      target_kind: target.kind, target_id: target.id, title: t.title, every_days: t.every_days ?? null, every_months: t.every_months ?? null,
      anchor_month: t.anchor_month ?? null, basis: t.basis, legal_ref: t.legal_ref ?? null, notes: t.note ?? t.maker_note ?? null, template_id: t.id,
    });
    toast(`Tarea añadida: ${t.title}. Si sabes cuándo se hizo por última vez, apúntalo al marcarla hecha.`);
    refresh();
  }

  return (
    <View style={{ gap: space(2) }}>
      <View style={styles.head}>
        <SectionTitle>Mantenimiento</SectionTitle>
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)}><Text style={styles.link}>＋ Tarea</Text></Pressable>
      </View>
      {tasks.map((t) => <TaskRow key={t.id} task={t} showTarget={false} onDone={() => setDone(t)} onEdit={() => setEditing(t)} />)}
      {!tasks.length ? <Text style={styles.dim}>Sin tareas de mantenimiento.</Text> : null}
      {suggestions.length ? (
        <View style={{ gap: space(1.5) }}>
          <Text style={styles.dim}>Sugerencias:</Text>
          <View style={styles.chips}>
            {suggestions.map((t) => (
              <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`Añadir ${t.title}`} style={styles.chip} onPress={() => quickAdd(t.id)}>
                <Text style={styles.chipText}>＋ {t.title}</Text>
                <Text style={styles.chipBasis}>{BASIS_LABEL[t.basis]}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      <AddTaskSheet visible={adding} onClose={() => setAdding(false)} onSaved={refresh} target={target} />
      <DoneSheet task={done} onClose={() => setDone(null)} onSaved={refresh} />
      <EditTaskSheet task={editing} onClose={() => setEditing(null)} onSaved={refresh} />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  link: { color: colors.accent, fontWeight: '700' },
  dim: { color: colors.textDim, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  chip: { paddingVertical: space(1.5), paddingHorizontal: space(3), borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  chipBasis: { color: colors.textDim, fontSize: 11 },
});
