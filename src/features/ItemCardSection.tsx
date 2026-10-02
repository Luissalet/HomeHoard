// «Ficha» del objeto: marca, modelo, número de serie, compra, garantía, manual, consumibles y notas.
// Plegable; sin editar solo enseña lo que está relleno.
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useData } from '../db/provider';
import type { Consumable, ID, ItemDetails } from '../db/types';
import { colors, radius, space } from '../theme';
import { Button, Input } from '../ui/components';
import { Badge, Field, TextField } from '../ui/form';
import { useToast } from '../ui/ToastProvider';
import { formatDay, readDay, relativeDue, todayIso } from './dates';
import { daysBetween } from './maintenanceCore';

type Draft = Record<'brand' | 'model' | 'serial' | 'purchase_date' | 'store' | 'price' | 'warranty_until' | 'manual_url' | 'notes', string>;
const EMPTY: Draft = { brand: '', model: '', serial: '', purchase_date: '', store: '', price: '', warranty_until: '', manual_url: '', notes: '' };

export function warrantyLine(until: string | null | undefined): { text: string; active: boolean } | null {
  if (!until) return null;
  const left = daysBetween(todayIso(), until);
  return left >= 0
    ? { text: `En garantía hasta el ${formatDay(until)} (${relativeDue(until)})`, active: true }
    : { text: `Garantía terminada el ${formatDay(until)}`, active: false };
}

export function ItemCardSection({ itemId }: { itemId: ID }) {
  const data = useData();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['details', itemId], queryFn: () => data.getItemDetails(itemId) });
  const details = q.data ?? null;
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [parts, setParts] = useState<Consumable[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    const d = details;
    setDraft(d ? {
      brand: d.brand ?? '', model: d.model ?? '', serial: d.serial ?? '', purchase_date: d.purchase_date ?? '', store: d.store ?? '',
      price: d.price != null ? String(d.price).replace('.', ',') : '', warranty_until: d.warranty_until ?? '', manual_url: d.manual_url ?? '', notes: d.notes ?? '',
    } : EMPTY);
    setParts(d?.consumables ?? []);
  }, [details, editing]);

  const set = (key: keyof Draft) => (v: string) => setDraft((x) => ({ ...x, [key]: v }));

  async function save() {
    const purchase = readDay(draft.purchase_date);
    const warranty = readDay(draft.warranty_until);
    if (purchase === undefined || warranty === undefined) return setError('Las fechas van como AAAA-MM-DD.');
    const price = draft.price.trim() ? Number(draft.price.replace(',', '.')) : null;
    if (price !== null && (!Number.isFinite(price) || price < 0)) return setError('El precio debe ser un número.');
    for (const p of parts) if (p.last_bought && readDay(p.last_bought) === undefined) return setError(`«${p.name}»: la última compra va como AAAA-MM-DD.`);
    await data.saveItemDetails(itemId, {
      brand: draft.brand, model: draft.model, serial: draft.serial, purchase_date: purchase, store: draft.store, price,
      warranty_until: warranty, ...(warranty !== (details?.warranty_until ?? null) ? { warranty_source: warranty ? 'manual' : null } : {}),
      manual_url: draft.manual_url, notes: draft.notes, consumables: parts,
    });
    setEditing(false);
    setError(null);
    await qc.invalidateQueries();
    toast('Ficha guardada');
  }

  const filled = details && (details.brand || details.model || details.serial || details.purchase_date || details.store || details.price != null
    || details.warranty_until || details.manual_url || details.notes || details.consumables.length);
  const warranty = warrantyLine(details?.warranty_until);

  return (
    <View style={styles.card}>
      <Pressable onPress={() => setOpen(!open)} style={styles.head} accessibilityRole="button" accessibilityLabel="Ficha">
        <Ionicons name="document-text-outline" size={18} color={colors.accent} />
        <Text style={styles.title}>Ficha</Text>
        {warranty ? <Badge label={warranty.active ? 'En garantía' : 'Sin garantía'} tone={warranty.active ? 'good' : 'dim'} /> : null}
        <View style={{ flex: 1 }} />
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textDim} />
      </Pressable>
      {open && !editing ? (
        <View style={{ gap: space(2) }}>
          {filled ? <ReadOnly details={details!} /> : <Text style={styles.dim}>Sin datos todavía: marca, modelo, número de serie, compra, garantía, recambios…</Text>}
          <Button label={filled ? 'Editar ficha' : 'Rellenar ficha'} variant="ghost" onPress={() => setEditing(true)} />
        </View>
      ) : null}
      {open && editing ? (
        <View style={{ gap: space(3) }}>
          <View style={styles.grid}>
            <View style={styles.cell}><TextField label="Marca" value={draft.brand} onChange={set('brand')} /></View>
            <View style={styles.cell}><TextField label="Modelo" value={draft.model} onChange={set('model')} /></View>
            <View style={styles.cell}><TextField label="Nº de serie" value={draft.serial} onChange={set('serial')} /></View>
            <View style={styles.cell}><TextField label="Fecha de compra" value={draft.purchase_date} onChange={set('purchase_date')} placeholder="AAAA-MM-DD" /></View>
            <View style={styles.cell}><TextField label="Tienda" value={draft.store} onChange={set('store')} /></View>
            <View style={styles.cell}><TextField label="Precio (€)" value={draft.price} onChange={set('price')} keyboard="decimal-pad" /></View>
            <View style={styles.cell}><TextField label="Garantía hasta" value={draft.warranty_until} onChange={set('warranty_until')} placeholder="AAAA-MM-DD"
              hint={details?.warranty_source === 'kafka' ? 'Tomada de Kafka.' : undefined} /></View>
            <View style={styles.cell}><TextField label="Manual (enlace)" value={draft.manual_url} onChange={set('manual_url')} keyboard="url" placeholder="https://…" /></View>
          </View>
          <Field label="Consumibles y recambios">
            <View style={{ gap: space(2) }}>
              {parts.map((p, i) => (
                <View key={i} style={styles.partRow}>
                  <Input style={{ flex: 2, minWidth: 140 }} value={p.name} placeholder="Qué (p. ej. filtro campana)" accessibilityLabel="Consumible"
                    onChangeText={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
                  <Input style={{ flex: 1.4, minWidth: 110 }} value={p.spec ?? ''} placeholder="Medida o tipo (3x, CR2032 ×2)" accessibilityLabel="Especificación"
                    onChangeText={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, spec: v } : x)))} />
                  <Input style={{ width: 64 }} value={p.qty != null ? String(p.qty) : ''} placeholder="Uds." keyboardType="numeric" accessibilityLabel="Cantidad"
                    onChangeText={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, qty: v.trim() ? Number(v) || null : null } : x)))} />
                  <Input style={{ width: 120 }} value={p.last_bought ?? ''} placeholder="Comprado AAAA-MM-DD" accessibilityLabel="Última compra"
                    onChangeText={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, last_bought: v || null } : x)))} />
                  <Pressable accessibilityLabel="Quitar consumible" onPress={() => setParts(parts.filter((_, j) => j !== i))} hitSlop={8}>
                    <Ionicons name="close-circle-outline" size={22} color={colors.textDim} />
                  </Pressable>
                </View>
              ))}
              <Pressable onPress={() => setParts([...parts, { name: '', spec: null, qty: null, last_bought: null }])}>
                <Text style={styles.link}>＋ Añadir consumible</Text>
              </Pressable>
            </View>
          </Field>
          <TextField label="Notas" value={draft.notes} onChange={set('notes')} multiline />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button label="Guardar ficha" onPress={save} />
          <Button label="Cancelar" variant="ghost" onPress={() => { setEditing(false); setError(null); }} />
        </View>
      ) : null}
    </View>
  );
}

function ReadOnly({ details }: { details: ItemDetails }) {
  const rows: [string, string | null][] = [
    ['Marca', details.brand], ['Modelo', details.model], ['Nº de serie', details.serial],
    ['Compra', [details.purchase_date ? formatDay(details.purchase_date) : null, details.store].filter(Boolean).join(' · ') || null],
    ['Precio', details.price != null ? `${details.price.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : null],
    ['Garantía', warrantyLine(details.warranty_until)?.text ?? null],
  ];
  return (
    <View style={{ gap: space(1.5) }}>
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <View key={k} style={styles.kv}><Text style={styles.k}>{k}</Text><Text style={styles.v} selectable>{v}</Text></View>
      ))}
      {details.manual_url ? (
        <View style={styles.kv}><Text style={styles.k}>Manual</Text>
          <Pressable onPress={() => { void Linking.openURL(details.manual_url!); }}><Text style={styles.link} numberOfLines={1}>{details.manual_url}</Text></Pressable></View>
      ) : null}
      {details.consumables.length ? (
        <View style={styles.kv}><Text style={styles.k}>Recambios</Text>
          <View style={{ flex: 1, gap: 2 }}>
            {details.consumables.map((c, i) => (
              <Text key={i} style={styles.v}>
                {c.name}{c.spec ? ` · ${c.spec}` : ''}{c.qty != null ? ` · ${c.qty} uds.` : ''}{c.last_bought ? ` · comprado ${formatDay(c.last_bought)}` : ''}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
      {details.notes ? <View style={styles.kv}><Text style={styles.k}>Notas</Text><Text style={styles.v}>{details.notes}</Text></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: space(4), gap: space(3) },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  dim: { color: colors.textDim, fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  cell: { flexGrow: 1, flexBasis: 220 },
  partRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  link: { color: colors.accent, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  kv: { flexDirection: 'row', gap: space(3), alignItems: 'flex-start' },
  k: { color: colors.textDim, fontSize: 13, width: 92 },
  v: { color: colors.text, fontSize: 14, flex: 1 },
});
