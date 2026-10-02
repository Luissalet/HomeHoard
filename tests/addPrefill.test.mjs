import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPrefill, hashToAddPath, parseAddParams, pickByName, purchaseDetails, splitPath, wantedPlace } from '../src/features/addPrefill.ts';

test('the address parameters become a clean prefill', () => {
  const p = parseAddParams({ name: ' Aspiradora Demo ', source_ref: 'hoard://hub/purchase/12', price: '129,90', merchant: 'Tienda Demo', date: '2026-09-28T10:00:00', room: 'Cocina', place: 'Cajón rojo' });
  assert.deepEqual(p, { name: 'Aspiradora Demo', source_ref: 'hoard://hub/purchase/12', warranty_ref: null, price: 129.9, merchant: 'Tienda Demo', date: '2026-09-28', room: 'Cocina', place: 'Cajón rojo' });
  assert.equal(hasPrefill(p), true);
});

test('invalid values are dropped instead of breaking the form', () => {
  const p = parseAddParams({ name: 'X', source_ref: 'https://example.com/x', price: 'mucho', date: '2026-02-31', warranty_ref: 'd_1' });
  assert.deepEqual([p.source_ref, p.price, p.date, p.warranty_ref], [null, null, null, null]);
  assert.equal(parseAddParams({ price: '-4' }).price, null);
  assert.equal(parseAddParams({ price: '0' }).price, 0);
  assert.equal(hasPrefill(parseAddParams({})), false);
  assert.equal(parseAddParams({ name: ['A', 'B'] }).name, 'A');
});

test('the hash address maps to the route', () => {
  assert.equal(hashToAddPath('#/add?name=Lampara&price=20'), '/add?name=Lampara&price=20');
  assert.equal(hashToAddPath('#add'), '/add');
  assert.equal(hashToAddPath('#/add'), '/add');
  assert.equal(hashToAddPath('#/item/1'), null);
  assert.equal(hashToAddPath(''), null);
});

test('rooms and furniture are found by name without accents or case', () => {
  const rooms = [{ name: 'Cocina' }, { name: 'Baño' }, { name: 'Baño de invitados' }];
  assert.equal(pickByName(rooms, 'cocina').name, 'Cocina');
  assert.equal(pickByName(rooms, 'bano').name, 'Baño');
  assert.equal(pickByName(rooms, 'invitados').name, 'Baño de invitados');
  assert.equal(pickByName(rooms, 'ba'), null, 'two partial matches: no guess');
  assert.equal(pickByName(rooms, 'garaje'), null);
  assert.equal(pickByName(rooms, ''), null);
});

test('room and place combine into a path', () => {
  assert.deepEqual(splitPath('Cocina › Cajón rojo'), ['Cocina', 'Cajón rojo']);
  assert.deepEqual(wantedPlace({ room: 'Cocina', place: 'Cajón rojo' }), { room: 'Cocina', chain: ['Cajón rojo'] });
  assert.deepEqual(wantedPlace({ room: 'Trastero › Estantería', place: 'Caja roja' }), { room: 'Trastero', chain: ['Estantería', 'Caja roja'] });
  assert.deepEqual(wantedPlace({ room: null, place: 'Salón' }), { room: 'Salón', chain: [] });
  assert.equal(wantedPlace({ room: null, place: null }), null);
});

test('the appliance card of a purchase carries origin, shop, price and paper', () => {
  const card = purchaseDetails(parseAddParams({ name: 'X', source_ref: 'hoard://hub/purchase/3', price: '10', merchant: 'Tienda', date: '2026-01-02', warranty_ref: 'hoard://kafka/document/d_9' }));
  assert.deepEqual(card, { store: 'Tienda', price: 10, purchase_date: '2026-01-02', source_ref: 'hoard://hub/purchase/3', warranty_ref: 'hoard://kafka/document/d_9', kafka_doc_ids: ['d_9'] });
  assert.deepEqual(purchaseDetails(parseAddParams({ name: 'X' })), {});
});
