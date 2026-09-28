// Motor de búsqueda compartido (SQLite y memoria). Todo el matching se hace en JS
// sobre los objetos ya decorados: para inventarios personales (miles de filas) es
// instantáneo y nos da lo que LIKE no puede: sin acentos, multi-palabra y relevancia.
import type { ItemWithLocation } from './types';

/** Normaliza para búsqueda: minúsculas y sin diacríticos ("Cajón" → "cajon"). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

interface Indexed {
  item: ItemWithLocation;
  name: string;
  desc: string;
  tags: string[];
  location: string;
}

function index(item: ItemWithLocation): Indexed {
  return {
    item,
    name: normalizeText(item.name),
    desc: normalizeText(item.description ?? ''),
    tags: item.tags.map((t) => normalizeText(t.name)),
    location: normalizeText(`${item.roomName} ${item.containerName ?? ''}`),
  };
}

/** Puntuación de un término contra un objeto indexado. 0 = no coincide. */
function scoreTerm(ix: Indexed, term: string): number {
  let best = 0;
  if (ix.name === term) best = Math.max(best, 100);
  else if (ix.name.startsWith(term)) best = Math.max(best, 80);
  else if (ix.name.split(/\s+/).some((w) => w.startsWith(term))) best = Math.max(best, 70);
  else if (ix.name.includes(term)) best = Math.max(best, 55);
  if (ix.tags.some((t) => t === term)) best = Math.max(best, 50);
  else if (ix.tags.some((t) => t.includes(term))) best = Math.max(best, 40);
  if (ix.desc.includes(term)) best = Math.max(best, 30);
  if (ix.location.includes(term)) best = Math.max(best, 25);
  // Una letra de más o de menos en palabras largas no debería ocultar un objeto.
  if (!best && term.length >= 5 && ix.name.split(/\s+/).some((word) => oneEditApart(word, term))) best = 45;
  return best;
}

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const questionWords = new Set(['donde', 'esta', 'estan', 'tengo', 'guardado', 'guardada', 'guardados', 'guardadas', 'puse', 'deje', 'hay', 'el', 'la', 'los', 'las', 'un', 'una', 'mi', 'mis', 'que', 'en', 'de', 'por', 'favor']);

/**
 * Filtra y ordena por relevancia. Multi-palabra = AND (todas deben coincidir en
 * algún campo). Query vacía → devuelve todo ordenado por nombre.
 */
export function rankSearch(items: ItemWithLocation[], query: string): ItemWithLocation[] {
  const words = normalizeText(query.trim()).replace(/[¿?¡!.,;:]/g, ' ').split(/\s+/).filter(Boolean);
  const terms = words.filter((word) => !questionWords.has(word));
  // Una consulta compuesta solo de palabras comunes no debe devolver todo el inventario.
  if (words.length && !terms.length) return [];
  if (!terms.length) {
    return [...items].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }
  const scored: { it: ItemWithLocation; score: number }[] = [];
  for (const it of items) {
    const ix = index(it);
    let total = 0;
    let ok = true;
    for (const term of terms) {
      const s = scoreTerm(ix, term);
      if (s === 0) {
        ok = false;
        break;
      }
      total += s;
    }
    if (ok) scored.push({ it, score: total });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.it.updated_at - a.it.updated_at ||
      a.it.name.localeCompare(b.it.name, 'es')
  );
  return scored.map((s) => s.it);
}
