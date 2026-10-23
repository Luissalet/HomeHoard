import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileKitSelection} from '../src/features/kitSelection.ts';

const kit = (id, name = id, updated_at = 1) => ({id, name, items: 1, updated_at});

test('selection survives pages and an empty search without losing stored names', () => {
  const selected = [kit('camp', 'Acampada'), kit('snow', 'Nieve')];
  assert.equal(reconcileKitSelection(selected, [kit('other')], false), selected);
  assert.equal(reconcileKitSelection(selected, [], false), selected);
  const updated = reconcileKitSelection(selected, [kit('camp', 'Acampada de verano', 2)], false);
  assert.deepEqual(updated.map(row => row.name), ['Acampada de verano', 'Nieve']);
  assert.equal(reconcileKitSelection(updated, [kit('camp', 'Acampada de verano', 2)], false), updated);
});

test('only a complete unfiltered list proves a selected kit was deleted', () => {
  const selected = [kit('camp'), kit('deleted')];
  assert.equal(reconcileKitSelection(selected, [kit('camp')], false), selected);
  assert.deepEqual(reconcileKitSelection(selected, [kit('camp')], true), [kit('camp')]);
  assert.deepEqual(reconcileKitSelection(selected, [], true), []);
});
