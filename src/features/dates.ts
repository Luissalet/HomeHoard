// Fechas para mostrar (castellano) y para escribir a mano (AAAA-MM-DD).
import { daysBetween, parseDay, todayIso } from './maintenanceCore';

const SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

export function formatDay(value: string | null | undefined): string {
  const d = parseDay(value);
  return d ? `${d.d} ${SHORT[d.m - 1]} ${d.y}` : '—';
}

export function relativeDue(value: string | null | undefined, today = todayIso()): string {
  if (!parseDay(value)) return 'sin fecha';
  const n = daysBetween(today, String(value));
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n === -1) return 'ayer';
  return n > 0 ? `en ${n} días` : `hace ${-n} días`;
}

/** Valida lo escrito a mano: '' → null; fecha correcta → AAAA-MM-DD; si no, undefined (error). */
export function readDay(text: string): string | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const d = parseDay(t);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
}

export function msFromDay(day: string): number {
  const d = parseDay(day)!;
  return new Date(d.y, d.m - 1, d.d, 12, 0).getTime();
}

export { todayIso };
