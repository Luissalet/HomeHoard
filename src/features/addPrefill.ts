// Alta de un objeto con datos precargados: lo que llega en la dirección `#/add?name=…&source_ref=…&price=…&merchant=…&date=…&room=…&place=…`
// (otro Hoard del hub abre este enlace tras una compra). Sin dependencias de Expo: se prueba en Node.

export interface AddPrefill {
  name: string;
  source_ref: string | null; // hoard://app/tipo/id
  warranty_ref: string | null;
  price: number | null;
  merchant: string | null;
  date: string | null; // YYYY-MM-DD
  room: string | null; // nombre o ruta «Cocina › Cajón rojo»
  place: string | null;
}

type Params = Record<string, string | string[] | undefined>;

const REF = /^hoard:\/\/[a-z0-9_-]+\/[a-z0-9_-]+\/[^\s/]+$/i;
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();

export const fold = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function validDay(text: string): string | null {
  const day = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day ? null : day;
}

/** Los parámetros de la dirección, saneados: lo que no es válido se descarta en vez de fallar. */
export function parseAddParams(params: Params): AddPrefill {
  const num = first(params.price).replace(',', '.');
  const price = num !== '' && Number.isFinite(Number(num)) && Number(num) >= 0 ? Number(num) : null;
  const ref = (key: string) => (REF.test(first(params[key])) ? first(params[key]) : null);
  const text = (key: string, max: number) => first(params[key]).slice(0, max) || null;
  return {
    name: first(params.name).slice(0, 160),
    source_ref: ref('source_ref'),
    warranty_ref: ref('warranty_ref'),
    price,
    merchant: text('merchant', 120),
    date: validDay(first(params.date)),
    room: text('room', 160),
    place: text('place', 160),
  };
}

/** ¿Trae algo para precargar? Sin datos, el alta es la de siempre. */
export const hasPrefill = (p: AddPrefill): boolean => Boolean(p.name || p.source_ref || p.price != null || p.merchant || p.date || p.room || p.place);

/** `#/add?x=1` (la dirección con almohadilla) → `/add?x=1`, o null si no es una alta. */
export function hashToAddPath(hash: string): string | null {
  const m = /^#\/?add(\?.*)?$/.exec(hash.trim());
  return m ? `/add${m[1] ?? ''}` : null;
}

/** El elemento cuyo nombre coincide (exacto sin acentos ni mayúsculas) o, si no, el único que lo contiene. */
export function pickByName<T extends { name: string }>(list: T[], wanted: string): T | null {
  const w = fold(wanted);
  if (!w) return null;
  const exact = list.filter((x) => fold(x.name) === w);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = list.filter((x) => fold(x.name).includes(w));
  return partial.length === 1 ? partial[0] : null;
}

/** «Cocina › Cajón rojo» → ['Cocina', 'Cajón rojo']; admite también «/» y «>». */
export function splitPath(text: string): string[] {
  return text.split(/\s*[›>/]\s*/).map((x) => x.trim()).filter(Boolean);
}

/** Los nombres de habitación y mueble pedidos: `room` puede ser una ruta completa y `place` el mueble (o una ruta). */
export function wantedPlace(p: Pick<AddPrefill, 'room' | 'place'>): { room: string; chain: string[] } | null {
  const roomParts = splitPath(p.room ?? '');
  const placeParts = splitPath(p.place ?? '');
  if (!roomParts.length && !placeParts.length) return null;
  if (!roomParts.length) return { room: placeParts[0], chain: placeParts.slice(1) }; // solo place: se prueba como habitación
  return { room: roomParts[0], chain: [...roomParts.slice(1), ...placeParts] };
}

/** La ficha del objeto que sale de una compra. */
export function purchaseDetails(p: AddPrefill): {
  store?: string; price?: number; purchase_date?: string; source_ref?: string; warranty_ref?: string; kafka_doc_ids?: string[];
} {
  const out: ReturnType<typeof purchaseDetails> = {};
  if (p.merchant) out.store = p.merchant;
  if (p.price != null) out.price = p.price;
  if (p.date) out.purchase_date = p.date;
  if (p.source_ref) out.source_ref = p.source_ref;
  if (p.warranty_ref) {
    out.warranty_ref = p.warranty_ref;
    const doc = /^hoard:\/\/kafka\/document\/(.+)$/.exec(p.warranty_ref);
    if (doc) out.kafka_doc_ids = [doc[1]];
  }
  return out;
}
