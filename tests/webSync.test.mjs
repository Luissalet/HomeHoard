// The web store and the computer: edits travel to /api/home/sync, changes made on the computer (Faustus) come back
// through /api/home/version, and the browser keeps working with its local copy when the computer does not answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSources } from './helpers/compile.mjs';

const compiled = compileSources();
const { MemorySource, migrateStore } = compiled.load('src/db/memory.js');
const R = compiled.load('src/db/records.js');
test.after(() => compiled.cleanup());

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const opened = [];
test.afterEach(() => { while (opened.length) opened.pop().sync?.stop(); });

/** A tiny stand-in for the HomeHoard server with the same last-writer-wins rule. */
function fakeServer({ instance = 'inst-1' } = {}) {
  const server = { instance, version: 0, tables: R.emptyTables(), down: false, syncs: [], gets: 0 };
  server.edit = (table, rec) => {
    R.mergeInto(server.tables, { [table]: [rec] });
    server.version += 1;
  };
  server.fetch = async (url, init = {}) => {
    if (server.down) throw new TypeError('connection refused');
    const path = new URL(url, 'http://127.0.0.1:5196').pathname;
    const reply = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
    if (path === '/api/home/version') return reply({ version: server.version, instance: server.instance });
    if (path === '/api/home') {
      server.gets += 1;
      return reply({ version: server.version, instance: server.instance, tables: server.tables });
    }
    if (path === '/api/home/sync') {
      const body = JSON.parse(init.body);
      server.syncs.push(body);
      const records = body.records;
      for (const item of records.items ?? []) if (String(item.photo_uri ?? '').startsWith('data:')) item.photo_uri = `/photos/${item.id}?v=1`;
      if (R.mergeInto(server.tables, records)) server.version += 1;
      return reply({ ok: true, state: { version: server.version, instance: server.instance, tables: server.tables } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return server;
}

function browser(server, { storage = new Map(), origin = 'http://127.0.0.1:5196' } = {}) {
  const wake = [];
  const env = {
    fetch: (...a) => server.fetch(...a),
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h),
    now: () => Date.now(),
    location: new URL(origin),
    isVisible: () => true,
    onWake: (cb) => wake.push(cb),
    pollMs: 40,
    debounceMs: 20,
  };
  globalThis.localStorage = env.storage;
  const source = new MemorySource(env);
  opened.push(source);
  return { source, env, wake: () => wake.forEach((cb) => cb()), storage };
}

async function makeHome(source) {
  const home = await source.addHome('Piso de prueba', 'flat');
  const floor = await source.addFloor(home.id, 'Planta', 900, 700);
  const room = await source.addRoom(floor.id, 'Trastero', { x_cm: 0, y_cm: 0, width_cm: 300, height_cm: 300 });
  return { home, floor, room };
}

test('edits on the web reach the computer once, with photos, and the page served by the server finds it', async () => {
  const server = fakeServer();
  const { source } = browser(server);
  await source.ready();
  assert.equal(source.sync.status.base, '', 'the page is served by the computer');
  const { room } = await makeHome(source);
  const item = await source.addItem({ name: 'Linterna', room_id: room.id, photo_uri: 'data:image/png;base64,cGhvdG8=' });
  await source.updateItem(item.id, { name: 'Linterna azul' });
  await pause(150);
  const sent = server.syncs.flatMap((s) => s.records.items ?? []);
  assert.ok(sent.length >= 1);
  const onServer = server.tables.items.find((i) => i.id === item.id);
  assert.equal(onServer.name, 'Linterna azul');
  assert.equal(onServer.photo_uri, `/photos/${item.id}?v=1`, 'the photo is stored as a file on the computer');
  assert.equal((await source.getItem(item.id)).photo_uri, `/photos/${item.id}?v=1`, 'the browser now points at the computer copy');
  assert.equal(source.sync.status.mode, 'online');
  assert.equal(source.sync.dirty().length, 0);
});

test('a change made on the computer (Faustus) appears in the open page', async () => {
  const server = fakeServer();
  const { source } = browser(server);
  await source.ready();
  const { room } = await makeHome(source);
  const item = await source.addItem({ name: 'Taladro', room_id: room.id });
  await pause(120);
  let notified = 0;
  source.subscribe(() => { notified += 1; });
  server.edit('items', { ...server.tables.items.find((i) => i.id === item.id), name: 'Taladro Bosch', updated_at: Date.now() + 5 });
  await pause(150);
  assert.equal((await source.getItem(item.id)).name, 'Taladro Bosch');
  assert.ok(notified >= 1, 'the interface is told to refresh');
});

test('without the computer the web keeps working and sends everything when it answers again', async () => {
  const server = fakeServer();
  const { source, wake } = browser(server);
  await source.ready();
  const { room } = await makeHome(source);
  await pause(80);
  server.down = true;
  const item = await source.addItem({ name: 'Cinta americana', room_id: room.id });
  await pause(80);
  assert.equal(source.sync.status.mode, 'offline');
  assert.equal(source.sync.status.error, 'sin conexión con el ordenador');
  assert.ok((await source.getItem(item.id)), 'the local copy has it');
  server.down = false;
  wake();
  await pause(150);
  assert.ok(server.tables.items.some((i) => i.id === item.id && i.name === 'Cinta americana'));
  assert.equal(source.sync.status.mode, 'online');
});

test('a browser with an older local inventory uploads it to a new computer and keeps newer server records', async () => {
  const storage = new Map();
  const server = fakeServer({ instance: 'new-computer' });
  const t = Date.now();
  // the browser had used HomeHoard alone (version 0.2 data: tag links without id or dates)
  storage.set('homehoard.v1', JSON.stringify({
    households: [{ id: 'hh', name: 'Mi casa', created_at: t, updated_at: t, deleted_at: null }],
    homes: [{ id: 'h', household_id: 'hh', name: 'Casa', kind: 'flat', created_at: t, updated_at: t, deleted_at: null }],
    floors: [], rooms: [], containers: [],
    items: [{ id: 'old', household_id: 'hh', name: 'Paraguas', quantity: 1, room_id: 'r', container_id: null, photo_uri: null, created_at: t, updated_at: t - 10, deleted_at: null }],
    tags: [{ id: 'tg', household_id: 'hh', name: 'Invierno', color: null, created_at: t, updated_at: t, deleted_at: null }],
    itemTags: [{ item_id: 'old', tag_id: 'tg' }],
  }));
  server.edit('items', { id: 'old', household_id: 'hh', name: 'Paraguas negro', quantity: 1, room_id: 'r', container_id: null, photo_uri: null, created_at: t, updated_at: t, deleted_at: null });
  const { source } = browser(server, { storage });
  await source.ready();
  await pause(150);
  assert.equal(server.tables.items.find((i) => i.id === 'old').name, 'Paraguas negro', 'the newer record on the computer wins');
  assert.ok(server.tables.homes.some((h) => h.id === 'h'), 'the rest of the browser data was uploaded');
  const link = server.tables.itemTags.find((l) => l.item_id === 'old');
  assert.equal(link.id, 'old:tg');
  assert.equal(link.deleted_at, null);
  // removing the tag leaves a tombstone that travels too
  await source.updateItem('old', { tagIds: [] });
  await pause(120);
  assert.notEqual(server.tables.itemTags.find((l) => l.id === 'old:tg').deleted_at, null);
  assert.deepEqual(await source.getItemTags('old'), []);
});

test('the example house is never sent to the computer, and real data on the computer replaces it', async () => {
  const server = fakeServer();
  const { source } = browser(server);
  await source.ready();
  const { seedInitialHome } = compiled.load('src/db/seed.js');
  await seedInitialHome(source);
  await pause(120);
  assert.equal(server.tables.items.length, 0, 'example objects stay in the browser');
  assert.equal(source.sync.status.mode, 'demo');
  const t = Date.now();
  server.edit('homes', { id: 'real', household_id: 'hh', name: 'Mi piso', kind: 'flat', created_at: t, updated_at: t, deleted_at: null });
  server.edit('items', { id: 'x', household_id: 'hh', name: 'Martillo', quantity: 1, room_id: 'r', container_id: null, photo_uri: null, created_at: t, updated_at: t, deleted_at: null });
  await pause(150);
  const names = (await source.searchItems('')).map((i) => i.name);
  assert.ok(!names.includes('Pasaporte'), 'the example objects are gone');
  assert.equal((await source.listHomes())[0].name, 'Mi piso');
});

test('forcing a sync reports the objects the computer holds, or says it is not answering', async () => {
  const server = fakeServer();
  const { source } = browser(server);
  await source.ready();
  const { room } = await makeHome(source);
  await source.addItem({ name: 'Linterna', room_id: room.id });
  assert.equal(await source.sync.forceSync(), 1);
  server.down = true;
  await assert.rejects(source.sync.forceSync(), /Sin conexión con el ordenador/);
});

test('old stores migrate: favorites, tag links with ids and dates, new tables; exports are version 3', async () => {
  const s = migrateStore({ items: [{ id: 'i', name: 'x', updated_at: 7, deleted_at: null }], itemTags: [{ item_id: 'i', tag_id: 't' }] });
  assert.equal(s.items[0].favorite, 0);
  assert.deepEqual(s.itemTags[0], { item_id: 'i', tag_id: 't', id: 'i:t', updated_at: 7, deleted_at: null });
  assert.deepEqual(s.maintenance_tasks, []);
  const server = fakeServer();
  server.down = true;
  const { source } = browser(server, { origin: 'http://localhost:8081' });
  await source.ready();
  const { room } = await makeHome(source);
  const item = await source.addItem({ name: 'Caldera', room_id: room.id });
  await source.saveItemDetails(item.id, { brand: 'Marca Demo', warranty_until: '2028-01-31', consumables: [{ name: 'Filtro', spec: '3x', qty: 2, last_bought: null }] });
  const task = await source.addMaintenance({ target_kind: 'item', target_id: item.id, title: 'Revisión', every_months: 24, basis: 'law', legal_ref: 'RITE IT 3.3' });
  await source.markMaintenanceDone(task.id, { note: 'Técnico', cost: 80 });
  const bundle = await source.exportAll();
  assert.equal(bundle.version, 3);
  assert.equal(bundle.data.item_details[0].warranty_source, 'manual');
  assert.equal(bundle.data.maintenance_tasks.length, 1);
  assert.equal(bundle.data.maintenance_log[0].cost, 80);
  const { tables } = R.recordsFromBundle(bundle);
  assert.equal(tables.maintenance_tasks[0].id, task.id);
});

test('version 1 and 2 bundles still import, links take their object time', () => {
  for (const version of [1, 2]) {
    const bundle = { format: 'homehoard-export', version, exported_at: 100, data: {
      households: [], homes: [], floors: [], rooms: [], containers: [],
      items: [{ id: 'i', name: 'Paraguas', updated_at: 50, deleted_at: null }], tags: [], itemTags: [{ item_id: 'i', tag_id: 't' }] } };
    const { tables } = R.recordsFromBundle(bundle);
    assert.equal(tables.itemTags[0].updated_at, 50);
    assert.deepEqual(tables.maintenance_tasks, []);
  }
  assert.throws(() => R.recordsFromBundle({ format: 'otra-cosa', version: 1, data: {} }), /no es una copia/);
});

test('last writer wins; a tombstone wins a tie', () => {
  const base = { id: 'a', updated_at: 10, deleted_at: null };
  assert.equal(R.wins({ ...base, updated_at: 11 }, base), true);
  assert.equal(R.wins({ ...base, updated_at: 9 }, base), false);
  assert.equal(R.wins({ ...base, deleted_at: 10 }, base), true);
  assert.equal(R.wins({ ...base, name: 'otro' }, base), false);
});
