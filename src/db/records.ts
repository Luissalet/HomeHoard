// Registros y copias: lo que comparten la web, el móvil y el ordenador. Mismas reglas que
// bridge/homehoard_server/bundle.py y store.py (ganador por updated_at; en empate gana la lápida).
// Sin dependencias de Expo: se prueba en Node.

export const LEGACY_TABLES = ['households', 'homes', 'floors', 'rooms', 'containers', 'items', 'tags', 'itemTags'] as const;
export const NEW_TABLES = ['item_details', 'maintenance_tasks', 'maintenance_log', 'packing_kits'] as const;
export const TABLES = [...LEGACY_TABLES, ...NEW_TABLES] as const;
export type TableName = (typeof TABLES)[number];

export type AnyRecord = { id: string; updated_at: number; deleted_at: number | null; [key: string]: unknown };
export type Tables = Record<TableName, AnyRecord[]>;

const JSON_FIELDS: Partial<Record<TableName, string[]>> = { item_details: ['kafka_doc_ids', 'consumables'], packing_kits: ['requests'] };

export const linkId = (itemId: string, tagId: string): string => `${itemId}:${tagId}`;

export function emptyTables(): Tables {
  return Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as Tables;
}

const ms = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : null;
};

/** Un registro listo para combinar, o null si no puede serlo. */
export function normalizeRecord(table: TableName, row: unknown, fallbackTs = 0): AnyRecord | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const rec: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  if (table === 'itemTags') {
    if (!rec.item_id || !rec.tag_id) return null;
    rec.id = linkId(String(rec.item_id), String(rec.tag_id));
  } else if (table === 'item_details') {
    rec.id = String(rec.id || rec.item_id || '');
    rec.item_id = rec.id;
  }
  if (typeof rec.id !== 'string' || !rec.id || rec.id.length > 200) return null;
  rec.updated_at = ms(rec.updated_at) ?? Math.trunc(fallbackTs || 0);
  rec.deleted_at = ms(rec.deleted_at);
  if (rec.created_at !== undefined && rec.created_at !== null) rec.created_at = ms(rec.created_at);
  for (const field of JSON_FIELDS[table] ?? []) {
    let value = rec[field];
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value || '[]');
      } catch {
        value = [];
      }
    }
    rec[field] = Array.isArray(value) ? value : [];
  }
  if (table === 'packing_kits') {
    const requests = rec.requests as Record<string, unknown>[];
    if (typeof rec.name !== 'string' || !rec.name.trim() || requests.length < 1 || requests.length > 100) return null;
    if (requests.some((r) => !r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join(',') !== 'item_id,quantity' ||
      typeof r.item_id !== 'string' || !r.item_id.trim() || !Number.isSafeInteger(r.quantity) || Number(r.quantity) < 1)) return null;
  }
  return rec as AnyRecord;
}

/** ¿Gana `incoming` a `current`? El más reciente; en empate, una lápida a un registro vivo. */
export function wins(incoming: AnyRecord, current: AnyRecord): boolean {
  const a = Number(incoming.updated_at || 0);
  const b = Number(current.updated_at || 0);
  if (a !== b) return a > b;
  return incoming.deleted_at != null && current.deleted_at == null;
}

/** Combina `incoming` en `target` (mutándolo). Devuelve cuántos registros han cambiado. */
export function mergeInto(target: Tables, incoming: Partial<Record<string, unknown[]>>): number {
  let changed = 0;
  for (const table of TABLES) {
    const rows = incoming[table];
    if (!Array.isArray(rows) || !rows.length) continue;
    const list = target[table];
    const index = new Map(list.map((r, i) => [r.id, i]));
    for (const row of rows) {
      const rec = normalizeRecord(table, row);
      if (!rec) continue;
      const at = index.get(rec.id);
      if (at === undefined) {
        index.set(rec.id, list.length);
        list.push(rec);
        changed += 1;
      } else if (wins(rec, list[at])) {
        if (table === 'maintenance_tasks' && list[at].kafka_deadline_id && !rec.kafka_deadline_id) rec.kafka_deadline_id = list[at].kafka_deadline_id;
        list[at] = rec;
        changed += 1;
      } else if (sameVersion(rec, list[at]) && adoptsServerField(table, rec, list[at])) {
        changed += 1;
      }
    }
  }
  return changed;
}

const sameVersion = (a: AnyRecord, b: AnyRecord) => Number(a.updated_at || 0) === Number(b.updated_at || 0);

/**
 * Campos que el ordenador rellena sin cambiar `updated_at`: la foto guardada como archivo (en lugar del data: URL
 * que envió el navegador) y el id del plazo en Kafka. Se adoptan sin que el registro cuente como más nuevo.
 */
function adoptsServerField(table: TableName, incoming: AnyRecord, current: AnyRecord): boolean {
  if (table === 'items' && typeof incoming.photo_uri === 'string' && incoming.photo_uri.includes('/photos/') &&
      typeof current.photo_uri === 'string' && current.photo_uri.startsWith('data:')) {
    current.photo_uri = incoming.photo_uri;
    return true;
  }
  if (table === 'maintenance_tasks' && incoming.kafka_deadline_id && incoming.kafka_deadline_id !== current.kafka_deadline_id) {
    current.kafka_deadline_id = incoming.kafka_deadline_id;
    return true;
  }
  return false;
}

export interface BundleLike {
  format?: unknown;
  version?: unknown;
  exported_at?: unknown;
  photos?: unknown;
  data?: unknown;
}

/**
 * Registros de una copia de cualquier versión (1, 2, 3 o 4). En las versiones 1 y 2 los vínculos de etiquetas no tenían
 * id, fecha ni lápida: cada vínculo toma la fecha de su objeto.
 */
export function recordsFromBundle(bundle: BundleLike): { tables: Tables; photos: Record<string, string>; exportedAt: number } {
  if (!bundle || bundle.format !== 'homehoard-export' || ![1, 2, 3, 4].includes(Number(bundle.version))) {
    throw new Error('El archivo no es una copia de HomeHoard');
  }
  const data = bundle.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object' || LEGACY_TABLES.some((t) => !Array.isArray(data[t]))) {
    throw new Error('La copia no contiene un inventario válido');
  }
  if (Number(bundle.version) === 4 && !Array.isArray(data.packing_kits)) {
    throw new Error('La copia versión 4 no contiene la tabla de kits; no se ha restaurado');
  }
  const exportedAt = ms(bundle.exported_at) ?? 0;
  const itemTimes = new Map<string, number>();
  for (const it of data.items as Record<string, unknown>[]) itemTimes.set(String(it.id), ms(it.updated_at) ?? exportedAt);
  const tables = emptyTables();
  for (const table of TABLES) {
    const rows = data[table];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error('La copia contiene registros inválidos');
    for (const row of rows) {
      const fallback = table === 'itemTags' ? itemTimes.get(String((row as Record<string, unknown>)?.item_id)) ?? exportedAt : exportedAt;
      const rec = normalizeRecord(table, row, fallback);
      if (!rec && table === 'packing_kits') throw new Error('La copia contiene un kit inválido; no se ha restaurado');
      if (rec) tables[table].push(rec);
    }
  }
  const photos: Record<string, string> = {};
  if (bundle.photos && typeof bundle.photos === 'object') {
    for (const [k, v] of Object.entries(bundle.photos as Record<string, unknown>)) if (typeof v === 'string') photos[k] = v;
  }
  return { tables, photos, exportedAt };
}

export const recordKey = (table: TableName, id: string): string => `${table}/${id}`;
