// The context HomeHoard's web page hands the Faustus copilot: pure builders in the page-side script, no browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('../bridge/homehoard_server/static/copilot.js');
const plain = (value) => JSON.parse(JSON.stringify(value));

const T = 1000;
const row = (id, name, extra = {}) => ({ id, name, created_at: T, updated_at: T, deleted_at: null, ...extra });
const TABLES = {
  households: [row('hh', 'Mi casa')],
  homes: [row('home', 'Piso de prueba', { household_id: 'hh', kind: 'flat' }), row('home2', 'Casa del pueblo', { household_id: 'hh', kind: 'house' })],
  floors: [row('floor', 'Planta unica', { home_id: 'home' }), row('floor2', 'Baja', { home_id: 'home2' })],
  rooms: [row('kitchen', 'Cocina', { floor_id: 'floor', kind: 'kitchen' }), row('storage', 'Trastero', { floor_id: 'floor', kind: 'storage' }),
          row('attic', 'Desvan', { floor_id: 'floor2', kind: 'storage' })],
  containers: [row('shelf', 'Estanteria', { room_id: 'storage', parent_container_id: null, kind: 'shelf' }),
               row('redbox', 'Caja roja', { room_id: 'storage', parent_container_id: 'shelf', kind: 'box' }),
               row('gone', 'Borrada', { room_id: 'storage', parent_container_id: null, deleted_at: 5 })],
  items: [row('torch', 'Linterna Philips', { room_id: 'storage', container_id: 'redbox', quantity: 1, description: 'Pilas AA', favorite: 1 }),
          row('batt', 'Pilas AA', { room_id: 'storage', container_id: 'shelf', quantity: 8 }),
          row('washer', 'Lavadora', { room_id: 'kitchen', container_id: null, quantity: 1 }),
          row('old', 'Tirado', { room_id: 'kitchen', container_id: null, quantity: 1, deleted_at: 9 }),
          row('boxfan', 'Ventilador', { room_id: 'attic', container_id: null, quantity: 2 })],
  tags: [row('electric', 'Material electrico')],
  itemTags: [{ id: 'torch:electric', item_id: 'torch', tag_id: 'electric', updated_at: T, deleted_at: null },
             { id: 'washer:electric', item_id: 'washer', tag_id: 'electric', updated_at: T, deleted_at: 3 }],
  item_details: [row('torch', '', { item_id: 'torch', brand: 'Philips', model: 'CR-200', serial: null, warranty_until: '2028-05-01', kafka_doc_ids: ['d1', 'd2'],
                                    consumables: [{ name: 'Pilas AA', qty: 2 }] })],
  maintenance_tasks: [row('t1', '', { title: 'Cambiar pilas', target_kind: 'item', target_id: 'torch', next_due: '2026-10-12', paused: 0, basis: 'advice' }),
                      row('t2', '', { title: 'Revisar caldera', target_kind: 'home', target_id: 'home', next_due: '2026-10-01', paused: 0, basis: 'law' }),
                      row('t3', '', { title: 'Purgar radiadores', target_kind: 'home', target_id: 'home', next_due: '2027-02-01', paused: 0 }),
                      row('t4', '', { title: 'Pausada', target_kind: 'room', target_id: 'kitchen', next_due: '2026-10-02', paused: 1 })],
};

test('routes are told apart, with the id decoded', () => {
  assert.deepEqual(cp.parseRoute('/item/torch'), { page: 'item', id: 'torch' });
  assert.deepEqual(cp.parseRoute('/room/a%20b/'), { page: 'room', id: 'a b' });
  assert.deepEqual(cp.parseRoute('/container/x'), { page: 'container', id: 'x' });
  assert.equal(cp.parseRoute('/').page, 'home');
  assert.equal(cp.parseRoute('/maintenance').page, 'maintenance');
  assert.equal(cp.parseRoute('/importar').page, 'import');
  assert.equal(cp.parseRoute('/nada').page, 'unknown');
  assert.equal(cp.parseRoute(undefined).page, 'home');
});

test('an object: where it is, its tags, sheet and tasks; deleted links and rows do not count', () => {
  const ctx = plain(cp.buildContext({ path: '/item/torch', tables: TABLES, today: '2026-10-12' }));
  assert.deepEqual(ctx.project, { external_project_id: 'home', title: 'Piso de prueba' });
  assert.equal(ctx.active_objects.length, 1);
  assert.deepEqual(ctx.active_objects[0], {
    kind: 'item', object_id: 'torch', title: 'Linterna Philips', quantity: 1, favorite: true, note: 'Pilas AA',
    location: 'Trastero › Estanteria › Caja roja', room_id: 'storage', container_id: 'redbox', tags: ['Material electrico'],
    details: { brand: 'Philips', model: 'CR-200', warranty_until: '2028-05-01' }, papers: 2, consumables: ['Pilas AA'],
    maintenance: [{ id: 't1', title: 'Cambiar pilas', next_due: '2026-10-12' }],
  });
  assert.deepEqual(ctx.view, { page: 'item' });
  assert.deepEqual(plain(cp.buildContext({ path: '/item/washer', tables: TABLES })).active_objects[0].location, 'Cocina');
  assert.equal('tags' in plain(cp.buildContext({ path: '/item/washer', tables: TABLES })).active_objects[0], false);
});

test('the project is the home of the open object, else the first home', () => {
  assert.equal(plain(cp.buildContext({ path: '/room/attic', tables: TABLES })).project.external_project_id, 'home2');
  assert.equal(plain(cp.buildContext({ path: '/item/boxfan', tables: TABLES })).project.title, 'Casa del pueblo');
  assert.equal(plain(cp.buildContext({ path: '/plan', tables: TABLES })).project.external_project_id, 'home');
  assert.equal('project' in plain(cp.buildContext({ path: '/plan', tables: {} })), false);
});

test('a room lists its furniture with counts and its loose objects', () => {
  const room = plain(cp.buildContext({ path: '/room/storage', tables: TABLES })).active_objects[0];
  assert.deepEqual(room, { kind: 'room', object_id: 'storage', title: 'Trastero', item_count: 2, room_kind: 'storage', floor: 'Planta unica',
                           containers: [{ id: 'shelf', name: 'Estanteria', item_count: 2, kind: 'shelf' }], loose_items: [] });
  const kitchen = plain(cp.buildContext({ path: '/room/kitchen', tables: TABLES })).active_objects[0];
  assert.deepEqual(kitchen.loose_items, [{ id: 'washer', name: 'Lavadora' }]);
  assert.equal(kitchen.item_count, 1);
});

test('furniture shows its direct contents, what is inside it and where it stands', () => {
  const shelf = plain(cp.buildContext({ path: '/container/shelf', tables: TABLES })).active_objects[0];
  assert.deepEqual(shelf.items, [{ id: 'batt', name: 'Pilas AA', quantity: 8 }]);
  assert.equal(shelf.item_count, 2);
  assert.deepEqual(shelf.sub_containers, [{ id: 'redbox', name: 'Caja roja' }]);
  assert.equal(shelf.location, 'Trastero');
  const box = plain(cp.buildContext({ path: '/container/redbox', tables: TABLES })).active_objects[0];
  assert.equal(box.location, 'Trastero › Estanteria');
  assert.equal(box.container_kind, 'box');
});

test('long lists are capped and say how much was left out', () => {
  const items = Array.from({ length: 40 }, (_, i) => row('i' + i, 'Cosa ' + i, { room_id: 'kitchen', container_id: null, quantity: 1 }));
  const room = plain(cp.buildContext({ path: '/room/kitchen', tables: { ...TABLES, items } })).active_objects[0];
  assert.equal(room.loose_items.length, cp.MAX_ITEMS);
  assert.equal(room.loose_items_truncated, 40 - cp.MAX_ITEMS);
  assert.equal(room.item_count, 40);
});

test('an object the computer does not have yet is a stub with the page title', () => {
  const ctx = plain(cp.buildContext({ path: '/item/new-one', tables: TABLES, heading: 'Taladro' }));
  assert.deepEqual(ctx.active_objects, [{ kind: 'item', object_id: 'new-one', unsynced: true, title: 'Taladro' }]);
  const offline = plain(cp.buildContext({ path: '/item/x', tables: null }));
  assert.deepEqual(offline.active_objects, [{ kind: 'item', object_id: 'x', unsynced: true }]);
});

test('list pages have no active objects but say what they show', () => {
  const home = plain(cp.buildContext({ path: '/', tables: TABLES }));
  assert.deepEqual(home.active_objects, []);
  assert.deepEqual(home.view.summary, { items: 4, containers: 2, rooms: [
    { id: 'kitchen', name: 'Cocina', items: 1 }, { id: 'storage', name: 'Trastero', items: 2 }, { id: 'attic', name: 'Desvan', items: 1 }] });
});

test('maintenance groups tasks like the tab and skips paused ones', () => {
  const view = plain(cp.buildContext({ path: '/maintenance', tables: TABLES, today: '2026-10-12' })).view;
  assert.deepEqual(plain(view.summary), {
    tasks: 3, overdue: 1, this_month: 1, upcoming: 1,
    next: [{ id: 't2', title: 'Revisar caldera', next_due: '2026-10-01', target: 'home', target_name: 'Piso de prueba', basis: 'law' },
           { id: 't1', title: 'Cambiar pilas', next_due: '2026-10-12', target: 'item', target_name: 'Linterna Philips', basis: 'advice' },
           { id: 't3', title: 'Purgar radiadores', next_due: '2027-02-01', target: 'home', target_name: 'Piso de prueba' }],
  });
});

test('inputs are sorted into the app fields and checkboxes are ignored', () => {
  const forms = plain(cp.readForms([
    { type: 'text', ph: '¿Qué objeto es?', value: ' Taladro ' }, { type: 'textarea', ph: 'Detalles…', value: 'Con maletin' },
    { type: 'text', ph: '¿Dónde está la linterna Philips?', value: 'pilas' }, { type: 'text', ph: 'Buscar en el manual de X', aria: 'Buscar en el manual', value: 'E21' },
    { type: 'checkbox', aria: 'Avisar mediante Kafka', value: 'on' }, { type: 'text', ph: 'Marca', value: 'Bosch' }, { type: 'text', ph: 'Modelo', value: '' }]));
  assert.deepEqual(forms, { other: { Marca: 'Bosch' }, name: 'Taladro', description: 'Con maletin', query: 'pilas', manual_query: 'E21' });
});

test('the new-object form, a search and edits of the open object are reported only when typed', () => {
  const add = plain(cp.buildContext({ path: '/add', tables: TABLES, forms: { name: 'Taladro', description: 'Con maletin', other: {} } })).view.editor;
  assert.deepEqual(add, { kind: 'new_item', dirty: true, fields: { name: 'Taladro', description: 'Con maletin' } });
  assert.equal('editor' in plain(cp.buildContext({ path: '/add', tables: TABLES, forms: { name: '', description: '', other: {} } })).view, false);
  assert.deepEqual(plain(cp.buildContext({ path: '/search', tables: TABLES, forms: { query: 'pilas', other: {} } })).view.editor,
                   { kind: 'search', dirty: true, fields: { query: 'pilas' } });
  const saved = { name: 'Linterna Philips', description: 'Pilas AA' };
  assert.equal('editor' in plain(cp.buildContext({ path: '/item/torch', tables: TABLES, forms: { name: saved.name, description: saved.description, other: {} } })).view, false);
  assert.deepEqual(plain(cp.buildContext({ path: '/item/torch', tables: TABLES, forms: { name: 'Linterna XL', description: 'Pilas AA', other: {} } })).view.editor,
                   { kind: 'edit_item', dirty: true, fields: { name: 'Linterna XL' } });
});

test('a manual search alone is its own editor; other typed fields are never lost', () => {
  assert.deepEqual(plain(cp.buildContext({ path: '/item/torch', tables: TABLES, forms: { name: 'Linterna Philips', description: 'Pilas AA', manual_query: 'E21', other: {} } })).view.editor,
                   { kind: 'manual_search', dirty: true, fields: { query: 'E21' } });
  assert.deepEqual(plain(cp.buildContext({ path: '/settings', tables: TABLES, forms: { other: { Etiqueta: 'Nueva' } } })).view.editor,
                   { kind: 'form', dirty: true, fields: { Etiqueta: 'Nueva' } });
  const both = plain(cp.buildContext({ path: '/add', tables: TABLES, forms: { name: 'X', other: { Marca: 'Bosch' } } })).view.editor;
  assert.deepEqual(both.fields, { name: 'X', other: { Marca: 'Bosch' } });
});

test('with no data at all the page still answers', () => {
  assert.deepEqual(plain(cp.buildContext()), { active_objects: [], view: { page: 'home', summary: { items: 0, containers: 0, rooms: [] } } });
});
