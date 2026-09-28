import assert from 'node:assert/strict';
import test from 'node:test';
import { hasExampleItems, onlyExampleItems } from '../src/db/demo.ts';

const names = ['Pasaporte', 'Bufanda azul', 'Zapatillas running', 'Cargador de móvil', 'Silla plegable', 'Mando de la TV', 'Tomate frito', 'Vajilla buena', 'Botiquín'];
const example = names.map((name) => ({ name, deleted_at: null }));

test('an untouched example can be replaced; mixed data cannot be cleared as example', () => {
  assert.equal(onlyExampleItems(example), true);
  assert.equal(hasExampleItems([...example, { name: 'Linterna real', deleted_at: null }]), true);
  assert.equal(onlyExampleItems([...example, { name: 'Linterna real', deleted_at: null }]), false);
});
