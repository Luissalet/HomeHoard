import type { Item } from './types';

const seedNames = ['Pasaporte', 'Bufanda azul', 'Zapatillas running', 'Cargador de móvil', 'Silla plegable', 'Mando de la TV', 'Tomate frito', 'Vajilla buena', 'Botiquín'];

export function hasExampleItems(items: Pick<Item, 'name' | 'deleted_at'>[]): boolean {
  const active = items.filter((item) => item.deleted_at == null);
  return seedNames.every((name) => active.some((item) => item.name === name));
}

export function onlyExampleItems(items: Pick<Item, 'name' | 'deleted_at'>[]): boolean {
  return items.filter((item) => item.deleted_at == null).length === seedNames.length && hasExampleItems(items);
}
