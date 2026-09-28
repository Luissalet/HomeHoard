import assert from 'node:assert/strict';
import test from 'node:test';
import { rankSearch } from '../src/db/searchUtil.ts';

const items = [
  { id: 'torch', name: 'Linterna Philips', description: null, roomName: 'Trastero', containerName: 'Caja roja', tags: [], updated_at: 1 },
  { id: 'lamp', name: 'Lámpara', description: null, roomName: 'Salón', containerName: null, tags: [], updated_at: 2 },
];

test('a natural question with a misspelled brand finds the object', () => {
  assert.deepEqual(rankSearch(items, '¿Dónde tengo guardada la linterna phillips?').map((item) => item.id), ['torch']);
});

test('common words alone do not display the entire inventory', () => {
  assert.deepEqual(rankSearch(items, '¿Dónde está?'), []);
});
