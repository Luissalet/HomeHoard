import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function adapter(serverApi) {
  const source = readFileSync(new URL('../src/features/warranties.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
  const module = {exports: {}};
  vm.runInNewContext(js, {module, exports: module.exports, require: () => serverApi});
  return module.exports;
}

test('warranty UI awaits sync and forwards native filters, pages and unknown values unchanged', async () => {
  const calls = [];
  const page = {as_of: '2026-10-23', unknown_dates: 2, next_offset: 40,
    items: [{item_id: 'no-date', warranty_until: null, days_left: null, source: null}]};
  const api = adapter({flushLocal: async () => calls.push('flush'), uiCall: async (tool, args) => {
    calls.push([tool, JSON.parse(JSON.stringify(args))]); return page;
  }});
  const query = {status: 'unknown', days: 14, as_of: '2026-10-23', location: 'redbox', offset: 20, limit: 20};
  assert.equal(await api.listWarranties(query), page);
  assert.deepEqual(calls, ['flush', ['home_warranties', query]]);
});

test('a failed local sync keeps the warranty read from presenting an older server snapshot', async () => {
  let read = false;
  const api = adapter({flushLocal: async () => {throw new Error('Sin conexión');}, uiCall: async () => {read = true;}});
  await assert.rejects(api.listWarranties({status: 'all', days: 90, offset: 0, limit: 20}), /Sin conexión/);
  assert.equal(read, false);
});
