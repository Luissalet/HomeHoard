import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useData } from '../../src/db/provider';
import type { MaintenanceWithTarget } from '../../src/db/types';
import { useSyncStatus } from '../../src/db/useSync';
import { todayIso } from '../../src/features/dates';
import { groupOf, type DueGroup } from '../../src/features/maintenanceCore';
import { AddTaskSheet, DoneSheet, EditTaskSheet, GROUP_LABEL, TaskRow } from '../../src/features/MaintenanceSheets';
import { kafkaStatus, runMirror, saveSettings } from '../../src/features/serverApi';
import { colors, radius, space } from '../../src/theme';
import { Button, Card, EmptyState, SectionTitle } from '../../src/ui/components';
import { Segmented } from '../../src/ui/form';
import { useToast } from '../../src/ui/ToastProvider';

type View_ = 'date' | 'place';

export default function MaintenanceScreen() {
  const data = useData();
  const qc = useQueryClient();
  const toast = useToast();
  const sync = useSyncStatus();
  const params = useLocalSearchParams<{ task?: string }>();
  const connected = sync.base !== null && sync.mode !== 'offline' && sync.mode !== 'connecting';
  const [view, setView] = useState<View_>('date');
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<MaintenanceWithTarget | null>(null);
  const [editing, setEditing] = useState<MaintenanceWithTarget | null>(null);
  const q = useQuery({ queryKey: ['maintenance', 'all'], queryFn: () => data.listMaintenance() });
  const mirror = useQuery({ queryKey: ['kafkaStatus', sync.version], enabled: connected, retry: false, queryFn: () => kafkaStatus() });
  const tasks = q.data ?? [];
  const today = todayIso();
  const refresh = () => qc.invalidateQueries();

  useEffect(() => {
    if (params.task && tasks.length) {
      const t = tasks.find((x) => x.id === params.task);
      if (t) setEditing(t);
    }
  }, [params.task, tasks.length]);

  const byGroup = useMemo(() => {
    const out: Record<DueGroup, MaintenanceWithTarget[]> = { overdue: [], month: [], upcoming: [], none: [] };
    for (const t of tasks) out[t.paused ? 'none' : groupOf(t.next_due, today)].push(t);
    return out;
  }, [tasks, today]);
  const byPlace = useMemo(() => {
    const map = new Map<string, MaintenanceWithTarget[]>();
    for (const t of tasks) {
      const key = t.targetPath ?? t.targetName ?? 'Sin sitio';
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'es'));
  }, [tasks]);

  const mirrorOf = (id: string) => {
    const m = mirror.data?.mirror?.tasks?.[id];
    return connected && mirror.data?.mirror?.enabled && m ? { ok: !!m.ok && !m.closed, error: m.error } : null;
  };
  const row = (t: MaintenanceWithTarget) => <TaskRow key={t.id} task={t} mirror={mirrorOf(t.id)} onDone={() => setDone(t)} onEdit={() => setEditing(t)} />;

  async function toggleMirror(value: boolean) {
    try {
      await saveSettings({ kafka_mirror: value });
      await runMirror();
      await mirror.refetch();
      toast(value ? 'Los avisos de mantenimiento irán por Kafka' : 'Avisos por Kafka desactivados');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se pudo cambiar');
    }
  }

  async function retry() {
    try {
      const s = await runMirror();
      await mirror.refetch();
      toast(s.mirror?.pending ? `${s.mirror.pending} pendientes: ${s.kafka.message ?? 'Kafka no responde'}` : 'Avisos enviados a Kafka');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se pudo enviar');
    }
  }

  const st = mirror.data;
  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <View style={styles.summary}>
        <Summary n={byGroup.overdue.length} label="vencidas" tone={colors.danger} />
        <Summary n={byGroup.month.length} label="este mes" tone={colors.warn} />
        <Summary n={byGroup.upcoming.length} label="próximas" tone={colors.textDim} />
      </View>
      <View style={styles.toolbar}>
        <Segmented<View_> options={[{ key: 'date', label: 'Por fecha' }, { key: 'place', label: 'Por sitio' }]} value={view} onChange={setView} />
        <View style={{ flex: 1 }} />
        <Button label="＋ Tarea" onPress={() => setAdding(true)} />
      </View>

      {!tasks.length && !q.isLoading ? (
        <EmptyState icon="construct-outline" title="Sin tareas de mantenimiento"
          subtitle="Añade la revisión de la caldera, purgar radiadores o limpiar filtros. Las plantillas dicen si es obligación legal o recomendación." />
      ) : null}

      {view === 'date'
        ? (['overdue', 'month', 'upcoming', 'none'] as DueGroup[]).filter((g) => byGroup[g].length).map((g) => (
          <View key={g} style={{ gap: space(2) }}>
            <SectionTitle>{g === 'none' ? 'En pausa' : GROUP_LABEL[g]}</SectionTitle>
            {byGroup[g].map(row)}
          </View>
        ))
        : byPlace.map(([place, list]) => (
          <View key={place} style={{ gap: space(2) }}>
            <SectionTitle>{place}</SectionTitle>
            {list.map(row)}
          </View>
        ))}

      <View style={{ gap: space(2) }}>
        <SectionTitle>Avisos</SectionTitle>
        <Card>
          {connected ? (
            <View style={{ gap: space(2) }}>
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>Avisar mediante Kafka</Text>
                  <Text style={styles.dim}>Cada tarea pasa a Kafka's Hoard como plazo con su base legal; Kafka avisa por sus canales (aviso de Windows, ntfy, Telegram, correo).</Text>
                </View>
                <Switch value={st?.settings.kafka_mirror ?? true} onValueChange={toggleMirror} accessibilityLabel="Avisar mediante Kafka" />
              </View>
              {st ? (
                <Text style={styles.dim}>
                  {st.kafka.reachable ? 'Kafka responde.' : st.kafka.message ?? 'Kafka no responde.'}
                  {st.mirror ? ` ${st.mirror.mirrored} en Kafka · ${st.mirror.pending} pendientes.` : ''}
                </Text>
              ) : mirror.error ? <Text style={styles.dim}>{(mirror.error as Error).message}</Text> : null}
              {st?.mirror?.pending ? <Button label="Reintentar ahora" variant="ghost" onPress={retry} /> : null}
            </View>
          ) : (
            <Text style={styles.dim}>Los avisos los envía el ordenador a través de Kafka's Hoard. Abre HomeHoard en el ordenador para verlos y cambiarlos.</Text>
          )}
        </Card>
      </View>

      <AddTaskSheet visible={adding} onClose={() => setAdding(false)} onSaved={refresh} />
      <DoneSheet task={done} onClose={() => setDone(null)} onSaved={refresh} />
      <EditTaskSheet task={editing} onClose={() => setEditing(null)} onSaved={refresh} />
    </ScrollView>
  );
}

function Summary({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileN, { color: tone }]}>{n}</Text>
      <Text style={styles.dim}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  content: { width: '100%', maxWidth: 900, alignSelf: 'center', padding: space(5), paddingBottom: space(16), gap: space(5) },
  summary: { flexDirection: 'row', gap: space(2) },
  tile: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: space(3), alignItems: 'center' },
  tileN: { fontSize: 24, fontWeight: '800' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: space(3), flexWrap: 'wrap' },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  dim: { color: colors.textDim, fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
});
