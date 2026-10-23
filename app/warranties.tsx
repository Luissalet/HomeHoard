import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSyncStatus } from '../src/db/useSync';
import { LocationPicker, type LocationValue } from '../src/features/LocationPicker';
import { listWarranties, type WarrantyQuery, type WarrantyStatus } from '../src/features/warranties';
import { colors, fonts, radius, space } from '../src/theme';
import { Input } from '../src/ui/components';
import { Field } from '../src/ui/form';

const STATES: {key: WarrantyStatus; label: string}[] = [
  {key: 'expiring', label: 'Caducan pronto'}, {key: 'active', label: 'Activas'},
  {key: 'expired', label: 'Vencidas'}, {key: 'unknown', label: 'Sin fecha'}, {key: 'all', label: 'Todas'},
];
const EVERYWHERE: LocationValue = {roomId: null, containerId: null, label: ''};
const PAGE_SIZE = 20;

function Action({label, onPress, disabled, primary}: {label: string; onPress: () => void; disabled?: boolean; primary?: boolean}) {
  return <Pressable accessibilityRole="button" accessibilityState={{disabled: !!disabled}} disabled={disabled}
    onPress={onPress} style={({pressed}) => [styles.action, primary && styles.primary, disabled && {opacity: 0.5}, pressed && {opacity: 0.75}]}>
    <Text style={[styles.actionText, primary && {color: colors.onAccent}]}>{label}</Text>
  </Pressable>;
}

export default function WarrantiesScreen() {
  const router = useRouter();
  const sync = useSyncStatus();
  const connected = sync.mode === 'online';
  const [status, setStatus] = useState<WarrantyStatus>('expiring');
  const [days, setDays] = useState('90');
  const [asOf, setAsOf] = useState('');
  const [location, setLocation] = useState(EVERYWHERE);
  const [appliedLocation, setAppliedLocation] = useState('Todas las ubicaciones');
  const [query, setQuery] = useState<WarrantyQuery>({status: 'expiring', days: 90, offset: 0, limit: PAGE_SIZE});
  const result = useQuery({queryKey: ['warranties', query, sync.version], enabled: connected,
    queryFn: () => listWarranties(query)});
  const page = connected ? result.data : undefined;

  function apply() {
    setAppliedLocation(location.roomId ? location.label : 'Todas las ubicaciones');
    setQuery({status, days: days.trim() ? Number(days) : 90, offset: 0, limit: PAGE_SIZE,
      ...(asOf.trim() ? {as_of: asOf.trim()} : {}),
      ...(location.roomId ? {location: location.containerId || location.roomId} : {})});
  }

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
    <View style={styles.intro}>
      <Text accessibilityRole="header" style={styles.title}>Garantías registradas</Text>
      <Text style={styles.help}>Consulta las fechas anotadas en las fichas de tus objetos. Una fecha ausente no indica que el objeto carezca de garantía.</Text>
    </View>
    {!connected && <Text accessibilityLiveRegion="polite" style={styles.notice}>Conecta con HomeHoard en el ordenador para consultar las garantías registradas. Esta vista no calcula fechas sobre el inventario local ni la casa de ejemplo.</Text>}
    <View style={styles.filters}>
      <Field label="Estado">
        <View style={styles.actions}>{STATES.map(option => <Pressable key={option.key} accessibilityRole="button"
          accessibilityState={{selected: option.key === status}} onPress={() => setStatus(option.key)}
          style={[styles.action, option.key === status && styles.primary]}>
          <Text style={[styles.actionText, option.key === status && {color: colors.onAccent}]}>{option.label}</Text>
        </Pressable>)}</View>
      </Field>
      <View style={styles.fields}>
        <View style={styles.field}><Field label="Horizonte de caducidad (días)" hint="Incluye la fecha de referencia y los siguientes días. Solo filtra «Caducan pronto».">
          <Input accessibilityLabel="Horizonte de caducidad en días" value={days} onChangeText={setDays} keyboardType="numeric" placeholder="90"/>
        </Field></View>
        <View style={styles.field}><Field label="Fecha de referencia" hint="AAAA-MM-DD. Vacía: fecha actual del ordenador.">
          <Input accessibilityLabel="Fecha de referencia" value={asOf} onChangeText={setAsOf} placeholder="AAAA-MM-DD" autoCapitalize="none"/>
        </Field></View>
      </View>
      <Field label="Ubicación" hint="La habitación incluye todos sus muebles; un mueble incluye los que contiene.">
        <LocationPicker value={location} onChange={setLocation} roomOptionLabel="Toda la habitación"/>
        <View style={styles.actions}><Text style={styles.help}>{location.roomId ? location.label : 'Todas las ubicaciones'}</Text>
          {location.roomId && <Action label="Quitar ubicación" onPress={() => setLocation(EVERYWHERE)}/>}</View>
      </Field>
      <View style={styles.actions}><Action label="Aplicar filtros" onPress={apply} primary disabled={!connected || result.isFetching}/>
        <Action label="Actualizar" onPress={() => {void result.refetch();}} disabled={!connected || result.isFetching}/></View>
    </View>
    {connected && result.isFetching && <View style={styles.actions}><ActivityIndicator color={colors.accent}/><Text style={styles.help}>Consultando las fichas registradas…</Text></View>}
    {connected && result.error && <View accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{result.error.message}</Text>
      <Text style={styles.help}>Revisa los filtros y vuelve a aplicarlos, o pulsa Actualizar para reintentar la consulta.</Text></View>}
    {page && !result.error && <View style={styles.results}>
      <View style={styles.resultHeading}><Text accessibilityRole="header" style={styles.section}>{STATES.find(option => option.key === page.status)?.label}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.count}>{page.matched} {page.matched === 1 ? 'objeto' : 'objetos'}</Text></View>
      <Text style={styles.help}>Referencia: {page.as_of}{page.status === 'expiring' ? ` · Hasta ${page.window_end}, inclusive (${page.days} días)` : ''}</Text>
      <Text style={styles.help}>{appliedLocation} · {page.checked_items} {page.checked_items === 1 ? 'objeto revisado' : 'objetos revisados'} · {page.unknown_dates} sin fecha válida registrada.</Text>
      <Text style={styles.help}>Fechas y procedencia guardadas en HomeHoard. No se ha consultado Kafka ni inferido un plazo legal.</Text>
      {!page.items.length && <View style={styles.empty}><Ionicons name="calendar-outline" size={28} color={colors.textDim}/>
        <Text style={styles.itemName}>No hay objetos que coincidan con estos filtros.</Text><Text style={styles.help}>Prueba Todas o Sin fecha para revisar el resto de fichas.</Text></View>}
      <View>{page.items.map(item => <View key={item.item_id} style={styles.row}>
        <View style={styles.itemHeading}><Pressable accessibilityRole="link" accessibilityLabel={`Abrir ficha de ${item.name}`} onPress={() => router.push(`/item/${item.item_id}`)} style={styles.itemLink}>
          <Text style={styles.itemName}>{item.name}</Text><Ionicons name="chevron-forward" size={18} color={colors.accent}/></Pressable>
          <Text style={[styles.state, {color: item.status === 'expired' ? colors.danger : item.status === 'unknown' ? colors.textDim : colors.good}]}>
            {item.status === 'expired' ? 'Fecha vencida' : item.status === 'unknown' ? 'Sin fecha válida' : 'Fecha activa'}</Text></View>
        <Text style={styles.location}>{item.location}</Text>
        {[item.brand, item.model].filter(Boolean).length > 0 && <Text style={styles.help}>{[item.brand, item.model].filter(Boolean).join(' · ')}</Text>}
        <Text style={styles.date}>{item.warranty_until ? `Hasta ${item.warranty_until}` : 'Fecha de fin no registrada o no válida'}{item.days_left !== null ? ` · ${item.days_left < 0 ? `${-item.days_left} ${item.days_left === -1 ? 'día después' : 'días después'} del vencimiento` : `${item.days_left} ${item.days_left === 1 ? 'día restante' : 'días restantes'}`}` : ''}</Text>
        <Text style={styles.help}>Origen de la fecha: {item.source === 'manual' ? 'anotada a mano' : item.source === 'kafka' ? 'Kafka (registro local)' : item.source || 'sin procedencia de fecha registrada'}</Text>
        {item.warranty_ref && <Text selectable style={styles.reference}>Referencia registrada: {item.warranty_ref}</Text>}
      </View>)}</View>
      {page.matched > 0 && <View style={styles.actions}>
        <Action label="Anterior" onPress={() => setQuery({...query, offset: Math.max(0, query.offset - PAGE_SIZE)})} disabled={query.offset === 0 || result.isFetching}/>
        <Text style={styles.help}>{query.offset + 1}–{query.offset + page.items.length} de {page.matched}</Text>
        <Action label="Siguiente" onPress={() => setQuery({...query, offset: page.next_offset!})} disabled={page.next_offset === null || result.isFetching}/>
      </View>}
    </View>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  content: {width: '100%', maxWidth: 1040, alignSelf: 'center', padding: space(5), paddingBottom: space(12), gap: space(7)},
  intro: {gap: space(3)}, title: {fontFamily: fonts.serif, color: colors.text, fontSize: 30, fontWeight: '700'},
  help: {color: colors.textDim, fontSize: 14, lineHeight: 21},
  notice: {color: colors.text, backgroundColor: colors.banner, padding: space(4), borderRadius: radius.md, lineHeight: 22},
  filters: {gap: space(5)}, fields: {flexDirection: 'row', flexWrap: 'wrap', gap: space(5)}, field: {flexGrow: 1, flexBasis: 260},
  actions: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(3)},
  action: {minHeight: 48, justifyContent: 'center', paddingHorizontal: space(4), paddingVertical: space(3), borderRadius: radius.md, backgroundColor: colors.surface2},
  primary: {backgroundColor: colors.accent2}, actionText: {color: colors.text, fontWeight: '700', fontSize: 14},
  results: {gap: space(3)}, resultHeading: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: space(3)},
  section: {fontFamily: fonts.serif, fontSize: 24, color: colors.text, fontWeight: '700'}, count: {color: colors.textDim, fontSize: 14},
  row: {paddingVertical: space(5), borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: space(2)},
  itemHeading: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(3)},
  itemLink: {flexDirection: 'row', gap: space(2), alignItems: 'center', minHeight: 48, flexGrow: 1, flexShrink: 1},
  itemName: {fontSize: 17, color: colors.accent, fontWeight: '700', flexShrink: 1}, state: {fontWeight: '700', fontSize: 13},
  location: {color: colors.text, fontSize: 14, lineHeight: 21}, date: {color: colors.text, fontSize: 15, lineHeight: 23},
  reference: {color: colors.textDim, fontSize: 13, lineHeight: 20}, empty: {gap: space(3), paddingVertical: space(7)},
  error: {gap: space(2)}, errorText: {color: colors.danger, fontWeight: '700', fontSize: 15},
});
