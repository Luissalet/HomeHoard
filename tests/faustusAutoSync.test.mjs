import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const compiledDir = mkdtempSync(path.join(process.cwd(), 'node_modules', '.homehoard-test-'));
for (const name of ['ids', 'demo', 'searchUtil', 'memory']) {
  const original = readFileSync(new URL(`../src/db/${name}.ts`, import.meta.url), 'utf8');
  const source = name === 'ids' ? original.replace("'expo-crypto'", "'node:crypto'") : original;
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(path.join(compiledDir, `${name}.js`), output);
}
const { MemorySource } = createRequire(import.meta.url)(path.join(compiledDir, 'memory.js'));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a connected web inventory sends only the latest photo-free snapshot after edits', async () => {
  const oldWindow = globalThis.window;
  const oldStorage = globalThis.localStorage;
  const oldFetch = globalThis.fetch;
  const values = new Map();
  const requests = [];
  globalThis.window = { location: { hostname: 'localhost' } };
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };
  try {
    const source = new MemorySource();
    await source.ready();
    const bundle = await source.exportAll();
    bundle.data.items = [{ id: 'torch', name: 'Linterna', photo_uri: 'data:image/png;base64,cGhvdG8=', deleted_at: null }];
    await source.importAll(bundle);
    await pause(450);
    assert.equal(requests.length, 0, 'sync needs a successful first manual connection');

    values.set('homehoard.faustus.auto', '1');
    const moved = { ...bundle, data: { ...bundle.data, items: [{ ...bundle.data.items[0], name: 'Linterna azul' }] } };
    await source.importAll(moved);
    const latest = { ...bundle, data: { ...bundle.data, items: [{ ...bundle.data.items[0], name: 'Linterna nueva' }] } };
    await source.importAll(latest);
    await pause(500);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:5196/api/import');
    assert.equal(requests[0].body.data.items[0].name, 'Linterna nueva');
    assert.equal(requests[0].body.data.items[0].photo_uri, null);
    assert.equal(JSON.stringify(requests[0].body).includes('cGhvdG8='), false);
  } finally {
    globalThis.window = oldWindow;
    globalThis.localStorage = oldStorage;
    globalThis.fetch = oldFetch;
    if (path.resolve(compiledDir).startsWith(path.resolve(process.cwd(), 'node_modules') + path.sep)) {
      rmSync(compiledDir, { recursive: true, force: true });
    }
  }
});

test('returning to the web app retries a failed Faustus sync without another edit', async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldStorage = globalThis.localStorage;
  const oldFetch = globalThis.fetch;
  const values = new Map();
  const listeners = new Map();
  const requests = [];
  globalThis.window = { location: { hostname: 'localhost' }, addEventListener: (event, callback) => listeners.set(event, callback) };
  globalThis.document = { hidden: false, addEventListener: (event, callback) => listeners.set(event, callback) };
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw new Error('bridge closed');
    return { ok: true };
  };
  try {
    const source = new MemorySource();
    await source.ready();
    const bundle = await source.exportAll();
    bundle.data.items = [{ id: 'torch', name: 'Linterna nueva', photo_uri: 'data:image/png;base64,cGhvdG8=', deleted_at: null }];
    values.set('homehoard.faustus.auto', '1');
    await source.importAll(bundle);
    await pause(500);
    assert.equal(requests.length, 1);
    listeners.get('focus')();
    await pause(500);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].data.items[0].name, 'Linterna nueva');
    assert.equal(requests[1].data.items[0].photo_uri, null);
    listeners.get('visibilitychange')();
    await pause(450);
    assert.equal(requests.length, 2, 'a successful sync does not retry on every focus');
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    globalThis.localStorage = oldStorage;
    globalThis.fetch = oldFetch;
  }
});
