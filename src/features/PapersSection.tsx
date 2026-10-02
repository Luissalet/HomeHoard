// «Papeles» y «Manual» del objeto: documentos de Kafka's Hoard vinculados (factura, garantía, manual…), su garantía,
// vincular uno existente, subir uno nuevo y buscar dentro de los manuales con cita de página. Todo pasa por el ordenador
// y el Hoard Hub; cuando no están, se dice por qué.
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useData } from '../db/provider';
import type { ID } from '../db/types';
import { useSyncStatus } from '../db/useSync';
import { colors, radius, space } from '../theme';
import { Button, Input } from '../ui/components';
import { Badge, Segmented } from '../ui/form';
import { useToast } from '../ui/ToastProvider';
import { SheetShell } from './CreateSheets';
import { formatDay } from './dates';
import { warrantyLine } from './ItemCardSection';
import {
  flushLocal, itemPapers, kafkaDocUrl, kafkaSearch, kafkaUpload, manualSearch, OFFLINE_MESSAGE, pickFileBase64, refreshFromServer,
  type KafkaDoc, type ManualHit,
} from './serverApi';

const UPLOAD_KINDS = [
  { key: 'invoice', label: 'Factura' },
  { key: 'receipt', label: 'Ticket' },
  { key: 'warranty', label: 'Garantía' },
  { key: 'manual', label: 'Manual' },
] as const;

function Snippet({ text }: { text: string }) {
  const parts = text.split('**');
  return <Text style={styles.v}>{parts.map((p, i) => <Text key={i} style={i % 2 ? styles.hit : undefined}>{p}</Text>)}</Text>;
}

export function PapersSection({ itemId, itemName }: { itemId: ID; itemName: string }) {
  const data = useData();
  const qc = useQueryClient();
  const toast = useToast();
  const sync = useSyncStatus();
  const connected = sync.base !== null && (sync.mode === 'online' || sync.mode === 'demo');
  const [linking, setLinking] = useState(false);
  const [uploadKind, setUploadKind] = useState<string>('invoice');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ results: ManualHit[]; message?: string | null } | null>(null);
  const details = useQuery({ queryKey: ['details', itemId], queryFn: () => data.getItemDetails(itemId) });
  const linked = details.data?.kafka_doc_ids ?? [];
  const papers = useQuery({
    queryKey: ['papers', itemId, linked.join(',')],
    enabled: connected,
    retry: false,
    queryFn: async () => {
      await flushLocal();
      return itemPapers(itemId);
    },
  });

  async function setLinks(ids: string[]) {
    await data.saveItemDetails(itemId, { kafka_doc_ids: ids });
    await flushLocal();
    await qc.invalidateQueries();
  }

  async function upload() {
    const file = await pickFileBase64();
    if (!file) return;
    setBusy(true);
    try {
      await flushLocal();
      const r = await kafkaUpload(itemId, uploadKind, file.name, file.data);
      if (!r.ok) {
        toast(r.message ?? 'Kafka no ha podido archivarlo');
        return;
      }
      await refreshFromServer();
      await qc.invalidateQueries();
      toast(r.duplicate_of ? 'Kafka ya tenía ese documento: queda vinculado' : 'Archivado en Kafka y vinculado');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se pudo subir');
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    if (query.trim().length < 2) return;
    try {
      await flushLocal();
      const r = await manualSearch(itemId, query.trim());
      setHits({ results: r.results ?? [], message: r.message });
    } catch (e) {
      setHits({ results: [], message: e instanceof Error ? e.message : 'No se pudo buscar' });
    }
  }

  const p = papers.data;
  const kafkaProblem = p && !p.kafka.ok ? p.kafka.message : null;
  const docs = p?.documents ?? [];
  const warranty = p?.kafka_warranty;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Ionicons name="folder-open-outline" size={18} color={colors.accent} />
        <Text style={styles.title}>Papeles</Text>
        <View style={{ flex: 1 }} />
        {linked.length ? <Text style={styles.dim}>{linked.length === 1 ? '1 documento' : `${linked.length} documentos`}</Text> : null}
      </View>
      {!connected ? (
        <Text style={styles.dim}>
          Las facturas, garantías y manuales viven en Kafka's Hoard, en el ordenador. {OFFLINE_MESSAGE}
          {linked.length ? ` Este objeto tiene ${linked.length} vinculados.` : ''}
        </Text>
      ) : (
        <View style={{ gap: space(2) }}>
          {papers.isLoading ? <Text style={styles.dim}>Consultando Kafka…</Text> : null}
          {papers.error ? <Text style={styles.warn}>{(papers.error as Error).message}</Text> : null}
          {kafkaProblem ? <Text style={styles.warn}>{kafkaProblem}</Text> : null}
          {docs.map((d) => (
            <View key={d.id} style={styles.doc}>
              <View style={{ flex: 1 }}>
                <Pressable onPress={() => { void Linking.openURL(kafkaDocUrl(d.id)); }}><Text style={styles.docTitle}>{d.title ?? d.id}</Text></Pressable>
                <Text style={styles.dim}>{[d.kind_label ?? d.kind, d.issuer, d.issue_date ? formatDay(d.issue_date) : null].filter(Boolean).join(' · ')}</Text>
              </View>
              <Pressable accessibilityLabel={`Desvincular ${d.title ?? d.id}`} hitSlop={8} onPress={() => setLinks(linked.filter((x) => x !== d.id))}>
                <Ionicons name="close-circle-outline" size={20} color={colors.textDim} />
              </Pressable>
            </View>
          ))}
          {p?.missing?.length ? <Text style={styles.dim}>{p.missing.length} vinculados ya no están en Kafka.</Text> : null}
          {warranty ? (
            <View style={styles.warranty}>
              <Badge label={warranty.active ? 'En garantía' : 'Garantía terminada'} tone={warranty.active ? 'good' : 'dim'} />
              <Text style={styles.v}>{warrantyLine(warranty.until)?.text}</Text>
              <Text style={styles.dim}>{warranty.basis} {warranty.cite}</Text>
              {details.data?.warranty_until !== warranty.until ? (
                <Pressable onPress={async () => { await data.saveItemDetails(itemId, { warranty_until: warranty.until, warranty_source: 'kafka' }); await qc.invalidateQueries(); toast('Garantía copiada a la ficha'); }}>
                  <Text style={styles.link}>Usar esta fecha en la ficha</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <View style={styles.actions}>
            <Button label="Vincular documento" variant="ghost" onPress={() => setLinking(true)} />
          </View>
          <View style={{ gap: space(2) }}>
            <Segmented options={UPLOAD_KINDS.map((k) => ({ key: k.key as string, label: k.label }))} value={uploadKind} onChange={setUploadKind} />
            <Button label={busy ? 'Subiendo…' : 'Subir factura / manual'} onPress={() => { if (!busy) void upload(); }} />
          </View>

          <View style={styles.sep} />
          <View style={styles.head}>
            <Ionicons name="book-outline" size={18} color={colors.accent} />
            <Text style={styles.title}>Manual</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <Input style={{ flex: 1, minWidth: 0 }} value={query} onChangeText={setQuery} placeholder={`Buscar en el manual de ${itemName}`} accessibilityLabel="Buscar en el manual" onSubmitEditing={search} />
            <Button label="Buscar" variant="ghost" onPress={search} />
          </View>
          {hits?.results.map((h, i) => (
            <View key={`${h.doc_id}-${h.page}-${i}`} style={styles.doc}>
              <View style={{ flex: 1, gap: 2 }}>
                <Snippet text={h.snippet} />
                <Pressable onPress={() => { void Linking.openURL(kafkaDocUrl(h.doc_id, h.page)); }}><Text style={styles.cite}>{h.title} · p. {h.page} {h.cite}</Text></Pressable>
              </View>
            </View>
          ))}
          {hits && !hits.results.length && hits.message ? <Text style={styles.dim}>{hits.message}</Text> : null}
        </View>
      )}
      <LinkSheet visible={linking} onClose={() => setLinking(false)} linked={linked} itemName={itemName} onLink={(doc) => setLinks([...linked, doc.id])} />
    </View>
  );
}

function LinkSheet({ visible, onClose, linked, itemName, onLink }: { visible: boolean; onClose: () => void; linked: string[]; itemName: string; onLink: (d: KafkaDoc) => void }) {
  const [query, setQuery] = useState(itemName);
  const [submitted, setSubmitted] = useState(itemName);
  const q = useQuery({ queryKey: ['kafkaSearch', submitted, visible], enabled: visible, retry: false, queryFn: () => kafkaSearch(submitted) });
  const docs = (q.data?.documents ?? []).filter((d) => !linked.includes(d.id));
  return (
    <SheetShell title="Vincular un documento de Kafka" visible={visible} onClose={onClose}>
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Input style={{ flex: 1, minWidth: 0 }} value={query} onChangeText={setQuery} placeholder="Título, emisor o texto" accessibilityLabel="Buscar en Kafka" onSubmitEditing={() => setSubmitted(query)} />
        <Button label="Buscar" variant="ghost" onPress={() => setSubmitted(query)} />
      </View>
      {q.isLoading ? <Text style={styles.dim}>Buscando en Kafka…</Text> : null}
      {q.error ? <Text style={styles.warn}>{(q.error as Error).message}</Text> : null}
      {q.data && !q.data.ok ? <Text style={styles.warn}>{q.data.message}</Text> : null}
      {docs.map((d) => (
        <Pressable key={d.id} style={styles.doc} accessibilityRole="button" onPress={() => { onLink(d); onClose(); }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.docTitle}>{d.title ?? d.id}</Text>
            <Text style={styles.dim}>{[d.kind_label ?? d.kind, d.issuer, d.issue_date ? formatDay(d.issue_date) : null].filter(Boolean).join(' · ')}</Text>
            {d.snippet ? <Snippet text={d.snippet} /> : null}
          </View>
          <Ionicons name="link-outline" size={20} color={colors.accent} />
        </Pressable>
      ))}
      {q.data?.ok && !docs.length ? <Text style={styles.dim}>Kafka no tiene documentos que encajen.</Text> : null}
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: space(4), gap: space(3) },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  dim: { color: colors.textDim, fontSize: 13 },
  warn: { color: colors.warn, fontSize: 13, fontWeight: '600' },
  doc: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3), borderRadius: radius.md, backgroundColor: colors.surface2 },
  docTitle: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  warranty: { gap: space(1), padding: space(3), borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  actions: { flexDirection: 'row', gap: space(2), flexWrap: 'wrap' },
  link: { color: colors.accent, fontWeight: '700' },
  v: { color: colors.text, fontSize: 14 },
  hit: { fontWeight: '800', backgroundColor: '#F1E3B8' },
  cite: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: space(2) },
});
