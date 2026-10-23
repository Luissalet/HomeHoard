import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useData } from '../src/db/provider';
import { normalizeText, rankSearch } from '../src/db/searchUtil';
import { useSyncStatus } from '../src/db/useSync';
import { checkKits, checkPacking, deleteKit, getKit, listKits, saveKit, type PackingCheck } from '../src/features/packingKits';
import { colors, fonts, radius, space } from '../src/theme';
import { Input } from '../src/ui/components';
import { Field } from '../src/ui/form';
import { useToast } from '../src/ui/ToastProvider';

type RequestRow = {item_id: string; quantity: string};

function Action({label, onPress, disabled, primary, danger}: {
  label: string; onPress: () => void; disabled?: boolean; primary?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} aria-disabled={!!disabled}
    disabled={disabled} onPress={onPress} style={({pressed}) => [styles.action, primary && styles.primary,
      disabled && {opacity: 0.5}, pressed && {opacity: 0.75}]}>
    <Text style={[styles.actionText, primary && {color: colors.onAccent}, danger && {color: colors.danger}]}>{label}</Text>
  </Pressable>;
}

export default function KitsScreen() {
  const data = useData(), router = useRouter(), qc = useQueryClient(), toast = useToast();
  const sync = useSyncStatus(), {width} = useWindowDimensions();
  const connected = sync.mode === 'online';
  const kits = useQuery({queryKey: ['packingKits', sync.version], enabled: connected, queryFn: listKits});
  const inventory = useQuery({queryKey: ['kitInventory'], queryFn: () => data.searchItems('')});
  const [kitId, setKitId] = useState<string | null>(null);
  const [name, setName] = useState(''), [notes, setNotes] = useState(''), [search, setSearch] = useState('');
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [combining, setCombining] = useState(false), [selectedKits, setSelectedKits] = useState<string[]>([]);
  const [check, setCheck] = useState<PackingCheck | null>(null);
  const [collected, setCollected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const [checkTop, setCheckTop] = useState(0);
  useEffect(() => {
    if (!kits.data) return;
    const visible = new Set(kits.data.kits.map(kit => kit.id));
    const retained = selectedKits.filter(id => visible.has(id));
    if (retained.length !== selectedKits.length) {
      setSelectedKits(retained); setCheck(null); setCollected({});
    }
  }, [kits.data, selectedKits]);
  useEffect(() => {if (check && checkTop) scroll.current?.scrollTo({y: Math.max(0, checkTop - 12), animated: false});}, [check, checkTop]);
  const items = inventory.data || [];
  const itemById = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const matches = useMemo(() => rankSearch(items, search).filter(item => !requests.some(row => row.item_id === item.id)), [items, search, requests]);
  const gathered = check?.items.reduce((sum, item) => sum + (collected[item.item_id] ? item.to_pack || 0 : 0), 0) || 0;
  const clearCheck = () => {setCheck(null); setCollected({});};

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo completar la operación.'); }
    finally { setBusy(false); }
  }
  function startNew() {
    setCombining(false);
    setSelectedKits([]);
    setKitId(null); setName(''); setNotes(''); setRequests([]); setSearch(''); setError(''); setConfirmDelete(false); clearCheck();
    scroll.current?.scrollTo({y: 0, animated: false});
  }
  const load = (id: string) => run(async () => {
    const result = await getKit(id);
    setKitId(result.kit.id); setName(result.kit.name); setNotes(result.kit.notes || '');
    setRequests(result.kit.requests.map(row => ({item_id: row.item_id, quantity: String(row.quantity)})));
    setSearch(''); setConfirmDelete(false); clearCheck();
  });
  function updateRequests(rows: RequestRow[]) {setRequests(rows); clearCheck();}
  const requestValues = () => requests.map(row => ({item_id: row.item_id, quantity: Number(row.quantity)}));
  const save = () => run(async () => {
    const result = await saveKit(name.trim(), notes, requestValues(), kitId || undefined);
    setKitId(result.kit.id); setName(result.kit.name);
    setRequests(result.kit.requests.map(row => ({item_id: row.item_id, quantity: String(row.quantity)})));
    await qc.invalidateQueries({queryKey: ['packingKits']});
    toast(result.status === 'unchanged' ? 'El kit ya estaba guardado' : 'Kit guardado');
  });
  const inspect = () => run(async () => {setCheck(await checkPacking(requestValues())); setCollected({});});
  const inspectKits = () => run(async () => {clearCheck(); setCheck(await checkKits(selectedKits));});
  function toggleKit(id: string) {
    setSelectedKits(selectedKits.includes(id) ? selectedKits.filter(value => value !== id) : [...selectedKits, id]);
    clearCheck(); setError('');
  }
  const remove = () => run(async () => {
    await deleteKit(kitId!); startNew(); await qc.invalidateQueries({queryKey: ['packingKits']}); toast('Kit borrado');
  });
  const editable = connected && !busy;

  return <ScrollView ref={scroll} style={styles.screen} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <View style={styles.heading}>
      <View style={{flex: 1}}><Text accessibilityRole="header" style={styles.title}>Kits y equipo</Text>
        <Text style={styles.help}>Guarda una lista para un viaje, una reparación o una actividad y encuentra cada objeto antes de salir.</Text></View>
      <Action label="Nuevo kit" onPress={startNew} disabled={busy}/>
    </View>
    {!connected && <Text style={styles.notice}>Los kits se guardan en el ordenador. Abre HomeHoard conectado para crear listas y comprobar sus existencias. Tu inventario local sigue disponible.</Text>}
    {error && !combining ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {busy && <View style={styles.busy}><ActivityIndicator color={colors.accent}/><Text style={styles.help}>Procesando la lista…</Text></View>}
    <View style={[styles.columns, width >= 850 && styles.wide]}>
      <View style={[styles.saved, width >= 850 && {width: 245}]}>
        <Text accessibilityRole="header" style={styles.section}>Kits guardados</Text>
        <Action label={combining ? 'Volver al editor' : 'Combinar kits'} disabled={!editable || !kits.data?.kits.length}
          onPress={() => {setCombining(!combining); clearCheck(); setError('');}}/>
        {kits.isLoading && <Text style={styles.help}>Cargando kits…</Text>}
        {kits.error && <Text style={styles.error}>{kits.error.message}</Text>}
        {connected && !kits.isLoading && !kits.error && !kits.data?.kits.length && <Text style={styles.help}>Aún no hay kits. Elige los objetos y guarda tu primera lista.</Text>}
        {kits.data?.kits.map(kit => <Pressable key={kit.id} accessibilityRole={combining ? 'checkbox' : 'button'}
          accessibilityLabel={combining ? `Incluir ${kit.name}` : undefined}
          {...(combining ? {'aria-checked': selectedKits.includes(kit.id)} : {'aria-selected': kit.id === kitId})} aria-disabled={!editable}
          disabled={!editable} onPress={() => combining ? toggleKit(kit.id) : load(kit.id)} style={[styles.kitRow, (combining ? selectedKits.includes(kit.id) : kit.id === kitId) && styles.selectedKit]}>
          <Ionicons name={combining ? selectedKits.includes(kit.id) ? 'checkbox' : 'square-outline' : 'bag-handle-outline'} color={(combining ? selectedKits.includes(kit.id) : kit.id === kitId) ? colors.accent : colors.textDim} size={20}/>
          <View style={{flex: 1}}><Text style={styles.itemName}>{kit.name}</Text><Text style={styles.help}>{kit.items} {kit.items === 1 ? 'tipo' : 'tipos'} de objeto</Text></View>
        </Pressable>)}
        {kits.data && kits.data.total > kits.data.kits.length && <Text style={styles.help}>Se muestran {kits.data.kits.length} de {kits.data.total} kits. Puedes acceder al resto desde Faustus.</Text>}
      </View>
      {combining ? <View style={styles.editor}>
        <Text accessibilityRole="header" style={styles.section}>Preparar varios kits</Text>
        <Text style={styles.help}>Selecciona los kits que necesitas a la vez. Los objetos compartidos se suman y se comparan con las mismas existencias.</Text>
        <Text accessibilityLiveRegion="polite" style={styles.itemName}>Kits seleccionados: {selectedKits.length}</Text>
        {!selectedKits.length && <Text style={styles.help}>Marca al menos un kit de la lista para comprobar el conjunto.</Text>}
        {kits.data?.kits.filter(kit => selectedKits.includes(kit.id)).map(kit => <Text key={kit.id} style={styles.help}>{kit.name}</Text>)}
        <View style={styles.actions}><Action label="Comprobar selección" primary onPress={inspectKits} disabled={!editable || !selectedKits.length}/></View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Text style={styles.help}>Se usan las versiones guardadas de los kits. Tu borrador del editor se conserva al volver. Esta consulta no reserva ni descuenta objetos.</Text>
      </View> : <View style={styles.editor} testID={`packing-kit-${kitId || 'new'}`}>
        <Text accessibilityRole="header" style={styles.section}>{kitId ? 'Editar kit' : 'Preparar un kit'}</Text>
        <Field label="Nombre del kit"><Input accessibilityLabel="Nombre del kit" value={name} onChangeText={setName} editable={editable} maxLength={160} placeholder="Por ejemplo: equipo de fin de semana"/></Field>
        <Field label="Notas"><Input accessibilityLabel="Notas del kit" value={notes} onChangeText={setNotes} editable={editable} multiline placeholder="Recordatorios para preparar este equipo" style={{minHeight: 65}}/></Field>
        <View style={styles.sectionHeading}><Text accessibilityRole="header" style={styles.section}>Objetos y cantidades</Text><Text style={styles.help}>{requests.length} {requests.length === 1 ? 'tipo' : 'tipos'} de objeto</Text></View>
        {!requests.length && <Text style={styles.help}>Busca un objeto de tu inventario y añádelo a la lista.</Text>}
        {requests.map(row => {
          const item = itemById.get(row.item_id);
          return <View key={row.item_id} style={styles.requestRow}>
            <View style={{flex: 1, minWidth: 90}}><Text style={styles.itemName}>{item?.name || `Objeto no disponible: ${row.item_id}`}</Text>
              <Text style={styles.help}>{item ? [item.roomName, item.containerName].filter(Boolean).join(' › ') : 'Se conserva su referencia para que puedas corregir el kit.'}</Text></View>
            <Input accessibilityLabel={`Cantidad de ${item?.name || row.item_id}`} keyboardType="numeric" value={row.quantity} editable={editable} style={styles.quantity}
              onChangeText={quantity => updateRequests(requests.map(value => value.item_id === row.item_id ? {...value, quantity} : value))}/>
            <Pressable accessibilityRole="button" accessibilityLabel={`Quitar ${item?.name || row.item_id}`} disabled={!editable}
              onPress={() => updateRequests(requests.filter(value => value.item_id !== row.item_id))} style={styles.iconButton}><Ionicons name="close-outline" size={22} color={colors.textDim}/></Pressable>
          </View>;
        })}
        <Field label="Añadir objetos del inventario"><Input accessibilityLabel="Buscar objetos para el kit" value={search} onChangeText={setSearch} editable={editable} placeholder="Nombre, etiqueta o ubicación"/></Field>
        {inventory.error && <Text style={styles.error}>{inventory.error.message}</Text>}
        {matches.slice(0, 8).map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Añadir ${item.name}`} disabled={!editable}
          onPress={() => {updateRequests([...requests, {item_id: item.id, quantity: '1'}]); setSearch('');}} style={styles.searchRow}>
          <Ionicons name="add-outline" size={22} color={colors.accent}/><View style={{flex: 1}}><Text style={styles.itemName}>{item.name}</Text>
            <Text style={styles.help}>{[item.roomName, item.containerName].filter(Boolean).join(' › ')} · {item.quantity} registrados</Text></View>
        </Pressable>)}
        {inventory.isLoading && <Text style={styles.help}>Cargando objetos…</Text>}
        {!inventory.isLoading && !inventory.error && !matches.length && <Text style={styles.help}>{normalizeText(search).trim() ? 'No hay más objetos que coincidan con la búsqueda.' : 'Todos los objetos disponibles están incluidos.'}</Text>}
        {matches.length > 8 && <Text style={styles.help}>Mostrando 8 de {matches.length}. Escribe para encontrar un objeto concreto.</Text>}
        <View style={styles.actions}>
          <Action label="Guardar kit" onPress={save} primary disabled={!editable || !name.trim() || !requests.length}/>
          <Action label="Comprobar existencias" onPress={inspect} disabled={!editable || !requests.length}/>
          {kitId && <Action label={confirmDelete ? 'Confirmar borrado' : 'Borrar kit'} danger disabled={!editable} onPress={() => confirmDelete ? remove() : setConfirmDelete(true)}/>}
          {confirmDelete && <Action label="Cancelar borrado" onPress={() => setConfirmDelete(false)} disabled={busy}/>}
        </View>
      </View>}
    </View>
    {check && <View style={styles.check} onLayout={event => setCheckTop(event.nativeEvent.layout.y)}>
      <Text accessibilityRole="header" style={styles.section}>Lista de recogida</Text>
      {check.kits && <Text style={styles.help}>Conjunto de {check.kits.length} {check.kits.length === 1 ? 'kit' : 'kits'}: {check.kits.map(kit => kit.name).join(' · ')}</Text>}
      <Text style={[styles.verdict, {color: check.ready ? colors.good : colors.warn}]}>
        {!check.totals_complete ? 'El inventario no permite confirmar todas las cantidades.' : check.ready ? `Hay existencias suficientes para ${check.kits ? 'la selección' : 'el kit'}.` : `Falta${check.missing_total === 1 ? '' : 'n'} ${check.missing_total} unidad${check.missing_total === 1 ? '' : 'es'} para completar ${check.kits ? 'la selección' : 'el kit'}.`}
      </Text>
      <Text style={styles.help}>Comprobación del inventario · versión {check.inventory_version}. Las marcas de recogida son temporales y no mueven ni descuentan objetos. Una nueva comprobación reinicia las marcas.</Text>
      <Text accessibilityLiveRegion="polite" style={styles.progress}>{check.totals_complete ? `${gathered} de ${check.to_pack_total} unidades recogidas` : `${gathered} unidades verificadas recogidas; el total sigue incompleto`}</Text>
      {check.items.map(item => <View key={item.item_id} style={styles.packingRow}>
        <Pressable testID={`collected-${item.item_id}`} accessibilityRole="checkbox" accessibilityLabel={`Recoger ${item.to_pack || 0} de ${item.name || item.item_id}`}
          aria-checked={!!collected[item.item_id]} aria-disabled={!item.to_pack} disabled={!item.to_pack}
          onPress={() => setCollected({...collected, [item.item_id]: !collected[item.item_id]})} style={styles.iconButton}>
          <Ionicons name={collected[item.item_id] ? 'checkbox' : 'square-outline'} size={25} color={collected[item.item_id] ? colors.good : colors.textDim}/>
        </Pressable>
        <View style={{flex: 1}}><Text style={styles.itemName}>{item.name || `Objeto no disponible: ${item.item_id}`}</Text><Text style={styles.location}>{item.location || 'Ubicación no disponible'}</Text>
          <Text style={styles.help}>Necesitas {item.requested} · Registrados {item.available ?? 'sin dato'} · Puedes recoger {item.to_pack ?? 'sin dato'} · Faltan {item.missing ?? 'sin dato'}</Text>
          {item.kits?.map(kit => <Text key={kit.id} style={styles.help}>{kit.name}: {kit.quantity} {kit.quantity === 1 ? 'unidad' : 'unidades'}</Text>)}</View>
        {item.status !== 'not_found' && <Action label="Ver objeto" onPress={() => router.push(`/item/${item.item_id}`)}/>}
      </View>)}
    </View>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  content: {width: '100%', maxWidth: 1100, alignSelf: 'center', padding: space(5), paddingBottom: space(14), gap: space(5)},
  heading: {flexDirection: 'row', alignItems: 'flex-start', gap: space(4)},
  title: {fontFamily: fonts.serif, fontSize: 30, fontWeight: '700', color: colors.text, marginBottom: space(2)},
  help: {fontSize: 13, lineHeight: 19, color: colors.textDim},
  notice: {fontSize: 14, lineHeight: 21, color: colors.warn},
  error: {fontSize: 14, lineHeight: 21, color: colors.danger},
  busy: {flexDirection: 'row', gap: space(3), alignItems: 'center'},
  columns: {gap: space(6)}, wide: {flexDirection: 'row', alignItems: 'flex-start'},
  saved: {gap: space(2)}, editor: {flex: 1, gap: space(4), minWidth: 0},
  section: {fontFamily: fonts.serif, color: colors.text, fontSize: 20, fontWeight: '700'},
  sectionHeading: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space(2), alignItems: 'center', marginTop: space(2)},
  kitRow: {flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3), minHeight: 52, borderRadius: radius.sm},
  selectedKit: {backgroundColor: colors.surface2},
  itemName: {fontSize: 14, lineHeight: 21, fontWeight: '600', color: colors.text},
  requestRow: {flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(2), borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border},
  quantity: {width: 68, minHeight: 44, textAlign: 'center'},
  iconButton: {minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center'},
  searchRow: {flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingVertical: space(2), gap: space(3), borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: space(3), marginTop: space(2)},
  action: {minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: space(3), backgroundColor: colors.surface2},
  primary: {backgroundColor: colors.accent, borderColor: colors.accent},
  actionText: {color: colors.text, fontWeight: '600', fontSize: 13},
  check: {marginTop: space(3), paddingTop: space(5), gap: space(3), borderTopWidth: 1, borderColor: colors.border},
  verdict: {fontSize: 16, lineHeight: 23, fontWeight: '600'},
  progress: {fontSize: 15, color: colors.text, fontWeight: '600', marginVertical: space(2)},
  packingRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(3), paddingVertical: space(3), borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border},
  location: {fontSize: 14, color: colors.accent, lineHeight: 22},
});
