// Mantenimiento: fila de tarea, hojas para añadir (plantilla o personalizada), marcar hecho y editar.
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useData } from '../db/provider';
import type { ID, MaintenanceBasis, MaintenanceTarget, MaintenanceWithTarget } from '../db/types';
import { colors, radius, space } from '../theme';
import { Button, Input } from '../ui/components';
import { Badge, Field, Segmented, TextField, type Tone } from '../ui/form';
import { useToast } from '../ui/ToastProvider';
import { SheetShell } from './CreateSheets';
import { formatDay, msFromDay, readDay, relativeDue, todayIso } from './dates';
import { BASIS_LABEL, groupOf, intervalText, MONTHS, suggestTemplates, templateSource, type DueGroup, type MaintenanceTemplate } from './maintenanceCore';
import { CATALOGUE, TEMPLATES } from './templates';

export const GROUP_LABEL: Record<DueGroup, string> = { overdue: 'Vencido', month: 'Este mes', upcoming: 'Próximos', none: 'Sin fecha' };
export const GROUP_TONE: Record<DueGroup, Tone> = { overdue: 'danger', month: 'warn', upcoming: 'dim', none: 'dim' };
export const BASIS_TONE: Record<MaintenanceBasis, Tone> = { law: 'info', maker: 'warn', advice: 'dim' };

export interface MaintenanceTargetRef {
  kind: MaintenanceTarget;
  id: ID;
  name: string;
  roomKind?: string | null;
}

/** Una tarea: título, dónde, cuándo toca, base (ley / fabricante / recomendación) y acciones. */
export function TaskRow({ task, onDone, onEdit, showTarget = true, mirror }: {
  task: MaintenanceWithTarget;
  onDone: () => void;
  onEdit: () => void;
  showTarget?: boolean;
  mirror?: { ok: boolean | null; error: string | null } | null;
}) {
  const group = groupOf(task.next_due, todayIso());
  return (
    <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel={`Tarea ${task.title}`} style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.rowTitle}>{task.title}</Text>
        {showTarget && task.targetPath ? <Text style={styles.dim} numberOfLines={1}>{task.targetPath}</Text> : null}
        <View style={styles.badges}>
          <Badge label={task.paused ? 'En pausa' : `${GROUP_LABEL[group]} · ${formatDay(task.next_due)} (${relativeDue(task.next_due)})`} tone={task.paused ? 'dim' : GROUP_TONE[group]} />
          <Badge label={BASIS_LABEL[task.basis]} tone={BASIS_TONE[task.basis]} />
          <Text style={styles.dim}>{intervalText(task)}</Text>
          {mirror ? <Badge label={mirror.ok ? 'Aviso en Kafka' : 'Pendiente de enviar a Kafka'} tone={mirror.ok ? 'good' : 'warn'} /> : null}
        </View>
        {task.basis === 'law' && task.legal_ref ? <Text style={styles.ref} numberOfLines={2}>{task.legal_ref}</Text> : null}
      </View>
      {!task.paused ? (
        <Pressable onPress={onDone} accessibilityRole="button" accessibilityLabel={`Marcar hecho: ${task.title}`} hitSlop={6} style={styles.doneBtn}>
          <Ionicons name="checkmark" size={16} color="#fff" />
          <Text style={styles.doneText}>Hecho</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------- añadir
type IntervalUnit = 'days' | 'months';

export function AddTaskSheet({ visible, onClose, onSaved, target }: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  target?: MaintenanceTargetRef | null;
}) {
  const data = useData();
  const toast = useToast();
  const [picked, setPicked] = useState<MaintenanceTargetRef | null>(target ?? null);
  const [targetKind, setTargetKind] = useState<MaintenanceTarget>(target?.kind ?? 'item');
  const [query, setQuery] = useState('');
  const [template, setTemplate] = useState<MaintenanceTemplate | null>(null);
  const [custom, setCustom] = useState(false);
  const [title, setTitle] = useState('');
  const [every, setEvery] = useState('12');
  const [unit, setUnit] = useState<IntervalUnit>('months');
  const [anchor, setAnchor] = useState<number | null>(null);
  const [basis, setBasis] = useState<MaintenanceBasis>('advice');
  const [legalRef, setLegalRef] = useState('');
  const [lastDone, setLastDone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPicked(target ?? null);
    setTargetKind(target?.kind ?? 'item');
    setQuery('');
    setTemplate(null);
    setCustom(false);
    setTitle('');
    setEvery('12');
    setUnit('months');
    setAnchor(null);
    setBasis('advice');
    setLegalRef('');
    setLastDone('');
    setNotes('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const choices = useQuery({
    queryKey: ['maintTargets', targetKind, query, visible],
    enabled: visible && !picked,
    queryFn: async (): Promise<MaintenanceTargetRef[]> => {
      if (targetKind === 'item') {
        const items = await data.searchItems(query.trim());
        return items.slice(0, 12).map((i) => ({ kind: 'item', id: i.id, name: i.name }));
      }
      if (targetKind === 'room') {
        const rooms = await data.listAllRooms();
        return rooms.map((r) => ({ kind: 'room', id: r.room.id, name: r.label, roomKind: r.room.kind }));
      }
      const homes = await data.listHomes();
      return homes.map((h) => ({ kind: 'home', id: h.id, name: h.name }));
    },
  });

  const suggested = useMemo(() => (picked ? suggestTemplates(CATALOGUE, picked.name, { target: picked.kind, roomKind: picked.roomKind }) : []), [picked]);
  const others = useMemo(() => TEMPLATES.filter((t) => !suggested.includes(t) && (!picked || t.target_kinds.includes(picked.kind))), [suggested, picked]);

  function chooseTemplate(t: MaintenanceTemplate) {
    setTemplate(t);
    setCustom(false);
    setTitle(t.title);
    setEvery(String(t.every_days ?? t.every_months ?? 12));
    setUnit(t.every_days ? 'days' : 'months');
    setAnchor(t.anchor_month ?? null);
    setBasis(t.basis);
    setLegalRef(t.legal_ref ?? '');
    setNotes(t.note ?? t.maker_note ?? '');
  }

  async function save() {
    if (!picked) return setError('Elige dónde se hace.');
    const n = Number(every);
    if (!title.trim()) return setError('Falta el título.');
    if (!Number.isInteger(n) || n < 1 || n > (unit === 'days' ? 3650 : 240)) return setError('Indica cada cuánto (un número entero).');
    if (basis === 'law' && !legalRef.trim()) return setError('Una obligación legal necesita su norma.');
    const last = readDay(lastDone);
    if (last === undefined) return setError('La última vez debe ser una fecha AAAA-MM-DD.');
    await data.addMaintenance({
      target_kind: picked.kind, target_id: picked.id, title: title.trim(),
      every_days: unit === 'days' ? n : null, every_months: unit === 'months' ? n : null, anchor_month: anchor,
      basis, legal_ref: legalRef.trim() || null, notes: notes.trim() || null, template_id: template?.id ?? null,
      last_done_at: last ? msFromDay(last) : null,
    });
    toast(`Tarea añadida: ${title.trim()}`);
    onSaved();
    onClose();
  }

  const editing = template !== null || custom;

  return (
    <SheetShell title="Nueva tarea de mantenimiento" visible={visible} onClose={onClose}>
      {!picked ? (
        <View style={{ gap: space(3) }}>
          <Segmented<MaintenanceTarget>
            options={[{ key: 'item', label: 'Objeto' }, { key: 'room', label: 'Habitación' }, { key: 'home', label: 'Vivienda' }]}
            value={targetKind}
            onChange={setTargetKind}
          />
          {targetKind === 'item' ? <Input placeholder="Busca el objeto (p. ej. caldera)" value={query} onChangeText={setQuery} accessibilityLabel="Buscar objeto" /> : null}
          {(choices.data ?? []).map((c) => (
            <Pressable key={c.id} style={styles.choice} accessibilityRole="button" onPress={() => setPicked(c)}>
              <Ionicons name={c.kind === 'item' ? 'cube-outline' : c.kind === 'room' ? 'grid-outline' : 'home-outline'} size={18} color={colors.accent} />
              <Text style={styles.rowTitle}>{c.name}</Text>
            </Pressable>
          ))}
          {choices.data && !choices.data.length ? <Text style={styles.dim}>No hay nada con ese nombre.</Text> : null}
        </View>
      ) : (
        <View style={{ gap: space(3) }}>
          <View style={styles.pickedRow}>
            <Text style={styles.dim}>Para</Text>
            <Text style={styles.rowTitle}>{picked.name}</Text>
            {!target ? <Pressable onPress={() => setPicked(null)}><Text style={styles.link}>Cambiar</Text></Pressable> : null}
          </View>
          {!editing ? (
            <View style={{ gap: space(2) }}>
              {suggested.length ? <Text style={styles.section}>Sugeridas para {picked.name}</Text> : null}
              {suggested.map((t) => <TemplateRow key={t.id} t={t} onPress={() => chooseTemplate(t)} />)}
              <Text style={styles.section}>Otras plantillas</Text>
              {others.map((t) => <TemplateRow key={t.id} t={t} onPress={() => chooseTemplate(t)} />)}
              <Button label="Tarea personalizada" variant="ghost" onPress={() => { setCustom(true); setTemplate(null); }} />
              <Text style={styles.dim}>Plantillas revisadas el {formatDay(CATALOGUE.verified)}. Solo las marcadas como obligación legal lo son; el resto son recomendaciones.</Text>
            </View>
          ) : (
            <View style={{ gap: space(3) }}>
              {template ? <Text style={styles.ref}>{templateSource(CATALOGUE, template)}</Text> : null}
              <TextField label="Título" value={title} onChange={setTitle} placeholder="p. ej. Revisar la caldera" />
              <Field label="Cada cuánto">
                <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'center' }}>
                  <Input value={every} onChangeText={setEvery} keyboardType="numeric" style={{ width: 80 }} accessibilityLabel="Intervalo" />
                  <Segmented<IntervalUnit> options={[{ key: 'days', label: 'días' }, { key: 'months', label: 'meses' }]} value={unit} onChange={setUnit} />
                </View>
              </Field>
              <Field label="Mes en el que toca (opcional)">
                <Segmented<number> options={[{ key: 0, label: 'Ninguno' }, ...MONTHS.map((m, i) => ({ key: i + 1, label: m.slice(0, 3) }))]}
                  value={anchor ?? 0} onChange={(v) => setAnchor(v || null)} />
              </Field>
              <Field label="Por qué">
                <Segmented<MaintenanceBasis> options={[{ key: 'advice', label: 'Recomendación' }, { key: 'maker', label: 'Fabricante' }, { key: 'law', label: 'Obligación legal' }]}
                  value={basis} onChange={setBasis} />
              </Field>
              {basis !== 'advice' ? <TextField label={basis === 'law' ? 'Norma' : 'Referencia del fabricante'} value={legalRef} onChange={setLegalRef}
                placeholder={basis === 'law' ? 'p. ej. RITE (RD 1027/2007), IT 3.3' : 'p. ej. manual, página 12'} multiline /> : null}
              <TextField label="Última vez que se hizo (opcional)" value={lastDone} onChange={setLastDone} placeholder="AAAA-MM-DD"
                hint="Si no lo sabes, toca desde hoy." />
              <TextField label="Notas" value={notes} onChange={setNotes} multiline />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button label="Añadir tarea" onPress={save} />
              <Button label="Volver a las plantillas" variant="ghost" onPress={() => { setTemplate(null); setCustom(false); setError(null); }} />
            </View>
          )}
        </View>
      )}
    </SheetShell>
  );
}

function TemplateRow({ t, onPress }: { t: MaintenanceTemplate; onPress: () => void }) {
  return (
    <Pressable style={styles.choice} accessibilityRole="button" accessibilityLabel={`Plantilla ${t.title}`} onPress={onPress}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.rowTitle}>{t.title}</Text>
        <View style={styles.badges}>
          <Badge label={BASIS_LABEL[t.basis]} tone={BASIS_TONE[t.basis]} />
          <Text style={styles.dim}>{intervalText(t)}</Text>
        </View>
        <Text style={styles.ref} numberOfLines={3}>{templateSource(CATALOGUE, t)}</Text>
      </View>
      <Ionicons name="add-circle-outline" size={22} color={colors.accent} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- hecho
export function DoneSheet({ task, onClose, onSaved }: { task: MaintenanceWithTarget | null; onClose: () => void; onSaved: () => void }) {
  const data = useData();
  const toast = useToast();
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  const [cost, setCost] = useState('');
  const [who, setWho] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (task) {
      setDay(todayIso());
      setNote('');
      setCost('');
      setWho('');
      setError(null);
    }
  }, [task]);
  if (!task) return null;
  async function save() {
    const d = readDay(day);
    if (!d) return setError('Indica la fecha AAAA-MM-DD.');
    const c = cost.trim() ? Number(cost.replace(',', '.')) : null;
    if (c !== null && (!Number.isFinite(c) || c < 0)) return setError('El coste debe ser un número.');
    const updated = await data.markMaintenanceDone(task!.id, { done_at: d === todayIso() ? Date.now() : msFromDay(d), note: note.trim() || null, cost: c, who: who.trim() || null });
    toast(`Hecho. Próxima vez: ${formatDay(updated?.next_due)}`);
    onSaved();
    onClose();
  }
  return (
    <SheetShell title={`Hecho: ${task.title}`} visible onClose={onClose}>
      <TextField label="Fecha" value={day} onChange={setDay} placeholder="AAAA-MM-DD" />
      <TextField label="Nota (opcional)" value={note} onChange={setNote} multiline />
      <TextField label="Coste en euros (opcional)" value={cost} onChange={setCost} keyboard="decimal-pad" />
      <TextField label="Quién lo hizo (opcional)" value={who} onChange={setWho} placeholder="p. ej. empresa de mantenimiento" />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Marcar hecho" onPress={save} />
    </SheetShell>
  );
}

// ---------------------------------------------------------------- editar
export function EditTaskSheet({ task, onClose, onSaved }: { task: MaintenanceWithTarget | null; onClose: () => void; onSaved: () => void }) {
  const data = useData();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [every, setEvery] = useState('');
  const [unit, setUnit] = useState<IntervalUnit>('months');
  const [anchor, setAnchor] = useState<number | null>(null);
  const [nextDue, setNextDue] = useState('');
  const [notes, setNotes] = useState('');
  const [basis, setBasis] = useState<MaintenanceBasis>('advice');
  const [legalRef, setLegalRef] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useQuery({ queryKey: ['maintLog', task?.id], enabled: !!task, queryFn: () => data.listMaintenanceLog(task!.id) });
  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setEvery(String(task.every_days ?? task.every_months ?? 12));
    setUnit(task.every_days ? 'days' : 'months');
    setAnchor(task.anchor_month);
    setNextDue(task.next_due_manual ? task.next_due ?? '' : '');
    setNotes(task.notes ?? '');
    setBasis(task.basis);
    setLegalRef(task.legal_ref ?? '');
    setConfirmDelete(false);
    setError(null);
  }, [task]);
  if (!task) return null;
  async function save() {
    const n = Number(every);
    if (!title.trim()) return setError('Falta el título.');
    if (!Number.isInteger(n) || n < 1) return setError('Indica cada cuánto (un número entero).');
    const due = readDay(nextDue);
    if (due === undefined) return setError('La próxima fecha debe ser AAAA-MM-DD o quedar vacía.');
    if (basis === 'law' && !legalRef.trim()) return setError('Una obligación legal necesita su norma.');
    await data.updateMaintenance(task!.id, {
      title, every_days: unit === 'days' ? n : undefined, every_months: unit === 'months' ? n : undefined, anchor_month: anchor,
      next_due: due, notes: notes.trim() || null, basis, legal_ref: legalRef.trim() || null,
    });
    toast('Tarea guardada');
    onSaved();
    onClose();
  }
  async function togglePause() {
    await data.updateMaintenance(task!.id, { paused: !task!.paused });
    toast(task!.paused ? 'Tarea reanudada' : 'Tarea en pausa: no se avisa');
    onSaved();
    onClose();
  }
  return (
    <SheetShell title="Editar tarea" visible onClose={onClose}>
      {task.targetPath ? <Text style={styles.dim}>{task.targetPath}</Text> : null}
      <TextField label="Título" value={title} onChange={setTitle} />
      <Field label="Cada cuánto">
        <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'center' }}>
          <Input value={every} onChangeText={setEvery} keyboardType="numeric" style={{ width: 80 }} accessibilityLabel="Intervalo" />
          <Segmented<IntervalUnit> options={[{ key: 'days', label: 'días' }, { key: 'months', label: 'meses' }]} value={unit} onChange={setUnit} />
        </View>
      </Field>
      <Field label="Mes en el que toca">
        <Segmented<number> options={[{ key: 0, label: 'Ninguno' }, ...MONTHS.map((m, i) => ({ key: i + 1, label: m.slice(0, 3) }))]}
          value={anchor ?? 0} onChange={(v) => setAnchor(v || null)} />
      </Field>
      <TextField label="Próxima fecha fijada a mano" value={nextDue} onChange={setNextDue} placeholder="AAAA-MM-DD"
        hint={`Vacía: se calcula (ahora ${formatDay(task.next_due)}).`} />
      <Field label="Por qué">
        <Segmented<MaintenanceBasis> options={[{ key: 'advice', label: 'Recomendación' }, { key: 'maker', label: 'Fabricante' }, { key: 'law', label: 'Obligación legal' }]}
          value={basis} onChange={setBasis} />
      </Field>
      {basis !== 'advice' ? <TextField label={basis === 'law' ? 'Norma' : 'Referencia del fabricante'} value={legalRef} onChange={setLegalRef} multiline /> : null}
      <TextField label="Notas" value={notes} onChange={setNotes} multiline />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Guardar" onPress={save} />
      <Button label={task.paused ? 'Reanudar' : 'Pausar (sin avisos)'} variant="ghost" onPress={togglePause} />
      <Text style={styles.section}>Historial</Text>
      {(log.data ?? []).length ? (log.data ?? []).map((l) => (
        <Text key={l.id} style={styles.dim}>
          {formatDay(todayIso(l.done_at))}{l.who ? ` · ${l.who}` : ''}{l.cost != null ? ` · ${l.cost.toLocaleString('es-ES')} €` : ''}{l.note ? ` · ${l.note}` : ''}
        </Text>
      )) : <Text style={styles.dim}>Aún no se ha marcado como hecha.</Text>}
      {confirmDelete ? (
        <View style={{ gap: space(2) }}>
          <Text style={styles.warn}>Se borra la tarea y deja de avisarse. ¿Seguro?</Text>
          <Button label="Sí, borrar tarea" variant="danger" onPress={async () => { await data.deleteMaintenance(task.id); toast('Tarea borrada'); onSaved(); onClose(); }} />
        </View>
      ) : (
        <Button label="Borrar tarea" variant="ghost" onPress={() => setConfirmDelete(true)} />
      )}
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3), backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  dim: { color: colors.textDim, fontSize: 12 },
  ref: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5), alignItems: 'center' },
  doneBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.accent2, paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: radius.pill },
  doneText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3), borderRadius: radius.md, backgroundColor: colors.surface2 },
  pickedRow: { flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap' },
  link: { color: colors.accent, fontWeight: '700' },
  section: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space(2) },
  error: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  warn: { color: colors.text, fontSize: 14, textAlign: 'center' },
});
