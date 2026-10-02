// Reglas del mantenimiento: próxima fecha, grupos (vencido / este mes / próximos), texto del intervalo y
// sugerencias de plantillas. Puras (la fecha de hoy se pasa siempre); las mismas que
// bridge/homehoard_server/maintenance.py, comprobadas con tests/maintenance-cases.json en los dos lados.

export type Basis = 'law' | 'maker' | 'advice';

export interface MaintenanceTemplate {
  id: string;
  title: string;
  target_kinds: string[];
  match: string[];
  room_kinds?: string[];
  every_days?: number | null;
  every_months?: number | null;
  anchor_month?: number | null;
  basis: Basis;
  rule?: string;
  legal_ref?: string;
  maker_note?: string;
  note?: string;
  remind?: number[];
}

export interface TemplateCatalogue {
  verified: string;
  advice_source: string;
  templates: MaintenanceTemplate[];
}

export interface DueInput {
  every_days?: number | null;
  every_months?: number | null;
  anchor_month?: number | null;
  last_done_at?: number | null;
  created_at?: number | null;
  next_due?: string | null;
  next_due_manual?: number | boolean | null;
}

export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const BASIS_LABEL: Record<Basis, string> = { law: 'Obligación legal', maker: 'Fabricante', advice: 'Recomendación' };

export function fold(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Fechas como días locales "YYYY-MM-DD"; nada de husos horarios.
interface Day { y: number; m: number; d: number }
const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (day: Day): string => `${day.y}-${pad(day.m)}-${pad(day.d)}`;
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

export function parseDay(value: unknown): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (day.m < 1 || day.m > 12 || day.d < 1 || day.d > daysIn(day.y, day.m)) return null;
  return day;
}

export function dayOfMs(msValue: number): Day {
  const d = new Date(msValue);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

export const todayIso = (nowMs: number = Date.now()): string => isoDay(dayOfMs(nowMs));

const ordinal = (day: Day) => Date.UTC(day.y, day.m - 1, day.d) / 86400000;
const fromOrdinal = (n: number): Day => {
  const d = new Date(n * 86400000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

export function addMonths(day: Day, months: number): Day {
  const total = day.m - 1 + months;
  const y = day.y + Math.floor(total / 12);
  const m = (((total % 12) + 12) % 12) + 1;
  return { y, m, d: Math.min(day.d, daysIn(y, m)) };
}

export const addDays = (day: Day, days: number): Day => fromOrdinal(ordinal(day) + days);
export const daysBetween = (a: string, b: string): number => {
  const x = parseDay(a);
  const y = parseDay(b);
  return x && y ? ordinal(y) - ordinal(x) : 0;
};

function step(base: Day, task: DueInput): Day {
  if (task.every_days) return addDays(base, Number(task.every_days));
  return addMonths(base, Number(task.every_months || 12));
}

/**
 * Próxima fecha (YYYY-MM-DD). Una fecha puesta a mano gana; si no, la última vez más el intervalo, llevada a la
 * aparición más cercana del mes ancla si lo hay. Nunca hecha: desde el día en que se creó.
 */
export function computeNextDue(task: DueInput, nowMs: number = Date.now()): string {
  const manual = parseDay(task.next_due);
  if (task.next_due_manual && manual) return isoDay(manual);
  const last = task.last_done_at != null ? dayOfMs(Number(task.last_done_at)) : null;
  const created = dayOfMs(task.created_at != null ? Number(task.created_at) : nowMs);
  const anchor = task.anchor_month ? Number(task.anchor_month) : null;
  if (anchor) {
    if (!last) {
      if (created.m === anchor) return isoDay(created);
      return isoDay({ y: created.m < anchor ? created.y : created.y + 1, m: anchor, d: 1 });
    }
    const target = step(last, task);
    const options = [target.y - 1, target.y, target.y + 1]
      .map((y) => ({ y, m: anchor, d: 1 }))
      .filter((d) => ordinal(d) > ordinal(last));
    options.sort((a, b) => Math.abs(ordinal(a) - ordinal(target)) - Math.abs(ordinal(b) - ordinal(target)) || ordinal(a) - ordinal(b));
    return isoDay(options[0]);
  }
  if (!last) return isoDay(created);
  return isoDay(step(last, task));
}

export type DueGroup = 'overdue' | 'month' | 'upcoming' | 'none';

/** vencido / este mes (hasta fin de mes) / próximos. */
export function groupOf(nextDue: string | null | undefined, today: string): DueGroup {
  const day = parseDay(nextDue);
  const now = parseDay(today);
  if (!day || !now) return 'none';
  if (ordinal(day) < ordinal(now)) return 'overdue';
  const end = { y: now.y, m: now.m, d: daysIn(now.y, now.m) };
  return ordinal(day) <= ordinal(end) ? 'month' : 'upcoming';
}

export function intervalText(task: DueInput): string {
  let text: string;
  if (task.every_days) {
    const n = Number(task.every_days);
    text = n === 1 ? 'cada día' : `cada ${n} días`;
  } else {
    const n = Number(task.every_months || 12);
    text = n === 1 ? 'cada mes' : n === 12 ? 'cada año' : n % 12 === 0 ? `cada ${n / 12} años` : `cada ${n} meses`;
  }
  if (task.anchor_month) text += `, en ${MONTHS[Number(task.anchor_month) - 1]}`;
  return text;
}

const words = (text: string) => ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `;

/** Plantillas cuyas palabras aparecen en el nombre o tipo de algo; en una habitación, también las de su tipo. */
export function suggestTemplates(
  catalogue: TemplateCatalogue,
  name: string,
  opts: { kind?: string | null; target?: string; roomKind?: string | null } = {}
): MaintenanceTemplate[] {
  const target = opts.target ?? 'item';
  const hay = words(`${name} ${opts.kind ?? ''}`);
  return catalogue.templates.filter((t) => {
    if (!t.target_kinds.includes(target)) return false;
    if (t.match.some((m) => words(m).trim() && hay.includes(words(m)))) return true;
    return target === 'room' && !!opts.roomKind && (t.room_kinds ?? []).includes(opts.roomKind);
  });
}

export function templateSource(catalogue: TemplateCatalogue, t: MaintenanceTemplate): string {
  return t.basis === 'law' ? t.legal_ref ?? '' : catalogue.advice_source;
}
